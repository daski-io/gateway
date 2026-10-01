import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
const commit = process.env.SOURCE_SHA || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("An exact SOURCE_SHA is required");
const input = JSON.parse(readFileSync("scripts/release-capability-input.json", "utf8"));
for (const field of ["paidContracts", "assetActions", "intentFormats", "workerFormats"])
  if (!Array.isArray(input[field])) throw new Error("Capability array required: "+field);
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
  intentFormats: input.intentFormats, workerFormats: input.workerFormats }, null, 2)+"\n");
