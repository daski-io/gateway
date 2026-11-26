import { z } from "zod";
import { DELIVERABLES_ADDITION } from "./deliverables.js";

/// The provider's buyer-facing additions to a payer-authorized order status
/// read: the input request of an order waiting for the buyer, and the
/// order's documents. They hold the buyer's own submitted values, so the
/// gateway validates and passes them through on that read only, and never
/// stores or logs them. Mirrors daski-provider
/// src/core/standardRail/orderStatusView.ts.

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const time = z.number().int().nonnegative();
const displayText = (max: number) =>
  z.string().min(1).max(max).refine((value) => !CONTROL_CHARACTERS.test(value));
const displayValue = z.string().max(1_000).refine((value) => !CONTROL_CHARACTERS.test(value));

export const inputRequestFieldSchema = z.object({
  path: z.string().min(1).max(256).regex(/^[A-Za-z0-9_.[\]-]+$/),
  label: displayText(200),
  value: z.union([displayValue, z.number().finite(), z.boolean(), z.null()]),
  status: z.enum(["as_submitted", "withheld", "set_by_daski"]),
  editable: z.boolean(),
}).strict();

export const inputRequestSchema = z.object({
  schemaVersion: z.literal(1),
  requestedAt: time,
  cause: z.enum(["supplier_attention", "validation", "supplier_rejected_correction"]),
  summary: displayText(1_000),
  reason: displayText(2_000).nullable(),
  fields: z.array(inputRequestFieldSchema).min(1).max(250),
}).strict();

export const orderDocumentSchema = z.object({
  documentId: z.string().uuid(),
  title: displayText(256),
  type: displayText(96),
  receivedAt: time,
}).strict();

export const orderDocumentsSchema = z.array(orderDocumentSchema).min(1).max(50);

/// The provider's sales tax statement for the order: what the paid amount
/// includes for tax and fees, per jurisdiction. Amounts are US dollars as
/// exact decimal strings (USDC's six decimals; sub-cent digits kept). It
/// carries no address and no rate-source evidence. Mirrors daski-provider
/// src/core/tax/orderStatus.ts.
const usdAmount = z.string().regex(/^(0|[1-9]\d{0,12})\.\d{2,6}$/);
// A rate below 100%, as the provider parses it.
const exactRate = "0(?:\\.\\d{1,12})?";
const RATE = new RegExp(`^${exactRate}(?: / ${exactRate}){0,9}$`, "u");

export const salesTaxJurisdictionSchema = z.object({
  name: displayText(200),
  type: displayText(64),
  rate: z.string().max(200).regex(RATE),
  taxUsd: usdAmount,
}).strict();

export const salesTaxFeeSchema = z.object({
  label: displayText(200),
  amountUsd: usdAmount,
}).strict();

export const salesTaxSchema = z.object({
  schemaVersion: z.literal(1),
  state: z.string().regex(/^[A-Z]{2}$/),
  jurisdictionCode: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,31}$/),
  priceUsd: usdAmount,
  taxableAmountUsd: usdAmount,
  jurisdictions: z.array(salesTaxJurisdictionSchema).max(50),
  fees: z.array(salesTaxFeeSchema).max(10),
  totalTaxUsd: usdAmount,
  totalFeesUsd: usdAmount,
  totalUsd: usdAmount,
  paidUsd: usdAmount,
  includedInPaidAmount: z.literal(true),
}).strict();

export type SalesTax = z.infer<typeof salesTaxSchema>;

/** A dollar string from `salesTaxSchema` as USDC atomic units. */
export function usdAtomic(amount: string): bigint {
  const [whole, fraction = ""] = amount.split(".");
  return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

/**
 * Whether a schema-valid statement adds up and states what this order paid:
 * jurisdiction taxes to the total tax, fees to the total fees, both to the
 * total, price plus total to the paid amount, which is the order's own gross
 * (USDC atomic units), and the taxable amount within the price.
 */
export function salesTaxAddsUp(tax: SalesTax, orderGrossAmount: string): boolean {
  const sum = (values: string[]) => values.reduce((total, value) => total + usdAtomic(value), 0n);
  const totalTax = usdAtomic(tax.totalTaxUsd);
  const totalFees = usdAtomic(tax.totalFeesUsd);
  const total = usdAtomic(tax.totalUsd);
  const price = usdAtomic(tax.priceUsd);
  const paid = usdAtomic(tax.paidUsd);
  return /^(0|[1-9]\d*)$/.test(orderGrossAmount) &&
    sum(tax.jurisdictions.map((entry) => entry.taxUsd)) === totalTax &&
    sum(tax.fees.map((fee) => fee.amountUsd)) === totalFees &&
    totalTax + totalFees === total &&
    price + total === paid &&
    paid === BigInt(orderGrossAmount) &&
    usdAtomic(tax.taxableAmountUsd) <= price;
}

/** The additions as one object, the shape consumers vendor as a wire fixture. */
export const orderStatusAdditionsSchema = z.object({
  inputRequest: inputRequestSchema.optional(),
  documents: orderDocumentsSchema.optional(),
  salesTax: salesTaxSchema.optional(),
}).strict();

/// Every provider lifecycle POST asks for the additions with this header. A
/// provider adds them only when asked, because a gateway released before
/// them checks the response's keys exactly and refuses the read. Expand,
/// then contract: once every network serves a gateway that sends it,
/// providers can add them unasked and the header can go.
export const ORDER_STATUS_VIEW_HEADER = "daski-order-status-view";

/// The additions this gateway accepts beyond `inputRequest` and `documents`,
/// by name, comma-separated: `salesTax` on status reads and order input
/// answers, and `deliverables`, the standard deliverables data part
/// (deliverables.ts) in an artifact read's result. A provider adds one only
/// when this header names it: a gateway released before it refuses the
/// unknown key or part, and a provider released before it ignores the header.
/// The existing view header stays unchanged so providers that predate this
/// one keep their additions.
export const ORDER_STATUS_ADDITIONS_HEADER = "daski-order-status-additions";
export const ACCEPTED_ORDER_STATUS_ADDITIONS = ["salesTax", DELIVERABLES_ADDITION] as const;

/** The headers of a provider lifecycle POST, published as a wire fixture. */
export const PROVIDER_LIFECYCLE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/json",
  [ORDER_STATUS_VIEW_HEADER]: "1",
  [ORDER_STATUS_ADDITIONS_HEADER]: ACCEPTED_ORDER_STATUS_ADDITIONS.join(", "),
});

export type InputRequest = z.infer<typeof inputRequestSchema>;
export type OrderDocument = z.infer<typeof orderDocumentSchema>;
