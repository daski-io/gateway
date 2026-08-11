import { randomBytes } from "node:crypto";
import type {
  PaymentPayload,
  PaymentRequirements,
} from "@x402/core/types";
import type { Hex } from "viem";
import type { ProviderAuthorityService } from "../payment/providerAuthority.js";
import { isHexAddress } from "../util/evmValidation.js";
import { requireCurrentListing } from "./listingAuthority.js";
import { type BazaarLeaseGuard, withBazaarLease } from "./lease.js";
import { parseBazaarExtensionResponse } from "./extensionResponse.js";
import { dispatchBazaarOrder } from "./outcomeDispatch.js";
import { parseBazaarPayment, type ParsedBazaarPayment } from "./payment.js";
import {
  createClaimInput,
  existingOutcomeResult,
  failureOutcome,
  normalizedPaymentResponse,
  sameOrderBinding,
  validSettlementEvidence,
  type BazaarOutcomeResult,
} from "./outcomeHelpers.js";
import {
  bindServerPaymentPayload,
  buildPaymentDeclaration,
  type BazaarPaymentDeclaration,
} from "./requirements.js";
import type { BazaarOrderStore } from "./store.js";
import { verifyBazaarSettlementEvidence } from "./settlementEvidence.js";
import { refundRiskPolicyFor } from "./refundPolicy.js";
import type {
  BazaarCompatibilityWiring,
  BazaarListing,
  BazaarOrder,
  BazaarRefundRiskPolicy,
} from "./types.js";

export class BazaarOutcomeService {
  private readonly now: () => Date;
  private readonly random: (size: number) => Buffer;
  private readonly declaration: BazaarPaymentDeclaration;
  private readonly refundPolicy: BazaarRefundRiskPolicy;

  constructor(
    readonly listing: BazaarListing,
    private readonly store: BazaarOrderStore,
    private readonly wiring: BazaarCompatibilityWiring,
    private readonly providerAuthority: ProviderAuthorityService,
    private readonly leaseOwner: string,
  ) {
    this.now = wiring.now ?? (() => new Date());
    this.random = wiring.randomBytes ?? randomBytes;
    this.declaration = buildPaymentDeclaration(listing, this.nowSeconds());
    this.refundPolicy = refundRiskPolicyFor(
      wiring.refundRiskPolicies,
      listing.offer.message.providerAgentId,
    );
  }

  async unpaid(): Promise<BazaarOutcomeResult> {
    await this.requireCurrentListing(false, 310n);
    if (await this.store.hasBlockingIncident(
      this.listing.offer.message.listingCommitment,
    )) return failureOutcome(503, "listing_paused");
    if (!(await this.store.hasRefundRiskHeadroom(
      this.listing.offer.message.providerAgentId,
      this.listing.offer.message.grossAmount,
      this.refundPolicy,
    ))) return failureOutcome(503, "refund_risk_capacity_unavailable");
    if (!(await this.store.hasListingSettlementCapacity(
      this.listing.offer.message.listingCommitment,
      this.wiring.settlementCapacity,
    ))) return failureOutcome(503, "settlement_capacity_unavailable");
    return {
      status: 402,
      paymentRequired: this.declaration.paymentRequired,
      body: {
        error: "payment_required",
        outcome: {
          seller: this.listing.sellerName,
          marketplace: "Daski",
          expectedDelivery: this.listing.expectedDelivery,
          refundTerms: this.listing.refundTerms,
          termsUrl: this.listing.termsUrl,
        },
      },
    };
  }

  async paid(
    decoded: PaymentPayload,
    ingressAgeSeconds = 0n,
  ): Promise<BazaarOutcomeResult> {
    try {
      return await this.processPaid(decoded, ingressAgeSeconds);
    } finally {
      scrubPaymentPayload(decoded);
    }
  }

