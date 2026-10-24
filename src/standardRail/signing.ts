import type { LocalAccount } from "viem/accounts";
import { artifactPayloadHash } from "./canonical.js";
import type { SignedEnvelope } from "./types.js";

/** Signs EIP-191 over raw bytes: a gateway signer role's account, or a local key's. */
export type MessageSigner = Pick<LocalAccount, "signMessage">;

export async function signEnvelope<T, Version extends 1 | 2 = 1>(args: {
  artifactType: string;
  schemaVersion?: Version;
  environment: string;
  chainId: number;
  audience: string;
  signerKeyId: string;
  account: MessageSigner;
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
  const signature = await args.account.signMessage({
    message: { raw: artifactPayloadHash(unsigned) },
  });
  return { ...unsigned, signature };
}
