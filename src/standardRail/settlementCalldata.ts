import {
  decodeFunctionData,
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
} from "viem";

const transferAuthorizationCallAbi = parseAbi([
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,bytes signature)",
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)",
]);

export interface SettlementCalldata {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
  signature: Hex;
  canonicalPrefix: Hex;
}

function signatureFromVrs(v: number, r: Hex, s: Hex): Hex {
  if (v !== 27 && v !== 28) throw new Error("Settlement signature recovery id is invalid");
  return `${r}${s.slice(2)}${v.toString(16).padStart(2, "0")}` as Hex;
}

/** Decodes both Exact-EVM transfer authorization ABIs used by supported facilitators. */
export function decodeSettlementCalldata(input: Hex): SettlementCalldata {
  const call = decodeFunctionData({ abi: transferAuthorizationCallAbi, data: input });
  if (call.functionName !== "transferWithAuthorization") {
    throw new Error("Unexpected settlement calldata");
  }
  if (call.args.length === 7) {
    const [from, to, value, validAfter, validBefore, nonce, signature] = call.args;
    return {
      from,
      to,
      value,
      validAfter,
      validBefore,
      nonce,
      signature,
      canonicalPrefix: encodeFunctionData({
        abi: transferAuthorizationCallAbi,
        functionName: "transferWithAuthorization",
        args: [from, to, value, validAfter, validBefore, nonce, signature],
      }),
    };
  }
  const [from, to, value, validAfter, validBefore, nonce, v, r, s] = call.args;
  return {
    from,
    to,
    value,
    validAfter,
    validBefore,
    nonce,
    signature: signatureFromVrs(v, r, s),
    canonicalPrefix: encodeFunctionData({
      abi: transferAuthorizationCallAbi,
      functionName: "transferWithAuthorization",
      args: [from, to, value, validAfter, validBefore, nonce, v, r, s],
    }),
  };
}
