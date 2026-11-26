import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { COMMITTED_KEYS_ONLY } from "../src/standardRail/providerAuthority.js";
import { compileClosedResponseSchema } from "../src/standardRail/schema.js";
import { StandardRailCatalog } from "../src/standardRail/catalog.js";
import { StandardRailService } from "../src/standardRail/service.js";
import { StandardAssetActions } from "../src/standardRail/assetActions.js";
import { canonicalHash } from "../src/standardRail/canonical.js";
import {
  checkDeliverables,
  DELIVERABLE_ITEMS_MAX,
  DELIVERABLES_ADDITION,
  DELIVERABLES_PART_KEY,
  liftDeliverablesPart,
} from "../src/standardRail/deliverables.js";
import { ORDER_STATUS_ADDITIONS_HEADER, PROVIDER_LIFECYCLE_HEADERS } from "../src/standardRail/orderStatusView.js";
import type { AssetActionDefinitionV1 } from "../src/standardRail/types.js";
import { logger } from "../src/util/logger.js";

const PROVIDER = "8327";
const ASSET_ID = "00000000-0000-4000-8000-00000000a5e7";
const DOCUMENT_ASSET_ID = "00000000-0000-4000-8000-00000000d0c5";
const account = privateKeyToAccount(`0x${"11".repeat(32)}` as Hex);
const text = { type: "string", maxLength: 256 };

/** A flat contract the gateway projects the task's data artifacts onto. */
const FLAT = { type: "object", additionalProperties: false, required: ["keyId", "environment"],
  properties: { keyId: text, environment: text } };
/** A closed task-shaped contract: every data part must be the account record. */
const TASK = { type: "object", additionalProperties: false, required: ["id", "status", "artifacts"], properties: {
  id: text,
  status: { type: "object", additionalProperties: false, required: ["state"], properties: { state: text } },
  artifacts: { type: "array", items: { type: "object", additionalProperties: false, required: ["artifactId", "name", "parts"],
    properties: { artifactId: text, name: text, parts: { type: "array", items: {
      type: "object", additionalProperties: false, required: ["kind", "data"],
      properties: { kind: { type: "string", enum: ["data"] }, data: FLAT },
    } } } } },
} };

const definitions: Record<string, Pick<AssetActionDefinitionV1, "actionId" | "assetType" | "destructive">> = {
  "get-api-key": { actionId: "get-api-key", assetType: "api-account", destructive: false },
  "download-account-document": { actionId: "download-account-document", assetType: "api-account", destructive: false },
  "rotate-api-key": { actionId: "rotate-api-key", assetType: "api-account", destructive: true },
  "get-domain-status": { actionId: "get-domain-status", assetType: "domain", destructive: false },
};
const definition = (actionId: string) => (definitions[actionId] ?? null) as AssetActionDefinitionV1 | null;

const keyItem = { kind: "owner-action", actionId: "get-api-key", assetType: "api-account", providerAssetId: ASSET_ID,
  input: { keyId: "key_0001" }, label: "API key" };
const documentItem = { kind: "owner-action", actionId: "download-account-document", assetType: "api-account",
  providerAssetId: DOCUMENT_ASSET_ID, input: { documentId: "00000000-0000-4000-8000-00000000d0c1" } };
const listedKey = { kind: "owner-action", providerAgentId: PROVIDER, actionId: "get-api-key", assetType: "api-account",
  providerAssetId: ASSET_ID, input: { keyId: "key_0001" }, label: "API key" };
const listedDocument = { kind: "owner-action", providerAgentId: PROVIDER, actionId: "download-account-document",
  assetType: "api-account", providerAssetId: DOCUMENT_ASSET_ID, input: documentItem.input, label: null };

const deliverablesPart = (items: unknown[]) => ({ kind: "data", data: { [DELIVERABLES_PART_KEY]: { items } } });
const account_record = { keyId: "key_0001", environment: "sandbox" };
function task(extraParts: unknown[] = []) {
  return {
    id: "task", status: { state: "TASK_STATE_COMPLETED" },
    artifacts: [{ artifactId: "account", name: "account_created",
      parts: [{ kind: "data", data: account_record }, ...extraParts] }],
  };
}

