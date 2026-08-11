import type { Request } from "express";

interface BazaarRequestContext {
  receivedAt: bigint;
  paymentSignature: string | string[] | undefined;
  legacyPaymentPresent: boolean;
}

const contexts = new WeakMap<Request, BazaarRequestContext>();
const NANOS_PER_SECOND = 1_000_000_000n;

export function captureBazaarRequestContext(request: Request): void {
  if (contexts.has(request)) return;
  contexts.set(request, {
    receivedAt: process.hrtime.bigint(),
    paymentSignature: request.headers["payment-signature"],
    legacyPaymentPresent: request.headers["x-payment"] !== undefined,
  });
  redactHeader(request, "payment-signature");
  redactHeader(request, "x-payment");
}

export function takeBazaarPaymentHeaders(request: Request): {
  paymentSignature: string | string[] | undefined;
  legacyPaymentPresent: boolean;
} {
  const context = contexts.get(request);
  if (!context) {
    return { paymentSignature: undefined, legacyPaymentPresent: false };
  }
  const result = {
    paymentSignature: context.paymentSignature,
    legacyPaymentPresent: context.legacyPaymentPresent,
  };
  context.paymentSignature = undefined;
  context.legacyPaymentPresent = false;
  return result;
}

export function hasBazaarPaymentSignature(request: Request): boolean {
  return contexts.get(request)?.paymentSignature !== undefined;
}

export function bazaarIngressAgeSeconds(request: Request): bigint {
  const receivedAt = contexts.get(request)?.receivedAt;
  if (receivedAt === undefined) return 0n;
  const elapsed = process.hrtime.bigint() - receivedAt;
  return (elapsed + NANOS_PER_SECOND - 1n) / NANOS_PER_SECOND;
}

export function clearBazaarRequestContext(request: Request): void {
  const context = contexts.get(request);
  if (context) context.paymentSignature = undefined;
  contexts.delete(request);
}

function redactHeader(request: Request, headerName: string): void {
  delete request.headers[headerName];
  const rawHeaders = request.rawHeaders as string[];
  for (let index = 0; index < rawHeaders.length - 1; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === headerName) {
      rawHeaders[index + 1] = "[REDACTED]";
    }
  }
}
