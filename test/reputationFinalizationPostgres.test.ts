import { randomUUID } from "node:crypto";
import {
  encodeAbiParameters,
  encodeEventTopics,
  parseAbi,
  parseAbiParameters,
  type Address,
  type Hex,
  type Log,
  type TransactionReceipt,
} from "viem";
import { describe, expect, it } from "vitest";
import { createPool } from "../src/db/pool.js";
import { finalizeReputationOperation } from "../src/standardRail/reputationFinalization.js";
import type {
  ConfirmationIntent,
  RevokeConfirmationIntent,
} from "../src/standardRail/reputationOperation.js";

const databaseUrl = process.env.DATABASE_URL_TEST ??
  "postgresql://postgres:password@localhost:5433/daski_gateway_test";
const hash = (digit: string): Hex => `0x${digit.repeat(64)}` as Hex;
const payer = "0x1111111111111111111111111111111111111111" as Address;
const recipient = "0x2222222222222222222222222222222222222222" as Address;
const eas = "0x3333333333333333333333333333333333333333" as Address;
const registry = "0x4444444444444444444444444444444444444444" as Address;
const orderKey = hash("1");
const schema = hash("2");

const attestedAbi = parseAbi([
  "event Attested(address indexed recipient,address indexed attester,bytes32 uid,bytes32 indexed schema)",
]);
function receipt(logs: Log[], blockNumber: bigint): TransactionReceipt {
  return {
    blockHash: hash("a"), blockNumber, contractAddress: null, cumulativeGasUsed: 1n,
    effectiveGasPrice: 1n, from: payer, gasUsed: 1n, logs, logsBloom: `0x${"0".repeat(512)}`,
    status: "success", to: eas, transactionHash: hash("b"), transactionIndex: 0,
    type: "eip1559",
  } as TransactionReceipt;
}
function attestedLog(uid: Hex, address: Address = eas): Log {
  return {
    address,
    topics: encodeEventTopics({
      abi: attestedAbi,
      eventName: "Attested",
      args: { recipient, attester: payer, schema },
    }),
    data: encodeAbiParameters(parseAbiParameters("bytes32"), [uid]),
  } as Log;
}
function confirmation(uid: Hex, transitionsUsed: number): ConfirmationIntent {
  return {
    operation: "attest-confirmation",
    orderKey,
    orderId: "order-1",
    outcomeId: "register-domain",
    confirmation: "Confirmed",
    transitionsUsed,
    request: {
      schema,
      data: { recipient, expirationTime: "0", revocable: true, refUID: uid, data: "0x", value: "0" },
      signature: { v: 27, r: hash("3"), s: hash("4") },
      attester: payer,
      deadline: "2000000000",
    },
  };
}

function revocation(uid: Hex): RevokeConfirmationIntent {
  return {
    operation: "revoke-confirmation",
    orderKey,
    orderId: "order-1",
    outcomeId: "register-domain",
    transitionsUsed: 2,
    request: {
      schema,
      data: { uid, value: "0" },
      signature: { v: 27, r: hash("3"), s: hash("4") },
      revoker: payer,
      deadline: "2000000000",
    },
  };
}

