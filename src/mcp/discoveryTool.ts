import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CATEGORY_FAMILY_SLUGS,
  FULFILLMENT_MODES,
  SERVICE_TYPE_SLUGS,
  isJurisdiction,
  isServiceTypeForFamily,
} from "../serviceTaxonomy.js";
import { searchServices, type SearchServicesArgs } from "./discoverySearch.js";
import type { McpDeps } from "./server.js";
import { mcpJson, type McpToolResult } from "./util.js";

const SEARCH_SERVICES_INPUT_SCHEMA = z
  .object({
    intent: z
      .string()
      .optional()
      .describe(
        "Free-text description of the desired service. Results are ranked " +
          "by semantic similarity over catalog skills.",
      ),
    categoryFamily: z
      .enum(CATEGORY_FAMILY_SLUGS)
      .optional()
      .describe("Filter by category family."),
    serviceType: z
      .enum(SERVICE_TYPE_SLUGS)
      .optional()
      .describe("Filter by controlled service type."),
    jurisdiction: z
      .string()
      .refine(isJurisdiction, (val) => ({
        message:
          `Invalid jurisdiction '${val}'. Use 'global', an ISO 3166-1 country ` +
          "code ('US'), or an ISO 3166-2 subdivision code ('US-WY'). Plain " +
          "place names like 'Wyoming' are not accepted.",
      }))
      .optional()
      .describe(
        "Filter by availability jurisdiction — ISO code only: 'global', a " +
          "country ('US'), or a subdivision ('US-WY' for Wyoming). NOT " +
          "plain place names like 'Wyoming'.",
      ),
    fulfillmentMode: z
      .enum(FULFILLMENT_MODES)
      .optional()
      .describe("Filter by automated, human, or hybrid fulfillment."),
    maxPrice: z
      .number()
      .optional()
      .describe("Maximum base price in USDC."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Maximum providers to return. Default 10."),
  })
  .strict();

export function registerDiscoveryTool(
  server: McpServer,
  deps: McpDeps,
): void {
  server.registerTool(
    "daski_search_services",
    {
      description: [
        "Find a provider on the Daski marketplace for a real-world service paid in USDC.",
        "",
        "Use this before a purchase when the provider and skill are not known.",
        "Filter by category, service type, jurisdiction (ISO code, e.g. US or",
        "US-WY — not plain names like 'Wyoming'), fulfillment mode, or price.",
        "Returns provider endpoints, legal terms, skills, pricing, and capability flags.",
        "Next: use daski_buy_service for paid skills or daski_submit_task for free skills.",
      ].join("\n"),
      inputSchema: SEARCH_SERVICES_INPUT_SCHEMA,
      annotations: {
        title: "Find a Daski provider",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args: SearchServicesArgs): Promise<McpToolResult> => {
      if (
        args.categoryFamily &&
        args.serviceType &&
        !isServiceTypeForFamily(args.categoryFamily, args.serviceType)
      ) {
        return mcpJson({
          error: {
            code: "INVALID_FILTER",
            message: "serviceType does not belong to categoryFamily",
          },
        });
      }
      return mcpJson(await searchServices(args, deps));
    },
  );
}
