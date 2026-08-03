import { hashCanonical } from "../payment/requirementResponse.js";
import type { Hex, PaymentPayload } from "../types.js";
import type { ProviderMatch } from "./providerCatalog.js";

export interface BuyServiceArgs {
  skillId: string;
  serviceSlug: string;
  walletAddress: string;
  name?: string;
  useWalletDerivedName?: boolean;
  buyerTokenId?: string;
  providerTokenId?: string;
  serviceArgs?: Record<string, unknown>;
  amount?: string;
  paymentId?: string;
  registration?: { agentURI: string; deadline: string; signature: string };
  paymentPayload?: PaymentPayload;
}

export function purchaseRequestFingerprint(args: BuyServiceArgs): Hex {
  const { paymentPayload: _paymentPayload, ...purchase } = args;
  return hashCanonical(purchase);
}

export interface BuyServiceContext {
  args: BuyServiceArgs;
  provider: ProviderMatch;
  providerA2AUrl: string;
  serviceArgs: Record<string, unknown>;
  buyerAgentId: bigint;
  buyerName?: string;
}
