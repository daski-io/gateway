import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DiscoveryCache } from "../discovery/cache.js";
import {
  fetchArtifact,
  type ArtifactFetchOptions,
} from "./artifactFetch.js";
import { ConcurrencyLimiter } from "./concurrencyLimiter.js";
import { isCatalogArtifactUrl } from "./providerCatalog.js";
import { mcpError } from "./util.js";
import { activeRequestKey, activeRequestSignal } from "./requestContext.js";

export function registerArtifactTool(
  server: McpServer,
  cache: DiscoveryCache,
  options: ArtifactFetchOptions,
  limiter: ConcurrencyLimiter,
): void {
  server.registerTool(
    "daski_fetch_artifact",
    {
      description: [
        "Retrieve the actual bytes behind a Daski artifact URL, including audience-bound formation PDFs. This is a two-call wallet-signature flow; do not hand a short-lived artifact URL to the principal as durable proof.",
        "",
        "Inputs:",
        "- First call: `url` from the provider artifact, that artifact's `taskId`, and the cataloged `providerA2AUrl`; omit `capability`. The URL must use the provider origin or an artifact origin advertised by its Agent Card.",
        "- Signed retry: the exact same `url` + `taskId` + `providerA2AUrl`, plus `capability: { signature, authorization }`. Sign the returned `eip712TypedData` and echo `authorization` verbatim.",
        "- `expectedMimeType` defaults to `application/pdf`; pass the artifact's advertised mimeType for another format.",
        "",
        "Returns:",
        "- First call: `{ requiresSignature, eip712TypedData, authorization, capabilityChallenge }`.",
        "- Signed retry: `{ artifact: { mimeType, filename, sizeBytes, sha256 }, delivery }`, capped at 5 MiB and verified against the expected content type, plus the document attached as an MCP embedded resource. `delivery.principalUsable: true` refers to that file; retrieval alone is not delivery.",
        "- If the challenge expired before the retry, the tool returns a fresh challenge. Sign that new typed-data; do not reuse the expired authorization.",
        "- The underlying URL is ONE-TIME. Once redeemed — including by a call that dropped mid-transfer — later fetches of the same URL fail with ARTIFACT_AUTH_FAILED and no challenge. Do not retry a consumed URL: mint a fresh one (for formation documents, re-run download-entity-document) and sign its challenge.",
        "- The challenge is satisfiable ONLY by the buyer wallet that owns the purchase (plus provider-administrator staff tooling). There is no principal-facing browser login for artifact URLs — never hand a raw URL to a principal expecting it to open. If a principal asks for a \"working download link\", say upfront that no clickable link exists and you will fetch the file bytes on their behalf instead.",
      ].join("\n"),
      inputSchema: {
        url: z.string().url().describe("Short-lived URL from a Daski artifact."),
        providerA2AUrl: z
          .string()
          .url()
          .describe("Cataloged provider endpoint that produced the artifact."),
        taskId: z
          .string()
          .min(1)
          .describe("Task id that the artifact URL's audience challenge binds."),
        expectedMimeType: z
          .string()
          .optional()
          .describe(
            "Expected response media type. Defaults to application/pdf and " +
              "must match the artifact response's Content-Type.",
          ),
        capability: z
          .object({
            signature: z.string(),
            authorization: z.record(z.string(), z.unknown()),
          })
          .optional()
          .describe(
            "Signed TaskAccessAuthorization bound to this exact URL and " +
              "taskId. Echo authorization verbatim.",
          ),
      },
      annotations: {
        title: "Fetch a Daski artifact",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, extra) => {
      if (!isCatalogArtifactUrl(cache, args.providerA2AUrl, args.url)) {
        return mcpError({
          code: "ARTIFACT_ENDPOINT_NOT_CATALOGED",
          message:
            "The artifact URL is not on the provider origin or an artifact " +
            "origin advertised by the cataloged provider. No request was made.",
        });
      }
      const release = limiter.tryAcquire(
        activeRequestKey(extra.sessionId ?? "sessionless"),
      );
      if (!release) {
        return mcpError({
          code: "ARTIFACT_CAPACITY_REACHED",
          message: "Artifact download capacity reached; retry later.",
          recoverable: true,
        });
      }
      try {
        return await fetchArtifact(args, options, activeRequestSignal(extra.signal));
      } finally {
        release();
      }
    },
  );
}
