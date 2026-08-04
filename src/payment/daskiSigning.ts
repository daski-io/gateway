import { getAddress, toHex } from "viem";
import type { Config } from "../config.js";
import type { DaskiX402Signing, Hex } from "../types.js";
import { deriveDaskiReceiveNonce } from "./daskiNonce.js";
import { RECEIVE_WITH_AUTHORIZATION_TYPES } from "./protocol.js";

interface DaskiSigningInput {
  payer: Hex;
  amount: bigint;
  validBefore: bigint;
  providerAgentId: bigint;
  serviceId: Hex;
  expectedPayee: Hex;
  serviceRef: Hex;
}

/** Builds the self-contained wallet-signing instructions issued with a challenge. */
export function buildDaskiX402Signing(
  config: Config,
  input: DaskiSigningInput,
): DaskiX402Signing {
  const nonceSalt = randomNonzeroHex32();
  const validAfter = 0n;
  const adapter = getAddress(config.x402AdapterAddress);
  const router = getAddress(config.paymentRouterAddress);
  const token = getAddress(config.usdc.address);
  const payer = getAddress(input.payer);
  const expectedPayee = getAddress(input.expectedPayee);
  const nonceInput = {
    chainId: config.chainId,
    adapter,
    router,
    token,
    payer,
    amount: input.amount,
    validAfter,
    validBefore: input.validBefore,
    providerAgentId: input.providerAgentId,
    serviceId: input.serviceId,
    expectedPayee,
    serviceRef: input.serviceRef,
    nonceSalt,
  };
  const authorization = {
    from: payer,
    to: adapter,
    value: input.amount.toString(),
    validAfter: validAfter.toString(),
    validBefore: input.validBefore.toString(),
    nonce: deriveDaskiReceiveNonce(nonceInput),
  };

  return {
    eip712TypedData: {
      domain: {
        name: config.usdc.name,
        version: config.usdc.version,
        chainId: config.chainId,
        verifyingContract: token,
      },
      types: {
        ReceiveWithAuthorization:
          RECEIVE_WITH_AUTHORIZATION_TYPES.ReceiveWithAuthorization.map(
            (field) => ({ ...field }),
          ),
      },
      primaryType: "ReceiveWithAuthorization",
      message: authorization,
    },
    nonceSalt,
    nonceDerivation: {
      ...nonceInput,
      amount: nonceInput.amount.toString(),
      validAfter: nonceInput.validAfter.toString(),
      validBefore: nonceInput.validBefore.toString(),
      providerAgentId: nonceInput.providerAgentId.toString(),
      recipe: `${config.publicUrl}/skill.md#daski-exact-signing`,
    },
    nextAction:
      "Sign eip712TypedData with the buyer wallet, then retry this exact " +
      "tool call unchanged plus paymentPayload containing x402Version, " +
      "serviceRef, authorization, signature, and nonceSalt. x402 clients " +
      "may use the full payload at _meta['x402/payment'] instead. A client " +
      "that cannot sign and cannot reach a signer cannot buy; settlement " +
      "requires wallet signing.",
  };
}

function randomNonzeroHex32(): Hex {
  for (;;) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    if (bytes.some((value) => value !== 0)) return toHex(bytes);
  }
}
