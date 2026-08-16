import type { Hex, Log } from "viem";
import { canonicalHash } from "./canonical.js";

/** Hashes mined receipt logs without non-JSON bigint or optional RPC fields. */
export function chainLogsHash(logs: readonly Log<bigint, number, false>[]): Hex {
  return canonicalHash(logs.map((log) => ({
    address: log.address,
    blockHash: log.blockHash,
    blockNumber: log.blockNumber.toString(),
    data: log.data,
    logIndex: log.logIndex,
    removed: log.removed,
    topics: log.topics,
    transactionHash: log.transactionHash,
    transactionIndex: log.transactionIndex,
  })));
}
