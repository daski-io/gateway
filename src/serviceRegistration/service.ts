import { randomUUID } from "node:crypto";
import { getAddress, type Address, type Hex } from "viem";
import type { Config } from "../config.js";
import type {
  MarketplaceChainReader,
  MarketplaceServiceRecord,
} from "../marketplace/reader.js";
import { canonicalHash } from "../standardRail/canonical.js";
import type { StandardRailConfig } from "../standardRail/config.js";
import { logger } from "../util/logger.js";
import {
  verifyRegistrationEvidence,
  verifyRegistrationIntent,
} from "./auth.js";
import { parseProviderServiceCard } from "./card.js";
import { fetchProviderCardJson } from "./cardFetch.js";
import type { RegistrationEvidenceVerifier } from "./evidence.js";
import {
  computeServiceId,
  dynamicRegistrationPolicy,
  prepareServiceRegistration,
  validateServiceRegistrationContract,
} from "./preparation.js";
import {
  buildRuntimeListingCommitment,
  runtimeCommitmentHash,
} from "./runtimeCommitment.js";
import {
  ServiceRegistrationStore,
  type StoredRegistration,
} from "./store.js";
import type {
  ProviderServiceCard,
  ProviderServiceRegistrationEvidenceEnvelope,
} from "./types.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export class RegistrationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

class PreparedRegistrationDrift extends Error {}

interface ProviderAuthority {
  owner: Address;
  agentWallet: Address;
}

function providerAuthority(raw: unknown, expectedAgentId: string): ProviderAuthority {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("provider record is invalid");
  }
  const provider = raw as {
    agentId?: unknown;
    active?: unknown;
    identity?: { owner?: unknown; agentWallet?: unknown };
  };
  if (
    provider.agentId !== expectedAgentId ||
    provider.active !== true ||
    typeof provider.identity?.owner !== "string" ||
    typeof provider.identity.agentWallet !== "string"
  ) throw new Error("provider is not active");
  return {
    owner: getAddress(provider.identity.owner),
    agentWallet: getAddress(provider.identity.agentWallet),
  };
}

function assertServiceMatches(
  service: MarketplaceServiceRecord,
  expected: {
    providerAgentId: string;
    serviceId: Hex;
    serviceSlug: string;
    serviceVersion: string;
  },
): void {
  const canonicalId = computeServiceId(
    expected.providerAgentId,
    expected.serviceSlug,
    expected.serviceVersion,
  );
  if (
    canonicalId !== expected.serviceId ||
    !service.active ||
    service.providerAgentId !== expected.providerAgentId ||
    service.serviceId.toLowerCase() !== expected.serviceId.toLowerCase() ||
    service.serviceSlug !== expected.serviceSlug ||
    service.version !== expected.serviceVersion
  ) throw new RegistrationError(
    409,
    "SERVICE_CHAIN_BINDING_MISMATCH",
    "The finalized service record does not match the signed registration.",
  );
  let uri: URL;
  try { uri = new URL(service.serviceUri); } catch {
    throw new RegistrationError(409, "SERVICE_URI_INVALID", "The finalized service URI is invalid.");
  }
  if (
    uri.protocol !== "https:" || uri.username || uri.password || uri.hash ||
    uri.toString().length > 2_048
  ) throw new RegistrationError(
    409,
    "SERVICE_URI_INVALID",
    "The finalized service URI must be credential-free HTTPS.",
  );
  try { getAddress(service.serviceWallet); } catch {
    throw new RegistrationError(409, "SERVICE_WALLET_INVALID", "The finalized service wallet is invalid.");
  }
}

function sameTransactions(
  left: ProviderServiceRegistrationEvidenceEnvelope,
  right: ProviderServiceRegistrationEvidenceEnvelope,
): boolean {
  const normalize = (value: ProviderServiceRegistrationEvidenceEnvelope) =>
    [...value.payload.splitterTransactionHashes]
      .sort((a, b) => a.listingId.localeCompare(b.listingId))
      .map(({ listingId, transactionHash }) => ({
        listingId,
        transactionHash: transactionHash.toLowerCase(),
      }));
  return canonicalHash(normalize(left)) === canonicalHash(normalize(right));
}

