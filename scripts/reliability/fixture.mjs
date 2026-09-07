import { keccak256, toFunctionSelector } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { signEnvelope } from '../../dist/standardRail/signing.js';
import { canonicalHash } from '../../dist/standardRail/canonical.js';

// Public, isolated test identity. Never an operational signer or funded account.
export const testKey = `0x${'11'.repeat(32)}`;
const hash = digit => `0x${digit.repeat(64)}`;
const address = digit => `0x${digit.repeat(40)}`;
export async function startupFixture() {
  const now = Math.floor(Date.now()/1000) - 10;
  const envelope = (artifactType, payload) => signEnvelope({ artifactType,
    schemaVersion: Number(artifactType.match(/V(\d+)$/)[1]), environment: 'testnet', chainId: 84532,
    audience: 'https://gateway.reliability.invalid', signerKeyId: 'reliability-test',
    privateKey: testKey, issuedAt: now, validBefore: now + 7200, payload });
  const usdc = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
  const tokenCode = '0x60016000'; const implementationCode = '0x60026000'; const oracleCode = '0x60036000';
  const domain = '0x71f17a3b2ff373b803d70a5a07c046c1a2bc8e89c09ef722fcb047abe94c9818';
  const facilitatorProfile = await envelope('FacilitatorProfileV1', {
    profileEpoch:'1', profileId:'reliability-v1', baseUrl:'https://facilitator.reliability.invalid',
    scheme:'exact', network:'eip155:84532', asset:usdc, assetTransferMethod:'eip3009',
    authenticationMethod:'cdp-jwt-v1', credentialPolicyHash:hash('1'), tlsPolicyHash:hash('1'),
    allowedExtensionSetHash:hash('1'), settlementCalldataPolicyHash:hash('1'), verifyTimeout:1000,
    settleTimeout:1000, responseSchemaHash:hash('1'), screeningPolicyHash:hash('1'), evidenceAdapterHash:hash('1'),
    activatedAt:now, admissionValidBefore:now+3600, recoveryValidBefore:now+7200 });
  const railCapabilityRequirements = await envelope('RailCapabilityRequirementsV1', {
    requirementId:'reliability-v1', scheme:'exact', network:'eip155:84532', asset:usdc,
    assetTransferMethod:'eip3009', authenticatedResponseEvidence:'cdp-jwt-v1',
    screeningCoverage:'gateway-and-facilitator-v1', calldataSemantics:'transferWithAuthorization-v1', allowedExtensionSetHash:hash('1') });
  const activeRailProfile = await envelope('ActiveRailProfileV1', { railEpoch:'1',
    facilitatorProfileHash:canonicalHash(facilitatorProfile), priorRailEpoch:'0', priorActiveRailProfileHash:hash('0'),
    environment:'testnet', chainId:84532, activatedAt:now, admissionValidBefore:now+3600, recoveryValidBefore:now+7200 });
  const chainEvidencePolicy = await envelope('ChainEvidencePolicyV2', { policyId:'reliability-v1', canonicalToken:usdc,
    canonicalTokenRuntimeCodeHash:keccak256(tokenCode), tokenImplementationAddress:address('7'),
    tokenImplementationRuntimeCodeHash:keccak256(implementationCode), tokenImplementationSlot:hash('6'),
    tokenDomainSeparator:domain, maximumSourceLagBlocks:10, finalityBlockTimeSeconds:2, maximumLogPageEvents:1000 });
  const control = await envelope('ProviderControlProfileV1', { providerAgentId:'1', providerAudience:'https://provider.reliability.invalid/',
    origin:'https://provider.reliability.invalid', quoteUrl:'https://provider.reliability.invalid/quote',
    dispatchUrl:'https://provider.reliability.invalid/dispatch', dispatchStatusUrl:'https://provider.reliability.invalid/status',
    lifecycleUrl:'https://provider.reliability.invalid/lifecycle', assetQueryUrl:'https://provider.reliability.invalid/assets',
    assetActionUrl:'https://provider.reliability.invalid/actions', assetResponseKeyId:'provider-wallet',
    assetResponseKey:privateKeyToAccount(testKey).address, servicingProfileEpoch:1,
    tlsPolicy:'webpki-v1', workloadAuthentication:'signed-envelopes-v1', maxResponseBytes:100000, timeoutMs:1000 });
  const catalog = await envelope('ProviderAssetActionCatalogV1', { providerAgentId:'1', providerControlProfileHash:canonicalHash(control),
    servicingProfileEpoch:1, actionCatalogSchemaHash:hash('3'), actionCatalogEpoch:1, actions:[] });
  const admission = await envelope('ProviderServicingAdmissionV1', { providerAgentId:'1',
    providerControlProfileHash:canonicalHash(control), actionCatalogHash:canonicalHash(catalog),
    actionCatalogSchemaHash:hash('3'), servicingProfileEpoch:1, actionCatalogEpoch:1,
    servicingEnabled:true, validFrom:now, validBefore:now+7200, previousAdmissionHash:hash('0') });
  return { schemaVersion:1, fixtureVersion:1, manifest: { facilitatorProfile, railCapabilityRequirements,
    activeRailProfile, chainEvidencePolicy, servicingAdmissions:[admission], actionCatalogs:[catalog], providerControlProfiles:[control] },
    priorState:[{admission,current:true}], expectedCurrent:[{providerAgentId:'1',admissionHash:canonicalHash(admission)}],
    trustedSigners:{'reliability-test':privateKeyToAccount(testKey).address},
    rpcFacts:{schemaVersion:1, blockNumber:'0x64', code:{[usdc]:tokenCode,[address('7')]:implementationCode,[address('8')]:oracleCode},
      storage:{[`${usdc}:${hash('6')}`]:`0x${'0'.repeat(24)}${address('7').slice(2)}`},
      calls:{[`${usdc}:${toFunctionSelector('DOMAIN_SEPARATOR()')}`]:domain,
        [`${address('9')}:${toFunctionSelector('getRecordCount()')}`]:hash('0')},
      screeningOracle:address('8'), screeningCodeHash:keccak256(oracleCode) } };
}
export async function conflictingCatalogFixture(input) {
  const next = JSON.parse(JSON.stringify(input));
  const resign = async item => signEnvelope({...item, privateKey:testKey});
  next.manifest.actionCatalogs[0].payload.actionCatalogEpoch += 1;
  next.manifest.actionCatalogs[0] = await resign(next.manifest.actionCatalogs[0]);
  next.manifest.servicingAdmissions[0].payload.actionCatalogEpoch += 1;
  next.manifest.servicingAdmissions[0].payload.actionCatalogHash = canonicalHash(next.manifest.actionCatalogs[0]);
  next.manifest.servicingAdmissions[0] = await resign(next.manifest.servicingAdmissions[0]);
  next.expectedCurrent[0].admissionHash = canonicalHash(next.manifest.servicingAdmissions[0]);
  return next;
}

export async function advancedCatalogFixture(input) {
  const next=await conflictingCatalogFixture(input);
  const resign=async item=>signEnvelope({...item,privateKey:testKey});
  const profile=next.manifest.providerControlProfiles[0]; profile.payload.servicingProfileEpoch+=1;
  next.manifest.providerControlProfiles[0]=await resign(profile);
  const catalog=next.manifest.actionCatalogs[0]; catalog.payload.servicingProfileEpoch+=1;
  catalog.payload.providerControlProfileHash=canonicalHash(next.manifest.providerControlProfiles[0]);
  next.manifest.actionCatalogs[0]=await resign(catalog);
  const admission=next.manifest.servicingAdmissions[0]; admission.payload.servicingProfileEpoch+=1;
  admission.payload.previousAdmissionHash=canonicalHash(input.priorState.find(row=>row.current).admission);
  admission.payload.providerControlProfileHash=canonicalHash(next.manifest.providerControlProfiles[0]);
  admission.payload.actionCatalogHash=canonicalHash(next.manifest.actionCatalogs[0]);
  next.manifest.servicingAdmissions[0]=await resign(admission);
  next.expectedCurrent[0].admissionHash=canonicalHash(next.manifest.servicingAdmissions[0]);
  return next;
}
