import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  recoverAddress,
  toBytes,
} from "viem";
import { describe, expect, it } from "vitest";

type Hex = `0x${string}`;

interface PublishedVector {
  network: string;
  chainId: number;
  token: Hex;
  tokenName: string;
  tokenVersion: string;
  adapter: Hex;
  router: Hex;
  payer: Hex;
  amount: string;
  validAfter: string;
  validBefore: string;
  providerAgentId: string;
  serviceId: Hex;
  expectedPayee: Hex;
  serviceRef: Hex;
  nonceSalt: Hex;
  expectedNonce: Hex;
  typedData: {
    domain: {
      name: string;
      version: string;
      chainId: number;
      verifyingContract: Hex;
    };
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, string>;
  };
  expectedSigner: Hex;
  signature: Hex;
}

const skillPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "static",
  "SKILL.md",
);
const skill = readFileSync(skillPath, "utf8");
const vectorMatch = skill.match(
  /```json daski-exact-signing-vector\r?\n([\s\S]*?)```/,
);
if (!vectorMatch?.[1]) throw new Error("SKILL.md has no signing vector");
const vector = JSON.parse(vectorMatch[1]) as PublishedVector;
const nonceDomain = keccak256(toBytes("DASKI_X402_RECEIVE_V1"));

describe("published daski-exact signing vector", () => {
  it("reproduces the nonce and constructs a complete signed payload", async () => {
    expect(skill).toContain(
      "keccak256(abi.encode(bytes32 DOMAIN, uint256 chainId, address adapter, address router, address token, address payer, uint256 amount, uint256 validAfter, uint256 validBefore, uint256 providerAgentId, bytes32 serviceId, address expectedPayee, bytes32 serviceRef, bytes32 nonceSalt))",
    );
    const nonce = keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "uint256" },
          { type: "address" },
          { type: "address" },
          { type: "address" },
          { type: "address" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "bytes32" },
          { type: "address" },
          { type: "bytes32" },
          { type: "bytes32" },
        ],
        [
          nonceDomain,
          BigInt(vector.chainId),
          vector.adapter,
          vector.router,
          vector.token,
          vector.payer,
          BigInt(vector.amount),
          BigInt(vector.validAfter),
          BigInt(vector.validBefore),
          BigInt(vector.providerAgentId),
          vector.serviceId,
          vector.expectedPayee,
          vector.serviceRef,
          vector.nonceSalt,
        ],
      ),
    );
    expect(nonce).toBe(vector.expectedNonce);
    expect(vector.typedData.message.nonce).toBe(nonce);

    const digest = hashTypedData({
      domain: vector.typedData.domain,
      types: vector.typedData.types,
      primaryType: vector.typedData.primaryType,
      message: vector.typedData.message,
    });
    await expect(
      recoverAddress({ hash: digest, signature: vector.signature }),
    ).resolves.toBe(vector.expectedSigner);

    const challenge = {
      x402Version: 2 as const,
      resource: { url: "https://gateway.example/purchase/2" },
      accepts: [
        {
          scheme: "daski-exact",
          network: "eip155:84532",
          amount: vector.amount,
          asset: vector.token,
          payTo: vector.adapter,
          maxTimeoutSeconds: 600,
          extra: {},
        },
      ],
      extensions: {
        "https://daski.xyz/x402/v2": {
          info: { serviceRef: vector.serviceRef },
          signing: {
            eip712TypedData: vector.typedData,
            nonceSalt: vector.nonceSalt,
          },
        },
      },
    };
    const paymentPayload = {
      x402Version: 2,
      resource: challenge.resource,
      accepted: challenge.accepts[0],
      extensions: challenge.extensions,
      payload: {
        authorization: vector.typedData.message,
        signature: vector.signature,
        nonceSalt: vector.nonceSalt,
      },
    };
    expect(paymentPayload.resource).toEqual(challenge.resource);
    expect(paymentPayload.accepted).toEqual(challenge.accepts[0]);
    expect(paymentPayload.extensions).toEqual(challenge.extensions);
    expect(paymentPayload.payload.authorization.nonce).toBe(
      vector.expectedNonce,
    );
  });
});
