import { describe, expect, it } from "vitest";
import {
  encodeAbiParameters,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import {
  assertSplitterDeploymentTransaction,
} from "../src/serviceRegistration/evidence.js";

const hash = (digit: string) => `0x${digit.repeat(64)}` as Hex;
const address = (digit: string) => `0x${digit.repeat(40)}` as Address;
const transactionHash = hash("1");
const blockHash = hash("2");
const salt = hash("3");
const listingKey = hash("4");
const listingCommitmentHash = hash("5");
const providerSigner = address("1");
const factory = address("2");
const splitterAddress = address("3");
const transactionData = "0x12345678" as Hex;
const listingEpoch = 7n;

function validAssertion() {
  const log = {
    address: factory,
    topics: [
      keccak256(stringToHex(
        "OutcomeSplitterDeployed(address,bytes32,bytes32,uint64,bytes32)",
      )),
      encodeAbiParameters([{ type: "address" }], [splitterAddress]),
      salt,
      listingKey,
    ],
    data: encodeAbiParameters(
      [{ type: "uint64" }, { type: "bytes32" }],
      [listingEpoch, listingCommitmentHash],
    ),
    blockHash,
    blockNumber: 17n,
    transactionHash,
    removed: false,
  };
  return {
    transactionHash,
    providerSigner,
    factory,
    transactionData,
    splitterAddress,
    salt,
    listingKey,
    listingEpoch,
    listingCommitmentHash,
    transaction: {
      hash: transactionHash,
      from: providerSigner,
      to: factory,
      input: transactionData,
      value: 0n,
      blockHash,
      blockNumber: 17n,
    },
    receipt: {
      transactionHash,
      from: providerSigner,
      to: factory,
      status: "success" as const,
      blockHash,
      blockNumber: 17n,
      logs: [log],
    },
  };
}

describe("splitter registration evidence", () => {
  it("binds the finalized transaction to the exact prepared deployment", () => {
    expect(() => assertSplitterDeploymentTransaction(validAssertion()))
      .not.toThrow();
  });

  it("rejects a different sender or calldata", () => {
    const relayed = validAssertion();
    relayed.transaction.from = address("9");
    relayed.receipt.from = address("9");
    expect(() => assertSplitterDeploymentTransaction(relayed))
      .toThrow("does not match preparation");

    const changedCall = validAssertion();
    changedCall.transaction.input = "0xabcdef" as Hex;
    expect(() => assertSplitterDeploymentTransaction(changedCall))
      .toThrow("does not match preparation");
  });

  it("requires exactly one matching trusted-factory deployment event", () => {
    const missing = validAssertion();
    missing.receipt.logs = [];
    expect(() => assertSplitterDeploymentTransaction(missing))
      .toThrow("deployment event does not match");

    const duplicate = validAssertion();
    duplicate.receipt.logs = [
      duplicate.receipt.logs[0]!,
      duplicate.receipt.logs[0]!,
    ];
    expect(() => assertSplitterDeploymentTransaction(duplicate))
      .toThrow("deployment event does not match");
  });
});
