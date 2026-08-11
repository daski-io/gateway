import { randomBytes } from "node:crypto";
import type { Hex } from "viem";
import { isHex32 } from "../util/evmValidation.js";
import { canonicalJsonStringify } from "../auth/envelope.js";
import {
  ZERO_BYTES32,
  actionFromHash,
  createTaskAccessAuthorization,
  lifecycleRequestHash,
  parseChallengeClaim,
  parseLifecycleRequest,
  parseTaskAccessAuthorization,
  verifyTaskAccessPayerSignature,
} from "./lifecycleAuthorization.js";
import {
  createTaskAccessChallengeEnvelope,
  verifyTaskAccessChallengeEnvelope,
} from "./lifecycleChallenge.js";
import { createProviderLifecycleAssertion } from "./lifecycleAssertion.js";
import type { BazaarOrderStore } from "./store.js";
import type {
  BazaarCompatibilityWiring,
  BazaarLifecycleAction,
  BazaarOrder,
} from "./types.js";

const CHALLENGE_TTL_SECONDS = 5n * 60n;
const PROVIDER_ASSERTION_TTL_SECONDS = 60n;

export type LifecycleResult =
  | { status: 200; body: Record<string, unknown> }
  | { status: 400 | 403; body: { error: string } };

export class BazaarLifecycleService {
  private readonly now: () => Date;
  private readonly random: (size: number) => Buffer;

  constructor(
    private readonly store: BazaarOrderStore,
    private readonly wiring: BazaarCompatibilityWiring,
  ) {
    this.now = wiring.now ?? (() => new Date());
    this.random = wiring.randomBytes ?? randomBytes;
  }

  async challenge(handle: string, body: unknown): Promise<LifecycleResult> {
    const orderRecordId = decodeOrderHandle(handle);
    const claim = parseChallengeClaim(body);
    if (
      !orderRecordId ||
      !claim ||
      !(await this.store.hasLifecycleDomain(claim.chainId, claim.payTo))
    ) {
      return badRequest();
    }
    const issuedAt = this.nowSeconds();
    const nonce = nonzeroRandomHex(this.random);
    const authorization = createTaskAccessAuthorization({
      orderRecordId,
      claim,
      nonce,
      issuedAt,
      expiresAt: issuedAt + CHALLENGE_TTL_SECONDS,
    });
    const envelope = createTaskAccessChallengeEnvelope({
      authorization,
      request: claim.request,
      keyring: this.wiring.challengeMac,
    });
    return { status: 200, body: { envelope } };
  }

  async redeem(handle: string, body: unknown): Promise<LifecycleResult> {
    const orderRecordId = decodeOrderHandle(handle);
    const parsed = parseRedemption(body);
    if (!orderRecordId || !parsed) return denied();
    const challenge = verifyTaskAccessChallengeEnvelope(
      parsed.envelope,
      this.wiring.challengeMac,
      this.nowSeconds(),
    );
    const authorization = challenge &&
      parseTaskAccessAuthorization(challenge.authorization);
    if (!authorization || authorization.message.orderRecordId !== orderRecordId) return denied();
    const now = this.nowSeconds();
    if (
      BigInt(authorization.message.issuedAt) > now ||
      BigInt(authorization.message.expiresAt) <= now ||
      BigInt(authorization.message.expiresAt) - BigInt(authorization.message.issuedAt) >
        CHALLENGE_TTL_SECONDS
    ) return denied();
    const signaturesValid = await verifyTaskAccessPayerSignature({
      authorization,
      payerSignature: parsed.payerSignature,
    });
    if (!signaturesValid) return denied();
    const order = await this.store.getByRecordId(orderRecordId);
    const action = actionFromHash(authorization.message.actionHash);
    const request = action && parseLifecycleRequest(action, challenge.request);
    if (!order || !action || !request || !matchesOrder(
      authorization,
      order,
      action,
      request,
    )) {
      return denied();
    }
    const consumed = await this.store.consumeLifecycle({
      orderRecordId,
      nonce: authorization.message.challengeNonce,
      action,
      requestHash: authorization.message.requestHash,
    });
    if (!consumed) return denied();
    if (action === "ORDER_STATUS" && order.state !== "dispatched") {
      return {
        status: 200,
        body: {
          state: order.state,
          failureCode: order.failureCode,
          financial: await this.store.getFinancialStatus(order.orderRecordId),
        },
      };
    }
    const assertion = await createProviderLifecycleAssertion({
      order,
      action,
      requestHash: authorization.message.requestHash,
      taskIdHash: authorization.message.taskIdHash,
      nonce: nonzeroRandomHex(this.random),
      issuedAt: now,
      expiresAt: now + PROVIDER_ASSERTION_TTL_SECONDS,
      signer: this.wiring.providerActionSigningBroker,
    });
    const result = await this.wiring.fulfillment.performLifecycleAction({
      taskId: order.taskId,
      action,
      request,
      contentTrust: action === "SUPPORT_MESSAGE" ? "untrusted_buyer" : "none",
      assertion,
    });
    if (action === "ORDER_STATUS") {
      return {
        status: 200,
        body: boundedJsonObject({
          ...result,
          financial: await this.store.getFinancialStatus(order.orderRecordId),
        }),
      };
    }
    return { status: 200, body: boundedJsonObject(result) };
  }

