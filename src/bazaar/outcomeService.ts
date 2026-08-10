import { randomBytes } from "node:crypto";
import type {
  PaymentPayload,
  PaymentRequirements,
} from "@x402/core/types";
import type { Hex } from "viem";
import type { ProviderAuthorityService } from "../payment/providerAuthority.js";
import { isHexAddress } from "../util/evmValidation.js";
import { requireCurrentListing } from "./listingAuthority.js";
import { withBazaarLease } from "./lease.js";
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
import type {
  BazaarCompatibilityWiring,
  BazaarListing,
  BazaarOrder,
} from "./types.js";

export class BazaarOutcomeService {
  private readonly now: () => Date;
  private readonly random: (size: number) => Buffer;
  private readonly declaration: BazaarPaymentDeclaration;

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
  }

  async unpaid(): Promise<BazaarOutcomeResult> {
    await this.requireCurrentListing(false, 310n);
    if (await this.store.hasBlockingIncident(
      this.listing.offer.message.listingCommitment,
    )) return failureOutcome(503, "listing_paused");
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

  async paid(decoded: PaymentPayload): Promise<BazaarOutcomeResult> {
    const payload = bindServerPaymentPayload(decoded, this.declaration);
    if (!payload) return failureOutcome(400, "payment_declaration_mismatch");
    const parsed = await parseBazaarPayment(
      payload,
      this.declaration.requirements,
      this.listing.offer.message,
      this.nowSeconds(),
    );
    if (!parsed.ok) return failureOutcome(400, parsed.code);
    const claimInput = createClaimInput(this.listing, parsed.payment, this.random);
    const claim = await this.store.claim(claimInput, this.leaseOwner);
    if (!sameOrderBinding(claim.order, claimInput)) {
      return failureOutcome(409, "payment_authorization_conflict");
    }
    if (!claim.created) return existingOutcomeResult(claim.order);
    if (!claim.leaseToken) throw new Error("Bazaar claim omitted its fencing token");
    return withBazaarLease({
      store: this.store,
      orderRecordId: claim.order.orderRecordId,
      leaseToken: claim.leaseToken,
      action: () => this.processNewOrder(
        claim.order,
        claim.leaseToken!,
        parsed.payment,
        this.declaration.requirements,
      ),
    });
  }

  private async processNewOrder(
    order: BazaarOrder,
    leaseToken: string,
    payment: ParsedBazaarPayment,
    requirements: PaymentRequirements,
  ): Promise<BazaarOutcomeResult> {
    if (await this.store.hasBlockingIncident(
      this.listing.offer.message.listingCommitment,
    )) {
      await this.store.markTerminal(
        order.orderRecordId, leaseToken, "claimed", "verify_rejected", "listing_paused",
      );
      return failureOutcome(503, "listing_paused");
    }
    try {
      await this.requireCurrentListing(true);
    } catch {
      await this.store.markTerminal(
        order.orderRecordId, leaseToken, "claimed", "verify_rejected",
        "provider_authority_changed",
      );
      return failureOutcome(409, "listing_authority_changed");
    }
    return this.verifySettleAndDispatch(
      order,
      leaseToken,
      payment,
      requirements,
    );
  }

  private async verifySettleAndDispatch(
    order: BazaarOrder,
    leaseToken: string,
    payment: ParsedBazaarPayment,
    requirements: PaymentRequirements,
  ): Promise<BazaarOutcomeResult> {
    try {
      const profile = await this.wiring.payerProfileVerifier.verifyBeforeSettlement({
        chainId: order.chainId,
        payer: order.payer,
      });
      if (profile.profile !== "eoa") {
        await this.store.markTerminal(
          order.orderRecordId, leaseToken, "claimed", "verify_rejected",
          "payer_profile_unsupported",
        );
        return failureOutcome(402, "payer_profile_unsupported");
      }
    } catch {
      await this.store.markTerminal(
        order.orderRecordId, leaseToken, "claimed", "verify_ambiguous",
        "payer_profile_ambiguous",
      );
      return failureOutcome(503, "payer_profile_ambiguous");
    }
    let verify;
    try {
      verify = await this.wiring.facilitator.verify(
        payment.payload,
        requirements,
      );
    } catch {
      await this.store.markTerminal(
        order.orderRecordId, leaseToken, "claimed", "verify_ambiguous",
        "facilitator_verify_ambiguous",
      );
      return failureOutcome(502, "payment_verification_ambiguous");
    }
    if (
      !verify.response.isValid ||
      !isHexAddress(verify.response.payer) ||
      verify.response.payer.toLowerCase() !== order.payer.toLowerCase()
    ) {
      await this.store.markTerminal(
        order.orderRecordId, leaseToken, "claimed", "verify_rejected",
        "facilitator_verify_rejected",
      );
      return failureOutcome(402, "payment_verification_rejected");
    }
    const verifyExtension = parseBazaarExtensionResponse(verify.extensionResponses);
    const began = await this.store.beginSettlement(
      order.orderRecordId,
      leaseToken,
      verifyExtension.headerHash,
      verifyExtension.status,
    );
    if (!began) return existingOutcomeResult(await this.reload(order));
    try {
      await this.requireCurrentListing(true);
    } catch {
      await this.store.markTerminal(
        order.orderRecordId, leaseToken, "settle_started", "settle_rejected",
        "provider_authority_changed",
      );
      return failureOutcome(409, "listing_authority_changed");
    }
    return this.settleAndDispatch(order, leaseToken, payment, requirements);
  }

  private async settleAndDispatch(
    order: BazaarOrder,
    leaseToken: string,
    payment: ParsedBazaarPayment,
    requirements: PaymentRequirements,
  ): Promise<BazaarOutcomeResult> {
    let settled;
    try {
      settled = await this.wiring.facilitator.settle(payment.payload, requirements);
    } catch {
      await this.store.markTerminal(
        order.orderRecordId, leaseToken, "settle_started", "settle_ambiguous",
        "facilitator_settle_ambiguous",
      );
      return failureOutcome(502, "payment_settlement_ambiguous");
    }
    if (!settled.response.success) {
      await this.store.markTerminal(
        order.orderRecordId, leaseToken, "settle_started", "settle_rejected",
        "facilitator_settle_rejected",
      );
      return failureOutcome(402, "payment_settlement_rejected");
    }
    if (!validSettlementEvidence(settled.response, order)) {
      await this.store.markTerminal(
        order.orderRecordId, leaseToken, "settle_started", "evidence_rejected",
        "invalid_settlement_evidence",
      );
      return failureOutcome(502, "payment_evidence_rejected");
    }
    const settleExtension = parseBazaarExtensionResponse(settled.extensionResponses);
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
    const evidence = await verifyBazaarSettlementEvidence(confirmedOrder, this.wiring);
    if (evidence.kind !== "valid") {
      await this.store.markTerminal(
        order.orderRecordId,
        leaseToken,
        "settle_confirmed",
        evidence.kind === "invalid" ? "evidence_rejected" : "settle_ambiguous",
        evidence.kind === "invalid"
          ? "invalid_settlement_evidence"
          : "evidence_observation_ambiguous",
      );
      return failureOutcome(
        502,
        evidence.kind === "invalid"
          ? "payment_evidence_rejected"
          : "payment_settlement_ambiguous",
      );
    }
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
