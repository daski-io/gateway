import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import {
  createPublicClient,
  getAddress,
  http,
  parseAbi,
  recoverMessageAddress,
  verifyTypedData,
  type Hex,
} from "viem";
import type { Config } from "../config.js";
import type { Pool } from "../db/pool.js";
import { canonicalHash } from "./canonical.js";
import { asStandardRailError, standardRailError } from "./errors.js";
import type { StandardRailConfig } from "./config.js";
import type {
  EvidenceResult,
  ReleaseEvidenceResult,
  StandardChainEvidence,
} from "./evidence.js";
import type { StandardFacilitator } from "./facilitator.js";
import { StandardRailJournal } from "./journal.js";
import {
  paymentRequired,
  paymentAuthorizationLookupKey,
  paymentIntentId,
  paymentRequirements,
  normalizePaymentPayload,
  validatePayment,
  type ValidatedAuthorization,
} from "./payment.js";
import { decryptPaymentPayload, encryptPaymentPayload } from "./secrets.js";
import { signEnvelope } from "./signing.js";
import { StandardRailStore } from "./store.js";
import type {
  CatalogSearchVocabularyV1,
  PublicOutcomeDetailV1,
  PublicOutcomeSummaryV1,
  PublicOutcomeV1,
  QuoteV1,
  StandardListing,
  StandardOrderRecord,
  StandardRailReceiptV2,
} from "./types.js";
import { verifyStandardRailManifest } from "./artifacts.js";
import { StandardRailRecoveryWorker } from "./recovery.js";
import { StandardRailIncidentStore } from "./incidents.js";
import { StandardWalletStore } from "./walletStore.js";
import { StandardWalletQueries } from "./walletQueries.js";
import type { WalletAuthorizationTransport } from "./types.js";
import { StandardAssetFederation } from "./assetFederation.js";
import { StandardAssetActions } from "./assetActions.js";
import { buildReputationRegistration } from "./reputationOrders.js";
import { isReputationEligiblePayer } from "./reputationEligibility.js";
import { StandardReputationWorker } from "./reputationWorker.js";
import { StandardConfirmations } from "./confirmations.js";
import { base, baseSepolia } from "viem/chains";
import { activeRequestKey } from "../mcp/requestContext.js";
import { DirectReputationReader } from "./reputationReader.js";
import type {
  ServiceRegistrationStore,
  StoredRegistration,
} from "../serviceRegistration/store.js";
import { discardResponseBody, readBoundedJsonResponse as readBoundedJson } from "./boundedJson.js";
import { StandardProviderTransport } from "./providerTransport.js";
import { StandardRailCatalog } from "./catalog.js";
import { StandardProviderDispatch } from "./providerDispatch.js";
import { StandardOperationalHealth } from "./operationalHealth.js";
import { withRpcFailover } from "../rpc/failover.js";
import {
  orderActionChallengeIssued, orderActionSignRequest,
  type OrderAction,
  type OrderActionChallenge,
} from "./orderAuthorization.js";
import { issueReadCapability, verifyReadCapability } from "./readCapability.js";
import { createX402OfferReceipt, x402PaymentResponse } from "./x402Receipt.js";

export function isAdmissionWindowOpen(
  railValidBefore: number,
  facilitatorValidBefore: number,
  nowSeconds = Math.floor(Date.now() / 1_000),
): boolean {
  return nowSeconds < Math.min(railValidBefore, facilitatorValidBefore);
}

function assertExactKeys(value: unknown, expected: readonly string[], label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw standardRailError("INTERNAL_ERROR", {
      phase: "dispatch",
      internalMessage: `${label} must be an object`,
    });
  }
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw standardRailError("INTERNAL_ERROR", {
      phase: "dispatch",
      internalMessage: `${label} fields are invalid`,
    });
  }
}

function isTransitionConflict(error: unknown): boolean {
  return error instanceof Error && error.message === "ORDER_TRANSITION_CONFLICT";
}

const OPERATIONAL_HEALTH_MEMO_MS = 15_000;

export class StandardRailService {
  private readonly store: StandardRailStore;
  private readonly journal: StandardRailJournal;
  private readonly providerTransport: StandardProviderTransport;
  private readonly catalog: StandardRailCatalog;
  private readonly dispatcher: StandardProviderDispatch;
  private readonly operationalHealthReporter: StandardOperationalHealth;
  private readonly recovery: StandardRailRecoveryWorker;
  private readonly incidents: StandardRailIncidentStore;
  private readonly walletStore: StandardWalletStore;
  private readonly walletQueries: StandardWalletQueries;
  private readonly assetFederation: StandardAssetFederation;
  private readonly assetActions: StandardAssetActions;
  private readonly reputationWorker: StandardReputationWorker;
  private readonly confirmations: StandardConfirmations;
  private readonly reputationReader: DirectReputationReader;
  private dependenciesReady = false;
  private operationalHealthMemo: {
    expiresAt: number;
    value: Promise<Awaited<ReturnType<StandardOperationalHealth["read"]>>>;
  } | null = null;
  private readinessInterval: NodeJS.Timeout | null = null;
  private readinessRetry: NodeJS.Timeout | null = null;
  private readinessRefresh: Promise<void> | null = null;
  readonly railProfileHash: Hex;

  constructor(
    private readonly appConfig: Config,
    private readonly railConfig: StandardRailConfig,
    pool: Pool,
    private readonly facilitator: StandardFacilitator,
    private readonly evidence: StandardChainEvidence,
    registrations: ServiceRegistrationStore,
    refreshRegistration: (record: StoredRegistration) => Promise<void>,
    fetchFn: typeof fetch = fetch,
    federationPermitPool: Pool = pool,
    lockPool: Pool = pool,
  ) {
    this.store = new StandardRailStore(pool, lockPool);
    this.incidents = new StandardRailIncidentStore(pool);
    this.journal = new StandardRailJournal(pool);
    this.providerTransport = new StandardProviderTransport(fetchFn);
    this.walletStore = new StandardWalletStore(pool, railConfig, appConfig.chainId);
    this.walletQueries = new StandardWalletQueries(
      pool,
      this.walletStore,
      railConfig,
      appConfig.chainId === 8453 ? base : baseSepolia,
    );
    this.assetFederation = new StandardAssetFederation(
      pool,
      railConfig,
      appConfig.chainId,
      this.walletStore,
      (listing, endpoint, init) => this.providerFetch(listing, endpoint, init),
      undefined,
      federationPermitPool,
    );
    this.assetActions = new StandardAssetActions(
      pool,
      railConfig,
      appConfig.chainId,
      this.walletStore,
      this.assetFederation,
      (active, endpoint, init) => this.providerFetch(active.listing, endpoint, init),
    );
    this.reputationWorker = new StandardReputationWorker(
      pool,
      railConfig,
      appConfig.chainId === 8453 ? base : baseSepolia,
      undefined,
      () => this.reputationReader.invalidate(),
    );
    this.operationalHealthReporter = new StandardOperationalHealth(pool, this.reputationWorker);
    this.confirmations = new StandardConfirmations(
      pool,
      railConfig,
      appConfig.chainId === 8453 ? base : baseSepolia,
    );
    this.reputationReader = new DirectReputationReader(
      railConfig,
      appConfig.chainId === 8453 ? base : baseSepolia,
      pool,
      appConfig.marketplaceContracts,
    );
    this.catalog = new StandardRailCatalog(
      railConfig,
      appConfig,
      registrations,
      refreshRegistration,
      this.reputationReader,
    );
    this.railProfileHash = canonicalHash(railConfig.manifest.activeRailProfile);
    this.dispatcher = new StandardProviderDispatch(
      appConfig,
      railConfig,
      this.journal,
      this.store,
      (listing, endpoint, init) => this.providerFetch(listing, endpoint, init),
      this.railProfileHash,
    );
    this.recovery = new StandardRailRecoveryWorker({
      config: railConfig,
      store: this.store,
      resumePaid: async (order) => { await this.resumePaidOrder(order); },
      cleanup: async () => {
        await this.journal.cleanupExpiredActionAuthorizations();
        await this.walletStore.cleanupExpiredAuthorizations();
        await this.store.pruneUnpaidDrafts();
      },
    });
  }

  async initialize(): Promise<void> {
    await verifyStandardRailManifest(this.railConfig.manifest, {
      environment: this.railConfig.environment,
      chainId: this.appConfig.chainId,
      gatewayAudience: this.railConfig.gatewayAudience,
      signers: this.railConfig.trustedSigners,
      splitterFactoryRuntimeCodeHash: this.railConfig.splitterFactoryRuntimeCodeHash,
      splitterCreationCodeHash: this.railConfig.splitterCreationCodeHash,
    });
    if (
      getAddress(this.railConfig.manifest.chainEvidencePolicy.payload.canonicalToken) !==
      getAddress(this.appConfig.usdc.address)
    ) throw new Error("Standard-rail canonical token does not match the reviewed USDC domain");
    await this.evidence.verifyCanonicalToken(this.appConfig.chainId);
    const rail = this.railConfig.manifest.activeRailProfile.payload;
    if (
      rail.chainId !== this.appConfig.chainId || rail.environment !== this.railConfig.environment ||
      getAddress(this.railConfig.manifest.facilitatorProfile.payload.asset) !==
        getAddress(this.appConfig.usdc.address) ||
      this.railConfig.manifest.facilitatorProfile.payload.baseUrl !==
        this.railConfig.facilitatorBaseUrl
    ) throw new Error("Standard-rail manifest does not match this runtime");
    await this.store.admitManifest(this.railConfig.manifest);
    await this.assetFederation.activateAdmissions();
    await this.refreshDependencyReadiness();
    this.recovery.start();
    this.reputationWorker.start();
    this.readinessInterval = setInterval(() => {
      void this.refreshDependencyReadiness().catch(() => undefined);
    }, this.railConfig.readinessIntervalMs);
    this.readinessInterval.unref();
  }

  async stop(): Promise<void> {
    if (this.readinessInterval) clearInterval(this.readinessInterval);
    this.readinessInterval = null;
    if (this.readinessRetry) clearTimeout(this.readinessRetry);
    this.readinessRetry = null;
    await this.readinessRefresh?.catch(() => undefined);
    await Promise.all([
      this.recovery.stop(),
      this.reputationWorker.stop(),
    ]);
  }

