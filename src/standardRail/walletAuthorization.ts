import {
  encodeAbiParameters,
  getAddress,
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import type {
  WalletActionAuthorizationV1,
  WalletAuthorizationTransport,
} from "./types.js";
import { canonicalHash } from "./canonical.js";
import { standardRailError } from "./errors.js";

export const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;
export const utf8Hash = (value: string): Hex => keccak256(stringToHex(value));

export function deriveActionExecutionId(input: {
  walletAuthorizationHash: Hex;
  providerAgentId: bigint;
  serviceId: Hex;
  providerControlProfileHash: Hex;
  servicingAdmissionHash: Hex;
  actionCatalogHash: Hex;
  actionCatalogSchemaHash: Hex;
  actionCatalogEpoch: bigint;
  actionDefinitionHash: Hex;
  requestHash: Hex;
}): Hex {
  const typeHash = utf8Hash(
    "ActionExecutionV1(bytes32 walletAuthorizationHash,uint256 providerAgentId,bytes32 serviceId,bytes32 providerControlProfileHash,bytes32 servicingAdmissionHash,bytes32 actionCatalogHash,bytes32 actionCatalogSchemaHash,uint64 actionCatalogEpoch,bytes32 actionDefinitionHash,bytes32 requestHash)",
  );
  return keccak256(encodeAbiParameters([
    { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "bytes32" },
    { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
    { type: "uint64" }, { type: "bytes32" }, { type: "bytes32" },
  ], [
    typeHash, input.walletAuthorizationHash, input.providerAgentId, input.serviceId,
    input.providerControlProfileHash, input.servicingAdmissionHash, input.actionCatalogHash,
    input.actionCatalogSchemaHash, input.actionCatalogEpoch, input.actionDefinitionHash,
    input.requestHash,
  ]));
}

export const WALLET_ACTION_FIELDS = [
  "payer", "providerAgentId", "serviceId", "providerControlProfileHash",
  "servicingAdmissionHash", "actionCatalogHash", "actionCatalogSchemaHash",
  "actionDefinitionHash", "actionCatalogEpoch", "actionHash", "methodHash",
  "absoluteResourceUriHash", "requestHash", "audienceHash", "nonce", "issuedAt",
  "validBefore",
] as const;

export const WALLET_ACTION_TYPES = {
  WalletActionAuthorizationV1: [
    { name: "payer", type: "address" },
    { name: "providerAgentId", type: "uint256" },
    { name: "serviceId", type: "bytes32" },
    { name: "providerControlProfileHash", type: "bytes32" },
    { name: "servicingAdmissionHash", type: "bytes32" },
    { name: "actionCatalogHash", type: "bytes32" },
    { name: "actionCatalogSchemaHash", type: "bytes32" },
    { name: "actionDefinitionHash", type: "bytes32" },
    { name: "actionCatalogEpoch", type: "uint64" },
    { name: "actionHash", type: "bytes32" },
    { name: "methodHash", type: "bytes32" },
    { name: "absoluteResourceUriHash", type: "bytes32" },
    { name: "requestHash", type: "bytes32" },
    { name: "audienceHash", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "validBefore", type: "uint64" },
  ],
} as const;

function exact(value: object, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw standardRailError("WALLET_AUTHORIZATION_INVALID");
  }
}

function typedMessage(message: WalletActionAuthorizationV1) {
  return {
    ...message,
    providerAgentId: BigInt(message.providerAgentId),
    actionCatalogEpoch: BigInt(message.actionCatalogEpoch),
    issuedAt: BigInt(message.issuedAt),
    validBefore: BigInt(message.validBefore),
  };
}

export function walletActionSignRequest(
  message: WalletActionAuthorizationV1,
  chainId: number,
) {
  return {
    domain: { name: "DaskiStandardWallet", version: "1", chainId },
    types: WALLET_ACTION_TYPES,
    primaryType: "WalletActionAuthorizationV1" as const,
    message,
  };
}

export function walletAuthorizationHash(
  message: WalletActionAuthorizationV1,
  chainId: number,
): Hex {
  return hashTypedData({
    domain: { name: "DaskiStandardWallet", version: "1", chainId },
    primaryType: "WalletActionAuthorizationV1",
    types: WALLET_ACTION_TYPES,
    message: typedMessage(message),
  });
}

export async function verifyWalletAuthorization(args: {
  authorization: WalletAuthorizationTransport;
  expected: WalletActionAuthorizationV1;
  chainId: number;
  now?: number;
}): Promise<Hex> {
  exact(args.authorization, ["message", "signature"]);
  exact(args.authorization.message, WALLET_ACTION_FIELDS);
  const message = args.authorization.message;
  const now = args.now ?? Math.floor(Date.now() / 1_000);
  if (
    canonicalHash(message) !== canonicalHash(args.expected) ||
    getAddress(message.payer) !== getAddress(args.expected.payer as Address) ||
    !/^0x[0-9a-f]{130}$/.test(args.authorization.signature) ||
    message.issuedAt > now + 30 || message.validBefore <= now ||
    message.validBefore - message.issuedAt > 300 || message.issuedAt >= message.validBefore
  ) throw standardRailError("WALLET_AUTHORIZATION_INVALID");
  const recovered = await recoverTypedDataAddress({
    domain: { name: "DaskiStandardWallet", version: "1", chainId: args.chainId },
    primaryType: "WalletActionAuthorizationV1",
    types: WALLET_ACTION_TYPES,
    message: typedMessage(message),
    signature: args.authorization.signature,
  });
  if (getAddress(recovered) !== getAddress(message.payer)) {
    throw standardRailError("WALLET_AUTHORIZATION_INVALID");
  }
  return walletAuthorizationHash(message, args.chainId);
}