function catalog(): StandardRailCatalog {
  return Object.assign(Object.create(StandardRailCatalog.prototype) as StandardRailCatalog, {
    withinSchemaBudget: async (_listing: unknown, validate: () => void) => validate(),
    compiled: (listing: { responseSchema: Record<string, unknown> }) =>
      ({ response: compileClosedResponseSchema(listing.responseSchema) }),
  });
}

function harness(responseSchema: Record<string, unknown> = FLAT) {
  const order = { orderId: "order", providerTaskId: "task", state: "FULFILLED", orderKey: "key" };
  const listing = { responseSchema, commitment: { payload: {
    providerAgentId: PROVIDER, providerAuthorityKey: account.address, providerTerminalAttestationKey: account.address,
  } } };
  const service = Object.assign(Object.create(StandardRailService.prototype), {
    providerWallets: COMMITTED_KEYS_ONLY, catalog: catalog(), store: { persistOperations: vi.fn() },
    signedReceipt: async () => null,
    confirmationState: { stored: async () => null }, submissionStatus: async () => null,
    assetActions: { currentDefinition: (providerAgentId: string, actionId: string) =>
      providerAgentId === PROVIDER ? definition(actionId) : null },
  });
  const read = async (result: unknown, action: "artifact" | "status" = "artifact") => {
    const now = Math.floor(Date.now() / 1000);
    const payload = { orderId: "order", taskId: "task", state: "completed", resultHash: canonicalHash(result), completedAt: now };
    const unsigned: Record<string, unknown> = {
      orderId: "order", taskId: "task", state: "completed",
      operations: { schemaVersion: 1, revision: 0, observedAt: now, fulfillment: null, support: null, recovery: null },
      terminalAttestation: { payload, signature: await account.signMessage({ message: { raw: canonicalHash(payload) } }) },
      ...(action === "artifact" ? { result } : {}),
    };
    const signed: Record<string, unknown> = { ...unsigned, signature: await account.signMessage({ message: { raw: canonicalHash(unsigned) } }) };
    const answer = await service.applyLifecycleResult(order, listing, structuredClone(signed), action, "handle") as
      Record<string, unknown> & { deliverables?: unknown[] };
    return { signed, answer };
  };
  return { listing, read };
}

afterEach(() => vi.restoreAllMocks());

describe("order deliverables part (design section 6)", () => {
  // What every gateway before this change does with an artifact carrying the
  // part: it projects the raw task onto the listing's schema and fails the read
  // (INTERNAL_ERROR to the buyer). So a provider adds the part only when the
  // gateway names `deliverables` in daski-order-status-additions.
  it("is refused by a projection that does not lift it, flat or task-shaped", async () => {
    const withPart = task([deliverablesPart([keyItem])]);
    await expect(catalog().validateResponse({ responseSchema: FLAT } as never, withPart))
      .rejects.toThrow("Undeclared provider artifact data");
    await expect(catalog().validateResponse({ responseSchema: TASK } as never, withPart))
      .rejects.toThrow("does not match the closed outcome schema");
    await expect(catalog().validateResponse({ responseSchema: FLAT } as never, task())).resolves.toBeUndefined();
  });

  it("is named in the additions every lifecycle POST sends", () => {
    expect(DELIVERABLES_ADDITION).toBe("deliverables");
    expect(PROVIDER_LIFECYCLE_HEADERS[ORDER_STATUS_ADDITIONS_HEADER]!.split(",").map((entry) => entry.trim()))
      .toContain(DELIVERABLES_ADDITION);
  });
});

