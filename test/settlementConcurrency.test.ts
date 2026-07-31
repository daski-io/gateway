import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hex } from "../src/types.js";
import { makePaymentSettledEvent } from "./helpers/mockChain.js";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";

const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;

describe("settlement database concurrency", () => {
  let gateway: TestGateway;

  beforeEach(async () => {
    gateway = await startTestGateway({
      providers: [
        {
          tokenId: 2n,
          name: "Provider",
          priceUsdcSmallest: "100000",
          categoryFamily: "other",
          serviceType: "other",
        },
      ],
    });
  });

  afterEach(async () => gateway.close());

  it("settles five distinct challenges without starving the main pool", async () => {
    const fixtures = [];
    for (let index = 0; index < 5; index += 1) {
      const challenge = await gateway.purchaseChallenge(2n, {
        buyerTokenId: "5",
      });
      fixtures.push({
        challenge,
        payload: await gateway.createPaymentPayload(
          challenge.paymentRequired!,
        ),
      });
      const transactionHash =
        `0x${(index + 1).toString(16).padStart(64, "0")}` as Hex;
      gateway.mockChain.queueSettlement({
        kind: "success",
        txHash: transactionHash,
        event: makePaymentSettledEvent({
          paymentId: BigInt(index + 1),
          serviceRef: ZERO_BYTES32,
          buyerAgentId: 5n,
          providerAgentId: 2n,
          totalAmount: 100_000n,
        }),
      });
    }

    const results = await Promise.all(
      fixtures.map(async ({ challenge, payload }) => {
        const response = await fetch(`${gateway.baseUrl}/settle`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            x402Version: 2,
            paymentPayload: payload,
            paymentRequirements: challenge.paymentRequired!.accepts[0],
          }),
        });
        return { status: response.status, body: await response.json() };
      }),
    );

    expect(results.map(({ status }) => status)).toEqual([
      200, 200, 200, 200, 200,
    ]);
    expect(gateway.mockChain.settlements).toHaveLength(5);
  });
});
