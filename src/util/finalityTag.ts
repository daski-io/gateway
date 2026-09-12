/**
 * The block tag the gateway treats as final. Testnet deploys observe `safe`
 * (the batch is posted to L1; only an L1 reorg can move it) and Base mainnet
 * observes `finalized` (owner decision 2026-08-28, extended on 2026-09-12 to
 * confirmation state, order-history reputation reads, and relayer nonce
 * recovery). CHAIN_FINALITY_TAG overrides the default in either direction.
 */
export type FinalityTag = "safe" | "finalized";

export function resolveFinalityTag(raw: string | undefined, chainId: number): FinalityTag {
  if (raw === undefined) return chainId === 8453 ? "finalized" : "safe";
  if (raw === "safe" || raw === "finalized") return raw;
  throw new Error("CHAIN_FINALITY_TAG must be 'safe' or 'finalized'");
}
