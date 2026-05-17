import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";

const TEST_BUYER_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

async function connectClient(baseUrl: string) {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
  );
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(transport);
  return { client, transport };
}

interface ToolResultContent {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

function parseResult<T>(result: unknown): T {
  const r = result as ToolResultContent;
  expect(r.content).toBeDefined();
  expect(r.content[0]).toBeDefined();
  return JSON.parse(r.content[0].text) as T;
}

describe("hosted MCP — wallet-agnostic surface", () => {
  let gateway: TestGateway;

  beforeEach(async () => {
    gateway = await startTestGateway({
      providers: [
        {
          tokenId: 2n,
          name: "Domain Reg",
          priceUsdcSmallest: "15000000",
          category: "domain-registration",
          skills: [
            {
              id: "register-domain",
              name: "Register Domain",
              metadata: {
                paymentRequired: true,
                baseAmount: "15000000",
                requiredFields: ["domain"],
              },
            },
          ],
        },
      ],
    });
  });

  afterEach(async () => {
    await gateway.close();
  });

  it("tools/list returns 5 public + 3 advanced by default (deprecated hidden)", async () => {
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      expect(names).toEqual(
        [
          // Public (5)
          "daski_buy_service",
          "daski_confirm_delivery",
          "daski_get_task_status",
          "daski_search_services",
          "daski_submit_task",
          // Advanced (3)
          "daski_purchase",
          "daski_register_agent",
          "daski_settle_payment",
        ].sort(),
      );
    } finally {
      await transport.close();
    }
  });

  it("tools/list includes deprecated aliases when X-Daski-Include-Deprecated is set", async () => {
    // Re-open a session with the include-deprecated header so we exercise
    // the per-session toggle that buildSession() reads off the inbound
    // initialize request.
    const transport = new StreamableHTTPClientTransport(
      new URL(`${gateway.baseUrl}/mcp`),
      {
        requestInit: { headers: { "X-Daski-Include-Deprecated": "1" } },
      },
    );
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      // Public + advanced + 6 deprecated.
      expect(names).toContain("daski_search_services");
      expect(names).toContain("search_services");
      expect(names).toContain("daski_get_provider");
      expect(names).toContain("daski_build_envelope_auth");
      expect(names).toContain("daski_prepare_registration");
      expect(names).toContain("daski_register_buyer");
      expect(names).toContain("daski_prepare_confirm");
    } finally {
      await transport.close();
    }
  });

