import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GATEWAY_TASK_ID_PATTERN,
  createGatewayTaskId,
  hashGatewayTaskId,
  isGatewayTaskId,
} from "../src/tasks/taskId.js";

describe("gateway task handles", () => {
  it("mints unguessable base64url handles carrying 32 bytes of entropy", () => {
    const minted = Array.from({ length: 256 }, () => createGatewayTaskId());
    for (const id of minted) {
      expect(id).toMatch(GATEWAY_TASK_ID_PATTERN);
      expect(id).toHaveLength(43);
      expect(Buffer.from(id, "base64url")).toHaveLength(32);
    }
    // A repeated handle would let one buyer read another buyer's task.
    expect(new Set(minted).size).toBe(minted.length);
  });

  it("admits only its own handle shape", () => {
    expect(isGatewayTaskId(createGatewayTaskId())).toBe(true);
    expect(isGatewayTaskId("t".repeat(43))).toBe(true);

    // Provider task ids are internal routing data and must never resolve.
    for (const providerShaped of [
      "task-42",
      "buyer-task",
      "task-document-1",
      "550e8400-e29b-41d4-a716-446655440000",
    ]) {
      expect(isGatewayTaskId(providerShaped)).toBe(false);
    }

    for (const malformed of [
      "",
      "t".repeat(42),
      "t".repeat(44),
      `${"t".repeat(42)}+`,
      `${"t".repeat(42)}/`,
      `${"t".repeat(42)}=`,
      `${"t".repeat(42)} `,
      ` ${"t".repeat(42)}`,
      `${"t".repeat(21)}\n${"t".repeat(21)}`,
    ]) {
      expect(isGatewayTaskId(malformed)).toBe(false);
    }
  });

  it("stores handles only as a stable 32-byte digest", () => {
    const id = createGatewayTaskId();
    const digest = hashGatewayTaskId(id);

    expect(digest).toHaveLength(32);
    expect(digest).toEqual(createHash("sha256").update(id, "utf8").digest());
    expect(hashGatewayTaskId(id)).toEqual(digest);
    // The digest is what lands in task_mappings.public_id_hash — a database
    // reader must not be able to recover the bearer handle from it.
    expect(digest.toString("utf8")).not.toContain(id);
    expect(digest.toString("base64url")).not.toBe(id);
  });

  it("separates handles that differ by a single character", () => {
    const id = createGatewayTaskId();
    const neighbour = `${id.slice(0, 42)}${id.at(42) === "A" ? "B" : "A"}`;

    expect(neighbour).not.toBe(id);
    expect(isGatewayTaskId(neighbour)).toBe(true);
    expect(hashGatewayTaskId(neighbour)).not.toEqual(hashGatewayTaskId(id));
  });
});
