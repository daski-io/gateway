import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "../src/types.js";
import { DaskiExactEvmScheme } from "../src/payment/daskiClient.js";
import { deriveDaskiReceiveNonce } from "../src/payment/daskiNonce.js";

const VECTOR = {
  adapter: "0x000000000000000000000000000000000000a004",
  router: "0x000000000000000000000000000000000000a002",
  token: "0x000000000000000000000000000000000000a003",
  payer: "0x1111111111111111111111111111111111111111",
  amount: 15_000_000n,
  validAfter: 0n,
  validBefore: 2_000_000_000n,
  providerAgentId: 2n,
  serviceId: (`0x${"22".repeat(32)}`) as Hex,
  expectedPayee: "0x000000000000000000000000000000000000bEEF",
  serviceRef: (`0x${"33".repeat(32)}`) as Hex,
  nonceSalt: (`0x${"44".repeat(32)}`) as Hex,
} as const;

describe("Daski receive authorization nonce", () => {
  it("matches the reviewed Base Sepolia and Base Mainnet vectors", () => {
    expect(
      deriveDaskiReceiveNonce({ ...VECTOR, chainId: 84_532 }),
    ).toBe(
      "0x6895237ed56c402a03e8bdad76bdaaa360aea6460ca448a08c4bb2afcf8e901e",
    );
    expect(
      deriveDaskiReceiveNonce({ ...VECTOR, chainId: 8_453 }),
    ).toBe(
      "0xe8c5ed2d18601764774c354819c70a9abf284906a8ec0aca4dae2152d0697bc0",
    );
  });

  it("changes when the route or random salt changes", () => {
    const expected = deriveDaskiReceiveNonce({
      ...VECTOR,
      chainId: 84_532,
    });
    expect(
      deriveDaskiReceiveNonce({
        ...VECTOR,
        chainId: 84_532,
        providerAgentId: 3n,
      }),
    ).not.toBe(expected);
    expect(
      deriveDaskiReceiveNonce({
        ...VECTOR,
        chainId: 84_532,
        expectedPayee:
          "0x000000000000000000000000000000000000beee",
      }),
    ).not.toBe(expected);
    expect(
      deriveDaskiReceiveNonce({
        ...VECTOR,
        chainId: 84_532,
        nonceSalt: (`0x${"45".repeat(32)}`) as Hex,
      }),
    ).not.toBe(expected);
  });

  it("uses the server-issued absolute authorization expiry", async () => {
    const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const result = await new DaskiExactEvmScheme(
      account,
    ).createPaymentPayload(
      2,
      {
        scheme: "daski-exact",
        network: "eip155:84532",
        amount: VECTOR.amount.toString(),
        asset: VECTOR.token,
        payTo: VECTOR.adapter,
        maxTimeoutSeconds: 1,
        extra: {
          assetTransferMethod: "eip3009-receive",
          name: "USDC",
          version: "2",
          daskiProfile: "1",
          authorizationValidBefore: VECTOR.validBefore.toString(),
          paymentRouter: VECTOR.router,
          providerAgentId: VECTOR.providerAgentId.toString(),
          serviceId: VECTOR.serviceId,
          expectedPayee: VECTOR.expectedPayee,
          serviceRef: VECTOR.serviceRef,
        },
      },
    );

    expect(
      (
        result.payload as {
          authorization: { validBefore: string };
        }
      ).authorization.validBefore,
    ).toBe(VECTOR.validBefore.toString());
  });
});