  private nowSeconds(): bigint {
    return BigInt(Math.floor(this.now().getTime() / 1000));
  }
}

function matchesOrder(
  authorization: NonNullable<ReturnType<typeof parseTaskAccessAuthorization>>,
  order: BazaarOrder,
  action: BazaarLifecycleAction,
  request: Record<string, unknown>,
): boolean {
  const { domain, message } = authorization;
  const expectedTaskHash = action === "ORDER_STATUS"
    ? ZERO_BYTES32
    : order.taskIdHash;
  const actionStateIsValid = action === "ORDER_STATUS" ||
    order.state === "dispatched" || order.state === "fulfilled";
  return actionStateIsValid &&
    domain.chainId === order.chainId.toString() &&
    domain.verifyingContract.toLowerCase() === order.payTo.toLowerCase() &&
    message.payer.toLowerCase() === order.payer.toLowerCase() &&
    BigInt(message.providerAgentId) === order.providerAgentId &&
    message.taskIdHash.toLowerCase() === expectedTaskHash?.toLowerCase() &&
    message.requestHash.toLowerCase() === lifecycleRequestHash(action, request) &&
    message.orderRecordId.toLowerCase() === order.orderRecordId.toLowerCase();
}

function parseRedemption(value: unknown): {
  envelope: unknown;
  payerSignature: Hex;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).sort().join("\0") !==
    ["envelope", "payerSignature"].sort().join("\0")) return null;
  if (!isSignature(body.payerSignature)) return null;
  return {
    envelope: body.envelope,
    payerSignature: body.payerSignature,
  };
}

function decodeOrderHandle(value: string): Hex | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== value) return null;
  const hex = `0x${bytes.toString("hex")}` as Hex;
  return isHex32(hex) && hex !== ZERO_BYTES32 ? hex : null;
}

function nonzeroRandomHex(random: (size: number) => Buffer): Hex {
  const bytes = random(32);
  if (bytes.length !== 32 || bytes.every((byte) => byte === 0)) {
    throw new Error("Bazaar random source returned an invalid identifier");
  }
  return `0x${bytes.toString("hex")}` as Hex;
}

function isSignature(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{130}$/.test(value);
}

function boundedJsonObject(value: Record<string, unknown>): Record<string, unknown> {
  const json = canonicalJsonStringify(value);
  if (Buffer.byteLength(json, "utf8") > 64 * 1024) {
    throw new Error("Bazaar lifecycle response exceeded its size limit");
  }
  const parsed: unknown = JSON.parse(json);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Bazaar lifecycle response was not an object");
  }
  return parsed as Record<string, unknown>;
}

function badRequest(): LifecycleResult {
  return { status: 400, body: { error: "invalid_lifecycle_request" } };
}

function denied(): LifecycleResult {
  return { status: 403, body: { error: "lifecycle_authorization_failed" } };
}
