import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
const commit = process.env.SOURCE_SHA || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("An exact SOURCE_SHA is required");
const input = JSON.parse(readFileSync("scripts/release-capability-input.json", "utf8"));
for (const field of ["paidContracts", "assetActions", "intentFormats", "workerFormats", "variableEncodings"])
  if (!Array.isArray(input[field])) throw new Error("Capability array required: "+field);
// Encodings of public JSON variables this gateway decodes (config.ts). The
// release engine sends "br-base64" only to a gateway that lists it.
if (!input.variableEncodings.includes("gzip-base64") ||
    input.variableEncodings.some(value => !["gzip-base64", "br-base64"].includes(value)))
  throw new Error("Invalid variable encodings");
// How a provider the manifest does not admit for servicing is sold when the
// manifest carries several of its control profiles (catalog.ts): through the
// profile naming its registration's agent wallet. An image without this field
// is treated as selecting the lowest epoch.
if (input.controlProfileSelection !== "agent-wallet") throw new Error("Invalid control profile selection");
// How hosted providers without a manifest control profile are admitted:
// "database", this image can approve them itself and store the record
// (docs/provider-approvals.md). The live capabilities answer repeats it only
// while HOSTED_PROVIDER_ORIGINS names an origin and says "off" otherwise; the
// release engine stops admitting invited hosted providers into the manifest
// for a gateway whose live answer says "database".
if (input.providerApprovals !== "database") throw new Error("Invalid provider approvals");
for (const [field, id, digest] of [["paidContracts", "skillId", "skillContractHash"], ["assetActions", "actionId", "definitionHash"]]) {
  const seen = new Set();
  for (const row of input[field]) {
    if (!row.serviceSlug || !row[id] || !/^0x[a-f0-9]{64}$/i.test(row[digest] ?? "")) throw new Error("Invalid immutable capability");
    const key = row.serviceSlug+":"+row[id]+":"+row[digest];
    if (seen.has(key)) throw new Error("Duplicate immutable capability");
    seen.add(key);
  }
}
mkdirSync("dist", { recursive: true });
writeFileSync("dist/release-capabilities.json", JSON.stringify({ schemaVersion: 1, role: "gateway", commit,
  paidContracts: input.paidContracts, assetActions: input.assetActions,
  intentFormats: input.intentFormats, workerFormats: input.workerFormats,
  variableEncodings: input.variableEncodings,
  controlProfileSelection: input.controlProfileSelection,
  providerApprovals: input.providerApprovals }, null, 2)+"\n");
