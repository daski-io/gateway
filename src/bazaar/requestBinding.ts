import type { Request } from "express";
import { encodeAbiParameters, keccak256, toBytes, type Hex } from "viem";
import { getRawJsonBody } from "../http/rawJsonBody.js";
import type { ListingOfferV1 } from "./types.js";

const REQUEST_DOMAIN_HASH = keccak256(toBytes("DASKI_BAZAAR_REQUEST_V1"));
const EMPTY_OBJECT_BYTES = toBytes("{}");
const EMPTY_JSON_PATTERN = /^[\x20\x09\x0a\x0d]*\{[\x20\x09\x0a\x0d]*\}[\x20\x09\x0a\x0d]*$/;

export type StockFixedRequestResult =
  | { ok: true; requestHash: Hex }
  | { ok: false; status: number; code: string };

export function validateStockFixedRequest(
  request: Request,
  offer: ListingOfferV1,
): StockFixedRequestResult {
  if (
    request.headers["content-encoding"] !== undefined ||
    request.headers["transfer-encoding"] !== undefined
  ) {
    return { ok: false, status: 400, code: "alternate_request_framing_forbidden" };
  }
  if (request.originalUrl.includes("?")) {
    return { ok: false, status: 400, code: "query_string_forbidden" };
  }
  const raw = getRawJsonBody(request);
  if (raw.length === 0) {
    if (request.get("content-type") !== undefined) {
      return { ok: false, status: 415, code: "bodyless_content_type_forbidden" };
    }
  } else {
    const contentType = request.get("content-type")?.toLowerCase();
    if (
      contentType !== "application/json" &&
      contentType !== "application/json; charset=utf-8"
    ) {
      return { ok: false, status: 415, code: "content_type_must_be_json" };
    }
    if (!EMPTY_JSON_PATTERN.test(raw.toString("utf8"))) {
      return { ok: false, status: 400, code: "request_body_must_be_empty_object" };
    }
  }
  if (
    request.body !== undefined &&
    (request.body === null ||
      typeof request.body !== "object" ||
      Array.isArray(request.body) ||
      Object.keys(request.body as Record<string, unknown>).length !== 0)
  ) {
    return { ok: false, status: 400, code: "request_body_must_be_empty_object" };
  }
  return { ok: true, requestHash: canonicalRequestHash(offer) };
}

export function canonicalRequestHash(offer: ListingOfferV1): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        REQUEST_DOMAIN_HASH,
        offer.methodHash,
        offer.resourceHash,
        keccak256(EMPTY_OBJECT_BYTES),
        offer.requestSchemaHash,
        offer.requestBindingModeHash,
      ],
    ),
  );
}
