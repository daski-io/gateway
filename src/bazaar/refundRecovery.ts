import { isHex32 } from "../util/evmValidation.js";
import { type BazaarLeaseGuard, withBazaarLease } from "./lease.js";
import { verifyBazaarRefundEvidence } from "./refundEvidence.js";
import { createBazaarRefundInstruction } from "./refundInstruction.js";
import type { BazaarRefundWorkItem } from "./refundLeaseStore.js";
import { refundRiskPolicyFor } from "./refundPolicy.js";
import type { BazaarRefundStore } from "./refundStore.js";
import type { BazaarCompatibilityWiring } from "./types.js";

const MAX_REFUNDS_PER_RUN = 50;
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;

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
    const policy = refundRiskPolicyFor(
      this.wiring.refundRiskPolicies,
      work.providerAgentId,
    );
    if (work.refundState === "broadcast") {
      const evidence = await verifyBazaarRefundEvidence({
        work,
        policy,
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
      instruction = await createBazaarRefundInstruction({
        chainId: work.chainId,
        payTo: work.payTo,
        orderRecordId: work.orderRecordId,
        refundId: work.refundId,
        authorizationDigest: work.authorizationDigest,
        payer: work.payer,
        token: work.token,
        grossAmount: work.grossAmount,
        refundReason: work.primaryReason,
        evidenceHash: work.evidenceHash,
        attemptCount: work.attemptCount,
        issuedAt: now,
        expiresAt: now + BigInt(this.wiring.refundWorkerPolicy.instructionTtlSeconds),
        signer: this.wiring.refundInstructionSigningBroker,
      });
      lease.assertOwned();
    } catch {
      if (await this.defer(work)) lease.complete();
      return;
    }
    let result;
    try {
      lease.assertOwned();
      result = await this.wiring.refundRequestService.requestRefund({
        refundId: work.refundId,
        providerAgentId: work.providerAgentId,
        refundWallet: policy.refundWallet,
        instruction,
      }, lease.signal);
      lease.assertOwned();
    } catch {
      if (await this.defer(work)) lease.complete();
      return;
    }
    let transitioned: boolean;
    if (result.kind === "broadcast" && isNonzeroHex32(result.transaction)) {
      transitioned = await this.store.recordBroadcast(
        work.orderRecordId,
        work.leaseToken,
        result.transaction,
      );
    } else if (result.kind === "blocked_issuer") {
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
