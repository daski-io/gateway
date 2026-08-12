import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = 1;

export function encryptPaymentPayload(key: Buffer, value: unknown): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(value), "utf8")),
    cipher.final(),
  ]);
  return Buffer.concat([
    Buffer.from([VERSION]),
    nonce,
    cipher.getAuthTag(),
    body,
  ]);
}

export function decryptPaymentPayload<T>(key: Buffer, envelope: Buffer): T {
  if (envelope[0] !== VERSION || envelope.length < 30) {
    throw new Error("Unsupported encrypted payment envelope");
  }
  const nonce = envelope.subarray(1, 13);
  const tag = envelope.subarray(13, 29);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  const clear = Buffer.concat([
    decipher.update(envelope.subarray(29)),
    decipher.final(),
  ]);
  return JSON.parse(clear.toString("utf8")) as T;
}
