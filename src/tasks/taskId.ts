import { createHash, randomBytes } from "node:crypto";

export const GATEWAY_TASK_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function createGatewayTaskId(): string {
  return randomBytes(32).toString("base64url");
}

export function isGatewayTaskId(value: string): boolean {
  return GATEWAY_TASK_ID_PATTERN.test(value);
}

export function hashGatewayTaskId(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}
