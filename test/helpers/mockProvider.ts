import express, { type Express } from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalJsonStringify, computeRequestHash } from "../../src/auth/envelope.js";
import { DASKI_A2A_EXTENSION_URI } from "../../src/config.js";
import type {
  CategoryFamily,
  ServiceType,
} from "../../src/serviceTaxonomy.js";
import {
  PROVIDER_QUOTE_VERSION,
  type ProviderQuoteCommitment,
} from "../../src/payment/providerQuote.js";
import type { Hex } from "../../src/types.js";

const MOCK_PROVIDER_PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const MOCK_PROVIDER_ACCOUNT = privateKeyToAccount(MOCK_PROVIDER_PRIVATE_KEY);
export const MOCK_PROVIDER_WALLET_ADDRESS =
  MOCK_PROVIDER_ACCOUNT.address.toLowerCase() as Hex;
export const MOCK_PROVIDER_TOKEN_ADDRESS =
  "0x000000000000000000000000000000000000a003" as Hex;
export const MOCK_PROVIDER_CHAIN_ID = 84532;

export interface MockProviderOptions {
  agentCards: Record<string, Record<string, unknown>>; // path -> agent card
  initialTaskState?: MockTaskState;
}

export interface MockTaskState {
  id: string;
  state:
    | "submitted"
    | "working"
    | "input-required"
    | "completed"
    | "failed"
    | "canceled";
  message?: {
    role: "agent" | "user";
    parts: Array<{ type: string; text?: string }>;
  };
  artifacts?: Array<{
    name: string;
    parts: Array<{
      type: string;
      text?: string;
      file?: { url?: string; bytes?: string; name?: string; mimeType?: string };
      data?: unknown;
    }>;
  }>;
}

const TASK_STATE_TO_PROTO = {
  submitted: "TASK_STATE_SUBMITTED",
  working: "TASK_STATE_WORKING",
  "input-required": "TASK_STATE_INPUT_REQUIRED",
  completed: "TASK_STATE_COMPLETED",
  failed: "TASK_STATE_FAILED",
  canceled: "TASK_STATE_CANCELED",
} as const satisfies Record<MockTaskState["state"], string>;

function protoTaskState(state: MockTaskState["state"]): string {
  return TASK_STATE_TO_PROTO[state];
}

function protoMessage(
  message: MockTaskState["message"] | undefined,
): Record<string, unknown> | undefined {
  if (!message) return undefined;
  return {
    ...message,
    role: message.role === "agent" ? "ROLE_AGENT" : "ROLE_USER",
    parts: message.parts.map(protoPart),
  };
}

function protoPart(part: unknown): unknown {
  if (!part || typeof part !== "object" || Array.isArray(part)) return part;
  const { type, ...current } = part as Record<string, unknown>;
  return {
    ...current,
    ...(typeof current.kind !== "string" && typeof type === "string"
      ? { kind: type }
      : {}),
  };
}

function protoArtifacts(artifacts: unknown[]): unknown[] {
  return artifacts.map((artifact) => {
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
      return artifact;
    }
    const current = artifact as Record<string, unknown>;
    return {
      ...current,
      ...(Array.isArray(current.parts)
        ? { parts: current.parts.map(protoPart) }
        : {}),
    };
  });
}

/// Per-skill quote outcome the mock provider returns for /quote requests.
/// Tests can scope by skillId (default applies to all). When unset, the
/// mock returns ok=true with amount=0 (free skills) — matches the
/// real provider's behaviour for non-paid skills.
///
/// Paid outcomes (amount > 0) also mint a signed-quote commitment like the
/// real provider (audit 1.1): the canonical payload is hashed for serviceRef
/// and signed with the mock provider's EIP-191 key. Tests read commitments
/// via getIssuedQuotes() to assert the gateway adopted quote.serviceRef
/// verbatim and forwarded quoteId/quoteSignature at task-submit time.
/// Set `omitCommitment: true` to impersonate a pre-audit-1.1 provider.
export type MockQuoteOutcome =
  | {
      ok: true;
      amount: bigint;
      currency?: "USDC";
      notes?: string[];
      omitCommitment?: boolean;
      /** Override the quote TTL (default 120s, like the real provider). */
      ttlMs?: number;
      /** Override the Agent Card-derived slug, including with a bad value. */
      serviceSlug?: string;
      /** Override the Agent Card-derived service version. */
      serviceVersion?: string;
      /** provider-quote-v2 supplier cost ceiling; null/omitted = none. */
      supplierCostCeiling?: Record<string, unknown> | null;
    }
  | {
      ok: false;
      errors: Array<{ field: string; code: string; message: string }>;
    };

