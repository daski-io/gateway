import type {
  ScreeningDetectionSource,
  SettlementScreeningFailure,
} from "../chain/sanctionsErrors.js";
import { screeningFailureAddress } from "../chain/sanctionsErrors.js";
import type { Hex, StoredChallenge } from "../types.js";
import type { Pool } from "./pool.js";
import { hexToBytea, normalizeHex } from "./paymentChallengeCodec.js";

export type SettlementOperation = "settle" | "settle_with_registration";

export interface RecordedScreeningEvent {
  eventId: string;
  occurrenceCount: number;
}
interface ScreeningEventRow {
  event_id: string;
  occurrence_count: number;
}

interface StoredFailureRow {
  code: SettlementScreeningFailure["code"];
  selector: Buffer;
  decoded_address: string;
}

export function createSettlementScreeningQueries(pool: Pool) {
  return {
    async recordSettlementScreeningEvent(input: {
      challenge: StoredChallenge;
      failure: SettlementScreeningFailure;
      detectionSource: ScreeningDetectionSource;
      operation: SettlementOperation;
      chainId: number;
      paymentRouter: Hex;
      adapterAddress: Hex;
      transactionHash?: Hex | null;
    }): Promise<RecordedScreeningEvent> {
      const client = await pool.connect();
      const decoded = screeningFailureAddress(input.failure);
      const terminal = input.failure.code === "SANCTIONS_ADDRESS_REJECTED";
      try {
        await client.query("BEGIN");
        const result = await client.query<ScreeningEventRow>(
          `INSERT INTO settlement_screening_events
             (service_ref, provider_token_id, buyer_token_id, service_id,
              payer_wallet, chain_id, payment_router, adapter_address,
              operation, code, retryable, selector, argument_kind,
              decoded_address, detection_source, transaction_hash,
              retention_class)
           VALUES
             ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
              $14, $15, $16, $17)
           ON CONFLICT (
             service_ref, code, selector, decoded_address, detection_source,
             (COALESCE(transaction_hash, ''))
           ) DO UPDATE
             SET last_seen_at = now(),
                 occurrence_count = settlement_screening_events.occurrence_count + 1
           RETURNING event_id, occurrence_count`,
          [
            hexToBytea(input.challenge.serviceRef),
            input.challenge.providerTokenId.toString(),
            input.challenge.buyerTokenId.toString(),
            hexToBytea(input.challenge.serviceId),
            input.challenge.walletAddress.toLowerCase(),
            input.chainId,
            input.paymentRouter.toLowerCase(),
            input.adapterAddress.toLowerCase(),
            input.operation,
            input.failure.code,
            input.failure.retryable,
            hexToBytea(input.failure.selector),
            decoded.kind,
            decoded.address.toLowerCase(),
            input.detectionSource,
            input.transactionHash ? normalizeHex(input.transactionHash) : null,
            terminal ? "compliance_evidence" : "operational_telemetry",
          ],
        );
        const event = result.rows[0];
        if (!event) throw new Error("screening event insert returned no row");
        if (terminal) {
          const updated = await client.query(
            `UPDATE payment_challenges
                SET settlement_state = 'sanctions_rejected'
              WHERE service_ref = $1
                AND settlement_state <> 'paid'`,
            [hexToBytea(input.challenge.serviceRef)],
          );
          if ((updated.rowCount ?? 0) !== 1) {
            throw new Error("unable to persist terminal sanctions state");
          }
        }
        await client.query("COMMIT");
        return {
          eventId: event.event_id,
          occurrenceCount: event.occurrence_count,
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async getTerminalSettlementScreeningFailure(
      serviceRef: Hex,
    ): Promise<SettlementScreeningFailure | null> {
      const result = await pool.query<StoredFailureRow>(
        `SELECT code, selector, decoded_address
           FROM settlement_screening_events
          WHERE service_ref = $1
            AND code = 'SANCTIONS_ADDRESS_REJECTED'
          ORDER BY first_seen_at
          LIMIT 1`,
        [hexToBytea(serviceRef)],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        code: "SANCTIONS_ADDRESS_REJECTED",
        retryable: false,
        selector: `0x${row.selector.toString("hex")}` as Hex,
        account: row.decoded_address as Hex,
      };
    },
  };
}
