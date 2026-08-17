interface LogRange<T> {
  fromBlock: bigint;
  toBlock: bigint;
  maximumPageEvents: number;
  load(fromBlock: bigint, toBlock: bigint): Promise<readonly T[]>;
}

export async function loadLogsPaged<T>(args: LogRange<T>): Promise<T[]> {
  if (!Number.isSafeInteger(args.maximumPageEvents) || args.maximumPageEvents <= 0) {
    throw new Error("Maximum log page events must be a positive safe integer");
  }
  if (args.toBlock < args.fromBlock) return [];
  const logs: T[] = [];
  const blockWindow = 10_000n;

  const loadRange = async (fromBlock: bigint, toBlock: bigint): Promise<void> => {
    let page: readonly T[];
    try {
      page = await args.load(fromBlock, toBlock);
    } catch (error) {
      if (fromBlock === toBlock) throw error;
      const midpoint = fromBlock + (toBlock - fromBlock) / 2n;
      await loadRange(fromBlock, midpoint);
      await loadRange(midpoint + 1n, toBlock);
      return;
    }
    if (page.length < args.maximumPageEvents || fromBlock === toBlock) {
      logs.push(...page);
      return;
    }
    const midpoint = fromBlock + (toBlock - fromBlock) / 2n;
    await loadRange(fromBlock, midpoint);
    await loadRange(midpoint + 1n, toBlock);
  };

  for (let fromBlock = args.fromBlock; fromBlock <= args.toBlock; fromBlock += blockWindow) {
    const end = fromBlock + blockWindow - 1n;
    await loadRange(fromBlock, end < args.toBlock ? end : args.toBlock);
  }
  return logs;
}
