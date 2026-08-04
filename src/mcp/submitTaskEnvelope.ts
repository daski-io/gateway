import {
  buildEnvelopeAuth,
  computeRequestHash,
} from "../auth/envelope.js";
import { verifyEnvelopeAuth } from "../auth/envelopeVerification.js";
import type { ChainReader } from "../chain/reader.js";
import type { Config } from "../config.js";
import type { Hex, StoredChallenge } from "../types.js";
import { publicErrorMessage } from "../util/errorWrap.js";
import { isHexAddress } from "../util/evmValidation.js";
import type { RoutedSubmitTaskArgs } from "./submitTaskTypes.js";
import {
  mcpError,
  mcpJson,
  type McpToolResult,
} from "./util.js";

interface EnvelopeDeps {
  config: Config;
  reader: ChainReader;
  providerAgentId: bigint;
}

export function rejectUnsignedAuthenticatedPrompt(
  args: RoutedSubmitTaskArgs,
  requiresEnvelopeAuth: boolean,
): McpToolResult | null {
  if ((!requiresEnvelopeAuth && !args.envelopeAuth) || args.prompt === undefined) {
    return null;
  }
  return mcpError({
    code: "UNSIGNED_PROMPT_NOT_ALLOWED",
    message:
      "Authenticated tasks must put all variable task input in serviceArgs. " +
      "prompt is not covered by the signed request hash, so no task was dispatched.",
    recoverable: true,
    next_action:
      "Move the requested work into the provider's documented serviceArgs fields and start a fresh envelope challenge.",
  });
}

/**
 * Returns signing material for the first authenticated submit call.
 * A null result means the caller already supplied an envelope.
 */
export async function prepareSubmitTaskEnvelope(
  args: RoutedSubmitTaskArgs,
  requiresEnvelopeAuth: boolean,
  deps: EnvelopeDeps,
): Promise<McpToolResult | null> {
  if (!requiresEnvelopeAuth || args.envelopeAuth) return null;

  let buyerTokenId = args.buyerTokenId;
  if (!buyerTokenId && args.walletAddress) {
    if (!isHexAddress(args.walletAddress)) {
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
    providerAgentId: deps.providerAgentId,
    serviceArgs: args.serviceArgs ?? {},
    messageId: args.messageId,
  });
  return mcpJson({
    status: "action-required",
    action: "sign_envelope",
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

export async function verifySubmitTaskEnvelope(
  args: RoutedSubmitTaskArgs,
  paidChallenge: StoredChallenge | null,
  deps: EnvelopeDeps,
): Promise<McpToolResult | null> {
  if (!args.envelopeAuth) return null;
  if (!args.messageId) {
    return mcpError({
      code: "MESSAGE_ID_REQUIRED",
      message:
        "messageId must accompany envelopeAuth and match the signed authorization.",
    });
  }

  let buyerTokenId: bigint;
  try {
    buyerTokenId = paidChallenge
      ? paidChallenge.buyerTokenId
      : BigInt(args.envelopeAuth.authorization.buyerTokenId);
  } catch {
    return mcpError({
      code: "ENVELOPE_AUTH_INVALID",
      message: "The signed envelope buyerTokenId is invalid.",
    });
  }
  const requestHash = computeSubmitRequestHash(args);
  if (!requestHash) {
    return mcpError({
      code: "BAD_INPUT",
      message: "serviceArgs cannot be canonically hashed.",
    });
  }
  const verified = await verifyEnvelopeAuth(
    deps.config,
    deps.reader,
    args.envelopeAuth,
    {
      buyerTokenId,
      skillId: args.skillId,
      paymentId: args.paymentId,
      chainId: args.chainId,
      messageId: args.messageId,
      requestHash,
      providerAgentId: deps.providerAgentId,
    },
  );
  if (!verified.ok) {
    return mcpError({
      code: "ENVELOPE_AUTH_INVALID",
      message:
        "The envelope signature or its payment, buyer, chain, skill, message, " +
        "or request binding is invalid. No task was dispatched.",
    });
  }
  if (
    args.buyerTokenId !== undefined &&
    args.buyerTokenId !== buyerTokenId.toString()
  ) {
    return mcpError({
      code: "ENVELOPE_AUTH_INVALID",
      message:
        "buyerTokenId conflicts with the verified envelope. No task was dispatched.",
    });
  }
  return null;
}

function computeSubmitRequestHash(args: RoutedSubmitTaskArgs): Hex | null {
  try {
    return computeRequestHash(args.serviceArgs ?? {});
  } catch {
    return null;
  }
}
