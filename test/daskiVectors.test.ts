import { readFileSync } from "node:fs";
import {
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  recoverAddress,
  toBytes,
} from "viem";
import { describe, expect, it } from "vitest";
import type { Hex } from "../src/types.js";
import { deriveDaskiReceiveNonce } from "../src/payment/daskiNonce.js";
import { RECEIVE_WITH_AUTHORIZATION_TYPES } from "../src/payment/protocol.js";
import { computeUsdcDomainSeparator } from "../src/payment/usdcDomain.js";

interface Vector {
  network: string;
  chainId: 8453 | 84532;
  token: Hex;
  decimals: 6;
  name: string;
  version: string;
  domainSeparator: Hex;
  adapter: Hex;
  router: Hex;
  payer: Hex;
  amount: string;
  validAfter: string;
  validBefore: string;
  providerAgentId: string;
  serviceId: Hex;
  serviceRef: Hex;
  nonceSalt: Hex;
  nonce: Hex;
  structHash: Hex;
  digest: Hex;
  signer: Hex;
  signature: Hex;
}

const vectors = (
  JSON.parse(
    readFileSync(new URL("./vectors/daski-x402.json", import.meta.url), "utf8"),
  ) as { schema: string; vectors: Vector[] }
).vectors;

const RECEIVE_TYPEHASH = keccak256(
  toBytes(
    "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)",
  ),
);

describe("shared Daski x402 signature vectors", () => {
  it.each(vectors)("reproduces $network", async (vector) => {
    const amount = BigInt(vector.amount);
    const validAfter = BigInt(vector.validAfter);
    const validBefore = BigInt(vector.validBefore);
    const nonce = deriveDaskiReceiveNonce({
      chainId: vector.chainId,
      adapter: vector.adapter,
      router: vector.router,
      token: vector.token,
      payer: vector.payer,
      amount,
      validAfter,
      validBefore,
      providerAgentId: BigInt(vector.providerAgentId),
      serviceId: vector.serviceId,
      serviceRef: vector.serviceRef,
      nonceSalt: vector.nonceSalt,
    });
    expect(nonce).toBe(vector.nonce);
    expect(
      computeUsdcDomainSeparator(
        vector.chainId,
        vector.token,
        vector.name,
        vector.version,
      ),
    ).toBe(vector.domainSeparator);

    const structHash = keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "address" },
          { type: "address" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "bytes32" },
        ],
        [
          RECEIVE_TYPEHASH,
          vector.payer,
          vector.adapter,
          amount,
          validAfter,
          validBefore,
          nonce,
        ],
      ),
    );
    expect(structHash).toBe(vector.structHash);

    const digest = hashTypedData({
      domain: {
        name: vector.name,
        version: vector.version,
        chainId: vector.chainId,
        verifyingContract: vector.token,
      },
      types: RECEIVE_WITH_AUTHORIZATION_TYPES,
      primaryType: "ReceiveWithAuthorization",
      message: {
        from: vector.payer,
        to: vector.adapter,
        value: amount,
        validAfter,
        validBefore,
        nonce,
      },
    });
    expect(digest).toBe(vector.digest);
    await expect(
      recoverAddress({ hash: digest, signature: vector.signature }),
    ).resolves.toBe(vector.signer);
  });
});
