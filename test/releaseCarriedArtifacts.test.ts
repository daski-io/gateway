import { randomUUID } from "node:crypto";
import { createPool, runMigrations } from "../src/db/pool.js";
import { StandardAssetFederation } from "../src/standardRail/assetFederation.js";
import { StandardAssetActions } from "../src/standardRail/assetActions.js";
import { claimAssetAction } from "../src/standardRail/assetActionClaims.js";
import { describe, expect, it } from "vitest";
import { verifyStandardRailManifest } from "../src/standardRail/artifacts.js";
import { canonicalHash } from "../src/standardRail/canonical.js";
import { signEnvelope } from "../src/standardRail/signing.js";
const { startupFixture, advancedCatalogFixture, testKey } =
  await import(new URL("../scripts/reliability/fixture.mjs", import.meta.url).href);

describe("signed carried admission bundles", () => {
  it("carries changed action definitions across exact signed epochs without rebinding historical claims", async () => {
    const initial = await startupFixture();
    const catalog = initial.manifest.actionCatalogs[0];
    const definition = { providerAgentId: "1", serviceId: "0x" + "a".repeat(64),
      serviceSlug: "example", actionId: "read-example", assetType: "example",
      ownershipPolicy: "owner-only", destructive: false,
      requestSchema: { type: "object", properties: {}, additionalProperties: false },
      responseSchema: { type: "object", properties: {}, additionalProperties: false },
      confirmationSummarySchema: null, confirmationSummaryTemplate: null,
      endpoint: initial.manifest.providerControlProfiles[0].payload.assetActionUrl,
      replayPolicy: "stable-result", retentionSeconds: 3600,
      validFrom: catalog.issuedAt - 5, validBefore: catalog.validBefore };
    catalog.payload.actions = [{ ...definition, actionDefinitionHash: canonicalHash(definition) }];
    initial.manifest.actionCatalogs[0] = await signEnvelope({ ...catalog, privateKey: testKey });
    initial.manifest.servicingAdmissions[0].payload.actionCatalogHash = canonicalHash(initial.manifest.actionCatalogs[0]);
    initial.manifest.servicingAdmissions[0] = await signEnvelope({ ...initial.manifest.servicingAdmissions[0], privateKey: testKey });
    initial.priorState[0].admission = initial.manifest.servicingAdmissions[0];
    initial.expectedCurrent[0].admissionHash = canonicalHash(initial.manifest.servicingAdmissions[0]);
    const carried = await advancedCatalogFixture(initial);
    const stableProfile = initial.manifest.providerControlProfiles[0];
    carried.manifest.providerControlProfiles = [stableProfile];
    const additiveCatalog = carried.manifest.actionCatalogs[1];
    additiveCatalog.payload.providerControlProfileHash = canonicalHash(stableProfile);
    additiveCatalog.payload.servicingProfileEpoch = stableProfile.payload.servicingProfileEpoch;
    carried.manifest.actionCatalogs[1] = await signEnvelope({ ...additiveCatalog, privateKey: testKey });
    const additiveAdmission = carried.manifest.servicingAdmissions[1];
    additiveAdmission.payload.providerControlProfileHash = canonicalHash(stableProfile);
    additiveAdmission.payload.servicingProfileEpoch = stableProfile.payload.servicingProfileEpoch;
    additiveAdmission.payload.actionCatalogHash = canonicalHash(carried.manifest.actionCatalogs[1]);
    carried.manifest.servicingAdmissions[1] = await signEnvelope({ ...additiveAdmission, privateKey: testKey });
    const trust = { environment: "testnet", chainId: 84532, gatewayAudience: "https://gateway.reliability.invalid",
      signers: new Map(Object.entries(initial.trustedSigners)) as never,
      splitterFactoryRuntimeCodeHash: ("0x" + "1".repeat(64)) as `0x${string}`,
      splitterCreationCodeHash: ("0x" + "2".repeat(64)) as `0x${string}` };
    await expect(verifyStandardRailManifest(carried.manifest, trust)).resolves.toBeUndefined();
    // Epoch 2 changes the action definition while epoch 1 remains executable.
    const changed = { ...definition, retentionSeconds: 7200 };
    const nextCatalog = carried.manifest.actionCatalogs[1];
    nextCatalog.payload.actions = [{ ...changed, actionDefinitionHash: canonicalHash(changed) }];
    carried.manifest.actionCatalogs[1] = await signEnvelope({ ...nextCatalog, privateKey: testKey });
    const nextAdmission = carried.manifest.servicingAdmissions[1];
    nextAdmission.payload.actionCatalogHash = canonicalHash(carried.manifest.actionCatalogs[1]);
    carried.manifest.servicingAdmissions[1] = await signEnvelope({ ...nextAdmission, privateKey: testKey });
    await expect(verifyStandardRailManifest(carried.manifest, trust)).resolves.toBeUndefined();
    // Persist epoch 1 work, advance to 2, then resolve the original claim
    // through the real database and carried signed artifacts, not current.
    const schema="carried_recovery_"+randomUUID().replaceAll("-","");
    const databaseUrl=process.env.DATABASE_URL_TEST??"postgresql://postgres:password@localhost:5433/daski_gateway_test";
    const admin=createPool({connectionString:databaseUrl,max:1});
    await admin.query('CREATE SCHEMA "'+schema+'"');
    const pool=createPool({connectionString:databaseUrl,searchPath:schema+",public",max:3});
    try {
      await runMigrations(pool);
      const config={manifest:carried.manifest};
      const federation=new StandardAssetFederation(pool,config as never,84532,{} as never,async()=>{throw new Error("no network");});
      await federation.activateAdmissions();
      const old=carried.manifest.servicingAdmissions[0],oldHash=canonicalHash(old);
      const executionId=("0x"+"b".repeat(64)) as never,payer="0x"+"c".repeat(40);
      await claimAssetAction(pool,{executionId,payer:payer as never,providerAgentId:"1",serviceId:definition.serviceId as never,
        operation:"use",stagedExecutionId:null,walletAuthorizationHash:("0x"+"d".repeat(64)) as never,
        requestHash:("0x"+"e".repeat(64)) as never,providerControlProfileHash:old.payload.providerControlProfileHash,
        servicingAdmissionHash:oldHash,actionCatalogHash:old.payload.actionCatalogHash,
        actionCatalogSchemaHash:old.payload.actionCatalogSchemaHash,actionCatalogEpoch:1,
        actionDefinitionHash:canonicalHash(definition),stageValidBefore:null});
      await federation.setTarget({providerAgentId:"1",requestId:"advance-catalog-2",expectedEpoch:1,targetEpoch:2});
      await federation.activateAdmissions();
      expect(federation.activeServicing("1")?.admissionHash).not.toBe(oldHash);
      const api=new StandardAssetActions(pool,config as never,84532,{} as never,federation,async()=>{throw new Error("no network");});
      const args={payer,providerAgentId:"1",actionId:definition.actionId,input:{operation:"recover-action",actionExecutionId:executionId,originalInput:{}}};
      const recovered=await (api as any).resolveBound(args);
      expect(recovered.active.admissionHash).toBe(oldHash);
      expect(recovered.catalogEnvelope.payload.actionCatalogEpoch).toBe(1);
      expect(recovered.definition.actionDefinitionHash).toBe(canonicalHash(definition));
      await expect((api as any).resolveBound({...args,payer:"0x"+"f".repeat(40)})).rejects.toThrow("ASSET_ACTION_NOT_ADMITTED");
      config.manifest={...carried.manifest,servicingAdmissions:[carried.manifest.servicingAdmissions[1]]};
      await expect((api as any).resolveBound(args)).rejects.toThrow("ASSET_ACTION_NOT_ADMITTED");
    } finally {await pool.end();await admin.query('DROP SCHEMA "'+schema+'" CASCADE');await admin.end();}
    // The same catalog cannot contain ambiguous duplicate action identities.
    const duplicate = carried.manifest.actionCatalogs[1];
    duplicate.payload.actions.push({ ...definition, actionDefinitionHash: canonicalHash(definition) });
    carried.manifest.actionCatalogs[1] = await signEnvelope({ ...duplicate, privateKey: testKey });
    carried.manifest.servicingAdmissions[1].payload.actionCatalogHash = canonicalHash(carried.manifest.actionCatalogs[1]);
    carried.manifest.servicingAdmissions[1] = await signEnvelope({ ...carried.manifest.servicingAdmissions[1], privateKey: testKey });
    await expect(verifyStandardRailManifest(carried.manifest, trust)).rejects.toThrow("action definition");
  },60_000);
});
