import { canonicalHash, canonicalJson } from "./canonical.js";
import type { AssetActionDefinitionV1 } from "./types.js";

/**
 * Order deliverables: what a buyer gets for a fulfilled order. The artifact
 * itself is always one. A provider may list the others in one standard data
 * part of the order's artifact (an A2A Task):
 *
 *   {"kind": "data", "data": {"https://daski.io/deliverables/v1": {"items": [
 *     {"kind": "artifact"},
 *     {"kind": "owner-action", "actionId": "get-api-key", "assetType": "api-account",
 *      "providerAssetId": "<uuid>", "input": {"keyId": "key_0001"}, "label": "API key"}
 *   ]}}}
 *
 * The part holds pointers, never secrets: a secret comes from the owner
 * action, which POST /wallet/assets/action authorizes and checks on its own.
 * The gateway lifts the part out before it projects a result onto the
 * listing's schema, so no listing schema ever sees it, checks every
 * owner-action item against the provider's signed asset-action catalog, and
 * answers the checked list as `deliverables`, `{"kind": "artifact"}` first.
 * An invalid item is dropped and logged; it never fails the artifact read.
 */
export const DELIVERABLES_PART_KEY = "https://daski.io/deliverables/v1";

/**
 * What a gateway names in `daski-order-status-additions` when it accepts the
 * part in an artifact read. A gateway released before it refuses an artifact
 * carrying the part, so a provider adds the part only when the header names it.
 */
export const DELIVERABLES_ADDITION = "deliverables";

export const DELIVERABLE_ITEMS_MAX = 32;
export const DELIVERABLE_INPUT_MAX_BYTES = 2_048;
export const DELIVERABLE_INPUT_MAX_KEYS = 16;
export const DELIVERABLE_INPUT_VALUE_MAX_LENGTH = 256;
export const DELIVERABLE_LABEL_MAX_LENGTH = 64;

export type ArtifactDeliverable = { kind: "artifact" };

/** Exactly what POST /wallet/assets/action takes besides payer and authorization, with the action's asset type. */
export interface OwnerActionDeliverable {
  kind: "owner-action";
  providerAgentId: string;
  actionId: string;
  assetType: string;
  providerAssetId: string;
  input: Record<string, unknown>;
  label: string | null;
}

export type Deliverable = ArtifactDeliverable | OwnerActionDeliverable;

export type DeliverableDropReason =
  | "part_invalid" | "part_ambiguous" | "too_many_items" | "item_invalid"
  | "action_unknown" | "action_destructive" | "asset_type_mismatch" | "duplicate";

/** Why an item, or the whole part (index null), was not listed. Never carries input values. */
export interface DeliverableDrop {
  reason: DeliverableDropReason;
  index: number | null;
  actionId?: string;
}

export interface LiftedDeliverables {
  /** The result the listing's schema sees: the key removed from every data part, emptied parts and artifacts removed. */
  contractView: unknown;
  /** Each value found under the key, in order, and whether its part was exactly the standard part. */
  parts: Array<{ value: unknown; standard: boolean }>;
}

const ITEM_KEYS = new Set(["kind", "actionId", "assetType", "providerAssetId", "input", "label"]);
const REQUIRED_ITEM_KEYS = ["kind", "actionId", "assetType", "providerAssetId", "input"] as const;
// The same action-id grammar as POST /wallet/assets/action.
const ACTION_ID = /^[a-z0-9][a-z0-9-]{0,95}$/;
// A canonical lowercase UUID: a subset of what POST /wallet/assets/action accepts.
const PROVIDER_ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Control, invisible formatting (bidirectional overrides among them) and line
// separator characters: provider text reaches agents outside the untrusted
// result, so it must read as what it shows.
const HIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
// An input is a flat object of identifiers and short scalar values, the shape
// of a pointer: never a document, an instruction or a nested payload.
const INPUT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/**
 * Takes the deliverables part out of a provider task, for schema projection
 * only. The task itself is never changed: the buyer receives it as the
 * provider signed it. A result that is not a task with artifacts is returned
 * as it is.
 */
export function liftDeliverablesPart(result: unknown): LiftedDeliverables {
  if (!object(result) || !Array.isArray(result.artifacts)) return { contractView: result, parts: [] };
  const parts: LiftedDeliverables["parts"] = [];
  const artifacts: unknown[] = [];
  for (const artifact of result.artifacts) {
    if (!object(artifact) || !Array.isArray(artifact.parts)) {
      artifacts.push(artifact);
      continue;
    }
    const kept: unknown[] = [];
    let lifted = false;
    for (const part of artifact.parts) {
      if (object(part) && part.kind === "data" && object(part.data) && Object.hasOwn(part.data, DELIVERABLES_PART_KEY)) {
        lifted = true;
        const { [DELIVERABLES_PART_KEY]: value, ...rest } = part.data;
        parts.push({ value, standard: exactKeys(part, ["kind", "data"]) && Object.keys(rest).length === 0 });
        if (Object.keys(rest).length > 0) kept.push({ ...part, data: rest });
        continue;
      }
      kept.push(part);
    }
    if (!lifted) artifacts.push(artifact);
    else if (kept.length > 0) artifacts.push({ ...artifact, parts: kept });
  }
  return parts.length === 0 ? { contractView: result, parts } : { contractView: { ...result, artifacts }, parts };
}

