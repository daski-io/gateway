import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";
import type { Hex } from "../src/types.js";

const REF = ("0x" + "ab".repeat(32)) as Hex;
const SERVICE_ID = ("0x" + "cd".repeat(32)) as Hex;
const WALLET = ("0x" + "12".repeat(20)) as Hex;

describe("durable payment and task bindings", () => {
  let gateway: TestGateway;

  beforeAll(async () => {
    gateway = await startTestGateway();
  });
  afterAll(async () => {
    await gateway.close();
  });

  it("stores commitments without raw service arguments", async () => {
    await gateway.bundle.queries.insertChallenge({
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
      quoteRequestHash: ("0x" + "34".repeat(32)) as Hex,
      providerAuthority: {
        walletAddress: WALLET,
        agentURI: "https://provider.example/agent.json",
        observedBlock: 0n,
      },
    });
    const challenge = await gateway.bundle.queries.getChallengeByRef(REF);
    expect(challenge?.quoteRequestHash).toBe(`0x${"34".repeat(32)}`);
    expect(challenge).not.toHaveProperty("serviceArgs");
  });

  it("removes abandoned and sensitive challenge columns", async () => {
    const columns = await gateway.bundle.pool.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'payment_challenges'
          AND column_name IN ('acknowledgements', 'service_args')`,
    );
    expect(columns.rows).toHaveLength(0);
  });

  it("resolves only an exact completed provider/task binding", async () => {
    const mappingId = await gateway.bundle.queries.insertTaskMapping({
      contextId: "ctx-1",
      messageId: "msg-1",
      serviceRef: REF,
      providerA2AUrl: "https://provider.example/a2a",
      skillId: "register-domain",
      buyerTokenId: "5",
    });
    expect(
      await gateway.bundle.queries.completedTaskMapping(
        "https://provider.example/a2a",
        "task-42",
      ),
    ).toBeNull();

    await gateway.bundle.queries.completeTaskMapping(
      mappingId,
      "task-42",
      "submitted",
    );
    const completed = await gateway.bundle.queries.completedTaskMapping(
      "https://provider.example/a2a",
      "task-42",
    );
    expect(completed).toMatchObject({
      contextId: "ctx-1",
      taskId: "task-42",
      buyerTokenId: 5n,
      status: "submitted",
    });
  });

  it("completes an identical provider replay without stale mappings", async () => {
    await gateway.bundle.queries.insertTaskMapping({
      contextId: "ctx-original",
      messageId: "msg-replay",
      serviceRef: null,
      providerA2AUrl: "https://provider.example/a2a",
      skillId: "check-availability",
      buyerTokenId: "0",
    });
    const replayId = await gateway.bundle.queries.insertTaskMapping({
      contextId: "ctx-retry",
      messageId: "msg-replay",
      serviceRef: null,
      providerA2AUrl: "https://provider.example/a2a",
      skillId: "check-availability",
      buyerTokenId: "0",
    });
    await gateway.bundle.queries.completeTaskMapping(
      replayId,
      "task-replay",
      "working",
    );
    const duplicateId = await gateway.bundle.queries.insertTaskMapping({
      contextId: "ctx-retry-again",
      messageId: "msg-replay",
      serviceRef: null,
      providerA2AUrl: "https://provider.example/a2a",
      skillId: "check-availability",
      buyerTokenId: "0",
    });
    await gateway.bundle.queries.completeTaskMapping(
      duplicateId,
      "task-replay",
      "working",
    );

    const count = await gateway.bundle.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM task_mappings
        WHERE provider_a2a_url = $1
          AND message_id = 'msg-replay'`,
      ["https://provider.example/a2a"],
    );
    expect(count.rows[0]?.count).toBe("1");
  });
});
