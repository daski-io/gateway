import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import type { DiscoveryCache } from "../discovery/cache.js";
import { cardsOf, extractAgentCardName } from "../discovery/agentCard.js";
import { formatForSkillDiscover } from "../discovery/skillPresentation.js";
import { sanitizeProviderValue } from "./providerReflection.js";

export function registerProviderResource(
  server: McpServer,
  cache: DiscoveryCache,
  config: Config,
): void {
  server.registerResource(
    "daski-provider",
    new ResourceTemplate("daski://provider/{agentId}", {
      list: async () => ({
        resources: cache.getAll().map((provider) => ({
          uri: `daski://provider/${provider.agentId.toString()}`,
          name:
            sanitizeProviderValue(
              cardsOf(provider)
                .map((card) => extractAgentCardName(card.agentCard))
                .filter((name) => name !== "(unnamed)")
                .join(" + "),
            ) || `provider#${provider.agentId.toString()}`,
          description: `Daski provider Agent Card (${provider.agentId.toString()})`,
          mimeType: "application/json",
        })),
      }),
    }),
    {
      title: "Daski provider",
      description: "Full Agent Card and skill metadata for one ERC-8004 provider.",
    },
    async (uri, variables) => {
      let agentId: bigint;
      try {
        agentId = BigInt(String(variables.agentId));
      } catch {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({
                error: "agentId must be a numeric string",
              }),
            },
          ],
        };
      }
      const provider = cache.get(agentId);
      const entries = provider ? formatForSkillDiscover([provider], config) : null;
      const value =
        !entries || entries.length === 0
          ? { error: "provider is not currently admitted or not in cache" }
          : entries.length === 1
            ? entries[0]
            : entries;
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(value, null, 2),
          },
        ],
      };
    },
  );
}
