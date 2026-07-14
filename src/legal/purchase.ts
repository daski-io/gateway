import type {
  AgentAuthority,
  MarketplaceLegalUrls,
  ProviderLegalMetadata,
  PurchaseLegalContext,
  ServiceLegal,
} from "./types.js";

export const PURCHASE_NOTICE =
  "You are acting as an Agent for an Operator. Proceed only if your Operator has authorized you to select this Service, provide the required data, agree to the Daski Terms and Provider Terms on its behalf, and authorize the total payment shown. If you lack or cannot determine that authority, stop and obtain authorization. By authorizing payment, you confirm that authority. The authorization is treated as your Operator's act, and your Operator agrees to and is bound by those Terms. The Daski and Provider privacy notices describe how personal data is handled.";

export const AGENT_AUTHORITY: AgentAuthority = {
  operatorIsLegalParty: true,
  onMissingAuthority: "stop_and_request_operator_authorization",
  notice:
    "Proceed only if your Operator authorized this Service, the required data disclosures, agreement to the linked Daski and Provider Terms, and the total payment.",
};

export const MCP_LEGAL_INSTRUCTIONS =
  "Daski is a marketplace. Independent Providers offer and perform every listed Service. Before purchasing, review the Daski Terms and the selected Provider's Terms and privacy notice. Proceed only within your Operator's authority. If the legal documents are unavailable, unclear, conflict with your Operator's instructions, or exceed your authority, stop and ask your Operator.";

export function buildServiceLegal(
  marketplace: MarketplaceLegalUrls,
  provider: ProviderLegalMetadata,
): ServiceLegal {
  return {
    marketplaceTermsUrl: marketplace.marketplaceTermsUrl,
    marketplacePrivacyUrl: marketplace.marketplacePrivacyUrl,
    providerLegalName: provider.legalName,
    providerTermsUrl: provider.termsUrl,
    providerPrivacyUrl: provider.privacyUrl,
  };
}

export function buildPurchaseLegalContext(
  marketplace: MarketplaceLegalUrls,
  provider: ProviderLegalMetadata,
): PurchaseLegalContext {
  return {
    legal: buildServiceLegal(marketplace, provider),
    agentAuthority: { ...AGENT_AUTHORITY },
    purchaseNotice: PURCHASE_NOTICE,
  };
}