  isAdmissionOpen(): boolean {
    return isAdmissionWindowOpen(
      this.railConfig.manifest.activeRailProfile.payload.admissionValidBefore,
      this.railConfig.manifest.facilitatorProfile.payload.admissionValidBefore,
    );
  }

  areDependenciesReady(): boolean {
    return this.dependenciesReady;
  }

  // /health/ready is unauthenticated and rate limited only at the public
  // read budget; each fresh read costs four aggregate scans and three RPC
  // calls, so one observation is shared for a short window.
  operationalHealth(): Promise<Awaited<ReturnType<StandardOperationalHealth["read"]>>> {
    const now = Date.now();
    const memo = this.operationalHealthMemo;
    if (memo && memo.expiresAt > now) return memo.value;
    const value = this.operationalHealthReporter.read();
    this.operationalHealthMemo = { expiresAt: now + OPERATIONAL_HEALTH_MEMO_MS, value };
    value.catch(() => {
      if (this.operationalHealthMemo?.value === value) this.operationalHealthMemo = null;
    });
    return value;
  }

  publicArtifact(hash: string): Promise<unknown | null> {
    return this.catalog.publicArtifact(hash);
  }

  private refreshDependencyReadiness(): Promise<void> {
    if (this.readinessRefresh) return this.readinessRefresh;
    this.readinessRefresh = (async () => {
      try {
        await this.assertRailFence();
        await this.facilitator.assertSupported(this.appConfig.x402Network);
        await this.evidence.verifyCanonicalToken(this.appConfig.chainId);
        await this.evidence.verifyScreeningOracle(
          this.railConfig.screeningPolicy.sanctionsOracle,
          this.railConfig.screeningPolicy.sanctionsOracleRuntimeCodeHash,
        );
        this.dependenciesReady = true;
        if (this.readinessRetry) clearTimeout(this.readinessRetry);
        this.readinessRetry = null;
      } catch (error) {
        this.dependenciesReady = false;
        this.scheduleReadinessRetry();
        throw error;
      } finally {
        this.readinessRefresh = null;
      }
    })();
    return this.readinessRefresh;
  }

  // The steady readiness cadence is slow to spare RPC quota; a failed probe must clear faster.
  private scheduleReadinessRetry(): void {
    if (!this.readinessInterval || this.readinessRetry) return;
    this.readinessRetry = setTimeout(() => {
      this.readinessRetry = null;
      void this.refreshDependencyReadiness().catch(() => undefined);
    }, Math.min(30_000, this.railConfig.readinessIntervalMs));
    this.readinessRetry.unref();
  }

  private assertAdmissionOpen(): void {
    if (!this.isAdmissionOpen()) {
      throw standardRailError("CHALLENGE_EXPIRED", {
        message: "The active standard rail admission window has expired",
      });
    }
  }

  private async providerFetch(
    listing: Pick<StandardListing, "providerControlProfile">,
    endpoint: string,
    init: RequestInit,
    requestScoped = false,
  ): Promise<Response> {
    return this.withRailFence(() => this.providerTransport.fetch(
      listing,
      endpoint,
      init,
      { requestScoped },
    ));
  }

  private async settlementCaptured(order: StandardOrderRecord): Promise<boolean> {
    if (!order.payer) {
      throw new Error("Settlement recovery is missing the encrypted authorization");
    }
    const payment = this.storedPayment(order);
    const authorization = payment.payload.authorization as Record<string, unknown> | undefined;
    const nonce = authorization?.nonce;
    if (typeof nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(nonce)) {
      throw new Error("Settlement recovery authorization nonce is malformed");
    }
    const listing = order.listing;
    return this.evidence.authorizationUsed(
      getAddress(listing.commitment.payload.canonicalToken),
      getAddress(order.payer),
      nonce as Hex,
    );
  }

  private paymentNonce(order: StandardOrderRecord): Hex {
    const payment = this.storedPayment(order);
    const nonce = (payment.payload.authorization as { nonce?: unknown } | undefined)?.nonce;
    if (typeof nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(nonce)) {
      throw new Error("Recovery authorization nonce is malformed");
    }
    return nonce as Hex;
  }

  private paymentAuthorizationValidBefore(order: StandardOrderRecord): number {
    const payment = this.storedPayment(order);
    const value = (payment.payload.authorization as { validBefore?: unknown } | undefined)?.validBefore;
    if ((typeof value !== "string" && typeof value !== "number") || !/^\d+$/.test(String(value))) {
      throw new Error("Recovery authorization validity is malformed");
    }
    const seconds = Number(value);
    if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error("Recovery authorization validity is invalid");
    return seconds;
  }

  private storedPayment(order: StandardOrderRecord): PaymentPayload {
    if (!order.encryptedPaymentPayload || !order.paymentPayloadHash) {
      throw new Error("Recovery is missing the encrypted authorization");
    }
    const payment = decryptPaymentPayload<PaymentPayload>(
      this.railConfig.encryptionKey,
      order.encryptedPaymentPayload,
    );
    if (canonicalHash(payment) !== order.paymentPayloadHash) {
      throw new Error("Recovery payment payload does not match its durable hash");
    }
    return payment;
  }

  private async resumePreSettlement(
    initial: StandardOrderRecord,
    listing: StandardListing,
  ): Promise<StandardOrderRecord> {
    let order = initial;
    if (!order.payer || !["ATTEMPT_OPENED", "VERIFIED", "SETTLE_INVOKED"].includes(order.state)) {
      return order;
    }
    const payment = this.storedPayment(order);
    if (order.state === "SETTLE_INVOKED") {
      const persisted = await this.journal.settlementRecord(order.orderId);
      if (persisted) {
        return this.store.transition(
          order,
          "FACILITATOR_CONFIRMED",
          "persisted_authenticated_settlement_response_recovered",
          { settlementTxHash: persisted.transactionHash },
        );
      }
      return this.store.transition(
        order,
        "SETTLEMENT_AMBIGUOUS",
        "settle_invocation_outcome_unknown",
      );
    }
    if (this.paymentAuthorizationValidBefore(order) <= Math.floor(Date.now() / 1_000) + 10) {
      return order;
    }
    const requirements = paymentRequirements(
      this.appConfig,
      listing,
      order.grossAmount,
      this.orderPaymentTimeout(order),
    );
    if (order.state === "ATTEMPT_OPENED") {
      await this.screenParticipants(listing, getAddress(order.payer));
      const recorded = await this.journal.verifyRecord(order.orderId);
      let verified = recorded?.valid;
      if (verified === undefined) {
        await this.journal.markVerifyInvoked(order.orderId);
        const verify = await this.withRailFence(() => this.facilitator.verify(payment, requirements));
        verified = Boolean(
          verify.isValid && verify.payer && getAddress(verify.payer) === getAddress(order.payer),
        );
        await this.journal.recordVerify(order.orderId, canonicalHash(verify), verified);
      }
      if (!verified) {
        return this.store.transition(order, "VERIFY_REJECTED", "recovered_facilitator_verify_rejected");
      }
      order = await this.store.transition(order, "VERIFIED", "recovered_facilitator_verified");
    }
    if (order.state !== "VERIFIED") return order;
    if (!await this.store.listingSettlementAvailable(order.listingManifestHash, order.orderId)) {
      return order;
    }
    await this.screenParticipants(listing, getAddress(order.payer!));
    if (await this.evidence.authorizationUsed(
      getAddress(listing.commitment.payload.canonicalToken),
      getAddress(order.payer!),
      this.paymentNonce(order),
    )) {
      return this.store.transition(
        order,
        "EXTERNAL_OR_UNPROVEN_DEPOSIT",
        "authorization_consumed_before_recovered_facilitator_egress",
      );
    }
    const mayInvokeFacilitator = await this.journal.markSettleInvoked(order.orderId);
    order = await this.store.transition(order, "SETTLE_INVOKED", "recovered_settle_invocation_persisted");
    if (!mayInvokeFacilitator) {
      return this.store.transition(order, "SETTLEMENT_AMBIGUOUS", "settle_invocation_outcome_unknown");
    }
    let settlement;
    try {
      settlement = await this.withRailFence(() => this.facilitator.settle(payment, requirements));
    } catch {
      return this.store.transition(order, "SETTLEMENT_AMBIGUOUS", "recovered_settle_response_unknown");
    }
    if (
      !settlement.success || !/^0x[0-9a-fA-F]{64}$/.test(settlement.transaction) ||
      !settlement.payer || getAddress(settlement.payer) !== getAddress(order.payer!) ||
      settlement.network !== this.appConfig.x402Network
    ) return this.store.transition(
      order,
      "SETTLEMENT_FAILED",
      "recovered_facilitator_settlement_failed",
    );
    const transactionHash = settlement.transaction as Hex;
    await this.journal.recordSettlement(order.orderId, canonicalHash(settlement), transactionHash);
    return this.store.transition(
      order,
      "FACILITATOR_CONFIRMED",
      "recovered_facilitator_settlement_confirmed",
      { settlementTxHash: transactionHash },
    );
  }

