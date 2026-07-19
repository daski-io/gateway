import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
} from "viem";

export function decodeRevertReason(error: unknown): string {
  if (!(error instanceof BaseError)) {
    return error instanceof Error ? error.message : String(error);
  }
  const revert = error.walk(
    (cause) =>
      cause instanceof ContractFunctionRevertedError ||
      cause instanceof ContractFunctionZeroDataError,
  );
  if (revert instanceof ContractFunctionRevertedError) {
    if (revert.reason) return revert.reason;
    if (revert.data?.errorName) {
      const args = revert.data.args
        ? Array.from(revert.data.args).map(formatErrorArg).join(", ")
        : "";
      return args
        ? `${revert.data.errorName}(${args})`
        : `${revert.data.errorName}()`;
    }
    if (revert.signature) return `unknown error ${revert.signature}`;
    if (revert.raw && revert.raw !== "0x") {
      return `unknown error ${revert.raw.slice(0, 10)}`;
    }
    return (
      "execution reverted with no data (likely out-of-gas — the simulation " +
      "gas budget was too low for this call)"
    );
  }
  if (revert instanceof ContractFunctionZeroDataError) {
    return "execution reverted with no data (out-of-gas or bare revert)";
  }
  const short = error.shortMessage ?? error.message;
  const details = (error as { details?: unknown }).details;
  const cause = (error as { cause?: { message?: string } }).cause;
  const extras: string[] = [];
  if (typeof details === "string" && details && details !== short) {
    extras.push(details);
  }
  if (cause?.message && cause.message !== short && cause.message !== details) {
    extras.push(cause.message);
  }
  return extras.length > 0 ? `${short} (${extras.join("; ")})` : short;
}

function formatErrorArg(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return String(value);
  try {
    return JSON.stringify(value, (_key, nested) =>
      typeof nested === "bigint" ? nested.toString() : nested,
    );
  } catch {
    return String(value);
  }
}
