import type { CachedProvider } from "../types.js";

export function catalogChanged(
  oldProviders: CachedProvider[],
  newProviders: CachedProvider[],
): boolean {
  if (oldProviders.length !== newProviders.length) return true;
  for (let index = 0; index < oldProviders.length; index += 1) {
    const oldProvider = oldProviders[index];
    const newProvider = newProviders[index];
    if (
      oldProvider.agentId !== newProvider.agentId ||
      oldProvider.providerName !== newProvider.providerName ||
      oldProvider.providerDescription !== newProvider.providerDescription ||
      JSON.stringify(oldProvider.providerLegal) !==
        JSON.stringify(newProvider.providerLegal) ||
      JSON.stringify(oldProvider.cards) !== JSON.stringify(newProvider.cards)
    ) {
      return true;
    }
  }
  return false;
}