function registrationView(record: StoredRegistration) {
  return {
    registrationId: record.registrationId,
    state: record.state,
    providerAgentId: record.providerAgentId,
    serviceId: record.serviceId,
    serviceSlug: record.serviceSlug,
    serviceVersion: record.serviceVersion,
    agentCardUrl: record.agentCardUrl,
    providerPayee: record.providerPayee,
    marketplaceEnabled: record.marketplaceEnabled,
    registrationHealthy: record.registrationHealthy,
    nextAction: ["PREPARED", "EVIDENCE_PENDING"].includes(record.state)
      ? "submit-splitter-evidence"
      : null,
    prepared: record.prepared,
    activatedAt: record.activatedAt?.toISOString() ?? null,
    updatedAt: record.updatedAt.toISOString(),
  };
}

function publicServiceView(
  record: StoredRegistration,
  runtimeCommitments: ReadonlyMap<string, `0x${string}`> = new Map(),
) {
  const listings = new Map(record.prepared.listings.map((item) => [item.skillId, item]));
  return {
    gatewayRegistrationId: record.registrationId,
    providerAgentId: record.providerAgentId,
    serviceId: record.serviceId,
    agentCardUrl: record.agentCardUrl,
    providerPayee: record.providerPayee,
    legal: record.card.legal,
    name: record.card.name,
    description: record.card.description,
    service: record.card.service,
    standardRail: record.card.standardRail,
    skills: record.card.skills.map((skill) => {
      const listing = listings.get(skill.skillId)!;
      return {
        ...skill,
        listing: {
          listingId: listing.listingId,
          listingKey: listing.listingKey,
          paymentRequired: listing.paymentRequired,
          splitterAddress: listing.splitterAddress,
          runtimeCommitmentHash: runtimeCommitments.get(listing.listingId) ?? null,
        },
      };
    }),
    freshness: {
      lastValidatedAt: record.lastRefreshedAt?.toISOString() ?? null,
      presentationStaleAfterSeconds: 86_400,
      commerceFreshnessSeconds: 300,
    },
  };
}

export class ServiceRegistrationService {
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshWork: Promise<void> | null = null;
  private activeRegistrationWork = 0;

  constructor(
    private readonly config: Config,
    private readonly railConfig: StandardRailConfig,
    private readonly store: ServiceRegistrationStore,
    private readonly marketplace: MarketplaceChainReader,
    private readonly evidenceVerifier: RegistrationEvidenceVerifier,
    private readonly cardLoader: (url: string) => Promise<unknown> =
      (url) => fetchProviderCardJson(url),
  ) {}

  policy() {
    const policy = dynamicRegistrationPolicy(this.config, this.railConfig);
    return {
      schemaVersion: 1,
      environment: this.railConfig.environment,
      chainId: this.config.chainId,
      audience: this.config.publicUrl,
      providerSignerKeyId: "provider-authority",
      serviceRegistry: this.config.marketplaceContracts.serviceRegistry,
      defaultMarketplaceEnabled: this.config.chainId === 84532,
      railPolicyHash: policy.policyVersionHash,
      canonicalToken: policy.canonicalToken,
      daskiCommissionReceiver: policy.daskiCommissionReceiver,
      commissionBps: policy.commissionBps,
      splitterFactory: policy.splitterFactory,
      splitterCreationCodeHash: policy.splitterCreationCodeHash,
      splitterFactoryRuntimeCodeHash: policy.splitterFactoryRuntimeCodeHash,
      splitterRuntimeCodeHash: policy.splitterRuntimeCodeHash,
      intentMaximumLifetimeSeconds: 600,
    };
  }

  private async boundedRegistrationWork<T>(work: () => Promise<T>): Promise<T> {
    if (this.activeRegistrationWork >= 4) {
      throw new RegistrationError(
        429,
        "REGISTRATION_CAPACITY_REACHED",
        "Registration validation capacity is temporarily exhausted.",
      );
    }
    this.activeRegistrationWork += 1;
    try {
      return await work();
    } finally {
      this.activeRegistrationWork -= 1;
    }
  }

