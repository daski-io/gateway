import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPool, runMigrations, type Pool } from "../src/db/pool.js";
import { canonicalHash } from "../src/standardRail/canonical.js";
import type { TerminalEvidence } from "../src/standardRail/operationsStore.js";
import { StandardRailStore, type CreateDraftInput } from "../src/standardRail/store.js";
import { LISTINGS, PROVIDER_AGENT_ID, PROVIDER_WIRE_DIR } from "./helpers/providerWire.js";

/// The provider-wire operations and terminal-evidence verdicts, replayed
/// through the stored order operations themselves: the same rules the
/// consumer test applies to fixture answers decide what PostgreSQL keeps.
const databaseUrl = process.env.DATABASE_URL_TEST ??
  "postgresql://postgres:password@localhost:5433/daski_gateway_test";
type Doc = Record<string, any>;
const load = (name: string): Doc => JSON.parse(readFileSync(path.join(PROVIDER_WIRE_DIR, name), "utf8")) as Doc;
const operations = load("operations.json");
const terminal = load("terminal-evidence.json");

let bootstrap: Pool;
let pool: Pool;
let store: StandardRailStore;
const schema = `gateway_provider_wire_${randomUUID().replaceAll("-", "")}`;

beforeAll(async () => {
  bootstrap = createPool({ connectionString: databaseUrl, max: 1 });
  await bootstrap.query(`CREATE SCHEMA "${schema}"`);
  pool = createPool({ connectionString: databaseUrl, searchPath: `${schema},public`, max: 2 });
  await runMigrations(pool);
  store = new StandardRailStore(pool);
  vi.useFakeTimers({ toFake: ["Date"] });
}, 60_000);

afterAll(async () => {
  vi.useRealTimers();
  await pool.end();
  await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`);
  await bootstrap.end();
});

async function order(): Promise<string> {
  const draft: CreateDraftInput = {
    providerAgentId: PROVIDER_AGENT_ID, outcomeId: LISTINGS.fixed.outcomeId, bindingProfile: "recipe-bound-v2",
    listingManifestHash: LISTINGS.fixed.listingManifestHash, providerOfferHash: LISTINGS.fixed.providerOfferHash,
    listing: { deadlinePolicy: { minimumPaymentWindowSeconds: 30 } } as CreateDraftInput["listing"],
    quoteHash: canonicalHash(randomUUID()), quote: {} as CreateDraftInput["quote"], orderNonce: canonicalHash(randomUUID()),
    intentId: `int_${randomUUID()}`, canonicalRequestHash: canonicalHash(randomUUID()), canonicalRequest: {},
    grossAmount: LISTINGS.fixed.fixedGrossAmount, railEpoch: "1", listingEpoch: "1",
    expiresAt: new Date(Date.now() + 60_000), expectedPayer: null,
  };
  return (await store.createDraft(draft)).order.orderId;
}

async function stored(orderId: string) {
  const result = await pool.query<{ revision: string; observed_at: string; original_terminal: TerminalEvidence | null }>(
    "SELECT revision,observed_at,original_terminal FROM standard_order_operations WHERE order_id=$1", [orderId]);
  const row = result.rows[0];
  return row ? { revision: Number(row.revision), observedAt: Number(row.observed_at), originalTerminal: row.original_terminal } : null;
}

async function persist(orderId: string, now: number, input: unknown, evidence: TerminalEvidence | null): Promise<Error | null> {
  vi.setSystemTime(now * 1_000);
  return store.persistOperations(orderId, input, evidence).then(() => null, (error: Error) => error);
}

describe("provider-wire operations in PostgreSQL", () => {
  for (const sequence of operations.sequences as Doc[]) {
    it(sequence.id, async () => {
      const orderId = await order();
      for (const step of sequence.steps as Doc[]) {
        const before = await stored(orderId);
        const error = await persist(orderId, step.now, step.operations, step.terminal);
        const after = await stored(orderId);
        if (step.expect === "stored") {
          expect(error).toBeNull();
          expect(after).toMatchObject({ revision: step.operations.revision, observedAt: step.operations.observedAt });
        } else {
          expect(error?.message ?? null).toBe(step.expect === "rejected" ? step.error : null);
          expect(after).toEqual(before);
        }
      }
    });
  }

  for (const vector of terminal.responses as Doc[]) {
    it(`terminal evidence ${vector.id}`, async () => {
      const orderId = await order();
      const original = vector.gateway.storedTerminal as TerminalEvidence;
      expect(await persist(orderId, vector.gateway.storedOperations.observedAt, vector.gateway.storedOperations, original)).toBeNull();
      const body = vector.response.body as Doc;
      const error = await persist(orderId, vector.gateway.receivedAt, body.operations, body.terminalAttestation);
      expect(error?.message ?? null).toBe(vector.gateway.verdict === "accepted" ? null : vector.gateway.message);
      // The first accepted attestation stays the original whatever follows.
      expect((await stored(orderId))?.originalTerminal).toEqual(original);
    });
  }
});
