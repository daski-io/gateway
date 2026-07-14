export interface ProviderLegalMetadata {
  legalName: string;
  termsUrl: string;
  privacyUrl: string;
}

export interface MarketplaceLegalUrls {
  marketplaceTermsUrl: string;
  marketplacePrivacyUrl: string;
}

export interface ServiceLegal {
  marketplaceTermsUrl: string;
  marketplacePrivacyUrl: string;
  providerLegalName: string;
  providerTermsUrl: string;
  providerPrivacyUrl: string;
}

export interface AgentAuthority {
  operatorIsLegalParty: true;
  onMissingAuthority: "stop_and_request_operator_authorization";
  notice: string;
}

export interface PurchaseLegalContext {
  legal: ServiceLegal;
  agentAuthority: AgentAuthority;
  purchaseNotice: string;
}
