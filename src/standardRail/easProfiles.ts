import { encodeAbiParameters, getAddress, keccak256, parseAbi, parseAbiParameters, toBytes, type Address, type Hex, type PublicClient } from "viem";

export const EAS_PROFILE_IDS = ["eas-native-1.0.1", "eas-native-1.2.0"] as const;
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

export const EAS_PROFILES = {
  "eas-native-1.0.1": {
    id: "eas-native-1.0.1", chainId:8453, implementation:"0xbEb5Fc579115071764c7423A4f12eDde41f106Ed", contractVersion: "1.0.1", domainVersion: "1.0.1", signedDeadline: false,
    implementationCodeHash: "0x16b293cd7ed66fa1e03076e5847c59b146a83c187d991c42fe6056b3c1cc0513",
    attestTypeHash: "0xdbfdf8dc2b135c26253e00d5b6cbe6f20457e003fd526d97cea183883570de61",
    revokeTypeHash: "0xa98d02348410c9c76735e0d0bb1396f4015ac2bb9615f9c2611d19d7a8a99650",
    attestTypes: { Attest: [...baseFields, nonceField] },
    revokeTypes: { Revoke: [...revokeFields, nonceField] },
  },
  "eas-native-1.2.0": {
    id: "eas-native-1.2.0", chainId:84532, implementation:"0xC0D3c0D3C0d3c0D3c0D3C0D3c0D3c0d3c0d30021", contractVersion: "1.2.0", domainVersion: "1.2.0", signedDeadline: true,
    implementationCodeHash: "0x703f246f804f8d4b315fd7b5fc504671f726230373571e02b69794d0f2614fd7",
    attestTypeHash: "0xf83bb2b0ede93a840239f7e701a54d9bc35f03701f51ae153d601c6947ff3d3f",
    revokeTypeHash: "0x2d4116d8c9824e4c316453e5c2843a1885580374159ce8768603c49085ef424c",
    attestTypes: { Attest: [...baseFields, valueField, nonceField, deadlineField] },
    revokeTypes: { Revoke: [...revokeFields, valueField, nonceField, deadlineField] },
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
/** Pinned runtime identity plus all domain/type reads; version alone never enables a profile. */
export async function observeEasProfile(
  client: PublicClient, chainId: number, address: Address, blockTag: "latest" | "safe" | "finalized" = "latest",
): Promise<EasProfileObservation> {
  if (address.toLowerCase() !== "0x4200000000000000000000000000000000000021" || await client.getChainId() !== chainId) throw new EasIncompatible();
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
  const profile = Object.values(EAS_PROFILES).find(p => p.chainId === chainId && p.implementation.toLowerCase() === implementation.toLowerCase() && p.implementationCodeHash === implementationCodeHash &&
    p.contractVersion === version && p.attestTypeHash === attest && p.revokeTypeHash === revoke &&
    easDomainSeparator(chainId, address, p.domainVersion) === domain);
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
