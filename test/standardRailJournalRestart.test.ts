import { describe, expect, it } from "vitest";
import type { Pool } from "../src/db/pool.js";
import type { Hex } from "../src/types.js";
import { canonicalHash } from "../src/standardRail/canonical.js";
import { StandardRailJournal } from "../src/standardRail/journal.js";
import { buildStandardEvidenceBundleV2 } from "../src/standardRail/wireContracts.js";

const hash = (byte: string): Hex => `0x${byte.repeat(64)}` as Hex;

function mockPool(row: Record<string, unknown>): Pool {
  return {
    query: async () => ({ rows: [row], rowCount: 1 }),
  } as unknown as Pool;
}

describe("standard rail journal restart", () => {
  it("recovers release allocation and sequence deterministically", async () => {
    const canonicalEvidence = {
      kind: "release",
      observations: ["rpc-a", "rpc-b"].map((source) => ({
        observation: { source },
        allocation: {
          providerNetAmount: "90",
          daskiCommissionAmount: "10",
          releaseSequence: "8",
        },
      })),
    };
    const evidenceHash = canonicalHash(canonicalEvidence);
    const row = {
      transaction_hash: hash("a"),
      block_number: "102",
      block_hash: hash("b"),
      transaction_index: 4,
      log_index: 5,
      evidence_hash: Buffer.from(evidenceHash.slice(2), "hex"),
      canonical_evidence: canonicalEvidence,
      source_fingerprints: ["rpc-a", "rpc-b"],
    };
    const first = await new StandardRailJournal(mockPool(row))
      .loadEvidence("order-1", "release");
    const restarted = await new StandardRailJournal(mockPool({
      ...structuredClone(row),
      evidence_hash: Buffer.from(row.evidence_hash),
    }))
      .loadEvidence("order-1", "release");

    expect(first).toEqual(restarted);
    expect(first.releaseSequence).toBe(8n);
    expect(first.providerNetAmount).toBe(90n);
    expect(first.daskiCommissionAmount).toBe(10n);

    const deposit = {
      ...first,
      transactionHash: hash("c"),
      blockNumber: 101n,
      blockHash: hash("d"),
      transactionIndex: 2,
      logIndex: 3,
      evidenceHash: hash("e"),
    };
    expect(buildStandardEvidenceBundleV2(deposit, first))
      .toEqual(buildStandardEvidenceBundleV2({ ...deposit }, restarted));
  });

  it("rejects a persisted release whose canonical evidence hash changed", async () => {
    const canonicalEvidence = {
      kind: "release",
      observations: [{
        observation: { source: "rpc-a" },
        allocation: {
          providerNetAmount: "90",
          daskiCommissionAmount: "10",
          releaseSequence: "8",
        },
      }],
    };
    const row = {
      transaction_hash: hash("a"),
      block_number: "102",
      block_hash: hash("b"),
      transaction_index: 4,
      log_index: 5,
      evidence_hash: Buffer.from(hash("f").slice(2), "hex"),
      canonical_evidence: canonicalEvidence,
      source_fingerprints: ["rpc-a"],
    };

    await expect(new StandardRailJournal(mockPool(row))
      .loadEvidence("order-1", "release"))
      .rejects.toThrow(/evidence hash is invalid/);
  });
});
