import { z } from "zod";
import { standardRailError } from "./errors.js";

export const supportRequestSchema = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  message: z.string().min(1).max(4000),
}).strict();

export function validateSupportRequest(action: string, request: unknown): void {
  if (action === "support" && !supportRequestSchema.safeParse(request).success) {
    throw standardRailError("REQUEST_SCHEMA_INVALID", {
      message: "Support requires requestId and message. Reuse requestId with a fresh authorization when retrying.",
    });
  }
}