  async register(raw: unknown, idempotencyKey: string) {
    return this.boundedRegistrationWork(async () => {
      let rawHash: Hex | null = null;
      let untrustedProviderAgentId: string | null = null;
      try {
        rawHash = canonicalHash(raw);
        const candidate = raw as {
          payload?: { providerAgentId?: unknown };
        };
        const value = candidate?.payload?.providerAgentId;
        if (
          typeof value === "string" &&
          /^(?:0|[1-9]\d{0,77})$/.test(value)
        ) {
          untrustedProviderAgentId = value;
        }
      } catch {
        rawHash = null;
      }
      if (rawHash && untrustedProviderAgentId) {
        const replay = await this.store.getByIdempotency(
          untrustedProviderAgentId,
          idempotencyKey,
        );
        if (replay) {
          if (replay.requestHash !== rawHash) {
            throw new RegistrationError(
              409,
              "IDEMPOTENCY_KEY_REUSED",
              "The idempotency key was already used for a different request.",
            );
          }
          return { created: false, registration: registrationView(replay) };
        }
      }

      let verified;
      try {
        verified = await verifyRegistrationIntent({
          raw,
          config: this.config,
          railConfig: this.railConfig,
          marketplace: this.marketplace,
        });
      } catch {
        throw new RegistrationError(
          401,
          "REGISTRATION_AUTH_INVALID",
          "The signed registration intent or finalized provider authority is invalid.",
        );
      }
      const { envelope, owner, agentWallet, signer } = verified;
      const requestHash = canonicalHash(envelope);
      const prior = await this.store.getByIdempotency(
        envelope.payload.providerAgentId,
        idempotencyKey,
      );
      if (prior) {
        if (prior.requestHash !== requestHash) {
          throw new RegistrationError(
            409,
            "IDEMPOTENCY_KEY_REUSED",
            "The idempotency key was already used for a different request.",
          );
        }
        return { created: false, registration: registrationView(prior) };
      }
      if (await this.store.getPendingByServiceId(envelope.payload.serviceId)) {
        throw new RegistrationError(
          409,
          "REGISTRATION_REVISION_PENDING",
          "This service already has a prepared registration revision; resume it.",
        );
      }

      let service: MarketplaceServiceRecord;
      try {
        service = await this.marketplace.getService(envelope.payload.serviceId);
      } catch {
        throw new RegistrationError(
          502,
          "SERVICE_CHAIN_READ_FAILED",
          "The finalized service record is temporarily unavailable.",
        );
      }
      assertServiceMatches(service, envelope.payload);
      let rawCard: unknown;
      try {
        rawCard = await this.cardLoader(service.serviceUri);
      } catch {
        throw new RegistrationError(
          422,
          "AGENT_CARD_FETCH_FAILED",
          "The chain-recorded Agent Card could not be fetched safely.",
        );
      }
      let card: ProviderServiceCard;
      try {
        card = parseProviderServiceCard(rawCard, {
          providerAgentId: envelope.payload.providerAgentId,
          serviceId: envelope.payload.serviceId,
          serviceSlug: envelope.payload.serviceSlug,
          serviceVersion: envelope.payload.serviceVersion,
          agentCardUrl: service.serviceUri,
        });
      } catch {
        throw new RegistrationError(
          422,
          "AGENT_CARD_INVALID",
          "The chain-recorded Agent Card does not satisfy the published contract.",
        );
      }
      let validated;
      try {
        validated = validateServiceRegistrationContract({
          intent: envelope,
          card,
          agentWallet,
          service,
          config: this.config,
          railConfig: this.railConfig,
        });
      } catch {
        throw new RegistrationError(
          409,
          "REGISTRATION_CONTRACT_MISMATCH",
          "The signed intent does not match the current service, card, payee, or rail policy.",
        );
      }

      const active = await this.store.getActiveByServiceId(
        envelope.payload.serviceId,
      );
      if (
        active &&
        active.card.serviceContractHash === card.serviceContractHash &&
        active.prepared.railPolicyHash === validated.policy.policyVersionHash &&
        getAddress(active.providerOwner) === owner &&
        getAddress(active.providerAgentWallet) === agentWallet &&
        getAddress(active.providerPayee) === validated.providerPayee &&
        active.agentCardUrl === service.serviceUri &&
        getAddress(active.serviceWallet) === getAddress(service.serviceWallet)
      ) {
        await this.store.refreshed({
          registrationId: active.registrationId,
          card,
          cardHash: canonicalHash(card),
          chainActive: true,
        });
        return {
          created: false,
          registration: registrationView(
            (await this.store.get(active.registrationId))!,
          ),
        };
      }

      const registrationId = randomUUID();
      let prepared;
      try {
        prepared = await prepareServiceRegistration({
          registrationId,
          intent: envelope,
          card,
          agentWallet,
          service,
          config: this.config,
          railConfig: this.railConfig,
          prior: active,
        });
      } catch {
        throw new RegistrationError(
          409,
          "REGISTRATION_CONTRACT_MISMATCH",
          "The signed intent does not match the current service, card, payee, or rail policy.",
        );
      }
      try {
        const saved = await this.store.create({
          intent: envelope,
          requestHash,
          idempotencyKey,
          serviceId: envelope.payload.serviceId,
          card,
          cardHash: canonicalHash(card),
          prepared,
          providerOwner: owner,
          providerAgentWallet: agentWallet,
          providerSigner: signer,
          supersedesRegistrationId: active?.registrationId ?? null,
        });
        return {
          created: saved.created,
          registration: registrationView(saved.record),
        };
      } catch (error) {
        if (error instanceof Error && error.message === "IDEMPOTENCY_KEY_REUSED") {
          throw new RegistrationError(409, error.message, "The idempotency key is already in use.");
        }
        if (
          error && typeof error === "object" &&
          (error as { code?: unknown }).code === "23505"
        ) {
          throw new RegistrationError(
            409,
            "REGISTRATION_REVISION_PENDING",
            "Another registration revision for this service is already pending.",
          );
        }
        throw error;
      }
    });
  }

