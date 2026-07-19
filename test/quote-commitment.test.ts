import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { privateKeyToAccount } from "viem/accounts";
import { encodeAbiParameters, keccak256 } from "viem";
import type { Hex } from "viem";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";
import { computeRequestHash } from "../src/auth/envelope.js";

// ── Provider quote-commitment integration (provider audit 1.1) ──────────
//
// The provider signs every paid quote and enforces at task-submit time
// that (a) the settled serviceRef equals the quote's commitment hash and
// (b) A2A metadata carries the matching quoteId + quoteSignature. These
// tests pin the gateway half: adopt quote.serviceRef, persist + expose
// the credentials, bound everything by the quote TTL, and inject the
// metadata at submit time.

const TEST_BUYER_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

const PRICE = 15_000_000n;

async function connectClient(baseUrl: string) {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
  );
  const client = new Client({ name: "quote-test-client", version: "0.0.0" });
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

interface BuyResponse {
  kind: string;
  quote: { quoteId: string; expiresAt: string };
  quoteNotes: string[];
  paymentRequirements: {
    maxAmountRequired: string;
    extra: {
      daski: {
        serviceRef: string;
        quote?: { quoteId: string; quoteSignature: string; expiresAt: string };
        eip712TypedData: {
          domain: Record<string, unknown>;
          types: Record<string, Array<{ name: string; type: string }>>;
          primaryType: string;
          message: Record<string, string>;
        };
      };
    };
  };
}

