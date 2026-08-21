import type { Transport } from "viem";

export function orderedRpcTransport(transport: Transport): Transport {
  return (parameters) => {
    const target = transport(parameters);
    let tail: Promise<void> = Promise.resolve();
    const request = ((...args: Parameters<typeof target.request>) => {
      const result = tail.then(() => target.request(...args));
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    }) as typeof target.request;
    return { ...target, request };
  };
}
