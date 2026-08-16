export function hasFinalizedNonceConflict(
  finalizedNonces: readonly bigint[],
  transactionNonce: bigint,
): boolean {
  return finalizedNonces.length >= 1 &&
    finalizedNonces.every((nonce) => nonce > transactionNonce);
}
