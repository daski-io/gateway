import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  CATEGORY_FAMILY_SLUGS,
  SERVICE_TYPE_SLUGS,
} from "../src/serviceTaxonomy.js";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";
import { computeRequestHash } from "../src/auth/envelope.js";
import { expectedPhoneConfirmationToken } from "../src/mcp/util.js";
import {
  AGENT_AUTHORITY,
  MCP_LEGAL_INSTRUCTIONS,
  PURCHASE_NOTICE,
} from "../src/legal/purchase.js";
import type { Embedder } from "../src/discovery/embeddings.js";

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

function expectedLegal(gateway: TestGateway) {
  return {
    marketplaceTermsUrl: gateway.config.marketplaceTermsUrl,
    marketplacePrivacyUrl: gateway.config.marketplacePrivacyUrl,
    providerLegalName: "Example Provider, LLC",
    providerTermsUrl: "https://provider.example/terms",
    providerPrivacyUrl: "https://provider.example/privacy",
  };
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
          categoryFamily: "domains-web",
          serviceType: "domain-management",
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

  it("tools/list returns the 6 public and 3 advanced tools", async () => {
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      expect(names).toEqual(
        [
          // Public (6)
          "daski_buy_service",
          "daski_confirm_delivery",
          "daski_fetch_artifact",
          "daski_get_task_status",
          "daski_search_services",
          "daski_submit_task",
          // Advanced (3)
          "daski_purchase",
          "daski_register_agent",
          "daski_settle_payment",
        ].sort(),
      );
      const searchTool = tools.tools.find(
        (tool) => tool.name === "daski_search_services",
      );
      const properties = searchTool?.inputSchema.properties as Record<
        string,
        { enum?: string[] }
      >;
      expect(properties.categoryFamily.enum).toEqual(CATEGORY_FAMILY_SLUGS);
      expect(properties.serviceType.enum).toEqual(SERVICE_TYPE_SLUGS);
      expect(client.getInstructions()).toContain(MCP_LEGAL_INSTRUCTIONS);
      for (const toolName of [
        "daski_purchase",
        "daski_settle_payment",
        "daski_buy_service",
      ]) {
        const tool = tools.tools.find((entry) => entry.name === toolName);
        expect(tool?.description).toContain("Operator is the legal party");
        expect(tool?.description).toContain("binds the Operator");
      }
      expect(
        tools.tools.find((tool) => tool.name === "daski_buy_service")
          ?.description,
      ).toContain("TOP-LEVEL `serviceArgs` keys");
      expect(
        tools.tools.find((tool) => tool.name === "daski_buy_service")
          ?.description,
      ).toContain("There is NO `officials`");
      expect(
        tools.tools.find((tool) => tool.name === "daski_submit_task")
          ?.description,
      ).toContain("NOTHING REMOVED");
      expect(
        tools.tools.find((tool) => tool.name === "daski_get_task_status")
          ?.description,
      ).toContain("reuse it until `authorization.expiry`");
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
        providers: Array<{
          tokenId: string;
          agentCardUrl: string;
          legal: Record<string, string>;
        }>;
      }>(result);
      expect(body.providers.length).toBe(1);
      expect(body.providers[0].tokenId).toBe("2");
      expect(body.providers[0].agentCardUrl).toMatch(/^http/);
      expect(body.providers[0].legal).toEqual(expectedLegal(gateway));
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

  it("degrades intent search to the filtered catalog and reports health", async () => {
    const unavailableEmbedder: Embedder = {
      dim: 384,
      async embed() {
        throw new Error("upstream model details must stay private");
      },
      async embedMany() {
        throw new Error("upstream model details must stay private");
      },
      async warmup() {
        throw new Error("upstream model details must stay private");
      },
      getStatus() {
        return { state: "degraded", reason: "model_load_failed" };
      },
    };
    const degradedGateway = await startTestGateway({
      embedder: unavailableEmbedder,
      providers: [
        {
          tokenId: 91n,
          name: "Fallback Domains",
          priceUsdcSmallest: "15000000",
          categoryFamily: "domains-web",
          serviceType: "domain-management",
          skills: [
            {
              id: "register-domain",
              name: "Register Domain",
              metadata: {
                paymentRequired: true,
                baseAmount: "15000000",
              },
            },
          ],
        },
      ],
    });
    const { client, transport } = await connectClient(degradedGateway.baseUrl);
    try {
      const result = await client.callTool({
        name: "daski_search_services",
        arguments: { intent: "register a domain" },
      });
      const body = parseResult<{
        ranking: string;
        warning: string;
        providers: unknown[];
      }>(result);
      expect(body.ranking).toBe("unavailable");
      expect(body.providers).toHaveLength(1);
      expect(body.warning).not.toContain("upstream model details");

      const health = (await (
        await fetch(`${degradedGateway.baseUrl}/health`)
      ).json()) as {
        status: string;
        embedder: { state: string; reason?: string };
      };
      expect(health.status).toBe("degraded");
      expect(health.embedder).toEqual({
        state: "degraded",
        reason: "model_load_failed",
      });
    } finally {
      await transport.close();
      await degradedGateway.close();
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
        legal: Record<string, string>;
      };
      expect(parsed.tokenId).toBe("2");
      expect(parsed.agentId).toBe("2");
      expect(parsed.legal).toEqual(expectedLegal(gateway));
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
        legal: Record<string, string>;
        agentAuthority: typeof AGENT_AUTHORITY;
        purchaseNotice: string;
        paymentRequirements: {
          maxAmountRequired: string;
          extra: {
            daski: {
              eip712TypedData: any;
              serviceRef: string;
              legal: Record<string, string>;
              agentAuthority: typeof AGENT_AUTHORITY;
              purchaseNotice: string;
            };
          };
        };
      }>(result);
      expect(Object.keys(body).slice(-2)).toEqual([
        "purchaseNotice",
        "paymentRequirements",
      ]);
      expect(body.paymentRequirements.maxAmountRequired).toBe("15000000");
      expect(body.legal).toEqual(expectedLegal(gateway));
      expect(body.agentAuthority).toEqual(AGENT_AUTHORITY);
      expect(body.purchaseNotice).toBe(PURCHASE_NOTICE);
      expect(body.paymentRequirements.extra.daski.legal).toEqual(
        expectedLegal(gateway),
      );
      expect(body.paymentRequirements.extra.daski.agentAuthority).toEqual(
        AGENT_AUTHORITY,
      );
      expect(body.paymentRequirements.extra.daski.purchaseNotice).toBe(
        PURCHASE_NOTICE,
      );
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
        legal: Record<string, string>;
        agentAuthority: typeof AGENT_AUTHORITY;
        purchaseNotice: string;
        paymentRequirements: { extra: { daski: { eip712TypedData: any } } };
        plan: { steps: Array<{ toolName: string }> };
      }>(result);
      expect(body.kind).toBe("paid");
      const paymentIndex = Object.keys(body).indexOf("paymentRequirements");
      expect(Object.keys(body)[paymentIndex - 1]).toBe("purchaseNotice");
      expect(body.legal).toEqual(expectedLegal(gateway));
      expect(body.agentAuthority).toEqual(AGENT_AUTHORITY);
      expect(body.purchaseNotice).toBe(PURCHASE_NOTICE);
      expect(body.paymentRequirements.extra.daski.eip712TypedData).toBeDefined();
      // The first daski_confirm_delivery step is the unsigned
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

  it("daski_buy_service atomic: no name → wallet-derived default + how-to-name hint", async () => {
    const fresh = "0xabcd000000000000000000000000000000aa39aa" as Hex;
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const body = parseResult<{
        atomic: boolean;
        registrationPrep: {
          agentURI: string;
          resolvedName: string;
          hint?: string;
        };
        plan: { steps: Array<{ toolName: string; hint: string }> };
      }>(
        await client.callTool({
          name: "daski_buy_service",
          arguments: {
            skillId: "register-domain",
            providerTokenId: "2",
            walletAddress: fresh,
            serviceArgs: { domain: "atomic.xyz" },
          },
        }),
      );

      expect(body.atomic).toBe(true);
      expect(body.registrationPrep.resolvedName).toBe("buyer-aa39aa");
      // The hint fires exactly where the default is applied, and tells the
      // agent to pick a name itself via re-call before signing.
      expect(body.registrationPrep.hint).toContain("`name`");
      expect(body.registrationPrep.hint).toContain("buyer-aa39aa");
      // The registration sign step repeats the nudge so it survives even
      // if the agent only reads the plan.
      const regSign = body.plan.steps.find(
        (s) =>
          s.toolName === "<your-wallet>.signTypedData" &&
          s.hint.includes("registrationPrep"),
      );
      expect(regSign).toBeDefined();
      expect(regSign!.hint).toContain("buyer-aa39aa");
      expect(regSign!.hint).toContain("`name`");
    } finally {
      await transport.close();
    }
  });

  it("daski_buy_service atomic: `name` is baked into the signed registration agentURI", async () => {
    const fresh = "0xabcd000000000000000000000000000000000004" as Hex;
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const body = parseResult<{
        atomic: boolean;
        registrationPrep: {
          agentURI: string;
          resolvedName: string;
          hint?: string;
          eip712TypedData: { message: Record<string, string> };
          submitTemplate: { agentURI: string };
        };
        plan: { steps: Array<{ toolName: string; hint: string }> };
      }>(
        await client.callTool({
          name: "daski_buy_service",
          arguments: {
            skillId: "register-domain",
            providerTokenId: "2",
            walletAddress: fresh,
            name: "  Acme Procurement Bot ",
            serviceArgs: { domain: "atomic.xyz" },
          },
        }),
      );

      expect(body.atomic).toBe(true);
      // Trimmed by sanitizeBuyerName, echoed so the agent can show it.
      expect(body.registrationPrep.resolvedName).toBe("Acme Procurement Bot");
      // Named registration needs no how-to-name hint.
      expect(body.registrationPrep.hint).toBeUndefined();
      // The name must live inside the agentURI the wallet actually signs —
      // decode the data: URI and check the embedded buyer card.
      const uri = body.registrationPrep.agentURI;
      expect(body.registrationPrep.eip712TypedData.message.agentURI).toBe(uri);
      expect(body.registrationPrep.submitTemplate.agentURI).toBe(uri);
      const b64 = uri.replace("data:application/json;base64,", "");
      const card = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
      expect(card.name).toBe("Acme Procurement Bot");
      expect(card.wallet).toBe(fresh.toLowerCase());
      // The registration sign step confirms the chosen name.
      const regSign = body.plan.steps.find(
        (s) =>
          s.toolName === "<your-wallet>.signTypedData" &&
          s.hint.includes("registrationPrep"),
      );
      expect(regSign!.hint).toContain("Acme Procurement Bot");
    } finally {
      await transport.close();
    }
  });

  it("daski_buy_service rejects an invalid `name` before quoting", async () => {
    const fresh = "0xabcd000000000000000000000000000000000005" as Hex;
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const result = await client.callTool({
        name: "daski_buy_service",
        arguments: {
          skillId: "register-domain",
          providerTokenId: "2",
          walletAddress: fresh,
          name: "x".repeat(65),
          serviceArgs: { domain: "atomic.xyz" },
        },
      });
      const r = result as ToolResultContent;
      expect(r.isError).toBe(true);
      const err = JSON.parse(r.content[0]!.text);
      expect(err.code).toBe("BAD_INPUT");
      expect(err.message).toContain("name");
      expect(err.recoverable).toBe(true);
    } finally {
      await transport.close();
    }
  });

  it("daski_buy_service warns when `name` is passed for an already-registered wallet", async () => {
    gateway.mockChain.setAgentOfWallet(gateway.buyerAddress, 5n);
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const body = parseResult<{
        atomic: boolean;
        registrationPrep: unknown;
        warnings?: string[];
      }>(
        await client.callTool({
          name: "daski_buy_service",
          arguments: {
            skillId: "register-domain",
            providerTokenId: "2",
            walletAddress: gateway.buyerAddress,
            name: "Acme Procurement Bot",
            serviceArgs: { domain: "smoke.xyz" },
          },
        }),
      );

      expect(body.atomic).toBe(false);
      expect(body.registrationPrep).toBeNull();
      // Ignored-arg policy: never drop a caller's input silently.
      expect(body.warnings).toBeDefined();
      expect(body.warnings!.some((w) => w.includes("`name` was ignored"))).toBe(
        true,
      );
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
    // Uses a domain-side error (not phone-format) because §1.8 added a
    // gateway-side E.164 precheck that would intercept phone failures
    // before reaching /quote. The shape we want to prove here is that
    // provider-side quote errors propagate through unchanged.
    gateway.mockProvider.setQuoteOutcome("register-domain", {
      ok: false,
      errors: [
        {
          field: "domain",
          code: "domain_unavailable",
          message: "atomic.xyz is not available for registration",
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
            registrantPhone: "+15555550100",
          },
          // Phone-bearing buys must pass the confirmation gate before any
          // /quote roundtrip; this test targets provider-side quote errors,
          // so satisfy the gate up front.
          confirmationToken: expectedPhoneConfirmationToken([
            { field: "registrantPhone", value: "+15555550100" },
          ]),
        },
      });
      const r = result as ToolResultContent;
      expect(r.isError).toBe(true);
      const err = JSON.parse(
        (r.content[0]! as { type: "text"; text: string }).text,
      );
      expect(err.code).toBe("quote_validation_failed");
      // Standardized error shape (§3.8) nests structured payload under details.
      expect(err.details.validationErrors[0].field).toBe("domain");
    } finally {
      await transport.close();
    }
  });

  it("daski_buy_service rejects formatted phone numbers before reaching the provider", async () => {
    // §1.8 — gateway-side E.164 precheck. Saves a network round-trip and
    // produces a clearer agent-side error than the provider would.
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
            registrantPhone: "+1.555.555.0100",
          },
        },
      });
      const r = result as ToolResultContent;
      expect(r.isError).toBe(true);
      const err = JSON.parse(
        (r.content[0]! as { type: "text"; text: string }).text,
      );
      expect(err.code).toBe("BAD_INPUT");
      expect(err.message).toMatch(/E\.164/);
      expect(err.details.field).toBe("registrantPhone");
      expect(err.details.example).toBe("+15555550100");
    } finally {
      await transport.close();
    }
  });

  it("daski_buy_service: check-availability returns kind:'availability' with inline result", async () => {
    gateway.registerProvider({
      tokenId: 2n,
      name: "Domain Reg",
      priceUsdcSmallest: "15000000",
      categoryFamily: "domains-web",
      serviceType: "domain-management",
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
            directEndpoint: "/availability",
            directResultKind: "availability",
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
    gateway.registerProvider({
      tokenId: 2n,
      name: "Domain Reg",
      priceUsdcSmallest: "15000000",
      categoryFamily: "domains-web",
      serviceType: "domain-management",
      skills: [
        {
          id: "check-availability",
          metadata: {
            paymentRequired: false,
            requiresAssetOwnership: false,
            requiresCapability: false,
          },
        },
      ],
    });
    await gateway.refresh();
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
      categoryFamily: "domains-web",
      serviceType: "domain-management",
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

  it("daski_buy_service builds an in-band capability plan without catalog capabilityType", async () => {
    // The provider returns the authoritative typed-data in its in-band
    // capability challenge, so the catalog does not need to duplicate
    // the capability's Solidity primary type.
    gateway.registerProvider({
      tokenId: 2n,
      name: "Misconfigured Reg",
      priceUsdcSmallest: "15000000",
      categoryFamily: "domains-web",
      serviceType: "domain-management",
      skills: [
        {
          id: "set-dns-record",
          metadata: {
            paymentRequired: false,
            requiresAssetOwnership: true,
            requiresCapability: true,
            requiredFields: ["domain", "recordType", "recordName", "recordContent"],
          },
        },
      ],
    });
    await gateway.refresh();

    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const body = parseResult<{
        kind: string;
        requiresCapability: boolean;
        plan: { steps: Array<{ hint: string }> };
      }>(
        await client.callTool({
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
        }),
      );
      expect(body.kind).toBe("free");
      expect(body.requiresCapability).toBe(true);
      expect(body.plan.steps.some((step) =>
        step.hint.includes("provider-issued capability"),
      )).toBe(true);
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

  it("daski_submit_task restores paid-path fields on a signed retry", async () => {
    const serviceArgs = { domain: "restored-paid-path.xyz" };
    const transactionHash = `0x${"cd".repeat(32)}` as Hex;
    const paymentId = "4242";
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const purchase = parseResult<{
        paymentRequirements: {
          extra: { daski: { serviceRef: Hex } };
        };
      }>(
        await client.callTool({
          name: "daski_buy_service",
          arguments: {
            skillId: "register-domain",
            providerTokenId: "2",
            buyerTokenId: "5",
            walletAddress: gateway.buyerAddress,
            serviceArgs,
          },
        }),
      );
      const serviceRef = purchase.paymentRequirements.extra.daski.serviceRef;
      expect(
        await gateway.bundle.queries.recordChallengePaid(
          serviceRef,
          BigInt(paymentId),
          transactionHash,
        ),
      ).toBe(true);

      const firstArgs = {
        providerA2AUrl: gateway.mockProvider.baseUrl + "/a2a",
        skillId: "register-domain",
        paymentId,
        chainId: 84532,
        buyerTokenId: "5",
        serviceArgs,
      };
      const first = parseResult<{
        messageId: string;
        authorization: {
          buyerTokenId: string;
          skillId: string;
          paymentId: string;
          chainId: number;
          messageId: string;
          requestHash: string;
          issuedAt: string;
        };
      }>(
        await client.callTool({
          name: "daski_submit_task",
          arguments: firstArgs,
        }),
      );

      const result = parseResult<{ taskId: string; state: string }>(
        await client.callTool({
          name: "daski_submit_task",
          arguments: {
            ...firstArgs,
            messageId: first.messageId,
            envelopeAuth: {
              signature: `0x${"ab".repeat(65)}`,
              authorization: first.authorization,
            },
          },
        }),
      );
      expect(result.taskId).toBeDefined();
      expect(result.state).toBe("submitted");

      const sent = gateway.mockProvider.getLastSendBody();
      const params = sent?.params as {
        message: { metadata: Record<string, Record<string, unknown>> };
      };
      const metadata = Object.values(params.message.metadata)[0]!;
      expect(metadata.serviceRef).toBe(serviceRef);
      expect(metadata.transactionHash).toBe(transactionHash);
      expect(metadata.quoteId).toBeDefined();
      expect(metadata.quoteSignature).toBeDefined();
    } finally {
      await transport.close();
    }
  });

  it("daski_submit_task task-input mode (taskId set) skips the envelope handshake and forwards metadata.taskId", async () => {
    // Answering an input-required task authenticates via the provider's
    // action:"input" TaskAccessAuthorization challenge, NOT an envelope —
    // even on a paid skill that would normally get the envelope first-call.
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const body = parseResult<{ taskId: string; state: string }>(
        await client.callTool({
          name: "daski_submit_task",
          arguments: {
            providerA2AUrl: gateway.mockProvider.baseUrl + "/a2a",
            skillId: "register-domain",
            paymentId: "42",
            chainId: 84532,
            taskId: "task-parked-1",
            serviceArgs: { domain: "corrected.xyz" },
          },
        }),
      );
      // No envelope typed-data — the call went straight to the provider.
      expect(body.taskId).toBeDefined();
      const sent = gateway.mockProvider.getLastSendBody();
      expect(sent).not.toBeNull();
      const params = sent!.params as {
        message: { metadata: Record<string, Record<string, unknown>> };
      };
      const meta = Object.values(params.message.metadata)[0]!;
      expect(meta.taskId).toBe("task-parked-1");
      expect(meta.serviceRef).toBeUndefined();
      expect(meta.envelopeAuth).toBeUndefined();
    } finally {
      await transport.close();
    }
  });

  it("daski_submit_task rejects taskId combined with serviceRef", async () => {
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const result = await client.callTool({
        name: "daski_submit_task",
        arguments: {
          providerA2AUrl: gateway.mockProvider.baseUrl + "/a2a",
          skillId: "register-domain",
          paymentId: "42",
          chainId: 84532,
          taskId: "task-parked-1",
          serviceRef: "0x" + "ab".repeat(32),
          transactionHash: "0x" + "cd".repeat(32),
          serviceArgs: { domain: "corrected.xyz" },
        },
      });
      const r = result as ToolResultContent;
      expect(r.isError).toBe(true);
      const err = JSON.parse(
        (r.content[0]! as { type: "text"; text: string }).text,
      );
      expect(err.code).toBe("BAD_INPUT");
      expect(err.message).toMatch(/task input/i);
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
          // buyerTokenId AND walletAddress both omitted — required for envelope-auth first call.
          serviceArgs: { domain: "envelope.xyz" },
        },
      });
      const r = result as ToolResultContent;
      expect(r.isError).toBe(true);
      const err = JSON.parse(
        (r.content[0]! as { type: "text"; text: string }).text,
      );
      expect(err.code).toBe("BAD_INPUT");
      // §1.4 — error message points at walletAddress + the buy_service
      // response, NOT daski_search_services.
      expect(err.message).toMatch(/buyerTokenId/);
      expect(err.message).toMatch(/walletAddress/);
      expect(err.message).not.toMatch(/daski_search_services/);
    } finally {
      await transport.close();
    }
  });

  it("daski_submit_task auto-derives buyerTokenId from walletAddress via the on-chain registry", async () => {
    // §1.3 — when the agent has the wallet but not the agentId, the
    // gateway looks up the ERC-8004 token via agentOfWallet instead of
    // forcing the agent to parse a tx receipt.
    gateway.mockChain.setAgentOfWallet(gateway.buyerAddress, 5n);
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const body = parseResult<{
        eip712TypedData: { primaryType: string; message: Record<string, string> };
        authorization: { buyerTokenId: string; paymentId: string };
        messageId: string;
      }>(
        await client.callTool({
          name: "daski_submit_task",
          arguments: {
            providerA2AUrl: gateway.mockProvider.baseUrl + "/a2a",
            skillId: "register-domain",
            paymentId: "42",
            chainId: 84532,
            walletAddress: gateway.buyerAddress,
            serviceArgs: { domain: "envelope.xyz" },
          },
        }),
      );
      expect(body.eip712TypedData.primaryType).toBe("A2ARequestAuthorization");
      expect(body.authorization.buyerTokenId).toBe("5");
      expect(body.authorization.paymentId).toBe("42");
    } finally {
      await transport.close();
    }
  });

  it("daski_submit_task surfaces a recoverable error when the wallet has no agentId", async () => {
    // §1.3 edge case — wallet exists on chain but isn't registered as an
    // ERC-8004 agent. Mock chain defaults agentOfWallet to 0n.
    const freshWallet = "0x1111111111111111111111111111111111111111" as Hex;
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const result = await client.callTool({
        name: "daski_submit_task",
        arguments: {
          providerA2AUrl: gateway.mockProvider.baseUrl + "/a2a",
          skillId: "register-domain",
          paymentId: "42",
          chainId: 84532,
          walletAddress: freshWallet,
          serviceArgs: { domain: "envelope.xyz" },
        },
      });
      const r = result as ToolResultContent;
      expect(r.isError).toBe(true);
      const err = JSON.parse(
        (r.content[0]! as { type: "text"; text: string }).text,
      );
      expect(err.code).toBe("WALLET_NOT_REGISTERED");
      expect(err.recoverable).toBe(true);
    } finally {
      await transport.close();
    }
  });

  it("daski_submit_task runs the envelope handshake for a gated FREE skill even with paymentId '0' (catalog-driven gating)", async () => {
    // Regression for the live 2026-07-02 finding: change-password (free
    // but ownership+capability-gated) called with paymentId "0" used to
    // skip the handshake here — "free skill" reads as "paymentId 0" — and
    // bounce off the provider's ENVELOPE_AUTH_REQUIRED. The skill's own
    // advertised gating in the discovery cache now decides.
    gateway.registerProvider({
      tokenId: 7n,
      name: "Agent Mailboxes",
      priceUsdcSmallest: "9990000",
      categoryFamily: "communications",
      serviceType: "agent-mailbox",
      skills: [
        {
          id: "change-password",
          metadata: {
            paymentRequired: false,
            requiresAssetOwnership: true,
            requiresCapability: true,
            capabilityType: "MailboxPasswordResetAuthorization",
            requiredFields: ["address"],
          },
        },
      ],
    });
    await gateway.refresh();

    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const body = parseResult<{
        eip712TypedData: { primaryType: string };
        authorization: { paymentId: string; buyerTokenId: string };
        messageId: string;
      }>(
        await client.callTool({
          name: "daski_submit_task",
          arguments: {
            providerA2AUrl: gateway.mockProvider.baseUrl + "/a2a",
            skillId: "change-password",
            paymentId: "0",
            chainId: 84532,
            buyerTokenId: "5",
            serviceArgs: { address: "pawel@uat.example" },
          },
        }),
      );
      // An envelope challenge, not a blind dispatch.
      expect(body.eip712TypedData.primaryType).toBe("A2ARequestAuthorization");
      expect(body.authorization.paymentId).toBe("0");
      expect(body.messageId).toBeDefined();
    } finally {
      await transport.close();
    }
  });

  it("daski_submit_task passes provider JSON-RPC error.data through (envelopeAuthChallenge recovery)", async () => {
    // The provider's ENVELOPE_AUTH_REQUIRED error embeds a ready-to-sign
    // envelopeAuthChallenge in error.data; dropping it strands the agent
    // with a message that references a payload it can't see.
    gateway.registerProvider({
      tokenId: 2n,
      name: "Domain Reg",
      priceUsdcSmallest: "15000000",
      categoryFamily: "domains-web",
      serviceType: "domain-management",
      skills: [
        {
          id: "check-availability",
          metadata: {
            paymentRequired: false,
            requiresAssetOwnership: false,
            requiresCapability: false,
          },
        },
      ],
    });
    await gateway.refresh();
    gateway.mockProvider.setNextA2AError({
      code: -32011,
      message:
        "envelopeAuth required: this skill is ownership- or capability-gated.",
      data: {
        envelopeAuthChallenge: {
          primaryType: "A2ARequestAuthorization",
          message: { skillId: "change-password" },
        },
      },
    });
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const result = await client.callTool({
        name: "daski_submit_task",
        arguments: {
          providerA2AUrl: gateway.mockProvider.baseUrl + "/a2a",
          skillId: "check-availability",
          paymentId: "0",
          chainId: 84532,
          serviceArgs: { domain: "pacu.ai" },
        },
      });
      const r = result as ToolResultContent;
      expect(r.isError).toBe(true);
      const err = JSON.parse(
        (r.content[0]! as { type: "text"; text: string }).text,
      );
      expect(err.code).toBe("PROVIDER_ERROR");
      expect(err.details.rpcCode).toBe(-32011);
      expect(err.details.data.envelopeAuthChallenge.primaryType).toBe(
        "A2ARequestAuthorization",
      );
    } finally {
      await transport.close();
    }
  });

  it("daski_submit_task bundles a fresh envelope challenge alongside a capability challenge", async () => {
    // Envelopes are single-use: the execute call after a capability
    // challenge needs a NEW envelope. The gateway pre-mints it so the
    // agent signs capability + next envelope in one pass instead of
    // discovering ENVELOPE_REPLAY the hard way.
    gateway.registerProvider({
      tokenId: 2n,
      name: "Agent Mailboxes",
      priceUsdcSmallest: "9990000",
      categoryFamily: "communications",
      serviceType: "agent-mailbox",
      skills: [
        {
          id: "change-password",
          metadata: {
            paymentRequired: false,
            requiresAssetOwnership: true,
            requiresCapability: true,
            capabilityType: "MailboxPasswordResetAuthorization",
          },
        },
      ],
    });
    await gateway.refresh();
    gateway.mockProvider.setSyncResult({
      id: "task-cap-1",
      state: "input-required",
      statusMessage: {
        role: "agent",
        parts: [{ type: "text", text: "Sign the capability." }],
      },
      artifacts: [
        {
          name: "capability_challenge",
          parts: [
            {
              type: "data",
              data: { capabilityType: "MailboxPasswordResetAuthorization" },
            },
          ],
        },
      ],
    });
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const body = parseResult<{
        state: string;
        nextEnvelopeAuthChallenge?: {
          messageId: string;
          authorization: {
            buyerTokenId: string;
            skillId: string;
            messageId: string;
          };
          eip712TypedData: { primaryType: string };
          hint: string;
        };
      }>(
        await client.callTool({
          name: "daski_submit_task",
          arguments: {
            providerA2AUrl: gateway.mockProvider.baseUrl + "/a2a",
            skillId: "change-password",
            paymentId: "5",
            chainId: 84532,
            buyerTokenId: "5",
            messageId: "msg-used-1",
            envelopeAuth: {
              signature: ("0x" + "ab".repeat(65)) as string,
              authorization: {
                buyerTokenId: "5",
                skillId: "change-password",
                paymentId: "5",
                chainId: 84532,
                messageId: "msg-used-1",
                // Must be the true canonical hash of the serviceArgs below —
                // the gateway now rejects body/envelope drift before dispatch.
                requestHash: computeRequestHash({ address: "pawel@uat.example" }),
                issuedAt: "1",
              },
            },
            serviceArgs: { address: "pawel@uat.example" },
          },
        }),
      );
      expect(body.state).toBe("input-required");
      expect(body.nextEnvelopeAuthChallenge).toBeDefined();
      const next = body.nextEnvelopeAuthChallenge!;
      expect(next.messageId).not.toBe("msg-used-1");
      expect(next.authorization.buyerTokenId).toBe("5");
      expect(next.authorization.skillId).toBe("change-password");
      expect(next.authorization.messageId).toBe(next.messageId);
      expect(next.eip712TypedData.primaryType).toBe("A2ARequestAuthorization");
      expect(next.hint).toMatch(/single-use/);
    } finally {
      await transport.close();
      gateway.mockProvider.setSyncResult(null);
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
