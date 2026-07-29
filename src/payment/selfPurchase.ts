import type { Hex } from "../types.js";

export function isSelfPurchase(input: {
  buyerAgentId: bigint;
  buyerWallet: Hex;
  providerAgentId: bigint;
  providerWallet: Hex;
}): boolean {
  return (
    input.buyerWallet.toLowerCase() === input.providerWallet.toLowerCase() ||
    (input.buyerAgentId !== 0n &&
      input.buyerAgentId === input.providerAgentId)
  );
}
