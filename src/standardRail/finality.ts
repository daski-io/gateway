/** Returns whether a mined block has the requested inclusive confirmation count. */
export function hasRequiredConfirmations(
  headBlock: bigint,
  minedBlock: bigint,
  requiredConfirmations: number,
): boolean {
  if (!Number.isInteger(requiredConfirmations) || requiredConfirmations < 1) {
    throw new Error("Required confirmations must be a positive integer");
  }
  return headBlock >= minedBlock + BigInt(requiredConfirmations - 1);
}
