export class FacilitatorTransactionFeeError extends Error {
  readonly code = "facilitator_transaction_fee_exceeded";

  constructor(message: string) {
    super(message);
    this.name = "FacilitatorTransactionFeeError";
  }
}

interface PreparedFeeFields {
  gas?: unknown;
  gasPrice?: unknown;
  maxFeePerGas?: unknown;
  maxPriorityFeePerGas?: unknown;
  value?: unknown;
}

/**
 * Rejects RPC-prepared transactions whose maximum native-token spend is
 * missing, malformed, or above the operator's explicit signing ceiling.
 */
export function assertFacilitatorTransactionFee(
  request: PreparedFeeFields,
  maximumTransactionFeeWei: bigint,
): void {
  const gas = optionalBigint(request.gas);
  const maxFeePerGas = optionalBigint(request.maxFeePerGas);
  const gasPrice = optionalBigint(request.gasPrice);
  const feePerGas = maxFeePerGas ?? gasPrice;
  const priorityFee = optionalBigint(request.maxPriorityFeePerGas);
  const transactionValue = optionalBigint(request.value);
  const value = transactionValue ?? 0n;
  if (
    gas === null ||
    gas === undefined ||
    gas <= 0n ||
    maxFeePerGas === null ||
    gasPrice === null ||
    feePerGas === null ||
    feePerGas === undefined ||
    feePerGas <= 0n ||
    priorityFee === null ||
    transactionValue === null ||
    value < 0n
  ) {
    throw new FacilitatorTransactionFeeError(
      "RPC prepared a transaction without a complete positive fee bound",
    );
  }
  if (
    priorityFee !== undefined &&
    (priorityFee < 0n || priorityFee > feePerGas)
  ) {
    throw new FacilitatorTransactionFeeError(
      "RPC prepared a priority fee above the total fee per gas",
    );
  }
  const maximumCost = gas * feePerGas + value;
  if (maximumCost > maximumTransactionFeeWei) {
    throw new FacilitatorTransactionFeeError(
      "RPC prepared a transaction above the configured maximum fee",
    );
  }
}

function optionalBigint(value: unknown): bigint | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === "bigint" ? value : null;
}
