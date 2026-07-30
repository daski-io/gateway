import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { PaymentChainGateway } from "../chain/reader.js";
import type { Queries } from "../db/queries.js";
import type { FacilitatorTransactionRow } from "../db/facilitatorTransactionTypes.js";
import type { Hex } from "../types.js";
import {
  type FacilitatorExecutionOptions,
  FacilitatorIntentConflictError,
  FacilitatorTransactionTerminalError,
  preparedTransactionFromRow,
} from "./facilitatorTransactionContracts.js";

export {
  FacilitatorIntentConflictError,
  FacilitatorTransactionTerminalError,
} from "./facilitatorTransactionContracts.js";

export class FacilitatorTransactionCoordinator {
  constructor(
    private readonly reader: PaymentChainGateway,
    private readonly queries: Queries,
  ) {}

  async execute<TResult>(
    options: FacilitatorExecutionOptions<TResult>,
  ): Promise<TResult> {
    const prior = await this.queries.getFacilitatorTransaction(options.owner);
    const completed = await this.completedResult(prior, options);
    if (completed) return completed;

    let transaction: FacilitatorTransactionRow | null = null;
    try {
      const result = await this.queries.withFacilitatorTransactionLock(
        async (release, client) => {
          const current =
            await this.queries.getFacilitatorTransaction(options.owner);
          const finished = await this.completedResult(current, options);
          if (finished) {
            await release();
            return finished;
          }
          transaction = await this.resolveOrPrepare(
            current,
            options,
            client,
          );
          const prepared = preparedTransactionFromRow(transaction);
          if (transaction.status === "broadcast") {
            const recovered = await options.inspect(transaction.transactionHash);
            if (recovered) {
              await release();
              return recovered;
            }
          }
          if (transaction.status === "prepared") {
            const confirmedNonce =
              await this.reader.getFacilitatorTransactionCount();
            if (confirmedNonce > prepared.facilitatorNonce) {
              const recovered = await options.inspect(
                transaction.transactionHash,
              );
              if (recovered) {
                await release();
                return recovered;
              }
              await this.finishConflict(transaction, options, client);
              throw new FacilitatorTransactionTerminalError(
                "nonce_conflict",
                transaction.transactionHash,
              );
            }
          }
          const onBroadcast = async (hash: Hex): Promise<void> => {
            if (hash.toLowerCase() !== transaction!.transactionHash.toLowerCase()) {
              throw new Error("RPC returned an unexpected transaction hash");
            }
            await client.query("BEGIN");
            try {
              const recorded =
                await this.queries.markFacilitatorTransactionBroadcast(
                  transaction!.id,
                  hash,
                  client,
                );
              if (!recorded) throw new Error("broadcast persistence conflict");
              await options.persistBroadcast?.(client, transaction!.id, hash);
              await client.query("COMMIT");
            } catch (error) {
              await client.query("ROLLBACK");
              throw error;
            }
            await release();
          };
          const attempted =
            await this.queries.recordFacilitatorSubmissionAttempt(
              transaction.id,
              client,
            );
          if (!attempted) {
            throw new Error("facilitator submission attempt conflict");
          }
          return options.send(prepared, onBroadcast);
        },
        { owner: options.owner },
      );
      await this.finishSuccess(transaction!, result, options);
      return result;
    } catch (error) {
      if (transaction && options.isReverted?.(error)) {
        const code = options.failureCode?.(error) ?? "transaction_reverted";
        await this.finishReverted(transaction, code, options);
      }
      throw error;
    }
  }

  private async completedResult<TResult>(
    row: FacilitatorTransactionRow | null,
    options: FacilitatorExecutionOptions<TResult>,
  ): Promise<TResult | null> {
    if (!row) return null;
    if (row.intentHash.toLowerCase() !== options.intentHash.toLowerCase()) {
      throw new FacilitatorIntentConflictError();
    }
    if (row.status === "succeeded") {
      const stored = await options.loadCompleted?.();
      const inspected = stored ?? (await options.inspect(row.transactionHash));
      if (!inspected) throw new Error("completed transaction result is missing");
      return inspected;
    }
    if (row.status === "nonce_conflict") {
      throw new FacilitatorTransactionTerminalError(
        "nonce_conflict",
        row.transactionHash,
      );
    }
    if (row.status === "reverted" && !options.allowNewAttemptAfterRevert) {
      throw new FacilitatorTransactionTerminalError(
        "reverted",
        row.transactionHash,
      );
    }
    return null;
  }

  private async resolveOrPrepare<TResult>(
    current: FacilitatorTransactionRow | null,
    options: FacilitatorExecutionOptions<TResult>,
    client: PoolClient,
  ): Promise<FacilitatorTransactionRow> {
    if (
      current &&
      (current.status === "prepared" || current.status === "broadcast")
    ) {
      return current;
    }
    const pending = await this.reader.getFacilitatorPendingTransactionCount();
    const highest =
      await this.queries.highestUnresolvedFacilitatorNonce(client);
    const nonce =
      highest == null || pending > highest + 1n ? pending : highest + 1n;
    const prepared = await options.prepare(nonce);
    if (prepared.facilitatorNonce !== nonce) {
      throw new Error("facilitator adapter ignored the allocated nonce");
    }
    const id = randomUUID();
    await client.query("BEGIN");
    try {
      const row = await this.queries.insertFacilitatorTransaction(client, {
        id,
        owner: options.owner,
        intentHash: options.intentHash,
        preparedTransaction: prepared.serializedTransaction,
        transactionHash: prepared.transactionHash,
        transactionNonce: prepared.facilitatorNonce,
        operationData: options.operationData,
      });
      await options.persistPrepared(client, id, prepared.transactionHash);
      await client.query("COMMIT");
      return row;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }

  private async finishSuccess<TResult>(
    row: FacilitatorTransactionRow,
    result: TResult,
    options: FacilitatorExecutionOptions<TResult>,
    existingClient?: PoolClient,
  ): Promise<void> {
    await this.withTransaction(existingClient, async (client) => {
      await options.finalizeSuccess(client, row.id, result);
      const finished = await this.queries.finishFacilitatorTransaction(
        client,
        row.id,
        "succeeded",
      );
      if (!finished) throw new Error("transaction finalization conflict");
    });
  }

  private async finishReverted<TResult>(
    row: FacilitatorTransactionRow,
    code: string,
    options: FacilitatorExecutionOptions<TResult>,
  ): Promise<void> {
    await this.withTransaction(undefined, async (client) => {
      await options.finalizeReverted?.(client, row.id, code);
      await this.queries.finishFacilitatorTransaction(
        client,
        row.id,
        "reverted",
        code,
      );
    });
  }

  private async finishConflict<TResult>(
    row: FacilitatorTransactionRow,
    options: FacilitatorExecutionOptions<TResult>,
    client: PoolClient,
  ): Promise<void> {
    await client.query("BEGIN");
    try {
      await options.finalizeReverted?.(
        client,
        row.id,
        "prepared_transaction_nonce_conflict",
      );
      const finished = await this.queries.finishFacilitatorTransaction(
        client,
        row.id,
        "nonce_conflict",
        "prepared_transaction_nonce_conflict",
      );
      if (!finished) throw new Error("transaction finalization conflict");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }

  private async withTransaction(
    existing: PoolClient | undefined,
    action: (client: PoolClient) => Promise<void>,
  ): Promise<void> {
    if (existing) return action(existing);
    await this.queries.withDatabaseTransaction(action);
  }
}
