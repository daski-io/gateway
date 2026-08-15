import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { loadConfig } from "../config.js";
import { createPool } from "../db/pool.js";
import type { Hex } from "../types.js";
import { verifyStandardRailManifest } from "./artifacts.js";
import { canonicalHash } from "./canonical.js";
import { loadStandardRailConfig } from "./config.js";
import { approveStandardCutover, inspectStandardCutover } from "./cutover.js";
import { verifyRuntimeIntegrity } from "./runtimeIntegrity.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function hex32(name: string, value: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${name} must be a 32-byte hex value`);
  return value.toLowerCase() as Hex;
}

async function fileSha256(file: string): Promise<Hex> {
  if (!(await stat(file)).isFile()) throw new Error("STANDARD_RAIL_CUTOVER_ARCHIVE_PATH is not a file");
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return `0x${digest.digest("hex")}`;
}

async function main(): Promise<void> {
  const appConfig = loadConfig();
  const standardConfig = loadStandardRailConfig();
  await verifyStandardRailManifest(standardConfig.manifest, {
    environment: standardConfig.environment,
    chainId: appConfig.chainId,
    gatewayAudience: standardConfig.gatewayAudience,
    signers: standardConfig.trustedSigners,
    marketplaceCommissionBps: standardConfig.marketplaceCommissionBps,
    launchOutcomeIds: standardConfig.launchOutcomeIds,
    reviewedListings: standardConfig.reviewedListings,
  });
  await verifyRuntimeIntegrity(appConfig, standardConfig);
  const archiveSha256 = hex32(
    "STANDARD_RAIL_CUTOVER_ARCHIVE_SHA256",
    required("STANDARD_RAIL_CUTOVER_ARCHIVE_SHA256"),
  );
  const actualArchiveSha256 = await fileSha256(required("STANDARD_RAIL_CUTOVER_ARCHIVE_PATH"));
  if (archiveSha256 !== actualArchiveSha256) throw new Error("Cutover archive SHA-256 mismatch");
  const identity = {
    environment: standardConfig.environment,
    chainId: appConfig.chainId,
    releaseCommit: standardConfig.releaseCommit,
    manifestHash: canonicalHash(standardConfig.manifest),
  };
  const pool = createPool({ connectionString: standardConfig.migrationDatabaseUrl, max: 1 });
  try {
    const before = await inspectStandardCutover(pool, identity);
    process.stdout.write(`${JSON.stringify({
      mode: process.argv.includes("--apply") ? "apply" : "dry-run",
      ...before,
    })}\n`);
    if (!process.argv.includes("--apply")) return;
    await approveStandardCutover(pool, identity, archiveSha256);
    process.stdout.write(`${JSON.stringify({ approved: true, manifestHash: identity.manifestHash })}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "cutover failed"}\n`);
  process.exitCode = 1;
});
