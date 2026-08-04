import { describe, expect, it, vi } from "vitest";
import type { Queries } from "../src/db/queries.js";
import type { Hex } from "../src/types.js";
import { DaskiTaskService } from "../src/tasks/taskService.js";
import { hashGatewayTaskId, isGatewayTaskId } from "../src/tasks/taskId.js";

const RETENTION_SECONDS = 7 * 24 * 60 * 60;

interface InsertedMapping {
  contextId: string;
  messageId: string | null;
  serviceRef: Hex | null;
  providerA2AUrl: string;
  skillId: string;
  buyerTokenId: string;
  publicIdHash: Buffer;
  expiresAt: Date;
}

function stubQueries() {
  const calls = {
    insertTaskMapping: vi.fn(async (_mapping: InsertedMapping) => "mapping-1"),
    completeTaskMapping: vi.fn(
      async (_mappingId: string, _providerTaskId: string, _status: string) =>
        undefined,
    ),
    deletePendingTaskMapping: vi.fn(async (_mappingId: string) => true),
    completedTaskMapping: vi.fn(async (_publicIdHash: Buffer) => null),
    updateTaskMappingStatus: vi.fn(
      async (_publicIdHash: Buffer, _status: string) => true,
    ),
  };
  return {
    calls,
    queries: calls as unknown as Queries,
  };
}

function serviceWith(retentionSeconds = RETENTION_SECONDS) {
  const { calls, queries } = stubQueries();
  return { calls, service: new DaskiTaskService(queries, retentionSeconds) };
}

// A well-formed handle nobody has been issued: it must still reach the
// database, because only the database can say whether it exists.
const UNKNOWN_HANDLE = "u".repeat(43);

describe("DaskiTaskService", () => {
  it("persists the digest and an expiry, never the handle itself", async () => {
    const { calls, service } = serviceWith();
    const before = Date.now();

    const pending = await service.begin({
      contextId: "ctx-begin",
      messageId: "msg-begin",
      serviceRef: null,
      providerA2AUrl: "https://provider.example/a2a",
      skillId: "register-domain",
      buyerTokenId: "5",
    });

    expect(isGatewayTaskId(pending.taskId)).toBe(true);
    expect(pending.mappingId).toBe("mapping-1");
    expect(calls.insertTaskMapping).toHaveBeenCalledTimes(1);

    const inserted = calls.insertTaskMapping.mock.calls[0]![0];
    expect(inserted.contextId).toBe("ctx-begin");
    expect(inserted.publicIdHash).toEqual(hashGatewayTaskId(pending.taskId));
    expect(JSON.stringify(inserted)).not.toContain(pending.taskId);
    expect(inserted.expiresAt.getTime() - before).toBeGreaterThanOrEqual(
      RETENTION_SECONDS * 1000,
    );
    expect(pending.expiresAt.getTime() - pending.createdAt.getTime()).toBe(
      RETENTION_SECONDS * 1000,
    );
  });

  it("issues a distinct handle per dispatch", async () => {
    const { service } = serviceWith();
    const input = {
      contextId: "ctx-shared",
      messageId: "msg-shared",
      serviceRef: null,
      providerA2AUrl: "https://provider.example/a2a",
      skillId: "check-availability",
      buyerTokenId: "0",
    };

    const first = await service.begin(input);
    const second = await service.begin(input);

    expect(first.taskId).not.toBe(second.taskId);
  });

  it("looks up a well-formed handle by digest only", async () => {
    const { calls, service } = serviceWith();

    expect(await service.resolve(UNKNOWN_HANDLE)).toBeNull();

    expect(calls.completedTaskMapping).toHaveBeenCalledWith(
      hashGatewayTaskId(UNKNOWN_HANDLE),
    );
  });

  // Sprayed garbage ids are cheap to generate and must not each cost a
  // database round trip.
  it("rejects a malformed handle before touching the database", async () => {
    const { calls, service } = serviceWith();

    for (const malformed of ["", "task-42", "buyer-task", "t".repeat(44)]) {
      expect(await service.resolve(malformed)).toBeNull();
      await service.recordStatus(malformed, "completed");
    }

    expect(calls.completedTaskMapping).not.toHaveBeenCalled();
    expect(calls.updateTaskMappingStatus).not.toHaveBeenCalled();
  });

  it("records status against the digest of a well-formed handle", async () => {
    const { calls, service } = serviceWith();

    await service.recordStatus(UNKNOWN_HANDLE, "completed");

    expect(calls.updateTaskMappingStatus).toHaveBeenCalledWith(
      hashGatewayTaskId(UNKNOWN_HANDLE),
      "completed",
    );
  });

  it("skips the delete when there is no pending mapping to abandon", async () => {
    const { calls, service } = serviceWith();

    await service.abandon(null);
    expect(calls.deletePendingTaskMapping).not.toHaveBeenCalled();

    await service.abandon("mapping-1");
    expect(calls.deletePendingTaskMapping).toHaveBeenCalledWith("mapping-1");
  });
});
