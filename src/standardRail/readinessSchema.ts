import { z } from "zod";

export const readinessSchema = z.object({
  state: z.enum(["ready", "dns_pending", "blocked"]),
  reasons: z.array(z.string().min(1).max(96)).max(32),
  checkedAt: z.number().int().nonnegative(),
  ownership: z.enum(["verified", "unknown", "mismatch"]),
  dns: z.enum(["verified", "unverified", "conflict", "lookup_unavailable"]),
  records: z.array(z.object({
    type: z.enum(["MX", "TXT", "CNAME"]),
    name: z.string().min(1).max(253), host: z.string().min(1).max(253),
    value: z.string().min(1).max(2048), priority: z.number().int().min(0).max(65535).nullable(),
  }).strict()).max(32),
}).strict();
export type PurchaseReadiness = z.infer<typeof readinessSchema>;
