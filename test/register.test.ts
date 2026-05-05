import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";
import type { Hex } from "../src/types.js";

const FRESH_WALLET = "0xcccc000000000000000000000000000000000001" as Hex;
const KNOWN_AGENT_WALLET =
  "0xdddd000000000000000000000000000000000002" as Hex;
const STUB_SIG = ("0x" + "11".repeat(65)) as Hex;
const REG_TX =
  "0x3333333333333333333333333333333333333333333333333333333333333333" as Hex;

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
    expect(body.eip712TypedData.domain.name).toBe("Daski IdentityRegistry");
    expect(body.eip712TypedData.domain.verifyingContract).toBe(
      gateway.config.identityRegistryAddress,
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
});
