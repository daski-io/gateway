import {
  ProviderAuthorityError,
  type ProviderAuthorityService,
} from "../payment/providerAuthority.js";
import type { CatalogA2AEndpoint } from "./providerCatalog.js";
import { mcpError, type McpToolResult } from "./util.js";

type FreshCatalogResult<T extends CatalogA2AEndpoint> =
  | { ok: true; endpoint: T }
  | { ok: false; result: McpToolResult };

export async function requireFreshCatalogMatch<T extends CatalogA2AEndpoint>(
  providerAgentId: bigint,
  authority: ProviderAuthorityService,
  resolveCurrent: () => T | null,
): Promise<FreshCatalogResult<T>> {
  try {
    await authority.requireFresh(providerAgentId);
  } catch (error) {
    const inactive =
      error instanceof ProviderAuthorityError &&
      error.code === "provider_inactive";
    return {
      ok: false,
      result: mcpError({
        code: inactive
          ? "PROVIDER_INACTIVE"
          : "PROVIDER_AUTHORITY_UNAVAILABLE",
        message: inactive
          ? "The provider is no longer active. No outbound request was made."
          : "Fresh provider authority could not be verified. No outbound request was made.",
        recoverable: !inactive,
      }),
    };
  }

  const endpoint = resolveCurrent();
  if (!endpoint || endpoint.provider.agentId !== providerAgentId) {
    return {
      ok: false,
      result: mcpError({
        code: "PROVIDER_AUTHORITY_CHANGED",
        message:
          "The provider endpoint or advertised service changed. No outbound request was made.",
        recoverable: true,
      }),
    };
  }
  return { ok: true, endpoint };
}
