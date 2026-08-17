import {
  concatHex,
  encodeAbiParameters,
  getAddress,
  getCreate2Address,
  keccak256,
  type Address,
  type Hex,
} from "viem";

export interface SplitterConstructorBinding {
  chainId: number;
  canonicalToken: Address;
  providerPayee: Address;
  daskiCommissionReceiver: Address;
  commissionBps: number;
  policyVersionHash: Hex;
  outcomeIdHash: Hex;
  listingCommitmentHash: Hex;
  listingEpoch: bigint;
}

export interface SplitterProvenanceBinding {
  splitterAddress: Address;
  splitterFactory: Address;
  splitterFactoryRuntimeCodeHash: Hex;
  splitterDeploymentSalt: Hex;
  splitterCreationCode: Hex;
  splitterCreationCodeHash: Hex;
  splitterInitCodeHash: Hex;
  splitterImmutableHash: Hex;
}

const constructorTypes = [
  { type: "uint256" },
  { type: "address" },
  { type: "address" },
  { type: "address" },
  { type: "uint16" },
  { type: "bytes32" },
  { type: "bytes32" },
  { type: "bytes32" },
  { type: "uint64" },
] as const;

function constructorValues(binding: SplitterConstructorBinding) {
  if (
    !Number.isSafeInteger(binding.chainId) ||
    binding.chainId < 1 ||
    !Number.isSafeInteger(binding.commissionBps) ||
    binding.commissionBps < 1 ||
    binding.commissionBps >= 10_000 ||
    binding.listingEpoch < 1n ||
    binding.listingEpoch >= 1n << 64n
  ) throw new Error("Splitter constructor values are outside their ABI ranges");
  return [
    BigInt(binding.chainId),
    getAddress(binding.canonicalToken),
    getAddress(binding.providerPayee),
    getAddress(binding.daskiCommissionReceiver),
    binding.commissionBps,
    binding.policyVersionHash,
    binding.outcomeIdHash,
    binding.listingCommitmentHash,
    binding.listingEpoch,
  ] as const;
}

export function deriveSplitterProvenance(args: {
  constructor: SplitterConstructorBinding;
  provenance: SplitterProvenanceBinding;
  trustedSplitterCreationCodeHash: Hex;
  trustedSplitterFactoryRuntimeCodeHash: Hex;
}): {
  initCodeHash: Hex;
  immutableHash: Hex;
  splitterAddress: Address;
} {
  const creationCodeHash = keccak256(args.provenance.splitterCreationCode);
  if (
    creationCodeHash !== args.trustedSplitterCreationCodeHash ||
    creationCodeHash !== args.provenance.splitterCreationCodeHash ||
    args.provenance.splitterFactoryRuntimeCodeHash !==
      args.trustedSplitterFactoryRuntimeCodeHash
  ) throw new Error("Splitter bytecode provenance is not independently trusted");
  const values = constructorValues(args.constructor);
  const initCodeHash = keccak256(concatHex([
    args.provenance.splitterCreationCode,
    encodeAbiParameters(constructorTypes, values),
  ]));
  const immutableHash = keccak256(encodeAbiParameters([
    { type: "uint256" },
    { type: "address" },
    { type: "address" },
    { type: "address" },
    { type: "uint256" },
    { type: "bytes32" },
    { type: "bytes32" },
    { type: "bytes32" },
    { type: "uint256" },
  ], [
    BigInt(args.constructor.chainId),
    getAddress(args.constructor.canonicalToken),
    getAddress(args.constructor.providerPayee),
    getAddress(args.constructor.daskiCommissionReceiver),
    BigInt(args.constructor.commissionBps),
    args.constructor.policyVersionHash,
    args.constructor.outcomeIdHash,
    args.constructor.listingCommitmentHash,
    args.constructor.listingEpoch,
  ]));
  const splitterAddress = getCreate2Address({
    from: getAddress(args.provenance.splitterFactory),
    salt: args.provenance.splitterDeploymentSalt,
    bytecodeHash: initCodeHash,
  });
  if (
    initCodeHash !== args.provenance.splitterInitCodeHash ||
    immutableHash !== args.provenance.splitterImmutableHash ||
    splitterAddress !== getAddress(args.provenance.splitterAddress)
  ) throw new Error("Splitter init code, immutables, or CREATE2 address mismatch");
  return { initCodeHash, immutableHash, splitterAddress };
}
