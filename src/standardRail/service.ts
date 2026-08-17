import { createHmac, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import type { ValidateFunction } from "ajv";
import type { PaymentPayload } from "@x402/core/types";
import {
  getAddress,
  keccak256,
  recoverMessageAddress,
  stringToHex,
  verifyTypedData,
  type Hex,
} from "viem";
import type { Config } from "../config.js";
import type { Pool } from "../db/pool.js";
import { assertNoDuplicateJsonKeys, canonicalHash, providerIdentitySnapshotHash } from "./canonical.js";
import type { StandardRailConfig } from "./config.js";
import type { StandardChainEvidence } from "./evidence.js";
import { createPinnedLookup, type StandardFacilitator } from "./facilitator.js";
import { StandardRailJournal } from "./journal.js";
import {
  paymentRequired,
  paymentAuthorizationLookupKey,
  paymentRequirements,
  validatePayment,
} from "./payment.js";
import { decryptPaymentPayload, encryptPaymentPayload } from "./secrets.js";
import { signEnvelope } from "./signing.js";
import { StandardRailStore } from "./store.js";
import type {
  QuoteV1,
  DispatchStatusQueryV1,
  StandardListing,
  StandardOrderRecord,
  StandardRailDispatchV1,
} from "./types.js";
import { verifyStandardRailManifest } from "./artifacts.js";
import { StandardRailRecoveryWorker } from "./recovery.js";
import { StandardRailIncidentStore } from "./incidents.js";
import {
  assertSchema,
  compileClosedRequestSchema,
  compileClosedResponseSchema,
} from "./schema.js";
import { isNonPublicAddress } from "./network.js";
import { assertPassiveProviderOutput } from "./providerOutput.js";
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
import type { MarketplaceChainReader } from "../marketplace/reader.js";
import {
  AdmittedServiceResolver,
  type ServicePresentation,
} from "../marketplace/servicePresentation.js";

interface OperationalSummary {
  pending: number;
  attention: number;
  aborted: number;
  blocked: number;
  exhausted: number;
  oldest_pending_seconds: number;
}

interface GroupCount { key: string; count: number }

function keyedCounts(rows: GroupCount[]): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.key, row.count]));
}

const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;

export function isAdmissionWindowOpen(
  railValidBefore: number,
  facilitatorValidBefore: number,
  nowSeconds = Math.floor(Date.now() / 1_000),
): boolean {
  return nowSeconds < Math.min(railValidBefore, facilitatorValidBefore);
}

function assertExactKeys(value: unknown, expected: readonly string[], label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new Error(`${label} fields are invalid`);
  }
}

export async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
  if (mediaType !== "application/json" || (encoding && encoding !== "identity")) {
    throw new Error("PROVIDER_RESPONSE_MEDIA_TYPE_INVALID");
  }
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    throw new Error("PROVIDER_RESPONSE_TOO_LARGE");
  }
  if (!response.body) throw new Error("PROVIDER_RESPONSE_EMPTY");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("PROVIDER_RESPONSE_TOO_LARGE");
    }
    chunks.push(next.value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(joined);
  assertNoDuplicateJsonKeys(text);
  return JSON.parse(text);
}

export async function assertPublicProviderEndpoint(profileOrigin: string, endpoint: string): Promise<void> {
  const origin = new URL(profileOrigin);
  const target = new URL(endpoint);
  if (target.origin !== origin.origin) throw new Error("PROVIDER_ENDPOINT_ORIGIN_MISMATCH");
  const addresses = isIP(target.hostname)
    ? [{ address: target.hostname }]
    : await lookup(target.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isNonPublicAddress(address))) {
    throw new Error("PROVIDER_ENDPOINT_DNS_REJECTED");
  }
}

export async function pinnedProviderFetch(
  endpoint: string,
  init: RequestInit,
  addresses: Array<{ address: string; family?: number }>,
): Promise<Response> {
  if (init.body !== undefined && typeof init.body !== "string") {
    throw new Error("PROVIDER_REQUEST_BODY_INVALID");
  }
  const selected = addresses[0];
  if (!selected) throw new Error("PROVIDER_ENDPOINT_DNS_REJECTED");
  return new Promise<Response>((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const request = httpsRequest(endpoint, {
      method: init.method,
      headers,
      signal: init.signal ?? undefined,
      lookup: createPinnedLookup({
        address: selected.address,
        family: selected.family === 6 ? 6 : 4,
      }),
    }, (incoming) => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
          responseHeaders.append(name, String(item));
        }
      }
      resolve(new Response(Readable.toWeb(incoming) as ReadableStream, {
        status: incoming.statusCode ?? 500,
        statusText: incoming.statusMessage,
        headers: responseHeaders,
      }));
    });
    request.once("error", reject);
    if (init.body !== undefined) request.write(init.body);
    request.end();
  });
}

export class StandardRailService {
  private readonly store: StandardRailStore;
  private readonly journal: StandardRailJournal;
  private readonly listings = new Map<string, StandardListing>();
  private readonly requestValidators = new Map<string, ValidateFunction>();
  private readonly responseValidators = new Map<string, ValidateFunction>();
  private readonly publicArtifacts = new Map<Hex, import("./types.js").SignedEnvelope<unknown>>();
  private readonly recovery: StandardRailRecoveryWorker;
  private readonly incidents: StandardRailIncidentStore;
  private readonly walletStore: StandardWalletStore;
  private readonly walletQueries: StandardWalletQueries;
  private readonly assetFederation: StandardAssetFederation;
  private readonly assetActions: StandardAssetActions;
  private readonly reputationWorker: StandardReputationWorker;
  private readonly confirmations: StandardConfirmations;
  private readonly reputationReader: DirectReputationReader;
  private readonly serviceResolver: AdmittedServiceResolver;
  private dependenciesReady = false;
  private readinessInterval: NodeJS.Timeout | null = null;
  private readinessRefresh: Promise<void> | null = null;
  readonly railProfileHash: Hex;