  async get(registrationId: string) {
    const record = await this.store.get(registrationId);
    if (!record) throw new RegistrationError(404, "REGISTRATION_NOT_FOUND", "Registration not found.");
    if (record.state !== "ACTIVE") return registrationView(record);
    const commitments = await this.store.listingCommitments(
      record.prepared.listings.map((listing) => listing.listingId),
    );
    return {
      ...registrationView(record),
      runtimeCommitments: commitments
        .filter((item) => item.runtimeCommitmentHash !== null)
        .map(({ listingId, runtimeCommitmentHash: hash }) => ({
          listingId,
          runtimeCommitmentHash: hash,
        })),
    };
  }

  async submitEvidence(registrationId: string, raw: unknown) {
    const record = await this.store.get(registrationId);
    if (!record) throw new RegistrationError(404, "REGISTRATION_NOT_FOUND", "Registration not found.");
    if (
      record.state === "REJECTED" &&
      record.lastRefreshErrorCode === "PREPARED_REGISTRATION_DRIFT"
    ) throw new RegistrationError(
      409,
      "PREPARED_REGISTRATION_DRIFT",
      "The prepared registration no longer matches current chain or card authority.",
    );

    const persistedReplay =
      record.evidence !== null &&
      canonicalHash(raw) === canonicalHash(record.evidence);
    if (record.state === "ACTIVE" && persistedReplay) {
      return registrationView(record);
    }

    let evidence: ProviderServiceRegistrationEvidenceEnvelope;
    if (persistedReplay) {
      evidence = record.evidence!;
    } else {
      try {
        evidence = (await verifyRegistrationEvidence({
          raw,
          providerAgentId: record.providerAgentId,
          config: this.config,
          railConfig: this.railConfig,
          marketplace: this.marketplace,
        })).envelope;
      } catch {
        throw new RegistrationError(
          401,
          "EVIDENCE_AUTH_INVALID",
          "Registration evidence signature is invalid.",
        );
      }
    }
    if (
      evidence.payload.registrationId !== registrationId ||
      evidence.payload.preparedRegistrationHash !== canonicalHash(record.prepared)
    ) throw new RegistrationError(
      409,
      "EVIDENCE_BINDING_MISMATCH",
      "Evidence does not bind this exact prepared registration.",
    );
    if (record.state === "ACTIVE") {
      if (record.evidence && sameTransactions(record.evidence, evidence)) {
        return registrationView(record);
      }
      throw new RegistrationError(409, "REGISTRATION_ALREADY_ACTIVE", "Registration is already active.");
    }
    if (
      !["PREPARED", "EVIDENCE_PENDING"].includes(record.state) ||
      (!persistedReplay &&
        record.state !== evidence.payload.expectedState)
    ) throw new RegistrationError(
      409,
      "REGISTRATION_STATE_CONFLICT",
      "Evidence continuation does not match the current workflow state.",
    );
    const pending = persistedReplay
      ? record
      : await this.recordEvidencePending(registrationId, evidence);
    try {
      await this.evidenceVerifier.verify(pending, evidence);
    } catch {
      throw new RegistrationError(
        409,
        "EVIDENCE_NOT_FINAL",
        "Splitter evidence is incomplete, non-final, or does not match the preparation.",
      );
    }
    await this.requirePreparedRegistrationCurrent(pending);
    const commitments = this.runtimeCommitmentsFor(pending);
    const active = await this.store.activate(registrationId, commitments);
    return {
      ...registrationView(active),
      runtimeCommitments: commitments.map(({ listingId, runtimeCommitmentHash: hash }) => ({
        listingId,
        runtimeCommitmentHash: hash,
      })),
    };
  }

