import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {keccak256} from 'viem';
import {baseSepolia} from 'viem/chains';
import {createPool,runMigrations} from '../../dist/db/pool.js';
import {StandardRailStore} from '../../dist/standardRail/store.js';
import {StandardRailJournal} from '../../dist/standardRail/journal.js';
import {StandardReputationWorker} from '../../dist/standardRail/reputationWorker.js';
import {encodeReputationOperation} from '../../dist/standardRail/reputationOperation.js';
import {encryptPaymentPayload} from '../../dist/standardRail/secrets.js';
import {ReleaseSales} from '../../dist/standardRail/releaseSales.js';
import {canonicalHash} from '../../dist/standardRail/canonical.js';
import {signEnvelope} from '../../dist/standardRail/signing.js';
import {root,verifyBuildIdentity} from '../build-identity.mjs';
const hash=n=>'0x'+n.repeat(64),address=n=>'0x'+n.repeat(40);
const digest=value=>'sha256:'+createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key='0x'+'11'.repeat(32);
const baseFormats=['standard-orders-v1','dispatch-journal-v2','review-journal-v1'];
export async function proveStateCompatibility({priorRoot,databaseUrl}) {
  const url=new URL(databaseUrl);
  assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname),'disposable loopback database required');
  const identity=verifyBuildIdentity();
  const environment={...process.env};delete environment.SOURCE_SHA;
  const prior=resolve(priorRoot);
  const fallbackIdentity=JSON.parse(execFileSync(process.execPath,[join(prior,'scripts/build-identity.mjs'),'--verify'],
    {cwd:prior,env:environment,encoding:'utf8'}));
  const selfRuntime=identity.sourceSha===fallbackIdentity.sourceSha;
  if(selfRuntime) for(const field of ['sourceHash','buildHash','lockHash']) assert.equal(identity[field],fallbackIdentity[field],'same commit has different '+field);
  const candidateManifestBytes=readFileSync(join(root,'dist/release-capabilities.json'));
  const fallbackManifestBytes=readFileSync(join(prior,'dist/release-capabilities.json'));
  const candidateManifest=JSON.parse(candidateManifestBytes),fallbackManifest=JSON.parse(fallbackManifestBytes);
  for(const format of baseFormats) {
    assert.ok(candidateManifest.workerFormats.includes(format),'candidate omits '+format);
    assert.ok(fallbackManifest.workerFormats.includes(format),'fallback omits '+format);
  }
  const load=path=>import(pathToFileURL(join(prior,'dist/standardRail',path+'.js')).href);
  const PriorStore=(await load('store')).StandardRailStore,PriorJournal=(await load('journal')).StandardRailJournal;
  const PriorWorker=(await load('reputationWorker')).StandardReputationWorker;
  const schema='state_compat_'+randomUUID().replaceAll('-','');
  const admin=createPool({connectionString:databaseUrl,max:1});
  await admin.query('CREATE SCHEMA "'+schema+'"');
  const pool=createPool({connectionString:databaseUrl,searchPath:schema+',public',max:4});
  const observations={},covered=[...baseFormats];
  try {
    await runMigrations(pool);
    const orderId='state-order';
    await pool.query(`INSERT INTO standard_orders
      (order_id,order_key,order_handle,handle_hash,state,provider_agent_id,outcome_id,binding_profile,
       listing_manifest_hash,provider_offer_hash,canonical_listing,quote_hash,canonical_quote,
       canonical_request_hash,canonical_request,order_nonce,intent_id,gross_amount,rail_epoch,listing_epoch,expires_at)
      VALUES($1,$2,$1,$2,'CHALLENGE_ISSUED','7','outcome','recipe-bound-v2',$3,$2,$4,$2,'{}',$2,'{}',$2,$5,100,1,1,now()+interval '1 hour')`,
      [orderId,Buffer.alloc(32,0x11),Buffer.alloc(32,0x33),{commitment:{payload:{serviceId:hash('a')}}},'int_'+randomUUID()]);
    const payment={fixture:'state-compatibility',authorization:{nonce:hash('9'),validBefore:Math.floor(Date.now()/1000)+3600}};
    const encryptionKey=Buffer.alloc(32,1),payload=encryptPaymentPayload(encryptionKey,payment);
    const candidateStore=new StandardRailStore(pool),candidateJournal=new StandardRailJournal(pool);
    await candidateStore.claimAuthorization({orderId,expectedVersion:0,authorizationKey:hash('9'),payer:address('2'),
      encryptedPayload:payload,paymentPayloadHash:canonicalHash(payment),facilitatorProfileHash:hash('8'),capacityLimit:10});
    await candidateJournal.markVerifyInvoked(orderId);await candidateJournal.recordVerify(orderId,hash('7'),true);
    const priorStore=new PriorStore(pool),priorJournal=new PriorJournal(pool);
    const before=await priorStore.findById(orderId);
    assert.equal(before.authorizationKey,hash('9'));assert.deepEqual(before.encryptedPaymentPayload,payload);
    assert.deepEqual(await priorJournal.verifyRecord(orderId),{valid:true});
    assert.equal(await priorJournal.markSettleInvoked(orderId),true);
    assert.equal(await priorJournal.markSettleInvoked(orderId),false);
    const after=await priorStore.findById(orderId);
    assert.equal(after.orderId,before.orderId);assert.equal(after.authorizationKey,before.authorizationKey);
    const attempt=(await pool.query('SELECT attempt_id,facilitator_profile_hash,settle_invoked_at FROM standard_settlement_attempts WHERE order_id=$1',[orderId])).rows[0];
    assert.ok(attempt.settle_invoked_at);observations['standard-orders-v1']=digest({orderId,authorizationKey:after.authorizationKey,attemptId:attempt.attempt_id,payloadHash:after.paymentPayloadHash});

    // Candidate serializer and actual prior parser/claim resolver share the
    // original nonce and canonical dispatch. No provider request is made.
    const now=Math.floor(Date.now()/1000),p={
      environment:'testnet',chainId:84532,gatewayAudience:'https://gateway.invalid',providerAudience:'https://provider.invalid',
      providerControlProfileHash:hash('1'),orderId,orderKey:after.orderKey,serviceId:hash('a'),reputationEligible:false,
      reputationContract:address('6'),outcomeSchemaUid:hash('9'),dispatchNonce:hash('4'),payer:address('2'),
      listingManifestHash:after.listingManifestHash,providerOfferHash:after.providerOfferHash,quoteHash:after.quoteHash,bindingProfile:'recipe-bound-v2',
      canonicalRequestHash:after.canonicalRequestHash,orderNonce:after.orderNonce,buyerIdentityProofHash:hash('0'),activeRailProfileHash:hash('1'),
      facilitatorConfirmationHash:hash('2'),settlementTxHash:hash('a'),depositBlockNumber:'101',depositBlockHash:hash('b'),
      depositTransactionIndex:2,depositLogIndex:3,depositEvidenceHash:hash('c'),releaseTxHash:hash('d'),releaseBlockNumber:'102',
      releaseBlockHash:hash('e'),releaseTransactionIndex:4,releaseLogIndex:5,releaseSequence:'8',releaseEvidenceHash:hash('f'),
      grossAmount:'100',providerNetAmount:'90',daskiCommissionAmount:'10',canonicalProviderRequestHash:canonicalHash({fixture:true}),
      dispatchDeadlineSeconds:300,issuedAt:now,validBefore:now+300};
    const dispatch=await signEnvelope({artifactType:'StandardRailDispatchV2',schemaVersion:2,environment:'testnet',chainId:84532,
      audience:p.providerAudience,signerKeyId:'fixture',privateKey:key,issuedAt:now,validBefore:now+300,payload:p});
    const dispatchHash=canonicalHash(dispatch);
    assert.equal(await candidateJournal.claimDispatch({orderId,nonce:p.dispatchNonce,dispatchHash,requestHash:p.canonicalProviderRequestHash,
      dispatch,request:{fixture:true}}),true);
    const oldDispatch=await priorJournal.dispatchClaim(orderId);
    assert.deepEqual(oldDispatch.dispatch,dispatch);
    await priorJournal.resolveDispatch(orderId,'original-provider-task',hash('3'),dispatchHash);
    assert.ok(await priorJournal.dispatchResolvedAt(orderId));
    const savedDispatch=(await pool.query('SELECT dispatch_nonce,dispatch_hash,provider_task_id FROM standard_dispatch_claims WHERE order_id=$1',[orderId])).rows[0];
    assert.equal('0x'+savedDispatch.dispatch_nonce.toString('hex'),p.dispatchNonce);
    assert.equal('0x'+savedDispatch.dispatch_hash.toString('hex'),dispatchHash);
    observations['dispatch-journal-v2']=digest(savedDispatch);

    // Candidate's real encrypted transaction writer; fallback decrypts and
    // validates the exact chain/destination/calldata/hash before handing bytes
    // to an in-memory transport. No RPC or chain mutation occurs.
    const config={reputationRelayerPrivateKey:key,evidenceRpcUrls:['https://rpc.invalid'],encryptionKey,
      easAddress:'0x4200000000000000000000000000000000000021',reputationConfirmationGasLimit:500000n,
      reputationMaxFeePerGasWei:1000000000n,reputationMaxPriorityFeePerGasWei:1000000n,reputationRetryDelaysSeconds:[1,2,3,4]};
    const intent={operation:'revoke-confirmation',profileId:'eas-native-1.2.0',orderKey:hash('1'),orderId,outcomeId:'outcome',submissionsUsed:1,
      request:{schema:hash('3'),data:{uid:hash('4'),value:'0'},signature:{v:27,r:hash('5'),s:hash('6')},
        revoker:address('2'),deadline:String(now+300)}};
    const operationId=randomUUID(),intentHash=canonicalHash(intent);
    await pool.query(`INSERT INTO standard_reputation_operations(operation_id,order_id,kind,logical_key,intent_hash,canonical_intent,state)
      VALUES($1,$2,'confirmation-v2',$3,$4,$5,'pending')`,[operationId,orderId,Buffer.alloc(32,5),Buffer.from(intentHash.slice(2),'hex'),intent]);
    const operation=(await pool.query('SELECT * FROM standard_reputation_operations WHERE operation_id=$1',[operationId])).rows[0];
    const writer=new StandardReputationWorker(pool,config,baseSepolia);
    writer.highestObservedNonce=async()=>7;
    const client=await pool.connect();let prepared;
    try {await client.query('BEGIN');prepared=await writer.persistPrepared(client,operation,encodeReputationOperation(intent,config));await client.query('COMMIT');}
    catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    const original=(await pool.query('SELECT * FROM standard_reputation_transactions WHERE operation_id=$1',[operationId])).rows[0];
    const reader=new PriorWorker(pool,config,baseSepolia);let broadcasts=0;
    reader.broadcastClient={sendRawTransaction:async({serializedTransaction})=>{broadcasts++;assert.equal(keccak256(serializedTransaction),prepared.transaction_hash);return prepared.transaction_hash;}};
    await reader.sendPersisted(operation,prepared);
    const resumed=(await pool.query('SELECT * FROM standard_reputation_transactions WHERE operation_id=$1',[operationId])).rows;
    assert.equal(broadcasts,1);assert.equal(resumed.length,1);assert.equal(resumed[0].state,'broadcast');
    for(const field of ['transaction_id','nonce','transaction_hash','destination','calldata_hash','encrypted_raw_transaction'])
      assert.deepEqual(resumed[0][field],original[field],field+' changed across fallback');
    observations['review-journal-v1']=digest({operationId,transactionId:original.transaction_id,nonce:original.nonce,transactionHash:original.transaction_hash});

    if(fallbackManifest.workerFormats.includes('standard-settlement-parked-v1')) {
      // A stopped authorization is decoded by the real fallback worker before
      // any facilitator egress, retaining its original encrypted payment.
      await pool.query('UPDATE standard_settlement_attempts SET settle_invoked_at=NULL WHERE order_id=$1',[orderId]);
      const sale=new ReleaseSales(pool);
      await sale.set({providerAgentId:'7',serviceId:hash('a'),listingManifestHash:hash('3'),requestId:'compat-stop',expectedRevision:0,acceptingNewOrders:false});
      const PriorService=(await load('service')).StandardRailService,PriorSales=(await load('releaseSales')).ReleaseSales;
      const worker=Object.create(PriorService.prototype);worker.railConfig={encryptionKey};worker.releaseSales=new PriorSales(pool);
      const parked=await priorStore.findById(orderId);
      assert.equal(await worker.resumePreSettlement(parked,parked.listing),parked);
      assert.deepEqual((await priorStore.findById(orderId)).encryptedPaymentPayload,payload);
      assert.equal(await worker.releaseSales.isParked(orderId),true);
      observations['standard-settlement-parked-v1']=digest({orderId,authorizationKey:parked.authorizationKey,parked:true});
      covered.push('standard-settlement-parked-v1');
    }
    return {schemaVersion:1,service:'daski-gateway',candidateCommit:identity.sourceSha,fallbackCommit:fallbackIdentity.sourceSha,status:'PASS',
      execution:{kind:'disposable-postgresql',network:'controlled-memory',chainId:84532,selfRuntime},
      checks:['candidate-writes-state','fallback-reads-state','fallback-resumes-original-work','immutable-work-identity','supported-worker-formats'],
      workerFormats:covered,testedWorkerFormats:covered,candidateWorkerFormats:candidateManifest.workerFormats,fallbackWorkerFormats:fallbackManifest.workerFormats,
      candidateManifestHash:'sha256:'+createHash('sha256').update(candidateManifestBytes).digest('hex'),fallbackManifestHash:'sha256:'+createHash('sha256').update(fallbackManifestBytes).digest('hex'),observations,
      observationHash:digest(observations)};
  } finally {await pool.end();await admin.query('DROP SCHEMA "'+schema+'" CASCADE');await admin.end();}
}
if(process.argv[1]&&resolve(process.argv[1])===new URL(import.meta.url).pathname){
  const args=process.argv.slice(2),values={};
  for(let i=0;i<args.length;i+=2){assert.ok(['--prior-root','--output'].includes(args[i]));assert.ok(args[i+1]);values[args[i]]=args[i+1];}
  assert.ok(values['--prior-root']&&values['--output'],'--prior-root and --output required');
  const result=await proveStateCompatibility({priorRoot:values['--prior-root'],databaseUrl:process.env.DATABASE_URL_TEST??'postgresql://postgres:password@localhost:5433/daski_gateway_test'});
  writeFileSync(values['--output'],JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({status:result.status,workerFormats:result.workerFormats,observationHash:result.observationHash}));
}