/// Commitment shape the mock's /quote mints for paid outcomes. Mirrors
/// the wire fields the gateway consumes from ProviderQuoteCommitment.
export interface MockIssuedQuote extends ProviderQuoteCommitment {
  serviceArgs: Record<string, unknown>;
}

export interface MockProviderHandle {
  url: string;
  baseUrl: string;
  /** Wallet registered on the mock chain and used to sign provider quotes. */
  walletAddress: Hex;
  setAgentCard(path: string, card: Record<string, unknown>): void;
  setTaskState(state: MockTaskState): void;
  setShouldHang(hang: boolean): void;
  setNextA2AError(
    err: { code: number; message: string; data?: unknown } | null,
  ): void;
  /// Set the quote outcome for a specific skillId (or pass skillId="*" to
  /// match anything not otherwise scoped). Default is { ok:true, amount:0 }.
  setQuoteOutcome(skillId: string, outcome: MockQuoteOutcome): void;
  /// When set, message/send returns a terminal "completed" task inline
  /// (mirrors the real provider's open-free skill behaviour) — or, when
  /// `state` is set, that state (e.g. "input-required" for capability
  /// challenges). Pass null to revert to the default submitted-state
  /// response.
  setSyncResult(
    result: {
      id?: string;
      state?: MockTaskState["state"];
      statusMessage?: { role: "agent"; parts: Array<{ type: string; text?: string }> };
      artifacts?: unknown[];
    } | null,
  ): void;
  /// Per-domain availability response. Pass domain="*" for the default.
  setAvailabilityOutcome(
    domain: string,
    outcome: { domain: string; available: boolean; price?: number; currency?: string },
  ): void;
  /// The JSON-RPC body of the last message/send (SendMessage) request the
  /// mock received — lets tests assert what the gateway forwarded
  /// (e.g. metadata.taskId routing for task input).
  getLastSendBody(): Record<string, unknown> | null;
  /// Every signed-quote commitment the mock /quote endpoint minted, in
  /// issue order. Tests assert the gateway adopted the last one's
  /// serviceRef / forwarded its quoteId + providerSignature.
  getIssuedQuotes(): MockIssuedQuote[];
  close(): Promise<void>;
}

/**
 * Starts an Express server that impersonates a provider for tests:
 *   - GET /{cardPath}     returns a registered Agent Card JSON
 *   - POST /a2a           handles JSON-RPC tasks/get and message/send
 *
 * The server is single-instance per test file; individual tests mutate its
 * state via the returned handle.
 */