  private async resumePaidOrder(initial: StandardOrderRecord): Promise<void> {
    await this.assertRailFence();
    // A busy listing lock means another driver is settling on this listing;
    // the order stays leased-free in its durable state and is due again on
    // the next recovery tick.
    await this.store.tryWithListingSettlementLock(initial.listingManifestHash, async () => {
      let order = await this.store.findById(initial.orderId);
      if (!order || ![
        "ATTEMPT_OPENED", "VERIFIED", "VERIFY_REJECTED", "SETTLE_INVOKED",
        "FACILITATOR_CONFIRMED", "SETTLEMENT_AMBIGUOUS", "SETTLEMENT_FAILED",
        "EXTERNAL_OR_UNPROVEN_DEPOSIT", "DEPOSIT_FINAL", "RELEASE_FINAL",
        "DISPATCH_STARTED", "DISPATCH_AMBIGUOUS", "DISPATCHED", "INPUT_REQUIRED",
      ].includes(order.state)) return;
      const listing = order.listing;
      order = await this.resumePreSettlement(order, listing);
      if (["NOT_SETTLED", "LEGAL_HOLD"].includes(order.state)) return;
      if (["DISPATCHED", "INPUT_REQUIRED"].includes(order.state)) {
        const claim = await this.journal.dispatchClaim(order.orderId);
        if (!claim) throw new Error("Dispatch recovery is missing its persisted claim");
        const resolvedAt = await this.journal.dispatchResolvedAt(order.orderId) ?? order.updatedAt;
        try {
          order = await this.dispatcher.reconcile(
            order,
            listing,
            canonicalHash(claim.dispatch),
          );
          if (["FULFILLED", "PROVIDER_FAILED"].includes(order.state)) return;
        } catch (error) {
          if (Date.now() < resolvedAt.getTime() + listing.deadlinePolicy.fulfillmentSeconds * 1_000) {
            throw error;
          }
        }
        if (Date.now() >= resolvedAt.getTime() + listing.deadlinePolicy.fulfillmentSeconds * 1_000) {
          await this.store.transition(order, "PROVIDER_FAILED", "signed_provider_deadline_elapsed");
        }
        return;
      }
      const authenticatedSettlement = await this.journal.settlementRecord(order.orderId);
      if (
        authenticatedSettlement &&
        (["SETTLE_INVOKED", "SETTLEMENT_AMBIGUOUS"].includes(order.state) ||
          (order.state === "EXTERNAL_OR_UNPROVEN_DEPOSIT" &&
            order.settlementTxHash === authenticatedSettlement.transactionHash))
      ) {
        order = await this.store.transition(
          order,
          "FACILITATOR_CONFIRMED",
          "persisted_authenticated_settlement_response_recovered",
          { settlementTxHash: authenticatedSettlement.transactionHash },
        );
      }
      const unconfirmedStates = [
        "ATTEMPT_OPENED", "VERIFIED", "VERIFY_REJECTED", "SETTLE_INVOKED",
        "SETTLEMENT_AMBIGUOUS", "SETTLEMENT_FAILED", "EXTERNAL_OR_UNPROVEN_DEPOSIT",
      ];
      if (unconfirmedStates.includes(order.state)) {
        const nonce = this.paymentNonce(order);
        if (!order.depositEvidenceHash) {
          const transactionHash = await this.evidence.findSettlementTransaction({
            listing,
            payer: getAddress(order.payer!),
            nonce,
          });
          if (transactionHash) {
            try {
              const externalDeposit = await this.evidence.proveDeposit({
                order,
                listing,
                transactionHash,
                paymentNonce: nonce,
              });
              await this.journal.recordEvidence(
                order.orderId,
                "deposit",
                externalDeposit,
                this.appConfig.chainId,
              );
              const proven = {
                settlementTxHash: transactionHash,
                depositEvidenceHash: externalDeposit.evidenceHash,
              };
              order = order.state === "EXTERNAL_OR_UNPROVEN_DEPOSIT"
                ? await this.store.transition(
                  order,
                  "DEPOSIT_FINAL",
                  "proven_deposit_accepted_as_settlement",
                  proven,
                )
                : await this.store.transition(
                  order,
                  "EXTERNAL_OR_UNPROVEN_DEPOSIT",
                  "exact_deposit_without_authenticated_facilitator_success",
                  proven,
                );
            } catch (error) {
              if (Date.now() < order.updatedAt.getTime() +
                listing.deadlinePolicy.settlementEvidenceSeconds * 1_000) throw error;
              await this.store.transition(order, "LEGAL_HOLD", "unproven_external_deposit_evidence_deadline", {
                encryptedPaymentPayload: null,
              });
              return;
            }
          } else if (order.state === "EXTERNAL_OR_UNPROVEN_DEPOSIT") {
            // The authorization was seen consumed before facilitator egress
            // but its transfer is not discoverable yet; hold the evidence
            // window before parking the order.
            if (Date.now() < order.updatedAt.getTime() +
              listing.deadlinePolicy.settlementEvidenceSeconds * 1_000) {
              throw new Error("External deposit transaction is not yet discoverable");
            }
            await this.store.transition(order, "LEGAL_HOLD", "captured_settlement_evidence_unavailable", {
              encryptedPaymentPayload: null,
            });
            return;
          } else {
            const policy = this.railConfig.manifest.chainEvidencePolicy.payload;
            const finalNoCaptureAt = (
              this.paymentAuthorizationValidBefore(order) +
              (this.railConfig.finalityConfirmations + policy.maximumSourceLagBlocks) *
                policy.finalityBlockTimeSeconds
            ) * 1_000;
            if (Date.now() < finalNoCaptureAt) throw new Error("Settlement authorization is not final");
            if (await this.settlementCaptured(order)) {
              if (Date.now() < order.updatedAt.getTime() +
                listing.deadlinePolicy.settlementEvidenceSeconds * 1_000) {
                throw new Error("Captured settlement transaction is not yet discoverable");
              }
              await this.store.transition(order, "LEGAL_HOLD", "captured_settlement_evidence_unavailable", {
                encryptedPaymentPayload: null,
              });
              return;
            }
            await this.store.transition(order, "NOT_SETTLED", "independent_chain_observation_no_capture", {
              encryptedPaymentPayload: null,
            });
            return;
          }
        }
        if (order.state === "EXTERNAL_OR_UNPROVEN_DEPOSIT") {
          // The deposit is proven on chain and bound to this order's payer,
          // nonce, splitter and amount: the same evidence the facilitator
          // path relies on. Whether the facilitator's settle response was
          // lost or the payer relayed the authorization themselves, the funds
          // are in the splitter for this order, so it proceeds to release and
          // dispatch instead of parking in LEGAL_HOLD, where it blocked every
          // later purchase of the listing (audit M1, 2026-09-01).
          order = await this.store.transition(
            order,
            "DEPOSIT_FINAL",
            "proven_deposit_accepted_as_settlement",
          );
        }
      }
      let deposit: import("./evidence.js").EvidenceResult;
      if (order.state === "FACILITATOR_CONFIRMED") {
        const nonce = this.paymentNonce(order);
        const transactionHash = order.settlementTxHash ?? authenticatedSettlement?.transactionHash;
        if (!transactionHash) throw new Error("Authenticated settlement transaction is unavailable");
        try {
          deposit = await this.evidence.proveDeposit({
            order,
            listing,
            transactionHash,
            paymentNonce: nonce,
          });
        } catch (error) {
          if (Date.now() < order.updatedAt.getTime() + listing.deadlinePolicy.settlementEvidenceSeconds * 1_000) throw error;
          await this.store.transition(order, "LEGAL_HOLD", "signed_deposit_evidence_deadline_elapsed", {
            encryptedPaymentPayload: null,
          });
          return;
        }
        await this.journal.recordEvidence(order.orderId, "deposit", deposit, this.appConfig.chainId);
        order = await this.store.transition(order, "DEPOSIT_FINAL", "deposit_evidence_recovered", {
          settlementTxHash: transactionHash,
          depositEvidenceHash: deposit.evidenceHash,
        });
      } else {
        deposit = await this.journal.loadEvidence(order.orderId, "deposit");
      }
      if (order.state === "DEPOSIT_FINAL") {
        try {
          const depositOrder = order;
          const release = await this.withRailFence(() =>
            this.evidence.releaseAndProve({ order: depositOrder, listing, deposit }));
          await this.journal.recordEvidence(order.orderId, "release", release, this.appConfig.chainId);
          const reputation = await buildReputationRegistration({
            order,
            listing,
            deposit,
            releaseEvidenceHash: release.evidenceHash,
            config: this.railConfig,
            chainId: this.appConfig.chainId,
            marketplaceContracts: this.appConfig.marketplaceContracts,
            evidence: this.evidence,
          });
          order = await this.store.transition(order, "RELEASE_FINAL", "release_evidence_recovered", {
            releaseTxHash: release.transactionHash,
            releaseEvidenceHash: release.evidenceHash,
            providerNetAmount: release.providerNetAmount.toString(),
            daskiCommissionAmount: release.daskiCommissionAmount.toString(),
            encryptedPaymentPayload: null,
          }, {
            kind: "register",
            logicalKey: order.orderKey,
            ...reputation,
          });
        } catch (error) {
          if (Date.now() < order.updatedAt.getTime() + listing.deadlinePolicy.releaseEvidenceSeconds * 1_000) throw error;
          await this.store.transition(order, "LEGAL_HOLD", "signed_release_evidence_deadline_elapsed", {
            encryptedPaymentPayload: null,
          });
          return;
        }
      }
      if (["RELEASE_FINAL", "DISPATCH_STARTED", "DISPATCH_AMBIGUOUS"].includes(order.state)) {
        const release = await this.journal.loadEvidence(order.orderId, "release");
        const confirmationHash = await this.journal.settlementResponseHash(order.orderId);
        const dispatched = await this.dispatch(
          order,
          listing,
          order.canonicalRequest,
          confirmationHash,
          { deposit, release },
        );
        const dispatchClaim = await this.journal.dispatchClaim(order.orderId);
        if (!dispatchClaim) throw new Error("Dispatch recovery lost its persisted claim");
        if (
          dispatched.state === "DISPATCH_AMBIGUOUS" &&
          Date.now() >= dispatchClaim.dispatch.validBefore * 1_000
        ) {
          await this.store.transition(
            dispatched,
            "PROVIDER_FAILED",
            "signed_dispatch_resolution_deadline_elapsed",
          );
        }
      }
    });
  }

  listing(providerAgentId: string, outcomeId: string): Promise<StandardListing> {
    return this.catalog.listing(providerAgentId, outcomeId);
  }

  private verifyListingIdentity(listing: StandardListing): Promise<void> {
    return this.catalog.verifyListingIdentity(listing);
  }

  listOutcomes(): Promise<PublicOutcomeV1[]> {
    return this.catalog.listOutcomes();
  }

  publicOutcomes(): Promise<PublicOutcomeV1[]> {
    return this.catalog.publicOutcomes();
  }

  searchOutcomes(filters: {
    text?: string;
    providerAgentId?: string;
    categoryFamily?: string;
    serviceType?: string;
    jurisdiction?: string;
    pricingMode?: "fixed" | "dynamic";
    persistentAsset?: boolean;
    limit: number;
  }): Promise<PublicOutcomeSummaryV1[]> {
    return this.catalog.searchOutcomes(filters);
  }

  searchVocabulary(): Promise<CatalogSearchVocabularyV1> {
    return this.catalog.searchVocabulary();
  }

  getOutcome(providerAgentId: string, outcomeId: string): Promise<PublicOutcomeDetailV1> {
    return this.catalog.getOutcome(providerAgentId, outcomeId);
  }

