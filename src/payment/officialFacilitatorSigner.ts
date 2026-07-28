import { toFacilitatorEvmSigner } from "@x402/evm";
import {
  createPublicClient,
  createWalletClient,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import type { Config } from "../config.js";

export function createOfficialFacilitatorSigner(config: Config) {
  const chain = config.chainId === 8453 ? base : baseSepolia;
  const account = privateKeyToAccount(config.facilitatorPrivateKey);
  const transport = http(config.baseRpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account, chain, transport });
  return toFacilitatorEvmSigner({
    address: account.address,
    readContract: (args) => publicClient.readContract(args as never),
    verifyTypedData: (args) => publicClient.verifyTypedData(args as never),
    writeContract: (args) => walletClient.writeContract(args as never),
    sendTransaction: (args) => walletClient.sendTransaction(args as never),
    waitForTransactionReceipt: (args) =>
      publicClient.waitForTransactionReceipt(args),
    getCode: (args) => publicClient.getCode(args),
  });
}
