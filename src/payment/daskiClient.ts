import type {
  PaymentPayloadContext,
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeNetworkClient,
} from "@x402/core/types";
import { getAddress, toHex } from "viem";
import type { Hex } from "../types.js";
import { deriveDaskiReceiveNonce } from "./daskiNonce.js";
import { RECEIVE_WITH_AUTHORIZATION_TYPES } from "./protocol.js";

export interface DaskiEvmSigner {
  address: Hex;
  signTypedData(input: {
    domain: Record<string, unknown>;
    types: Record<string, readonly { name: string; type: string }[]>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<Hex>;
}

interface DaskiRequirementExtra {
  assetTransferMethod?: string;
  name?: string;
  version?: string;
  daskiProfile?: string;
  authorizationValidBefore?: string;
  paymentRouter?: Hex;
  providerAgentId?: string;
  serviceId?: Hex;
  serviceRef?: Hex;
}

/** Client implementation for Daski's route-bound x402 V2 receive profile. */
export class DaskiExactEvmScheme implements SchemeNetworkClient {
  readonly scheme = "daski-exact";

  constructor(private readonly signer: DaskiEvmSigner) {}

  async createPaymentPayload(
    x402Version: number,
    requirements: PaymentRequirements,
    _context?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult> {
    if (x402Version !== 2) throw new Error("daski-exact requires x402 V2");
    const extra = requirements.extra as DaskiRequirementExtra | undefined;
    validateRequirement(requirements, extra);

    const chainId = parseChainId(requirements.network);
    const validAfter = 0n;
    const validBefore = BigInt(extra!.authorizationValidBefore!);
    const nonceSalt = randomNonzeroHex32();
    const authorization = {
      from: getAddress(this.signer.address),
      to: getAddress(requirements.payTo),
      value: requirements.amount,
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce: deriveDaskiReceiveNonce({
        chainId,
        adapter: getAddress(requirements.payTo),
        router: getAddress(extra!.paymentRouter!),
        token: getAddress(requirements.asset),
        payer: getAddress(this.signer.address),
        amount: BigInt(requirements.amount),
        validAfter,
        validBefore,
        providerAgentId: BigInt(extra!.providerAgentId!),
        serviceId: extra!.serviceId!,
        serviceRef: extra!.serviceRef!,
        nonceSalt,
      }),
    };
    const signature = await this.signer.signTypedData({
      domain: {
        name: extra!.name!,
        version: extra!.version!,
        chainId,
        verifyingContract: getAddress(requirements.asset),
      },
      types: RECEIVE_WITH_AUTHORIZATION_TYPES,
      primaryType: "ReceiveWithAuthorization",
      message: {
        ...authorization,
        value: BigInt(authorization.value),
        validAfter,
        validBefore,
      },
    });
    return {
      x402Version,
      payload: { authorization, signature, nonceSalt },
    };
  }
}

function validateRequirement(
  requirements: PaymentRequirements,
  extra: DaskiRequirementExtra | undefined,
): void {
  if (requirements.scheme !== "daski-exact") {
    throw new Error(`unsupported scheme: ${requirements.scheme}`);
  }
  if (
    extra?.assetTransferMethod !== "eip3009-receive" ||
    extra.daskiProfile !== "1" ||
    !/^\d+$/.test(extra.authorizationValidBefore ?? "") ||
    !extra.name ||
    !extra.version ||
    !extra.paymentRouter ||
    !extra.providerAgentId ||
    !extra.serviceId ||
    !extra.serviceRef
  ) {
    throw new Error("daski-exact requirement is missing route metadata");
  }
}

function parseChainId(network: string): number {
  const match = /^eip155:(\d+)$/.exec(network);
  if (!match) throw new Error(`invalid EVM network: ${network}`);
  const chainId = Number(match[1]);
  if (!Number.isSafeInteger(chainId)) {
    throw new Error(`invalid EVM chain ID: ${network}`);
  }
  return chainId;
}

function randomNonzeroHex32(): Hex {
  for (;;) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    if (bytes.some((value) => value !== 0)) return toHex(bytes);
  }
}
