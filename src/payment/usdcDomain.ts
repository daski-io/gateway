import {
  encodeAbiParameters,
  keccak256,
  toBytes,
  type Address,
} from "viem";
import type { ChainId, Hex } from "../types.js";

const EIP712_DOMAIN_TYPEHASH = keccak256(
  toBytes(
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
  ),
);

export interface UsdcDomainConfig {
  address: Hex;
  decimals: 6;
  name: string;
  version: string;
  domainSeparator: Hex;
}

export const REVIEWED_USDC_DOMAINS: Record<ChainId, UsdcDomainConfig> = {
  8453: {
    address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    decimals: 6,
    name: "USD Coin",
    version: "2",
    domainSeparator:
      "0x02fa7265e7c5d81118673727957699e4d68f74cd74b7db77da710fe8a2c7834f",
  },
  84532: {
    address: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    decimals: 6,
    name: "USDC",
    version: "2",
    domainSeparator:
      "0x71f17a3b2ff373b803d70a5a07c046c1a2bc8e89c09ef722fcb047abe94c9818",
  },
};

export function computeUsdcDomainSeparator(
  chainId: number,
  address: Address,
  name: string,
  version: string,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
      ],
      [
        EIP712_DOMAIN_TYPEHASH,
        keccak256(toBytes(name)),
        keccak256(toBytes(version)),
        BigInt(chainId),
        address,
      ],
    ),
  );
}

interface LoadUsdcDomainInput {
  chainId: ChainId;
  address: Hex;
  env: NodeJS.ProcessEnv;
}

export function loadUsdcDomain(input: LoadUsdcDomainInput): UsdcDomainConfig {
  const reviewed = REVIEWED_USDC_DOMAINS[input.chainId];
  const name = input.env.USDC_NAME?.trim() || reviewed.name;
  const version = input.env.USDC_VERSION?.trim() || reviewed.version;
  const decimals = parseDecimals(input.env.USDC_DECIMALS ?? String(reviewed.decimals));
  const domainSeparator = requireHex32(
    "USDC_DOMAIN_SEPARATOR",
    input.env.USDC_DOMAIN_SEPARATOR ?? reviewed.domainSeparator,
  );
  const configured: UsdcDomainConfig = {
    address: input.address,
    decimals,
    name,
    version,
    domainSeparator,
  };
  for (const field of [
    "address",
    "decimals",
    "name",
    "version",
    "domainSeparator",
  ] as const) {
    if (configured[field] !== reviewed[field]) {
      throw new Error(
        `${fieldForError(field)} does not match the reviewed ${networkName(input.chainId)} value`,
      );
    }
  }
  const computed = computeUsdcDomainSeparator(
    input.chainId,
    configured.address,
    configured.name,
    configured.version,
  );
  if (configured.domainSeparator !== computed) {
    throw new Error(
      "USDC_DOMAIN_SEPARATOR does not match the configured EIP-712 domain",
    );
  }
  return configured;
}

function parseDecimals(raw: string): 6 {
  if (raw !== "6") {
    throw new Error("USDC_DECIMALS must be exactly 6");
  }
  return 6;
}

function requireValue(name: string, raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) throw new Error(`${name} env var is required in live chain mode`);
  return value;
}

function requireHex32(name: string, raw: string | undefined): Hex {
  const value = requireValue(name, raw).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${name} must be a 32-byte hex value`);
  }
  return value as Hex;
}

function networkName(chainId: ChainId): string {
  return chainId === 8453 ? "Base mainnet" : "Base Sepolia";
}

function fieldForError(field: keyof UsdcDomainConfig): string {
  return {
    address: "USDC_ADDRESS",
    decimals: "USDC_DECIMALS",
    name: "USDC_NAME",
    version: "USDC_VERSION",
    domainSeparator: "USDC_DOMAIN_SEPARATOR",
  }[field];
}
