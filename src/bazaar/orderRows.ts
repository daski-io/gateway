import type { Hex } from "../types.js";
import type { BazaarOrder, BazaarOrderState } from "./types.js";

export interface RawBazaarOrder {
  order_record_id: Buffer;
  order_handle: string;
  authorization_digest: Buffer;
  chain_id: string;
  token: Buffer;
  payer: Buffer;
  nonce: Buffer;
  provider_agent_id: string;
  listing_epoch: Buffer;
  listing_commitment: Buffer;
  outcome_id: Buffer;
  resource: string;
  request_hash: Buffer;
  offer_hash: Buffer;
  gross_amount: string;
  pay_to: Buffer;
  authorization_valid_before: string;
  state: BazaarOrderState;
  settlement_transaction: Buffer | null;
  task_id: string | null;
  task_id_hash: Buffer | null;
  failure_code: string | null;
}

export const BAZAAR_ORDER_SELECT_COLUMNS = `
  order_record_id, order_handle, authorization_digest, chain_id, token, payer,
  nonce, provider_agent_id, listing_epoch, listing_commitment, outcome_id,
  resource, request_hash, offer_hash, gross_amount, pay_to,
  authorization_valid_before, state, settlement_transaction, task_id,
  task_id_hash, failure_code
`;

export function toBazaarOrder(row: RawBazaarOrder): BazaarOrder {
  const hex = (value: Buffer) => `0x${value.toString("hex")}` as Hex;
  return {
    orderRecordId: hex(row.order_record_id), orderHandle: row.order_handle,
    authorizationDigest: hex(row.authorization_digest), chainId: BigInt(row.chain_id),
    token: hex(row.token), payer: hex(row.payer), nonce: hex(row.nonce),
    providerAgentId: BigInt(row.provider_agent_id), listingEpoch: hex(row.listing_epoch),
    listingCommitment: hex(row.listing_commitment), outcomeId: hex(row.outcome_id),
    resource: row.resource, requestHash: hex(row.request_hash), offerHash: hex(row.offer_hash),
    grossAmount: BigInt(row.gross_amount), payTo: hex(row.pay_to),
    authorizationValidBefore: BigInt(row.authorization_valid_before), state: row.state,
    settlementTransaction: row.settlement_transaction ? hex(row.settlement_transaction) : null,
    taskId: row.task_id, taskIdHash: row.task_id_hash ? hex(row.task_id_hash) : null,
    failureCode: row.failure_code,
  };
}
