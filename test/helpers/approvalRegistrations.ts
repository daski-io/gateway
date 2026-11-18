import { randomUUID } from "node:crypto";
import { keccak256, stringToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Pool } from "../../src/db/pool.js";
import type { ProviderServiceCard } from "../../src/serviceRegistration/types.js";
import { canonicalHash } from "../../src/standardRail/canonical.js";
import { hostedCard, hostedCardUrl } from "./hostedProvider.js";
import { serviceIdOf, SERVICE } from "./railManifestExamples.js";

/// Registration rows for the provider approval tests, written straight into
/// standard_service_registrations: only the columns approvals read matter.
/// Every value is synthetic.

export const approvalWallet = (name: string): Hex =>
  privateKeyToAccount(keccak256(stringToHex(`provider approval test key: ${name}`))).address;

export interface SeededRegistration {
  registrationId: string;
  providerAgentId: string;
  owner: Hex;
  agentWallet: Hex;
  card: ProviderServiceCard;
}

export async function insertRegistration(pool: Pool, args: {
  providerAgentId: string;
  card?: ProviderServiceCard;
  state?: "ACTIVE" | "PREPARED" | "SUPERSEDED";
  activatedAt?: Date;
  owner?: Hex;
  agentWallet?: Hex;
}): Promise<SeededRegistration> {
  const card = args.card ?? hostedCard(args.providerAgentId);
  const owner = args.owner ?? approvalWallet(`owner of ${args.providerAgentId}`);
  const agentWallet = args.agentWallet ?? approvalWallet(`agent wallet of ${args.providerAgentId}`);
  const registrationId = randomUUID();
  const bytes = (value: string) => Buffer.from(value.slice(2), "hex");
  const filler = (label: string) => bytes(keccak256(stringToHex(`${registrationId}:${label}`)));
  await pool.query(
    `INSERT INTO standard_service_registrations
      (registration_id,provider_agent_id,service_id,service_slug,service_version,agent_card_url,service_wallet,
       provider_owner,provider_agent_wallet,provider_signer,idempotency_key,provider_payee,registration_nonce,
       request_hash,canonical_intent,prepared_json,card_json,card_hash,skill_contract_set_hash,state,
       marketplace_enabled,card_accepting_orders,chain_active,registration_healthy,activated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$8,$10,$7,$11,$12,'{}',$13,$14,$15,$16,$17,true,true,true,true,$18)`,
    [registrationId, args.providerAgentId, bytes(serviceIdOf(args.providerAgentId)), SERVICE.slug, SERVICE.version,
      hostedCardUrl(args.providerAgentId, new URL(card.standardRail.origin).origin),
      approvalWallet(`payee of ${args.providerAgentId}`).toLowerCase(), owner.toLowerCase(), agentWallet.toLowerCase(),
      `seed-${registrationId}`, filler("nonce"), filler("request"),
      { registrationId, listings: [] }, card, bytes(canonicalHash(card)), bytes(card.skillContractSetHash),
      args.state ?? "ACTIVE", args.activatedAt ?? new Date()],
  );
  return { registrationId, providerAgentId: args.providerAgentId, owner, agentWallet, card };
}
