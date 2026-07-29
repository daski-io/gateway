export function eligibleChainEvent(alias = ""): string {
  return `${alias}reputation_eligible IS TRUE`;
}
