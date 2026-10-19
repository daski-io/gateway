import { EventEmitter } from "node:events";
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { createPool } from "../src/db/pool.js";

// Never connected: emitting the pool's events needs no database.
const CONNECTION = "postgresql://runtime-role:never-logged-secret@db.internal.example:5432/gateway";

async function stderrLines(run: () => void): Promise<string[]> {
  const lines: string[] = [];
  const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    run();
  } finally {
    write.mockRestore();
  }
  return lines;
}

function terminated(): Error {
  return Object.assign(new Error("terminating connection due to administrator command"), {
    code: "57P01",
    severity: "FATAL",
  });
}

describe("database pool connection errors", () => {
  it("shows the failure it prevents: a pool with no 'error' listener throws", async () => {
    const bare = new pg.Pool({ connectionString: CONNECTION });
    try {
      expect(() => bare.emit("error", terminated(), new EventEmitter())).toThrow(/administrator command/);
    } finally {
      await bare.end();
    }
  });

  it("logs an idle client's lost connection by pool name, never the connection string, and keeps running", async () => {
    const pool = createPool({ connectionString: CONNECTION, name: "runtime" });
    try {
      const lines = await stderrLines(() => {
        expect(() => pool.emit("error", terminated(), new EventEmitter())).not.toThrow();
      });
      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0]!) as { level: string; message: string; details: Record<string, any> };
      expect(entry).toMatchObject({
        level: "error",
        message: "database connection lost",
        details: { pool: "runtime", error: { name: "Error", code: "57P01" } },
      });
      // The shared sanitizer logs an error's name, code and stack, not its message.
      expect(entry.details.error.message).toBeUndefined();
      for (const secret of ["never-logged-secret", "runtime-role", "db.internal.example", "postgresql://"]) {
        expect(lines[0]).not.toContain(secret);
      }
    } finally {
      await pool.end();
    }
  });

  it("keeps a checked-out client's lost connection from ending the process and reports each client once", async () => {
    const pool = createPool({ connectionString: CONNECTION });
    try {
      const held = new EventEmitter();
      const other = new EventEmitter();
      pool.emit("connect", held);
      pool.emit("connect", other);
      const lines = await stderrLines(() => {
        // A held client errors once for the backend's message and again when its socket ends.
        expect(() => held.emit("error", terminated())).not.toThrow();
        expect(() => held.emit("error", new Error("Connection terminated unexpectedly"))).not.toThrow();
        expect(() => pool.emit("error", terminated(), held)).not.toThrow();
        expect(() => other.emit("error", new Error("Connection terminated unexpectedly"))).not.toThrow();
      });
      expect(lines.map((line) => JSON.parse(line).details)).toEqual([
        expect.objectContaining({ pool: "database", error: expect.objectContaining({ code: "57P01" }) }),
        expect.objectContaining({ pool: "database", error: expect.objectContaining({ name: "Error" }) }),
      ]);
    } finally {
      await pool.end();
    }
  });
});
