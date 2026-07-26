import { describe, expect, it } from "vitest";
import { mapProviderRpcError } from "../src/mcp/rpcErrors.js";

// Provider RPC errors used to flatten to a generic PROVIDER_ERROR with the
// real signal buried in details.rpcCode — agents recovered only by digging
// the -32107 challenge out of nested data (260725 review, verified).
describe("provider rpc error mapping", () => {
  it("names the capability challenge and marks it recoverable", () => {
    const mapped = mapProviderRpcError(-32107);
    expect(mapped?.code).toBe("CAPABILITY_REQUIRED");
    expect(mapped?.recoverable).toBe(true);
    expect(mapped?.nextAction).toContain("capability");
  });

  it("names envelope rejection with the byte-match rule", () => {
    const mapped = mapProviderRpcError(-32110);
    expect(mapped?.code).toBe("ENVELOPE_AUTH_REJECTED");
    expect(mapped?.nextAction).toContain("bytes you signed");
  });

  it("returns null for unknown codes so callers fall back", () => {
    expect(mapProviderRpcError(-31999)).toBeNull();
    expect(mapProviderRpcError(undefined)).toBeNull();
  });
});

// De-scar 260726: the reply-policy extractor and the buyer-name gate are
// gone (behavior-shaping transport and consent theater, respectively) —
// their suites went with them. Status text still flows in `messages`;
// name divergence is a quote warning covered in tier1Contract.test.ts.
