export interface SubmitTaskArgs {
  providerA2AUrl?: string;
  skillId?: string;
  paymentId?: string;
  chainId?: 8453 | 84532;
  buyerTokenId?: string;
  walletAddress?: string;
  serviceRef?: string;
  transactionHash?: string;
  prompt?: string;
  serviceArgs?: Record<string, unknown>;
  capability?: {
    signature: string;
    authorization: Record<string, unknown>;
  };
  messageId?: string;
  envelopeAuth?: {
    signature: string;
    authorization: {
      buyerTokenId: string;
      skillId: string;
      paymentId: string;
      chainId: number;
      messageId: string;
      requestHash: string;
      issuedAt: string;
    };
  };
  contextId?: string;
  taskId?: string;
}

export interface RoutedSubmitTaskArgs extends SubmitTaskArgs {
  providerA2AUrl: string;
  skillId: string;
  paymentId: string;
  chainId: 8453 | 84532;
}
