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
  phoneAcknowledgement?: { values: Record<string, string>; principalConfirmed: true };
  phoneAcknowledgementToken?: string;
  buyerNameAcknowledgementToken?: string;
  amount?: string;
  paymentId?: string;
  paymentPayload?: Record<string, unknown>;
  paymentRequirements?: Record<string, unknown>;
  registration?: { agentURI: string; deadline: string; signature: string };
}

export interface BuyServiceContext {
  args: BuyServiceArgs;
  provider: ProviderMatch;
  providerA2AUrl: string;
  serviceArgs: Record<string, unknown>;
  buyerAgentId: bigint;
  buyerName?: string;
}