export async function startMockProvider(
  opts: MockProviderOptions,
): Promise<MockProviderHandle> {
  const app: Express = express();
  app.use(express.json());

  const cards: Record<string, Record<string, unknown>> = { ...opts.agentCards };
  let taskState: MockTaskState =
    opts.initialTaskState ?? {
      id: "task-default-1",
      state: "completed",
      message: {
        role: "agent",
        parts: [{ type: "text", text: "Task completed" }],
      },
    };

  let shouldHang = false;
  let lastSendBody: Record<string, unknown> | null = null;
  let nextA2AError: { code: number; message: string; data?: unknown } | null =
    null;
  let syncResult: {
    id?: string;
    state?: MockTaskState["state"];
    statusMessage?: { role: "agent"; parts: Array<{ type: string; text?: string }> };
    artifacts?: unknown[];
  } | null = null;
  const quoteOutcomes = new Map<string, MockQuoteOutcome>();
  const availabilityOutcomes = new Map<string, {
    domain: string;
    available: boolean;
    price?: number;
    currency?: string;
  }>();

  // Agent card serving: one generic handler that looks up the path.
  app.use((req, res, next) => {
    if (req.method !== "GET") {
      next();
      return;
    }
    const card = cards[req.path];
    if (card) {
      res.json(card);
      return;
    }
    next();
  });

  // Quote endpoint: gateway calls this BEFORE issuing PaymentRequirements
  // to get live pricing + pre-validate user input. Match both /quote and
  // /quote/<slug> shapes. Paid quotes use the same commitment derivation
  // and EIP-191 signing contract as the real provider.
  const issuedQuotes: MockIssuedQuote[] = [];
  let quoteCounter = 0;
  function serviceBinding(skillId: string): {
    serviceSlug: string;
    serviceVersion: string;
  } | null {
    for (const card of Object.values(cards)) {
      const skills = card.skills;
      const listed =
        Array.isArray(skills) &&
        skills.some(
          (skill) =>
            skill !== null &&
            typeof skill === "object" &&
            (skill as Record<string, unknown>).id === skillId,
        );
      if (!listed) continue;
      const extensions = card.extensions;
      const daski =
        extensions && typeof extensions === "object"
          ? (extensions as Record<string, unknown>)[DASKI_A2A_EXTENSION_URI]
          : null;
      let metadata: Record<string, unknown> | null = null;
      if (daski && typeof daski === "object") {
        const skillMap = (daski as Record<string, unknown>).skills;
        const mapped =
          skillMap && typeof skillMap === "object" && !Array.isArray(skillMap)
            ? (skillMap as Record<string, unknown>)[skillId]
            : null;
        if (mapped && typeof mapped === "object") {
          metadata = mapped as Record<string, unknown>;
        }
      }
      return {
        serviceSlug:
          typeof metadata?.serviceSlug === "string" && metadata.serviceSlug
            ? metadata.serviceSlug
            : skillId,
        serviceVersion:
          typeof (metadata?.serviceVersion ?? metadata?.version) === "string" &&
          (metadata?.serviceVersion ?? metadata?.version)
            ? ((metadata?.serviceVersion ?? metadata?.version) as string)
            : "1",
      };
    }
    return null;
  }

  const quoteHandler = async (
    req: express.Request,
    res: express.Response,
  ) => {
    const skillId = (req.body?.skillId as string | undefined) ?? "";
    const serviceArgs =
      req.body?.serviceArgs && typeof req.body.serviceArgs === "object"
        ? (req.body.serviceArgs as Record<string, unknown>)
        : {};
    const routeSlug =
      (req.params as Record<string, string | undefined>).serviceSlug ?? null;
    const outcome =
      quoteOutcomes.get(skillId) ??
      quoteOutcomes.get("*") ??
      ({ ok: true as const, amount: 0n });
    if (!outcome.ok) {
      res.status(200).json({ ok: false, errors: outcome.errors, skillId });
      return;
    }
    if (outcome.amount <= 0n) {
      // Free skill — the real provider returns paymentRequired:false and
      // no commitment.
      res.json({
        ok: true,
        amount: outcome.amount.toString(),
        currency: outcome.currency ?? "USDC",
        notes: outcome.notes ?? [],
        skillId,
        paymentRequired: false,
      });
      return;
    }
    if (outcome.omitCommitment) {
      // Impersonate a pre-audit-1.1 provider: paid amount, no commitment.
      res.json({
        ok: true,
        amount: outcome.amount.toString(),
        currency: outcome.currency ?? "USDC",
        notes: outcome.notes ?? [],
        skillId,
        paymentRequired: true,
      });
      return;
    }
    quoteCounter += 1;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (outcome.ttlMs ?? 120_000));
    const binding = serviceBinding(skillId);
    const serviceSlug =
      outcome.serviceSlug ?? binding?.serviceSlug ?? routeSlug ?? skillId;
    const serviceVersion =
      outcome.serviceVersion ?? binding?.serviceVersion ?? "1";
    const signedPayload = {
      quoteId: `mock-quote-${quoteCounter}`,
      serviceId: `mock-service-row:${serviceSlug}`,
      serviceSlug,
      serviceVersion,
      skillId,
      requestHash: computeRequestHash(serviceArgs),
      trustedRequestCountryHash: null,
      amount: outcome.amount.toString(),
      token: MOCK_PROVIDER_TOKEN_ADDRESS,
      chainId: MOCK_PROVIDER_CHAIN_ID,
      quoteVersion: PROVIDER_QUOTE_VERSION,
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      supplierCostCeiling: outcome.supplierCostCeiling ?? null,
    } satisfies Omit<
      ProviderQuoteCommitment,
      "serviceRef" | "providerSignature" | "signerAddress" | "signingKeyId"
    >;
    const message = canonicalJsonStringify(signedPayload);
    const commitment: ProviderQuoteCommitment = {
      ...signedPayload,
      serviceRef: keccak256(toBytes(message)),
      providerSignature: (await MOCK_PROVIDER_ACCOUNT.signMessage({
        message,
      })) as Hex,
      signerAddress: MOCK_PROVIDER_WALLET_ADDRESS,
      signingKeyId: `provider-wallet-v1:${MOCK_PROVIDER_WALLET_ADDRESS}`,
    };
    const quote: MockIssuedQuote = {
      ...commitment,
      serviceArgs,
    };
    issuedQuotes.push(quote);
    res.json({
      ok: true,
      amount: outcome.amount.toString(),
      currency: outcome.currency ?? "USDC",
      notes: outcome.notes ?? [],
      skillId,
      paymentRequired: true,
      quote: commitment,
    });
  };
  app.post("/quote", quoteHandler);
  app.post("/quote/:serviceSlug", quoteHandler);

  // Synchronous availability endpoint — mirrors real provider's
  // /availability/:serviceSlug. Tests can override the response by
  // calling setAvailabilityOutcome.
  const availabilityHandler = (req: express.Request, res: express.Response) => {
    const domain = (req.body?.domain as string | undefined) ?? "";
    if (!domain) {
      res.status(400).json({ error: { code: "BAD_DOMAIN", message: "domain required" } });
      return;
    }
    const outcome = availabilityOutcomes.get(domain) ??
      availabilityOutcomes.get("*") ?? {
        domain,
        available: true,
        price: 9.99,
        currency: "USD",
      };
    res.json(outcome);
  };
  app.post("/availability", availabilityHandler);
  app.post("/availability/:serviceSlug", availabilityHandler);

  // A2A JSON-RPC endpoint
  app.post("/a2a", async (req, res) => {
    if (shouldHang) {
      // Never respond — used to test client-side timeouts.
      return;
    }
    const body = req.body;
    const rpcId = body?.id ?? null;
    if (nextA2AError) {
      const err = nextA2AError;
      nextA2AError = null;
      res.json({ jsonrpc: "2.0", id: rpcId, error: err });
      return;
    }
    if (body?.method === "GetTask") {
      res.json({
        jsonrpc: "2.0",
        id: rpcId,
        result: {
          id: taskState.id,
          status: {
            state: protoTaskState(taskState.state),
            message: protoMessage(taskState.message),
          },
          artifacts: protoArtifacts(taskState.artifacts ?? []),
        },
      });
      return;
    }
    if (body?.method === "SendMessage") {
      lastSendBody = body as Record<string, unknown>;
      // Synchronous-completion path (mirrors real provider's open-free
      // skill handler): when configured, the mock returns a fully
      // terminal task with artifacts inline on this single call. Tests
      // exercising daski_submit_task's pass-through behaviour set this.
      if (syncResult) {
        res.json({
          jsonrpc: "2.0",
          id: rpcId,
          result: {
            id: syncResult.id ?? "qa-mock-1",
            status: {
              state: protoTaskState(syncResult.state ?? "completed"),
              message: protoMessage(syncResult.statusMessage),
            },
            artifacts: protoArtifacts(syncResult.artifacts ?? []),
          },
        });
        return;
      }
      res.json({
        jsonrpc: "2.0",
        id: rpcId,
        result: {
          id: taskState.id,
          status: {
            state: "TASK_STATE_SUBMITTED",
            message: {
              role: "ROLE_AGENT",
              parts: [{ kind: "text", text: "Task received" }],
            },
          },
        },
      });
      return;
    }
    res.status(400).json({
      jsonrpc: "2.0",
      id: rpcId,
      error: { code: -32601, message: "Method not found" },
    });
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    url: baseUrl,
    baseUrl,
    walletAddress: MOCK_PROVIDER_WALLET_ADDRESS,
    setAgentCard(path, card) {
      cards[path] = card;
    },
    setTaskState(state) {
      taskState = state;
    },
    setShouldHang(hang) {
      shouldHang = hang;
    },
    setNextA2AError(err) {
      nextA2AError = err;
    },
    setQuoteOutcome(skillId, outcome) {
      quoteOutcomes.set(skillId, outcome);
    },
    setSyncResult(result) {
      syncResult = result;
    },
    setAvailabilityOutcome(domain, outcome) {
      availabilityOutcomes.set(domain, outcome);
    },
    getLastSendBody() {
      return lastSendBody;
    },
    getIssuedQuotes() {
      return issuedQuotes;
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

// Builds an Agent Card with the daski marketplace extension.
export interface BuildAgentCardOpts {
  name: string;
  a2aUrl: string;
  priceUsdcSmallest: string;
  categoryFamily: CategoryFamily;
  serviceType: ServiceType;
  jurisdictions?: string[];
  description?: string;
  registryAddress: `0x${string}`;
  paymentRouterAddress: `0x${string}`;
  chainId: 8453 | 84532 | 31337;
  turnaround?: string;
  serviceLifecycle?: "one-shot" | "ongoing";
  variablePricing?: boolean;
  artifactOrigins?: string[];
  skipExtension?: boolean;
  legal?: {
    legalName?: unknown;
    termsUrl?: unknown;
    privacyUrl?: unknown;
  } | null;
  skills?: Array<{
    id: string;
    name: string;
    description: string;
    metadata: Record<string, unknown>;
  }>;
}

export function buildAgentCard(
  o: BuildAgentCardOpts,
): Record<string, unknown> {
  const skillDefinitions =
    o.skills ??
    [
      {
        id: "default-service",
        name: "Default Service",
        description: "Default service skill",
        metadata: {
          [DASKI_A2A_EXTENSION_URI]: {
            fulfillmentMode: "automated",
          },
        },
      },
    ];
  const card: Record<string, unknown> = {
    name: o.name,
    description: o.description ?? `${o.name} provider`,
    supportedInterfaces: [
      {
        url: o.a2aUrl,
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
      },
    ],
    skills: skillDefinitions.map(({ id, name, description }) => ({
      id,
      name,
      description,
    })),
  };
  const legal =
    o.legal === undefined
      ? {
          legalName: "Example Provider, LLC",
          termsUrl: "https://provider.example/terms",
          privacyUrl: "https://provider.example/privacy",
        }
      : o.legal;
  if (legal !== null) Object.assign(card, legal);
  if (!o.skipExtension) {
    card.extensions = {
      [DASKI_A2A_EXTENSION_URI]: {
        pricing: {
          baseAmount: o.priceUsdcSmallest,
          currency: "USDC",
          variablePricing: o.variablePricing ?? false,
          billingModel: "one-time",
        },
        onChainReferences: {
          registryAddress: o.registryAddress,
          paymentRouterAddress: o.paymentRouterAddress,
          chainId: o.chainId,
        },
        categoryFamily: o.categoryFamily,
        serviceType: o.serviceType,
        jurisdictions: o.jurisdictions ?? ["global"],
        serviceDescription: o.description ?? `${o.name} description`,
        serviceLifecycle: o.serviceLifecycle ?? "one-shot",
        turnaroundEstimate: o.turnaround ?? "PT10M",
        ...(o.artifactOrigins ? { artifactOrigins: o.artifactOrigins } : {}),
        skills: Object.fromEntries(
          skillDefinitions.map((skill) => {
            const metadata = skill.metadata[DASKI_A2A_EXTENSION_URI];
            const current =
              metadata && typeof metadata === "object"
                ? (metadata as Record<string, unknown>)
                : {};
            return [
              skill.id,
              {
                ...current,
                serviceSlug:
                  typeof current.serviceSlug === "string"
                    ? current.serviceSlug
                    : o.serviceType,
              },
            ];
          }),
        ),
      },
    };
  }
  return card;
}
