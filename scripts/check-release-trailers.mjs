#!/usr/bin/env node
// Release hand-off lint: every commit in a range may carry Release-* git
// trailers that the deploy-testnet coordinator executes. This script proves
// they are well formed, carry no secrets, and that a variable added to
// .env.example is declared. Dependency-free; runs in CI on every push.
// This file is copied verbatim into each sibling repository as
// scripts/check-release-trailers.mjs; the coordinator imports it here.
//
//   node scripts/check-release-trailers.mjs --range <base>..<head> [--env-example .env.example]
//
// Exit 0 when every commit passes, 1 on a finding, 2 on a usage error.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

export const SERVICES = new Set(["gateway", "provider", "daski-website", "none"]);
export const RULES = {
  "Release-Variable": /^(gateway|provider|daski-website|none) ([A-Z][A-Z0-9_]*)(?:=(\S+))?(?: (before-deploy|after-deploy))?$/,
  "Release-Requires": /^(new-epoch|reregister:[a-z0-9-]+|contract-upgrade)$/,
  "Release-Scenarios": /^[a-z0-9-]+(, ?[a-z0-9-]+)*$/,
  "Release-Owner-Task": /^\S.{9,199}$/,
  "Release-Rollback": /^\S.{9,199}$/,
};
const SECRET = /(0x[0-9a-fA-F]{64}|[A-Za-z0-9+/]{40,}={0,2}|:\/\/[^/\s]+:[^/\s]+@|-----BEGIN)/;

function git(args, input, cwd) {
  return execFileSync("git", args, { encoding: "utf8", input, cwd, stdio: ["pipe", "pipe", "pipe"] });
}

export function parseTrailers(message, { cwd } = {}) {
  const parsed = git(["interpret-trailers", "--parse"], message, cwd);
  return parsed.split("\n").filter(Boolean).map(line => {
    const i = line.indexOf(":");
    return { key: line.slice(0, i).trim(), value: line.slice(i + 1).trim() };
  }).filter(t => t.key.startsWith("Release-"));
}

export function checkTrailers(trailers, { sha = "commit" } = {}) {
  const findings = [];
  for (const { key, value } of trailers) {
    const rule = RULES[key];
    if (!rule) { findings.push(`${sha}: unknown trailer ${key}; use ${Object.keys(RULES).join(", ")}`); continue; }
    if (!rule.test(value)) { findings.push(`${sha}: ${key} is malformed: "${value}"`); continue; }
    if (SECRET.test(value)) findings.push(`${sha}: ${key} looks like it carries a secret; use the value "staged" and set it on Railway`);
    if (key === "Release-Variable") {
      const [, service, name, value2, when] = rule.exec(value);
      if (service !== "none" && (!value2 || !when)) findings.push(`${sha}: Release-Variable for ${service} needs NAME=value and before-deploy|after-deploy (${name})`);
      if (service === "none" && (value2 || when)) findings.push(`${sha}: Release-Variable none ${name} takes no value or timing`);
    }
  }
  return findings;
}

export function declaredVariables(trailers) {
  const names = new Set();
  for (const { key, value } of trailers) {
    if (key !== "Release-Variable") continue;
    const match = RULES[key].exec(value);
    if (match) names.add(match[2]);
  }
  return names;
}

export function addedEnvKeys(diffText) {
  const keys = new Set();
  for (const line of diffText.split("\n")) {
    const match = /^\+([A-Z][A-Z0-9_]*)=/.exec(line);
    if (match) keys.add(match[1]);
  }
  return keys;
}

export function lintRange(range, { cwd, envExample = ".env.example" } = {}) {
  const shas = git(["rev-list", "--reverse", range], undefined, cwd).split("\n").filter(Boolean);
  const findings = [];
  const declared = new Set();
  for (const sha of shas) {
    const trailers = parseTrailers(git(["show", "-s", "--format=%B", sha], undefined, cwd), { cwd });
    findings.push(...checkTrailers(trailers, { sha: sha.slice(0, 7) }));
    for (const name of declaredVariables(trailers)) declared.add(name);
  }
  const examplePath = cwd ? cwd + "/" + envExample : envExample;
  if (existsSync(examplePath)) {
    const [base, head = "HEAD"] = range.split("..");
    let diff = "";
    try { diff = git(["diff", base + ".." + head, "--", envExample], undefined, cwd); } catch { diff = ""; }
    for (const key of addedEnvKeys(diff)) {
      if (!declared.has(key)) findings.push(`${envExample} adds ${key} but no commit in ${range} carries "Release-Variable: <service> ${key}=<value|staged> <before-deploy|after-deploy>" (or "Release-Variable: none ${key}" when no deployment change is needed)`);
    }
  }
  return { commits: shas.length, declared: [...declared], findings };
}

function main() {
  const args = process.argv.slice(2);
  const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const range = opt("--range");
  if (!range || !range.includes("..")) { console.error("usage: check-release-trailers.mjs --range <base>..<head> [--env-example FILE]"); process.exit(2); }
  const result = lintRange(range, { envExample: opt("--env-example") ?? ".env.example" });
  if (result.findings.length) { console.error(result.findings.join("\n")); process.exit(1); }
  console.log(`release trailers: ${result.commits} commit(s) in ${range} checked, ${result.declared.length} variable(s) declared`);
}

if (process.argv[1] && /check-release-trailers\.mjs$|release-trailers\.mjs$/.test(process.argv[1])) main();
