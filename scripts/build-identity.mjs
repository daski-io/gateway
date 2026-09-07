import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const sha256 = value => createHash('sha256').update(value).digest('hex');
function files(path) {
  if (!existsSync(path)) throw new Error(`Build input missing: ${relative(root, path)}`);
  return readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)]);
}
function digest(paths) {
  return sha256(JSON.stringify(paths.map(path => [relative(root, path).replaceAll('\\', '/'), sha256(readFileSync(path))])));
}
export function buildIdentity() {
  const inputs = ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'Dockerfile', 'railway.json']
    .map(path => join(root, path));
  inputs.push(...['src', 'skills', 'scripts'].flatMap(path => files(join(root, path))));
  const outputs = files(join(root, 'dist')).filter(path => path !== join(root, 'dist', 'build-identity.json'));
  let sourceSha = process.env.SOURCE_SHA ?? null;
  if (!sourceSha) {
    try { sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { /* Docker builds identify content even when .git is excluded. */ }
  }
  if (!/^[0-9a-f]{40}$/.test(sourceSha ?? '')) throw new Error('Build requires SOURCE_SHA or a Git checkout');
  return { schemaVersion: 1, repo: 'gateway', sourceSha, sourceHash: digest(inputs),
    lockHash: sha256(readFileSync(join(root, 'package-lock.json'))), buildHash: digest(outputs),
    nodeVersion: process.version, platform: process.platform, architecture: process.arch,
    buildDefinitionHash: sha256(readFileSync(join(root, 'Dockerfile'))) };
}
export function verifyBuildIdentity() {
  const recorded = JSON.parse(readFileSync(join(root, 'dist', 'build-identity.json'), 'utf8'));
  const current = buildIdentity();
  for (const key of ['schemaVersion', 'repo', 'sourceSha', 'sourceHash', 'lockHash', 'buildHash', 'nodeVersion', 'platform', 'architecture', 'buildDefinitionHash']) {
    if (recorded[key] !== current[key]) throw new Error(`Build identity mismatch: ${key}; rebuild the candidate`);
  }
  return recorded;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = process.argv.includes('--verify') ? verifyBuildIdentity() : buildIdentity();
  if (!process.argv.includes('--verify')) writeFileSync(join(root, 'dist', 'build-identity.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
}
