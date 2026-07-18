import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  fetchArtifact,
  type ArtifactFetchOptions,
} from "./artifactFetch.js";

export function registerArtifactTool(
  server: McpServer,
  options: ArtifactFetchOptions,
): void {
  server.registerTool(
    "daski_fetch_artifact",
    {
      description: [
        "Retrieve the actual bytes behind a Daski artifact URL, including audience-bound formation PDFs. This is a two-call wallet-signature flow; do not hand a short-lived artifact URL to the principal as durable proof.",
        "",
        "Inputs:",
        "- First call: `url` from the provider artifact and that artifact's `taskId`; omit `capability`. The taskId is verified against the audience-bound challenge.",
        "- Signed retry: the exact same `url` + `taskId`, plus `capability: { signature, authorization }`. Sign the returned `eip712TypedData` and echo `authorization` verbatim.",
        "- `expectedMimeType` defaults to `application/pdf`; pass the artifact's advertised mimeType for another format.",
        "",
        "Returns:",
        "- First call: `{ requiresSignature, eip712TypedData, authorization, capabilityChallenge }`.",
        "- Signed retry: `{ artifact: { bytesBase64, encoding, mimeType, filename, sizeBytes, sha256 }, delivery }`, capped at 5 MiB and verified against the expected content type — PLUS the document attached to the result as an MCP embedded resource (a real file your client can render/save, not just JSON). `delivery.principalUsable: true` refers to THAT file: hand it (or the decoded bytes) to your principal, then report delivery. Retrieval alone is not delivery — say \"retrieved, not yet handed over\" until you actually have.",
        "- If the challenge expired before the retry, the tool returns a fresh challenge. Sign that new typed-data; do not reuse the expired authorization.",
        "- The challenge is satisfiable ONLY by the buyer wallet that owns the purchase (plus provider-administrator staff tooling). There is no principal-facing browser login for artifact URLs — never hand a raw URL to a principal expecting it to open.",
      ].join("\n"),
      inputSchema: {
        url: z.string().url().describe("Short-lived URL from a Daski artifact."),
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
            "Signed TaskAccessAuthorization from this URL's first-call " +
              "challenge. Echo authorization verbatim.",
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
    (args) => fetchArtifact(args, options),
  );
}
