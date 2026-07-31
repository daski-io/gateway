import {
  encodeAbiParameters,
  keccak256,
  type Hex,
} from "viem";

export const DASKI_PROVIDER_DOMAIN_NAME = "Daski";
export const DASKI_PROVIDER_DOMAIN_VERSION = "1";

export interface DaskiProviderDomain {
  name: typeof DASKI_PROVIDER_DOMAIN_NAME;
  version: typeof DASKI_PROVIDER_DOMAIN_VERSION;
  chainId: number;
  verifyingContract: Hex;
  salt: Hex;
}

/** Derive the EIP-712 domain salt that isolates one provider agent's signatures. */
export function providerAgentIdDomainSalt(providerAgentId: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }],
      [providerAgentId],
    ),
  );
}

export function buildDaskiProviderDomain(args: {
  chainId: number;
  identityRegistryAddress: Hex;
  providerAgentId: bigint;
}): DaskiProviderDomain {
  return {
    name: DASKI_PROVIDER_DOMAIN_NAME,
    version: DASKI_PROVIDER_DOMAIN_VERSION,
    chainId: args.chainId,
    verifyingContract: args.identityRegistryAddress,
    salt: providerAgentIdDomainSalt(args.providerAgentId),
  };
}