describe("artifact read with deliverables", () => {
  it("lists checked owner actions after the artifact and delivers the signed task unchanged", async () => {
    for (const schema of [FLAT, TASK]) {
      const { read } = harness(schema);
      const result = task([deliverablesPart([{ kind: "artifact" }, keyItem, documentItem])]);
      const { signed, answer } = await read(result);
      expect(answer.deliverables).toEqual([{ kind: "artifact" }, listedKey, listedDocument]);
      // The buyer receives the task exactly as the provider signed it, part included.
      expect(answer.result).toEqual(signed.result);
      expect(answer.signature).toBe(signed.signature);
    }
  });

  it("lists only the artifact when there is no part", async () => {
    const { read } = harness();
    const { answer } = await read(task());
    expect(answer.deliverables).toEqual([{ kind: "artifact" }]);
  });

  it("lists the artifact once for a part that names only the artifact", async () => {
    const { read } = harness(TASK);
    const { answer } = await read(task([deliverablesPart([{ kind: "artifact" }, { kind: "artifact" }])]));
    expect(answer.deliverables).toEqual([{ kind: "artifact" }]);
  });

  it("accepts the part in an artifact of its own", async () => {
    const { read } = harness(TASK);
    const result = task();
    result.artifacts.push({ artifactId: "deliverables", name: "deliverables", parts: [deliverablesPart([keyItem])] } as never);
    const { answer } = await read(result);
    expect(answer.deliverables).toEqual([{ kind: "artifact" }, listedKey]);
  });

  it("drops and logs invalid items without failing the read", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const { read } = harness();
    const items = [
      { ...keyItem, actionId: "delete-everything" },
      { ...keyItem, actionId: "rotate-api-key" },
      { ...keyItem, actionId: "get-domain-status" },
      { ...keyItem, assetType: "domain" },
      { ...keyItem, apiKey: "sk-secret-value" },
      { kind: "owner-action", actionId: "get-api-key", assetType: "api-account", providerAssetId: ASSET_ID },
      { ...keyItem, providerAssetId: "asset-1" },
      { ...keyItem, providerAssetId: ASSET_ID.toUpperCase() },
      { ...keyItem, input: ["key_0001"] },
      { ...keyItem, input: { operation: "recover-action", keyId: "key_0001" } },
      { ...keyItem, input: { keyId: "k".repeat(1_000), note: "n".repeat(1_100) } },
      { ...keyItem, label: "" },
      { ...keyItem, label: "x".repeat(65) },
      { ...keyItem, label: null },
      { ...keyItem, kind: "download" },
      { kind: "artifact", label: "The artifact" },
      "get-api-key",
      keyItem,
      { ...keyItem, label: "The same key again" },
    ];
    const { answer } = await read(task([deliverablesPart(items)]));
    expect(answer.deliverables).toEqual([{ kind: "artifact" }, listedKey]);
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, details] = warn.mock.calls[0]! as [string, { dropped: Array<{ reason: string; index: number }> }];
    expect(message).toBe("order deliverables dropped");
    expect(details.dropped.map(({ reason, index }) => [index, reason])).toEqual([
      [0, "action_unknown"], [1, "action_destructive"], [2, "asset_type_mismatch"], [3, "asset_type_mismatch"],
      [4, "item_invalid"], [5, "item_invalid"], [6, "item_invalid"], [7, "item_invalid"], [8, "item_invalid"],
      [9, "item_invalid"], [10, "item_invalid"], [11, "item_invalid"], [12, "item_invalid"], [13, "item_invalid"],
      [14, "item_invalid"], [15, "item_invalid"], [16, "item_invalid"], [18, "duplicate"],
    ]);
    // A drop names the reason, never an item's input or anything it carried.
    expect(JSON.stringify(warn.mock.calls)).not.toContain("sk-secret-value");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("key_0001");
  });

  it("lists only the artifact for a part it cannot read, and still delivers the result", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const { read } = harness();
    const cases = [
      // The key beside other data, or a part with more than kind and data.
      [{ kind: "data", data: { [DELIVERABLES_PART_KEY]: { items: [keyItem] }, keyId: "key_0001" } }],
      [{ ...deliverablesPart([keyItem]), metadata: {} }],
      // Two parts, a value without items, an items value that is not a list, too many items.
      [deliverablesPart([keyItem]), deliverablesPart([documentItem])],
      [{ kind: "data", data: { [DELIVERABLES_PART_KEY]: { items: [keyItem], more: true } } }],
      [{ kind: "data", data: { [DELIVERABLES_PART_KEY]: { items: keyItem } } }],
      [{ kind: "data", data: { [DELIVERABLES_PART_KEY]: "get-api-key" } }],
      [deliverablesPart(Array.from({ length: DELIVERABLE_ITEMS_MAX + 1 }, () => keyItem))],
    ];
    for (const parts of cases) {
      const { signed, answer } = await read(task(parts));
      expect(answer.deliverables).toEqual([{ kind: "artifact" }]);
      expect(answer.result).toEqual(signed.result);
    }
  });

  it("still holds the raw part to the passive-output check", async () => {
    const { read } = harness();
    await expect(read(task([deliverablesPart([{ ...keyItem, label: "<script>alert(1)</script>" }])])))
      .rejects.toThrow("PROVIDER_OUTPUT_ACTIVE_CONTENT_REJECTED");
  });

  it("is never added to a status read", async () => {
    const { read } = harness();
    const { answer } = await read(task(), "status");
    expect(answer).not.toHaveProperty("deliverables");
  });
});

