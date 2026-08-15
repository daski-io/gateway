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
import { finalizeReputationMirrorTransaction } from "../src/standardRail/reputationMirrorFinalization.js";
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
const mirrorClient = "0x5555555555555555555555555555555555555555" as Address;
const orderKey = hash("1");
const schema = hash("2");

const attestedAbi = parseAbi([
  "event Attested(address indexed recipient,address indexed attester,bytes32 uid,bytes32 indexed schema)",
]);
const feedbackAbi = parseAbi([
  "event NewFeedback(uint256 indexed agentId,address indexed clientAddress,uint64 feedbackIndex,int128 value,uint8 valueDecimals,string indexed indexedTag1,string tag1,string tag2,string endpoint,string feedbackURI,bytes32 feedbackHash)",
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
function feedbackLog(uid: Hex, index: bigint, address: Address = registry): Log {
  return {
    address,
    topics: encodeEventTopics({
      abi: feedbackAbi,
      eventName: "NewFeedback",
      args: { agentId: 8060n, clientAddress: mirrorClient, indexedTag1: "daski" },
    }),
    data: encodeAbiParameters(
      parseAbiParameters("uint64,int128,uint8,string,string,string,string,bytes32"),
      [index, 100n, 0, "daski", "register-domain", "", "https://easscan.example", uid],
    ),
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
  it("converges repeated attest, revise, revoke, and mirror finalization", async () => {
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

      await pool.query(
        `UPDATE standard_reputation_mirrors SET desired_revision=1,desired_confirmation='Confirmed',
          desired_uid=$1,state='broadcast' WHERE order_id='order-1'`,
        [Buffer.from(uid1.slice(2), "hex")],
      );
      await seedMirrorTransaction(pool, "mirror-1");
      const mirrorArgs = {
        pool, registry, clientAddress: mirrorClient,
        row: { order_id: "order-1", provider_agent_id: "8060", outcome_id: "register-domain" },
        transaction: {
          transaction_id: "mirror-1", desired_revision: "1", operation: "give" as const,
          target_uid: Buffer.from(uid1.slice(2), "hex"), target_confirmation: "Confirmed" as const,
        },
        receipt: receipt([feedbackLog(uid1, 7n)], 20n),
      };
      await finalizeReputationMirrorTransaction(mirrorArgs);
      await finalizeReputationMirrorTransaction(mirrorArgs);
      const mirrored = await pool.query(
        "SELECT state,active_feedback_index,active_uid,transaction_count FROM standard_reputation_mirrors",
      );
      expect(mirrored.rows).toEqual([{
        state: "current", active_feedback_index: "7",
        active_uid: Buffer.from(uid1.slice(2), "hex"), transaction_count: 0,
      }]);
      await pool.query(
        "UPDATE standard_reputation_mirrors SET desired_revision=2,active_feedback_index=8,active_uid=$1",
        [Buffer.from(uid2.slice(2), "hex")],
      );
      await finalizeReputationMirrorTransaction(mirrorArgs);
      const afterOldMirrorReplay = await pool.query(
        "SELECT desired_revision,active_feedback_index,active_uid FROM standard_reputation_mirrors",
      );
      expect(afterOldMirrorReplay.rows[0]).toEqual({
        desired_revision: "2", active_feedback_index: "8",
        active_uid: Buffer.from(uid2.slice(2), "hex"),
      });

      await expect(finalizeReputationMirrorTransaction({
        ...mirrorArgs,
        receipt: receipt([feedbackLog(uid1, 7n), feedbackLog(uid1, 8n)], 20n),
      })).rejects.toThrow("MIRROR_FEEDBACK_EVENT_MISSING_OR_AMBIGUOUS");
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
    CREATE TABLE standard_reputation_mirrors (
      order_id TEXT PRIMARY KEY,desired_revision BIGINT,desired_confirmation TEXT,desired_uid BYTEA,
      active_feedback_index BIGINT,active_uid BYTEA,state TEXT,attempts INTEGER DEFAULT 0,
      transaction_count INTEGER DEFAULT 0,next_attempt_at TIMESTAMPTZ,updated_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE standard_reputation_mirror_transactions (
      transaction_id TEXT PRIMARY KEY,state TEXT,block_number BIGINT,updated_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE standard_confirmation_sponsorships (
      operation_id TEXT PRIMARY KEY,state TEXT,updated_at TIMESTAMPTZ DEFAULT now());
    INSERT INTO standard_reputation_mirrors
      (order_id,desired_revision,state) VALUES ('order-1',0,'pending');
  `);
}

async function seedOperation(pool: ReturnType<typeof createPool>, operationId: string, transactionId: string) {
  await pool.query("INSERT INTO standard_reputation_operations(operation_id,state) VALUES ($1,'broadcast')", [operationId]);
  await pool.query("INSERT INTO standard_reputation_transactions(transaction_id,state) VALUES ($1,'broadcast')", [transactionId]);
  await pool.query("INSERT INTO standard_confirmation_sponsorships(operation_id,state) VALUES ($1,'reserved')", [operationId]);
}

async function seedMirrorTransaction(pool: ReturnType<typeof createPool>, transactionId: string) {
  await pool.query(
    "INSERT INTO standard_reputation_mirror_transactions(transaction_id,state) VALUES ($1,'broadcast')",
    [transactionId],
  );
}
