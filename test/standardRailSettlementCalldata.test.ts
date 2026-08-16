import { encodeFunctionData, parseAbi, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { decodeSettlementCalldata } from "../src/standardRail/settlementCalldata.js";

const from = "0x1111111111111111111111111111111111111111";
const to = "0x2222222222222222222222222222222222222222";
const nonce = `0x${"33".repeat(32)}` as Hex;
const r = `0x${"44".repeat(32)}` as Hex;
const s = `0x${"55".repeat(32)}` as Hex;
const signature = `${r}${s.slice(2)}1c` as Hex;

describe("standard settlement calldata", () => {
  it("decodes the bytes-signature Exact-EVM ABI", () => {
    const abi = parseAbi([
      "function transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)",
    ]);
    const input = encodeFunctionData({
      abi,
      functionName: "transferWithAuthorization",
      args: [from, to, 10n, 20n, 30n, nonce, signature],
    });

    expect(decodeSettlementCalldata(input)).toMatchObject({
      from,
      to,
      value: 10n,
      validAfter: 20n,
      validBefore: 30n,
      nonce,
      signature,
      canonicalPrefix: input,
    });
  });

  it("decodes the legacy v-r-s ABI and preserves an inert facilitator suffix", () => {
    const abi = parseAbi([
      "function transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)",
    ]);
    const canonical = encodeFunctionData({
      abi,
      functionName: "transferWithAuthorization",
      args: [from, to, 10n, 20n, 30n, nonce, 28, r, s],
    });
    const input = `${canonical}a161776a6364705f666163696c31` as Hex;
    const decoded = decodeSettlementCalldata(input);

    expect(decoded).toMatchObject({
      from,
      to,
      value: 10n,
      validAfter: 20n,
      validBefore: 30n,
      nonce,
      signature,
      canonicalPrefix: canonical,
    });
    expect(input.startsWith(decoded.canonicalPrefix)).toBe(true);
  });
});
