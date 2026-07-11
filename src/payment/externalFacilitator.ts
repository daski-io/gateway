/**
 * Thin HTTP client for an EXTERNAL x402 facilitator's /verify + /settle
 * endpoints (CDP facilitator on Base mainnet, x402.org on Base Sepolia).
 *
 * Used by the Bazaar-facing resource route: the gateway acts as a standard
 * x402 resource server, forwarding the client's payment payload to the
 * external facilitator instead of settling on-chain itself. This is what
 * makes Daski resources indexable by the x402 Bazaar — CDP catalogs a
 * resource the first time ITS facilitator settles a payment for it, with
 * `paymentPayload.resource` set.
 *
 * The gateway's own on-chain split then runs as a follow-up attribution tx
 * (see DirectTransferAdapter) — the external facilitator only executes the
 * bare EIP-3009 transfer into the PaymentRouter.
 *
 * Auth: the CDP facilitator requires a CDP API key JWT (Authorization
 * header) for mainnet /settle. The gateway treats the header value as an
 * opaque config string (EXTERNAL_FACILITATOR_AUTH_HEADER) so operators can
 * mint it with CDP tooling out-of-band; testnet facilitators typically
 * need none.
 */

export interface ExternalVerifyResponse {
  isValid: boolean;
  invalidReason?: string | null;
  payer?: string | null;
}

export interface ExternalSettleResponse {
  success: boolean;
  errorReason?: string | null;
  transaction?: string | null;
  network?: string | null;
  payer?: string | null;
}

export interface ExternalFacilitatorClient {
  /** POST {base}/verify with the full facilitator body (verbatim). */
  verify(body: Record<string, unknown>): Promise<ExternalVerifyResponse>;
  /** POST {base}/settle with the full facilitator body (verbatim). */
  settle(body: Record<string, unknown>): Promise<ExternalSettleResponse>;
}

export interface ExternalFacilitatorOptions {
  baseUrl: string;
  /** Raw `Authorization` header value, e.g. `Bearer <cdp-jwt>`. */
  authHeader?: string;
  /** Test seam. Defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Per-request timeout. Settles submit an on-chain tx — allow for a
   *  confirmation wait. */
  timeoutMs?: number;
}

export function createExternalFacilitatorClient(
  opts: ExternalFacilitatorOptions,
): ExternalFacilitatorClient {
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const baseUrl = opts.baseUrl.replace(/\/$/, "");

  async function post(
    path: "/verify" | "/settle",
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (opts.authHeader) headers["authorization"] = opts.authHeader;

    let res: Response;
    try {
      res = await fetchFn(`${baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new Error(
        `external facilitator ${path} unreachable: ${(err as Error).message}`,
      );
    }

    // Facilitators return structured errors with non-2xx statuses too
    // (e.g. 400 { isValid: false, invalidReason }). Parse the body first
    // and let the caller interpret the flags; only throw when there's no
    // JSON to interpret.
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      // fall through
    }
    if (json === null || typeof json !== "object") {
      throw new Error(
        `external facilitator ${path} returned ${res.status} with a non-JSON body`,
      );
    }
    return json as Record<string, unknown>;
  }

  return {
    async verify(body) {
      const json = await post("/verify", body);
      return {
        isValid: json["isValid"] === true,
        invalidReason:
          typeof json["invalidReason"] === "string"
            ? (json["invalidReason"] as string)
            : null,
        payer: typeof json["payer"] === "string" ? (json["payer"] as string) : null,
      };
    },
    async settle(body) {
      const json = await post("/settle", body);
      return {
        success: json["success"] === true,
        errorReason:
          typeof json["errorReason"] === "string"
            ? (json["errorReason"] as string)
            : null,
        transaction:
          typeof json["transaction"] === "string"
            ? (json["transaction"] as string)
            : null,
        network:
          typeof json["network"] === "string" ? (json["network"] as string) : null,
        payer: typeof json["payer"] === "string" ? (json["payer"] as string) : null,
      };
    },
  };
}
