/**
 * The block tag the gateway treats as final. Testnet deploys observe `safe`
 * (the batch is posted to L1; only an L1 reorg can move it). Base mainnet
 * defaults to `finalized` (owner decision 2026-08-28, extended on 2026-09-12
 * to confirmation state, order-history reputation reads, and relayer nonce
 * recovery); since the owner decision of 2026-10-24 production sets
 * CHAIN_FINALITY_TAG=safe. CHAIN_FINALITY_TAG overrides the default in either
 * direction.
 *
 * `latest` reads the newest blocks with no reorg protection. It exists only
 * for the testnet rehearsal (owner decision T8 of 2026-10-24, which keeps
 * production on `safe`), and Base mainnet refuses it at boot.
 */
export type FinalityTag = "safe" | "finalized" | "latest";

const BASE_MAINNET = 8453;

export function resolveFinalityTag(raw: string | undefined, chainId: number): FinalityTag {
  if (raw === undefined) return chainId === BASE_MAINNET ? "finalized" : "safe";
  if (raw === "safe" || raw === "finalized") return raw;
  if (raw === "latest") {
    if (chainId === BASE_MAINNET) {
      throw new Error("CHAIN_FINALITY_TAG=latest is refused on Base mainnet; use 'safe' or 'finalized'");
    }
    return raw;
  }
  throw new Error("CHAIN_FINALITY_TAG must be 'safe' or 'finalized' ('latest' is accepted only off Base mainnet)");
}
