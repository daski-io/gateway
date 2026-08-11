const MIN_ADAPTER_TIMEOUT_MS = 100;
const MAX_ADAPTER_TIMEOUT_MS = 15_000;

export function validateBazaarAdapterCallTimeout(timeoutMs: number): void {
  if (
    !Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_ADAPTER_TIMEOUT_MS ||
    timeoutMs > MAX_ADAPTER_TIMEOUT_MS
  ) throw new Error("Bazaar adapter-call timeout is invalid");
}

export async function callBazaarAdapter<T>(input: {
  timeoutMs: number;
  signal?: AbortSignal;
  operation: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const timeoutSignal = AbortSignal.timeout(input.timeoutMs);
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeoutSignal])
    : timeoutSignal;
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("Bazaar adapter call aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return input.operation(signal);
      }),
      aborted,
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
