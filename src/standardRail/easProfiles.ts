import { encodeAbiParameters, getAddress, keccak256, parseAbi, parseAbiParameters, toBytes, type Address, type Hex, type PublicClient } from "viem";

export const EAS_PROFILE_IDS = ["eas-native-1.0.1", "eas-native-1.2.0", "eas-native-1.4.1-beta.3"] as const;
export type EasProfileId = typeof EAS_PROFILE_IDS[number];
export const EAS_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
export const EAS_IDENTITY_ABI = parseAbi([
  "function version() view returns (string)",
  "function getDomainSeparator() view returns (bytes32)",
  "function getAttestTypeHash() view returns (bytes32)",
  "function getRevokeTypeHash() view returns (bytes32)",
  "function getNonce(address account) view returns (uint256)",
]);
const baseFields = [
  { name: "schema", type: "bytes32" }, { name: "recipient", type: "address" },
  { name: "expirationTime", type: "uint64" }, { name: "revocable", type: "bool" },
  { name: "refUID", type: "bytes32" }, { name: "data", type: "bytes" },
] as const;
const revokeFields = [{ name: "schema", type: "bytes32" }, { name: "uid", type: "bytes32" }] as const;
const nonceField = { name: "nonce", type: "uint256" } as const;
const valueField = { name: "value", type: "uint256" } as const;
const deadlineField = { name: "deadline", type: "uint64" } as const;
// From 1.4.1-beta.3 (signing domain 1.3.0) the signed struct names its signer.
const attesterField = { name: "attester", type: "address" } as const;
const revokerField = { name: "revoker", type: "address" } as const;

/**
 * Native EAS signing formats, each named after the EAS release that introduced it.
 * A deployment is qualified by what a payer signs: the EIP-712 domain version and the
 * Attest and Revoke type hashes, read from the chain. Base upgrades its EAS predeploy in
 * place; an upgrade that keeps a known format keeps working, and one that changes what is
 * signed fails closed. The implementation and its code hash are recorded as evidence only.
 */