  issueWalletChallenge(args: {
    action: "list-orders" | "get-buyer-reputation" | "list-assets";
    payer: string;
    request: unknown;
    absoluteResourceUri: string;
    clientKey?: string;
  }) {
    return this.walletStore.issue({
      ...args,
      clientKey: args.clientKey ?? activeRequestKey("unknown"),
    });
  }

  listWalletOrders(args: {
    payer: string;
    limit: number;
    cursor: string | null;
    paymentIdentifier?: string | null;
    authorization: WalletAuthorizationTransport;
  }) {
    return this.walletQueries.listOrders(args);
  }

  getWalletReputation(args: {
    payer: string;
    authorization: WalletAuthorizationTransport;
  }) {
    return this.walletQueries.getReputation(args);
  }

  listWalletAssets(args: {
    payer: string;
    providerAgentId: string | null;
    limit: number;
    cursor: string | null;
    authorization: WalletAuthorizationTransport;
  }) {
    return this.assetFederation.listAssets(args);
  }

  issueAssetActionChallenge(args: {
    payer: string;
    providerAgentId: string;
    actionId: string;
    providerAssetId: string;
    input: Record<string, unknown>;
    absoluteResourceUri: string;
    clientKey?: string;
  }) {
    return this.assetActions.issue({
      ...args,
      clientKey: args.clientKey ?? activeRequestKey("unknown"),
    });
  }

  performAssetAction(args: {
    payer: string;
    providerAgentId: string;
    actionId: string;
    providerAssetId: string;
    input: Record<string, unknown>;
    authorization: WalletAuthorizationTransport;
  }) {
    return this.assetActions.perform(args);
  }

  async signedReceipt(order: StandardOrderRecord) {
    if (
      !order.payer || !order.authorizationKey || !order.paymentPayloadHash ||
      !order.providerNetAmount || !order.daskiCommissionAmount ||
      !order.settlementTxHash || !order.depositEvidenceHash ||
      !order.releaseTxHash || !order.releaseEvidenceHash
    ) return null;
    const [facilitatorConfirmationHash, deposit, release] = await Promise.all([
      this.journal.settlementResponseHash(order.orderId),
      this.journal.loadEvidence(order.orderId, "deposit"),
      this.journal.loadEvidence(order.orderId, "release"),
    ]);
    if (
      deposit.transactionHash !== order.settlementTxHash ||
      deposit.evidenceHash !== order.depositEvidenceHash ||
      release.transactionHash !== order.releaseTxHash ||
      release.evidenceHash !== order.releaseEvidenceHash ||
      release.providerNetAmount.toString() !== order.providerNetAmount ||
      release.daskiCommissionAmount.toString() !== order.daskiCommissionAmount
    ) throw standardRailError("INTERNAL_ERROR", {
        phase: "dispatch",
        internalMessage: "Persisted receipt evidence does not match the order",
      });
    const payload: StandardRailReceiptV2 = {
      orderId: order.orderId,
      state: "RELEASE_FINAL",
      payer: order.payer,
      providerAgentId: order.providerAgentId,
      outcomeId: order.outcomeId,
      bindingProfile: order.bindingProfile,
      activeRailProfileHash: this.railProfileHash,
      listingManifestHash: order.listingManifestHash,
      providerOfferHash: order.providerOfferHash,
      quoteHash: order.quoteHash,
      canonicalRequestHash: order.canonicalRequestHash,
      orderNonce: order.orderNonce,
      authorizationKey: order.authorizationKey,
      paymentPayloadHash: order.paymentPayloadHash,
      grossAmount: order.grossAmount,
      providerNetAmount: order.providerNetAmount,
      daskiCommissionAmount: order.daskiCommissionAmount,
      facilitatorConfirmationHash,
      settlementTxHash: order.settlementTxHash,
      depositEvidenceHash: deposit.evidenceHash,
      depositBlockNumber: deposit.blockNumber.toString(),
      depositBlockHash: deposit.blockHash,
      depositTransactionIndex: deposit.transactionIndex,
      depositLogIndex: deposit.logIndex,
      releaseTxHash: order.releaseTxHash,
      releaseEvidenceHash: release.evidenceHash,
      releaseBlockNumber: release.blockNumber.toString(),
      releaseBlockHash: release.blockHash,
      releaseTransactionIndex: release.transactionIndex,
      releaseLogIndex: release.logIndex,
      releaseSequence: release.releaseSequence.toString(),
    };
    const existing = await this.store.loadReceipt(order.orderId);
    if (existing) {
      if (
        existing.environment !== this.railConfig.environment ||
        existing.chainId !== this.appConfig.chainId || existing.audience !== order.payer ||
        existing.signerKeyId !== "gateway-receipt" ||
        canonicalHash(existing.payload) !== canonicalHash(payload)
      ) throw standardRailError("INTERNAL_ERROR", {
        phase: "dispatch",
        internalMessage: "Persisted StandardRailReceiptV2 does not match the order",
      });
      return existing;
    }
    const now = Math.floor(Date.now() / 1_000);
    const receipt = await signEnvelope<StandardRailReceiptV2, 2>({
      artifactType: "StandardRailReceiptV2",
      schemaVersion: 2,
      environment: this.railConfig.environment,
      chainId: this.appConfig.chainId,
      audience: order.payer ?? this.railConfig.gatewayAudience,
      signerKeyId: "gateway-receipt",
      privateKey: this.railConfig.receiptPrivateKey,
      issuedAt: now,
      validBefore: Math.floor(order.expiresAt.getTime() / 1_000) + 31_536_000,
      payload,
    });
    return this.store.persistReceipt(order.orderId, receipt);
  }

  async purchaseReceipts(order: StandardOrderRecord) {
    const receipt = await this.signedReceipt(order);
    if (!receipt || !order.payer || !order.settlementTxHash) {
      return { receipt, x402OfferReceipt: null, x402PaymentResponse: null };
    }
    const x402OfferReceipt = await createX402OfferReceipt({
      privateKey: this.railConfig.receiptPrivateKey,
      network: this.appConfig.x402Network,
      resourceUrl: order.listing.commitment.payload.absoluteResourceUri,
      payer: order.payer,
      issuedAt: receipt.issuedAt,
      transaction: order.settlementTxHash,
    });
    return {
      receipt,
      x402OfferReceipt,
      x402PaymentResponse: x402PaymentResponse({
        receipt: x402OfferReceipt,
        network: this.appConfig.x402Network,
        payer: order.payer,
        transaction: order.settlementTxHash,
      }),
    };
  }

  async issueActionChallenge(args: {
    handle: string;
    action: OrderAction;
    request: Record<string, unknown>;
    clientKey?: string;
  }): Promise<Record<string, unknown>> {
    await this.assertRailFence();
    const order = await this.store.findByHandle(args.handle);
    const now = Math.floor(Date.now() / 1_000);
    const validBefore = now + 300;
    const nonce = `0x${randomBytes(32).toString("hex")}` as Hex;
    const absoluteResourceUri =
      `${this.appConfig.publicUrl.replace(/\/$/, "")}/orders/${encodeURIComponent(args.handle)}/actions/${args.action}`;
    const requestHash = canonicalHash(args.request);
    const orderId = order?.payer ? order.orderId : this.syntheticOrderId(args.handle);
    await this.journal.issueActionChallenge({
      orderId: order?.payer ? order.orderId : null,
      action: args.action,
      requestHash,
      absoluteResourceUri,
      nonce,
      issuedAt: now,
      validBefore,
      clientKeyHash: createHmac("sha256", this.railConfig.encryptionKey)
        .update("wallet-challenge-client\0")
        .update(args.clientKey ?? activeRequestKey("unknown"))
        .digest(),
      outstandingPerClient: this.railConfig.abuse.walletChallengesOutstandingPerClient,
      outstandingGlobal: this.railConfig.abuse.walletChallengesOutstandingGlobal,
    });
    const challenge: OrderActionChallenge = {
      orderId,
      action: args.action,
      method: "POST",
      absoluteResourceUri,
      requestHash,
      nonce,
      issuedAt: now,
      validBefore,
    };
    return orderActionChallengeIssued({
      challenge,
      chainId: this.appConfig.chainId,
      gatewayAudience: this.railConfig.gatewayAudience,
    });
  }