function boundedText(value: unknown, maxLength: number, minLength = 1): value is string {
  return typeof value === "string" && value.length >= minLength && value.length <= maxLength &&
    !HIDDEN_CHARACTERS.test(value);
}

function flatInput(input: Record<string, unknown>): boolean {
  const entries = Object.entries(input);
  if (entries.length > DELIVERABLE_INPUT_MAX_KEYS) return false;
  for (const [key, value] of entries) {
    // `operation` names the gateway's own follow-ups (confirm-destructive,
    // cancel-staged-action, recover-action), never a first use.
    if (!INPUT_KEY.test(key) || key === "operation") return false;
    if (!(value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) ||
      boundedText(value, DELIVERABLE_INPUT_VALUE_MAX_LENGTH, 0))) return false;
  }
  try {
    return Buffer.byteLength(canonicalJson(input), "utf8") <= DELIVERABLE_INPUT_MAX_BYTES;
  } catch {
    return false;
  }
}

type ParsedItem = ArtifactDeliverable | Omit<OwnerActionDeliverable, "providerAgentId">;

function parseItem(raw: unknown): ParsedItem | null {
  if (!object(raw)) return null;
  if (raw.kind === "artifact") return exactKeys(raw, ["kind"]) ? { kind: "artifact" } : null;
  if (raw.kind !== "owner-action") return null;
  if (Object.keys(raw).some((key) => !ITEM_KEYS.has(key)) || REQUIRED_ITEM_KEYS.some((key) => !Object.hasOwn(raw, key))) {
    return null;
  }
  const { actionId, assetType, providerAssetId, input, label } = raw;
  if (
    typeof actionId !== "string" || !ACTION_ID.test(actionId) ||
    !boundedText(assetType, 128) ||
    typeof providerAssetId !== "string" || !PROVIDER_ASSET_ID.test(providerAssetId) ||
    !object(input) || !flatInput(input) ||
    // A label is optional; null says the same as leaving it out.
    (label !== undefined && label !== null && !boundedText(label, DELIVERABLE_LABEL_MAX_LENGTH))
  ) return null;
  return {
    kind: "owner-action", actionId, assetType, providerAssetId, input,
    label: typeof label === "string" ? label : null,
  };
}

/**
 * The checked deliverables of one artifact read: `{"kind": "artifact"}`
 * first, then each owner-action item, in the provider's order, whose action
 * exists in the provider's current signed catalog (as POST
 * /wallet/assets/action resolves it), is not destructive and has the asset
 * type the item names. Duplicates are listed once. Anything else is dropped:
 * a part that is not exactly the standard part, more than one part, more than
 * DELIVERABLE_ITEMS_MAX items, and every malformed item.
 */
export function checkDeliverables(args: {
  parts: LiftedDeliverables["parts"];
  providerAgentId: string;
  definition: (actionId: string) => AssetActionDefinitionV1 | null;
}): { deliverables: Deliverable[]; dropped: DeliverableDrop[] } {
  const deliverables: Deliverable[] = [{ kind: "artifact" }];
  const dropped: DeliverableDrop[] = [];
  if (args.parts.length === 0) return { deliverables, dropped };
  if (args.parts.length > 1) return { deliverables, dropped: [{ reason: "part_ambiguous", index: null }] };
  const [part] = args.parts as [LiftedDeliverables["parts"][number]];
  if (!part.standard || !object(part.value) || !exactKeys(part.value, ["items"]) || !Array.isArray(part.value.items)) {
    return { deliverables, dropped: [{ reason: "part_invalid", index: null }] };
  }
  const items: unknown[] = part.value.items;
  if (items.length > DELIVERABLE_ITEMS_MAX) return { deliverables, dropped: [{ reason: "too_many_items", index: null }] };
  const listed = new Set<string>();
  items.forEach((raw, index) => {
    const item = parseItem(raw);
    if (!item) {
      dropped.push({ reason: "item_invalid", index });
      return;
    }
    // The artifact is always listed, once and first.
    if (item.kind === "artifact") return;
    let definition: AssetActionDefinitionV1 | null;
    try {
      definition = args.definition(item.actionId);
    } catch {
      definition = null;
    }
    const drop = (reason: DeliverableDropReason): void => {
      dropped.push({ reason, index, actionId: item.actionId });
    };
    if (!definition) return drop("action_unknown");
    if (definition.destructive) return drop("action_destructive");
    if (definition.assetType !== item.assetType) return drop("asset_type_mismatch");
    const identity = canonicalHash({ actionId: item.actionId, providerAssetId: item.providerAssetId, input: item.input });
    if (listed.has(identity)) return drop("duplicate");
    listed.add(identity);
    deliverables.push({
      kind: "owner-action", providerAgentId: args.providerAgentId, actionId: item.actionId,
      assetType: item.assetType, providerAssetId: item.providerAssetId, input: item.input, label: item.label,
    });
  });
  return { deliverables, dropped };
}