  // The runtime commitment fixes each listing head's immutable identity at
  // activation. Reused listings derive identity from their original signed
  // preparation, so re-registering a changed sibling never rotates them.
  private runtimeCommitmentsFor(record: StoredRegistration): Array<{
    listingId: string;
    runtimeCommitmentHash: `0x${string}`;
    runtimeCommitment: unknown;
  }> {
    const policy = dynamicRegistrationPolicy(this.config, this.railConfig);
    return record.prepared.listings.map((listing) => {
      const commitment = buildRuntimeListingCommitment({
        environment: this.railConfig.environment,
        chainId: this.config.chainId,
        gatewayAudience: this.config.publicUrl,
        providerAgentId: record.providerAgentId,
        serviceId: record.serviceId,
        serviceSlug: record.serviceSlug,
        serviceVersion: record.serviceVersion,
        currentProviderIntentHash: record.prepared.providerIntentHash,
        currentProviderPayee: getAddress(record.providerPayee),
        policy: {
          canonicalToken: policy.canonicalToken,
          daskiCommissionReceiver: policy.daskiCommissionReceiver,
          commissionBps: policy.commissionBps,
          policyVersionHash: policy.policyVersionHash,
          splitterFactory: policy.splitterFactory,
        },
        listing: {
          listingId: listing.listingId,
          listingKey: listing.listingKey,
          skillId: listing.skillId,
          skillContractHash: listing.skillContractHash,
          paymentRequired: listing.paymentRequired,
          splitterAddress: listing.splitterAddress,
          preparation: listing.preparation,
          controlProfile: listing.controlProfile,
        },
      });
      return {
        listingId: listing.listingId,
        runtimeCommitmentHash: runtimeCommitmentHash(commitment),
        runtimeCommitment: commitment,
      };
    });
  }

  private async recordEvidencePending(
    registrationId: string,
    evidence: ProviderServiceRegistrationEvidenceEnvelope,
  ): Promise<StoredRegistration> {
    try {
      return await this.store.recordEvidencePending({
        registrationId,
        evidence,
      });
    } catch {
      throw new RegistrationError(
        409,
        "REGISTRATION_STATE_CONFLICT",
        "Registration state does not accept this evidence.",
      );
    }
  }