  private syntheticOrderId(handle: string): string {
    const digest = createHmac("sha256", this.railConfig.encryptionKey)
      .update("missing-order-challenge\0")
      .update(handle)
      .digest("hex")
      .slice(0, 32);
    const hex = `${digest.slice(0, 12)}4${digest.slice(13, 16)}8${digest.slice(17)}`;
    return `ord_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  async performAction(args: {
    handle: string;
    action: OrderAction;
    request: Record<string, unknown>;
    authorization?: {
      orderId: string;
      action: string;
      method: "POST";
      absoluteResourceUri: string;
      requestHash: Hex;
      nonce: Hex;
      issuedAt: number;
      validBefore: number;
      signature: Hex;
    };
    readCapability?: string;
  }): Promise<unknown> {
    await this.assertRailFence();
    const order = await this.store.findByHandle(args.handle);
    if (!order || !order.payer) {
      throw standardRailError("WALLET_AUTHORIZATION_INVALID");
    }
    if (Boolean(args.authorization) === Boolean(args.readCapability)) {
      throw standardRailError("WALLET_AUTHORIZATION_INVALID", {
        message: "Provide exactly one of authorization or readCapability",
      });
    }

    const requestHash = canonicalHash(args.request);
    const expectedUri =
      `${this.appConfig.publicUrl.replace(/\/$/, "")}/orders/${encodeURIComponent(args.handle)}/actions/${args.action}`;
    let authorizationHash: Hex;
    let providerAuthorization: unknown;
    if (args.readCapability) {
      if (args.action !== "status" && args.action !== "artifact") {
        throw standardRailError("WALLET_AUTHORIZATION_INVALID", {
          message: "Read capabilities authorize only status and artifact actions",
        });
      }
      verifyReadCapability({
        key: this.railConfig.encryptionKey,
        token: args.readCapability,
        orderId: order.orderId,
        payer: order.payer,
        audience: this.railConfig.gatewayAudience,
        capabilityEpoch: order.capabilityEpoch,
        requiredScope: args.action,
      });
      providerAuthorization = { type: "DaskiReadCap", scope: args.action };
      authorizationHash = canonicalHash(providerAuthorization);
    } else {
      const authorization = args.authorization!;
      const now = Math.floor(Date.now() / 1_000);
      if (
        authorization.issuedAt > now + 30 ||
        authorization.validBefore <= now ||
        authorization.validBefore > now + 300
      ) {
        throw standardRailError("WALLET_AUTHORIZATION_INVALID", {
          message: "Order action authorization is expired",
        });
      }
      if (
        authorization.orderId !== order.orderId || authorization.action !== args.action ||
        authorization.method !== "POST" || authorization.absoluteResourceUri !== expectedUri ||
        authorization.requestHash !== requestHash
      ) {
        throw standardRailError("WALLET_AUTHORIZATION_INVALID", {
          message: "Order action authorization binding is invalid",
        });
      }
      const signRequest = orderActionSignRequest({
        challenge: {
          orderId: authorization.orderId,
          action: args.action,
          method: authorization.method,
          absoluteResourceUri: authorization.absoluteResourceUri,
          requestHash,
          nonce: authorization.nonce,
          issuedAt: authorization.issuedAt,
          validBefore: authorization.validBefore,
        },
        chainId: this.appConfig.chainId,
        gatewayAudience: this.railConfig.gatewayAudience,
      });
      const valid = await verifyTypedData({
        address: getAddress(order.payer),
        ...signRequest,
        message: {
          ...signRequest.message,
          issuedAt: BigInt(signRequest.message.issuedAt),
          validBefore: BigInt(signRequest.message.validBefore),
        },
        signature: authorization.signature,
      });
      if (!valid) throw standardRailError("WALLET_AUTHORIZATION_INVALID");
      if (args.action === "confirmation" || args.action === "revoke-confirmation") {
        await this.confirmations.assertReady(order);
      }
      try {
        await this.journal.consumeActionChallenge({
          orderId: order.orderId,
          action: args.action,
          requestHash,
          absoluteResourceUri: authorization.absoluteResourceUri,
          nonce: authorization.nonce,
          issuedAt: authorization.issuedAt,
          validBefore: authorization.validBefore,
          payerRate: ["confirmation", "revoke-confirmation"].includes(args.action)
            ? {
                scope: "wallet-state-change",
                maximum: this.railConfig.abuse.assetStateChangesPerPayerPerMinute,
              }
            : undefined,
        });
      } catch (error) {
        if (error instanceof Error && error.message === "ACTION_CHALLENGE_INVALID_OR_REPLAYED") {
          await this.incidents.record({
            kind: "action_authorization_reuse_or_tamper",
            orderId: order.orderId,
            state: order.state,
            details: { action: args.action, nonce: authorization.nonce },
          });
        }
        throw standardRailError("WALLET_AUTHORIZATION_INVALID", { cause: error });
      }
      providerAuthorization = authorization;
      authorizationHash = canonicalHash(authorization);
    }

    if (args.action === "grant-read") {
      return {
        ...issueReadCapability({
          key: this.railConfig.encryptionKey,
          orderId: order.orderId,
          payer: order.payer,
          audience: this.railConfig.gatewayAudience,
          capabilityEpoch: order.capabilityEpoch,
          ttlSeconds: this.railConfig.orderReadCapTtlSeconds,
        }),
        orderHandle: args.handle,
      };
    }
    if (args.action === "confirmation" || args.action === "revoke-confirmation") {
      const result = await this.confirmations.handle(order, args.action, args.request);
      await this.store.bumpCapabilityEpoch(order.orderId);
      return result;
    }
    if (args.action === "status" && !order.providerTaskId) {
      return {
        orderHandle: args.handle,
        state: order.state,
        receipt: await this.signedReceipt(order),
      };
    }
    if (!order.providerTaskId) throw standardRailError("INTERNAL_ERROR", {
        phase: "dispatch",
        internalMessage: "PROVIDER_TASK_NOT_AVAILABLE",
      });
    const listing = order.listing;
    const grantIssuedAt = Math.floor(Date.now() / 1_000);
    const lifecycleGrant = await signEnvelope({
      artifactType: "ProviderLifecycleGrantV1",
      environment: this.railConfig.environment,
      chainId: this.appConfig.chainId,
      audience: listing.providerControlProfile.payload.providerAudience,
      signerKeyId: "gateway-lifecycle",
      privateKey: this.railConfig.lifecyclePrivateKey,
      issuedAt: grantIssuedAt,
      validBefore: grantIssuedAt + 120,
      payload: {
        orderId: order.orderId,
        providerTaskId: order.providerTaskId,
        action: args.action,
        requestHash,
        authorizationHash,
        payer: order.payer,
      },
    });
    const response = await this.providerFetch(
      listing,
      listing.providerControlProfile.payload.lifecycleUrl,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orderId: order.orderId,
          providerTaskId: order.providerTaskId,
          action: args.action,
          request: args.request,
          authorization: providerAuthorization,
          grant: lifecycleGrant,
          payer: order.payer,
          gatewayAudience: this.railConfig.gatewayAudience,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(
          this.railConfig.dispatchTimeoutMs,
          listing.providerControlProfile.payload.timeoutMs,
        )),
      },
    );
    if (!response.ok) {
      await discardResponseBody(response);
      throw standardRailError("INTERNAL_ERROR", {
        phase: "dispatch",
        internalMessage: "PROVIDER_LIFECYCLE_REJECTED",
      });
    }
    const providerResult = await readBoundedJson(
      response,
      listing.providerControlProfile.payload.maxResponseBytes,
    );
    const result = await this.applyLifecycleResult(
      order,
      listing,
      providerResult,
      args.action as "status" | "input" | "cancel" | "artifact" | "support",
      args.handle,
    );
    if (["input", "cancel", "support"].includes(args.action)) {
      await this.store.bumpCapabilityEpoch(order.orderId);
    }
    return result;
  }

  private async applyLifecycleResult(
    initial: StandardOrderRecord,
    listing: StandardListing,
    result: unknown,
    action: "status" | "input" | "cancel" | "artifact" | "support",
    handle: string,
  ): Promise<unknown> {
    if (!result || typeof result !== "object") throw standardRailError("INTERNAL_ERROR", {
        phase: "dispatch",
        internalMessage: "PROVIDER_LIFECYCLE_RESPONSE_INVALID",
      });
    const response = result as {
      orderId?: unknown; taskId?: unknown; state?: unknown; result?: unknown;
      signature?: unknown;
      terminalAttestation?: { payload?: Record<string, unknown>; signature?: unknown };
    };
    const lifecycleKeys = ["orderId", "taskId", "state", "signature"];
    if ("result" in response) lifecycleKeys.push("result");
    if ("terminalAttestation" in response) lifecycleKeys.push("terminalAttestation");
    assertExactKeys(response, lifecycleKeys, "provider lifecycle response");
    if (
      response.orderId !== initial.orderId || response.taskId !== initial.providerTaskId ||
      typeof response.signature !== "string" ||
      !["submitted", "dispatching", "working", "input-required", "completed", "failed", "canceled"]
        .includes(String(response.state))
    ) {
      throw standardRailError("INTERNAL_ERROR", {
        phase: "dispatch",
        internalMessage: "PROVIDER_LIFECYCLE_BINDING_INVALID",
      });
    }
    const { signature, ...signedResponse } = response;
    const authority = await recoverMessageAddress({
      message: { raw: canonicalHash(signedResponse) },
      signature: signature as Hex,
    });
    if (getAddress(authority) !== getAddress(listing.commitment.payload.providerAuthorityKey)) {
      throw standardRailError("INTERNAL_ERROR", {
        phase: "dispatch",
        internalMessage: "PROVIDER_LIFECYCLE_SIGNATURE_INVALID",
      });
    }
    if ((action === "status" || action === "support" || action === "cancel") && "result" in response) {
      throw standardRailError("INTERNAL_ERROR", {
        phase: "dispatch",
        internalMessage: "PROVIDER_LIFECYCLE_UNEXPECTED_CONTENT",
      });
    }
    if (action === "artifact" && !("result" in response)) {
      throw standardRailError("INTERNAL_ERROR", {
        phase: "dispatch",
        internalMessage: "PROVIDER_ARTIFACT_MISSING",
      });
    }
    if ("result" in response) await this.validateResponse(listing, response.result);
    let order = initial;
    if (response.state === "input-required" && order.state === "DISPATCHED") {
      order = await this.store.transition(order, "INPUT_REQUIRED", "provider_input_required");
    } else if (response.state === "working" && order.state === "INPUT_REQUIRED") {
      order = await this.store.transition(order, "DISPATCHED", "provider_input_accepted");
    } else if (["completed", "failed", "canceled"].includes(String(response.state))) {
      const attestation = response.terminalAttestation;
      if (!attestation?.payload || typeof attestation.signature !== "string") {
        throw standardRailError("INTERNAL_ERROR", {
        phase: "dispatch",
        internalMessage: "PROVIDER_TERMINAL_ATTESTATION_MISSING",
      });
      }
      assertExactKeys(attestation, ["payload", "signature"], "provider lifecycle attestation");
      assertExactKeys(
        attestation.payload,
        ["orderId", "taskId", "state", "resultHash", "completedAt"],
        "provider lifecycle attestation payload",
      );
      if (
        typeof attestation.payload.completedAt !== "number" ||
        !Number.isSafeInteger(attestation.payload.completedAt) ||
        attestation.payload.completedAt <= 0 ||
        attestation.payload.completedAt > Math.floor(Date.now() / 1_000) + 30
      ) throw standardRailError("INTERNAL_ERROR", {
        phase: "dispatch",
        internalMessage: "PROVIDER_TERMINAL_ATTESTATION_TIME_INVALID",
      });
      const signer = await recoverMessageAddress({
        message: { raw: canonicalHash(attestation.payload) },
        signature: attestation.signature as Hex,
      });
      if (
        getAddress(signer) !== getAddress(listing.commitment.payload.providerTerminalAttestationKey) ||
        attestation.payload.orderId !== initial.orderId ||
        attestation.payload.taskId !== initial.providerTaskId ||
        attestation.payload.state !== response.state ||
        (action !== "artifact" && "result" in response &&
          attestation.payload.resultHash !== canonicalHash(response.result))
      ) throw standardRailError("INTERNAL_ERROR", {
        phase: "dispatch",
        internalMessage: "PROVIDER_TERMINAL_ATTESTATION_INVALID",
      });
      if (response.state === "completed" && ["DISPATCHED", "INPUT_REQUIRED"].includes(order.state)) {
        order = await this.store.transition(order, "FULFILLED", "provider_terminal_completed");
      } else if (["failed", "canceled"].includes(String(response.state)) && ["DISPATCHED", "INPUT_REQUIRED"].includes(order.state)) {
        order = await this.store.transition(order, "PROVIDER_FAILED", "provider_terminal_failed");
      }
    }
    // Every order action answers with the order handle and the gateway's own
    // order state beside the provider's lifecycle state, so a client can
    // always recover from the handle alone.
    return { ...response, orderHandle: handle, orderState: order.state, receipt: await this.signedReceipt(order) };
  }

  async issueChallenge(args: {
    providerAgentId: string;
    outcomeId: string;
    body: unknown;
    payerAddress?: Hex;
  }): Promise<{ handle: string; order: StandardOrderRecord; paymentRequired: PaymentRequired }> {
    this.assertAdmissionOpen();
    await this.assertRailFence();
    const listing = await this.listing(args.providerAgentId, args.outcomeId);
    await this.validateRequest(listing, args.body);
    const canonicalRequestHash = canonicalHash({
      method: "POST",
      resource: listing.commitment.payload.absoluteResourceUri,
      providerAgentId: args.providerAgentId,
      outcomeId: args.outcomeId,
      body: args.body,
    });
    const listingManifestHash = listing.runtimeCommitmentHash;
    const providerOfferHash = listing.providerIntentHash;
    const railEpoch = this.railConfig.manifest.activeRailProfile.payload.railEpoch;
    const existing = await this.store.findOpenDraft(
      args.providerAgentId,
      args.outcomeId,
      canonicalRequestHash,
      listingManifestHash,
      providerOfferHash,
      railEpoch,
    );
    if (existing) {
      return this.challengeResponse(listing, existing.order, existing.handle, args.payerAddress);
    }

    const now = Math.floor(Date.now() / 1_000);
    const pricing = await this.resolveGrossAmount(listing, args.body);
    const quoteIssuedAt = Math.max(now, pricing.issuedAt);
    const minimumPaymentWindowSeconds = Math.max(
      listing.deadlinePolicy.minimumPaymentWindowSeconds,
      listing.quotePolicy?.minimumPaymentWindowSeconds ?? 0,
    );
    const expiresAt = Math.min(
      now + this.railConfig.challengeTtlSeconds,
      pricing.validBefore,
    );
    if (expiresAt <= quoteIssuedAt + minimumPaymentWindowSeconds) {
      throw standardRailError("CHALLENGE_EXPIRED", {
        serverTime: now,
        logContext: {
          providerAgentId: args.providerAgentId,
          outcomeId: args.outcomeId,
          canonicalRequestHash,
        },
      });
    }
    const grossAmount = pricing.grossAmount;
    const orderNonce = `0x${randomBytes(32).toString("hex")}` as Hex;
    const intentId = `int_${randomUUID()}`;
    const quote = await signEnvelope<QuoteV1>({
      artifactType: "QuoteV1",
      environment: this.railConfig.environment,
      chainId: this.appConfig.chainId,
      audience: this.railConfig.gatewayAudience,
      signerKeyId: "gateway-quote",
      privateKey: this.railConfig.quotePrivateKey,
      issuedAt: quoteIssuedAt,
      validBefore: expiresAt,
      payload: {
        listingManifestHash,
        providerOfferHash,
        providerQuoteHash: pricing.providerQuoteHash,
        canonicalRequestHash,
        grossAmount,
        token: listing.commitment.payload.canonicalToken,
        splitter: listing.manifest.payload.splitterAddress,
        orderNonce,
        issuedAt: quoteIssuedAt,
        validBefore: expiresAt,
      },
    });
    const created = await this.store.createDraft({
      providerAgentId: args.providerAgentId,
      outcomeId: args.outcomeId,
      bindingProfile: listing.commitment.payload.bindingProfile,
      listingManifestHash,
      providerOfferHash,
      listing,
      quoteHash: canonicalHash(quote),
      quote,
      orderNonce,
      intentId,
      canonicalRequestHash,
      canonicalRequest: args.body,
      grossAmount,
      railEpoch,
      listingEpoch: listing.commitment.payload.listingEpoch,
      expiresAt: new Date(expiresAt * 1_000),
    });
    return this.challengeResponse(listing, created.order, created.handle, args.payerAddress);
  }

  async preparePaymentChallenge(args: {
    providerAgentId: string;
    outcomeId: string;
    body: unknown;
    payerAddress?: Hex;
  }) {
    const challenge = await this.issueChallenge(args);
    const listing = await this.listing(args.providerAgentId, args.outcomeId);
    const required = challenge.paymentRequired.accepts[0]!;
    const payer = args.payerAddress ? getAddress(args.payerAddress) : null;
    const payerAllowed = payer
      ? isReputationEligiblePayer(payer, listing, this.railConfig)
      : null;
    let usdcBalance: string | null = null;
    let sufficient: boolean | null = null;
    let note: string | undefined;
    if (payer) {
      try {
        const chain = this.appConfig.chainId === 8453 ? base : baseSepolia;
        const clients = this.railConfig.evidenceRpcUrls.map((url) => ({
          host: new URL(url).hostname,
          client: createPublicClient({
            chain,
            transport: http(url, { retryCount: 0, timeout: 10_000 }),
          }),
        }));
        const balance = await withRpcFailover(
          clients,
          ({ client }) => client.readContract({
            address: getAddress(required.asset),
            abi: parseAbi(["function balanceOf(address holder) view returns (uint256)"]),
            functionName: "balanceOf",
            args: [payer],
          }),
          { attempts: 1, baseDelayMs: 0 },
        );
        usdcBalance = balance.toString();
        sufficient = balance >= BigInt(required.amount);
      } catch {
        note = "USDC balance could not be checked; the challenge remains valid.";
      }
    } else {
      note = "Provide payerAddress to receive a sign-ready challenge and balance preflight.";
    }
    const amount = BigInt(required.amount);
    const whole = amount / 1_000_000n;
    const fraction = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
    const displayAmount = fraction ? `${whole}.${fraction}` : whole.toString();
    const networkName = this.appConfig.chainId === 8453 ? "Base" : "Base Sepolia";
    const ttl = Math.max(
      0,
      Math.floor(challenge.order.expiresAt.getTime() / 1_000) -
        Math.floor(Date.now() / 1_000),
    );
    return {
      orderHandle: challenge.handle,
      paymentRequired: challenge.paymentRequired,
      preflight: {
        payer,
        network: this.appConfig.x402Network,
        usdcBalance,
        sufficient,
        payerAllowed,
        intentId: challenge.order.intentId,
        approvalSummary:
          `Buy ${listing.offer.payload.skillId} from ${listing.terms.providerLegalName} ` +
          `for ${displayAmount} USDC (${networkName}). Challenge expires in ${ttl}s.`,
        ...(note ? { note } : {}),
      },
    };
  }

  async submitPayment(args: {
    providerAgentId: string;
    outcomeId: string;
    body: unknown;
    payment: PaymentPayload;
  }): Promise<{ handle: string; order: StandardOrderRecord; replay: boolean }> {
    this.assertAdmissionOpen();
    await this.assertRailFence();
    const payment = normalizePaymentPayload(args.payment);
    const intentId = paymentIntentId(payment);
    const intended = await this.store.findByIntentId(intentId);
    if (!intended ||
        intended.order.providerAgentId !== args.providerAgentId ||
        intended.order.outcomeId !== args.outcomeId ||
        canonicalHash(intended.order.canonicalRequest) !== canonicalHash(args.body)) {
      throw standardRailError("PAYMENT_IDENTIFIER_CONFLICT", {
        field: "payment-identifier",
        logContext: {
          intentId,
          providerAgentId: args.providerAgentId,
          outcomeId: args.outcomeId,
        },
      });
    }
    const paymentHash = canonicalHash(payment);
    if (intended.order.paymentPayloadHash) {
      if (intended.order.paymentPayloadHash !== paymentHash) {
        throw standardRailError("PAYMENT_IDENTIFIER_CONFLICT", {
          field: "payment-identifier",
          logContext: { intentId, orderId: intended.order.orderId },
        });
      }
      return { ...intended, replay: true };
    }
    if (intended.order.expiresAt.getTime() <= Date.now()) {
      throw standardRailError("CHALLENGE_EXPIRED", {
        logContext: { intentId, orderId: intended.order.orderId },
      });
    }

    const authorizationKey = paymentAuthorizationLookupKey(this.appConfig, payment);
    const existingAuthorization = await this.store.findByAuthorizationKey(authorizationKey);
    if (existingAuthorization) {
      if (existingAuthorization.order.intentId !== intentId ||
          existingAuthorization.order.paymentPayloadHash !== paymentHash) {
        await this.incidents.record({
          kind: "changed_payment_authorization_replay",
          orderId: existingAuthorization.order.orderId,
          state: existingAuthorization.order.state,
          details: { intentId, presentedPaymentHash: paymentHash },
        });
        throw standardRailError("PAYMENT_IDENTIFIER_CONFLICT", {
          field: "payment-identifier",
          logContext: { intentId, orderId: existingAuthorization.order.orderId },
        });
      }
      return { ...existingAuthorization, replay: true };
    }

    let order = intended.order;
    if (order.state !== "CHALLENGE_ISSUED") {
      return { handle: intended.handle, order, replay: false };
    }
    const listing = await this.listing(args.providerAgentId, args.outcomeId);
    const requirements = paymentRequirements(
      this.appConfig,
      listing,
      order.grossAmount,
      this.orderPaymentTimeout(order),
    );
    const authorization = await validatePayment({
      config: this.appConfig,
      listing,
      order,
      requirements,
      payment,
      railProfileHash: this.railProfileHash,
      validAfterBackstopSeconds: this.railConfig.validAfterBackstopSeconds,
    });
    if (!isReputationEligiblePayer(authorization.payer, listing, this.railConfig)) {
      throw standardRailError("SELF_PURCHASE_FORBIDDEN", {
        field: "payload.authorization.from",
      });
    }
    try {
      order = await this.store.claimAuthorization({
        orderId: order.orderId,
        expectedVersion: order.version,
        authorizationKey: authorization.authorizationKey,
        payer: authorization.payer,
        encryptedPayload: encryptPaymentPayload(this.railConfig.encryptionKey, payment),
        paymentPayloadHash: paymentHash,
        facilitatorProfileHash: this.railConfig.manifest.activeRailProfile.payload.facilitatorProfileHash,
        capacityLimit: listing.capacityPolicy.maxOpenOrders,
      });
    } catch (error) {
      const claimed = await this.store.findByIntentId(intentId);
      if (claimed?.order.paymentPayloadHash === paymentHash) return { ...claimed, replay: true };
      throw error;
    }
    return this.driveClaimedOrder(intended.handle, order, (claimed) =>
      this.settleClaimedOrder({
        order: claimed,
        listing,
        requirements,
        authorization,
        body: args.body,
        payment,
      }));
  }

  // Runs `work` as the claimed order's driver. The request leases the order
  // for as long as it is advancing it and renews that lease on a heartbeat,
  // so the recovery worker does not read a long finality wait as
  // abandonment, lease the order from underneath the request, and fence the
  // request's next transition out (2026-08-22: ORDER_TRANSITION_CONFLICT at
  // the RELEASE_FINAL transition answered a captured purchase with a 5xx).
  // Should another driver still hold the fence, the order's current state is
  // the truthful one-shape answer: it is the same order, carried on by
  // recovery, and the client recovers from the handle alone.
  private async driveClaimedOrder(
    handle: string,
    claimed: StandardOrderRecord,
    work: (order: StandardOrderRecord) => Promise<StandardOrderRecord>,
  ): Promise<{ handle: string; order: StandardOrderRecord; replay: boolean }> {
    const driver = `standard-request-${randomUUID()}`;
    const order = await this.store.leaseOrder(claimed.orderId, driver, this.railConfig.leaseSeconds);
    if (!order) return this.currentOrderReply(handle, claimed, driver);
    const heartbeat = this.renewLeaseWhileDriving(order, driver);
    try {
      return { handle, order: await work(order), replay: false };
    } catch (error) {
      if (!isTransitionConflict(error)) throw error;
      return this.currentOrderReply(handle, order, driver);
    } finally {
      heartbeat.stop();
      await this.store.releaseLease(order.orderId, driver, order.leaseFence);
    }
  }

  private renewLeaseWhileDriving(
    order: StandardOrderRecord,
    driver: string,
  ): { stop(): void } {
    const seconds = this.railConfig.leaseSeconds;
    const timer = setInterval(() => {
      this.store.renewLease(order.orderId, driver, order.leaseFence, seconds)
        .then((renewed) => { if (!renewed) clearInterval(timer); })
        .catch(() => undefined);
    }, Math.max(1_000, Math.floor((seconds * 1_000) / 3)));
    timer.unref();
    return { stop: () => clearInterval(timer) };
  }

  // The order as the database holds it now, recorded as an incident because
  // this request stopped driving it before it reached a terminal state.
  private async currentOrderReply(
    handle: string,
    fallback: StandardOrderRecord,
    driver: string,
  ): Promise<{ handle: string; order: StandardOrderRecord; replay: boolean }> {
    const order = await this.store.findById(fallback.orderId) ?? fallback;
    await this.incidents.record({
      kind: "in_flight_purchase_fenced_out",
      orderId: order.orderId,
      state: order.state,
      details: { driver, fence: fallback.leaseFence },
    }).catch(() => undefined);
    return { handle, order, replay: false };
  }

  // The post-claim purchase path: facilitator verify and settle, deposit and
  // release evidence, reputation registration, and dispatch. Resolves to the
  // order as far as this driver carried it.
  private async settleClaimedOrder(args: {
    order: StandardOrderRecord;
    listing: StandardListing;
    requirements: PaymentRequirements;
    authorization: ValidatedAuthorization;
    body: unknown;
    payment: PaymentPayload;
  }): Promise<StandardOrderRecord> {
    const { listing, requirements, authorization } = args;
    let order = args.order;
    await this.screenParticipants(listing, authorization.payer);
    await this.journal.markVerifyInvoked(order.orderId);
    let verify;
    try {
      verify = await this.withRailFence(() => this.facilitator.verify(args.payment, requirements));
    } catch (error) {
      // The facilitator was never reached, so nothing was verified and
      // nothing can settle. The claimed authorization is voided before the
      // client is told to sign again: left in ATTEMPT_OPENED, recovery would
      // re-verify and settle it while the client's fresh signature settles a
      // second time (audit H1, 2026-09-01).
      order = await this.store.transition(order, "VERIFY_REJECTED", "facilitator_verify_unavailable");
      await this.store.releaseCapacity(order.orderId);
      throw standardRailError("FACILITATOR_REJECTED", {
        phase: "facilitator_verify",
        status: 503,
        message: "The external facilitator could not be reached; this authorization was voided",
        nextAction: "This authorization will not settle. Request a fresh challenge and sign again.",
        cause: error,
        logContext: { orderId: order.orderId, intentId: order.intentId, payer: authorization.payer },
      });
    }
    const facilitatorVerified = Boolean(
      verify.isValid && verify.payer && getAddress(verify.payer) === authorization.payer,
    );
    await this.journal.recordVerify(order.orderId, canonicalHash(verify), facilitatorVerified);
    if (!facilitatorVerified) {
      order = await this.store.transition(order, "VERIFY_REJECTED", "facilitator_verify_rejected");
      await this.store.releaseCapacity(order.orderId);
      throw standardRailError("FACILITATOR_REJECTED", {
        phase: "facilitator_verify",
        logContext: {
          orderId: order.orderId,
          intentId: order.intentId,
          payer: authorization.payer,
          facilitatorSummary: {
            isValid: verify.isValid,
            invalidReason: verify.invalidReason,
          },
        },
      });
    }
    order = await this.store.transition(order, "VERIFIED", "facilitator_verified");
    // The verified order is durable. When another purchase already holds
    // this listing's settlement lock the request answers with the VERIFIED
    // order at once; the recovery worker settles it when the listing frees.
    const settled = await this.store.tryWithListingSettlementLock(order.listingManifestHash, async () => {
      if (!await this.store.listingSettlementAvailable(order.listingManifestHash, order.orderId)) {
        return order;
      }
      // From here the verified authorization is recovery's to settle. A
      // failure in these pre-settlement checks must never tell the client to
      // sign again (a LISTING_SUPERSEDED 409 or a plain 500 did), because the
      // fresh signature would settle beside the original one.
      const consumedBeforeEgress = await this.reconcileInsteadOfResigning(order, authorization.payer, async () => {
        await this.screenParticipants(listing, authorization.payer);
        await this.verifyListingIdentity(listing);
        return this.evidence.authorizationUsed(
          getAddress(listing.commitment.payload.canonicalToken),
          authorization.payer,
          authorization.nonce,
        );
      });
      if (consumedBeforeEgress) {
        order = await this.store.transition(
          order,
          "EXTERNAL_OR_UNPROVEN_DEPOSIT",
          "authorization_consumed_before_facilitator_egress",
        );
        return order;
      }
      const mayInvokeFacilitator = await this.journal.markSettleInvoked(order.orderId);
      order = await this.store.transition(order, "SETTLE_INVOKED", "settle_invocation_persisted");
      if (!mayInvokeFacilitator) {
        order = await this.store.transition(order, "SETTLEMENT_AMBIGUOUS", "settle_invocation_outcome_unknown");
        return order;
      }
      let settlement;
      try {
        settlement = await this.withRailFence(() => this.facilitator.settle(args.payment, requirements));
      } catch (error) {
        order = await this.store
          .transition(order, "SETTLEMENT_AMBIGUOUS", "settle_response_unknown")
          .catch(() => order);
        throw standardRailError("PAYMENT_PENDING_RECONCILIATION", {
          cause: error,
          logContext: {
            orderId: order.orderId,
            intentId: order.intentId,
            payer: authorization.payer,
          },
        });
      }
      try {
        if (
          !settlement.success || !/^0x[0-9a-fA-F]{64}$/.test(settlement.transaction) ||
          !settlement.payer || getAddress(settlement.payer) !== authorization.payer ||
          settlement.network !== this.appConfig.x402Network
        ) {
          order = await this.store.transition(order, "SETTLEMENT_FAILED", "facilitator_settlement_failed");
          throw standardRailError("FACILITATOR_REJECTED", {
            phase: "facilitator_settle",
            paymentMayHaveSettled: true,
            requiresNewSignature: false,
            logContext: {
              orderId: order.orderId,
              intentId: order.intentId,
              payer: authorization.payer,
              facilitatorSummary: {
                success: settlement.success,
                errorReason: settlement.errorReason,
                network: settlement.network,
                hasTransaction: /^0x[0-9a-fA-F]{64}$/.test(settlement.transaction),
              },
            },
          });
        }
        const transactionHash = settlement.transaction as Hex;
        await this.journal.recordSettlement(order.orderId, canonicalHash(settlement), transactionHash);
        order = await this.store.transition(order, "FACILITATOR_CONFIRMED", "facilitator_settlement_confirmed", { settlementTxHash: transactionHash });
        const deposit = await this.evidence.proveDeposit({
          order,
          listing,
          transactionHash,
          paymentNonce: authorization.nonce,
        });
        await this.journal.recordEvidence(order.orderId, "deposit", deposit, this.appConfig.chainId);
        order = await this.store.transition(order, "DEPOSIT_FINAL", "deposit_evidence_final", { depositEvidenceHash: deposit.evidenceHash });
        const release = await this.withRailFence(() =>
          this.evidence.releaseAndProve({ order, listing, deposit }));
        await this.journal.recordEvidence(order.orderId, "release", release, this.appConfig.chainId);
        const reputation = await buildReputationRegistration({
          order,
          listing,
          deposit,
          releaseEvidenceHash: release.evidenceHash,
          config: this.railConfig,
          chainId: this.appConfig.chainId,
          marketplaceContracts: this.appConfig.marketplaceContracts,
          evidence: this.evidence,
        });
        order = await this.store.transition(order, "RELEASE_FINAL", "release_evidence_final", {
          releaseTxHash: release.transactionHash,
          releaseEvidenceHash: release.evidenceHash,
          providerNetAmount: release.providerNetAmount.toString(),
          daskiCommissionAmount: release.daskiCommissionAmount.toString(),
          encryptedPaymentPayload: null,
        }, {
          kind: "register",
          logicalKey: order.orderKey,
          ...reputation,
        });
        order = await this.dispatch(
          order,
          listing,
          args.body,
          canonicalHash(settlement),
          { deposit, release },
        );
        return order;
      } catch (error) {
        const classified = asStandardRailError(error);
        if (classified?.paymentMayHaveSettled) throw classified;
        throw standardRailError("PAYMENT_PENDING_RECONCILIATION", {
          internalMessage: error instanceof Error
            ? `Post-settlement processing failed: ${error.message}`
            : "Post-settlement processing failed",
          cause: error,
          logContext: {
            orderId: order.orderId,
            intentId: order.intentId,
            payer: authorization.payer,
            facilitatorSummary: { success: settlement.success },
          },
        });
      }
    });
    return settled.acquired ? settled.result : order;
  }

  // Runs a pre-settlement check for an order whose signed authorization is
  // durably claimed and verified. Any failure is answered as
  // PAYMENT_PENDING_RECONCILIATION: the recovery worker will settle that
  // authorization, so the only safe client advice is to reconcile by payment
  // identifier and never to sign a second one.
  private async reconcileInsteadOfResigning<T>(
    order: StandardOrderRecord,
    payer: Hex,
    check: () => Promise<T>,
  ): Promise<T> {
    try {
      return await check();
    } catch (error) {
      const classified = asStandardRailError(error);
      if (classified?.paymentMayHaveSettled) throw classified;
      throw standardRailError("PAYMENT_PENDING_RECONCILIATION", {
        internalMessage: error instanceof Error
          ? `Pre-settlement check failed after verification: ${error.message}`
          : "Pre-settlement check failed after verification",
        cause: error,
        logContext: { orderId: order.orderId, intentId: order.intentId, payer },
      });
    }
  }

  private dispatch(
    order: StandardOrderRecord,
    listing: StandardListing,
    request: unknown,
    confirmationHash: Hex,
    evidenceBundle: { deposit: EvidenceResult; release: ReleaseEvidenceResult },
  ): Promise<StandardOrderRecord> {
    return this.dispatcher.dispatch(order, listing, request, confirmationHash, evidenceBundle);
  }

  private challengeResponse(
    listing: StandardListing,
    order: StandardOrderRecord,
    handle: string,
    payerAddress?: Hex,
  ) {
    const requirements = paymentRequirements(
      this.appConfig,
      listing,
      order.grossAmount,
      this.orderPaymentTimeout(order),
    );
    return {
      handle,
      order,
      paymentRequired: paymentRequired({
        config: this.appConfig,
        requirements,
        listing,
        order,
        railProfileHash: this.railProfileHash,
        ...(payerAddress ? { payerAddress: getAddress(payerAddress) } : {}),
      }),
    };
  }

  private orderPaymentTimeout(order: StandardOrderRecord): number {
    return Math.max(
      1,
      Math.floor((order.expiresAt.getTime() - order.createdAt.getTime()) / 1_000),
    );
  }

  private async resolveGrossAmount(
    listing: StandardListing,
    body: unknown,
  ): Promise<{
    grossAmount: string;
    providerQuoteHash: Hex;
    issuedAt: number;
    validBefore: number;
  }> {
    const offer = listing.offer.payload;
    const now = Math.floor(Date.now() / 1_000);
    if (offer.pricingMode === "fixed" && /^[1-9][0-9]*$/.test(offer.fixedGrossAmount)) {
      return {
        grossAmount: offer.fixedGrossAmount,
        providerQuoteHash: `0x${"00".repeat(32)}`,
        issuedAt: now,
        validBefore: now + listing.deadlinePolicy.draftSeconds,
      };
    }
    const requestHash = canonicalHash(body);
    const quoteRequest = await signEnvelope({
      artifactType: "ProviderQuoteRequestV1",
      environment: this.railConfig.environment,
      chainId: this.appConfig.chainId,
      audience: listing.providerControlProfile.payload.providerAudience,
      signerKeyId: "gateway-dispatch",
      privateKey: this.railConfig.dispatchPrivateKey,
      issuedAt: now,
      validBefore: now + 60,
      payload: {
        outcomeId: listing.commitment.payload.outcomeId,
        listingManifestHash: listing.runtimeCommitmentHash,
        requestHash,
        request: body,
      },
    });
    const response = await this.providerFetch(listing, listing.providerControlProfile.payload.quoteUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: quoteRequest }),
      redirect: "error",
      signal: AbortSignal.timeout(Math.min(
        this.railConfig.dispatchTimeoutMs,
        listing.providerControlProfile.payload.timeoutMs,
      )),
    }, true);
    if (!response.ok) {
      // Only a 4xx carries a structured rejection worth reading; every other
      // failure body is released so the pinned socket closes.
      if (response.status < 400 || response.status >= 500) await discardResponseBody(response);
      if (response.status >= 400 && response.status < 500) {
        let fieldErrors: Array<{
          path: string;
          rule: string;
          message: string;
          allowedValues?: readonly string[];
        }> | undefined;
        try {
          const rejection = await readBoundedJson(
            response,
            Math.min(32_768, listing.providerControlProfile.payload.maxResponseBytes),
          ) as { fieldErrors?: unknown };
          if (Array.isArray(rejection.fieldErrors)) {
            fieldErrors = rejection.fieldErrors.slice(0, 32).flatMap((item) => {
              if (!item || typeof item !== "object" || Array.isArray(item)) return [];
              const value = item as Record<string, unknown>;
              if (typeof value.path !== "string" || typeof value.rule !== "string" ||
                  typeof value.message !== "string") return [];
              const allowedValues = Array.isArray(value.allowedValues) &&
                value.allowedValues.every((entry) => typeof entry === "string")
                ? value.allowedValues as string[]
                : undefined;
              return [{
                path: value.path,
                rule: value.rule,
                message: value.message,
                ...(allowedValues ? { allowedValues } : {}),
              }];
            });
          }
        } catch {
          // A structured rejection body is optional; status remains authoritative.
        }
        throw standardRailError("PROVIDER_QUOTE_REJECTED", {
          fieldErrors,
          logContext: {
            providerAgentId: listing.commitment.payload.providerAgentId,
            outcomeId: listing.commitment.payload.outcomeId,
            canonicalRequestHash: requestHash,
            providerStatus: response.status,
          },
        });
      }
      throw standardRailError("PROVIDER_QUOTE_UNAVAILABLE", {
        logContext: {
          providerAgentId: listing.commitment.payload.providerAgentId,
          outcomeId: listing.commitment.payload.outcomeId,
          canonicalRequestHash: requestHash,
          providerStatus: response.status,
        },
      });
    }
    const quote = await readBoundedJson(
      response,
      listing.providerControlProfile.payload.maxResponseBytes,
    ) as {
      outcomeId?: unknown;
      listingManifestHash?: unknown;
      requestHash?: unknown;
      grossAmount?: unknown;
      issuedAt?: unknown;
      validBefore?: unknown;
      signature?: unknown;
    };
    assertExactKeys(
      quote,
      ["outcomeId", "listingManifestHash", "requestHash", "grossAmount", "issuedAt", "validBefore", "signature"],
      "provider quote response",
    );
    if (
      quote.outcomeId !== listing.commitment.payload.outcomeId ||
      quote.listingManifestHash !== listing.runtimeCommitmentHash ||
      quote.requestHash !== requestHash || typeof quote.grossAmount !== "string" ||
      !/^[1-9][0-9]*$/.test(quote.grossAmount) || typeof quote.issuedAt !== "number" ||
      !Number.isSafeInteger(quote.issuedAt) || typeof quote.validBefore !== "number" ||
      !Number.isSafeInteger(quote.validBefore) || quote.issuedAt > now + 30 || quote.issuedAt < now - 30 ||
      quote.validBefore <= now + Math.max(
        listing.deadlinePolicy.minimumPaymentWindowSeconds,
        listing.quotePolicy?.minimumPaymentWindowSeconds ?? 0,
      ) ||
      !listing.quotePolicy ||
      quote.validBefore > quote.issuedAt + listing.quotePolicy.maximumLifetimeSeconds ||
      typeof quote.signature !== "string"
    ) throw standardRailError("PROVIDER_QUOTE_UNAVAILABLE");
    const bps = BigInt(listing.commitment.payload.commissionBps);
    const minimumReleasableAmount = (10_000n + bps - 1n) / bps;
    if (BigInt(quote.grossAmount) < minimumReleasableAmount) {
      throw standardRailError("PROVIDER_QUOTE_UNAVAILABLE");
    }
    const signature = quote.signature as Hex;
    const quoteHash = canonicalHash({
      outcomeId: quote.outcomeId,
      listingManifestHash: quote.listingManifestHash,
      requestHash: quote.requestHash,
      grossAmount: quote.grossAmount,
      issuedAt: quote.issuedAt,
      validBefore: quote.validBefore,
    });
    const signer = await recoverMessageAddress({ message: { raw: quoteHash }, signature });
    if (getAddress(signer) !== getAddress(listing.commitment.payload.providerAuthorityKey)) {
      throw standardRailError("PROVIDER_QUOTE_UNAVAILABLE");
    }
    return {
      grossAmount: quote.grossAmount,
      providerQuoteHash: quoteHash,
      issuedAt: quote.issuedAt,
      validBefore: quote.validBefore,
    };
  }

  private assertRailFence(): Promise<void> {
    return this.store.assertActiveRail(this.railProfileHash);
  }

  private validateRequest(listing: StandardListing, body: unknown): Promise<void> {
    return this.catalog.validateRequest(listing, body);
  }

  private validateResponse(listing: StandardListing, result: unknown): Promise<void> {
    return this.catalog.validateResponse(listing, result);
  }

  private screenParticipants(listing: StandardListing, payer?: Hex): Promise<void> {
    const commitment = listing.commitment.payload;
    return this.evidence.assertNotSanctioned(
      getAddress(listing.screeningPolicy.sanctionsOracle),
      listing.screeningPolicy.sanctionsOracleRuntimeCodeHash,
      [
        commitment.providerAuthorityKey,
        commitment.providerTerminalAttestationKey,
        commitment.providerPayee,
        commitment.daskiCommissionReceiver,
        listing.manifest.payload.splitterAddress,
        ...listing.screeningPolicy.providerControlledWallets,
        ...(payer ? [payer] : []),
      ].map(getAddress),
    );
  }

  private withRailFence<T>(work: () => Promise<T>): Promise<T> {
    return this.store.withRailFence({
      environment: this.railConfig.environment,
      chainId: this.appConfig.chainId,
      railProfileHash: this.railProfileHash,
    }, work);
  }

}
