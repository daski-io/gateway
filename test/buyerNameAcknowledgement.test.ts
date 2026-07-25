import { describe, expect, it } from "vitest";
import {
  checkBuyerNameAcknowledgement,
  expectedBuyerNameAcknowledgementToken,
} from "../src/mcp/util.js";
import { siblingServiceTypes } from "../src/serviceTaxonomy.js";

function payload(result: { content: unknown[] } | null) {
  const first = result!.content[0] as { type: string; text: string };
  return JSON.parse(first.type === "text" ? first.text : "{}");
}

// The buyer-name gate: an atomic first purchase with no `name` would
// permanently mint `buyer-<last6>`, so it is gated the same way phone values
// are — one acknowledgement, or pass `name` and never see it.
describe("buyer name acknowledgement gate", () => {
  it("rejects a defaulted name, exposing the default and its token", () => {
    const err = checkBuyerNameAcknowledgement("buyer-aa39aa", undefined);
    expect(err).not.toBeNull();
    const body = payload(err);
    expect(body.code).toBe("BUYER_NAME_ACKNOWLEDGEMENT_REQUIRED");
    expect(body.details.resolvedDefaultName).toBe("buyer-aa39aa");
    expect(body.details.buyerNameAcknowledgementToken).toBe(
      expectedBuyerNameAcknowledgementToken("buyer-aa39aa"),
    );
    expect(body.recoverable).toBe(true);
    // The message must push toward naming, not toward acknowledging.
    expect(body.message).toContain("`name`");
  });

  it("passes with the bound token", () => {
    const token = expectedBuyerNameAcknowledgementToken("buyer-aa39aa");
    expect(checkBuyerNameAcknowledgement("buyer-aa39aa", token)).toBeNull();
  });

  it("does not let one wallet's token authorize another's default", () => {
    const token = expectedBuyerNameAcknowledgementToken("buyer-aa39aa");
    expect(checkBuyerNameAcknowledgement("buyer-bb40bb", token)).not.toBeNull();
  });
});

// Discovery steer: every taxonomy slug is a legal filter, so an empty result
// must not read as "you guessed wrong" — it names the stocked siblings.
describe("service type siblings", () => {
  it("returns the rest of the family for a valid slug", () => {
    const siblings = siblingServiceTypes("llc-formation");
    expect(siblings).toContain("entity-formation");
    expect(siblings).not.toContain("llc-formation");
  });

  it("returns nothing for a slug outside the taxonomy", () => {
    expect(siblingServiceTypes("not-a-real-service-type")).toEqual([]);
  });
});