  constructor(
    private readonly appConfig: Config,
    private readonly railConfig: StandardRailConfig,
    private readonly pool: Pool,
    private readonly facilitator: StandardFacilitator,
    private readonly evidence: StandardChainEvidence,
    marketplace: MarketplaceChainReader,
    private readonly fetchFn: typeof fetch = fetch,
    federationPermitPool: Pool = pool,
  ) {
    this.store = new StandardRailStore(pool);
    this.incidents = new StandardRailIncidentStore(pool);
    this.journal = new StandardRailJournal(pool);
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
    );
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
    this.serviceResolver = new AdmittedServiceResolver(
      marketplace,
      async (listing, endpoint) => {
        const response = await this.providerFetch(listing, endpoint, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(listing.providerControlProfile.payload.timeoutMs),
        });
        if (!response.ok) throw new Error("PROVIDER_AGENT_CARD_UNAVAILABLE");
        return readBoundedJson(
          response,
          Math.min(256_000, listing.providerControlProfile.payload.maxResponseBytes),
        );
      },
    );
    this.railProfileHash = canonicalHash(railConfig.manifest.activeRailProfile);
    for (const artifact of [
      railConfig.manifest.facilitatorProfile,
      railConfig.manifest.railCapabilityRequirements,
      railConfig.manifest.activeRailProfile,
      railConfig.manifest.chainEvidencePolicy,
      ...railConfig.manifest.providerIdentitySnapshots,
      ...railConfig.manifest.servicingAdmissions,
      ...railConfig.manifest.actionCatalogs,
      ...railConfig.manifest.listings.flatMap((listing) => [
        listing.commitment,
        listing.manifest,
        listing.offer,
        listing.providerControlProfile,
      ]),
    ]) {
      this.publicArtifacts.set(canonicalHash(artifact), artifact as import("./types.js").SignedEnvelope<unknown>);
    }
    for (const listing of railConfig.manifest.listings) {
      const payload = listing.commitment.payload;
      const key = `${payload.providerAgentId}:${payload.outcomeId}`;
      this.listings.set(key, listing);
      this.requestValidators.set(key, compileClosedRequestSchema(listing.requestSchema));
      this.responseValidators.set(key, compileClosedResponseSchema(listing.responseSchema));
    }
    this.recovery = new StandardRailRecoveryWorker({
      config: railConfig,
      store: this.store,
      resumePaid: async (order) => { await this.resumePaidOrder(order); },
      cleanup: async () => {
        await this.journal.cleanupExpiredActionAuthorizations();
        await this.walletStore.cleanupExpiredAuthorizations();
      },
    });
  }

  async initialize(): Promise<void> {
    await verifyStandardRailManifest(this.railConfig.manifest, {
      environment: this.railConfig.environment,
      chainId: this.appConfig.chainId,
      gatewayAudience: this.railConfig.gatewayAudience,
      signers: this.railConfig.trustedSigners,
      launchOutcomeIds: this.railConfig.launchOutcomeIds,
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
    for (const listing of this.railConfig.manifest.listings) {
      await this.evidence.verifyListingDeployment(listing, this.appConfig.chainId);
    }
    for (const snapshot of this.railConfig.manifest.providerIdentitySnapshots) {
      if (
        getAddress(snapshot.payload.identityRegistry) !== getAddress(this.appConfig.marketplaceContracts.identityRegistry) ||
        getAddress(snapshot.payload.providerRegistry) !== getAddress(this.appConfig.marketplaceContracts.providerRegistry) ||
        getAddress(snapshot.payload.serviceRegistry) !== getAddress(this.appConfig.marketplaceContracts.serviceRegistry)
      ) throw new Error("Provider identity snapshot registry domain mismatch");
      await this.evidence.verifyProviderIdentitySnapshot(snapshot.payload);
    }
    await this.store.admitManifest(this.railConfig.manifest);
    await this.assetFederation.activateAdmissions();
    await this.refreshDependencyReadiness();
    this.recovery.start();
    this.reputationWorker.start();
    this.readinessInterval = setInterval(() => {
      void this.refreshDependencyReadiness().catch(() => undefined);
    }, 30_000);
    this.readinessInterval.unref();
  }

  async stop(): Promise<void> {
    if (this.readinessInterval) clearInterval(this.readinessInterval);
    this.readinessInterval = null;
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

  async operationalHealth() {
    const [operations, operationCauses, oldestByKind, transactionStates, relayer] = await Promise.all([
      this.pool.query<OperationalSummary>(
        `SELECT count(*) FILTER (WHERE state IN ('pending','broadcast'))::int AS pending,
                count(*) FILTER (WHERE state='operator_attention')::int AS attention,
                count(*) FILTER (WHERE state='aborted_unattested')::int AS aborted,
                count(*) FILTER (WHERE state='blocked_parent_aborted')::int AS blocked,
                count(*) FILTER (WHERE state='operator_attention' AND attempts>=5)::int AS exhausted,
                COALESCE(extract(epoch FROM now()-min(created_at) FILTER
                  (WHERE state IN ('pending','broadcast'))),0)::int AS oldest_pending_seconds
           FROM standard_reputation_operations`,
      ),
      this.pool.query<GroupCount>(
        `SELECT last_error_class AS key,count(*)::int AS count
           FROM standard_reputation_operations WHERE last_error_class IS NOT NULL
          GROUP BY last_error_class`,
      ),
      this.pool.query<{ key: string; oldest_pending_seconds: number }>(
        `SELECT kind AS key,COALESCE(extract(epoch FROM now()-min(created_at)),0)::int
                  AS oldest_pending_seconds
           FROM standard_reputation_operations WHERE state IN ('pending','broadcast') GROUP BY kind`,
      ),
      this.pool.query<GroupCount>(
        `SELECT state AS key,count(*)::int AS count FROM standard_reputation_transactions
          WHERE state IN ('prepared','broadcast','operator_attention') GROUP BY state`,
      ),
      this.reputationWorker.accountHealth(),
    ]);
    return {
      reputation: {
        ...operations.rows[0],
        causes: keyedCounts(operationCauses.rows),
        oldestPendingSecondsByKind: Object.fromEntries(oldestByKind.rows.map(
          (row) => [row.key, row.oldest_pending_seconds],
        )),
        transactionStates: keyedCounts(transactionStates.rows),
        relayer,
      },
    };
  }

  publicArtifact(hash: string): import("./types.js").SignedEnvelope<unknown> | null {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return null;
    return this.publicArtifacts.get(hash.toLowerCase() as Hex) ?? null;
  }

  private refreshDependencyReadiness(): Promise<void> {
    if (this.readinessRefresh) return this.readinessRefresh;
    this.readinessRefresh = (async () => {
      try {
        await this.assertRailFence();
        await this.facilitator.assertSupported(this.appConfig.x402Network);
        await this.evidence.verifyCanonicalToken(this.appConfig.chainId);
        await Promise.all(this.railConfig.manifest.listings.map(
          async (listing) => {
            await this.evidence.verifyScreeningPolicy(listing);
            await this.screenParticipants(listing);
          },
        ));
        this.dependenciesReady = true;
      } catch (error) {
        this.dependenciesReady = false;
        throw error;
      } finally {
        this.readinessRefresh = null;
      }
    })();
    return this.readinessRefresh;
  }

  private assertAdmissionOpen(): void {
    if (!this.isAdmissionOpen()) throw new Error("STANDARD_RAIL_ADMISSION_EXPIRED");
  }

  private async providerFetch(
    listing: StandardListing,
    endpoint: string,
    init: RequestInit,
  ): Promise<Response> {
    return this.withRailFence(async () => {
      await assertPublicProviderEndpoint(listing.providerControlProfile.payload.origin, endpoint);
      if (this.fetchFn !== fetch) return this.fetchFn(endpoint, init);
      const hostname = new URL(endpoint).hostname;
      const addresses = isIP(hostname)
        ? [{ address: hostname, family: isIP(hostname) }]
        : await lookup(hostname, { all: true, verbatim: true });
      if (addresses.length === 0 || addresses.some(({ address }) => isNonPublicAddress(address))) {
        throw new Error("PROVIDER_ENDPOINT_DNS_REJECTED");
      }
      return pinnedProviderFetch(endpoint, init, addresses);
    });
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
    await this.store.withListingSettlementLock(initial.listingManifestHash, async () => {
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
          const response = await this.queryProviderDispatchStatus(
            listing,
            order.orderId,
            canonicalHash(claim.dispatch),
          );
          order = await this.applyDispatchResponse(
            order,
            listing,
            canonicalHash(claim.dispatch),
            response,
          );
          if (["FULFILLED", "PROVIDER_FAILED"].includes(order.state)) return;
        } catch (error) {
          if (Date.now() < resolvedAt.getTime() + listing.deadlinePolicy.fulfillmentSeconds * 1_000) {
            throw error;
          }
        }
        if (Date.now() >= resolvedAt.getTime() + listing.deadlinePolicy.fulfillmentSeconds * 1_000) {
          await this.store.transition(order, "PROVIDER_FAILED", "signed_provider_deadline_elapsed");
          await this.store.releaseCapacity(order.orderId);
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
        if (order.state !== "EXTERNAL_OR_UNPROVEN_DEPOSIT") {
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
                payment: this.storedPayment(order),
              });
              await this.journal.recordEvidence(
                order.orderId,
                "deposit",
                externalDeposit,
                this.appConfig.chainId,
              );
              order = await this.store.transition(
                order,
                "EXTERNAL_OR_UNPROVEN_DEPOSIT",
                "exact_deposit_without_authenticated_facilitator_success",
                {
                  settlementTxHash: transactionHash,
                  depositEvidenceHash: externalDeposit.evidenceHash,
                },
              );
            } catch (error) {
              if (Date.now() < order.updatedAt.getTime() +
                listing.deadlinePolicy.settlementEvidenceSeconds * 1_000) throw error;
              await this.store.transition(order, "LEGAL_HOLD", "unproven_external_deposit_evidence_deadline", {
                encryptedPaymentPayload: null,
              });
              await this.store.releaseCapacity(order.orderId);
              return;
            }
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
              await this.store.releaseCapacity(order.orderId);
              return;
            }
            await this.store.transition(order, "NOT_SETTLED", "independent_chain_observation_no_capture", {
              encryptedPaymentPayload: null,
            });
            await this.store.releaseCapacity(order.orderId);
            return;
          }
        }
        if (order.state === "EXTERNAL_OR_UNPROVEN_DEPOSIT") {
          if (Date.now() < order.updatedAt.getTime() +
            listing.deadlinePolicy.settlementEvidenceSeconds * 1_000) {
            throw new Error("External deposit awaits authenticated facilitator evidence");
          }
          await this.store.transition(order, "LEGAL_HOLD", "facilitator_attestation_deadline_elapsed", {
            encryptedPaymentPayload: null,
          });
          await this.store.releaseCapacity(order.orderId);
          return;
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
            payment: this.storedPayment(order),
          });
        } catch (error) {
          if (Date.now() < order.updatedAt.getTime() + listing.deadlinePolicy.settlementEvidenceSeconds * 1_000) throw error;
          await this.store.transition(order, "LEGAL_HOLD", "signed_deposit_evidence_deadline_elapsed", {
            encryptedPaymentPayload: null,
          });
          await this.store.releaseCapacity(order.orderId);
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
          await this.store.releaseCapacity(order.orderId);
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

  listing(providerAgentId: string, outcomeId: string): StandardListing {
    const listing = this.listings.get(`${providerAgentId}:${outcomeId}`);
    if (!listing) throw new Error("OUTCOME_NOT_FOUND");
    return listing;
  }

  private async verifyListingIdentity(listing: StandardListing): Promise<void> {
    const snapshot = this.railConfig.manifest.providerIdentitySnapshots.find((item) =>
      providerIdentitySnapshotHash(item.payload, this.appConfig.chainId) ===
        listing.commitment.payload.providerIdentitySnapshotHash
    );
    if (!snapshot) throw new Error("LISTING_IDENTITY_SNAPSHOT_UNAVAILABLE");
    await this.evidence.revalidateProviderIdentitySnapshot(snapshot.payload);
  }

  listOutcomes(): Array<Record<string, unknown>> {
    const emptyReputation = {
      transactionCount: "0",
      completedCount: "0",
      failedCount: "0",
      canceledCount: "0",
      completionSampleSize: "0",
      completionRate: null,
      confirmedCount: "0",
      notConfirmedCount: "0",
      confirmationSampleSize: "0",
      buyerSatisfactionRate: null,
      valueWeightedBuyerSatisfactionRate: null,
      totalPaid: "0",
      totalRefunded: "0",
      averageFulfillmentSeconds: null,
      fulfillmentSampleSize: "0",
      recentPurchases: [],
      safeBlock: null,
    };
    return [...this.listings.values()].map((listing) => ({
      providerAgentId: listing.commitment.payload.providerAgentId,
      serviceId: listing.commitment.payload.serviceId,
      outcomeId: listing.commitment.payload.outcomeId,
      skillId: listing.offer.payload.skillId,
      ...listing.discovery,
      bindingProfile: listing.commitment.payload.bindingProfile,
      pricingMode: listing.offer.payload.pricingMode,
      fixedGrossAmount: listing.offer.payload.fixedGrossAmount,
      token: listing.commitment.payload.canonicalToken,
      payTo: listing.manifest.payload.splitterAddress,
      splitterDeploymentBlockNumber: listing.manifest.payload.splitterDeploymentBlockNumber,
      providerPayee: listing.commitment.payload.providerPayee,
      daskiCommissionReceiver: listing.commitment.payload.daskiCommissionReceiver,
      commissionBps: listing.commitment.payload.commissionBps,
      providerAudience: listing.providerControlProfile.payload.providerAudience,
      absoluteResourceUri: listing.commitment.payload.absoluteResourceUri,
      listingManifestHash: canonicalHash(listing.manifest),
      providerOfferHash: canonicalHash(listing.offer),
      terms: listing.terms,
      deadlinePolicy: listing.deadlinePolicy,
      capacityPolicy: listing.capacityPolicy,
      providerReputation: emptyReputation,
      serviceReputation: emptyReputation,
      reputation: emptyReputation,
    }));
  }

  async publicOutcomes(): Promise<Array<Record<string, unknown>>> {
    const outcomes: Array<Record<string, unknown>> = await Promise.all(
      this.listOutcomes().map(async (outcome): Promise<Record<string, unknown>> => {
        const listing = this.listing(String(outcome.providerAgentId), String(outcome.outcomeId));
        return { ...outcome, ...await this.serviceResolver.resolve(listing) };
      }),
    );
    let snapshot;
    try {
      snapshot = await this.reputationReader.forOutcomes(outcomes);
    } catch {
      return outcomes;
    }
    const { providers, services, safeBlock } = snapshot;
    return outcomes.map((outcome) => ({
      ...outcome,
      providerReputation: providers.get(String(outcome.providerAgentId)) ??
        { ...(outcome.providerReputation as object), safeBlock },
      serviceReputation: services.get(outcome.serviceId as Hex) ??
        { ...(outcome.serviceReputation as object), safeBlock },
      reputation: services.get(outcome.serviceId as Hex) ??
        { ...(outcome.reputation as object), safeBlock },
    }));
  }

  async searchOutcomes(filters: {
    text?: string;
    providerAgentId?: string;
    categoryFamily?: string;
    serviceType?: string;
    jurisdiction?: string;
    pricingMode?: "fixed" | "dynamic";
    persistentAsset?: boolean;
    limit: number;
  }): Promise<Array<Record<string, unknown>>> {
    const tokens = (filters.text ?? "").toLowerCase().match(/[a-z0-9]+/g)?.slice(0, 12) ?? [];
    return (await this.publicOutcomes()).filter((outcome) => {
      const row = outcome as Record<string, unknown>;
      const presentation = row as unknown as ServicePresentation;
      const haystack = [
        presentation.service.name,
        presentation.service.description,
        presentation.skill.name,
        presentation.skill.description,
        ...(row.tags as string[]),
      ]
        .join(" ").toLowerCase().match(/[a-z0-9]+/g) ?? [];
      return (
        tokens.every((token) => haystack.some((word) => word.includes(token))) &&
        (!filters.providerAgentId || row.providerAgentId === filters.providerAgentId) &&
        (!filters.categoryFamily || row.categoryFamily === filters.categoryFamily) &&
        (!filters.serviceType || row.serviceType === filters.serviceType) &&
        (!filters.jurisdiction || (row.jurisdictions as string[]).includes(filters.jurisdiction)) &&
        (!filters.pricingMode || row.pricingMode === filters.pricingMode) &&
        (filters.persistentAsset === undefined || row.persistentAsset === filters.persistentAsset)
      );
    }).sort((left, right) =>
      `${left.providerAgentId}:${left.outcomeId}`.localeCompare(`${right.providerAgentId}:${right.outcomeId}`)
    ).slice(0, filters.limit);
  }

  async getOutcome(providerAgentId: string, outcomeId: string): Promise<Record<string, unknown>> {
    const outcome = (await this.publicOutcomes()).find((item) =>
      item.providerAgentId === providerAgentId && item.outcomeId === outcomeId
    );
    if (!outcome) throw new Error("OUTCOME_NOT_FOUND");
    const listing = this.listing(providerAgentId, outcomeId);
    return {
      ...outcome,
      requestSchema: listing.requestSchema,
      responseSchema: listing.responseSchema,
      artifacts: {
        commitment: canonicalHash(listing.commitment),
        manifest: canonicalHash(listing.manifest),
        offer: canonicalHash(listing.offer),
      },
    };
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
    const existing = await this.store.loadReceipt(order.orderId);
    if (existing) return existing;
    if (
      !order.payer || !order.providerNetAmount || !order.daskiCommissionAmount ||
      !order.settlementTxHash || !order.depositEvidenceHash ||
      !order.releaseTxHash || !order.releaseEvidenceHash
    ) return null;
    const facilitatorConfirmationHash = await this.journal.settlementResponseHash(order.orderId);
    const now = Math.floor(Date.now() / 1_000);
    const receipt = await signEnvelope<Record<string, unknown>>({
      artifactType: "StandardRailReceiptV1",
      environment: this.railConfig.environment,
      chainId: this.appConfig.chainId,
      audience: order.payer ?? this.railConfig.gatewayAudience,
      signerKeyId: "gateway-receipt",
      privateKey: this.railConfig.receiptPrivateKey,
      issuedAt: now,
      validBefore: Math.floor(order.expiresAt.getTime() / 1_000) + 31_536_000,
      payload: {
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
        depositEvidenceHash: order.depositEvidenceHash,
        releaseTxHash: order.releaseTxHash,
        releaseEvidenceHash: order.releaseEvidenceHash,
      },
    });
    return this.store.persistReceipt(order.orderId, receipt);
  }

  async issueActionChallenge(args: {
    handle: string;
    action: "status" | "input" | "cancel" | "artifact" | "support" |
      "confirmation" | "revoke-confirmation";
    request: Record<string, unknown>;
    clientKey?: string;
  }): Promise<Record<string, unknown>> {
    await this.assertRailFence();
    const order = await this.store.findByHandle(args.handle);
    const now = Math.floor(Date.now() / 1_000);
    const validBefore = now + 300;
    const nonce = `0x${randomBytes(32).toString("hex")}` as Hex;
    const absoluteResourceUri = `${this.appConfig.publicUrl.replace(/\/$/, "")}/orders/${encodeURIComponent(args.handle)}/actions/${args.action}`;
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
    return {
      orderId,
      action: args.action,
      method: "POST",
      absoluteResourceUri,
      requestHash,
      nonce,
      issuedAt: now,
      validBefore,
    };
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
    action: "status" | "input" | "cancel" | "artifact" | "support" |
      "confirmation" | "revoke-confirmation";
    request: Record<string, unknown>;
    authorization: {
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
  }): Promise<unknown> {
    await this.assertRailFence();
    const order = await this.store.findByHandle(args.handle);
    if (!order || !order.payer) throw new Error("ORDER_NOT_FOUND");
    const now = Math.floor(Date.now() / 1_000);
    if (
      args.authorization.issuedAt > now + 30 ||
      args.authorization.validBefore <= now ||
      args.authorization.validBefore > now + 300
    ) throw new Error("ACTION_AUTHORIZATION_EXPIRED");
    const requestHash = canonicalHash(args.request);
    const expectedUri = `${this.appConfig.publicUrl.replace(/\/$/, "")}/orders/${encodeURIComponent(args.handle)}/actions/${args.action}`;
    if (
      args.authorization.orderId !== order.orderId || args.authorization.action !== args.action ||
      args.authorization.method !== "POST" || args.authorization.absoluteResourceUri !== expectedUri ||
      args.authorization.requestHash !== requestHash
    ) throw new Error("ACTION_AUTHORIZATION_BINDING_INVALID");
    const valid = await verifyTypedData({
      address: getAddress(order.payer),
      domain: { name: "DaskiStandardOrder", version: "1", chainId: this.appConfig.chainId },
      types: {
        OrderActionAuthorizationV1: [
          { name: "orderIdHash", type: "bytes32" },
          { name: "actionHash", type: "bytes32" },
          { name: "methodHash", type: "bytes32" },
          { name: "absoluteResourceUriHash", type: "bytes32" },
          { name: "requestHash", type: "bytes32" },
          { name: "audienceHash", type: "bytes32" },
          { name: "nonce", type: "bytes32" },
          { name: "issuedAt", type: "uint64" },
          { name: "validBefore", type: "uint64" },
        ],
      },
      primaryType: "OrderActionAuthorizationV1",
      message: {
        orderIdHash: keccak256(stringToHex(order.orderId)),
        actionHash: keccak256(stringToHex(args.action)),
        methodHash: keccak256(stringToHex(args.authorization.method)),
        absoluteResourceUriHash: keccak256(stringToHex(args.authorization.absoluteResourceUri)),
        requestHash,
        audienceHash: keccak256(stringToHex(this.railConfig.gatewayAudience)),
        nonce: args.authorization.nonce,
        issuedAt: BigInt(args.authorization.issuedAt),
        validBefore: BigInt(args.authorization.validBefore),
      },
      signature: args.authorization.signature,
    });
    if (!valid) throw new Error("ACTION_AUTHORIZATION_INVALID");
    if (args.action === "confirmation" || args.action === "revoke-confirmation") {
      await this.confirmations.assertReady(order);
    }
    try {
      await this.journal.consumeActionChallenge({
        orderId: order.orderId,
        action: args.action,
        requestHash,
        absoluteResourceUri: args.authorization.absoluteResourceUri,
        nonce: args.authorization.nonce,
        issuedAt: args.authorization.issuedAt,
        validBefore: args.authorization.validBefore,
        payerRate: ["confirmation", "revoke-confirmation"].includes(args.action)
          ? { scope: "wallet-state-change", maximum: this.railConfig.abuse.assetStateChangesPerPayerPerMinute }
          : undefined,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "ACTION_CHALLENGE_INVALID_OR_REPLAYED") {
        await this.incidents.record({
          kind: "action_authorization_reuse_or_tamper",
          orderId: order.orderId,
          state: order.state,
          details: { action: args.action, nonce: args.authorization.nonce },
        });
      }
      throw error;
    }
    if (args.action === "confirmation" || args.action === "revoke-confirmation") {
      return this.confirmations.handle(order, args.action, args.request);
    }
    if (args.action === "status" && !order.providerTaskId) {
      return { receipt: await this.signedReceipt(order) };
    }
    if (!order.providerTaskId) throw new Error("PROVIDER_TASK_NOT_AVAILABLE");
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
        authorizationHash: canonicalHash(args.authorization),
        payer: order.payer,
      },
    });
    const response = await this.providerFetch(listing, listing.providerControlProfile.payload.lifecycleUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orderId: order.orderId,
        providerTaskId: order.providerTaskId,
        action: args.action,
        request: args.request,
        authorization: args.authorization,
        grant: lifecycleGrant,
        payer: order.payer,
        gatewayAudience: this.railConfig.gatewayAudience,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(Math.min(
        this.railConfig.dispatchTimeoutMs,
        listing.providerControlProfile.payload.timeoutMs,
      )),
    });
    if (!response.ok) throw new Error("PROVIDER_LIFECYCLE_REJECTED");
    const providerResult = await readBoundedJson(
      response,
      listing.providerControlProfile.payload.maxResponseBytes,
    );
    return this.applyLifecycleResult(order, listing, providerResult, args.action);
  }

  private async applyLifecycleResult(
    initial: StandardOrderRecord,
    listing: StandardListing,
    result: unknown,
    action: "status" | "input" | "cancel" | "artifact" | "support",
  ): Promise<unknown> {
    if (!result || typeof result !== "object") throw new Error("PROVIDER_LIFECYCLE_RESPONSE_INVALID");
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
      throw new Error("PROVIDER_LIFECYCLE_BINDING_INVALID");
    }
    const { signature, ...signedResponse } = response;
    const authority = await recoverMessageAddress({
      message: { raw: canonicalHash(signedResponse) },
      signature: signature as Hex,
    });
    if (getAddress(authority) !== getAddress(listing.commitment.payload.providerAuthorityKey)) {
      throw new Error("PROVIDER_LIFECYCLE_SIGNATURE_INVALID");
    }
    if ((action === "status" || action === "support" || action === "cancel") && "result" in response) {
      throw new Error("PROVIDER_LIFECYCLE_UNEXPECTED_CONTENT");
    }
    if (action === "artifact" && !("result" in response)) {
      throw new Error("PROVIDER_ARTIFACT_MISSING");
    }
    if ("result" in response) this.validateResponse(listing, response.result);
    let order = initial;
    if (response.state === "input-required" && order.state === "DISPATCHED") {
      order = await this.store.transition(order, "INPUT_REQUIRED", "provider_input_required");
    } else if (response.state === "working" && order.state === "INPUT_REQUIRED") {
      order = await this.store.transition(order, "DISPATCHED", "provider_input_accepted");
    } else if (["completed", "failed", "canceled"].includes(String(response.state))) {
      const attestation = response.terminalAttestation;
      if (!attestation?.payload || typeof attestation.signature !== "string") {
        throw new Error("PROVIDER_TERMINAL_ATTESTATION_MISSING");
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
      ) throw new Error("PROVIDER_TERMINAL_ATTESTATION_TIME_INVALID");
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
      ) throw new Error("PROVIDER_TERMINAL_ATTESTATION_INVALID");
      if (response.state === "completed" && ["DISPATCHED", "INPUT_REQUIRED"].includes(order.state)) {
        order = await this.store.transition(order, "FULFILLED", "provider_terminal_completed");
      } else if (["failed", "canceled"].includes(String(response.state)) && ["DISPATCHED", "INPUT_REQUIRED"].includes(order.state)) {
        order = await this.store.transition(order, "PROVIDER_FAILED", "provider_terminal_failed");
      }
      await this.store.releaseCapacity(order.orderId);
    }
    return { ...response, receipt: await this.signedReceipt(order) };
  }

  async issueChallenge(args: {
    providerAgentId: string;
    outcomeId: string;
    body: unknown;
  }): Promise<{ handle: string; order: StandardOrderRecord; paymentRequired: unknown }> {
    this.assertAdmissionOpen();
    await this.assertRailFence();
    const listing = this.listing(args.providerAgentId, args.outcomeId);
    await this.verifyListingIdentity(listing);
    this.validateRequest(listing, args.body);
    const canonicalRequestHash = canonicalHash({
      method: "POST",
      resource: listing.commitment.payload.absoluteResourceUri,
      providerAgentId: args.providerAgentId,
      outcomeId: args.outcomeId,
      body: args.body,
    });
    const listingManifestHash = canonicalHash(listing.manifest);
    const providerOfferHash = canonicalHash(listing.offer);
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
      return this.challengeResponse(listing, existing.order, existing.handle);
    }

    const now = Math.floor(Date.now() / 1_000);
    const offer = listing.offer.payload;
    const pricing = await this.resolveGrossAmount(listing, args.body);
    const quoteIssuedAt = Math.max(now, pricing.issuedAt);
    const minimumPaymentWindowSeconds = Math.max(
      listing.deadlinePolicy.minimumPaymentWindowSeconds,
      listing.quotePolicy?.minimumPaymentWindowSeconds ?? 0,
    );
    const expiresAt = Math.min(
      now + listing.deadlinePolicy.draftSeconds,
      offer.validBefore,
      pricing.validBefore,
      listing.commitment.payload.validUntil,
      listing.commitment.validBefore,
    );
    if (
      expiresAt <= quoteIssuedAt + minimumPaymentWindowSeconds
    ) {
      throw new Error("OUTCOME_OFFER_EXPIRED");
    }
    const grossAmount = pricing.grossAmount;
    const orderNonce = `0x${randomBytes(32).toString("hex")}` as Hex;
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
      canonicalRequestHash,
      canonicalRequest: args.body,
      grossAmount,
      railEpoch,
      listingEpoch: listing.commitment.payload.listingEpoch,
      expiresAt: new Date(expiresAt * 1_000),
    });
    return this.challengeResponse(listing, created.order, created.handle);
  }

  async submitPayment(args: {
    providerAgentId: string;
    outcomeId: string;
    body: unknown;
    payment: PaymentPayload;
  }): Promise<{ handle: string; order: StandardOrderRecord; replay: boolean }> {
    this.assertAdmissionOpen();
    await this.assertRailFence();
    const existing = await this.store.findByAuthorizationKey(
      paymentAuthorizationLookupKey(this.appConfig, args.payment),
    );
    if (existing) {
      if (
        existing.order.providerAgentId !== args.providerAgentId ||
        existing.order.outcomeId !== args.outcomeId ||
        canonicalHash(existing.order.canonicalRequest) !== canonicalHash(args.body) ||
        existing.order.paymentPayloadHash !== canonicalHash(args.payment)
      ) {
        await this.incidents.record({
          kind: "changed_payment_authorization_replay",
          orderId: existing.order.orderId,
          state: existing.order.state,
          details: { presentedPaymentHash: canonicalHash(args.payment) },
        });
        throw new Error("Changed authorization replay rejected");
      }
      return { ...existing, replay: true };
    }
    const challenge = await this.issueChallenge(args);
    let order = challenge.order;
    if (order.state !== "CHALLENGE_ISSUED") return { handle: challenge.handle, order, replay: false };
    const listing = this.listing(args.providerAgentId, args.outcomeId);
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
      payment: args.payment,
      railProfileHash: this.railProfileHash,
    });
    if (!isReputationEligiblePayer(authorization.payer, listing, this.railConfig)) {
      throw new Error("Known operational-wallet self-purchase is forbidden");
    }
    try {
      order = await this.store.claimAuthorization({
        orderId: order.orderId,
        expectedVersion: order.version,
        authorizationKey: authorization.authorizationKey,
        payer: authorization.payer,
        encryptedPayload: encryptPaymentPayload(this.railConfig.encryptionKey, args.payment),
        paymentPayloadHash: canonicalHash(args.payment),
        facilitatorProfileHash: this.railConfig.manifest.activeRailProfile.payload.facilitatorProfileHash,
        capacityLimit: listing.capacityPolicy.maxOpenOrders,
      });
    } catch (error) {
      const claimed = await this.store.findByAuthorizationKey(authorization.authorizationKey);
      if (
        claimed && claimed.order.providerAgentId === args.providerAgentId &&
        claimed.order.outcomeId === args.outcomeId &&
        canonicalHash(claimed.order.canonicalRequest) === canonicalHash(args.body) &&
        claimed.order.paymentPayloadHash === canonicalHash(args.payment)
      ) return { ...claimed, replay: true };
      throw error;
    }
    await this.screenParticipants(listing, authorization.payer);
    await this.journal.markVerifyInvoked(order.orderId);
    const verify = await this.withRailFence(() => this.facilitator.verify(args.payment, requirements));
    const facilitatorVerified = Boolean(
      verify.isValid && verify.payer && getAddress(verify.payer) === authorization.payer,
    );
    await this.journal.recordVerify(order.orderId, canonicalHash(verify), facilitatorVerified);
    if (!facilitatorVerified) {
      order = await this.store.transition(order, "VERIFY_REJECTED", "facilitator_verify_rejected");
      await this.store.releaseCapacity(order.orderId);
      return { handle: challenge.handle, order, replay: false };
    }
    order = await this.store.transition(order, "VERIFIED", "facilitator_verified");
    return this.store.withListingSettlementLock(order.listingManifestHash, async () => {
      if (!await this.store.listingSettlementAvailable(order.listingManifestHash, order.orderId)) {
        return { handle: challenge.handle, order, replay: false };
      }
      await this.screenParticipants(listing, authorization.payer);
      await this.verifyListingIdentity(listing);
      if (await this.evidence.authorizationUsed(
        getAddress(listing.commitment.payload.canonicalToken),
        authorization.payer,
        authorization.nonce,
      )) {
        order = await this.store.transition(
          order,
          "EXTERNAL_OR_UNPROVEN_DEPOSIT",
          "authorization_consumed_before_facilitator_egress",
        );
        return { handle: challenge.handle, order, replay: false };
      }
      const mayInvokeFacilitator = await this.journal.markSettleInvoked(order.orderId);
      order = await this.store.transition(order, "SETTLE_INVOKED", "settle_invocation_persisted");
      if (!mayInvokeFacilitator) {
        order = await this.store.transition(order, "SETTLEMENT_AMBIGUOUS", "settle_invocation_outcome_unknown");
        return { handle: challenge.handle, order, replay: false };
      }
      let settlement;
      try {
        settlement = await this.withRailFence(() => this.facilitator.settle(args.payment, requirements));
      } catch {
        order = await this.store.transition(order, "SETTLEMENT_AMBIGUOUS", "settle_response_unknown");
        return { handle: challenge.handle, order, replay: false };
      }
      if (
        !settlement.success || !/^0x[0-9a-fA-F]{64}$/.test(settlement.transaction) ||
        !settlement.payer || getAddress(settlement.payer) !== authorization.payer ||
        settlement.network !== this.appConfig.x402Network
      ) {
        order = await this.store.transition(order, "SETTLEMENT_FAILED", "facilitator_settlement_failed");
        return { handle: challenge.handle, order, replay: false };
      }
      const transactionHash = settlement.transaction as Hex;
      await this.journal.recordSettlement(order.orderId, canonicalHash(settlement), transactionHash);
      order = await this.store.transition(order, "FACILITATOR_CONFIRMED", "facilitator_settlement_confirmed", { settlementTxHash: transactionHash });
      const deposit = await this.evidence.proveDeposit({
        order,
        listing,
        transactionHash,
        paymentNonce: authorization.nonce,
        payment: args.payment,
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
      return { handle: challenge.handle, order, replay: false };
    });
  }

  private async dispatch(
    order: StandardOrderRecord,
    listing: StandardListing,
    request: unknown,
    confirmationHash: Hex,
    evidenceBundle: { deposit: import("./evidence.js").EvidenceResult; release: import("./evidence.js").EvidenceResult },
  ): Promise<StandardOrderRecord> {
    const persisted = await this.journal.dispatchClaim(order.orderId);
    const mayInvokeProvider = persisted === null;
    let dispatch: import("./types.js").SignedEnvelope<StandardRailDispatchV1>;
    let dispatchHash: Hex;
    let effectiveRequest = request;
    if (persisted) {
      dispatch = persisted.dispatch;
      dispatchHash = canonicalHash(dispatch);
      effectiveRequest = persisted.request;
      if (
        dispatch.payload.orderId !== order.orderId ||
        dispatch.payload.listingManifestHash !== order.listingManifestHash ||
        dispatch.payload.canonicalProviderRequestHash !== canonicalHash(effectiveRequest)
      ) throw new Error("Persisted dispatch does not match the order");
    } else {
      const nonce = `0x${randomBytes(32).toString("hex")}` as Hex;
      const now = Math.floor(Date.now() / 1_000);
      const gross = BigInt(order.grossAmount);
      if (!order.providerNetAmount || !order.daskiCommissionAmount) {
        throw new Error("Release allocation is missing from the order");
      }
      const payload: StandardRailDispatchV1 = {
        environment: this.railConfig.environment,
        chainId: this.appConfig.chainId,
        gatewayAudience: this.railConfig.gatewayAudience,
        providerAudience: listing.providerControlProfile.payload.providerAudience,
        providerControlProfileHash: listing.commitment.payload.providerControlProfileHash,
        orderId: order.orderId,
        orderKey: order.orderKey,
        serviceId: listing.commitment.payload.serviceId,
        reputationEligible: isReputationEligiblePayer(order.payer!, listing, this.railConfig),
        reputationContract: this.railConfig.reputationContract,
        outcomeSchemaUid: this.railConfig.reputationOutcomeSchemaUid,
        dispatchNonce: nonce,
        payer: order.payer!,
        listingManifestHash: order.listingManifestHash,
        providerOfferHash: order.providerOfferHash,
        quoteHash: order.quoteHash,
        bindingProfile: listing.commitment.payload.bindingProfile,
        canonicalRequestHash: order.canonicalRequestHash,
        orderNonce: order.orderNonce,
        buyerIdentityProofHash: ZERO_HASH,
        activeRailProfileHash: this.railProfileHash,
        facilitatorConfirmationHash: confirmationHash,
        depositEvidenceHash: order.depositEvidenceHash!,
        releaseEvidenceHash: order.releaseEvidenceHash!,
        grossAmount: gross.toString(),
        providerNetAmount: order.providerNetAmount,
        daskiCommissionAmount: order.daskiCommissionAmount,
        canonicalProviderRequestHash: canonicalHash(request),
        dispatchDeadlineSeconds: listing.deadlinePolicy.dispatchSeconds,
        issuedAt: now,
        validBefore: now + listing.deadlinePolicy.dispatchSeconds,
      };
      dispatch = await signEnvelope({
        artifactType: "StandardRailDispatchV1",
        environment: this.railConfig.environment,
        chainId: this.appConfig.chainId,
        audience: listing.providerControlProfile.payload.providerAudience,
        signerKeyId: "gateway-dispatch",
        privateKey: this.railConfig.dispatchPrivateKey,
        issuedAt: now,
        validBefore: now + listing.deadlinePolicy.dispatchSeconds,
        payload,
      });
      dispatchHash = canonicalHash(dispatch);
      if (!await this.journal.claimDispatch({
        orderId: order.orderId,
        nonce,
        dispatchHash,
        requestHash: canonicalHash(request),
        dispatch,
        request,
      })) throw new Error("Dispatch claim changed concurrently");
    }
    if (order.state === "RELEASE_FINAL") {
      order = await this.store.transition(order, "DISPATCH_STARTED", "dispatch_invocation_persisted");
    } else if (order.state !== "DISPATCH_STARTED" && order.state !== "DISPATCH_AMBIGUOUS") {
      throw new Error(`Order ${order.orderId} is not dispatchable from ${order.state}`);
    }
    if (!mayInvokeProvider || order.state === "DISPATCH_AMBIGUOUS") {
      try {
        const response = await this.queryProviderDispatchStatus(
          listing,
          order.orderId,
          dispatchHash,
        );
        return this.applyDispatchResponse(order, listing, dispatchHash, response);
      } catch {
        return order.state === "DISPATCH_STARTED"
          ? this.store.transition(order, "DISPATCH_AMBIGUOUS", "provider_dispatch_outcome_unknown")
          : order;
      }
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.min(this.railConfig.dispatchTimeoutMs, listing.providerControlProfile.payload.timeoutMs),
    );
    try {
      const response = await this.providerFetch(listing, listing.providerControlProfile.payload.dispatchUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dispatch, quote: order.quote, request: effectiveRequest, evidenceBundle }, (_, value) =>
          typeof value === "bigint" ? value.toString() : value,
        ),
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) throw new Error("provider_dispatch_rejected");
      const body = await readBoundedJson(
        response,
        listing.providerControlProfile.payload.maxResponseBytes,
      );
      return this.applyDispatchResponse(order, listing, dispatchHash, body);
    } catch {
      return order.state === "DISPATCH_STARTED"
        ? this.store.transition(order, "DISPATCH_AMBIGUOUS", "provider_dispatch_response_unknown")
        : order;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async queryProviderDispatchStatus(
    listing: StandardListing,
    orderId: string,
    dispatchHash: Hex,
  ): Promise<unknown> {
    const now = Math.floor(Date.now() / 1_000);
    const query = await signEnvelope<DispatchStatusQueryV1>({
      artifactType: "DispatchStatusQueryV1",
      environment: this.railConfig.environment,
      chainId: this.appConfig.chainId,
      audience: listing.providerControlProfile.payload.providerAudience,
      signerKeyId: "gateway-dispatch",
      privateKey: this.railConfig.dispatchPrivateKey,
      issuedAt: now,
      validBefore: now + 60,
      payload: { orderId, dispatchHash, issuedAt: now, validBefore: now + 60 },
    });
    const response = await this.providerFetch(
      listing,
      listing.providerControlProfile.payload.dispatchStatusUrl,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(
          this.railConfig.dispatchTimeoutMs,
          listing.providerControlProfile.payload.timeoutMs,
        )),
      },
    );
    if (!response.ok) throw new Error("PROVIDER_DISPATCH_STATUS_UNAVAILABLE");
    return readBoundedJson(response, listing.providerControlProfile.payload.maxResponseBytes);
  }

  private async applyDispatchResponse(
    initial: StandardOrderRecord,
    listing: StandardListing,
    dispatchHash: Hex,
    value: unknown,
  ): Promise<StandardOrderRecord> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("provider_dispatch_response_malformed");
    }
    const body = value as {
      taskId?: unknown; dispatchHash?: unknown; signature?: unknown; state?: unknown;
      terminalAttestation?: { payload?: Record<string, unknown>; signature?: unknown };
    };
    const terminal = ["completed", "failed", "canceled"].includes(String(body.state));
    assertExactKeys(
      body,
      terminal
        ? ["taskId", "dispatchHash", "signature", "state", "terminalAttestation"]
        : ["taskId", "dispatchHash", "signature", "state"],
      "provider dispatch response",
    );
    if (
      typeof body.taskId !== "string" || body.taskId.length === 0 || body.taskId.length > 128 ||
      body.dispatchHash !== dispatchHash || typeof body.signature !== "string" ||
      !["dispatching", "submitted", "working", "input-required", "completed", "failed", "canceled"].includes(String(body.state))
    ) throw new Error("provider_dispatch_response_malformed");
    const responseHash = canonicalHash({ taskId: body.taskId, dispatchHash, state: body.state });
    const signer = await recoverMessageAddress({
      message: { raw: responseHash },
      signature: body.signature as Hex,
    });
    if (getAddress(signer) !== getAddress(listing.commitment.payload.providerAuthorityKey)) {
      throw new Error("provider_dispatch_response_signature_invalid");
    }
    await this.journal.resolveDispatch(initial.orderId, body.taskId, responseHash);
    let order = initial;
    if (["DISPATCH_STARTED", "DISPATCH_AMBIGUOUS"].includes(order.state)) {
      order = await this.store.transition(order, "DISPATCHED", "provider_dispatch_accepted", {
        providerTaskId: body.taskId,
      });
    } else if (order.providerTaskId !== body.taskId) {
      throw new Error("provider_dispatch_task_binding_invalid");
    }
    if (body.state === "input-required" && order.state === "DISPATCHED") {
      order = await this.store.transition(order, "INPUT_REQUIRED", "provider_pre_execute_hold");
    } else if (["dispatching", "submitted", "working"].includes(String(body.state)) && order.state === "INPUT_REQUIRED") {
      order = await this.store.transition(order, "DISPATCHED", "provider_input_accepted");
    } else if (terminal) {
      const attestation = body.terminalAttestation;
      if (!attestation?.payload || typeof attestation.signature !== "string") {
        throw new Error("provider_terminal_attestation_missing");
      }
      assertExactKeys(attestation, ["payload", "signature"], "provider terminal attestation");
      assertExactKeys(
        attestation.payload,
        ["taskId", "dispatchHash", "state", "resultHash", "completedAt"],
        "provider terminal attestation payload",
      );
      const completedAt = attestation.payload.completedAt;
      if (
        typeof completedAt !== "number" || !Number.isSafeInteger(completedAt) || completedAt <= 0 ||
        completedAt > Math.floor(Date.now() / 1_000) + 30 ||
        typeof attestation.payload.resultHash !== "string" ||
        !/^0x[0-9a-fA-F]{64}$/.test(attestation.payload.resultHash)
      ) throw new Error("provider_terminal_attestation_time_invalid");
      const terminalSigner = await recoverMessageAddress({
        message: { raw: canonicalHash(attestation.payload) },
        signature: attestation.signature as Hex,
      });
      if (
        getAddress(terminalSigner) !== getAddress(listing.commitment.payload.providerTerminalAttestationKey) ||
        attestation.payload.taskId !== body.taskId || attestation.payload.dispatchHash !== dispatchHash ||
        attestation.payload.state !== body.state
      ) throw new Error("provider_terminal_attestation_invalid");
      if (["DISPATCHED", "INPUT_REQUIRED"].includes(order.state)) {
        order = await this.store.transition(
          order,
          body.state === "completed" ? "FULFILLED" : "PROVIDER_FAILED",
          body.state === "completed" ? "provider_terminal_completed" : "provider_terminal_failed",
        );
      }
    }
    if (["FULFILLED", "PROVIDER_FAILED"].includes(order.state)) {
      await this.store.releaseCapacity(order.orderId);
    }
    return order;
  }

  private challengeResponse(listing: StandardListing, order: StandardOrderRecord, handle: string) {
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
        requirements,
        listing,
        order,
        railProfileHash: this.railProfileHash,
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
        validBefore: offer.validBefore,
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
        listingManifestHash: canonicalHash(listing.manifest),
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
    });
    if (!response.ok) throw new Error("PROVIDER_QUOTE_UNAVAILABLE");
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
      quote.listingManifestHash !== canonicalHash(listing.manifest) ||
      quote.requestHash !== requestHash || typeof quote.grossAmount !== "string" ||
      !/^[1-9][0-9]*$/.test(quote.grossAmount) || typeof quote.issuedAt !== "number" ||
      !Number.isSafeInteger(quote.issuedAt) || typeof quote.validBefore !== "number" ||
      !Number.isSafeInteger(quote.validBefore) || quote.issuedAt > now + 30 || quote.issuedAt < now - 30 ||
      quote.validBefore <= now + Math.max(
        listing.deadlinePolicy.minimumPaymentWindowSeconds,
        listing.quotePolicy?.minimumPaymentWindowSeconds ?? 0,
      ) ||
      quote.validBefore > offer.validBefore || !listing.quotePolicy ||
      quote.validBefore > quote.issuedAt + listing.quotePolicy.maximumLifetimeSeconds ||
      typeof quote.signature !== "string"
    ) throw new Error("PROVIDER_QUOTE_INVALID");
    const bps = BigInt(listing.commitment.payload.commissionBps);
    const minimumReleasableAmount = (10_000n + bps - 1n) / bps;
    if (BigInt(quote.grossAmount) < minimumReleasableAmount) {
      throw new Error("PROVIDER_QUOTE_NOT_RELEASABLE");
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
      throw new Error("PROVIDER_QUOTE_SIGNATURE_INVALID");
    }
    return {
      grossAmount: quote.grossAmount,
      providerQuoteHash: quoteHash,
      issuedAt: quote.issuedAt,
      validBefore: quote.validBefore,
    };
  }

  private validateRequest(listing: StandardListing, body: unknown): void {
    const payload = listing.commitment.payload;
    const validate = this.requestValidators.get(`${payload.providerAgentId}:${payload.outcomeId}`);
    if (!validate) throw new Error("Outcome request validator is unavailable");
    assertSchema(validate, body);
  }

  private validateResponse(listing: StandardListing, result: unknown): void {
    const payload = listing.commitment.payload;
    const validate = this.responseValidators.get(`${payload.providerAgentId}:${payload.outcomeId}`);
    if (!validate) throw new Error("Outcome response validator is unavailable");
    assertSchema(validate, result, "Response");
    assertPassiveProviderOutput(result);
  }

  private assertRailFence(): Promise<void> {
    return this.store.assertActiveRail(this.railProfileHash);
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