  private async processPaid(
    decoded: PaymentPayload,
    ingressAgeSeconds: bigint,
  ): Promise<BazaarOutcomeResult> {
    const currentTime = this.nowSeconds();
    const paidRetryReceivedAt = currentTime >= ingressAgeSeconds
      ? currentTime - ingressAgeSeconds
      : 0n;
    const payload = bindServerPaymentPayload(decoded, this.declaration);
    if (!payload) return failureOutcome(400, "payment_declaration_mismatch");
    const parsed = await parseBazaarPayment(
      payload,
      this.declaration.requirements,
      this.listing.offer.message,
      currentTime,
      paidRetryReceivedAt,
    );
    if (!parsed.ok) return failureOutcome(400, parsed.code);
    if (
      parsed.payment.authorization.from.toLowerCase() ===
      this.refundPolicy.refundWallet.toLowerCase()
    ) return failureOutcome(402, "payer_refund_wallet_conflict");
    const claimInput = createClaimInput(
      this.listing,
      parsed.payment,
      this.random,
      paidRetryReceivedAt,
    );
    const existing = await this.store.findByAuthorization(claimInput);
    if (existing) {
      return sameOrderBinding(existing, claimInput)
        ? existingOutcomeResult(existing)
        : failureOutcome(409, "payment_authorization_conflict");
    }
    if (await this.store.hasBlockingIncident(
      this.listing.offer.message.listingCommitment,
    )) return failureOutcome(503, "listing_paused");
    if (!(await this.store.hasRefundRiskHeadroom(
      claimInput.providerAgentId,
      claimInput.grossAmount,
      this.refundPolicy,
    ))) return failureOutcome(503, "refund_risk_capacity_unavailable");
    if (!(await this.store.hasSettlementCapacity(
      claimInput,
      this.wiring.settlementCapacity,
    ))) return failureOutcome(503, "settlement_capacity_unavailable");
    try {
      await this.requireCurrentListing(true);
    } catch {
      return failureOutcome(409, "listing_authority_changed");
    }
    try {
      const profile = await this.wiring.payerProfileVerifier.verifyBeforeSettlement({
        chainId: this.listing.offer.message.chainId,
        payer: parsed.payment.authorization.from,
      });
      if (profile.profile !== "eoa") {
        return failureOutcome(402, "payer_profile_unsupported");
      }
    } catch {
      return failureOutcome(503, "payer_profile_ambiguous");
    }
    const rechecked = await parseBazaarPayment(
      payload,
      this.declaration.requirements,
      this.listing.offer.message,
      this.nowSeconds(),
      paidRetryReceivedAt,
    );
    if (!rechecked.ok) return failureOutcome(400, rechecked.code);
    const claim = await this.store.claimWithCapacity(
      claimInput,
      this.leaseOwner,
      this.wiring.settlementCapacity,
      this.refundPolicy,
      () => this.nowSeconds(),
    );
    if (claim.kind === "capacity_unavailable") {
      return failureOutcome(503, claim.dimension === "refund_risk"
        ? "refund_risk_capacity_unavailable"
        : "settlement_capacity_unavailable");
    }
    if (claim.kind === "authorization_expired") {
      return failureOutcome(400, "authorization_binding_mismatch");
    }
    if (!sameOrderBinding(claim.order, claimInput)) {
      return failureOutcome(409, "payment_authorization_conflict");
    }
    if (!claim.created) return existingOutcomeResult(claim.order);
    if (!claim.leaseToken) throw new Error("Bazaar claim omitted its fencing token");
    return withBazaarLease({
      store: this.store,
      orderRecordId: claim.order.orderRecordId,
      leaseToken: claim.leaseToken,
      action: (lease) => this.processNewOrder(
        claim.order,
        claim.leaseToken!,
        parsed.payment,
        this.declaration.requirements,
        lease,
      ),
      onOwnershipLost: () => failureOutcome(409, "processing_ownership_lost"),
      onOwnershipLostCleanup: () => scrubPaymentPayload(parsed.payment.payload),
    });
  }

  private async processNewOrder(
    order: BazaarOrder,
    leaseToken: string,
    payment: ParsedBazaarPayment,
    requirements: PaymentRequirements,
    lease: BazaarLeaseGuard,
  ): Promise<BazaarOutcomeResult> {
    try {
      return await this.verifySettleAndDispatch(
        order,
        leaseToken,
        payment,
        requirements,
        lease,
      );
    } finally {
      scrubPaymentPayload(payment.payload);
    }
  }

  private async verifySettleAndDispatch(
    order: BazaarOrder,
    leaseToken: string,
    payment: ParsedBazaarPayment,
    requirements: PaymentRequirements,
    lease: BazaarLeaseGuard,
  ): Promise<BazaarOutcomeResult> {
    let verify;
    try {
      lease.assertOwned();
      verify = await this.wiring.facilitator.verify(
        payment.payload,
        requirements,
        lease.signal,
      );
      lease.assertOwned();
    } catch {
      if (lease.ownershipLost) return ownershipLost();
      const marked = await this.store.markTerminal(
        order.orderRecordId, leaseToken, "attempt_opened", "verify_ambiguous",
        "facilitator_verify_ambiguous",
      );
      if (!marked) return existingOutcomeResult(await this.reload(order));
      lease.complete();
      return failureOutcome(502, "payment_verification_ambiguous");
    }
    if (
      !verify.response.isValid ||
      !isHexAddress(verify.response.payer) ||
      verify.response.payer.toLowerCase() !== order.payer.toLowerCase()
    ) {
      const marked = await this.store.markTerminal(
        order.orderRecordId, leaseToken, "attempt_opened", "verify_rejected",
        "facilitator_verify_rejected",
      );
      if (!marked) return existingOutcomeResult(await this.reload(order));
      lease.complete();
      return failureOutcome(402, "payment_verification_rejected");
    }
    const verifyExtension = parseBazaarExtensionResponse(verify.extensionResponses);
    lease.assertOwned();
    const began = await this.store.beginSettlement(
      order.orderRecordId,
      leaseToken,
      verifyExtension.headerHash,
      verifyExtension.status,
    );
    if (!began) return existingOutcomeResult(await this.reload(order));
    try {
      lease.assertOwned();
      await this.requireCurrentListing(true);
      lease.assertOwned();
    } catch {
      if (lease.ownershipLost) return ownershipLost();
      const marked = await this.store.markTerminal(
        order.orderRecordId, leaseToken, "settle_started", "settle_rejected",
        "provider_authority_changed",
      );
      if (!marked) return existingOutcomeResult(await this.reload(order));
      lease.complete();
      return failureOutcome(409, "listing_authority_changed");
    }
    return this.settleAndDispatch(order, leaseToken, payment, requirements, lease);
  }

