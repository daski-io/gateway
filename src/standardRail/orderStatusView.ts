import { z } from "zod";

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

/** The additions as one object, the shape consumers vendor as a wire fixture. */
export const orderStatusAdditionsSchema = z.object({
  inputRequest: inputRequestSchema.optional(),
  documents: orderDocumentsSchema.optional(),
}).strict();

/// Every provider lifecycle POST asks for the additions with this header. A
/// provider adds them only when asked, because a gateway released before
/// them checks the response's keys exactly and refuses the read. Expand,
/// then contract: once every network serves a gateway that sends it,
/// providers can add them unasked and the header can go.
export const ORDER_STATUS_VIEW_HEADER = "daski-order-status-view";

/** The headers of a provider lifecycle POST, published as a wire fixture. */
export const PROVIDER_LIFECYCLE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/json",
  [ORDER_STATUS_VIEW_HEADER]: "1",
});

export type InputRequest = z.infer<typeof inputRequestSchema>;
export type OrderDocument = z.infer<typeof orderDocumentSchema>;
