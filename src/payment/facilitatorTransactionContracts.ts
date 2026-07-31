import type { PoolClient } from "pg";
import type {
  PreparedFacilitatorTransaction,
} from "../chain/reader.js";
import type {
  FacilitatorOperationOwner,
  FacilitatorTransactionRow,
} from "../db/facilitatorTransactionTypes.js";
import type { Hex } from "../types.js";

export class FacilitatorIntentConflictError extends Error {
  constructor() {
    super("the operation already exists with a different intent");
    this.name = "FacilitatorIntentConflictError";
  }
}

export class FacilitatorTransactionTerminalError extends Error {
  constructor(
    readonly status: "reverted" | "nonce_conflict",
    readonly transactionHash: Hex,
  ) {
    super(`facilitator transaction is terminal: ${status}`);
    this.name = "FacilitatorTransactionTerminalError";
  }
}

export interface FacilitatorExecutionOptions<TResult> {
  owner: FacilitatorOperationOwner;
  intentHash: Hex;
  operationData: Record<string, unknown>;
  prepare(nonce: bigint): Promise<PreparedFacilitatorTransaction>;
  send(
    prepared: PreparedFacilitatorTransaction,
    onBroadcast: (hash: Hex) => Promise<void>,
  ): Promise<TResult>;
  inspect(transactionHash: Hex): Promise<TResult | null>;
  loadCompleted?(): Promise<TResult | null>;
  persistPrepared(
    client: PoolClient,
    transactionId: string,
    transactionHash: Hex,
  ): Promise<void>;
  persistBroadcast?(
    client: PoolClient,
    transactionId: string,
    transactionHash: Hex,
  ): Promise<void>;
  finalizeSuccess(
    client: PoolClient,
    transactionId: string,
    result: TResult,
  ): Promise<void>;
  finalizeReverted?(
    client: PoolClient,
    transactionId: string,
    failureCode: string,
    error?: unknown,
  ): Promise<void>;
  isReverted?(error: unknown): boolean;
  failureCode?(error: unknown): string;
  projectionFailureCode?(error: unknown): string | null;
  allowNewAttemptAfterRevert?: boolean;
}

export function preparedTransactionFromRow(
  row: FacilitatorTransactionRow,
): PreparedFacilitatorTransaction {
  if (!row.preparedTransaction) {
    throw new Error("active facilitator transaction is missing signed bytes");
  }
  return {
    serializedTransaction: row.preparedTransaction,
    transactionHash: row.transactionHash,
    facilitatorNonce: row.transactionNonce,
  };
}
