import type { PaymentChainGateway } from "../chain/reader.js";
import type { Config } from "../config.js";
import type { Queries } from "../db/queries.js";
import { recoverPendingSettlement } from "./settlementRecovery.js";

export interface SettlementReconciliationResult {
  scanned: number;
  recovered: number;
}

export async function reconcileBroadcastSettlements(
  reader: PaymentChainGateway,
  queries: Queries,
  config: Config,
  limit = 100,
): Promise<SettlementReconciliationResult> {
  const challenges = await queries.listPendingSettlementChallenges(limit);
  let recovered = 0;
  for (const challenge of challenges) {
    if (!challenge.transactionHash) continue;
    const atomic = challenge.buyerTokenId === 0n;
    const payer = challenge.acceptedPayer ?? challenge.walletAddress;
    const result = await recoverPendingSettlement(
      challenge,
      config,
      reader,
      queries,
      payer,
      !atomic,
      atomic,
    );
    if (result.ok) recovered += 1;
  }
  return { scanned: challenges.length, recovered };
}
