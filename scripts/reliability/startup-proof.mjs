import assert from 'node:assert/strict';
import { randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { keccak256 } from 'viem';
import { createPool, runMigrations } from '../../dist/db/pool.js';
import { ServiceRegistrationStore } from '../../dist/serviceRegistration/store.js';
import { canonicalHash } from '../../dist/standardRail/canonical.js';
import { root, verifyBuildIdentity, sha256 } from '../build-identity.mjs';
import { writeProof } from '../release-proof.mjs';
import { startupFixture, testKey } from './fixture.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const zip = value => `gzip-base64:${gzipSync(value).toString('base64')}`;
async function unusedPort() {
  const server=createServer(); await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
export async function proveStartup(input, databaseUrl, options={}) {
  const required=['schemaVersion','fixtureVersion','manifest','priorState','expectedCurrent','trustedSigners','rpcFacts'];
  const optional=['migrationThrough','registrations','providerRoutes','runtimeConfig'];
  assert.ok(input && typeof input==='object' && !Array.isArray(input));
  for(const key of required) assert.ok(Object.hasOwn(input,key),`startup input missing ${key}`);
  assert.ok(Object.keys(input).every(key=>[...required,...optional].includes(key)),'unknown startup input field');
  assert.equal(input.schemaVersion,1); assert.equal(input.fixtureVersion,1);
  assert.ok(Array.isArray(input.priorState) && Array.isArray(input.expectedCurrent));
  assert.equal(input.manifest.activeRailProfile.chainId,84532, 'only isolated Testnet shape is supported');
  const database=new URL(databaseUrl);
  assert.ok(['localhost','127.0.0.1','[::1]'].includes(database.hostname),'startup proof requires loopback PostgreSQL');
  const identity=verifyBuildIdentity();
  const nonce=randomUUID().replaceAll('-',''); const name=`gateway_boot_${nonce}`; const runtime=`gateway_runtime_${nonce}`;
  const bootstrap=createPool({connectionString:databaseUrl,max:1});
  let pool; let child; let temporary; let status=null; let output=''; let databaseCreated=false; let roleCreated=false;
  const started=performance.now();
  try {
    await bootstrap.query(`CREATE DATABASE "${name}"`); databaseCreated=true;
    const password=randomBytes(24).toString('hex');
    await bootstrap.query(`CREATE ROLE "${runtime}" LOGIN PASSWORD '${password}'`); roleCreated=true;
    database.pathname=`/${name}`; const migrationUrl=database.href;
    pool=createPool({connectionString:migrationUrl,max:1});
    await runMigrations(pool, input.migrationThrough ? {through:input.migrationThrough} : {});
    for (const {admission,current} of input.priorState) {
      await pool.query(`INSERT INTO standard_provider_servicing_admissions
        (provider_agent_id,admission_hash,profile_hash,canonical_admission,current,valid_before)
        VALUES ($1,$2,$3,$4,$5,to_timestamp($6))`,[admission.payload.providerAgentId,
        Buffer.from(canonicalHash(admission).slice(2),'hex'), Buffer.from(admission.payload.providerControlProfileHash.slice(2),'hex'),
        admission,current,admission.payload.validBefore]);
    }
    if (input.registrations?.length) {
      const store=new ServiceRegistrationStore(pool);
      for (const operation of input.registrations) {
        await store.create(operation.create);
        await store.recordEvidencePending({registrationId:operation.create.prepared.registrationId,evidence:operation.evidence});
        await store.activate(operation.create.prepared.registrationId,operation.commitments,operation.checkpoints ?? []);
      }
    }
    database.username=runtime; database.password=password;
    const port=await unusedPort(); const url=`http://127.0.0.1:${port}`;
    const key=generateKeyPairSync('ed25519').privateKey.export({format:'jwk'});
    const secret=Buffer.concat([Buffer.from(key.d,'base64url'),Buffer.from(key.x,'base64url')]).toString('base64');
    const address=digit => `0x${digit.repeat(40)}`; const hash=digit => `0x${digit.repeat(64)}`;
    const code='0x60046000';
    const publicSettings=['USDC_ADDRESS','USDC_DECIMALS','USDC_NAME','USDC_VERSION','USDC_DOMAIN_SEPARATOR',
      'STANDARD_RAIL_SPLITTER_FACTORY_RUNTIME_CODE_HASH','STANDARD_RAIL_SPLITTER_CREATION_CODE_HASH','STANDARD_RAIL_SPLITTER_CREATION_CODE',
      'STANDARD_RAIL_SPLITTER_FACTORY','STANDARD_RAIL_COMMISSION_RECEIVER','STANDARD_RAIL_COMMISSION_BPS',
      'IDENTITY_REGISTRY_ADDRESS','AGENT_INDEX_ADDRESS','PROVIDER_REGISTRY_ADDRESS','SERVICE_REGISTRY_ADDRESS',
      'VALIDATION_REGISTRY_ADDRESS','REPUTATION_STORAGE_ADDRESS','EAS_ADDRESS','EAS_OUTCOME_SCHEMA_UID','EAS_CONFIRMATION_SCHEMA_UID'];
    for(const [key,value] of Object.entries(input.runtimeConfig ?? {})) {
      assert.ok(publicSettings.includes(key),`unsupported public runtime setting ${key}`); assert.equal(typeof value,'string');
    }
    const env={NODE_ENV:'production',PORT:String(port),TRUST_PROXY:'0',CHAIN_ID:'84532',CHAIN_MODE:'live',
      DATABASE_URL:database.href,MIGRATION_DATABASE_URL:migrationUrl,
      PUBLIC_URL:input.manifest.activeRailProfile.audience,STANDARD_RAIL_GATEWAY_AUDIENCE:input.manifest.activeRailProfile.audience,
      STANDARD_RAIL_ENVIRONMENT:input.manifest.activeRailProfile.environment,
      FACILITATOR_PRIVATE_KEY:testKey,STANDARD_RAIL_ENCRYPTION_KEY:'22'.repeat(32),CDP_API_KEY_ID:'reliability-test',CDP_API_KEY_SECRET:secret,
      CDP_FACILITATOR_BASE_URL:input.manifest.facilitatorProfile.payload.baseUrl,BASE_RPC_URL:'https://rpc.reliability.invalid',
      STANDARD_RAIL_MANIFEST_JSON:zip(JSON.stringify(input.manifest)),STANDARD_RAIL_TRUSTED_SIGNERS_JSON:JSON.stringify(input.trustedSigners),
      STANDARD_RAIL_SPLITTER_FACTORY_RUNTIME_CODE_HASH:hash('1'),STANDARD_RAIL_SPLITTER_CREATION_CODE_HASH:keccak256(code),
      STANDARD_RAIL_SPLITTER_CREATION_CODE:zip(code),STANDARD_RAIL_SPLITTER_FACTORY:address('1'),
      STANDARD_RAIL_COMMISSION_RECEIVER:address('2'),STANDARD_RAIL_COMMISSION_BPS:'250',
      STANDARD_RAIL_SANCTIONS_ORACLE:input.rpcFacts.screeningOracle,
      STANDARD_RAIL_SANCTIONS_ORACLE_RUNTIME_CODE_HASH:input.rpcFacts.screeningCodeHash,
      SANCTIONS_ORACLE_ADDRESS:input.rpcFacts.screeningOracle,SANCTIONS_ORACLE_MODE:'production',
      IDENTITY_REGISTRY_ADDRESS:address('3'),AGENT_INDEX_ADDRESS:address('4'),PROVIDER_REGISTRY_ADDRESS:address('5'),
      SERVICE_REGISTRY_ADDRESS:address('6'),VALIDATION_REGISTRY_ADDRESS:address('a'),REPUTATION_STORAGE_ADDRESS:address('9'),
      EAS_ADDRESS:address('b'),EAS_OUTCOME_SCHEMA_UID:hash('4'),EAS_CONFIRMATION_SCHEMA_UID:hash('5'),
      CATALOG_OPERATOR_TOKEN:'isolated-reliability-token-000000000000000000000',
      DASKI_ISOLATED_STARTUP_PROOF:'1',DASKI_PROOF_FACILITATOR_URL:input.manifest.facilitatorProfile.payload.baseUrl,DASKI_PROOF_PROVIDER_ROUTES:JSON.stringify(input.providerRoutes ?? []),DASKI_PROOF_RPC_FACTS:Buffer.from(JSON.stringify(input.rpcFacts)).toString('base64'),
      SHUTDOWN_GRACE_MS:'5000',...input.runtimeConfig};
    const loader=join(root,'scripts/reliability/controlled-network.mjs');
    let command=process.execPath; let args=['--import',loader,join(root,'dist/index.js')];
    let image=null;
    if(options.image) {
      const details=JSON.parse(execFileSync('docker',['image','inspect',options.image],{encoding:'utf8'}))[0];
      assert.deepEqual(details.Config.Cmd,['node','dist/index.js'],'image must use the declared application entrypoint');
      const expectedRevision=details.Config.Env.find(value => value.startsWith('RELEASE_SOURCE_SHA='))?.split('=')[1];
      assert.equal(expectedRevision,identity.sourceSha,'image source revision differs from candidate');
      const imageIdentity=JSON.parse(execFileSync('docker',['run','--rm','--network','none','--read-only','--entrypoint','node',options.image,'-e',"process.stdout.write(require('node:fs').readFileSync('/app/dist/build-identity.json','utf8'))"],{encoding:'utf8'}));
      for(const key of ['sourceSha','sourceHash','lockHash','buildHash','buildDefinitionHash']) assert.equal(imageIdentity[key],identity[key],`image ${key} differs from candidate`);
      image={id:details.Id,sourceSha:expectedRevision,dockerfileHash:identity.buildDefinitionHash,identity:imageIdentity};
      let network=['--network','host'];
      if(options.imageDbContainer) {
        const databaseContainer=JSON.parse(execFileSync('docker',['inspect',options.imageDbContainer],{encoding:'utf8'}))[0];
        const published=databaseContainer.NetworkSettings.Ports['5432/tcp'] ?? [];
        const connection=new URL(databaseUrl);
        assert.ok(published.some(binding=>['127.0.0.1','::1'].includes(binding.HostIp) && binding.HostPort===connection.port),
          'database container must publish the supplied loopback PostgreSQL port');
        const ip=Object.values(databaseContainer.NetworkSettings.Networks).map(network=>network.IPAddress).find(Boolean);
        assert.ok(ip && /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(ip),'database container must have a private bridge IP');
        for(const key of ['DATABASE_URL','MIGRATION_DATABASE_URL']) {
          const value=new URL(env[key]); assert.equal(value.pathname,`/${name}`);
          value.hostname=ip; value.port='5432'; env[key]=value.href;
        }
        network=['--network','bridge','--publish',`127.0.0.1:${port}:${port}`];
      }
      temporary=mkdtempSync(join(tmpdir(),'gateway-boot-')); const envFile=join(temporary,'environment');
      writeFileSync(envFile,Object.entries(env).map(([key,value]) => `${key}=${value}`).join('\n'),{mode:0o600});
      command='docker'; args=['run','--rm','--name',`gateway-proof-${nonce}`,...network,'--read-only','--tmpfs','/tmp',
        '--env-file',envFile,'--mount',`type=bind,source=${loader},target=/proof/controlled-network.mjs,readonly`,
        options.image,'node','--import','/proof/controlled-network.mjs','dist/index.js'];
    }
    child=spawn(command,args,{cwd:root,env:options.image ? process.env : {...env,PATH:process.env.PATH},stdio:['ignore','pipe','pipe']});
    child.on('exit',(code,signal)=>{status={code,signal};});
    const capture=data=>{output=(output+String(data)).slice(-64000);}; child.stdout.on('data',capture); child.stderr.on('data',capture);
    child.on('error',error=>{status={code:1,error:error.message};});
    let ready=false;
    for(let attempt=0;attempt<200;attempt++) {
      if(status) break;
      try { const response=await fetch(`${url}/health/ready`,{signal:AbortSignal.timeout(300)}); if(response.ok) {ready=true;break;} }
      catch { /* bounded readiness polling */ }
      await delay(100);
    }
    if(!ready) {
      const known=['Servicing admission epoch conflicts with the activated admission','Servicing admission chain is invalid',
        'Current servicing admission is absent from the marketplace manifest','Servicing admission does not bind an active control profile and action catalog',
        'Canonical-token code, implementation, or EIP-712 domain changed','Selected facilitator does not advertise',
        'Standard-rail manifest does not match this runtime','fatal startup failure'];
      const reason=known.find(message=>output.includes(message)) ?? `startup did not become ready (${status?.code ?? 'timeout'})`;
      if(options.debug) options.debug(output); // local diagnostic callback only; never included in proof
      throw new Error(reason);
    }
    assert.equal((await fetch(`${url}/health/live`)).status,200);
    const current=(await pool.query(`SELECT provider_agent_id AS "providerAgentId",'0x'||encode(admission_hash,'hex') AS "admissionHash"
      FROM standard_provider_servicing_admissions WHERE current ORDER BY provider_agent_id`)).rows;
    assert.deepEqual(current,[...input.expectedCurrent].sort((a,b)=>a.providerAgentId.localeCompare(b.providerAgentId)));
    const probe=options.probe ? await options.probe({url,databaseUrl:migrationUrl}) : null;
    return {schemaVersion:1,repo:'gateway',boundary:'gateway-startup',status:'PASS',identity,
      inputHash:sha256(JSON.stringify(input)),startingStateHash:sha256(JSON.stringify(input.priorState)),
      execution:{entrypoint:'dist/index.js',mode:options.image?'dockerfile-image':'compiled-runtime',image,
        durationMs:Math.round(performance.now()-started)},
      checks:['actual-entrypoint','signed-manifest-validation','migrations-and-distinct-database-roles',
        'existing-admission-state','health-live','health-ready','expected-current-admissions',...(probe?['candidate-probe']:[])],probe};
  } finally {
    if(options.image && child) {
      try { execFileSync('docker',['stop','--time','5',`gateway-proof-${nonce}`],{stdio:'ignore'}); } catch {}
    } else if(child && !status) child.kill('SIGTERM');
    if(child && !status) {for(let i=0;i<60 && !status;i++) await delay(100); if(!status) child.kill('SIGKILL');}
    if(temporary) rmSync(temporary,{recursive:true,force:true});
    await pool?.end();
    if(databaseCreated) await bootstrap.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    if(roleCreated) await bootstrap.query(`DROP ROLE "${runtime}"`);
    await bootstrap.end();
  }
}
async function main() {
  const args=process.argv.slice(2); const values={};
  for(let i=0;i<args.length;i+=2) {assert.ok(['--input','--output','--evidence','--image','--image-db-container','--probe-command'].includes(args[i])); values[args[i]]=args[i+1];}
  const input=values['--input'] ? JSON.parse(readFileSync(values['--input'],'utf8')) : await startupFixture();
  const output=values['--output'] ?? values['--evidence']; assert.ok(output,'--output is required');
  try {
    const proof=await proveStartup(input,process.env.DATABASE_URL_TEST,{image:values['--image'],imageDbContainer:values['--image-db-container'],
      ...(values['--probe-command'] ? {probe:async({url})=>{
        const argv=JSON.parse(values['--probe-command']).map(value=>value.replaceAll('{gatewayUrl}',url));
        execFileSync(argv[0],argv.slice(1),{stdio:['ignore','pipe','pipe'],timeout:120000});
        return {entrypoint:argv[0],commandHash:sha256(JSON.stringify(argv)),status:'PASS'};
      }} : {})});
    writeProof(output,proof);
  } catch(error) {writeProof(output,{schemaVersion:1,repo:'gateway',boundary:'gateway-startup',status:'FAIL',
    inputHash:sha256(JSON.stringify(input)),error:error.message.replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[database]')}); process.exitCode=1;}
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) await main();
