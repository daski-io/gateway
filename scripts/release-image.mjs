import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { relative, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
export const hash = bytes => "sha256:" + createHash("sha256").update(bytes).digest("hex");
export function treeIdentity(root, paths) {
  const files = [];
  const visit = path => {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push({ path: relative(root, full).replaceAll("\\", "/"), sha256: hash(readFileSync(full)) });
      else throw new Error("Release inputs must not contain symlinks");
    }
  };
  for (const name of paths) {
    const path = resolve(root, name);
    if (!path.startsWith(resolve(root) + "/")) throw new Error("Release input escapes checkout");
    if (!existsSync(path)) continue;
    if (name.endsWith("/")) visit(path);
    else files.push({ path: name, sha256: hash(readFileSync(path)) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { hash: hash(JSON.stringify(files)), files };
}
export function releaseImage({ root = process.cwd(), env = process.env, capabilityFile = "release-capabilities.json" } = {}) {
  const commit = env.GITHUB_SHA ?? env.SOURCE_SHA;
  if (!/^[a-f0-9]{40}$/.test(commit ?? "")) throw new Error("Exact source commit required");
  if (!/^sha256:[a-f0-9]{64}$/.test(env.DIGEST ?? "")) throw new Error("Exact OCI digest required");
  const repository = env.IMAGE;
  if (!/^ghcr\.io\/[a-z0-9][a-z0-9._/-]+$/.test(repository ?? "")) throw new Error("Expected a GHCR repository without tag");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version ?? "")) throw new Error("Source version missing");
  const bytes = readFileSync(join(root, capabilityFile));
  const capabilities = JSON.parse(bytes);
  if (capabilities.schemaVersion !== 1 || capabilities.commit !== commit ||
      !["gateway", "provider", "website"].includes(capabilities.role) ||
      !["paidContracts", "assetActions", "intentFormats", "workerFormats"].every(k => Array.isArray(capabilities[k])))
    throw new Error("Embedded capability manifest does not identify this artifact");
  const fixtures = treeIdentity(root, ["test/wire-fixtures/", "test/fixtures/gateway-wire/"]);
  const configuration = treeIdentity(root, ["Dockerfile", "railway.json", "env.schema.json", "package-lock.json"]);
  const runId = Number(env.GITHUB_RUN_ID), runAttempt = Number(env.GITHUB_RUN_ATTEMPT);
  if (!Number.isSafeInteger(runId) || runId < 1 || !Number.isSafeInteger(runAttempt) || runAttempt < 1 ||
      typeof env.GITHUB_WORKFLOW_REF !== "string" || !env.GITHUB_WORKFLOW_REF.includes("/.github/workflows/release-image.yml@"))
    throw new Error("Trusted workflow identity required");
  return {
    schemaVersion: 1, repo: env.GITHUB_REPOSITORY, commit, sourceSha: commit, version: pkg.version,
    repository, image: repository + "@" + env.DIGEST, digest: env.DIGEST,
    ...(env.DASKI_OCI_METADATA_FILE ? {oci:JSON.parse(readFileSync(env.DASKI_OCI_METADATA_FILE,"utf8"))} : {}),
    capabilities: { hash: hash(bytes), manifest: capabilities }, capabilitiesHash: hash(bytes), fixturesHash: fixtures.hash,
    configurationHash: configuration.hash, configuration, fixtures,
    ci: { workflowRef: env.GITHUB_WORKFLOW_REF, runId, runAttempt, checks: ["image"] },
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  writeFileSync("release-image.json", JSON.stringify(releaseImage({ capabilityFile: process.argv[2] ?? "release-capabilities.json" }), null, 2) + "\n");
