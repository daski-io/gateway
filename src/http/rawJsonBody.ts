import type { Request, Response } from "express";

const rawJsonBodies = new WeakMap<Request, Buffer>();

export function captureRawJsonBody(
  request: Request,
  _response: Response,
  body: Buffer,
): void {
  if (!request.path.startsWith("/x402/v1/")) return;
  rawJsonBodies.set(request, Buffer.from(body));
}

export function getRawJsonBody(request: Request): Buffer {
  return rawJsonBodies.get(request) ?? Buffer.alloc(0);
}