  private async requirePreparedRegistrationCurrent(
    record: StoredRegistration,
  ): Promise<void> {
    try {
      await this.assertPreparedRegistrationCurrent(record);
    } catch (error) {
      if (error instanceof PreparedRegistrationDrift) {
        await this.store.rejectPending(
          record.registrationId,
          "PREPARED_REGISTRATION_DRIFT",
        );
        throw new RegistrationError(
          409,
          "PREPARED_REGISTRATION_DRIFT",
          "The prepared registration no longer matches current chain or card authority.",
        );
      }
      throw new RegistrationError(
        409,
        "EVIDENCE_NOT_FINAL",
        "Current finalized service and card authority could not be revalidated; retry later.",
      );
    }
  }

  private async assertPreparedRegistrationCurrent(
    record: StoredRegistration,
  ): Promise<void> {
    let service: MarketplaceServiceRecord;
    let rawProvider: unknown;
    try {
      [service, rawProvider] = await Promise.all([
        this.marketplace.getService(record.serviceId),
        this.marketplace.getProvider(BigInt(record.providerAgentId)),
      ]);
    } catch {
      throw new Error("current registration authority is unavailable");
    }
    let authority: ProviderAuthority;
    try {
      authority = providerAuthority(rawProvider, record.providerAgentId);
      assertServiceMatches(service, {
        providerAgentId: record.providerAgentId,
        serviceId: record.serviceId,
        serviceSlug: record.serviceSlug,
        serviceVersion: record.serviceVersion,
      });
    } catch {
      throw new PreparedRegistrationDrift();
    }
    const expectedPayee = service.serviceWallet.toLowerCase() === ZERO_ADDRESS
      ? authority.agentWallet
      : getAddress(service.serviceWallet);
    if (
      authority.owner !== getAddress(record.providerOwner) ||
      authority.agentWallet !== getAddress(record.providerAgentWallet) ||
      ![authority.owner, authority.agentWallet]
        .includes(getAddress(record.providerSigner)) ||
      service.serviceUri !== record.agentCardUrl ||
      getAddress(service.serviceWallet) !== getAddress(record.serviceWallet) ||
      expectedPayee !== getAddress(record.providerPayee) ||
      record.prepared.providerIntentHash !== canonicalHash(record.intent)
    ) throw new PreparedRegistrationDrift();

    let rawCard: unknown;
    try {
      rawCard = await this.cardLoader(service.serviceUri);
    } catch {
      throw new Error("current registration card is unavailable");
    }
    let card: ProviderServiceCard;
    try {
      card = parseProviderServiceCard(rawCard, {
        providerAgentId: record.providerAgentId,
        serviceId: record.serviceId,
        serviceSlug: record.serviceSlug,
        serviceVersion: record.serviceVersion,
        agentCardUrl: record.agentCardUrl,
      });
    } catch {
      throw new PreparedRegistrationDrift();
    }
    const policy = dynamicRegistrationPolicy(this.config, this.railConfig);
    if (
      card.serviceContractHash !== record.card.serviceContractHash ||
      card.serviceContractHash !== record.intent.payload.serviceContractHash ||
      record.prepared.railPolicyHash !== policy.policyVersionHash
    ) throw new PreparedRegistrationDrift();

  }
  async setVisibility(registrationId: string, visible: boolean) {
    if (!await this.store.setVisibility(registrationId, visible, "catalog-operator")) {
      throw new RegistrationError(404, "REGISTRATION_NOT_FOUND", "Active registration not found.");
    }
    return this.get(registrationId);
  }

  async listPublic(limit: number) {
    return {
      services: (await this.store.listPublic(limit))
        .map((record) => publicServiceView(record)),
    };
  }

  async getPublic(serviceId: Hex) {
    const record = await this.store.getPublicByServiceId(serviceId);
    if (!record) throw new RegistrationError(404, "SERVICE_NOT_FOUND", "Visible service not found.");
    const commitments = new Map(
      (await this.store.listingCommitments(
        record.prepared.listings.map((listing) => listing.listingId),
      ))
        .filter((item) => item.runtimeCommitmentHash !== null)
        .map((item) => [item.listingId, item.runtimeCommitmentHash!] as const),
    );
    return {
      ...publicServiceView(record, commitments),
      ...await this.publicReputation(record),
    };
  }

