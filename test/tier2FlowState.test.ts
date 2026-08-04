import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";
import type { Hex } from "../src/types.js";
import { hashGatewayTaskId } from "../src/tasks/taskId.js";

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

  it("resolves only a completed opaque gateway task handle", async () => {
    const pending = await gateway.tasks.begin({
      contextId: "ctx-1",
      messageId: "msg-1",
      serviceRef: REF,
      providerA2AUrl: "https://provider.example/a2a",
      skillId: "register-domain",
      buyerTokenId: "5",
    });
    expect(await gateway.tasks.resolve(pending.taskId)).toBeNull();
    expect(await gateway.tasks.resolve("task-42")).toBeNull();

    await gateway.tasks.complete(
      pending.mappingId,
      "task-42",
      "submitted",
    );
    const completed = await gateway.tasks.resolve(pending.taskId);
    expect(completed).toMatchObject({
      contextId: "ctx-1",
      providerTaskId: "task-42",
      buyerTokenId: 5n,
      status: "submitted",
    });
    const stored = await gateway.bundle.pool.query<{
      public_id_hash: Buffer;
      provider_task_id: string;
    }>(
      `SELECT public_id_hash, provider_task_id
         FROM task_mappings
        WHERE id = $1`,
      [pending.mappingId],
    );
    expect(stored.rows[0]?.public_id_hash).toEqual(
      hashGatewayTaskId(pending.taskId),
    );
    expect(stored.rows[0]?.provider_task_id).toBe("task-42");
    expect(Object.values(stored.rows[0] ?? {})).not.toContain(pending.taskId);
  });

  it("keeps existing gateway handles valid across an exact provider replay", async () => {
    const first = await gateway.tasks.begin({
      contextId: "ctx-retry",
      messageId: "msg-replay",
      serviceRef: null,
      providerA2AUrl: "https://provider.example/a2a",
      skillId: "check-availability",
      buyerTokenId: "0",
    });
    await gateway.tasks.complete(
      first.mappingId,
      "task-replay",
      "working",
    );
    const second = await gateway.tasks.begin({
      contextId: "ctx-retry-again",
      messageId: "msg-replay",
      serviceRef: null,
      providerA2AUrl: "https://provider.example/a2a",
      skillId: "check-availability",
      buyerTokenId: "0",
    });
    await gateway.tasks.complete(
      second.mappingId,
      "task-replay",
      "working",
    );

    expect(first.taskId).not.toBe(second.taskId);
    expect((await gateway.tasks.resolve(first.taskId))?.providerTaskId).toBe(
      "task-replay",
    );
    expect((await gateway.tasks.resolve(second.taskId))?.providerTaskId).toBe(
      "task-replay",
    );
  });

  it("deletes failed and expired pending mappings without completed tasks", async () => {
    const failed = await gateway.tasks.begin({
      contextId: "ctx-failed",
      messageId: "msg-failed",
      serviceRef: null,
      providerA2AUrl: "https://provider.example/a2a",
      skillId: "check-availability",
      buyerTokenId: "0",
    });
    expect(
      await gateway.bundle.queries.deletePendingTaskMapping(failed.mappingId),
    ).toBe(true);

    const expired = await gateway.tasks.begin({
      contextId: "ctx-expired",
      messageId: "msg-expired",
      serviceRef: null,
      providerA2AUrl: "https://provider.example/a2a",
      skillId: "check-availability",
      buyerTokenId: "0",
    });
    const completed = await gateway.tasks.begin({
      contextId: "ctx-completed",
      messageId: "msg-completed",
      serviceRef: null,
      providerA2AUrl: "https://provider.example/a2a",
      skillId: "check-availability",
      buyerTokenId: "0",
    });
    await gateway.tasks.complete(
      completed.mappingId,
      "task-completed",
      "completed",
    );
    await gateway.bundle.pool.query(
      "UPDATE task_mappings SET created_at = now() - interval '2 days' WHERE id IN ($1, $2)",
      [expired.mappingId, completed.mappingId],
    );

    expect(
      await gateway.bundle.queries.deleteExpiredPendingTaskMappings(86_400),
    ).toBe(1);
    expect(
      await gateway.tasks.resolve(completed.taskId),
    ).not.toBeNull();
    await gateway.bundle.pool.query(
      `UPDATE task_mappings
          SET created_at = now() - interval '2 days',
              expires_at = now() - interval '1 day'
        WHERE id = $1`,
      [completed.mappingId],
    );
    expect(await gateway.tasks.resolve(completed.taskId)).toBeNull();
    expect(await gateway.bundle.queries.deleteExpiredTaskMappings()).toBe(1);
  });

  it("enforces identifier bounds at the persistence boundary", async () => {
    await expect(
      gateway.tasks.begin({
        contextId: "x".repeat(257),
        messageId: "msg",
        serviceRef: null,
        providerA2AUrl: "https://provider.example/a2a",
        skillId: "check-availability",
        buyerTokenId: "0",
      }),
    ).rejects.toThrow();
  });
});
