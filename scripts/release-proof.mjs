import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPool, runMigrations } from '../dist/db/pool.js';
import { StandardAssetFederation } from '../dist/standardRail/assetFederation.js';
import { canonicalHash } from '../dist/standardRail/canonical.js';
import { verifyBuildIdentity, sha256 } from './build-identity.mjs';

function closed(value, keys, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} fields mismatch`);
}
export function validateInput(input) {
  closed(input, ['schemaVersion', 'priorState', 'candidateAdmissions', 'expectedCurrent'], 'gateway admission input');
  assert.equal(input.schemaVersion, 1);
  assert.ok(Array.isArray(input.priorState));
  assert.ok(Array.isArray(input.candidateAdmissions) && input.candidateAdmissions.length > 0);
  assert.ok(Array.isArray(input.expectedCurrent) && input.expectedCurrent.length > 0);
  for (const row of input.priorState) {
    closed(row, ['admission', 'current'], 'prior admission');
    assert.equal(typeof row.current, 'boolean');
  }
  const providers = new Set();
  for (const row of input.expectedCurrent) {
    closed(row, ['providerAgentId', 'admissionHash'], 'expected current admission');
    assert.match(row.providerAgentId, /^[1-9]\d*$/);
    assert.match(row.admissionHash, /^0x[0-9a-f]{64}$/);
    assert.ok(!providers.has(row.providerAgentId), 'duplicate expected provider');
    providers.add(row.providerAgentId);
  }
}
export async function proveAdmissions(input, databaseUrl) {
  validateInput(input);
  // Only disposable local databases are permitted. There is no option to
  // reuse a caller-selected schema or mutate live admission state.
  const database = new URL(databaseUrl);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname), 'proof requires loopback PostgreSQL');
  assert.ok(['postgres:', 'postgresql:'].includes(database.protocol));
  const identity = verifyBuildIdentity();
  const schema = `gateway_proof_${randomUUID().replaceAll('-', '')}`;
  const bootstrap = createPool({ connectionString: databaseUrl, max: 1 });
  let pool;
  const start = performance.now();
  try {
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    pool = createPool({ connectionString: databaseUrl, searchPath: `${schema},public`, max: 2 });
    await runMigrations(pool);
    for (const { admission, current } of input.priorState) {
      await pool.query(`INSERT INTO standard_provider_servicing_admissions
        (provider_agent_id,admission_hash,profile_hash,canonical_admission,current,valid_before)
        VALUES ($1,$2,$3,$4,$5,to_timestamp($6))`, [admission.payload.providerAgentId,
        Buffer.from(canonicalHash(admission).slice(2), 'hex'),
        Buffer.from(admission.payload.providerControlProfileHash.slice(2), 'hex'),
        admission, current, admission.payload.validBefore]);
    }
    const federation = new StandardAssetFederation(pool,
      { manifest: { servicingAdmissions: input.candidateAdmissions } }, 84532, {},
      () => { throw new Error('Admission proof must not dispatch network requests'); });
    await federation.activateAdmissions();
    const current = await pool.query(`SELECT provider_agent_id AS "providerAgentId",
      '0x' || encode(admission_hash,'hex') AS "admissionHash"
      FROM standard_provider_servicing_admissions WHERE current ORDER BY provider_agent_id`);
    const expected = [...input.expectedCurrent].sort((a,b) => a.providerAgentId.localeCompare(b.providerAgentId));
    assert.deepEqual(current.rows, expected, 'activated admissions differ from the planned outcome');
    // A replay must be stable and must not duplicate or overwrite history.
    const count = await pool.query('SELECT count(*)::int AS count FROM standard_provider_servicing_admissions');
    await federation.activateAdmissions();
    assert.deepEqual((await pool.query('SELECT count(*)::int AS count FROM standard_provider_servicing_admissions')).rows, count.rows);
    return { schemaVersion: 1, repo: 'gateway', boundary: 'gateway-admission', status: 'PASS',
      execution: { entrypoint: 'dist/standardRail/assetFederation.js#StandardAssetFederation.activateAdmissions',
        database: 'disposable-postgresql-schema', durationMs: Math.round(performance.now() - start), migrations: 'complete' },
      identity, inputHash: sha256(JSON.stringify(input)), startingStateHash: sha256(JSON.stringify(input.priorState)),
      checks: ['actual-migrations', 'actual-admission-transaction', 'expected-current-admissions', 'idempotent-replay'],
      current: current.rows };
  } finally {
    await pool?.end();
    await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await bootstrap.end();
  }
}
export function writeProof(path, proof) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, path);
}
async function main() {
  const args = process.argv.slice(2);
  assert.equal(args.length, 4, 'usage: release-proof.mjs --input file.json --output proof.json');
  assert.equal(args[0], '--input'); assert.equal(args[2], '--output');
  const input = JSON.parse(readFileSync(args[1], 'utf8'));
  try { writeProof(args[3], await proveAdmissions(input, process.env.DATABASE_URL_TEST)); }
  catch (error) {
    writeProof(args[3], { schemaVersion: 1, repo: 'gateway', boundary: 'gateway-admission', status: 'FAIL',
      inputHash: sha256(JSON.stringify(input)), error: error instanceof Error ? error.message.replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[database]') : 'proof failed' });
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
