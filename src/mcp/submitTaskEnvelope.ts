import { buildEnvelopeAuth } from "../auth/envelope.js";
import type { ChainReader } from "../chain/reader.js";
import type { Config } from "../config.js";
import type { Hex } from "../types.js";
import { publicErrorMessage } from "../util/errorWrap.js";
import type { SubmitTaskArgs } from "./submitTaskTypes.js";
import {
  mcpError,
  mcpJson,
  type McpToolResult,
} from "./util.js";

interface EnvelopeDeps {
  config: Config;
  reader: ChainReader;
}

/**
 * Returns signing material for the first authenticated submit call.
 * A null result means the caller already supplied an envelope.
 */
export async function prepareSubmitTaskEnvelope(
  args: SubmitTaskArgs,
  requiresEnvelopeAuth: boolean,
  deps: EnvelopeDeps,
): Promise<McpToolResult | null> {
  if (!requiresEnvelopeAuth || args.envelopeAuth) return null;

  let buyerTokenId = args.buyerTokenId;
  if (!buyerTokenId && args.walletAddress) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(args.walletAddress)) {
      return mcpError({
        code: "BAD_INPUT",
        message: "walletAddress must be a 0x-prefixed 20-byte hex address.",
      });
    }
    try {
      const agentId = await deps.reader.agentOfWallet(
        args.walletAddress.toLowerCase() as Hex,
      );
      if (agentId === 0n) {
        return mcpError({
          code: "WALLET_NOT_REGISTERED",
          message:
            `Wallet ${args.walletAddress} has no ERC-8004 agentId on chain ` +
            `${args.chainId}. Register it via daski_register_agent or let ` +
            "daski_buy_service register it atomically.",
          recoverable: true,
          next_action:
            "Call daski_register_agent, or run a daski_buy_service flow first.",
        });
      }
      buyerTokenId = agentId.toString();
    } catch (error) {
      return mcpError({
        code: "CHAIN_READ_FAILED",
        message: publicErrorMessage(
          "mcp.submitTask.agentOfWallet",
          error,
          "buyer identity lookup failed",
        ),
        recoverable: true,
        next_action:
          "Retry, or pass buyerTokenId directly if you already know it.",
      });
    }
  }
  if (!buyerTokenId) {
    return mcpError({
      code: "BAD_INPUT",
      message:
        "buyerTokenId not provided. Pass the buyerTokenId returned by " +
        "daski_buy_service, or pass walletAddress for an on-chain lookup.",
      recoverable: true,
      next_action:
        "Re-call this tool with either buyerTokenId or walletAddress set.",
    });
  }

  const envelope = buildEnvelopeAuth({
    skillId: args.skillId,
    paymentId: args.paymentId,
    chainId: args.chainId,
    buyerTokenId,
    identityRegistryAddress: deps.config.identityRegistryAddress,
    serviceArgs: args.serviceArgs ?? {},
    messageId: args.messageId,
  });
  return mcpJson({
    messageId: envelope.messageId,
    requestHash: envelope.requestHash,
    issuedAt: envelope.issuedAt,
    authorization: envelope.authorization,
    eip712TypedData: envelope.eip712TypedData,
    hint:
      "Sign eip712TypedData with the buyer agent wallet, then make the " +
      "second call with the exact first-call arguments plus envelopeAuth " +
      "and the same messageId.",
  });
}