describe("reputation finalization against PostgreSQL", () => {
  it("converges repeated attest, revise, and revoke finalization", async () => {
    const namespace = `reputation_finalize_${randomUUID().replaceAll("-", "")}`;
    const bootstrap = createPool({ connectionString: databaseUrl, max: 1 });
    await bootstrap.query(`CREATE SCHEMA "${namespace}"`);
    const pool = createPool({ connectionString: databaseUrl, searchPath: namespace, max: 3 });
    try {
      await createTables(pool);
      const uid1 = hash("5");
      const uid2 = hash("6");
      await seedOperation(pool, "op-1", "tx-1");
      const first = confirmation(hash("0"), 0);
      await finalizeReputationOperation({
        pool, operation: { operation_id: "op-1", order_id: "order-1", canonical_intent: first },
        transactionId: "tx-1", easAddress: eas, receipt: receipt([attestedLog(uid1)], 10n),
      });
      await finalizeReputationOperation({
        pool, operation: { operation_id: "op-1", order_id: "order-1", canonical_intent: first },
        transactionId: "tx-1", easAddress: eas, receipt: receipt([attestedLog(uid1)], 10n),
      });

      await seedOperation(pool, "op-2", "tx-2");
      const revised = confirmation(uid1, 1);
      await finalizeReputationOperation({
        pool, operation: { operation_id: "op-2", order_id: "order-1", canonical_intent: revised },
        transactionId: "tx-2", easAddress: eas, receipt: receipt([attestedLog(uid2)], 11n),
      });
      await seedOperation(pool, "op-3", "tx-3");
      const revoked = revocation(uid2);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await finalizeReputationOperation({
          pool, operation: { operation_id: "op-3", order_id: "order-1", canonical_intent: revoked },
          transactionId: "tx-3", easAddress: eas, receipt: receipt([], 12n),
        });
      }
      const confirmationRow = await pool.query(
        "SELECT confirmation,current_uid,transitions_used FROM standard_reputation_confirmations",
      );
      expect(confirmationRow.rows).toEqual([{
        confirmation: "Pending", current_uid: null, transitions_used: 3,
      }]);
      await expect(finalizeReputationOperation({
        pool, operation: { operation_id: "op-1", order_id: "order-1", canonical_intent: first },
        transactionId: "tx-1", easAddress: eas,
        receipt: receipt([attestedLog(uid1), attestedLog(uid1, registry)], 10n),
      })).resolves.toBeUndefined();
      await expect(finalizeReputationOperation({
        pool, operation: { operation_id: "op-1", order_id: "order-1", canonical_intent: first },
        transactionId: "tx-1", easAddress: eas,
        receipt: receipt([attestedLog(uid1), attestedLog(uid1)], 10n),
      })).rejects.toThrow("CONFIRMATION_UID_MISSING_OR_AMBIGUOUS");
      const afterStaleReplay = await pool.query(
        "SELECT confirmation,current_uid,transitions_used FROM standard_reputation_confirmations",
      );
      expect(afterStaleReplay.rows).toEqual([{
        confirmation: "Pending", current_uid: null, transitions_used: 3,
      }]);

    } finally {
      await pool.end();
      await bootstrap.query(`DROP SCHEMA "${namespace}" CASCADE`).catch(() => undefined);
      await bootstrap.end();
    }
  });
});

async function createTables(pool: ReturnType<typeof createPool>): Promise<void> {
  await pool.query(`
    CREATE TABLE standard_reputation_operations (
      operation_id TEXT PRIMARY KEY,state TEXT NOT NULL,result JSONB,final_block_number BIGINT,
      final_block_hash TEXT,next_attempt_at TIMESTAMPTZ,updated_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE standard_reputation_transactions (
      transaction_id TEXT PRIMARY KEY,state TEXT NOT NULL,block_number BIGINT,block_hash TEXT,
      final_at TIMESTAMPTZ,updated_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE standard_reputation_confirmations (
      order_id TEXT PRIMARY KEY,order_key BYTEA,current_uid BYTEA,confirmation TEXT,
      transitions_used INTEGER,finalized_block BIGINT,finalized_block_hash TEXT,
      updated_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE standard_confirmation_sponsorships (
      operation_id TEXT PRIMARY KEY,state TEXT,updated_at TIMESTAMPTZ DEFAULT now());
  `);
}

async function seedOperation(pool: ReturnType<typeof createPool>, operationId: string, transactionId: string) {
  await pool.query("INSERT INTO standard_reputation_operations(operation_id,state) VALUES ($1,'broadcast')", [operationId]);
  await pool.query("INSERT INTO standard_reputation_transactions(transaction_id,state) VALUES ($1,'broadcast')", [transactionId]);
  await pool.query("INSERT INTO standard_confirmation_sponsorships(operation_id,state) VALUES ($1,'reserved')", [operationId]);
}
