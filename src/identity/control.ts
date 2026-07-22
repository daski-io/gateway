import type { ChainReader } from "../chain/reader.js";
import type { Hex } from "../types.js";

const ZERO_ADDRESS = `0x${"00".repeat(20)}` as Hex;

export async function walletControlsAgent(
  reader: ChainReader,
  agentId: bigint,
  walletAddress: Hex,
): Promise<boolean> {
  if (agentId === 0n) return false;
  const wallet = walletAddress.toLowerCase();
  const [owner, agentWallet] = await Promise.all([
    reader.getAgentOwner(agentId).catch(() => ZERO_ADDRESS),
    reader.getAgentWallet(agentId).catch(() => ZERO_ADDRESS),
  ]);
  return (
    owner.toLowerCase() === wallet ||
    agentWallet.toLowerCase() === wallet
  );
}
