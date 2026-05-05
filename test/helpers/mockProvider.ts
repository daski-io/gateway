import express, { type Express } from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DASKI_A2A_EXTENSION_URI } from "../../src/config.js";

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
      file?: { url: string; mimeType?: string };
      data?: unknown;
    }>;
  }>;
}

/// Per-skill quote outcome the mock provider returns for /quote requests.
/// Tests can scope by skillId (default applies to all). When unset, the
/// mock returns ok=true with amount=0 (free skills) — matches the
/// real provider's behaviour for non-paid skills.
export type MockQuoteOutcome =
  | { ok: true; amount: bigint; currency?: "USDC"; notes?: string[] }
  | {
      ok: false;
      errors: Array<{ field: string; code: string; message: string }>;
    };

export interface MockProviderHandle {
  url: string;
  baseUrl: string;
  setAgentCard(path: string, card: Record<string, unknown>): void;
  setTaskState(state: MockTaskState): void;
  setShouldHang(hang: boolean): void;
  setNextA2AError(err: { code: number; message: string } | null): void;
  /// Set the quote outcome for a specific skillId (or pass skillId="*" to
  /// match anything not otherwise scoped). Default is { ok:true, amount:0 }.
  setQuoteOutcome(skillId: string, outcome: MockQuoteOutcome): void;
  /// When set, message/send returns a fully terminal "completed" task
  /// inline (mirrors the real provider's open-free skill behaviour).
  /// Pass null to revert to the default submitted-state response.
  setSyncResult(
    result: {
      id?: string;
      statusMessage?: { role: "agent"; parts: Array<{ type: string; text?: string }> };
      artifacts?: unknown[];
    } | null,
  ): void;
  /// Per-domain availability response. Pass domain="*" for the default.
  setAvailabilityOutcome(
    domain: string,
    outcome: { domain: string; available: boolean; price?: number; currency?: string },
  ): void;
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
  let nextA2AError: { code: number; message: string } | null = null;
  let syncResult: {
    id?: string;
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
  app.get("*", (req, res, next) => {
    const card = cards[req.path];
    if (card) {
      res.json(card);
      return;
    }
    next();
  });

  // Quote endpoint: gateway calls this BEFORE issuing PaymentRequirements
  // to get live pricing + pre-validate user input. Match both /quote and
  // /quote/<slug> shapes.
  const quoteHandler = (req: express.Request, res: express.Response) => {
    const skillId = (req.body?.skillId as string | undefined) ?? "";
    const outcome =
      quoteOutcomes.get(skillId) ??
      quoteOutcomes.get("*") ??
      ({ ok: true as const, amount: 0n });
    if (!outcome.ok) {
      res.status(200).json({ ok: false, errors: outcome.errors, skillId });
      return;
    }
    res.json({
      ok: true,
      amount: outcome.amount.toString(),
      currency: outcome.currency ?? "USDC",
      notes: outcome.notes ?? [],
      skillId,
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
    if (body?.method === "tasks/get" || body?.method === "GetTask") {
      res.json({
        jsonrpc: "2.0",
        id: rpcId,
        result: {
          id: taskState.id,
          status: {
            state: taskState.state,
            message: taskState.message,
          },
          artifacts: taskState.artifacts ?? [],
        },
      });
      return;
    }
    if (body?.method === "message/send" || body?.method === "SendMessage") {
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
              state: "completed",
              message: syncResult.statusMessage,
            },
            artifacts: syncResult.artifacts ?? [],
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
            state: "submitted",
            message: {
              role: "agent",
              parts: [{ type: "text", text: "Task received" }],
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
  category: string;
  description?: string;
  registryAddress: `0x${string}`;
  paymentRouterAddress: `0x${string}`;
  erc8004TokenId: string;
  chainId: 8453 | 84532 | 31337;
  turnaround?: string;
  serviceLifecycle?: "one-shot" | "ongoing";
  variablePricing?: boolean;
  skipExtension?: boolean;
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
  const card: Record<string, unknown> = {
    name: o.name,
    description: o.description ?? `${o.name} provider`,
    url: o.a2aUrl,
    skills: o.skills ?? [],
  };
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
          erc8004TokenId: o.erc8004TokenId,
          chainId: o.chainId,
        },
        category: o.category,
        serviceDescription: o.description ?? `${o.name} description`,
        serviceLifecycle: o.serviceLifecycle ?? "one-shot",
        turnaroundEstimate: o.turnaround ?? "PT10M",
      },
    };
  }
  return card;
}
