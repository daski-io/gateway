import { privateKeyToAccount } from "viem/accounts";
import {
  A2A_REQUEST_AUTHORIZATION_PRIMARY_TYPE,
  A2A_REQUEST_AUTHORIZATION_TYPES,
  type A2ARequestAuthorization,
} from "../../src/auth/envelope.js";
import { buildDaskiProviderDomain } from "../../src/auth/providerDomain.js";
import type { Config } from "../../src/config.js";
import { TEST_BUYER_KEY } from "./setup.js";

export async function signTestEnvelope(
  config: Pick<Config, "chainId" | "identityRegistryAddress">,
  providerAgentId: bigint,
  authorization: A2ARequestAuthorization,
): Promise<string> {
  return privateKeyToAccount(TEST_BUYER_KEY).signTypedData({
    domain: buildDaskiProviderDomain({
      chainId: config.chainId,
      identityRegistryAddress: config.identityRegistryAddress,
      providerAgentId,
    }),
    types: A2A_REQUEST_AUTHORIZATION_TYPES,
    primaryType: A2A_REQUEST_AUTHORIZATION_PRIMARY_TYPE,
    message: {
      ...authorization,
      buyerTokenId: BigInt(authorization.buyerTokenId),
      paymentId: BigInt(authorization.paymentId),
      chainId: BigInt(authorization.chainId),
      issuedAt: BigInt(authorization.issuedAt),
    },
  });
}