  // Separate provider- and service-scoped blocks on the detail view, sourced
  // from the cached chain reader. Reputation is a nullable enrichment: a read
  // failure must never take the public catalog down with it.
  private async publicReputation(record: StoredRegistration): Promise<{
    providerReputation: Record<string, string> | null;
    serviceReputation: Record<string, string> | null;
  }> {
    try {
      const [provider, service] = await Promise.all([
        this.marketplace.getProvider(BigInt(record.providerAgentId)),
        this.marketplace.getService(record.serviceId),
      ]);
      return {
        providerReputation: (provider as {
          standardReputation?: Record<string, string>;
        } | null)?.standardReputation ?? null,
        serviceReputation: service.standardReputation ?? null,
      };
    } catch {
      return { providerReputation: null, serviceReputation: null };
    }
  }

  private async refreshOne(record: StoredRegistration): Promise<void> {
    let service: MarketplaceServiceRecord;
    let authority: ProviderAuthority;
    try {
      [service, authority] = await Promise.all([
        this.marketplace.getService(record.serviceId),
        this.marketplace.getProvider(BigInt(record.providerAgentId))
          .then((value) => providerAuthority(value, record.providerAgentId)),
      ]);
    } catch {
      await this.store.refreshFailed(record.registrationId, "CHAIN_AUTHORITY_UNAVAILABLE");
      return;
    }
    const expectedPayee = service.serviceWallet.toLowerCase() === ZERO_ADDRESS
      ? authority.agentWallet
      : getAddress(service.serviceWallet);
    const authorityMatches =
      authority.owner === getAddress(record.providerOwner) &&
      authority.agentWallet === getAddress(record.providerAgentWallet);
    try {
      assertServiceMatches(service, {
        providerAgentId: record.providerAgentId,
        serviceId: record.serviceId,
        serviceSlug: record.serviceSlug,
        serviceVersion: record.serviceVersion,
      });
    } catch {
      await this.store.stopNewCommerce(record.registrationId, "CHAIN_SERVICE_DRIFT", false);
      return;
    }
    if (
      !authorityMatches ||
      service.serviceUri !== record.agentCardUrl ||
      getAddress(service.serviceWallet) !== getAddress(record.serviceWallet) ||
      expectedPayee !== getAddress(record.providerPayee)
    ) {
      await this.store.stopNewCommerce(record.registrationId, "CHAIN_AUTHORITY_DRIFT", true);
      return;
    }
    let rawCard: unknown;
    try {
      rawCard = await this.cardLoader(service.serviceUri);
    } catch {
      await this.store.refreshFailed(record.registrationId, "AGENT_CARD_UNAVAILABLE");
      return;
    }
    let card: ProviderServiceCard;
    try {
      card = parseProviderServiceCard(rawCard, {
        providerAgentId: record.providerAgentId,
        serviceId: record.serviceId,
        serviceSlug: record.serviceSlug,
        serviceVersion: record.serviceVersion,
        agentCardUrl: record.agentCardUrl,
      });
    } catch {
      await this.store.stopNewCommerce(record.registrationId, "AGENT_CARD_INVALID", true);
      return;
    }
    if (
      card.serviceContractHash !== record.card.serviceContractHash
    ) {
      await this.store.stopNewCommerce(record.registrationId, "CARD_CONTRACT_DRIFT", true);
      return;
    }
    await this.store.refreshed({
      registrationId: record.registrationId,
      card,
      cardHash: canonicalHash(card),
      chainActive: true,
    });
  }

  private async refreshBatch(): Promise<void> {
    for (const record of await this.store.listRefreshCandidates(25)) {
      try {
        await this.refreshOne(record);
      } catch {
        logger.warn("dynamic catalog refresh failed safely", {
          registrationId: record.registrationId,
        });
      }
    }
  }

  start(): void {
    if (this.refreshTimer) return;
    const run = () => {
      if (!this.refreshWork) {
        this.refreshWork = this.refreshBatch().finally(() => {
          this.refreshWork = null;
        });
      }
    };
    run();
    this.refreshTimer = setInterval(run, this.config.catalogRefreshIntervalMs);
    this.refreshTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    await this.refreshWork;
  }
}
