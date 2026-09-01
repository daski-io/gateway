import type { McpServer } from "@modelcontextprotocol/server";
import { getAddress, type Hex } from "viem";
import { z } from "zod";
import { mcpError, mcpJson } from "../mcp/util.js";
import type { MarketplaceChainReader } from "./reader.js";

async function chainRead(read: () => Promise<unknown>) {
  try {
    return mcpJson(await read());
  } catch {
    return mcpError({
      code: "MARKETPLACE_CHAIN_READ_FAILED",
      message: "Marketplace chain state is unavailable",
      retryable: true,
    });
  }
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

interface ActiveMarketplaceOutcome {
  providerAgentId: string;
  serviceId: Hex;
  outcomeId: string;
}

export function registerMarketplaceTools(
  server: McpServer,
  reader: MarketplaceChainReader,
  activeOutcomes: () => Promise<readonly ActiveMarketplaceOutcome[]>,
): void {
  server.registerTool(
    "daski_list_providers",
    {
      outputSchema: z.object({}).catchall(z.unknown()),
      description: "List providers registered in the Daski on-chain marketplace catalog.",
      inputSchema: {
        offset: z.number().int().min(0).max(1_000_000).default(0),
        limit: z.number().int().min(1).max(100).default(25),
      },
      annotations: { title: "List Daski providers", ...readOnlyAnnotations },
    },
    async ({ offset, limit }) => chainRead(async () => {
      const all = await activeOutcomes();
      const ids = [...new Set(all.map((item) => String(item.providerAgentId)))];
      const page = ids.slice(offset, offset + limit);
      return {
        offset,
        limit,
        total: ids.length.toString(),
        providers: await Promise.all(page.map(async (id) => ({
          ...await reader.getProvider(BigInt(id)) as object,
          marketplaceAdmitted: true,
          activeOutcomeIds: all
            .filter((item) => item.providerAgentId === id).map((item) => item.outcomeId),
        }))),
      };
    }),
  );
  server.registerTool(
    "daski_get_provider",
    {
      outputSchema: z.object({}).catchall(z.unknown()),
      description:
        "Read a provider's canonical identity, catalog services, and standard-order reputation.",
      inputSchema: { agentId: z.string().regex(/^(0|[1-9]\d{0,77})$/) },
      annotations: { title: "Get a Daski provider", ...readOnlyAnnotations },
    },
    async ({ agentId }) => chainRead(async () => {
      const outcomes = (await activeOutcomes()).filter((item) => item.providerAgentId === agentId);
      return {
        ...await reader.getProvider(BigInt(agentId)) as object,
        marketplaceAdmitted: outcomes.length > 0,
        activeOutcomeIds: outcomes.map((item) => item.outcomeId),
      };
    }),
  );
  server.registerTool(
    "daski_get_service",
    {
      outputSchema: z.object({}).catchall(z.unknown()),
      description: "Read an on-chain Daski service-catalog record.",
      inputSchema: { serviceId: z.string().regex(/^0x[0-9a-fA-F]{64}$/) },
      annotations: { title: "Get a Daski service", ...readOnlyAnnotations },
    },
    async ({ serviceId }) => chainRead(async () => {
      const outcomes = (await activeOutcomes()).filter(
        (item) => String(item.serviceId).toLowerCase() === serviceId.toLowerCase(),
      );
      return {
        ...await reader.getService(serviceId as Hex) as object,
        marketplaceAdmitted: outcomes.length > 0,
        activeOutcomeIds: outcomes.map((item) => item.outcomeId),
      };
    }),
  );
  server.registerTool(
    "daski_resolve_agent",
    {
      outputSchema: z.object({}).catchall(z.unknown()),
      description: "Resolve a wallet through Daski's verified wallet-to-ERC-8004 agent index.",
      inputSchema: { wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/) },
      annotations: { title: "Resolve an ERC-8004 agent", ...readOnlyAnnotations },
    },
    async ({ wallet }) => chainRead(() => reader.resolveWallet(getAddress(wallet))),
  );
}
