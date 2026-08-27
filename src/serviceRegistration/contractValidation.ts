import {
  compileClosedResponseSchema,
} from "../standardRail/schema.js";
import type { PublishedAssetActionContract } from "./types.js";

const PRICING_TYPES = new Set([
  "one-time", "hourly", "daily", "weekly", "monthly", "quarterly",
  "annually", "usage",
]);
const PRICING_FIELDS = new Set([
  "type", "fixed_amount", "min_amount", "max_amount", "price_list", "unit",
  "amount_per_unit", "interval",
]);
const ACTION_FIELDS = new Set([
  "ownershipPolicy", "effect", "replayPolicy", "retentionSeconds",
  "confirmationSummarySchema", "confirmationSummaryTemplate",
]);

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function noUnknown(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`${label} fields are invalid`);
  }
}

function atomic(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,77})$/.test(value)) {
    throw new Error(`${label} must be an atomic-unit integer string`);
  }
  return value;
}

export function parseUsdcPricing(
  raw: unknown,
  declaredPaymentRequired: boolean,
): Record<string, unknown> {
  const pricing = object(raw, "skill pricing");
  if (Object.keys(pricing).length !== 1 || !pricing.USDC) {
    throw new Error("skill pricing must declare exactly the supported USDC rail");
  }
  const usdc = object(pricing.USDC, "USDC pricing");
  noUnknown(usdc, PRICING_FIELDS, "USDC pricing");
  if (typeof usdc.type !== "string" || !PRICING_TYPES.has(usdc.type)) {
    throw new Error("USDC pricing type is invalid");
  }
  const fixed = atomic(usdc.fixed_amount, "fixed_amount");
  const minimum = atomic(usdc.min_amount, "min_amount");
  const maximum = atomic(usdc.max_amount, "max_amount");
  const perUnit = atomic(usdc.amount_per_unit, "amount_per_unit");
  if (
    fixed !== undefined &&
    (minimum !== undefined || maximum !== undefined ||
      perUnit !== undefined || usdc.price_list !== undefined)
  ) throw new Error("fixed_amount cannot be combined with another amount mechanism");
  if (minimum !== undefined && maximum !== undefined && BigInt(minimum) > BigInt(maximum)) {
    throw new Error("USDC minimum exceeds maximum");
  }
  if (usdc.unit !== undefined && (
    typeof usdc.unit !== "string" || usdc.unit.length < 1 || usdc.unit.length > 128
  )) throw new Error("USDC pricing unit is invalid");
  if (usdc.interval !== undefined) {
    const interval = object(usdc.interval, "pricing interval");
    if (
      Object.keys(interval).length !== 2 ||
      !["day", "week", "month", "year"].includes(interval.unit as string) ||
      !Number.isSafeInteger(interval.count) ||
      (interval.count as number) < 1 ||
      (interval.count as number) > 10_000
    ) throw new Error("USDC pricing interval is invalid");
  }
  let hasPriceList = false;
  if (usdc.price_list !== undefined) {
    const priceList = object(usdc.price_list, "USDC price list");
    const entries = Object.entries(priceList);
    if (
      entries.length < 1 || entries.length > 256 ||
      entries.some(([key, value]) =>
        key.length < 1 || key.length > 128 || atomic(value, "price-list amount") === undefined)
    ) throw new Error("USDC price list is invalid");
    hasPriceList = true;
  }
  if (usdc.type === "usage") {
    if (perUnit === undefined) throw new Error("usage pricing requires amount_per_unit");
  } else if (
    fixed === undefined && minimum === undefined && maximum === undefined && !hasPriceList
  ) {
    throw new Error("USDC pricing has no admitted amount");
  }
  const paymentRequired = fixed !== "0";
  if (paymentRequired !== declaredPaymentRequired) {
    throw new Error("paymentRequired does not match canonical USDC pricing");
  }
  return pricing;
}

export function parseAssetAction(args: {
  raw: unknown;
  inputSchema: Record<string, unknown>;
  requiresAssetOwnership: boolean;
  assetType: string | null;
}): PublishedAssetActionContract | null {
  if (args.raw === null) return null;
  if (!args.requiresAssetOwnership || !args.assetType) {
    throw new Error("asset actions require an owned asset type");
  }
  const action = object(args.raw, "skill asset action");
  noUnknown(action, ACTION_FIELDS, "skill asset action");
  if (
    action.ownershipPolicy !== "owner-only" ||
    !["read", "mutate", "destructive"].includes(action.effect as string) ||
    !["stable-result", "regenerate-ephemeral", "redacted-after-window"]
      .includes(action.replayPolicy as string) ||
    !Number.isSafeInteger(action.retentionSeconds) ||
    (action.retentionSeconds as number) < 1 ||
    (action.retentionSeconds as number) > 31_536_000 ||
    (action.replayPolicy === "redacted-after-window" &&
      (action.retentionSeconds as number) > 604_800)
  ) throw new Error("skill asset action policy is invalid");

  const destructive = action.effect === "destructive";
  const summarySchema = action.confirmationSummarySchema;
  const summaryTemplate = action.confirmationSummaryTemplate;
  if (
    destructive !== (summarySchema !== undefined && summaryTemplate !== undefined) ||
    (destructive && (action.retentionSeconds as number) <= 600)
  ) throw new Error("destructive actions require a durable confirmation summary");
  if (destructive) {
    const schema = object(summarySchema, "confirmation summary schema");
    const template = object(summaryTemplate, "confirmation summary template");
    const validate = compileClosedResponseSchema(schema);
    if (!validate(template)) throw new Error("confirmation summary template is invalid");
    const requestProperties = object(args.inputSchema.properties, "action request properties");
    const summaryRequired = schema.required;
    if (
      !Array.isArray(summaryRequired) || summaryRequired.length < 1 ||
      summaryRequired.some((field) =>
        typeof field !== "string" ||
        !(field in requestProperties) ||
        !(field in template))
    ) throw new Error("confirmation summary must bind an action request field");
  }
  return action as unknown as PublishedAssetActionContract;
}