export const EAS_PROFILES = {
  // First qualified on Base (8453), implementation 0xbEb5Fc57…, until Base's 2026-11-04 upgrade.
  "eas-native-1.0.1": {
    id: "eas-native-1.0.1", domainVersion: "1.0.1", signedDeadline: false,
    attestTypeHash: "0xdbfdf8dc2b135c26253e00d5b6cbe6f20457e003fd526d97cea183883570de61",
    revokeTypeHash: "0xa98d02348410c9c76735e0d0bb1396f4015ac2bb9615f9c2611d19d7a8a99650",
    attestTypes: { Attest: [...baseFields, nonceField] },
    revokeTypes: { Revoke: [...revokeFields, nonceField] },
  },
  // First qualified on Base Sepolia (84532) until its 2026-10-22 upgrade.
  "eas-native-1.2.0": {
    id: "eas-native-1.2.0", domainVersion: "1.2.0", signedDeadline: true,
    attestTypeHash: "0xf83bb2b0ede93a840239f7e701a54d9bc35f03701f51ae153d601c6947ff3d3f",
    revokeTypeHash: "0x2d4116d8c9824e4c316453e5c2843a1885580374159ce8768603c49085ef424c",
    attestTypes: { Attest: [...baseFields, valueField, nonceField, deadlineField] },
    revokeTypes: { Revoke: [...revokeFields, valueField, nonceField, deadlineField] },
  },
  // Signing domain 1.3.0: Base Sepolia since block 48858051 (2026-10-22), Base since block 53508490 (2026-11-04).
  "eas-native-1.4.1-beta.3": {
    id: "eas-native-1.4.1-beta.3", domainVersion: "1.3.0", signedDeadline: true,
    attestTypeHash: "0xfeb2925a02bae3dae48d424a0437a2b6ac939aa9230ddc55a1a76f065d988076",
    revokeTypeHash: "0xb5d556f07587ec0f08cf386545cc4362c702a001650c2058002615ee5c9d1e75",
    attestTypes: { Attest: [attesterField, ...baseFields, valueField, nonceField, deadlineField] },
    revokeTypes: { Revoke: [revokerField, ...revokeFields, valueField, nonceField, deadlineField] },
  },
} as const;
export type EasProfile = typeof EAS_PROFILES[EasProfileId];
export interface EasProfileObservation {
  profileId: EasProfileId; contractVersion: string; domainVersion: string;
  implementation: Address; implementationCodeHash: Hex; domainSeparator: Hex;
  chainId: number; easAddress: Address; blockNumber: string; blockHash: Hex; timestamp: string;
}
export class EasIncompatible extends Error {
  constructor() { super("The deployed EAS identity is not a supported signing profile"); }
}
export function easDomainSeparator(chainId: number, address: Address, version: string): Hex {
  return keccak256(encodeAbiParameters(parseAbiParameters("bytes32,bytes32,bytes32,uint256,address"), [
    keccak256(toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
    keccak256(toBytes("EAS")), keccak256(toBytes(version)), BigInt(chainId), address,
  ]));
}
export function easProfile(id: string): EasProfile {
  if (!EAS_PROFILE_IDS.includes(id as EasProfileId)) throw new EasIncompatible();
  return EAS_PROFILES[id as EasProfileId];
}
/** Chains whose EAS is the OP Stack predeploy, whose upgrades only the chain's governance can make. */
export const EAS_REVIEW_CHAINS: ReadonlySet<number> = new Set([8453, 84532]);
/** The signing format the chain's EAS presents; version() and bytecode never select one. */
export async function observeEasProfile(
  client: PublicClient, chainId: number, address: Address, blockTag: "latest" | "safe" | "finalized" = "latest",
): Promise<EasProfileObservation> {
  if (!EAS_REVIEW_CHAINS.has(chainId) || address.toLowerCase() !== "0x4200000000000000000000000000000000000021" ||
      await client.getChainId() !== chainId) throw new EasIncompatible();
  const block = await client.getBlock({ blockTag });
  const blockNumber = block.number;
  const slot = await client.getStorageAt({ address, slot: EAS_IMPLEMENTATION_SLOT, blockNumber });
  if (!slot || /^0x0+$/.test(slot)) throw new EasIncompatible();
  const implementation = getAddress(`0x${slot.slice(-40)}`);
  const [code, version, domain, attest, revoke] = await Promise.all([
    client.getCode({ address: implementation, blockNumber }),
    client.readContract({ address, abi: EAS_IDENTITY_ABI, functionName: "version", blockNumber }),
    client.readContract({ address, abi: EAS_IDENTITY_ABI, functionName: "getDomainSeparator", blockNumber }),
    client.readContract({ address, abi: EAS_IDENTITY_ABI, functionName: "getAttestTypeHash", blockNumber }),
    client.readContract({ address, abi: EAS_IDENTITY_ABI, functionName: "getRevokeTypeHash", blockNumber }),
  ]);
  if (!code || code === "0x") throw new EasIncompatible();
  const implementationCodeHash = keccak256(code);
  const profile = Object.values(EAS_PROFILES).find(p => p.attestTypeHash === attest?.toLowerCase() && p.revokeTypeHash === revoke?.toLowerCase() &&
    easDomainSeparator(chainId, address, p.domainVersion) === domain?.toLowerCase());
  if (!profile) throw new EasIncompatible();
  const canonical = await client.getBlock({ blockNumber });
  if (canonical.hash !== block.hash) throw new Error("EAS observation changed during read");
  return { profileId: profile.id, contractVersion: version, domainVersion: profile.domainVersion,
    implementation, implementationCodeHash, domainSeparator: domain, chainId, easAddress: getAddress(address),
    blockNumber: blockNumber.toString(), blockHash: block.hash, timestamp: block.timestamp.toString() };
}
export function signedDeadlineExpired(profileId: EasProfileId, deadline: string | null, timestamp: bigint): boolean {
  return easProfile(profileId).signedDeadline && deadline !== null && BigInt(deadline) !== 0n && BigInt(deadline) < timestamp;
}
