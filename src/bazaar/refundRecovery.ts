import { isHex32 } from "../util/evmValidation.js";
import { type BazaarLeaseGuard, withBazaarLease } from "./lease.js";
import { verifyBazaarRefundEvidence } from "./refundEvidence.js";
import { createBazaarRefundInstruction } from "./refundInstruction.js";
import type { BazaarRefundWorkItem } from "./refundLeaseStore.js";
import type { BazaarRefundStore } from "./refundStore.js";
import type { BazaarCompatibilityWiring } from "./types.js";
import { callBazaarAdapter } from "./adapterCall.js";

const MAX_REFUNDS_PER_RUN = 50;
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
type RefundRequestResult =
  | { kind: "broadcast"; transaction: `0x${string}` }
  | { kind: "blocked_issuer" }
  | { kind: "deferred" };

export class BazaarRefundRecovery {
  constructor(
    private readonly store: BazaarRefundStore,
    private readonly wiring: BazaarCompatibilityWiring,
    private readonly leaseOwner: string,
  ) {}

  async runOnce(): Promise<void> {
    for (let processed = 0; processed < MAX_REFUNDS_PER_RUN; processed += 1) {
      const work = await this.store.claim(this.leaseOwner);
      if (!work) return;
      await withBazaarLease({
        store: this.store,
        orderRecordId: work.orderRecordId,
        leaseToken: work.leaseToken,
        action: (lease) => this.process(work, lease),
        onOwnershipLost: () => undefined,
      });
    }
  }

  private async process(
    work: BazaarRefundWorkItem,
    lease: BazaarLeaseGuard,
  ): Promise<void> {
    if (work.refundState === "broadcast") {
      const evidence = await verifyBazaarRefundEvidence({
        work,
        wiring: this.wiring,
        lease,
      });
      const transitioned = evidence !== "pending"
        ? await this.store.finalize({
          orderRecordId: work.orderRecordId,
          leaseToken: work.leaseToken,
          ...evidence,
        })
        : await this.defer(work);
      if (transitioned) lease.complete();
      return;
    }
    const now = this.nowSeconds();
    let instruction;
    try {
      lease.assertOwned();
      instruction = await callBazaarAdapter({
        timeoutMs: this.wiring.adapterCallTimeoutMs,
        signal: lease.signal,
        operation: (signal) => createBazaarRefundInstruction({
          chainId: work.chainId,
          payTo: work.payTo,
          orderRecordId: work.orderRecordId,
          refundId: work.refundId,
          providerAgentId: work.providerAgentId,
          authorizationDigest: work.authorizationDigest,
          payer: work.payer,
          token: work.token,
          grossAmount: work.grossAmount,
          refundWallet: work.refundWallet,
          refundPolicyVersion: work.refundPolicyVersion,
          refundReason: work.primaryReason,
          evidenceHash: work.evidenceHash,
          attemptCount: work.attemptCount,
          issuedAt: now,
          expiresAt: now + BigInt(
            this.wiring.refundWorkerPolicy.instructionTtlSeconds,
          ),
          signer: this.wiring.refundInstructionSigningBroker,
          signal,
        }),
      });
      lease.assertOwned();
    } catch {
      if (await this.defer(work)) lease.complete();
      return;
    }
    let response: unknown;
    try {
      lease.assertOwned();
      response = await callBazaarAdapter({
        timeoutMs: this.wiring.adapterCallTimeoutMs,
        signal: lease.signal,
        operation: (signal) => this.wiring.refundRequestService.requestRefund({
          refundId: work.refundId,
          providerAgentId: work.providerAgentId,
          refundWallet: work.refundWallet,
          refundPolicyVersion: work.refundPolicyVersion,
          instruction,
        }, signal),
      });
      lease.assertOwned();
    } catch {
      if (await this.defer(work)) lease.complete();
      return;
    }
    const result = parseRefundRequestResult(response);
    let transitioned: boolean;
    if (result?.kind === "broadcast") {
      transitioned = await this.store.recordBroadcast(
        work.orderRecordId,
        work.leaseToken,
        result.transaction,
      );
    } else if (result?.kind === "blocked_issuer") {
      transitioned = await this.store.markBlocked(work.orderRecordId, work.leaseToken);
    } else {
      transitioned = await this.defer(work);
    }
    if (transitioned) lease.complete();
  }

  private defer(work: BazaarRefundWorkItem): Promise<boolean> {
    return this.store.defer(
      work.orderRecordId,
      work.leaseToken,
      this.wiring.refundWorkerPolicy.retryDelaySeconds,
    );
  }

  private nowSeconds(): bigint {
    return BigInt(Math.floor((this.wiring.now?.() ?? new Date()).getTime() / 1000));
  }
}

function isNonzeroHex32(value: unknown): value is `0x${string}` {
  return isHex32(value) && value.toLowerCase() !== ZERO_BYTES32;
}

function parseRefundRequestResult(value: unknown): RefundRequestResult | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (
    value.kind === "broadcast" && keys.length === 2 &&
    Object.hasOwn(value, "kind") && Object.hasOwn(value, "transaction") &&
    isNonzeroHex32(value.transaction)
  ) return { kind: "broadcast", transaction: value.transaction };
  if (
    (value.kind === "blocked_issuer" || value.kind === "deferred") &&
    keys.length === 1 && Object.hasOwn(value, "kind")
  ) return { kind: value.kind };
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
