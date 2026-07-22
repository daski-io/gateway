import type { ChainReader } from "../chain/reader.js";
import type { Config } from "../config.js";
import type { Eip712TypedData, Hex } from "../types.js";
import { buildBuyerAgentURI, defaultBuyerName, sanitizeBuyerName } from "./name.js";
import { logErrorWithId } from "../util/errorWrap.js";
import { isHexAddress, isHexBytes } from "../util/evmValidation.js";
import { verifyTypedData } from "viem";
import { encodeFunctionData } from "viem";
import { agentIndexAbi } from "../chain/abis.js";
import {
  AgentCardFetchError,
  fetchAgentCard,
  type FetchAgentCardOptions,
} from "./fetch-agent-card.js";

export interface IdentityServiceDeps {
  config: Config;
  reader: ChainReader;
  fetchAgentCardFn?: FetchAgentCardOptions["fetchFn"];
}

export type IdentityServiceResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      status: number;
      error: { code: string; message: string; [key: string]: unknown };
    };

const REGISTER_AGENT_TYPES = {
  RegisterAgent: [
    { name: "agentURI", type: "string" },
    { name: "agentWallet", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

function fail(
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): IdentityServiceResult<never> {
  return { ok: false, status, error: { code, message, ...details } };
}

async function resolveIdentity(
  walletAddress: Hex,
  name: unknown,
  agentURI: unknown,
  deps: IdentityServiceDeps,
): Promise<
  IdentityServiceResult<{
    agentURI: string;
    resolvedName: string;
    hint?: string;
  }>
> {
  const hasName = name != null && name !== "";
  const hasAgentURI = agentURI != null && agentURI !== "";
  if (hasName && hasAgentURI) {
    return fail(400, "NAME_AGENT_URI_CONFLICT", "Pass either 'name' or 'agentURI', not both.");
  }
  if (hasAgentURI) {
    if (typeof agentURI !== "string") {
      return fail(400, "BAD_AGENT_URI", "agentURI must be a string");
    }
    try {
      const card = await fetchAgentCard(agentURI, {
        ipfsGatewayUrl: deps.config.ipfsGatewayUrl,
        fetchFn: deps.fetchAgentCardFn,
      });
      const sanitized = sanitizeBuyerName(card.name);
      if (!sanitized.ok) {
        return fail(400, "BAD_NAME", sanitized.error);
      }
      return {
        ok: true,
        value: { agentURI, resolvedName: sanitized.name },
      };
    } catch (err) {
      if (err instanceof AgentCardFetchError) {
        return fail(400, err.code, err.message);
      }
      throw err;
    }
  }
  if (hasName) {
    const sanitized = sanitizeBuyerName(name);
    if (!sanitized.ok) return fail(400, "BAD_NAME", sanitized.error);
    return {
      ok: true,
      value: {
        agentURI: buildBuyerAgentURI(walletAddress, sanitized.name),
        resolvedName: sanitized.name,
      },
    };
  }
  const resolvedName = defaultBuyerName(walletAddress);
  return {
    ok: true,
    value: {
      agentURI: buildBuyerAgentURI(walletAddress),
      resolvedName,
      hint:
        `No display name was provided, so this wallet will register as ` +
        `'${resolvedName}'. Pass a \`name\` before signing to choose the ` +
        `registration-time name shown on receipts and in the marketplace.`,
    },
  };
}

export async function prepareRegistration(
  deps: IdentityServiceDeps,
  input: {
    walletAddress: unknown;
    name?: unknown;
    agentURI?: unknown;
    deadlineSeconds?: unknown;
  },
  now = new Date(),
): Promise<IdentityServiceResult<Record<string, unknown>>> {
  if (!isHexAddress(input.walletAddress)) {
    return fail(400, "BAD_WALLET", "walletAddress must be a 20-byte hex string");
  }
  const walletAddress = input.walletAddress.toLowerCase() as Hex;
  const deadlineSeconds = input.deadlineSeconds == null ? 3600 : Number(input.deadlineSeconds);
  if (!Number.isSafeInteger(deadlineSeconds) || deadlineSeconds <= 0) {
    return fail(400, "BAD_DEADLINE", "deadlineSeconds must be a positive integer");
  }

  let existingAgentId: bigint;
  try {
    existingAgentId = await deps.reader.agentOfWallet(walletAddress);
  } catch (err) {
    return fail(502, "CHAIN_READ_FAILED", "chain read failed", {
      correlationId: logErrorWithId("prepareRegistration.agentOfWallet", err),
    });
  }
  if (existingAgentId !== 0n) {
    return fail(409, "ALREADY_REGISTERED", "wallet is already registered", {
      agentId: existingAgentId.toString(),
    });
  }

  const identity = await resolveIdentity(walletAddress, input.name, input.agentURI, deps);
  if (!identity.ok) return identity;

  let nonce: bigint;
  try {
    nonce = await deps.reader.getRegistrationNonce(walletAddress);
  } catch (err) {
    return fail(502, "CHAIN_READ_FAILED", "chain read failed", {
      correlationId: logErrorWithId("prepareRegistration.registrationNonce", err),
    });
  }

  const deadline = BigInt(Math.floor(now.getTime() / 1000)) + BigInt(deadlineSeconds);
  const typedData: Eip712TypedData = {
    domain: {
      name: "Daski AgentIndex",
      version: "1",
      chainId: deps.config.chainId,
      verifyingContract: deps.config.agentIndexAddress,
    },
    types: {
      RegisterAgent: REGISTER_AGENT_TYPES.RegisterAgent.map((field) => ({
        name: field.name,
        type: field.type,
      })),
    },
    primaryType: "RegisterAgent",
    message: {
      agentURI: identity.value.agentURI,
      agentWallet: walletAddress,
      nonce: nonce.toString(),
      deadline: deadline.toString(),
    },
  };
  return {
    ok: true,
    value: {
      walletAddress,
      ...identity.value,
      nonce: nonce.toString(),
      deadline: deadline.toString(),
      eip712TypedData: typedData,
      submitTemplate: {
        walletAddress,
        agentURI: identity.value.agentURI,
        deadline: deadline.toString(),
      },
    },
  };
}

export async function buildRegistrationTransaction(
  deps: IdentityServiceDeps,
  input: {
    walletAddress?: unknown;
    agentURI?: unknown;
    deadline?: unknown;
    signature?: unknown;
  },
): Promise<IdentityServiceResult<Record<string, unknown>>> {
  if (!isHexAddress(input.walletAddress)) {
    return fail(400, "BAD_WALLET", "walletAddress is required");
  }
  if (typeof input.agentURI !== "string") {
    return fail(400, "BAD_AGENT_URI", "agentURI must be a string");
  }
  if (typeof input.deadline !== "string" || !/^[1-9][0-9]*$/.test(input.deadline)) {
    return fail(400, "BAD_DEADLINE", "deadline must be a positive decimal string");
  }
  if (!isHexBytes(input.signature)) {
    return fail(400, "BAD_SIGNATURE", "signature must be a non-empty hex string");
  }

  const walletAddress = input.walletAddress.toLowerCase() as Hex;
  const deadline = BigInt(input.deadline);
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (deadline <= now) {
    return fail(400, "BAD_DEADLINE", "registration signature has expired");
  }
  let existingAgentId: bigint;
  try {
    existingAgentId = await deps.reader.agentOfWallet(walletAddress);
  } catch (err) {
    return fail(502, "CHAIN_READ_FAILED", "chain read failed", {
      correlationId: logErrorWithId(
        "buildRegistrationTransaction.agentOfWallet",
        err,
      ),
    });
  }
  if (existingAgentId !== 0n) {
    return fail(409, "ALREADY_REGISTERED", "wallet is already registered", {
      agentId: existingAgentId.toString(),
    });
  }

  let nonce: bigint;
  try {
    nonce = await deps.reader.getRegistrationNonce(walletAddress);
  } catch (err) {
    return fail(502, "CHAIN_READ_FAILED", "chain read failed", {
      correlationId: logErrorWithId(
        "buildRegistrationTransaction.registrationNonce",
        err,
      ),
    });
  }
  let validSignature = false;
  try {
    validSignature = await verifyTypedData({
      address: walletAddress,
      domain: {
        name: "Daski AgentIndex",
        version: "1",
        chainId: deps.config.chainId,
        verifyingContract: deps.config.agentIndexAddress,
      },
      types: REGISTER_AGENT_TYPES,
      primaryType: "RegisterAgent",
      message: {
        agentURI: input.agentURI,
        agentWallet: walletAddress,
        nonce,
        deadline,
      },
      signature: input.signature,
    });
  } catch {
    validSignature = false;
  }
  if (!validSignature) {
    return fail(
      400,
      "BAD_SIGNATURE",
      "signature does not authorize this registration payload",
    );
  }

  let resolvedName: string;
  try {
    const card = await fetchAgentCard(input.agentURI, {
      ipfsGatewayUrl: deps.config.ipfsGatewayUrl,
      fetchFn: deps.fetchAgentCardFn,
    });
    const sanitized = sanitizeBuyerName(card.name);
    if (!sanitized.ok) {
      return fail(400, "BAD_NAME", sanitized.error);
    }
    resolvedName = sanitized.name;
  } catch (err) {
    if (err instanceof AgentCardFetchError) {
      return fail(400, err.code, err.message);
    }
    return fail(502, "AGENT_URI_FETCH_FAILED", "agentURI validation failed", {
      correlationId: logErrorWithId(
        "buildRegistrationTransaction.resolveName",
        err,
      ),
    });
  }

  const data = encodeFunctionData({
    abi: agentIndexAbi,
    functionName: "registerWithSig",
    args: [input.agentURI, walletAddress, deadline, input.signature],
  });
  return {
    ok: true,
    value: {
      walletAddress,
      agentURI: input.agentURI,
      resolvedName,
      transaction: {
        chainId: deps.config.chainId,
        to: deps.config.agentIndexAddress,
        data,
        value: "0",
      },
      instructions:
        "Send this transaction from the registration wallet and pay its network gas.",
    },
  };
}