describe("lifting the part", () => {
  it("removes it from the schema's view only, never from the task", () => {
    const original = task([deliverablesPart([keyItem])]);
    const before = JSON.stringify(original);
    const lifted = liftDeliverablesPart(original);
    expect(lifted.contractView).toEqual(task());
    expect(lifted.parts).toEqual([{ value: { items: [keyItem] }, standard: true }]);
    expect(JSON.stringify(original)).toBe(before);
    const plain = task();
    expect(liftDeliverablesPart(plain)).toEqual({ contractView: plain, parts: [] });
    expect(liftDeliverablesPart(plain).contractView).toBe(plain);
  });

  it("leaves results that are not tasks as they are", () => {
    const flat = { keyId: "key_0001", [DELIVERABLES_PART_KEY]: { items: [] } };
    expect(liftDeliverablesPart(flat)).toEqual({ contractView: flat, parts: [] });
    expect(liftDeliverablesPart(null)).toEqual({ contractView: null, parts: [] });
  });

  it("keeps the rest of a data part that also carried the key", () => {
    const lifted = liftDeliverablesPart(task([{ kind: "data", data: { [DELIVERABLES_PART_KEY]: { items: [] }, note: "kept" } }]));
    expect(lifted.parts).toEqual([{ value: { items: [] }, standard: false }]);
    expect((lifted.contractView as ReturnType<typeof task>).artifacts[0]!.parts).toEqual([
      { kind: "data", data: account_record }, { kind: "data", data: { note: "kept" } },
    ]);
  });

  it("checks an item against the catalog lookup it is given, and survives a lookup that throws", () => {
    const parts = [{ value: { items: [keyItem] }, standard: true }];
    expect(checkDeliverables({ parts, providerAgentId: PROVIDER, definition }).deliverables)
      .toEqual([{ kind: "artifact" }, listedKey]);
    expect(checkDeliverables({ parts, providerAgentId: PROVIDER, definition: () => { throw new Error("catalog"); } }))
      .toEqual({ deliverables: [{ kind: "artifact" }], dropped: [{ reason: "action_unknown", index: 0, actionId: "get-api-key" }] });
  });
});

describe("current asset-action definition", () => {
  it("is what a new asset action would resolve, or null", () => {
    const now = Math.floor(Date.now() / 1000);
    const preimage = (actionId: string, validFrom = now - 60) => ({ ...definitions[actionId], providerAgentId: PROVIDER,
      validFrom, validBefore: now + 600 });
    const withHash = (value: Record<string, unknown>) => ({ ...value, actionDefinitionHash: canonicalHash(value) });
    const catalogEnvelope = { payload: { providerAgentId: PROVIDER, actions: [
      withHash(preimage("get-api-key")), withHash(preimage("rotate-api-key", now + 3_600)),
      { ...withHash(preimage("get-domain-status")), assetType: "changed-after-signing" },
    ] } };
    const active = { admissionEnvelope: { payload: { actionCatalogHash: canonicalHash(catalogEnvelope) } } };
    const actions = new StandardAssetActions(
      {} as never,
      { manifest: { actionCatalogs: [catalogEnvelope] } } as never,
      84532,
      {} as never,
      { activeServicing: (providerAgentId: string) => providerAgentId === PROVIDER ? active : null } as never,
      async () => new Response(null),
    );
    expect(actions.currentDefinition(PROVIDER, "get-api-key")).toMatchObject({ actionId: "get-api-key", assetType: "api-account" });
    expect(actions.currentDefinition(PROVIDER, "rotate-api-key")).toBeNull();
    expect(actions.currentDefinition(PROVIDER, "get-domain-status")).toBeNull();
    expect(actions.currentDefinition(PROVIDER, "download-account-document")).toBeNull();
    expect(actions.currentDefinition("9999", "get-api-key")).toBeNull();
  });
});
