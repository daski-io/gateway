import type {
  DaskiX402Declaration,
  Hex,
  PaymentRequired,
  SettlementResponse,
  StoredChallenge,
} from "../types.js";

export interface ChallengeRow {
  service_ref: Buffer;
  provider_token_id: string;
  buyer_token_id: string;
  amount: string;
  skill_id: string | null;
  service_slug: string | null;
  service_version: string | null;
  service_id: Buffer | null;
  provider_a2a_url: string;
  wallet_address: string;
  created_at: Date;
  expires_at: Date;
  settlement_state:
    | "pending"
    | "settlement_prepared"
    | "settlement_broadcast"
    | "paid"
    | "expired"
    | "sanctions_rejected";
  payment_id: string | null;
  transaction_hash: string | null;
  prepared_transaction: Buffer | null;
  prepared_transaction_nonce: string | null;
  prepared_at: Date | null;
  verified_at: Date | null;
  confirmation_attestation_uid: Buffer | null;
  quote_id: string | null;
  quote_signature: string | null;
  quote_expires_at: Date | null;
  quote_request_hash: Buffer | null;
  service_args: Record<string, unknown> | null;
  x402_version: number | null;
  payment_required: PaymentRequired | null;
  requirements_hash: Buffer | null;
  resource_url: string | null;
  daski_extension: DaskiX402Declaration | null;
  request_fingerprint: Buffer | null;
  registration_delegation: StoredChallenge["registrationDelegation"];
  accepted_payer: string | null;
  eip3009_nonce: Buffer | null;
  payment_payload_fingerprint: Buffer | null;
  settle_response: SettlementResponse | null;
}

export function hexToBytea(hex: Hex): Buffer {
  return Buffer.from(hex.slice(2), "hex");
}

export function normalizeHex(hex: string): string {
  return hex.toLowerCase();
}

function byteaToHex(buf: Buffer): Hex {
  return `0x${buf.toString("hex")}` as Hex;
}

function requiredColumn<T>(value: T | null, column: string): T {
  if (value === null) {
    throw new Error(`payment challenge is missing required column ${column}`);
  }
  return value;
}

export function rowToChallenge(row: ChallengeRow): StoredChallenge {
  return {
    serviceRef: byteaToHex(row.service_ref),
    providerTokenId: BigInt(row.provider_token_id),
    buyerTokenId: BigInt(row.buyer_token_id),
    amount: BigInt(row.amount),
    skillId: row.skill_id ?? null,
    serviceSlug: requiredColumn(row.service_slug, "service_slug"),
    serviceVersion: requiredColumn(row.service_version, "service_version"),
    serviceId: byteaToHex(requiredColumn(row.service_id, "service_id")),
    providerA2AUrl: row.provider_a2a_url,
    walletAddress: requiredColumn(row.wallet_address, "wallet_address") as Hex,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    settlementState: row.settlement_state,
    paymentId: row.payment_id != null ? BigInt(row.payment_id) : null,
    transactionHash:
      row.transaction_hash != null ? (row.transaction_hash as Hex) : null,
    preparedTransaction: row.prepared_transaction
      ? byteaToHex(row.prepared_transaction)
      : null,
    preparedTransactionNonce:
      row.prepared_transaction_nonce != null
        ? BigInt(row.prepared_transaction_nonce)
        : null,
    preparedAt: row.prepared_at,
    verifiedAt: row.verified_at,
    confirmationAttestationUid: row.confirmation_attestation_uid
      ? byteaToHex(row.confirmation_attestation_uid)
      : null,
    quoteId: row.quote_id ?? null,
    quoteSignature:
      row.quote_signature != null ? (row.quote_signature as Hex) : null,
    quoteExpiresAt: row.quote_expires_at ?? null,
    quoteRequestHash: row.quote_request_hash
      ? byteaToHex(row.quote_request_hash)
      : null,
    serviceArgs: row.service_args ?? null,
    x402Version: row.x402_version ?? null,
    paymentRequired: row.payment_required ?? null,
    requirementsHash: row.requirements_hash
      ? byteaToHex(row.requirements_hash)
      : null,
    resourceUrl: row.resource_url ?? null,
    daskiExtension: row.daski_extension ?? null,
    requestFingerprint: row.request_fingerprint
      ? byteaToHex(row.request_fingerprint)
      : null,
    registrationDelegation: row.registration_delegation ?? null,
    acceptedPayer:
      row.accepted_payer != null
        ? (row.accepted_payer.toLowerCase() as Hex)
        : null,
    eip3009Nonce: row.eip3009_nonce ? byteaToHex(row.eip3009_nonce) : null,
    paymentPayloadFingerprint: row.payment_payload_fingerprint
      ? byteaToHex(row.payment_payload_fingerprint)
      : null,
    settleResponse: row.settle_response ?? null,
  };
}
