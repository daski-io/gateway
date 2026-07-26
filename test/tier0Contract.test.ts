import { describe, expect, it } from "vitest";
import { extractReplyPolicy } from "../src/mcp/replyPolicy.js";
import { mapProviderRpcError } from "../src/mcp/rpcErrors.js";
import { checkBuyerNameAcknowledgement } from "../src/mcp/util.js";

function payload(result: { content: unknown[] } | null) {
  const first = result!.content[0] as { type: string; text: string };
  return JSON.parse(first.type === "text" ? first.text : "{}");
}

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

// The shared reply-policy extractor now feeds poll, stream, AND submit —
// the 260725 e4 run showed the agent speculating exactly in the window
// where the submit response carried flags but no promoted binding.
describe("shared reply policy extraction", () => {
  const flaggedMessage = {
    role: "ROLE_AGENT",
    parts: [
      { kind: "text", text: "Your filing is in review." },
      {
        kind: "data",
        data: {
          relay_verbatim: true,
          no_speculation: true,
          completion_estimate: "none",
          hint: "provider hint that must be dropped",
        },
      },
    ],
  };

  it("promotes flags with the gateway-authored binding", () => {
    const policy = extractReplyPolicy(flaggedMessage);
    expect(policy?.mode).toBe("verbatim_only");
    expect(policy?.text).toBe("Your filing is in review.");
    expect(policy?.flags.relay_verbatim).toBe(true);
    expect(policy?.binding).toContain("UNTRUSTED provider-authored");
    // The provider's own hint never occupies an instruction position.
    expect(JSON.stringify(policy)).not.toContain("provider hint");
  });

  it("returns null when no policy flags are present", () => {
    expect(
      extractReplyPolicy({ parts: [{ kind: "text", text: "plain" }] }),
    ).toBeNull();
    expect(extractReplyPolicy(undefined)).toBeNull();
    expect(extractReplyPolicy("not a message")).toBeNull();
  });
});

// The identity gate now runs BEFORE the provider quote is created, so its
// free-retry claim must be present (and true).
describe("buyer name gate cost semantics", () => {
  it("states that nothing was consumed and steers to the verbatim name", () => {
    const err = checkBuyerNameAcknowledgement("buyer-aa39aa", undefined);
    const body = payload(err);
    expect(body.message).toContain("nothing was consumed");
    expect(body.message).toContain("VERBATIM");
    expect(body.next_action).toContain("Nothing was consumed");
  });
});