  it("deprecated tool names remain callable even when hidden", async () => {
    // Default session has no X-Daski-Include-Deprecated header, so the
    // deprecated alias is hidden from tools/list — but the call still
    // works (logged as deprecated_tool_call).
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const result = await client.callTool({
        name: "search_services",
        arguments: {},
      });
      const body = parseResult<{
        providers: Array<{ tokenId: string; agentCardUrl: string }>;
      }>(result);
      expect(body.providers.length).toBe(1);
      expect(body.providers[0].tokenId).toBe("2");
    } finally {
      await transport.close();
    }
  });

  it("daski_search_services returns the provider catalog with no intent", async () => {
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const result = await client.callTool({
        name: "daski_search_services",
        arguments: {},
      });
      const body = parseResult<{
        providers: Array<{ tokenId: string; agentCardUrl: string }>;
      }>(result);
      expect(body.providers.length).toBe(1);
      expect(body.providers[0].tokenId).toBe("2");
      expect(body.providers[0].agentCardUrl).toMatch(/^http/);
    } finally {
      await transport.close();
    }
  });

  it("daski_search_services ranks providers by intent embedding when intent is given", async () => {
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      // Single registered provider in this fixture: "Daski Test" (a
      // generic test provider). The stub embedder is a bag-of-words
      // hasher, so any intent containing the test provider's tokens
      // produces a finite distance.
      const result = await client.callTool({
        name: "daski_search_services",
        arguments: { intent: "register a domain", limit: 5 },
      });
      const body = parseResult<{
        intent: string;
        providers: Array<{
          tokenId: string;
          match: { distance: number; bestSkillId: string };
        }>;
      }>(result);
      expect(body.intent).toBe("register a domain");
      expect(body.providers.length).toBeGreaterThanOrEqual(1);
      expect(body.providers[0].tokenId).toBe("2");
      expect(body.providers[0].match.distance).toBeLessThanOrEqual(2);
      expect(typeof body.providers[0].match.bestSkillId).toBe("string");
    } finally {
      await transport.close();
    }
  });

  it("exposes provider details as an MCP Resource", async () => {
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      // listResources should advertise the per-provider URI.
      const list = await client.listResources();
      const uris = list.resources.map((r) => r.uri).sort();
      expect(uris).toContain("daski://provider/2");

      // Reading the URI returns the same shape as one entry of
      // search_services (curated card + skills + serviceDescription).
      const read = await client.readResource({ uri: "daski://provider/2" });
      expect(read.contents).toHaveLength(1);
      const first = read.contents[0] as { mimeType?: string; text?: string };
      expect(first.mimeType).toBe("application/json");
      const parsed = JSON.parse(first.text ?? "{}") as {
        tokenId: string;
        agentId: string;
      };
      expect(parsed.tokenId).toBe("2");
      expect(parsed.agentId).toBe("2");
    } finally {
      await transport.close();
    }
  });

  it("returns a structured error when the resource tokenId is unknown", async () => {
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const read = await client.readResource({ uri: "daski://provider/999" });
      const first = read.contents[0] as { text?: string };
      const parsed = JSON.parse(first.text ?? "{}") as { error?: string };
      expect(parsed.error).toMatch(/not whitelisted|not in cache/);
    } finally {
      await transport.close();
    }
  });

  it("daski_purchase returns paymentRequirements with wallet-bound typed-data", async () => {
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const result = await client.callTool({
        name: "daski_purchase",
        arguments: {
          providerTokenId: "2",
          buyerTokenId: "5",
          walletAddress: gateway.buyerAddress,
          skillId: "register-domain",
        },
      });
      const body = parseResult<{
        paymentRequirements: {
          maxAmountRequired: string;
          extra: { daski: { eip712TypedData: any; serviceRef: string } };
        };
      }>(result);
      expect(body.paymentRequirements.maxAmountRequired).toBe("15000000");
      const td = body.paymentRequirements.extra.daski.eip712TypedData;
      expect(td.primaryType).toBe("TransferWithAuthorization");
      expect(td.message.from.toLowerCase()).toBe(gateway.buyerAddress);
    } finally {
      await transport.close();
    }
  });

  it("rejects daski_purchase without walletAddress", async () => {
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const result = await client.callTool({
        name: "daski_purchase",
        arguments: {
          providerTokenId: "2",
          buyerTokenId: "5",
          // walletAddress omitted
        },
      });
      const r = result as ToolResultContent;
      expect(r.isError).toBe(true);
    } finally {
      await transport.close();
    }
  });

  it("daski_buy_service returns a paid plan with paymentRequirements + steps", async () => {
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const result = await client.callTool({
        name: "daski_buy_service",
        arguments: {
          skillId: "register-domain",
          providerTokenId: "2",
          buyerTokenId: "5",
          walletAddress: gateway.buyerAddress,
          serviceArgs: { domain: "smoke.xyz" },
        },
      });
      const body = parseResult<{
        kind: string;
        paymentRequirements: { extra: { daski: { eip712TypedData: any } } };
        plan: { steps: Array<{ toolName: string }> };
      }>(result);
      expect(body.kind).toBe("paid");
      expect(body.paymentRequirements.extra.daski.eip712TypedData).toBeDefined();
      // Plan now uses the daski_confirm_delivery two-call pattern in place
      // of the deprecated daski_prepare_confirm + daski_confirm_delivery
      // pair. The first daski_confirm_delivery step is the unsigned
      // typed-data request; the second is the signed retry.
      expect(body.plan.steps.map((s) => s.toolName)).toEqual([
        "<your-wallet>.signTypedData",
        "daski_settle_payment",
        "daski_submit_task",
        "daski_get_task_status",
        // Two-call confirm delivery (first call returns typed-data):
        "daski_confirm_delivery",
        "<your-wallet>.signTypedData",
        // Second call submits the signed attestation:
        "daski_confirm_delivery",
      ]);
    } finally {
      await transport.close();
    }
  });

  it("end-to-end: purchase via MCP, sign locally, settle via MCP", async () => {
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      // 1. Open the challenge via daski_purchase
      const purchase = parseResult<{
        paymentRequirements: PaymentRequirementsLite;
      }>(
        await client.callTool({
          name: "daski_purchase",
          arguments: {
            providerTokenId: "2",
            buyerTokenId: "5",
            walletAddress: gateway.buyerAddress,
            // post-service-identity-refactor: skillId is required so the
            // gateway can derive serviceId from (providerAgentId, skillId,
            // version) and bind the EIP-3009 nonce accordingly.
            skillId: "register-domain",
          },
        }),
      );

      // 2. Sign the gateway-baked typed-data with a stand-in wallet (any
      //    EIP-712-capable signer works; we simulate the wallet here).
      const td = purchase.paymentRequirements.extra.daski.eip712TypedData;
      const account = privateKeyToAccount(TEST_BUYER_KEY);
      const message = {
        from: td.message.from,
        to: td.message.to,
        value: BigInt(td.message.value),
        validAfter: BigInt(td.message.validAfter),
        validBefore: BigInt(td.message.validBefore),
        nonce: td.message.nonce,
      };
      const types = {
        TransferWithAuthorization: td.types.TransferWithAuthorization,
      };
      const signature = (await account.signTypedData({
        domain: td.domain,
        types,
        primaryType: "TransferWithAuthorization",
        message,
      })) as Hex;

      // Sanity: signature recovers to the wallet address baked in
      const recovered = await recoverTypedDataAddress({
        domain: td.domain,
        types,
        primaryType: "TransferWithAuthorization",
        message,
        signature,
      });
      expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());

      // 3. Queue settlement and call daski_settle_payment via MCP
      gateway.queueSettlementSuccess({
        txHash: ("0x" + "11".repeat(32)) as Hex,
        paymentId: 99n,
        serviceRef: purchase.paymentRequirements.extra.daski.serviceRef as Hex,
        providerAgentId: 2n,
        buyerAgentId: 5n,
        totalAmount: 15_000_000n,
      });
      const settleResult = parseResult<{
        success: boolean;
        paymentId: string;
        transaction: string;
        providerA2AUrl: string;
      }>(
        await client.callTool({
          name: "daski_settle_payment",
          arguments: {
            paymentPayload: {
              x402Version: 1,
              scheme: "exact",
              network: "base-sepolia",
              payload: {
                signature,
                authorization: {
                  from: td.message.from,
                  to: td.message.to,
                  value: td.message.value,
                  validAfter: td.message.validAfter,
                  validBefore: td.message.validBefore,
                  nonce: td.message.nonce,
                },
              },
            },
            paymentRequirements: purchase.paymentRequirements,
          },
        }),
      );
      expect(settleResult.success).toBe(true);
      expect(settleResult.paymentId).toBe("99");
      expect(settleResult.providerA2AUrl).toMatch(/^http/);
    } finally {
      await transport.close();
    }
  });

  // ── Gasless registration MCP surface ─────────────────────────────────

  it("daski_register_agent first call returns RegisterAgent typed-data", async () => {
    const fresh = "0xabcd000000000000000000000000000000000001" as Hex;
    gateway.mockChain.setRegistrationNonce(fresh, 3n);

    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const body = parseResult<{
        walletAddress: string;
        nonce: string;
        eip712TypedData: { primaryType: string; message: Record<string, string> };
        submitTemplate: { walletAddress: string; deadline: string };
      }>(
        await client.callTool({
          name: "daski_register_agent",
          arguments: { walletAddress: fresh, agentURI: "ipfs://buyer" },
        }),
      );
      expect(body.walletAddress).toBe(fresh);
      expect(body.nonce).toBe("3");
      expect(body.eip712TypedData.primaryType).toBe("RegisterAgent");
      expect(body.eip712TypedData.message.agentWallet).toBe(fresh);
    } finally {
      await transport.close();
    }
  });

  it("daski_register_agent second call (with signature) submits via the facilitator", async () => {
    const fresh = "0xabcd000000000000000000000000000000000002" as Hex;
    gateway.mockChain.queueRegistration({
      kind: "success",
      agentId: 88n,
      txHash: ("0x" + "33".repeat(32)) as Hex,
    });

    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const body = parseResult<{
        walletAddress: string;
        agentId: string;
        transactionHash: string;
      }>(
        await client.callTool({
          name: "daski_register_agent",
          arguments: {
            walletAddress: fresh,
            agentURI: "ipfs://buyer",
            deadline: String(Math.floor(Date.now() / 1000) + 600),
            signature: ("0x" + "11".repeat(65)) as Hex,
          },
        }),
      );
      expect(body.walletAddress).toBe(fresh);
      expect(body.agentId).toBe("88");
      expect(body.transactionHash).toMatch(/^0x3{64}$/);
      expect(gateway.mockChain.registrations).toHaveLength(1);
    } finally {
      await transport.close();
    }
  });

  it("deprecated daski_prepare_registration alias still returns typed-data", async () => {
    const fresh = "0xabcd000000000000000000000000000000000011" as Hex;
    gateway.mockChain.setRegistrationNonce(fresh, 7n);

    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const body = parseResult<{
        walletAddress: string;
        nonce: string;
        eip712TypedData: { primaryType: string };
      }>(
        await client.callTool({
          name: "daski_prepare_registration",
          arguments: { walletAddress: fresh, agentURI: "ipfs://buyer" },
        }),
      );
      expect(body.nonce).toBe("7");
      expect(body.eip712TypedData.primaryType).toBe("RegisterAgent");
    } finally {
      await transport.close();
    }
  });

  it("deprecated daski_register_buyer alias still submits the registration", async () => {
    const fresh = "0xabcd000000000000000000000000000000000012" as Hex;
    gateway.mockChain.queueRegistration({
      kind: "success",
      agentId: 99n,
      txHash: ("0x" + "44".repeat(32)) as Hex,
    });

    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const body = parseResult<{ agentId: string; transactionHash: string }>(
        await client.callTool({
          name: "daski_register_buyer",
          arguments: {
            walletAddress: fresh,
            agentURI: "ipfs://buyer",
            deadline: String(Math.floor(Date.now() / 1000) + 600),
            signature: ("0x" + "22".repeat(65)) as Hex,
          },
        }),
      );
      expect(body.agentId).toBe("99");
      expect(body.transactionHash).toMatch(/^0x4{64}$/);
    } finally {
      await transport.close();
    }
  });

  it("daski_buy_service routes a fresh wallet to atomic register-and-settle", async () => {
    const fresh = "0xabcd000000000000000000000000000000000003" as Hex;
    // Wallet has no agent on chain; getRegistrationNonce returns 0 by default.
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const body = parseResult<{
        kind: string;
        atomic: boolean;
        paymentRequirements: { extra: { daski: { eip712TypedData: any; buyerTokenId: string } } };
        registrationPrep: {
          eip712TypedData: { primaryType: string; message: Record<string, string> };
          submitTemplate: { walletAddress: string };
        } | null;
        plan: { steps: Array<{ toolName: string }> };
      }>(
        await client.callTool({
          name: "daski_buy_service",
          arguments: {
            skillId: "register-domain",
            providerTokenId: "2",
            walletAddress: fresh,
            // buyerTokenId omitted on purpose — orchestrator should look it up.
            serviceArgs: { domain: "atomic.xyz" },
          },
        }),
      );

      expect(body.kind).toBe("paid");
      expect(body.atomic).toBe(true);
      expect(body.paymentRequirements.extra.daski.buyerTokenId).toBe("0");
      expect(body.registrationPrep).not.toBeNull();
      expect(body.registrationPrep!.eip712TypedData.primaryType).toBe(
        "RegisterAgent",
      );
      expect(body.registrationPrep!.eip712TypedData.message.agentWallet).toBe(
        fresh.toLowerCase(),
      );
      // Plan: payment sign → registration sign → settle → submit → check
      // → confirm-prep → confirm sign → confirm_delivery. Three sign
      // steps total (payment, registration, confirmation).
      const tools = body.plan.steps.map((s) => s.toolName);
      expect(tools.filter((t) => t === "<your-wallet>.signTypedData")).toHaveLength(3);
      expect(tools).toContain("daski_settle_payment");
      expect(tools).toContain("daski_confirm_delivery");
    } finally {
      await transport.close();
    }
  });

  it("daski_search_services surfaces acceptedToken at the top of the response", async () => {
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const body = parseResult<{
        acceptedToken: { address: string; chainId: number; network: string };
        providers: unknown[];
      }>(
        await client.callTool({
          name: "daski_search_services",
          arguments: {},
        }),
      );
      expect(body.acceptedToken).toBeDefined();
      expect(body.acceptedToken.address.toLowerCase()).toBe(
        gateway.config.usdcAddress,
      );
      expect(body.acceptedToken.chainId).toBe(84532);
      expect(body.acceptedToken.network).toBe("base-sepolia");
    } finally {
      await transport.close();
    }
  });

  it("daski_buy_service uses the provider /quote amount instead of priceUsdcSmallest fallback", async () => {
    // Override the default quote outcome to a different amount than the
    // agent-card's priceUsdcSmallest. Proves the orchestrator calls /quote
    // and uses its return value rather than falling back to the card.
    gateway.mockProvider.setQuoteOutcome("register-domain", {
      ok: true,
      amount: 2_980_000n, // .xyz live price
      notes: ["live name.com price for .xyz: $2.98 USD"],
    });

    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const body = parseResult<{
        kind: string;
        atomic: boolean;
        paymentRequirements: { maxAmountRequired: string };
        quoteNotes: string[];
        acceptedToken: { address: string };
      }>(
        await client.callTool({
          name: "daski_buy_service",
          arguments: {
            skillId: "register-domain",
            providerTokenId: "2",
            buyerTokenId: "5",
            walletAddress: gateway.buyerAddress,
            serviceArgs: { domain: "atomic.xyz" },
          },
        }),
      );
      expect(body.kind).toBe("paid");
      expect(body.paymentRequirements.maxAmountRequired).toBe("2980000");
      expect(body.quoteNotes).toContain(
        "live name.com price for .xyz: $2.98 USD",
      );
      expect(body.acceptedToken.address.toLowerCase()).toBe(
        gateway.config.usdcAddress,
      );
    } finally {
      await transport.close();
    }
  });

  it("daski_buy_service returns validation errors from /quote without issuing a payment", async () => {
    gateway.mockProvider.setQuoteOutcome("register-domain", {
      ok: false,
      errors: [
        {
          field: "registrantPhone",
          code: "invalid_format",
          message: "must be E.164 with no separators",
        },
      ],
    });

    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const result = await client.callTool({
        name: "daski_buy_service",
        arguments: {
          skillId: "register-domain",
          providerTokenId: "2",
          buyerTokenId: "5",
          walletAddress: gateway.buyerAddress,
          serviceArgs: {
            domain: "atomic.xyz",
            registrantPhone: "+48.500000000",
          },
        },
      });
      const r = result as ToolResultContent;
      expect(r.isError).toBe(true);
      const err = JSON.parse(
        (r.content[0]! as { type: "text"; text: string }).text,
      );
      expect(err.code).toBe("quote_validation_failed");
      // Standardized error shape (§3.8) nests structured payload under details.
      expect(err.details.validationErrors[0].field).toBe("registrantPhone");
    } finally {
      await transport.close();
    }
  });

  it("daski_buy_service: check-availability returns kind:'availability' with inline result", async () => {
    gateway.registerProvider({
      tokenId: 2n,
      name: "Domain Reg",
      priceUsdcSmallest: "15000000",
      category: "domain-registration",
      skills: [
        {
          id: "register-domain",
          metadata: { paymentRequired: true, baseAmount: "15000000" },
        },
        {
          id: "check-availability",
          metadata: {
            paymentRequired: false,
            requiresAssetOwnership: false,
            requiresCapability: false,
            requiredFields: ["domain"],
          },
        },
      ],
    });
    await gateway.refresh();
    gateway.mockProvider.setAvailabilityOutcome("smoke.xyz", {
      domain: "smoke.xyz",
      available: true,
      price: 17.99,
      currency: "USD",
    });

    // Fresh wallet — no agentId required for an availability lookup.
    const fresh = "0xabcd000000000000000000000000000000000005" as Hex;
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const body = parseResult<{
        kind: string;
        domain: string;
        available: boolean;
        price?: number;
        currency?: string;
        plan: { steps: unknown[] };
      }>(
        await client.callTool({
          name: "daski_buy_service",
          arguments: {
            skillId: "check-availability",
            providerTokenId: "2",
            walletAddress: fresh,
            serviceArgs: { domain: "smoke.xyz" },
          },
        }),
      );
      expect(body.kind).toBe("availability");
      expect(body.domain).toBe("smoke.xyz");
      expect(body.available).toBe(true);
      expect(body.price).toBe(17.99);
      expect(body.currency).toBe("USD");
      // Synchronous: zero steps. Answer is in the response above.
      expect(body.plan.steps).toEqual([]);
    } finally {
      await transport.close();
    }
  });

  // Note: the dedicated `daski_check_availability` MCP tool was removed
  // in v4. Agents now reach check-availability via daski_submit_task →
  // provider's free A2A skill (synchronous path with inline artifacts);
  // the test below exercises that flow.

  it("daski_submit_task passes inline artifacts + statusMessage through (open-free sync path)", async () => {
    gateway.mockProvider.setSyncResult({
      id: "qa-test-1",
      statusMessage: {
        role: "agent",
        parts: [{ type: "text", text: "pacu.ai is not available." }],
      },
      artifacts: [
        {
          name: "availability_result",
          parts: [
            {
              type: "data",
              data: { domain: "pacu.ai", available: false },
            },
          ],
        },
      ],
    });

    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const body = parseResult<{
        taskId: string;
        state: string;
        artifacts?: Array<{ name: string; parts: unknown[] }>;
        statusMessage?: { role: string; parts: Array<{ type: string; text?: string }> };
      }>(
        await client.callTool({
          name: "daski_submit_task",
          arguments: {
            providerA2AUrl: gateway.mockProvider.baseUrl + "/a2a",
            skillId: "check-availability",
            paymentId: "",
            chainId: 84532,
            serviceArgs: { domain: "pacu.ai" },
          },
        }),
      );
      expect(body.taskId).toBe("qa-test-1");
      expect(body.state).toBe("completed");
      // Artifact MUST come back inline so the agent doesn't have to call
      // daski_check_task on a non-persistent qa- task (would 404).
      expect(body.artifacts).toBeDefined();
      expect(body.artifacts![0].name).toBe("availability_result");
      expect(body.statusMessage?.parts[0].text).toBe(
        "pacu.ai is not available.",
      );
    } finally {
      await transport.close();
      gateway.mockProvider.setSyncResult(null);
    }
  });

  it("daski_buy_service: ownership-gated free skill still requires paymentId", async () => {
    gateway.registerProvider({
      tokenId: 2n,
      name: "Domain Reg",
      priceUsdcSmallest: "15000000",
      category: "domain-registration",
      skills: [
        {
          id: "set-dns-record",
          metadata: {
            paymentRequired: false,
            requiresAssetOwnership: true,
            requiresCapability: true,
            // Required for capability-gated skills — the orchestrator
            // refuses to build a plan when this is missing so we declare
            // it here even though the test asserts the paymentId branch.
            capabilityType: "DnsRecordCapability",
            requiredFields: ["domain", "recordType", "recordName", "recordContent"],
          },
        },
      ],
    });
    await gateway.refresh();

    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const result = await client.callTool({
        name: "daski_buy_service",
        arguments: {
          skillId: "set-dns-record",
          providerTokenId: "2",
          walletAddress: gateway.buyerAddress,
          buyerTokenId: "5",
          serviceArgs: {
            domain: "owned.xyz",
            recordType: "A",
            recordName: "@",
            recordContent: "1.2.3.4",
          },
          // paymentId omitted — should error.
        },
      });
      const r = result as ToolResultContent;
      expect(r.isError).toBe(true);
      const err = JSON.parse(
        (r.content[0]! as { type: "text"; text: string }).text,
      );
      expect(err.code).toBe("payment_id_required");
    } finally {
      await transport.close();
    }
  });

  it("daski_buy_service: refuses to emit a plan when requiresCapability=true but capabilityType is missing", async () => {
    // Regression for the audit finding: previously the plan-builder
    // silently omitted the prepare-capability step when the provider
    // declared `requiresCapability: true` without a `capabilityType`,
    // leaving the buyer with a plan that says "pass capability" but
    // no upstream step to produce one.
    gateway.registerProvider({
      tokenId: 2n,
      name: "Misconfigured Reg",
      priceUsdcSmallest: "15000000",
      category: "domain-registration",
      skills: [
        {
          id: "set-dns-record",
          metadata: {
            paymentRequired: false,
            requiresAssetOwnership: true,
            requiresCapability: true,
            // capabilityType deliberately omitted to exercise the guard.
            requiredFields: ["domain", "recordType", "recordName", "recordContent"],
          },
        },
      ],
    });
    await gateway.refresh();

    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const result = await client.callTool({
        name: "daski_buy_service",
        arguments: {
          skillId: "set-dns-record",
          providerTokenId: "2",
          walletAddress: gateway.buyerAddress,
          buyerTokenId: "5",
          paymentId: "42",
          serviceArgs: {
            domain: "owned.xyz",
            recordType: "A",
            recordName: "@",
            recordContent: "1.2.3.4",
          },
        },
      });
      const r = result as ToolResultContent;
      expect(r.isError).toBe(true);
      const err = JSON.parse(
        (r.content[0]! as { type: "text"; text: string }).text,
      );
      expect(err.code).toBe("provider_missing_capability_type");
      expect(err.details.skillId).toBe("set-dns-record");
    } finally {
      await transport.close();
    }
  });

  it("daski_settle_payment requires `registration` when challenge.buyerTokenId === 0", async () => {
    const fresh = "0xabcd000000000000000000000000000000000004" as Hex;
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      // 1. Open atomic challenge via daski_buy_service.
      const plan = parseResult<{
        paymentRequirements: PaymentRequirementsLite;
      }>(
        await client.callTool({
          name: "daski_buy_service",
          arguments: {
            skillId: "register-domain",
            providerTokenId: "2",
            walletAddress: fresh,
            serviceArgs: { domain: "atomic-settle.xyz" },
          },
        }),
      );

      // 2. Sign the payment typed-data with a stand-in wallet.
      const td = plan.paymentRequirements.extra.daski.eip712TypedData;
      const account = privateKeyToAccount(TEST_BUYER_KEY);
      const signature = (await account.signTypedData({
        domain: td.domain,
        types: { TransferWithAuthorization: td.types.TransferWithAuthorization },
        primaryType: "TransferWithAuthorization",
        message: {
          from: td.message.from,
          to: td.message.to,
          value: BigInt(td.message.value),
          validAfter: BigInt(td.message.validAfter),
          validBefore: BigInt(td.message.validBefore),
          nonce: td.message.nonce,
        },
      })) as Hex;

      // 3. Call daski_settle_payment WITHOUT registration → should be an error.
      const errResult = await client.callTool({
        name: "daski_settle_payment",
        arguments: {
          paymentPayload: {
            x402Version: 1,
            scheme: "exact",
            network: "base-sepolia",
            payload: {
              signature,
              authorization: {
                from: td.message.from,
                to: td.message.to,
                value: td.message.value,
                validAfter: td.message.validAfter,
                validBefore: td.message.validBefore,
                nonce: td.message.nonce,
              },
            },
          },
          paymentRequirements: plan.paymentRequirements,
        },
      });
      const r = errResult as ToolResultContent;
      expect(r.isError).toBe(true);
      const err = JSON.parse(
        (r.content[0]! as { type: "text"; text: string }).text,
      );
      expect(err.code).toBe("registration_required");
    } finally {
      await transport.close();
    }
  });

  it("daski_submit_task first call (no envelopeAuth, paid skill) returns typed-data + messageId", async () => {
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const body = parseResult<{
        eip712TypedData: { primaryType: string; message: Record<string, unknown> };
        authorization: { messageId: string; paymentId: string };
        messageId: string;
        hint: string;
      }>(
        await client.callTool({
          name: "daski_submit_task",
          arguments: {
            providerA2AUrl: gateway.mockProvider.baseUrl + "/a2a",
            skillId: "register-domain",
            paymentId: "42",
            chainId: 84532,
            buyerTokenId: "5",
            serviceArgs: { domain: "envelope.xyz" },
          },
        }),
      );
      expect(body.eip712TypedData.primaryType).toBe(
        "A2ARequestAuthorization",
      );
      expect(body.authorization.paymentId).toBe("42");
      expect(body.messageId).toBe(body.authorization.messageId);
      expect(body.hint).toMatch(/Sign eip712TypedData/);
    } finally {
      await transport.close();
    }
  });

  it("daski_submit_task first call without buyerTokenId returns BAD_INPUT", async () => {
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const result = await client.callTool({
        name: "daski_submit_task",
        arguments: {
          providerA2AUrl: gateway.mockProvider.baseUrl + "/a2a",
          skillId: "register-domain",
          paymentId: "42",
          chainId: 84532,
          // buyerTokenId omitted — required for envelope-auth first call.
          serviceArgs: { domain: "envelope.xyz" },
        },
      });
      const r = result as ToolResultContent;
      expect(r.isError).toBe(true);
      const err = JSON.parse(
        (r.content[0]! as { type: "text"; text: string }).text,
      );
      expect(err.code).toBe("BAD_INPUT");
      expect(err.message).toMatch(/buyerTokenId/);
    } finally {
      await transport.close();
    }
  });

  it("deprecated daski_build_envelope_auth alias still returns the typed-data", async () => {
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const body = parseResult<{
        eip712TypedData: { primaryType: string };
        authorization: { paymentId: string };
        messageId: string;
      }>(
        await client.callTool({
          name: "daski_build_envelope_auth",
          arguments: {
            skillId: "register-domain",
            paymentId: "42",
            chainId: 84532,
            buyerTokenId: "5",
            serviceArgs: { domain: "envelope.xyz" },
          },
        }),
      );
      expect(body.eip712TypedData.primaryType).toBe(
        "A2ARequestAuthorization",
      );
      expect(body.authorization.paymentId).toBe("42");
      expect(body.messageId).toBeDefined();
    } finally {
      await transport.close();
    }
  });
});

interface PaymentRequirementsLite {
  maxAmountRequired: string;
  extra: {
    daski: {
      serviceRef: string;
      eip712TypedData: {
        domain: any;
        types: any;
        primaryType: string;
        message: Record<string, string>;
      };
    };
  };
}
