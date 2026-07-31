import type { SettlementSponsorshipLimit } from "../db/settlementSponsorshipQueries.js";

export class SettlementAdmissionError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly message: string,
  ) {
    super(message);
    this.name = "SettlementAdmissionError";
  }
}

export function settlementSponsorshipError(
  limit: SettlementSponsorshipLimit,
): SettlementAdmissionError {
  if (limit === "wallet") {
    return new SettlementAdmissionError(
      "settlement_sponsorship_limited",
      429,
      "This wallet has reached its daily settlement sponsorship limit.",
    );
  }
  return new SettlementAdmissionError(
    "settlement_sponsorship_unavailable",
    503,
    "The daily settlement sponsorship capacity is exhausted.",
  );
}
