import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPool, runMigrations } from "../src/db/pool.js";
import { ReleaseSales } from "../src/standardRail/releaseSales.js";
import { ServiceRegistrationStore } from "../src/serviceRegistration/store.js";

const databaseUrl = process.env.DATABASE_URL_TEST ??
  "postgresql://postgres:password@localhost:5433/daski_gateway_test";
const hash = Buffer.alloc(32, 3);
const service = Buffer.alloc(32, 4);
const quote = (name: string) => '"' + name + '"';

describe("release migrations under incumbent runtime privileges", () => {
  it("keeps legacy writes usable before candidate runtime setup without granting control writes", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const schema = "release_acl_" + suffix;
    const role = "release_runtime_" + suffix;
    const observer = "release_observer_" + suffix;
    const admin = createPool({ connectionString: databaseUrl, max: 1 });
    await admin.query("CREATE SCHEMA " + quote(schema));
    await admin.query("CREATE ROLE " + quote(role) + " NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT");
    await admin.query("CREATE ROLE " + quote(observer) + " NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT");
    const pool = createPool({ connectionString: databaseUrl, searchPath: schema + ",public", max: 3 });
    const runtime = await pool.connect();
    try {
      await runMigrations(pool, { through: "051_zz.sql" });
      await pool.query("GRANT USAGE ON SCHEMA " + quote(schema) + " TO " + quote(role) + ", " + quote(observer));
      await pool.query("GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA " + quote(schema) + " TO " + quote(role));
      await pool.query("GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA " + quote(schema) + " TO " + quote(role));
      await pool.query("GRANT SELECT ON ALL TABLES IN SCHEMA " + quote(schema) + " TO " + quote(observer));
      // No configureRuntimePrivileges after migrations: the candidate may fail before that step.
      await runMigrations(pool);
      await runtime.query("SET ROLE " + quote(role));
      expect((await runtime.query("SELECT current_user,rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0])
        .toEqual({ current_user: role, rolsuper: false });
      for (const table of ["standard_registration_revision_fences", "standard_sale_controls",
        "standard_parked_authorizations", "standard_asset_action_targets"]) {
        const privileges = (await runtime.query("SELECT has_table_privilege(current_user,$1,'SELECT') AS read,has_table_privilege(current_user,$1,'INSERT,UPDATE,DELETE') AS write", [schema + "." + table])).rows[0];
        expect(privileges).toEqual({ read: true, write: false });
        expect((await pool.query("SELECT has_table_privilege($1,$2,'SELECT') AS read", [observer,schema + "." + table])).rows[0].read).toBe(false);
      }

      const registration = randomUUID();
      const registrationSql = [
        "INSERT INTO standard_service_registrations",
        "(registration_id,provider_agent_id,service_id,service_slug,service_version,agent_card_url,",
        "service_wallet,provider_owner,provider_agent_wallet,provider_signer,idempotency_key,",
        "provider_payee,registration_nonce,request_hash,canonical_intent,prepared_json,card_json,",
        "card_hash,skill_contract_set_hash,state,marketplace_enabled,card_accepting_orders)",
        "VALUES($1,'7',$2,'legacy-service','1','https://provider.example',",
        "$3,$3,$3,$3,'legacy-registration',$3,$4,$4,$5,'{}','{}',$4,$4,'EVIDENCE_PENDING',true,true)",
      ].join(" ");
      const registrationValues = [registration,service,"0x" + "22".repeat(20),hash,
        { payload: { serviceContractHash: "0x" + hash.toString("hex"), skillContractSetHash: "0x" + hash.toString("hex") } }];
      await runtime.query(registrationSql, registrationValues);
      await runtime.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await runtime.query("SELECT count(*) FROM standard_service_registrations");
      const fencedService = Buffer.alloc(32,5);
      await new ServiceRegistrationStore(pool).acknowledgeRevisionFence({ payload: {
        providerAgentId: "8", serviceId: "0x" + fencedService.toString("hex"), targetRevision: 1,
        serviceContractHash: "0x" + hash.toString("hex"), skillContractSetHash: "0x" + hash.toString("hex"),
      } } as never);
      await expect(runtime.query(registrationSql.replace("'7'", "'8'"),
        [randomUUID(),fencedService,...registrationValues.slice(2)]))
        .rejects.toMatchObject({ code: "40001" });
      await runtime.query("ROLLBACK");
      await pool.query([
        "INSERT INTO standard_registration_revision_fences",
        "(provider_agent_id,service_id,target_revision,service_contract_hash,skill_contract_set_hash,intent_hash,canonical_intent)",
        "VALUES('7',$1,1,$2,$2,$2,'{}')",
      ].join(" "), [service,hash]);
      await expect(runtime.query("UPDATE standard_service_registrations SET state='ACTIVE' WHERE registration_id=$1", [registration]))
        .rejects.toThrow("REGISTRATION_REVISION_FENCED");

      await runtime.query([
        "INSERT INTO standard_orders",
        "(order_id,order_key,order_handle,handle_hash,state,provider_agent_id,outcome_id,binding_profile,",
        "listing_manifest_hash,provider_offer_hash,canonical_listing,quote_hash,canonical_quote,",
        "canonical_request_hash,canonical_request,order_nonce,intent_id,gross_amount,rail_epoch,listing_epoch,",
        "expires_at,payer,encrypted_payment_payload)",
        "VALUES('legacy',$1,'handle',$1,'CHALLENGE_ISSUED','7','outcome','recipe-bound-v2',",
        "$1,$1,$3,$1,'{}',$1,'{}',$1,'int_12345678-1234-4123-8123-123456789abc',1000000,1,1,",
        "now()+interval '1 hour','0x2222222222222222222222222222222222222222',$2)",
      ].join(" "), [hash,Buffer.from("encrypted"), { commitment: { payload: { serviceId: "0x" + service.toString("hex") } } }]);
      // A payment-admission transaction already holds its SERIALIZABLE snapshot
      // when the independently acknowledged stop becomes visible to newer reads.
      await runtime.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await runtime.query("SELECT * FROM standard_orders WHERE order_id='legacy' FOR UPDATE");
      await new ReleaseSales(pool).set({ providerAgentId: "7", serviceId: "0x" + service.toString("hex"),
        listingManifestHash: "0x" + hash.toString("hex"), expectedRevision: 0, requestId: "race-stop", acceptingNewOrders: false });
      await expect(runtime.query("UPDATE standard_orders SET state='ATTEMPT_OPENED' WHERE order_id='legacy'"))
        .rejects.toMatchObject({ code: "40001" });
      await runtime.query("ROLLBACK");
      await pool.query("DELETE FROM standard_sale_controls WHERE request_id='race-stop'");
      await runtime.query("UPDATE standard_orders SET state='ATTEMPT_OPENED' WHERE order_id='legacy'");
      await runtime.query("INSERT INTO standard_settlement_attempts(order_id,attempt_id,facilitator_profile_hash) VALUES('legacy','legacy-attempt',$1)", [hash]);
      await pool.query([
        "INSERT INTO standard_sale_controls",
        "(provider_agent_id,service_id,listing_manifest_hash,revision,request_id,accepting_new_orders)",
        "VALUES('7',$1,$2,1,'legacy-control',false)",
      ].join(" "), [service,hash]);
      await expect(runtime.query("UPDATE standard_settlement_attempts SET settle_invoked_at=now() WHERE order_id='legacy'"))
        .rejects.toThrow("SALE_SUSPENDED");
      await pool.query("UPDATE standard_sale_controls SET accepting_new_orders=true");
      await runtime.query("UPDATE standard_settlement_attempts SET settle_invoked_at=now() WHERE order_id='legacy'");
      await pool.query("INSERT INTO standard_parked_authorizations(order_id,sale_revision) VALUES('legacy',1)");
      await expect(runtime.query("UPDATE standard_orders SET state='NOT_SETTLED' WHERE order_id='legacy'"))
        .rejects.toThrow("PARKED_AUTHORIZATION_FINALITY_REQUIRED");

      const admission = (epoch: number) => ({ payload: { actionCatalogEpoch: epoch, servicingProfileEpoch: epoch } });
      const insertAdmission = [
        "INSERT INTO standard_provider_servicing_admissions",
        "(provider_agent_id,admission_hash,profile_hash,canonical_admission,current,valid_before)",
        "VALUES('7',$1,$1,$2,true,now()+interval '1 hour')",
      ].join(" ");
      // Legacy bootstrap profile 1 does not require INSERT access to target controls.
      await runtime.query(insertAdmission, [hash,admission(1)]);
      await runtime.query("BEGIN");
      await runtime.query("UPDATE standard_provider_servicing_admissions SET current=false WHERE provider_agent_id='7'");
      await expect(runtime.query(insertAdmission, [Buffer.alloc(32,9),admission(2)]))
        .rejects.toThrow("ASSET_ACTION_TARGET_REQUIRED");
      await runtime.query("ROLLBACK");
      expect((await runtime.query("SELECT current FROM standard_provider_servicing_admissions WHERE provider_agent_id='7'")).rows)
        .toEqual([{ current: true }]);
    } finally {
      await runtime.query("ROLLBACK").catch(() => undefined);
      await runtime.query("RESET ROLE");
      runtime.release();
      await pool.end();
      await admin.query("DROP SCHEMA " + quote(schema) + " CASCADE");
      await admin.query("DROP ROLE " + quote(role));
      await admin.query("DROP ROLE " + quote(observer));
      await admin.end();
    }
  }, 60_000);
});
