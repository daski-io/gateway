import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";
import type { Hex } from "../src/types.js";

const FRESH_WALLET = "0xcccc000000000000000000000000000000000001" as Hex;
const KNOWN_AGENT_WALLET =
  "0xdddd000000000000000000000000000000000002" as Hex;
const STUB_SIG = ("0x" + "11".repeat(65)) as Hex;
const REG_TX =
  "0x3333333333333333333333333333333333333333333333333333333333333333" as Hex;

function dataUri(card: Record<string, unknown>): string {
  const b64 = Buffer.from(JSON.stringify(card)).toString("base64");
  return `data:application/json;base64,${b64}`;
}

describe("GET /register-prep", () => {
  let gateway: TestGateway;

  beforeEach(async () => {
    gateway = await startTestGateway({});
    gateway.mockChain.setRegistrationNonce(FRESH_WALLET, 7n);
    gateway.mockChain.setAgentOfWallet(KNOWN_AGENT_WALLET, 42n);
  });

  afterEach(async () => {
    await gateway.close();
  });

  it("returns RegisterAgent typed-data + nonce + submitTemplate", async () => {
    const res = await fetch(
      `${gateway.baseUrl}/register-prep?walletAddress=${FRESH_WALLET}&agentURI=ipfs%3A%2F%2Fabc&deadlineSeconds=900`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.walletAddress).toBe(FRESH_WALLET);
    expect(body.agentURI).toBe("ipfs://abc");
    expect(body.nonce).toBe("7");
    expect(body.eip712TypedData.primaryType).toBe("RegisterAgent");
    // Domain moved to the Daski AgentIndex (registerWithSig verifies the
    // consent signature there); struct fields are unchanged.
    expect(body.eip712TypedData.domain.name).toBe("Daski AgentIndex");
    expect(body.eip712TypedData.domain.verifyingContract).toBe(
      gateway.config.agentIndexAddress,
    );
    expect(body.eip712TypedData.message.agentWallet).toBe(FRESH_WALLET);
    expect(body.eip712TypedData.message.nonce).toBe("7");
    // deadline drift is fine; just assert it's a positive numeric string.
    expect(body.eip712TypedData.message.deadline).toMatch(/^[1-9][0-9]*$/);
    expect(body.submitTemplate.walletAddress).toBe(FRESH_WALLET);
  });

  it("returns 409 when the wallet is already registered", async () => {
    const res = await fetch(
      `${gateway.baseUrl}/register-prep?walletAddress=${KNOWN_AGENT_WALLET}`,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("ALREADY_REGISTERED");
    expect(body.error.agentId).toBe("42");
  });

  it("returns 400 for a malformed walletAddress", async () => {
    const res = await fetch(
      `${gateway.baseUrl}/register-prep?walletAddress=not-an-address`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("BAD_WALLET");
  });

  it("returns 400 for a non-positive deadlineSeconds", async () => {
    const res = await fetch(
      `${gateway.baseUrl}/register-prep?walletAddress=${FRESH_WALLET}&deadlineSeconds=-1`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("BAD_DEADLINE");
  });
});

describe("POST /register", () => {
  let gateway: TestGateway;

  beforeEach(async () => {
    gateway = await startTestGateway({});
    gateway.mockChain.setRegistrationNonce(FRESH_WALLET, 0n);
    gateway.mockChain.setAgentOfWallet(KNOWN_AGENT_WALLET, 42n);
  });

  afterEach(async () => {
    await gateway.close();
  });

  it("submits via the facilitator and returns agentId + tx hash", async () => {
    gateway.mockChain.queueRegistration({
      kind: "success",
      agentId: 99n,
      txHash: REG_TX,
    });

    const res = await fetch(`${gateway.baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        walletAddress: FRESH_WALLET,
        agentURI: "ipfs://abc",
        deadline: String(Math.floor(Date.now() / 1000) + 600),
        signature: STUB_SIG,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.walletAddress).toBe(FRESH_WALLET);
    expect(body.agentId).toBe("99");
    expect(body.transactionHash).toBe(REG_TX);

    // Mock recorded the call.
    expect(gateway.mockChain.registrations).toHaveLength(1);
    expect(gateway.mockChain.registrations[0]!.agentWallet).toBe(FRESH_WALLET);
  });

  it("returns 409 if the wallet was already registered when the call arrives", async () => {
    const res = await fetch(`${gateway.baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        walletAddress: KNOWN_AGENT_WALLET,
        agentURI: "ipfs://abc",
        deadline: String(Math.floor(Date.now() / 1000) + 600),
        signature: STUB_SIG,
      }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("ALREADY_REGISTERED");
    expect(body.error.agentId).toBe("42");
    // Did NOT call the chain registerBuyer because the pre-check intercepted.
    expect(gateway.mockChain.registrations).toHaveLength(0);
  });

  it("returns 400 for a malformed signature", async () => {
    const res = await fetch(`${gateway.baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        walletAddress: FRESH_WALLET,
        agentURI: "ipfs://abc",
        deadline: String(Math.floor(Date.now() / 1000) + 600),
        signature: "not-a-hex-string",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("BAD_SIGNATURE");
  });

  it("returns 502 when the chain reader throws", async () => {
    gateway.mockChain.queueRegistration({
      kind: "revert",
      reason: "wallet already registered",
    });

    const res = await fetch(`${gateway.baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        walletAddress: FRESH_WALLET,
        agentURI: "ipfs://abc",
        deadline: String(Math.floor(Date.now() / 1000) + 600),
        signature: STUB_SIG,
      }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("REGISTER_FAILED");
    // Handler returns a generic message and a correlationId for log
    // lookup — chain-side reasons (e.g. "wallet already registered")
    // are kept out of the public response to avoid leaking internal
    // contract revert text.
    expect(body.error.message).toBe("registration submission failed");
    expect(typeof body.error.correlationId).toBe("string");
  });

  it("fails closed when the signed agentURI cannot be validated", async () => {
    const broken = await startTestGateway({
      buyerAgentCardFetch: async () =>
        new Response("not found", { status: 404 }),
    });
    try {
      const res = await fetch(`${broken.baseUrl}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletAddress: FRESH_WALLET,
          agentURI: "https://card.example/missing.json",
          deadline: String(Math.floor(Date.now() / 1000) + 600),
          signature: STUB_SIG,
        }),
      });
      expect(res.status).toBe(400);
      expect((await res.json() as any).error.code).toBe(
        "AGENT_URI_FETCH_FAILED",
      );
      expect(broken.mockChain.registrations).toHaveLength(0);
    } finally {
      await broken.close();
    }
  });

  it("enforces the global registration sponsorship budget", async () => {
    gateway.config.registrationSponsorMaxPerHour = 1;
    gateway.mockChain.queueRegistration({
      kind: "success",
      agentId: 99n,
      txHash: REG_TX,
    });
    const submit = (walletAddress: Hex) =>
      fetch(`${gateway.baseUrl}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletAddress,
          agentURI: "ipfs://abc",
          deadline: String(Math.floor(Date.now() / 1000) + 600),
          signature: STUB_SIG,
        }),
      });

    expect((await submit(FRESH_WALLET)).status).toBe(200);
    const secondWallet =
      "0xcccc000000000000000000000000000000000003" as Hex;
    const second = await submit(secondWallet);
    expect(second.status).toBe(429);
    expect((await second.json() as any).error.code).toBe(
      "REGISTRATION_SPONSOR_BUDGET_EXHAUSTED",
    );
    expect(gateway.mockChain.registrations).toHaveLength(1);
  });
});

// ── Buyer naming spec — resolution rules ─────────────────────────────────
//
// Four cases at /register-prep, plus name validation and agentURI fetch
// failure modes. Tests use a per-test stub fetcher so they don't go to
// the network and can simulate arbitrary upstream responses.

describe("GET /register-prep — buyer naming", () => {
  let gateway: TestGateway;

  async function setup(
    fetchFn?: (url: string, init?: RequestInit) => Promise<Response>,
  ): Promise<TestGateway> {
    gateway = await startTestGateway({
      buyerAgentCardFetch: fetchFn,
    });
    gateway.mockChain.setRegistrationNonce(FRESH_WALLET, 7n);
    return gateway;
  }

  afterEach(async () => {
    await gateway?.close();
  });

  it("case 1: no name, no agentURI → wallet-derived buyer-<last6> + hint", async () => {
    await setup();
    const res = await fetch(
      `${gateway.baseUrl}/register-prep?walletAddress=${FRESH_WALLET}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const expectedName = `buyer-${FRESH_WALLET.toLowerCase().slice(-6)}`;
    expect(body.resolvedName).toBe(expectedName);
    expect(body.agentURI).toMatch(/^data:application\/json;base64,/);
    // Decode the embedded card and confirm the name landed inside.
    const b64 = body.agentURI.split(",")[1];
    const card = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    expect(card.name).toBe(expectedName);
    expect(typeof body.hint).toBe("string");
    expect(body.hint.length).toBeGreaterThan(0);
  });

  it("case 2: name provided → embedded data URI, no hint", async () => {
    await setup();
    const res = await fetch(
      `${gateway.baseUrl}/register-prep?walletAddress=${FRESH_WALLET}&name=Alice`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.resolvedName).toBe("Alice");
    expect(body.agentURI).toMatch(/^data:application\/json;base64,/);
    const b64 = body.agentURI.split(",")[1];
    const card = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    expect(card.name).toBe("Alice");
    expect(body.hint).toBeUndefined();
  });

  it("case 3a: agentURI (data:) → name read from inline JSON, no hint", async () => {
    await setup();
    const uri = dataUri({ name: "Bob", type: "buyer", wallet: FRESH_WALLET });
    const res = await fetch(
      `${gateway.baseUrl}/register-prep?walletAddress=${FRESH_WALLET}&agentURI=${encodeURIComponent(uri)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.agentURI).toBe(uri);
    expect(body.resolvedName).toBe("Bob");
    expect(body.hint).toBeUndefined();
  });

  it("case 3b: agentURI (ipfs://) → resolves through configured gateway", async () => {
    let lastUrl: string | null = null;
    await setup(async (url) => {
      lastUrl = url;
      return new Response(JSON.stringify({ name: "Carol" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const res = await fetch(
      `${gateway.baseUrl}/register-prep?walletAddress=${FRESH_WALLET}&agentURI=${encodeURIComponent("ipfs://Qm123")}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.agentURI).toBe("ipfs://Qm123");
    expect(body.resolvedName).toBe("Carol");
    expect(lastUrl).toBe("https://ipfs.io/ipfs/Qm123");
  });

  it("case 3c: agentURI (https://) → fetches and reads name", async () => {
    await setup(async () =>
      new Response(JSON.stringify({ name: "Dave" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await fetch(
      `${gateway.baseUrl}/register-prep?walletAddress=${FRESH_WALLET}&agentURI=${encodeURIComponent("https://card.example/buyer.json")}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.resolvedName).toBe("Dave");
  });

  it("case 4: both name and agentURI → 400 NAME_AGENT_URI_CONFLICT", async () => {
    await setup();
    const uri = dataUri({ name: "Bob" });
    const res = await fetch(
      `${gateway.baseUrl}/register-prep?walletAddress=${FRESH_WALLET}&name=Alice&agentURI=${encodeURIComponent(uri)}`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("NAME_AGENT_URI_CONFLICT");
  });

  it("agentURI 404 → 400 AGENT_URI_FETCH_FAILED", async () => {
    await setup(async () =>
      new Response("not found", { status: 404 }),
    );
    const res = await fetch(
      `${gateway.baseUrl}/register-prep?walletAddress=${FRESH_WALLET}&agentURI=${encodeURIComponent("https://card.example/missing.json")}`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("AGENT_URI_FETCH_FAILED");
  });

  it("agentURI returning non-JSON → 400 AGENT_URI_NOT_JSON", async () => {
    await setup(async () =>
      new Response("<html>oops</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    const res = await fetch(
      `${gateway.baseUrl}/register-prep?walletAddress=${FRESH_WALLET}&agentURI=${encodeURIComponent("https://card.example/page.html")}`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("AGENT_URI_NOT_JSON");
  });

  it("agentURI JSON missing 'name' → 400 AGENT_URI_MISSING_NAME", async () => {
    await setup(async () =>
      new Response(JSON.stringify({ type: "buyer" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await fetch(
      `${gateway.baseUrl}/register-prep?walletAddress=${FRESH_WALLET}&agentURI=${encodeURIComponent("https://card.example/no-name.json")}`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("AGENT_URI_MISSING_NAME");
  });

  it("agentURI body exceeding 64 KB → 400 AGENT_URI_TOO_LARGE", async () => {
    const huge = JSON.stringify({ name: "x", padding: "y".repeat(70_000) });
    await setup(async () =>
      new Response(huge, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": String(huge.length),
        },
      }),
    );
    const res = await fetch(
      `${gateway.baseUrl}/register-prep?walletAddress=${FRESH_WALLET}&agentURI=${encodeURIComponent("https://card.example/huge.json")}`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("AGENT_URI_TOO_LARGE");
  });

  it("name with control characters → 400 BAD_NAME", async () => {
    await setup();
    const res = await fetch(
      `${gateway.baseUrl}/register-prep?walletAddress=${FRESH_WALLET}&name=${encodeURIComponent("hithere")}`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("BAD_NAME");
  });

  it("name longer than 64 chars → 400 BAD_NAME", async () => {
    await setup();
    const tooLong = "a".repeat(65);
    const res = await fetch(
      `${gateway.baseUrl}/register-prep?walletAddress=${FRESH_WALLET}&name=${encodeURIComponent(tooLong)}`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("BAD_NAME");
  });

  it("name = '' (after trim) → 400 BAD_NAME", async () => {
    await setup();
    const res = await fetch(
      `${gateway.baseUrl}/register-prep?walletAddress=${FRESH_WALLET}&name=${encodeURIComponent("   ")}`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("BAD_NAME");
  });

  it("name with leading/trailing whitespace → trimmed and accepted", async () => {
    await setup();
    const res = await fetch(
      `${gateway.baseUrl}/register-prep?walletAddress=${FRESH_WALLET}&name=${encodeURIComponent("   Alice   ")}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.resolvedName).toBe("Alice");
  });
});

describe("POST /register — buyer naming", () => {
  let gateway: TestGateway;

  beforeEach(async () => {
    gateway = await startTestGateway({});
    gateway.mockChain.setRegistrationNonce(FRESH_WALLET, 0n);
  });

  afterEach(async () => {
    await gateway?.close();
  });

  it("caches resolved_name in DB after successful registration", async () => {
    gateway.mockChain.queueRegistration({
      kind: "success",
      agentId: 7n,
      txHash: REG_TX,
    });

    const card = { name: "Eve", type: "buyer" };
    const uri = dataUri(card);
    const res = await fetch(`${gateway.baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        walletAddress: FRESH_WALLET,
        agentURI: uri,
        deadline: String(Math.floor(Date.now() / 1000) + 600),
        signature: STUB_SIG,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.agentId).toBe("7");
    expect(body.resolvedName).toBe("Eve");

    const cached = await gateway.bundle.queries.getBuyerIdentity(7n);
    expect(cached?.resolvedName).toBe("Eve");
    expect(cached?.walletAddress.toLowerCase()).toBe(FRESH_WALLET.toLowerCase());
    expect(cached?.agentURI).toBe(uri);
  });
});
