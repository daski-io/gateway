import type { PaymentChainGateway } from "../chain/reader.js";

export class FacilitatorBalanceError extends Error {
  constructor(
    readonly code:
      | "facilitator_balance_unavailable"
      | "facilitator_balance_low",
  ) {
    super(
      code === "facilitator_balance_unavailable"
        ? "The facilitator wallet balance cannot be verified right now."
        : "The facilitator wallet cannot cover the transaction fee while preserving its configured reserve.",
    );
    this.name = "FacilitatorBalanceError";
  }
}

export async function requireFacilitatorBalance(
  reader: PaymentChainGateway,
  minimumWei: bigint,
  maximumTransactionFeeWei: bigint,
): Promise<void> {
  let balance: bigint;
  try {
    balance = await reader.getFacilitatorBalance();
  } catch {
    throw new FacilitatorBalanceError("facilitator_balance_unavailable");
  }
  if (balance < minimumWei + maximumTransactionFeeWei) {
    throw new FacilitatorBalanceError("facilitator_balance_low");
  }
}
