import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import type { Config } from "../../src/config.js";
import { createApp, type AppBundle } from "../../src/app.js";
import { createPool, type Pool } from "../../src/db/pool.js";
import type { Embedder } from "../../src/discovery/embeddings.js";
import { stubEmbedder } from "./stubEmbedder.js";
import { MockChainReader, makePaymentSettledEvent } from "./mockChain.js";
import {
  buildAgentCard,
  startMockProvider,
  type MockProviderHandle,
  type MockTaskState,
} from "./mockProvider.js";
import { DASKI_A2A_EXTENSION_URI } from "../../src/config.js";
import type { CategoryFamily, FulfillmentMode, ServiceType } from "../../src/serviceTaxonomy.js";
import { resolveSkillOffer } from "../../src/payment/skillOffer.js";
import type { PaymentSettledEvent } from "../../src/chain/reader.js";
import type { ExactEvmAuthorization, Hex, PaymentPayload } from "../../src/types.js";

const IDENTITY_REGISTRY_ADDRESS = "0x000000000000000000000000000000000000a000" as Hex;
// Daski AgentIndex — reverse lookup + delegated registerWithSig companion of
// the (canonical) identity registry. Distinct address so tests can assert
// the RegisterAgent typed-data verifies against the index, not the registry.
const AGENT_INDEX_ADDRESS = "0x000000000000000000000000000000000000a007" as Hex;
const REGISTRY_ADDRESS = "0x000000000000000000000000000000000000a001" as Hex;
const PAYMENT_ROUTER_ADDRESS = "0x000000000000000000000000000000000000a002" as Hex;
const USDC_ADDRESS = "0x000000000000000000000000000000000000a003" as Hex;
const X402_ADAPTER_ADDRESS = "0x000000000000000000000000000000000000a004" as Hex;
const EAS_ADDRESS = "0x000000000000000000000000000000000000a005" as Hex;
const SERVICE_REGISTRY_ADDRESS = "0x000000000000000000000000000000000000a006" as Hex;
const EAS_OUTCOME_SCHEMA_UID =
  "0xaa00000000000000000000000000000000000000000000000000000000000001" as Hex;
const EAS_CONFIRMATION_SCHEMA_UID =
  "0xaa00000000000000000000000000000000000000000000000000000000000002" as Hex;

// Facilitator: random key, the contents don't matter (tests mock the chain).
const FACILITATOR_KEY = "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;

// Buyer: fixed keypair so tests can sign EIP-3009 authorizations.
const TEST_BUYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

const CHAIN_ID = 84532;

// Tests connect to a real Postgres (matches production) and isolate via a
// per-test schema. The base URL points at the same DB the dev gateway uses
// — set DATABASE_URL_TEST to override (e.g. CI). Each test creates a
// schema like `gw_test_<uuid>` and drops it on close, so the suite is safe
// to run in parallel.
const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ??
  "postgresql://postgres:password@localhost:5433/daski_gateway_test";

export interface TestGatewayOptions {
  providers?: Array<TestProviderDef>;
  initialTaskState?: MockTaskState;
  embedder?: Embedder;
  /** Outbound provider/artifact fetch seam used by the MCP server. */
  a2aFetch?: typeof fetch;
  /**
   * Optional override for the buyer agentURI fetcher
   * (`/register-prep` + `/register-transaction`). Defaults to a stub that returns
   * `{ name: "buyer-test" }` for any URL — enough to satisfy callers that
   * don't assert on the resolved name.
   */
  buyerAgentCardFetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /**
   * Shallow overrides applied on top of the default test Config. Use this
   * to populate optional fields (permitAdapterAddress, reputationStorageAddress,
   * etc.) that the default fixture leaves unset.
   */
  configOverrides?: Partial<Config>;
  /**
   * Stub for the EXTERNAL x402 facilitator HTTP client (Bazaar rail).
   * Receives the /verify and /settle POSTs the gateway would send to the
   * CDP facilitator. Only reachable when configOverrides sets
   * directAdapterAddress (which mounts the /x402/services routes).
   */
  externalFacilitatorFetch?: typeof fetch;
}

