import { describe, expect, it } from "vitest";
import {
  concatHex,
  encodeAbiParameters,
  getCreate2Address,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { deriveSplitterProvenance } from "../src/standardRail/splitterProvenance.js";

const constructorTypes = [
  { type: "uint256" }, { type: "address" }, { type: "address" },
  { type: "address" }, { type: "uint16" }, { type: "bytes32" },
  { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" },
] as const;

const immutableTypes = [
  { type: "uint256" }, { type: "address" }, { type: "address" },
  { type: "address" }, { type: "uint256" }, { type: "bytes32" },
  { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" },
] as const;

const token = "0x1111111111111111111111111111111111111111" as Address;
const payee = "0x2222222222222222222222222222222222222222" as Address;
const receiver = "0x3333333333333333333333333333333333333333" as Address;
const factory = "0x4444444444444444444444444444444444444444" as Address;
const policyHash = `0x${"55".repeat(32)}` as Hex;
const outcomeHash = `0x${"66".repeat(32)}` as Hex;
const commitmentHash = `0x${"77".repeat(32)}` as Hex;
const salt = `0x${"88".repeat(32)}` as Hex;
const factoryRuntimeHash = `0x${"99".repeat(32)}` as Hex;
const creationCode = "0x60006000556001600055" as Hex;

function fixture() {
  const constructor = {
    chainId: 8453,
    canonicalToken: token,
    providerPayee: payee,
    daskiCommissionReceiver: receiver,
    commissionBps: 1_000,
    policyVersionHash: policyHash,
    outcomeIdHash: outcomeHash,
    listingCommitmentHash: commitmentHash,
    listingEpoch: 9n,
  };
  const values = [
    8453n, token, payee, receiver, 1_000, policyHash, outcomeHash, commitmentHash, 9n,
  ] as const;
  const creationCodeHash = keccak256(creationCode);
  const initCodeHash = keccak256(concatHex([
    creationCode,
    encodeAbiParameters(constructorTypes, values),
  ]));
  const immutableHash = keccak256(encodeAbiParameters(immutableTypes, [
    8453n, token, payee, receiver, 1_000n, policyHash, outcomeHash, commitmentHash, 9n,
  ]));
  const splitterAddress = getCreate2Address({
    from: factory,
    salt,
    bytecodeHash: initCodeHash,
  });
  return {
    constructor,
    provenance: {
      splitterAddress,
      splitterFactory: factory,
      splitterFactoryRuntimeCodeHash: factoryRuntimeHash,
      splitterDeploymentSalt: salt,
      splitterCreationCode: creationCode,
      splitterCreationCodeHash: creationCodeHash,
      splitterInitCodeHash: initCodeHash,
      splitterImmutableHash: immutableHash,
    },
    trustedSplitterCreationCodeHash: creationCodeHash,
    trustedSplitterFactoryRuntimeCodeHash: factoryRuntimeHash,
  };
}

describe("deriveSplitterProvenance", () => {
  it("deterministically rebuilds init code, immutables, and CREATE2", () => {
    const first = deriveSplitterProvenance(fixture());
    const second = deriveSplitterProvenance(fixture());

    expect(first).toEqual(second);
    expect(first.splitterAddress).toBe(fixture().provenance.splitterAddress);
  });

  it("rejects raw creation-code substitution even when manifest hashes follow it", () => {
    const input = fixture();
    const replacement = "0x60016000" as Hex;
    input.provenance.splitterCreationCode = replacement;
    input.provenance.splitterCreationCodeHash = keccak256(replacement);
    expect(() => deriveSplitterProvenance(input)).toThrow(/independently trusted/);
  });

  it("rejects independently trusted code-hash mismatches", () => {
    const creation = fixture();
    creation.trustedSplitterCreationCodeHash = `0x${"aa".repeat(32)}`;
    expect(() => deriveSplitterProvenance(creation)).toThrow(/independently trusted/);

    const factoryCode = fixture();
    factoryCode.trustedSplitterFactoryRuntimeCodeHash = `0x${"bb".repeat(32)}`;
    expect(() => deriveSplitterProvenance(factoryCode)).toThrow(/independently trusted/);
  });

  it("rejects constructor, init-hash, immutable-hash, and address tampering", () => {
    const constructor = fixture();
    constructor.constructor.chainId += 1;
    expect(() => deriveSplitterProvenance(constructor)).toThrow(/mismatch/);

    const init = fixture();
    init.provenance.splitterInitCodeHash = `0x${"cc".repeat(32)}`;
    expect(() => deriveSplitterProvenance(init)).toThrow(/mismatch/);

    const immutable = fixture();
    immutable.provenance.splitterImmutableHash = `0x${"dd".repeat(32)}`;
    expect(() => deriveSplitterProvenance(immutable)).toThrow(/mismatch/);

    const address = fixture();
    address.provenance.splitterAddress =
      "0x5555555555555555555555555555555555555555";
    expect(() => deriveSplitterProvenance(address)).toThrow(/mismatch/);
  });
});
