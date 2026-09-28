import { z } from "zod";
import { standardRailError } from "./errors.js";

export const supportRequestSchema = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  message: z.string().min(1).max(4000).refine(value => value.trim().length > 0 &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)),
}).strict();

export const supportResultSchema = z.object({
  supportReceipt: z.object({
    requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    messageId: z.string().uuid(),
    reviewId: z.string().uuid(),
    acceptedAt: z.string().datetime(),
  }).strict(),
}).strict();

export function validateSupportRequest(action: string, request: unknown): void {
  if (action === "support" && !supportRequestSchema.safeParse(request).success) {
    throw standardRailError("REQUEST_SCHEMA_INVALID", {
      message: "Support requires requestId and message. Reuse requestId with a fresh authorization when retrying.",
    });
  }
}
