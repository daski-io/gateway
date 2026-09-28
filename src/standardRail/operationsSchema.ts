import { z } from "zod";

const time = z.number().int().nonnegative();
const id = z.string().min(1).max(128);
const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
export const fulfillmentViewSchema = z.object({
  phase: z.enum(["dns_pending", "waiting_capacity", "provisioning", "operator_attention"]),
  reasons: z.array(z.string().min(1).max(96)).max(32),
  pendingSince: time.nullable(), lastCheckedAt: time.nullable(), nextCheckAt: time.nullable(),
  missingRecords: z.array(z.object({ type: z.enum(["MX", "TXT", "CNAME"]),
    name: z.string().min(1).max(253), value: z.string().min(1).max(2048),
    priority: z.number().int().min(0).max(65535).nullable() }).strict()).max(32),
  accumulatedWaitSeconds: time,
}).strict();
export const recoveryViewSchema = z.object({
  recoveryId: id, reviewId: id,
  state: z.enum(["queued", "pending", "running", "attention", "completed", "stopped"]),
  originalTerminal: z.object({ state: z.literal("failed"), completedAt: time,
    resultHash: hash }).strict(),
  startedAt: time.nullable(), completedAt: time.nullable(), resultHash: hash.nullable(),
}).strict();
export const operationsSchema = z.object({
  schemaVersion: z.literal(1), revision: time, observedAt: time,
  fulfillment: fulfillmentViewSchema.nullable(),
  support: z.object({ reviewId: id, status: z.enum(["open", "closed"]),
    lastAcceptedRequest: z.object({ requestId: id, messageId: id, acceptedAt: time }).strict(),
    // The provider's latest operator reply, present once one exists. It is
    // returned to the buyer and never retained by the gateway.
    lastReply: z.object({ messageId: id, repliedAt: time, message: z.string().min(1).max(4_000) }).strict().optional(),
  }).strict().nullable(),
  recovery: recoveryViewSchema.nullable(),
}).strict();
export type OrderOperations = z.infer<typeof operationsSchema>;
