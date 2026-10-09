// ReputationStorage records a provider's recovery of a Failed order from
// implementation 2.2.0. Whether a read can report recoveries is decided from
// the contract's own `version()`, read at the same block as the figures it
// qualifies. An older implementation, a malformed version, or a version that
// could not be read all mean the figure is unknown (null), never zero.
const RECOVERY_VERSION = [2, 2, 0] as const;
const SEMANTIC_VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

export function supportsOrderRecoveries(version: unknown): boolean {
  if (typeof version !== "string") return false;
  const match = SEMANTIC_VERSION.exec(version);
  if (!match) return false;
  for (const [index, minimum] of RECOVERY_VERSION.entries()) {
    const part = Number(match[index + 1]);
    if (part !== minimum) return part > minimum;
  }
  return true;
}
