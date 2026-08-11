import { describe, expect, it } from "vitest";
import {
  createTaskAccessAuthorization,
  lifecycleRequestHash,
  ZERO_BYTES32,
} from "../src/bazaar/lifecycleAuthorization.js";
import {
  createTaskAccessChallengeEnvelope,
  verifyTaskAccessChallengeEnvelope,
} from "../src/bazaar/lifecycleChallenge.js";
import type { BazaarChallengeMacKeyring } from "../src/bazaar/types.js";
import type { Hex } from "../src/types.js";

const PAY_TO = `0x${"11".repeat(20)}` as Hex;
const PAYER = `0x${"22".repeat(20)}` as Hex;
const ORDER_ID = `0x${"33".repeat(32)}` as Hex;
const NONCE = `0x${"44".repeat(32)}` as Hex;
const NOW = 1_786_387_200n;

describe("Bazaar lifecycle challenge key rotation", () => {
  it("accepts a retained epoch only through its bounded retirement time", () => {
    const old: BazaarChallengeMacKeyring = {
      current: { epoch: "old", secret: Buffer.alloc(32, 1) },
    };
    const authorization = createTaskAccessAuthorization({
      orderRecordId: ORDER_ID,
      claim: {
        chainId: 84532n,
        payTo: PAY_TO,
        payer: PAYER,
        providerAgentId: 701n,
        taskIdHash: ZERO_BYTES32,
        action: "ORDER_STATUS",
        request: {},
        requestHash: lifecycleRequestHash("ORDER_STATUS"),
      },
      nonce: NONCE,
      issuedAt: NOW,
      expiresAt: NOW + 300n,
    });
    const envelope = createTaskAccessChallengeEnvelope({
      authorization,
      request: {},
      keyring: old,
    });
    const rotated: BazaarChallengeMacKeyring = {
      current: { epoch: "new", secret: Buffer.alloc(32, 2) },
      retained: [{
        epoch: "old",
        secret: Buffer.alloc(32, 1),
        acceptUntil: NOW + 330n,
      }],
    };
    expect(verifyTaskAccessChallengeEnvelope(envelope, rotated, NOW + 329n))
      .not.toBeNull();
    expect(verifyTaskAccessChallengeEnvelope(envelope, rotated, NOW + 331n))
      .toBeNull();
  });
});