describe("provider quote-commitment integration", () => {
  let gateway: TestGateway;

  beforeEach(async () => {
    gateway = await startTestGateway({
      providers: [
        {
          tokenId: 2n,
          name: "Domain Reg",
          priceUsdcSmallest: PRICE.toString(),
          categoryFamily: "domains-web",
          serviceType: "domain-management",
          skills: [
            {
              id: "register-domain",
              name: "Register Domain",
              metadata: {
                paymentRequired: true,
                baseAmount: PRICE.toString(),
                requiredFields: ["domain"],
              },
            },
          ],
        },
      ],
    });
    // Registered buyer — the quote flow itself is what's under test.
    gateway.mockChain.setAgentOfWallet(gateway.buyerAddress, 5n);
  });

  afterEach(async () => {
    await gateway.close();
  });

  async function buyRegisterDomain(
    client: Client,
    extraArgs: Record<string, unknown> = {},
  ) {
    return client.callTool({
      name: "daski_buy_service",
      arguments: {
        skillId: "register-domain",
        providerTokenId: "2",
        buyerTokenId: "5",
        walletAddress: gateway.buyerAddress,
        serviceArgs: { domain: "quoted.xyz" },
        ...extraArgs,
      },
    });
  }

  async function requestProviderQuote(serviceArgs: Record<string, unknown>) {
    const response = await fetch(
      `${gateway.mockProvider.baseUrl}/quote/register-domain`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillId: "register-domain", serviceArgs }),
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      quote?: Record<string, unknown>;
    };
    expect(body.quote).toBeDefined();
    return body.quote!;
  }

  async function postPurchase(body: Record<string, unknown>) {
    const response = await fetch(`${gateway.baseUrl}/purchase/2`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      json: (await response.json()) as any,
    };
  }

  async function retryPurchase(serviceRef: string) {
    const paymentPayload = Buffer.from(
      JSON.stringify({ serviceRef }),
    ).toString("base64");
    const response = await fetch(`${gateway.baseUrl}/purchase/2`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-PAYMENT": paymentPayload,
      },
      body: JSON.stringify({}),
    });
    return {
      status: response.status,
      json: (await response.json()) as any,
    };
  }

  it("REST /purchase validates the signed quote and only reuses an exact binding", async () => {
    const serviceArgs = { domain: "rest-quoted.xyz" };
    const baseRequest = {
      buyerTokenId: "5",
      walletAddress: gateway.buyerAddress,
      skillId: "register-domain",
      serviceArgs,
    };

    const missing = await postPurchase(baseRequest);
    expect(missing.status).toBe(400);
    expect(missing.json.error).toContain("providerQuote is required");

    const providerQuote = await requestProviderQuote(serviceArgs);
    const badSignature = structuredClone(providerQuote);
    badSignature.providerSignature = `0x${"11".repeat(65)}`;
    const tampered = await postPurchase({
      ...baseRequest,
      providerQuote: badSignature,
    });
    expect(tampered.status).toBe(400);
    expect(tampered.json.error).toMatch(/signature is invalid/i);

    const drifted = await postPurchase({
      ...baseRequest,
      serviceArgs: { domain: "substituted.xyz" },
      providerQuote,
    });
    expect(drifted.status).toBe(400);
    expect(drifted.json.error).toMatch(/requestHash.*serviceArgs/i);

    const first = await postPurchase({ ...baseRequest, providerQuote });
    expect(first.status).toBe(402);
    const firstDaski = first.json.accepts[0].extra.daski;
    expect(firstDaski.serviceRef).toBe(providerQuote.serviceRef);
    expect(firstDaski.quote.quoteId).toBe(providerQuote.quoteId);

    const retry = await postPurchase({ ...baseRequest, providerQuote });
    expect(retry.status).toBe(402);
    expect(retry.json.accepts[0].extra.daski.serviceRef).toBe(
      firstDaski.serviceRef,
    );

    const rebound = await postPurchase({
      ...baseRequest,
      buyerTokenId: "6",
      providerQuote,
    });
    expect(rebound.status).toBe(409);
    expect(rebound.json.error).toContain("quote is already bound");
  });

  it("REST resource route rejects the retired X-PAYMENT settlement flow", async () => {
    const serviceArgs = { domain: "rest-retry.xyz" };
    const providerQuote = await requestProviderQuote(serviceArgs);
    const opened = await postPurchase({
      buyerTokenId: "5",
      walletAddress: gateway.buyerAddress,
      skillId: "register-domain",
      serviceArgs,
      providerQuote,
    });
    expect(opened.status).toBe(402);
    const serviceRef = opened.json.accepts[0].extra.daski.serviceRef as Hex;

    const retired = await retryPurchase(serviceRef);
    expect(retired.status).toBe(410);
    expect(retired.json.error).toContain("/settle");

    const challenge = await gateway.bundle.queries.getChallengeByRef(serviceRef);
    expect(challenge?.status).toBe("pending");
    expect(gateway.mockChain.settlements).toHaveLength(0);
  });

  it("daski_buy_service adopts quote.serviceRef and persists the credentials", async () => {
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const body = parseResult<BuyResponse>(await buyRegisterDomain(client));
      expect(body.kind).toBe("paid");

      const issued = gateway.mockProvider.getIssuedQuotes();
      expect(issued.length).toBeGreaterThan(0);
      const quote = issued[issued.length - 1]!;
      // The quote was taken with the buyer's REAL serviceArgs — the
      // commitment's requestHash binds them to the eventual task.
      expect(quote.serviceArgs).toEqual({ domain: "quoted.xyz" });

      const daski = body.paymentRequirements.extra.daski;
      // The challenge settles under the QUOTE's commitment hash, not a
      // gateway-generated entropy ref.
      expect(daski.serviceRef).toBe(quote.serviceRef);
      expect(daski.quote?.quoteId).toBe(quote.quoteId);
      expect(daski.quote?.quoteSignature).toBe(quote.providerSignature);
      expect(body.quote.quoteId).toBe(quote.quoteId);
      expect(body.paymentRequirements.maxAmountRequired).toBe(
        PRICE.toString(),
      );

      // The EIP-3009 signing window dies with the quote.
      const validBeforeSec = Number(
        daski.eip712TypedData.message.validBefore,
      );
      expect(validBeforeSec * 1000).toBeLessThanOrEqual(
        Date.parse(quote.expiresAt),
      );

      // Persisted challenge row carries the credentials + bounded expiry.
      const challenge = await gateway.bundle.queries.getChallengeByRef(
        quote.serviceRef as Hex,
      );
      expect(challenge).not.toBeNull();
      expect(challenge!.quoteId).toBe(quote.quoteId);
      expect(challenge!.quoteSignature).toBe(quote.providerSignature);
      expect(challenge!.quoteExpiresAt).not.toBeNull();
      expect(daski.eip712TypedData.message.nonce).toBe(
        keccak256(
          encodeAbiParameters(
            [{ type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }],
            [quote.serviceRef as Hex, 2n, challenge!.serviceId],
          ),
        ),
      );
      expect(challenge!.expiresAt.getTime()).toBeLessThanOrEqual(
        Date.parse(quote.expiresAt),
      );
    } finally {
      await transport.close();
    }
  });

  it("daski_buy_service signed retry rejects missing or changed serviceArgs before settlement", async () => {
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const buy = parseResult<BuyResponse>(await buyRegisterDomain(client));
      const paymentRequirements = buy.paymentRequirements;
      const paymentPayload = {
        x402Version: 1,
        scheme: "exact",
        network: "base-sepolia",
        payload: { signature: "0x", authorization: {} },
      };

      const missing = parseResult<Record<string, unknown>>(
        await buyRegisterDomain(client, {
          serviceArgs: undefined,
          paymentPayload,
          paymentRequirements,
        }),
      );
      expect(JSON.stringify(missing)).toContain("QUOTE_REQUEST_ARGS_MISSING");

      const changed = parseResult<Record<string, unknown>>(
        await buyRegisterDomain(client, {
          serviceArgs: { domain: "changed-after-signing.xyz" },
          paymentPayload,
          paymentRequirements,
        }),
      );
      expect(JSON.stringify(changed)).toContain("QUOTE_REQUEST_MISMATCH");

      const challenge = await gateway.bundle.queries.getChallengeByRef(
        paymentRequirements.extra.daski.serviceRef as Hex,
      );
      expect(challenge?.status).toBe("pending");
      expect(gateway.mockChain.settlements).toHaveLength(0);

      const nestedArgs = {
        domain: "nested-retry.xyz",
        registrant: { firstName: "Pawel" },
      };
      const nestedBuy = parseResult<BuyResponse>(
        await buyRegisterDomain(client, { serviceArgs: nestedArgs }),
      );
      const normalizedRetry = parseResult<Record<string, unknown>>(
        await buyRegisterDomain(client, {
          serviceArgs: nestedArgs,
          paymentPayload: {
            ...paymentPayload,
            serviceRef:
              nestedBuy.paymentRequirements.extra.daski.serviceRef,
          },
          paymentRequirements: nestedBuy.paymentRequirements,
        }),
      );
      expect(JSON.stringify(normalizedRetry)).not.toContain(
        "QUOTE_REQUEST_MISMATCH",
      );
      expect(JSON.stringify(normalizedRetry)).toContain("invalid_payload");
    } finally {
      await transport.close();
    }
  });

  it("advanced daski_purchase also uses the provider quote commitment", async () => {
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const body = parseResult<{ paymentRequirements: BuyResponse["paymentRequirements"] }>(
        await client.callTool({
          name: "daski_purchase",
          arguments: {
            providerTokenId: "2",
            buyerTokenId: "5",
            walletAddress: gateway.buyerAddress,
            skillId: "register-domain",
            serviceArgs: { domain: "advanced-purchase.xyz" },
          },
        }),
      );
      const quote = gateway.mockProvider.getIssuedQuotes().at(-1)!;
      const daski = body.paymentRequirements.extra.daski;
      expect(quote.serviceArgs).toEqual({ domain: "advanced-purchase.xyz" });
      expect(daski.serviceRef).toBe(quote.serviceRef);
      expect(daski.quote).toMatchObject({
        quoteId: quote.quoteId,
        quoteSignature: quote.providerSignature,
      });
    } finally {
      await transport.close();
    }
  });

  it("caps the price with args.amount but never overrides the quote", async () => {
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      // Below-quote cap → refused with the quote attached.
      const capped = parseResult<{
        error: { code: string; details?: { quotedAmount?: string } };
      }>(await buyRegisterDomain(client, { amount: "1000" }));
      const cappedError =
        (capped as any).error ?? (capped as Record<string, unknown>);
      expect(JSON.stringify(cappedError)).toContain("price_above_limit");

      // At-quote cap → proceeds, charged the QUOTED amount.
      const ok = parseResult<BuyResponse>(
        await buyRegisterDomain(client, { amount: PRICE.toString() }),
      );
      expect(ok.kind).toBe("paid");
      expect(ok.paymentRequirements.maxAmountRequired).toBe(PRICE.toString());
      const issued = gateway.mockProvider.getIssuedQuotes();
      expect(ok.paymentRequirements.extra.daski.serviceRef).toBe(
        issued[issued.length - 1]!.serviceRef,
      );
    } finally {
      await transport.close();
    }
  });

  it("fails closed when the provider omits the signed commitment", async () => {
    gateway.mockProvider.setQuoteOutcome("register-domain", {
      ok: true,
      amount: PRICE,
      omitCommitment: true,
    });
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const body = parseResult<Record<string, unknown>>(
        await buyRegisterDomain(client),
      );
      expect(JSON.stringify(body)).toContain("quote_commitment_missing");
      // No challenge was opened — nothing to strand.
    } finally {
      await transport.close();
    }
  });

  it("rejects a quote bound to a different serviceSlug (catalog drift)", async () => {
    gateway.mockProvider.setQuoteOutcome("register-domain", {
      ok: true,
      amount: PRICE,
      serviceSlug: "some-other-product",
    });
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const body = parseResult<Record<string, unknown>>(
        await buyRegisterDomain(client),
      );
      expect(JSON.stringify(body)).toContain("quote_malformed");
      expect(JSON.stringify(body)).toContain("serviceSlug");
    } finally {
      await transport.close();
    }
  });

  it("daski_submit_task fails closed on missing quote credentials or changed serviceArgs", async () => {
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const buy = parseResult<BuyResponse>(await buyRegisterDomain(client));
      const serviceRef = buy.paymentRequirements.extra.daski.serviceRef as Hex;
      const transactionHash = ("0x" + "44".repeat(32)) as Hex;
      expect(
        await gateway.bundle.queries.recordChallengePaid(
          serviceRef,
          88n,
          transactionHash,
          5n,
        ),
      ).toBe(true);
      const challenge = await gateway.bundle.queries.getChallengeByRef(
        serviceRef,
      );
      expect(challenge).not.toBeNull();

      const submitArgs = {
        providerA2AUrl: challenge!.providerA2AUrl,
        skillId: "register-domain",
        chainId: 84532,
        paymentId: "88",
        buyerTokenId: "5",
        serviceRef,
        transactionHash,
      };
      const changedArgs = parseResult<Record<string, unknown>>(
        await client.callTool({
          name: "daski_submit_task",
          arguments: {
            ...submitArgs,
            serviceArgs: { domain: "not-the-quoted-domain.xyz" },
          },
        }),
      );
      expect(JSON.stringify(changedArgs)).toContain("QUOTE_REQUEST_MISMATCH");
      expect(gateway.mockProvider.getLastSendBody()).toBeNull();

      await gateway.bundle.pool.query(
        "UPDATE payment_challenges SET quote_signature = NULL WHERE service_ref = $1",
        [Buffer.from(serviceRef.slice(2), "hex")],
      );
      const missingCredentials = parseResult<Record<string, unknown>>(
        await client.callTool({
          name: "daski_submit_task",
          arguments: {
            ...submitArgs,
            serviceArgs: { domain: "quoted.xyz" },
          },
        }),
      );
      expect(JSON.stringify(missingCredentials)).toContain(
        "QUOTE_CREDENTIALS_MISSING",
      );
      expect(gateway.mockProvider.getLastSendBody()).toBeNull();
    } finally {
      await transport.close();
    }
  });

  it("settles under the quote ref and injects quoteId/quoteSignature at submit time", async () => {
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      // 1. Buy — challenge bound to the provider quote.
      const buy = parseResult<BuyResponse>(await buyRegisterDomain(client));
      const daski = buy.paymentRequirements.extra.daski;
      const issued = gateway.mockProvider.getIssuedQuotes();
      const quote = issued[issued.length - 1]!;
      expect(daski.serviceRef).toBe(quote.serviceRef);

      // 2. Sign the gateway-baked EIP-3009 typed-data.
      const td = daski.eip712TypedData;
      const account = privateKeyToAccount(TEST_BUYER_KEY);
      const message = {
        from: td.message.from,
        to: td.message.to,
        value: BigInt(td.message.value),
        validAfter: BigInt(td.message.validAfter),
        validBefore: BigInt(td.message.validBefore),
        nonce: td.message.nonce,
      };
      const signature = (await account.signTypedData({
        domain: td.domain as any,
        types: {
          TransferWithAuthorization: td.types.TransferWithAuthorization,
        },
        primaryType: "TransferWithAuthorization",
        message,
      })) as Hex;

      // 3. Settle via MCP — the settle response exposes the credentials
      //    for direct-A2A buyers.
      const settleTx = ("0x" + "22".repeat(32)) as Hex;
      gateway.queueSettlementSuccess({
        txHash: settleTx,
        paymentId: 77n,
        serviceRef: daski.serviceRef as Hex,
        providerAgentId: 2n,
        buyerAgentId: 5n,
        totalAmount: PRICE,
      });
      const settled = parseResult<{
        success: boolean;
        paymentId: string;
        quoteId: string | null;
        quoteSignature: string | null;
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
            paymentRequirements: buy.paymentRequirements,
          },
        }),
      );
      expect(settled.success).toBe(true);
      expect(settled.quoteId).toBe(quote.quoteId);
      expect(settled.quoteSignature).toBe(quote.providerSignature);

      // 4. Submit the task (signed-envelope retry with a stand-in
      //    signature — the MOCK provider records rather than verifies).
      //    The gateway must inject metadata.quoteId + quoteSignature from
      //    the challenge row.
      const messageId = "quote-msg-1";
      const submit = parseResult<{ taskId: string }>(
        await client.callTool({
          name: "daski_submit_task",
          arguments: {
            providerA2AUrl: settled.providerA2AUrl,
            skillId: "register-domain",
            chainId: 84532,
            paymentId: settled.paymentId,
            buyerTokenId: "5",
            serviceRef: daski.serviceRef,
            transactionHash: settleTx,
            serviceArgs: { domain: "quoted.xyz" },
            messageId,
            envelopeAuth: {
              signature: ("0x" + "ab".repeat(65)) as string,
              authorization: {
                buyerTokenId: "5",
                skillId: "register-domain",
                paymentId: settled.paymentId,
                chainId: 84532,
                messageId,
                // Must be the true canonical hash of the serviceArgs above —
                // the gateway now rejects body/envelope drift before dispatch.
                requestHash: computeRequestHash({ domain: "quoted.xyz" }),
                issuedAt: "1",
              },
            },
          },
        }),
      );
      expect(submit.taskId).toBeDefined();

      const sendBody = gateway.mockProvider.getLastSendBody();
      expect(sendBody).not.toBeNull();
      const meta = (sendBody as any).params.message.metadata[
        "https://daski.xyz/a2a/v1"
      ];
      expect(meta.serviceRef).toBe(daski.serviceRef);
      expect(meta.quoteId).toBe(quote.quoteId);
      expect(meta.quoteSignature).toBe(quote.providerSignature);
    } finally {
      await transport.close();
    }
  });
});
