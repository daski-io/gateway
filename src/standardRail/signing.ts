import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "../types.js";
import { artifactPayloadHash } from "./canonical.js";
import type { SignedEnvelope } from "./types.js";

export async function signEnvelope<T, Version extends 1 | 2 = 1>(args: {
  artifactType: string;
  schemaVersion?: Version;
  environment: string;
  chainId: number;
  audience: string;
  signerKeyId: string;
  privateKey: Hex;
  issuedAt: number;
  validBefore: number;
  payload: T;
}): Promise<SignedEnvelope<T, Version>> {
  const unsigned = {
    artifactType: args.artifactType,
    schemaVersion: (args.schemaVersion ?? 1) as Version,
    environment: args.environment,
    chainId: args.chainId,
    audience: args.audience,
    signerKeyId: args.signerKeyId,
    issuedAt: args.issuedAt,
    validBefore: args.validBefore,
    payload: args.payload,
  };
  const signature = await privateKeyToAccount(args.privateKey).signMessage({
    message: { raw: artifactPayloadHash(unsigned) },
  });
  return { ...unsigned, signature };
}
