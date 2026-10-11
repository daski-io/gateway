interface LogRange<T> {
  fromBlock: bigint;
  toBlock: bigint;
  maximumPageEvents: number;
  load(fromBlock: bigint, toBlock: bigint): Promise<readonly T[]>;
}

/** Blocks one log request covers before the range is split. */
export const LOG_BLOCK_WINDOW = 10_000n;

export async function loadLogsPaged<T>(args: LogRange<T>): Promise<T[]> {
  if (!Number.isSafeInteger(args.maximumPageEvents) || args.maximumPageEvents <= 0) {
    throw new Error("Maximum log page events must be a positive safe integer");
  }
  if (args.toBlock < args.fromBlock) return [];
  const logs: T[] = [];
  const blockWindow = LOG_BLOCK_WINDOW;

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

/**
 * The newest logs `matches` accepts at or below `toBlock`. Windows are read
 * from the top down and the first one holding a match ends the search, so an
 * event that recurs costs as many windows as it lies back, not the whole range
 * since `fromBlock`. Every match in that window is returned.
 */
export async function loadNewestLogs<T>(args: LogRange<T> & { matches(log: T): boolean }): Promise<T[]> {
  for (let toBlock = args.toBlock; toBlock >= args.fromBlock;) {
    const lowest = toBlock - LOG_BLOCK_WINDOW + 1n;
    const fromBlock = lowest > args.fromBlock ? lowest : args.fromBlock;
    const found = (await loadLogsPaged({ ...args, fromBlock, toBlock })).filter(log => args.matches(log));
    if (found.length) return found;
    toBlock = fromBlock - 1n;
  }
  return [];
}
