import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { releaseImage } from "./release-image.mjs";
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "release-image-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const commit = "a".repeat(40);
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
  writeFileSync(join(root, "release-capabilities.json"), JSON.stringify({ schemaVersion: 1, role: "gateway", commit,
    paidContracts: [], assetActions: [], intentFormats: ["legacy-v0"], workerFormats: ["v1"] }));
  const env = { GITHUB_SHA: commit, IMAGE: "ghcr.io/example/service", DIGEST: "sha256:"+"b".repeat(64),
    GITHUB_REPOSITORY: "example/service", GITHUB_RUN_ID: "12", GITHUB_RUN_ATTEMPT: "1",
    GITHUB_WORKFLOW_REF: "example/service/.github/workflows/release-image.yml@refs/heads/develop" };
  return { root, env };
}
test("immutable manifest binds embedded capabilities, source and actual input bytes", t => {
  const f = fixture(t), a = releaseImage(f);
  assert.equal(a.image, f.env.IMAGE+"@"+f.env.DIGEST);
  assert.equal(a.capabilities.manifest.commit, f.env.GITHUB_SHA);
  assert.equal(a.ci.runId, 12);
  writeFileSync(join(f.root, "Dockerfile"), "changed configuration");
  assert.notEqual(releaseImage(f).configurationHash, a.configurationHash);
});
test("manifest refuses mutable image or capability from another build", t => {
  const f = fixture(t);
  assert.throws(() => releaseImage({ ...f, env: { ...f.env, DIGEST: "latest" } }), /digest/);
  assert.throws(() => releaseImage({ ...f, env: { ...f.env, IMAGE: f.env.IMAGE+":latest" } }), /GHCR/);
  writeFileSync(join(f.root, "release-capabilities.json"), JSON.stringify({ schemaVersion: 1, role: "gateway", commit: "c".repeat(40),
    paidContracts: [], assetActions: [], intentFormats: [], workerFormats: [] }));
  assert.throws(() => releaseImage(f), /capability/);
});
test("manifest cannot self-assert a missing workflow identity", t => {
  const f = fixture(t);
  assert.throws(() => releaseImage({ ...f, env: { ...f.env, GITHUB_RUN_ID: "" } }), /workflow/);
});