  private async settleAndDispatch(
    order: BazaarOrder,
    leaseToken: string,
    payment: ParsedBazaarPayment,
    requirements: PaymentRequirements,
    lease: BazaarLeaseGuard,
  ): Promise<BazaarOutcomeResult> {
    let settled;
    try {
      lease.assertOwned();
      settled = await this.wiring.facilitator.settle(
        payment.payload,
        requirements,
        lease.signal,
      );
      lease.assertOwned();
    } catch {
      if (lease.ownershipLost) return ownershipLost();
      const marked = await this.store.markTerminal(
        order.orderRecordId, leaseToken, "settle_started", "settle_ambiguous",
        "facilitator_settle_ambiguous",
      );
      if (!marked) return existingOutcomeResult(await this.reload(order));
      lease.complete();
      return failureOutcome(502, "payment_settlement_ambiguous");
    }
    if (!settled.response.success) {
      const marked = await this.store.markTerminal(
        order.orderRecordId, leaseToken, "settle_started", "settle_rejected",
        "facilitator_settle_rejected",
      );
      if (!marked) return existingOutcomeResult(await this.reload(order));
      lease.complete();
      return failureOutcome(402, "payment_settlement_rejected");
    }
    if (!validSettlementEvidence(settled.response, order)) {
      const marked = await this.store.markTerminal(
        order.orderRecordId, leaseToken, "settle_started", "evidence_rejected",
        "invalid_settlement_evidence",
      );
      if (!marked) return existingOutcomeResult(await this.reload(order));
      lease.complete();
      return failureOutcome(502, "payment_evidence_rejected");
    }
    const settleExtension = parseBazaarExtensionResponse(settled.extensionResponses);
    lease.assertOwned();
    const confirmed = await this.store.markSettlementConfirmed({
      orderRecordId: order.orderRecordId,
      leaseToken,
      transaction: settled.response.transaction as Hex,
      facilitatorPayer: settled.response.payer as Hex,
      settleExtensionHash: settleExtension.headerHash,
      settleBazaarStatus: settleExtension.status,
      rejectedReasonHash: settleExtension.rejectedReasonHash,
    });
    if (!confirmed) return existingOutcomeResult(await this.reload(order));
    const confirmedOrder = await this.reload(order);
    const evidence = await verifyBazaarSettlementEvidence(
      confirmedOrder,
      this.wiring,
      lease,
    );
    if (evidence.kind !== "valid") {
      const marked = await this.store.markTerminal(
        order.orderRecordId,
        leaseToken,
        "settle_confirmed",
        evidence.kind === "invalid" ? "evidence_rejected" : "settle_ambiguous",
        evidence.kind === "invalid"
          ? "invalid_settlement_evidence"
          : "evidence_observation_ambiguous",
      );
      if (!marked) return existingOutcomeResult(await this.reload(order));
      lease.complete();
      return failureOutcome(
        502,
        evidence.kind === "invalid"
          ? "payment_evidence_rejected"
          : "payment_settlement_ambiguous",
      );
    }
    lease.assertOwned();
    const marked = await this.store.markSettled(order.orderRecordId, leaseToken);
    if (!marked) return existingOutcomeResult(await this.reload(order));
    return dispatchBazaarOrder({
      order: await this.reload(order),
      paymentResponse: normalizedPaymentResponse(settled.response, order),
      store: this.store,
      wiring: this.wiring,
      listing: this.listing,
      leaseToken,
      assertListingCurrent: () => this.requireCurrentListing(true),
      lease,
    });
  }

  private async requireCurrentListing(
    forceAuthorityRefresh = false,
    minimumRemainingSeconds = 0n,
  ): Promise<void> {
    await requireCurrentListing(
      this.listing,
      this.providerAuthority,
      this.nowSeconds(),
      forceAuthorityRefresh,
      minimumRemainingSeconds,
    );
  }

  private async reload(order: BazaarOrder): Promise<BazaarOrder> {
    return (await this.store.getByRecordId(order.orderRecordId)) ?? order;
  }

  private nowSeconds(): bigint {
    return BigInt(Math.floor(this.now().getTime() / 1000));
  }
}

function scrubPaymentPayload(payload: PaymentPayload): void {
  payload.payload = {};
}

function ownershipLost(): BazaarOutcomeResult {
  return failureOutcome(409, "processing_ownership_lost");
}
