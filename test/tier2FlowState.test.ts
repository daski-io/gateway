import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";
import type { Hex } from "../src/types.js";

// Durable flow state: canonical serviceArgs are written atomically with the
// challenge, and every dispatch leaves a recoverable operation trace.

const REF = ("0x" + "ab".repeat(32)) as Hex;
const SERVICE_ID = ("0x" + "cd".repeat(32)) as Hex;
const WALLET = ("0x" + "12".repeat(20)) as Hex;

describe("tier 2 durable flow state", () => {
  let gw: TestGateway;

  beforeAll(async () => {
    gw = await startTestGateway();
  });
  afterAll(async () => {
    await gw.close();
  });

  it("stores and restores service arguments with the challenge", async () => {
    const serviceArgs = {
      domain: "example.xyz",
      years: 1,
      registrantPhone: "+15125550142",
    };
    await gw.bundle.queries.insertChallenge({
      serviceRef: REF,
      providerTokenId: 1n,
      buyerTokenId: 5n,
      amount: 1000n,
      skillId: "register-domain",
      serviceSlug: "domain-management",
      serviceVersion: "1",
      serviceId: SERVICE_ID,
      providerA2AUrl: "https://provider.example/a2a",
      walletAddress: WALLET,
      expiresAt: new Date(Date.now() + 60_000),
      serviceArgs,
      providerAuthority: {
        walletAddress: WALLET,
        agentURI: "https://provider.example/agent.json",
        observedBlock: 0n,
      },
    });
    const challenge = await gw.bundle.queries.getChallengeByRef(REF);
    expect(challenge?.serviceArgs).toEqual(serviceArgs);
  });

  it("removes the abandoned acknowledgements column", async () => {
    const legacyRef = ("0x" + "ef".repeat(32)) as Hex;
    await gw.bundle.queries.insertChallenge({
      serviceRef: legacyRef,
      providerTokenId: 1n,
      buyerTokenId: 5n,
      amount: 1000n,
      skillId: "register-domain",
      serviceSlug: "domain-management",
      serviceVersion: "1",
      serviceId: SERVICE_ID,
      providerA2AUrl: "https://provider.example/a2a",
      walletAddress: WALLET,
      expiresAt: new Date(Date.now() + 60_000),
      serviceArgs: {},
      providerAuthority: {
        walletAddress: WALLET,
        agentURI: "https://provider.example/agent.json",
        observedBlock: 0n,
      },
    });
    const challenge = await gw.bundle.queries.getChallengeByRef(legacyRef);
    expect(challenge?.serviceArgs).toEqual({});
    const columns = await gw.bundle.pool.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'payment_challenges'
          AND column_name = 'acknowledgements'`,
    );
    expect(columns.rows).toHaveLength(0);
  });

  it("records and completes the operation trace", async () => {
    await gw.bundle.queries.insertTaskMapping({
      contextId: "ctx-1",
      messageId: "msg-1",
      serviceRef: REF,
      providerA2AUrl: "https://provider.example/a2a",
      skillId: "register-domain",
      buyerTokenId: "5",
    });

    // Pending trace: dispatch recorded, response not yet seen.
    const pending = await gw.bundle.queries.latestTaskMappingByContext("ctx-1");
    expect(pending?.taskId).toBeNull();
    expect(pending?.skillId).toBe("register-domain");

    await gw.bundle.queries.completeTaskMapping("ctx-1", "task-42", "submitted");
    const done = await gw.bundle.queries.latestTaskMappingByContext("ctx-1");
    expect(done?.taskId).toBe("task-42");
    expect(done?.status).toBe("submitted");

    // Recovery by serviceRef finds the same trace.
    const byRef = await gw.bundle.queries.latestTaskMappingByServiceRef(REF);
    expect(byRef?.taskId).toBe("task-42");
  });

  it("completeTaskMapping touches only the newest row for a context", async () => {
    await gw.bundle.queries.insertTaskMapping({
      contextId: "ctx-2",
      messageId: "msg-a",
      serviceRef: null,
      providerA2AUrl: "https://provider.example/a2a",
      skillId: "check-availability",
      buyerTokenId: null,
    });
    await gw.bundle.queries.insertTaskMapping({
      contextId: "ctx-2",
      messageId: "msg-b",
      serviceRef: null,
      providerA2AUrl: "https://provider.example/a2a",
      skillId: "check-availability",
      buyerTokenId: null,
    });
    await gw.bundle.queries.completeTaskMapping("ctx-2", "task-b", "working");
    const latest = await gw.bundle.queries.latestTaskMappingByContext("ctx-2");
    expect(latest?.taskId).toBe("task-b");
  });
});
