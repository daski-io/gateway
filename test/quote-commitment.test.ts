import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { Hex, PaymentRequired } from "../src/types.js";
import { computeRequestHash } from "../src/auth/envelope.js";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";

const PRICE = 15_000_000n;
const DASKI_EXTENSION = "https://daski.xyz/x402/v2";

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
  _meta?: Record<string, unknown>;
}

function parseResult<T>(result: unknown): T {
  const content = (result as ToolResultContent).content;
  expect(content[0]).toBeDefined();
  return JSON.parse(content[0]!.text) as T;
}

function declaration(required: PaymentRequired) {
  return required.extensions?.[DASKI_EXTENSION] as {
    info: {
      serviceRef: Hex;
      providerA2AUrl: string;
      quote: { id: string; signature: Hex; expiresAt: string };
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
    gateway.mockChain.setAgentOfWallet(gateway.buyerAddress, 5n);
    gateway.mockChain.setAgentOwner(6n, gateway.buyerAddress);
  });

  afterEach(async () => {
    await gateway.close();
  });

  function buyArgs(extra: Record<string, unknown> = {}) {
    return {
      skillId: "register-domain",
      providerTokenId: "2",
      serviceSlug: "domain-management",
      buyerTokenId: "5",
      walletAddress: gateway.buyerAddress,
      serviceArgs: { domain: "quoted.xyz" },
      ...extra,
    };
  }

  async function buy(client: Client, args = buyArgs()) {
    return client.callTool({
      name: "daski_buy_service",
      arguments: args,
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
    const body = (await response.json()) as {
      quote: Record<string, unknown>;
    };
    return body.quote;
  }

  async function postPurchase(body: Record<string, unknown>) {
    const response = await fetch(`${gateway.baseUrl}/purchase/2`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const header = response.headers.get("payment-required");
    return {
      status: response.status,
      json: (await response.json()) as Record<string, unknown>,
      required: header ? decodePaymentRequiredHeader(header) : undefined,
    };
  }

  it("validates provider signatures and reuses only the exact REST binding", async () => {
    const serviceArgs = { domain: "rest-quoted.xyz" };
    const baseRequest = {
      buyerTokenId: "5",
      walletAddress: gateway.buyerAddress,
      skillId: "register-domain",
      serviceSlug: "domain-management",
      serviceArgs,
    };
    expect((await postPurchase(baseRequest)).status).toBe(400);

    const providerQuote = await requestProviderQuote(serviceArgs);
    const badSignature = {
      ...providerQuote,
      providerSignature: `0x${"11".repeat(65)}`,
    };
    const tampered = await postPurchase({
      ...baseRequest,
      providerQuote: badSignature,
    });
    expect(tampered.status).toBe(400);
    expect(tampered.json.error).toMatch(/signature is invalid/i);

    const first = await postPurchase({ ...baseRequest, providerQuote });
    const retry = await postPurchase({ ...baseRequest, providerQuote });
    expect(first.status).toBe(402);
    expect(declaration(first.required!).info.serviceRef).toBe(
      providerQuote.serviceRef,
    );
    expect(retry.required).toEqual(first.required);

    const rebound = await postPurchase({
      ...baseRequest,
      buyerTokenId: "6",
      providerQuote,
    });
    expect(rebound.status).toBe(409);
  });

  it("adopts the provider serviceRef and persists quote credentials", async () => {
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const required = parseResult<PaymentRequired>(await buy(client));
      const quote = gateway.mockProvider.getIssuedQuotes().at(-1)!;
      const daski = declaration(required).info;
      expect(required.x402Version).toBe(2);
      expect(required.accepts[0]?.amount).toBe(PRICE.toString());
      expect(daski.serviceRef).toBe(quote.serviceRef);
      expect(daski.quote).toMatchObject({
        id: quote.quoteId,
        signature: quote.providerSignature,
      });

      const challenge = await gateway.bundle.queries.getChallengeByRef(
        quote.serviceRef as Hex,
      );
      expect(challenge).toMatchObject({
        quoteId: quote.quoteId,
        quoteSignature: quote.providerSignature,
        x402Version: 2,
      });
      expect(challenge!.expiresAt.getTime()).toBeLessThanOrEqual(
        Date.parse(quote.expiresAt),
      );
    } finally {
      await transport.close();
    }
  });

  it("rejects changed paid-retry arguments before settlement", async () => {
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const args = buyArgs();
      const required = parseResult<PaymentRequired>(await buy(client, args));
      const payload = await gateway.createPaymentPayload(required);
      const changed = await client.callTool({
        name: "daski_buy_service",
        arguments: buyArgs({
          serviceArgs: { domain: "changed-after-signing.xyz" },
        }),
        _meta: { "x402/payment": payload },
      });
      expect(parseResult<{ code: string }>(changed).code).toBe(
        "PURCHASE_REQUEST_MISMATCH",
      );
      const challenge = await gateway.bundle.queries.getChallengeByRef(
        declaration(required).info.serviceRef,
      );
      expect(challenge?.settlementState).toBe("pending");
      expect(gateway.mockChain.settlements).toHaveLength(0);
    } finally {
      await transport.close();
    }
  });

  it("treats amount as a cap and never as a price override", async () => {
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const capped = parseResult<{ code: string }>(
        await buy(client, buyArgs({ amount: "1000" })),
      );
      expect(capped.code).toBe("price_above_limit");

      const required = parseResult<PaymentRequired>(
        await buy(client, buyArgs({ amount: PRICE.toString() })),
      );
      expect(required.accepts[0]?.amount).toBe(PRICE.toString());
    } finally {
      await transport.close();
    }
  });

  it("fails closed on missing or drifted quote commitments", async () => {
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      gateway.mockProvider.setQuoteOutcome("register-domain", {
        ok: true,
        amount: PRICE,
        omitCommitment: true,
      });
      expect(
        parseResult<{ code: string }>(await buy(client)).code,
      ).toBe("quote_commitment_missing");

      gateway.mockProvider.setQuoteOutcome("register-domain", {
        ok: true,
        amount: PRICE,
        serviceSlug: "some-other-product",
      });
      const drift = parseResult<{ code: string; message: string }>(
        await buy(client),
      );
      expect(drift.code).toBe("quote_malformed");
      expect(drift.message).toContain("serviceSlug");
    } finally {
      await transport.close();
    }
  });

  it("settles under the quote ref and injects quote credentials at submit", async () => {
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const args = buyArgs();
      const required = parseResult<PaymentRequired>(await buy(client, args));
      const daski = declaration(required).info;
      const quote = gateway.mockProvider.getIssuedQuotes().at(-1)!;
      const payload = await gateway.createPaymentPayload(required);
      const settleTx = `0x${"22".repeat(32)}` as Hex;
      gateway.queueSettlementSuccess({
        txHash: settleTx,
        paymentId: 77n,
        serviceRef: daski.serviceRef,
        providerAgentId: 2n,
        buyerAgentId: 5n,
        totalAmount: PRICE,
      });
      const paid = await client.callTool({
        name: "daski_buy_service",
        arguments: args,
        _meta: { "x402/payment": payload },
      });
      const settled = parseResult<{
        success: boolean;
        paymentId: string;
        providerA2AUrl: string;
      }>(paid);
      expect(settled.success).toBe(true);
      const response = (paid as ToolResultContent)._meta?.[
        "x402/payment-response"
      ] as { extensions: Record<string, { quoteId: string }> };
      expect(response.extensions[DASKI_EXTENSION]?.quoteId).toBe(
        quote.quoteId,
      );

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
              signature: `0x${"ab".repeat(65)}`,
              authorization: {
                buyerTokenId: "5",
                skillId: "register-domain",
                paymentId: settled.paymentId,
                chainId: 84532,
                messageId,
                requestHash: computeRequestHash({ domain: "quoted.xyz" }),
                issuedAt: "1",
              },
            },
          },
        }),
      );
      expect(submit.taskId).toBeDefined();
      const meta = (gateway.mockProvider.getLastSendBody() as any).params
        .message.metadata["https://daski.xyz/a2a/v1"];
      expect(meta).toMatchObject({
        serviceRef: daski.serviceRef,
        quoteId: quote.quoteId,
        quoteSignature: quote.providerSignature,
      });
    } finally {
      await transport.close();
    }
  });
});