/** Test-facing provider definition. `tokenId` is the ERC-8004 agentId. */
export interface TestProviderDef {
  tokenId: bigint;
  walletAddress?: Hex;
  priceUsdcSmallest: string;
  categoryFamily: CategoryFamily;
  serviceType: ServiceType;
  jurisdictions?: string[];
  name: string;
  a2aPath?: string;
  cardPath?: string;
  description?: string;
  skipExtension?: boolean;
  legal?: {
    legalName?: unknown;
    termsUrl?: unknown;
    privacyUrl?: unknown;
  } | null;
  /**
   * Optional skill metadata to attach to the Agent Card. Each entry lands
   * in the card's `skills[]` array with `metadata[DASKI_A2A_EXTENSION_URI]`
   * set to the provided meta — matches "Shape A" that
   * findProvidersOfferingSkill scans first.
   */
  skills?: Array<{
    id: string;
    name?: string;
    description?: string;
    metadata?: Record<string, unknown>;
  }>;
}

export interface PurchaseChallenge {
  status: number;
  json: any;
  serviceRef?: Hex;
  maxAmountRequired?: string;
  payTo?: Hex;
}

export interface TestGateway {
  bundle: AppBundle;
  httpServer: Server;
  baseUrl: string;
  config: Config;
  mockChain: MockChainReader;
  mockProvider: MockProviderHandle;
  buyerAddress: Hex;
  purchaseChallenge(tokenId: bigint, body: Record<string, unknown>): Promise<PurchaseChallenge>;
  purchaseSettle(
    tokenId: bigint,
    payload: PaymentPayload,
    serviceRef?: Hex,
  ): Promise<{ status: number; json: any }>;
  signAuthorization(
    value: bigint,
    nonce: Hex,
    opts?: { validAfter?: bigint; validBefore?: bigint },
  ): Promise<{ signature: Hex; authorization: ExactEvmAuthorization }>;
  discover(filters?: {
    categoryFamily?: CategoryFamily;
    serviceType?: ServiceType;
    jurisdiction?: string;
    fulfillmentMode?: FulfillmentMode;
    maxPrice?: number;
  }): Promise<{ status: number; json: any }>;
  queueSettlementSuccess(args: {
    txHash: Hex;
    paymentId: bigint;
    serviceRef: Hex;
    providerAgentId: bigint;
    buyerAgentId: bigint;
    totalAmount: bigint;
  }): void;
  registerProvider(def: TestProviderDef): void;
  refresh(): Promise<void>;
  close(): Promise<void>;
}

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export async function startTestGateway(opts: TestGatewayOptions = {}): Promise<TestGateway> {
  const mockProvider = await startMockProvider({
    agentCards: {},
    initialTaskState: opts.initialTaskState,
  });

  const mockChain = new MockChainReader();
  const providers = opts.providers ?? [];
  const whitelist: bigint[] = [];

  for (const def of providers) {
    _installProvider(mockChain, mockProvider, def);
    whitelist.push(def.tokenId);
  }

  const config: Config = {
    nodeEnv: "test",
    chainMode: "live",
    trustProxy: 0,
    challengeRetentionSeconds: 7 * 24 * 60 * 60,
    rpcReadMaxPerMinute: 1_000,
    stateChangeGlobalMaxPerMinute: 1_000,
    mcpGlobalMaxPerMinute: 1_000,
    publicReadMaxPerMinute: 1_000,
    publicReadGlobalMaxPerMinute: 1_000,
    publicCacheMaxEntries: 1_000,
    discoveryMaxA2AEntries: 16,
    discoveryFetchConcurrency: 4,
    discoveryRefreshDeadlineMs: 30_000,
    mockProviderWalletAddress: "0x1111111111111111111111111111111111111111",
    mockProviderAgentId: 1n,
    mockProviderAgentUri: "http://localhost:4040/.well-known/agent.json",
    mockBuyerAgentId: 99n,
    port: 0,
    mcpEnabled: true,
    mcpPath: "/mcp",
    baseRpcUrl: "http://127.0.0.1:0",
    chainId: CHAIN_ID,
    network: "base-sepolia",
    identityRegistryAddress: IDENTITY_REGISTRY_ADDRESS,
    agentIndexAddress: AGENT_INDEX_ADDRESS,
    providerRegistryAddress: REGISTRY_ADDRESS,
    serviceRegistryAddress: SERVICE_REGISTRY_ADDRESS,
    paymentRouterAddress: PAYMENT_ROUTER_ADDRESS,
    x402AdapterAddress: X402_ADAPTER_ADDRESS,
    usdcAddress: USDC_ADDRESS,
    usdcName: "USDC",
    usdcVersion: "2",
    facilitatorPrivateKey: FACILITATOR_KEY,
    whitelistedAgentIds: whitelist,
    cacheRefreshIntervalSeconds: 60,
    cacheMaxStalenessSeconds: 86400,
    challengeTtlSeconds: 3600,
    databaseUrl: TEST_DATABASE_URL,
    publicUrl: "http://127.0.0.1:0",
    marketplaceTermsUrl: "https://daski.io/terms-of-use",
    marketplacePrivacyUrl: "https://daski.io/privacy-policy",
    easAddress: EAS_ADDRESS,
    easConfirmationSchemaUid: EAS_CONFIRMATION_SCHEMA_UID,
    easOutcomeSchemaUid: EAS_OUTCOME_SCHEMA_UID,
    ipfsGatewayUrl: "https://ipfs.io/ipfs/",
    // Bazaar rail — never hit over the network in tests; routes are only
    // mounted when configOverrides also sets directAdapterAddress, and
    // those tests inject externalFacilitatorFetch.
    externalFacilitatorUrl: "http://external-facilitator.test",
    ...opts.configOverrides,
  };

  const schemaName = `gw_test_${randomUUID().replace(/-/g, "_")}`;
  // Bootstrap pool talks to the default schema (public) just to create
  // the per-test schema. We then point the app pool at the new schema.
  const bootstrap = createPool({ connectionString: TEST_DATABASE_URL });
  await bootstrap.query(`CREATE SCHEMA "${schemaName}"`);
  await bootstrap.end();

  const pool: Pool = createPool({
    connectionString: TEST_DATABASE_URL,
    // Include `public` so the test schema can resolve the pgvector type
    // (the extension is installed in `public` by the migration). Tables
    // created without an explicit schema land in the test schema (first
    // match wins) so per-test isolation is preserved.
    searchPath: `${schemaName},public`,
  });

  // Default stub for the buyer-side agentURI fetcher used by
  // /register-prep + /register-transaction. Returns `{ name: "buyer-test" }` for any
  // URI tests don't otherwise care about, lets ipfs:// and https:// URIs
  // pass without going to the network. Tests that need to assert on the
  // resolved name should override the test gateway's `buyerAgentCardFetch`
  // before calling the route. (data: URIs are decoded inline by
  // fetch-agent-card itself and never hit this stub.)
  const buyerAgentCardFetch =
    opts.buyerAgentCardFetch ??
    (async () =>
      new Response(JSON.stringify({ name: "buyer-test" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
  const localProviderFetch = (input: string | URL | Request, init?: RequestInit) =>
    fetch(input, init);

  const bundle = await createApp({
    config,
    reader: mockChain,
    pool,
    embedder: opts.embedder ?? stubEmbedder(),
    startCacheRefreshLoop: false,
    agentCardFetch: localProviderFetch,
    agentCardFetchTimeoutMs: 2000,
    a2aFetch: opts.a2aFetch ?? localProviderFetch,
    buyerAgentCardFetch,
    externalFacilitatorFetch: opts.externalFacilitatorFetch,
  });

  await bundle.cache.refresh();

  const httpServer: Server = await new Promise((resolve) => {
    const s = bundle.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const addr = httpServer.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  config.publicUrl = baseUrl;

  const buyerAccount = privateKeyToAccount(TEST_BUYER_KEY);
  mockChain.setAgentOwner(5n, buyerAccount.address.toLowerCase() as Hex);
  const requirementsByProvider = new Map<string, Record<string, unknown>>();

  async function signAuthorization(
    value: bigint,
    nonce: Hex,
    opts?: { validAfter?: bigint; validBefore?: bigint },
  ) {
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const validAfter = opts?.validAfter ?? 0n;
    const validBefore = opts?.validBefore ?? nowSec + 3600n;
    const authorization: ExactEvmAuthorization = {
      from: buyerAccount.address.toLowerCase() as Hex,
      to: PAYMENT_ROUTER_ADDRESS,
      value: value.toString(),
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce,
    };
    const signature = (await buyerAccount.signTypedData({
      domain: {
        name: "USDC",
        version: "2",
        chainId: CHAIN_ID,
        verifyingContract: USDC_ADDRESS,
      },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from,
        to: authorization.to,
        value,
        validAfter,
        validBefore,
        nonce,
      },
    })) as Hex;
    return { signature, authorization };
  }

  const gateway: TestGateway = {
    bundle,
    httpServer,
    baseUrl,
    config,
    mockChain,
    mockProvider,
    buyerAddress: buyerAccount.address.toLowerCase() as Hex,

    async purchaseChallenge(tokenId, body) {
      // Default the walletAddress to the test buyer so existing tests don't
      // have to pass it; tests that exercise validation override explicitly.
      // Default the skillId to "default-service" — post-service-identity-refactor
      // the gateway requires a non-empty skillId to derive serviceId. Tests
      // that don't care about which skill they're paying for get a stable
      // default; tests that specifically want to omit skillId can pass
      // `skillId: undefined` explicitly (the merge below preserves the
      // omission via `hasOwnProperty`).
      const merged: Record<string, unknown> = {
        walletAddress: buyerAccount.address.toLowerCase(),
        skillId: "default-service",
        ...body,
      };
      const requestedSkillId = merged.skillId;
      const cachedProvider = bundle.cache.get(tokenId);
      if (cachedProvider && typeof requestedSkillId === "string") {
        if (!Object.prototype.hasOwnProperty.call(body, "serviceSlug")) {
          const selectedCard =
            cachedProvider.cards.find((card) => {
              const skills = card.agentCard.skills;
              return (
                Array.isArray(skills) &&
                skills.some(
                  (skill) =>
                    skill !== null &&
                    typeof skill === "object" &&
                    (skill as Record<string, unknown>).id === requestedSkillId,
                )
              );
            }) ?? cachedProvider.cards[0];
          if (selectedCard) merged.serviceSlug = selectedCard.serviceSlug;
        }
        const cards = new Set<Record<string, unknown>>(
          cachedProvider.cards
            .filter((card) => card.serviceSlug === merged.serviceSlug)
            .map((card) => card.agentCard),
        );
        for (const card of cards) {
          const listed = Array.isArray(card.skills) ? card.skills : [];
          if (
            !listed.some(
              (skill) =>
                skill !== null &&
                typeof skill === "object" &&
                (skill as Record<string, unknown>).id === requestedSkillId,
            )
          ) {
            listed.push({
              id: requestedSkillId,
              name: requestedSkillId,
              description: `${requestedSkillId} test skill`,
              metadata: {
                [DASKI_A2A_EXTENSION_URI]: {
                  fulfillmentMode: "automated",
                },
              },
            });
          }
          card.skills = listed;
        }
      }
      if (!Object.prototype.hasOwnProperty.call(body, "providerQuote")) {
        const skillId = merged.skillId;
        const serviceArgs = merged.serviceArgs ?? {};
        if (
          typeof skillId === "string" &&
          serviceArgs !== null &&
          typeof serviceArgs === "object" &&
          !Array.isArray(serviceArgs)
        ) {
          const resolved = resolveSkillOffer(tokenId, skillId, bundle.cache, {
            serviceSlug: String(merged.serviceSlug),
          });
          if (resolved.ok) {
            const quoteResponse = await fetch(
              `${mockProvider.baseUrl}/quote/${encodeURIComponent(resolved.offer.serviceSlug)}`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ skillId, serviceArgs }),
              },
            );
            const quoteBody = (await quoteResponse.json()) as {
              quote?: Record<string, unknown>;
            };
            if (quoteBody.quote) merged.providerQuote = quoteBody.quote;
          }
        }
      }
      const res = await fetch(`${baseUrl}/purchase/${tokenId.toString()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(merged),
      });
      const json = (await res.json()) as any;
      let serviceRef: Hex | undefined;
      let maxAmountRequired: string | undefined;
      let payTo: Hex | undefined;
      const accepts = json?.accepts;
      if (Array.isArray(accepts) && accepts.length > 0) {
        const req = accepts[0];
        serviceRef = req?.extra?.daski?.serviceRef;
        maxAmountRequired = req?.maxAmountRequired;
        payTo = req?.payTo;
        requirementsByProvider.set(tokenId.toString(), req);
      }
      return { status: res.status, json, serviceRef, maxAmountRequired, payTo };
    },

    async purchaseSettle(tokenId, payload, serviceRef) {
      const requirements =
        requirementsByProvider.get(tokenId.toString()) ??
        (serviceRef ? { extra: { daski: { serviceRef } } } : undefined);
      const res = await fetch(`${baseUrl}/settle`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          paymentPayload: payload,
          paymentRequirements: requirements,
        }),
      });
      const json = await res.json();
      return { status: res.status, json };
    },

    signAuthorization,

    async discover(filters = {}) {
      const params = new URLSearchParams();
      if (filters.categoryFamily !== undefined)
        params.set("categoryFamily", filters.categoryFamily);
      if (filters.serviceType !== undefined) params.set("serviceType", filters.serviceType);
      if (filters.jurisdiction !== undefined) params.set("jurisdiction", filters.jurisdiction);
      if (filters.fulfillmentMode !== undefined)
        params.set("fulfillmentMode", filters.fulfillmentMode);
      if (filters.maxPrice !== undefined) params.set("maxPrice", String(filters.maxPrice));
      const url = params.size > 0 ? `${baseUrl}/discover?${params}` : `${baseUrl}/discover`;
      const res = await fetch(url);
      const json = await res.json();
      return { status: res.status, json };
    },

    queueSettlementSuccess(args) {
      const event: PaymentSettledEvent = makePaymentSettledEvent({
        paymentId: args.paymentId,
        serviceRef: args.serviceRef,
        buyerAgentId: args.buyerAgentId,
        providerAgentId: args.providerAgentId,
        totalAmount: args.totalAmount,
        token: USDC_ADDRESS,
      });
      mockChain.queueSettlement({
        kind: "success",
        event,
        txHash: args.txHash,
      });
    },

    registerProvider(def) {
      _installProvider(mockChain, mockProvider, def);
      if (!config.whitelistedAgentIds.includes(def.tokenId)) {
        config.whitelistedAgentIds.push(def.tokenId);
      }
    },

    async refresh() {
      await bundle.cache.refresh();
    },

    async close() {
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
      await bundle.shutdown();
      try {
        await pool.end();
      } catch {
        // ignore
      }
      const cleanup = createPool({ connectionString: TEST_DATABASE_URL });
      try {
        await cleanup.query(`DROP SCHEMA "${schemaName}" CASCADE`);
      } catch {
        // ignore — best-effort
      }
      await cleanup.end();
      await mockProvider.close();
    },
  };

  return gateway;
}

function _installProvider(
  mockChain: MockChainReader,
  mockProvider: MockProviderHandle,
  def: TestProviderDef,
): void {
  const cardPath = def.cardPath ?? `/agent-cards/${def.tokenId}.json`;
  const a2aPath = def.a2aPath ?? "/a2a";
  const a2aUrl = `${mockProvider.baseUrl}${a2aPath}`;
  const registrationPath = `/agent-registrations/${def.tokenId}.json`;
  const agentURI = `${mockProvider.baseUrl}${registrationPath}`;
  mockChain.addProvider(def.tokenId, {
    walletAddress: def.walletAddress ?? mockProvider.walletAddress,
    agentId: def.tokenId,
    agentURI,
    registrationTime: 1n,
    isActive: true,
  });

  const skills = (def.skills ?? [{ id: "default-service", metadata: {} }]).map((s) => ({
    id: s.id,
    name: s.name ?? s.id,
    description: s.description ?? `${s.id} skill`,
    metadata: {
      [DASKI_A2A_EXTENSION_URI]: {
        fulfillmentMode: "automated",
        ...(s.metadata ?? {}),
      },
    },
  }));

  mockProvider.setAgentCard(
    cardPath,
    buildAgentCard({
      name: def.name,
      a2aUrl,
      priceUsdcSmallest: def.priceUsdcSmallest,
      categoryFamily: def.categoryFamily,
      serviceType: def.serviceType,
      jurisdictions: def.jurisdictions,
      registryAddress: REGISTRY_ADDRESS,
      paymentRouterAddress: PAYMENT_ROUTER_ADDRESS,
      chainId: CHAIN_ID,
      description: def.description,
      skipExtension: def.skipExtension,
      legal: def.legal,
      skills,
    }),
  );
  const legal =
    def.legal === undefined
      ? {
          legalName: "Example Provider, LLC",
          termsUrl: "https://provider.example/terms",
          privacyUrl: "https://provider.example/privacy",
        }
      : def.legal;
  mockProvider.setAgentCard(registrationPath, {
    name: def.name,
    description: def.description ?? `${def.name} provider`,
    ...(legal ?? {}),
    services: [
      {
        name: "A2A",
        endpoint: `${mockProvider.baseUrl}${cardPath}`,
      },
    ],
  });

  // Default quote outcome — gateway's daski_buy_service calls /quote
  // before issuing PaymentRequirements. Match the agent-card's
  // priceUsdcSmallest by default so tests that don't care about quote
  // semantics just work; tests that do can override per-skill.
  mockProvider.setQuoteOutcome("*", {
    ok: true,
    amount: BigInt(def.priceUsdcSmallest),
  });
}
