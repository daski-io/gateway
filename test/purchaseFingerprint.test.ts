import { describe, expect, it } from "vitest";
import { purchaseRequestFingerprint } from "../src/mcp/buyServiceTypes.js";
import type { BuyServiceArgs } from "../src/mcp/buyServiceTypes.js";
import type { PaymentPayload } from "../src/types.js";

const purchase: BuyServiceArgs = {
  providerTokenId: "2",
  serviceSlug: "example-service",
  buyerTokenId: "5",
  walletAddress: "0x1111111111111111111111111111111111111111",
  skillId: "example-skill",
  serviceArgs: { example: "value" },
};

describe("purchaseRequestFingerprint", () => {
  it("excludes only the payment transport wrapper", () => {
    const firstPayload = { x402Version: 2 } as unknown as PaymentPayload;
    const secondPayload = {
      x402Version: 2,
      payload: { changed: true },
    } as unknown as PaymentPayload;
    const original = purchaseRequestFingerprint(purchase);

    expect(
      purchaseRequestFingerprint({ ...purchase, paymentPayload: firstPayload }),
    ).toBe(original);
    expect(
      purchaseRequestFingerprint({ ...purchase, paymentPayload: secondPayload }),
    ).toBe(original);
    expect(
      purchaseRequestFingerprint({
        ...purchase,
        serviceArgs: { example: "different" },
      }),
    ).not.toBe(original);
  });
});
