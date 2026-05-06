import { describe, expect, it } from "vitest";
import {
  BaseError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  encodeErrorResult,
} from "viem";
import { decodeRevertReason } from "../src/chain/viemReader.js";
import { knownErrorAbis } from "../src/chain/abis.js";

/**
 * Regression for the "execution reverted" black-hole that ate ~3 minutes
 * during a fresh-wallet domain registration: every contract revert with no
 * Solidity reason string surfaced as the bare phrase, leaving the caller
 * (and the agent) with nothing to act on. These tests pin down the four
 * shapes decodeRevertReason should now emit:
 *   1. require/revert("string") → the string verbatim
 *   2. typed custom error with ABI fragment → "ErrorName(args)"
 *   3. typed custom error WITHOUT a fragment → "unknown error 0xSELECTOR"
 *   4. zero-data revert (OOG / bare revert()) → an explicit OOG hint
 */

function makeReverted(args: {
  abi: readonly unknown[];
  data?: `0x${string}`;
  message?: string;
}): BaseError {
  return new ContractFunctionRevertedError({
    abi: args.abi as any,
    data: args.data,
    functionName: "settleWithRegistration",
    message: args.message,
  });
}

describe("decodeRevertReason", () => {
  it("returns the Solidity require string verbatim", () => {
    // ContractFunctionRevertedError parses this from `data` when `data`
    // matches the Error(string) ABI fragment.
    const data = encodeErrorResult({
      abi: [
        { type: "error", name: "Error", inputs: [{ type: "string" }] },
      ] as const,
      errorName: "Error",
      args: ["wallet already registered"],
    });
    const err = makeReverted({ abi: [], data });
    expect(decodeRevertReason(err)).toBe("wallet already registered");
  });

  it("formats a known custom error as ErrorName(args)", () => {
    const data = encodeErrorResult({
      abi: knownErrorAbis,
      errorName: "ERC721InvalidReceiver",
      args: ["0x0000000000000000000000000000000000000000"],
    });
    const err = makeReverted({ abi: knownErrorAbis, data });
    expect(decodeRevertReason(err)).toBe(
      "ERC721InvalidReceiver(0x0000000000000000000000000000000000000000)",
    );
  });

  it("surfaces the 4-byte selector when the ABI has no matching fragment", () => {
    // selector for keccak256("SomeUnknownError()")[:4]
    const unknownSelector = "0xdeadbeef" as const;
    const err = makeReverted({ abi: knownErrorAbis, data: unknownSelector });
    expect(decodeRevertReason(err)).toBe("unknown error 0xdeadbeef");
  });

  it("calls out zero-data reverts (OOG / bare revert()) explicitly", () => {
    // ContractFunctionExecutionError wraps a ZeroData error in real flows
    // (e.g. when a sub-call OOGs and bubbles up empty returndata). Walk the
    // cause chain — same path the production code takes.
    const cause = new ContractFunctionZeroDataError({
      functionName: "settleWithRegistration",
    });
    const wrapped = new ContractFunctionExecutionError(cause as any, {
      abi: knownErrorAbis as any,
      functionName: "settleWithRegistration",
    });
    expect(decodeRevertReason(wrapped)).toBe(
      "execution reverted with no data (out-of-gas or bare revert)",
    );
  });

  it("falls back to message text for non-revert errors (RPC outages, etc.)", () => {
    const err = new BaseError("connection refused");
    expect(decodeRevertReason(err)).toContain("connection refused");
  });

  it("handles plain Error instances thrown outside viem", () => {
    expect(decodeRevertReason(new Error("boom"))).toBe("boom");
    expect(decodeRevertReason("string thrown directly")).toBe(
      "string thrown directly",
    );
  });
});
