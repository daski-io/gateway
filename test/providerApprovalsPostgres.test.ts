import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { createPool, runMigrations, type Pool } from "../src/db/pool.js";
import { buildProviderApprovalRecord, type ProviderApprovalRecord } from "../src/providerApprovals/record.js";
import { createProviderApprovalRouter, PUBLIC_APPROVAL_CACHE_CONTROL } from "../src/providerApprovals/routes.js";
import { ProviderApprovalService } from "../src/providerApprovals/service.js";
import { APPROVAL_SNAPSHOT_TTL_MS, ProviderApprovalStore } from "../src/providerApprovals/store.js";
import { ServiceRegistrationStore } from "../src/serviceRegistration/store.js";
import { canonicalHash } from "../src/standardRail/canonical.js";
import type { StandardRailConfig } from "../src/standardRail/config.js";
import type { StandardRailManifest } from "../src/standardRail/types.js";
import { approvalWallet, insertRegistration, type SeededRegistration } from "./helpers/approvalRegistrations.js";
import { HOSTED_ORIGIN, hostedCard, hostedStandardRail } from "./helpers/hostedProvider.js";

// Hosted provider approvals over PostgreSQL (docs/provider-approvals.md):
// the approval table, the store and its snapshot across replicas, approval by
// invite on activation and on the sweep, and the operator and public routes.
// The public answer for a synthetic provider is the shared fixture
// test/fixtures/provider-approval-answer.json, which a hosted runtime can
// vendor to check its reading of the record and its hash. Regenerate it after
// an intentional change:
//   UPDATE_PROVIDER_APPROVAL_ANSWER=1 npx vitest run test/providerApprovalsPostgres.test.ts

const databaseUrl = process.env.DATABASE_URL_TEST ??
  "postgresql://postgres:password@localhost:5433/daski_gateway_test";
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "provider-approval-answer.json");
const update = process.env.UPDATE_PROVIDER_APPROVAL_ANSWER === "1";

const CHAIN_ID = 84_532;
const ENVIRONMENT = "testnet";
const GATEWAY_AUDIENCE = "https://gateway.example";
const OPERATOR_TOKEN = "provider-approvals-test-operator-token-0000000";
const OTHER_ORIGIN = "https://elsewhere.example";
const DOMAIN = { environment: ENVIRONMENT, chainId: CHAIN_ID, gatewayAudience: GATEWAY_AUDIENCE };

const config = { chainId: CHAIN_ID, hostedProviderOrigins: [HOSTED_ORIGIN] } as Pick<Config, "chainId" | "hostedProviderOrigins">;
const railConfig = {
  environment: ENVIRONMENT, gatewayAudience: GATEWAY_AUDIENCE,
  manifest: { providerControlProfiles: [] } as unknown as StandardRailManifest,
} as Pick<StandardRailConfig, "environment" | "gatewayAudience" | "manifest">;

let admin: Pool;
let pool: Pool;
let schema: string;

beforeAll(async () => {
  schema = `provider_approvals_${randomUUID().replaceAll("-", "")}`;
  admin = createPool({ connectionString: databaseUrl, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  pool = createPool({ connectionString: databaseUrl, searchPath: `${schema},public`, max: 6 });
  await runMigrations(pool);
}, 60_000);

afterAll(async () => {
  await pool?.end();
  await admin?.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined);
  await admin?.end();
});

beforeEach(async () => {
  await pool.query("TRUNCATE standard_provider_approvals, standard_operator_actions, standard_service_registrations CASCADE");
});

const builder = (registration: SeededRegistration, chainId = CHAIN_ID) => (minimumEpoch = 1) => buildProviderApprovalRecord({
  domain: { ...DOMAIN, chainId },
  registration: { providerAgentId: registration.providerAgentId, providerAgentWallet: registration.agentWallet, card: registration.card },
  manifestProfiles: [],
  minimumEpoch,
});
const built = (registration: SeededRegistration, chainId = CHAIN_ID, minimumEpoch = 1) =>
  builder(registration, chainId)(minimumEpoch);
const approveAs = (
  store: ProviderApprovalStore, registration: SeededRegistration, approvedBy: string, replace: boolean,
  extra: Partial<Parameters<ProviderApprovalStore["approve"]>[0]> = {},
) => store.approve({ providerAgentId: registration.providerAgentId, build: builder(registration), approvedBy, replace, ...extra });
const operatorActions = async () => (await pool.query<{ actor: string; action: string; target_id: string; details: Record<string, unknown> }>(
  "SELECT actor,action,target_id,details FROM standard_operator_actions ORDER BY id")).rows;
const approvalRows = async (providerAgentId: string) => (await pool.query<{
  approved_by: string; revoked_at: Date | null; revoked_by: string | null; record_hash: Buffer; epoch: number;
}>(`SELECT approved_by,revoked_at,revoked_by,record_hash,(record_json->'payload'->>'servicingProfileEpoch')::int AS epoch
      FROM standard_provider_approvals WHERE provider_agent_id=$1 ORDER BY approval_id`,
  [providerAgentId])).rows;
const hex = (value: Buffer) => `0x${value.toString("hex")}`;

describe("the approval table (migration 063)", () => {
  it("holds one current approval per provider and chain, one record per epoch, and keeps every row", async () => {
    const registration = await insertRegistration(pool, { providerAgentId: "9201" });
    const insert = (chainId: number, value: { record: ProviderApprovalRecord; recordHash: string } = built(registration),
      by = "operator:catalog-operator") => pool.query(
      `INSERT INTO standard_provider_approvals (provider_agent_id,chain_id,approved_by,record_json,record_hash)
       VALUES ($1,$2,$3,$4,$5)`,
      [value.record.payload.providerAgentId, chainId, by, value.record, Buffer.from(value.recordHash.slice(2), "hex")]);
    await insert(CHAIN_ID);
    await expect(insert(CHAIN_ID, built(registration, CHAIN_ID, 2))).rejects.toMatchObject({ code: "23505" });
    // Another chain's approval of the same provider is its own.
    await insert(8453, built(registration, 8453));
    // A revoked row stays, and the provider may hold a new current one, under another epoch only.
    await pool.query("UPDATE standard_provider_approvals SET revoked_at=now(),revoked_by='operator:catalog-operator' WHERE chain_id=$1", [CHAIN_ID]);
    await expect(insert(CHAIN_ID)).rejects.toMatchObject({ code: "23505" });
    await insert(CHAIN_ID, built(registration, CHAIN_ID, 2));
    expect((await approvalRows("9201")).map((row) => row.epoch)).toEqual([1, 1, 2]);
    // The record must name the row's provider and chain; approvers are labelled.
    await expect(pool.query(
      `INSERT INTO standard_provider_approvals (provider_agent_id,chain_id,approved_by,record_json,record_hash)
       VALUES ('9202',$1,'operator:catalog-operator',$2,$3)`, [CHAIN_ID, built(registration, CHAIN_ID, 5).record, Buffer.alloc(32)]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(insert(84_531, built(registration, CHAIN_ID, 6))).rejects.toMatchObject({ code: "23514" });
    await pool.query("DELETE FROM standard_provider_approvals WHERE revoked_at IS NULL AND chain_id=$1", [CHAIN_ID]);
    await expect(insert(CHAIN_ID, built(registration, CHAIN_ID, 7), "someone")).rejects.toMatchObject({ code: "23514" });
  });
});

describe("the approval store", () => {
  it("records an approval once, keeps it against an invite and replaces it only for the operator", async () => {
    const store = new ProviderApprovalStore(pool, CHAIN_ID);
    const registration = await insertRegistration(pool, { providerAgentId: "9211" });
    const first = built(registration);
    const created = await approveAs(store, registration, "invite:a1b2c3d4e5f6", false);
    expect(created).toMatchObject({ created: true, replaced: null });
    expect(created.approval).toMatchObject({ providerAgentId: "9211", chainId: CHAIN_ID, approvedBy: "invite:a1b2c3d4e5f6",
      revokedAt: null, record: first.record, recordHash: first.recordHash });
    // Approved again by hand from the same registration: the same record, unchanged.
    expect(await approveAs(store, registration, "operator:catalog-operator", true))
      .toMatchObject({ created: false, approval: { approvedBy: "invite:a1b2c3d4e5f6" } });

    // After the wallet moved: an invite never replaces, the operator does, under the next epoch.
    const moved = { ...registration, agentWallet: approvalWallet("next wallet of 9211") };
    expect(await approveAs(store, moved, "invite:a1b2c3d4e5f6", false))
      .toMatchObject({ created: false, approval: { recordHash: first.recordHash } });
    const second = built(moved, CHAIN_ID, 2);
    const replaced = await approveAs(store, moved, "operator:release-desk", true);
    expect(replaced).toMatchObject({ created: true, replaced: { recordHash: first.recordHash },
      approval: { record: second.record, recordHash: second.recordHash, approvedBy: "operator:release-desk" } });
    expect(await approveAs(store, moved, "operator:release-desk", true)).toMatchObject({ created: false });
    expect((await approvalRows("9211")).map((row) => [row.approved_by, row.revoked_by, hex(row.record_hash), row.epoch]))
      .toEqual([
        ["invite:a1b2c3d4e5f6", "operator:release-desk", first.recordHash, 1],
        ["operator:release-desk", null, second.recordHash, 2],
      ]);
    expect((await store.read("9211"))?.recordHash).toBe(second.recordHash);
    // Both records stay resolvable by hash.
    expect(await store.recordByHash(first.recordHash)).toEqual(first.record);
    expect(await store.recordByHash(second.recordHash)).toEqual(second.record);

    const revoked = await store.revoke({ providerAgentId: "9211", revokedBy: "operator:catalog-operator" });
    expect(revoked).toMatchObject({ recordHash: second.recordHash, revokedBy: "operator:catalog-operator" });
    expect(revoked?.revokedAt).toBeInstanceOf(Date);
    expect(await store.read("9211")).toBeNull();
    expect((await store.latest("9211"))?.recordHash).toBe(second.recordHash);
    expect(await store.revoke({ providerAgentId: "9211", revokedBy: "operator:catalog-operator" })).toBeNull();
    expect(await store.latest("9212")).toBeNull();

    // Approved again, even with the first wallet's payload, it never reuses an earlier epoch.
    expect((await approveAs(store, registration, "operator:catalog-operator", true)).approval.record)
      .toEqual(built(registration, CHAIN_ID, 3).record);
    expect((await approvalRows("9211")).map((row) => row.epoch)).toEqual([1, 2, 3]);
  });

  it("takes the epoch after the manifest's and every earlier approval's, under the provider's lock", async () => {
    const store = new ProviderApprovalStore(pool, CHAIN_ID);
    const registration = await insertRegistration(pool, { providerAgentId: "9215" });
    const asked: number[] = [];
    const build = (minimumEpoch: number) => {
      asked.push(minimumEpoch);
      // As if the manifest carried epochs up to 4 for this provider.
      return built(registration, CHAIN_ID, Math.max(minimumEpoch, 5));
    };
    await store.approve({ providerAgentId: "9215", build, approvedBy: "operator:catalog-operator", replace: true });
    await store.revoke({ providerAgentId: "9215", revokedBy: "operator:catalog-operator" });
    await store.approve({ providerAgentId: "9215", build: builder(registration), approvedBy: "operator:catalog-operator", replace: true });
    expect(asked).toEqual([1]);
    expect((await approvalRows("9215")).map((row) => row.epoch)).toEqual([5, 6]);
    // Two operators approving different records at once both get their own epoch.
    const other = { ...registration, agentWallet: approvalWallet("other wallet of 9215") };
    await Promise.all([
      approveAs(store, other, "operator:first-desk", true),
      approveAs(store, { ...registration, agentWallet: approvalWallet("third wallet of 9215") }, "operator:second-desk", true),
    ]);
    const epochs = (await approvalRows("9215")).map((row) => row.epoch);
    expect(epochs).toEqual([5, 6, 7, 8]);
  });

  it("commits an operator action with its change, and neither without the other", async () => {
    const store = new ProviderApprovalStore(pool, CHAIN_ID);
    const registration = await insertRegistration(pool, { providerAgentId: "9221" });
    const record = built(registration);
    await expect(approveAs(store, registration, "operator:catalog-operator", true,
      { audit: () => { throw new Error("audit refused"); } })).rejects.toThrow("audit refused");
    expect(await store.read("9221")).toBeNull();
    expect(await operatorActions()).toEqual([]);
    await approveAs(store, registration, "operator:catalog-operator", true, {
      audit: ({ approval }) => ({ actor: "catalog-operator", action: "operator_provider_approved",
        details: { recordHash: approval.recordHash } }) });
    expect(await operatorActions()).toEqual([{ actor: "catalog-operator", action: "operator_provider_approved",
      target_id: "9221", details: { recordHash: record.recordHash } }]);
  });

  it("refuses a record of another chain or provider, or a hash that is not the record's", async () => {
    const store = new ProviderApprovalStore(pool, CHAIN_ID);
    const registration = await insertRegistration(pool, { providerAgentId: "9231" });
    const approve = (build: Parameters<ProviderApprovalStore["approve"]>[0]["build"]) =>
      store.approve({ providerAgentId: "9231", build, approvedBy: "operator:catalog-operator", replace: true });
    await expect(approve(builder(registration, 8453))).rejects.toThrow("PROVIDER_APPROVAL_CHAIN_MISMATCH");
    await expect(approve(() => ({ ...built(registration), recordHash: built(registration, 8453).recordHash })))
      .rejects.toThrow("PROVIDER_APPROVAL_HASH_MISMATCH");
    const another = await insertRegistration(pool, { providerAgentId: "9232" });
    await expect(approve(builder(another))).rejects.toThrow("PROVIDER_APPROVAL_PROVIDER_MISMATCH");
    expect(await approvalRows("9231")).toEqual([]);
  });

  it("never serves a stored record that no longer matches its hash", async () => {
    const store = new ProviderApprovalStore(pool, CHAIN_ID);
    const registration = await insertRegistration(pool, { providerAgentId: "9241" });
    const record = built(registration);
    await approveAs(store, registration, "operator:catalog-operator", true);
    await pool.query(`UPDATE standard_provider_approvals SET record_json=jsonb_set(record_json,'{payload,timeoutMs}','1000')`);
    expect(await store.read("9241")).toBeNull();
    expect(await new ProviderApprovalStore(pool, CHAIN_ID).currentRecord("9241")).toBeNull();
    expect(await store.recordByHash(record.recordHash)).toBeNull();
  });

  it("shows an approval or a revocation at once in its own process and within the snapshot age in another", async () => {
    let clock = 1_000_000;
    const here = new ProviderApprovalStore(pool, CHAIN_ID, () => clock);
    const there = new ProviderApprovalStore(pool, CHAIN_ID, () => clock);
    const registration = await insertRegistration(pool, { providerAgentId: "9251" });
    const record = built(registration);
    expect(await here.currentRecord("9251")).toBeNull();
    expect(await there.currentRecord("9251")).toBeNull();
    const before = { here: here.version, there: there.version };

    await approveAs(here, registration, "operator:catalog-operator", true);
    expect(await here.currentRecord("9251")).toEqual(record.record);
    expect(here.version).toBeGreaterThan(before.here);
    // The other replica's snapshot is still the one it read.
    clock += APPROVAL_SNAPSHOT_TTL_MS - 1;
    expect(await there.currentRecord("9251")).toBeNull();
    expect(there.version).toBe(before.there);
    clock += 1;
    expect(await there.currentRecord("9251")).toEqual(record.record);
    expect(there.version).toBeGreaterThan(before.there);

    const seen = there.version;
    await here.revoke({ providerAgentId: "9251", revokedBy: "operator:catalog-operator" });
    expect(await here.currentRecord("9251")).toBeNull();
    expect(await there.currentRecord("9251")).toEqual(record.record);
    clock += APPROVAL_SNAPSHOT_TTL_MS;
    expect(await there.currentRecord("9251")).toBeNull();
    expect(there.version).toBeGreaterThan(seen);
    // A reload that finds nothing changed leaves the version alone.
    const settled = there.version;
    clock += APPROVAL_SNAPSHOT_TTL_MS;
    expect(await there.currentRecord("9251")).toBeNull();
    expect(there.version).toBe(settled);
  });

  it("keeps serving its last snapshot when the database cannot be read, and shares one read", async () => {
    let clock = 2_000_000;
    let reads = 0;
    let failing = false;
    const flaky = {
      query: async (text: string, values?: unknown[]) => {
        reads += 1;
        if (failing) throw new Error("database unavailable");
        return pool.query(text, values);
      },
    } as unknown as Pool;
    const store = new ProviderApprovalStore(flaky, CHAIN_ID, () => clock);
    const registration = await insertRegistration(pool, { providerAgentId: "9261" });
    await approveAs(new ProviderApprovalStore(pool, CHAIN_ID), registration, "operator:catalog-operator", true);
    const [first, second] = await Promise.all([store.currentRecord("9261"), store.currentRecord("9262")]);
    expect(first?.payload.providerAgentId).toBe("9261");
    expect(second).toBeNull();
    expect(reads).toBe(1);
    failing = true;
    clock += APPROVAL_SNAPSHOT_TTL_MS;
    expect((await store.currentRecord("9261"))?.payload.providerAgentId).toBe("9261");
    expect(reads).toBe(2);
    // The next attempt waits a few seconds rather than reading on every call.
    expect((await store.currentRecord("9261"))?.payload.providerAgentId).toBe("9261");
    expect(reads).toBe(2);
    await expect(new ProviderApprovalStore(flaky, CHAIN_ID, () => clock).currentRecord("9261")).rejects.toThrow("database unavailable");
  });
});

describe("approval by invite", () => {
  function service(answer: (url: string) => unknown, origins: string[] = [HOSTED_ORIGIN]) {
    const asked: string[] = [];
    const approvals = new ProviderApprovalStore(pool, CHAIN_ID);
    const approvalService = new ProviderApprovalService({
      config: { ...config, hostedProviderOrigins: origins }, railConfig,
      registrations: new ServiceRegistrationStore(pool), approvals,
      loadJson: async (url) => {
        asked.push(url);
        const value = answer(url);
        if (value instanceof Error) throw value;
        return value;
      },
    });
    return { asked, approvals, approvalService };
  }
  const report = (registration: SeededRegistration, overrides: Record<string, unknown> = {}) => ({
    providerAgentId: registration.providerAgentId, chainId: CHAIN_ID,
    invite: { id: `invite${registration.providerAgentId}`, admissionAuthorized: true,
      authorizedAt: "2026-11-17T12:00:00.000Z", redeemedWallet: registration.owner.toLowerCase(), ...overrides },
  });
  const stored = async (providerAgentId: string) => (await new ProviderApprovalStore(pool, CHAIN_ID).read(providerAgentId));
  const record = async (registration: SeededRegistration) =>
    (await new ServiceRegistrationStore(pool).listActiveByProvider(registration.providerAgentId))[0]!;

  it("approves a hosted provider whose invite authorizes admission, from its runtime's admission report", async () => {
    const registration = await insertRegistration(pool, { providerAgentId: "9301" });
    const { asked, approvalService } = service(() => report(registration));
    expect(await approvalService.approveByInvite(await record(registration))).toBe("approved");
    expect(asked).toEqual([`${HOSTED_ORIGIN}/p/9301/standard-rail/admission`]);
    const approval = await stored("9301");
    expect(approval).toMatchObject({ approvedBy: "invite:invite9301", revokedAt: null });
    expect(approval?.record).toEqual(built(registration).record);
    expect(approval?.recordHash).toBe(canonicalHash(approval!.record));
    // Asked again, it reads nothing.
    expect(await approvalService.approveByInvite(await record(registration))).toBe("already-approved");
    expect(asked).toHaveLength(1);
  });

  it("holds nothing while it asks the runtime, which may read the provider's status meanwhile", async () => {
    const registration = await insertRegistration(pool, { providerAgentId: "9305" });
    const statuses: unknown[] = [];
    let approvalService: ProviderApprovalService | undefined;
    const approvals = new ProviderApprovalStore(pool, CHAIN_ID);
    approvalService = new ProviderApprovalService({
      config, railConfig, registrations: new ServiceRegistrationStore(pool), approvals,
      loadJson: async () => {
        // The runtime reads the gateway's public answer, and the operator acts, before it answers.
        statuses.push(await approvalService!.publicStatus("9305"));
        statuses.push(await approvals.read("9305"));
        return report(registration);
      },
    });
    const outcome = await Promise.race([
      approvalService.approveByInvite(await record(registration)),
      new Promise((resolve) => setTimeout(() => resolve("timed out"), 5_000)),
    ]);
    expect(outcome).toBe("approved");
    expect(statuses).toEqual([{ approved: false }, null]);
    expect((await approvalService.publicStatus("9305")).approved).toBe(true);
  });

  it("does not approve on an answer that does not authorize, and asks again later", async () => {
    const registration = await insertRegistration(pool, { providerAgentId: "9302" });
    let answer: unknown = report(registration, { admissionAuthorized: false, authorizedAt: null });
    const { asked, approvalService } = service(() => answer);
    expect(await approvalService.approveByInvite(await record(registration))).toBe("refused");
    answer = report(registration, { redeemedWallet: approvalWallet("someone else") });
    expect(await approvalService.approveByInvite(await record(registration))).toBe("refused");
    answer = { ...report(registration), chainId: 8453 };
    expect(await approvalService.approveByInvite(await record(registration))).toBe("refused");
    answer = new Error("admission report unavailable");
    expect(await approvalService.approveByInvite(await record(registration))).toBe("unavailable");
    expect(await stored("9302")).toBeNull();
    answer = report(registration);
    expect(await approvalService.approveByInvite(await record(registration))).toBe("approved");
    expect(asked).toHaveLength(5);
  });

  it("never approves a provider off the hosted origins, nor one whose approval was revoked", async () => {
    const elsewhere = await insertRegistration(pool, { providerAgentId: "9303",
      card: hostedCard("9303", hostedStandardRail("9303", OTHER_ORIGIN)) });
    const { asked, approvalService, approvals } = service(() => ({}));
    expect(await approvalService.approveByInvite(await record(elsewhere))).toBe("not-hosted");
    const off = service(() => report(elsewhere), []);
    expect(await off.approvalService.approveByInvite(await record(elsewhere))).toBe("not-hosted");
    await expect(off.approvalService.approveByOperator("9303", { reason: "test", operator: "catalog-operator" }))
      .rejects.toMatchObject({ status: 409, code: "PROVIDER_NOT_HOSTED" });

    const revoked = await insertRegistration(pool, { providerAgentId: "9304" });
    await approveAs(approvals, revoked, "operator:catalog-operator", true);
    await approvals.revoke({ providerAgentId: "9304", revokedBy: "operator:catalog-operator" });
    expect(await approvalService.approveByInvite(await record(revoked))).toBe("previously-approved");
    expect(asked).toEqual([]);
    expect(off.asked).toEqual([]);
  });

  it("sweeps active hosted registrations of providers that never held an approval", async () => {
    const authorized = await insertRegistration(pool, { providerAgentId: "9311" });
    const unauthorized = await insertRegistration(pool, { providerAgentId: "9312" });
    await insertRegistration(pool, { providerAgentId: "9313", state: "PREPARED" });
    await insertRegistration(pool, { providerAgentId: "9314", card: hostedCard("9314", hostedStandardRail("9314", OTHER_ORIGIN)) });
    const revoked = await insertRegistration(pool, { providerAgentId: "9315" });
    const { asked, approvals, approvalService } = service((url) => {
      if (url.includes("/p/9311/")) return report(authorized);
      if (url.includes("/p/9312/")) return report(unauthorized, { admissionAuthorized: false, authorizedAt: null });
      return new Error("unexpected");
    });
    await approveAs(approvals, revoked, "operator:catalog-operator", true);
    await approvals.revoke({ providerAgentId: "9315", revokedBy: "operator:catalog-operator" });

    await approvalService.sweep();
    expect(asked.sort()).toEqual([
      `${HOSTED_ORIGIN}/p/9311/standard-rail/admission`, `${HOSTED_ORIGIN}/p/9312/standard-rail/admission`,
    ]);
    expect((await stored("9311"))?.approvedBy).toBe("invite:invite9311");
    expect(await stored("9312")).toBeNull();
    expect(await stored("9315")).toBeNull();
    // The next sweep asks only about the provider still without an approval.
    asked.length = 0;
    await approvalService.sweep();
    expect(asked).toEqual([`${HOSTED_ORIGIN}/p/9312/standard-rail/admission`]);
  });

  it("approves on activation without waiting for it, and sweeps once a minute until stopped", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const registration = await insertRegistration(pool, { providerAgentId: "9321" });
      const { asked, approvalService } = service(() => report(registration));
      approvalService.activated(await record(registration));
      await vi.waitFor(async () => expect(await stored("9321")).not.toBeNull());
      expect(asked).toHaveLength(1);

      const later = await insertRegistration(pool, { providerAgentId: "9322" });
      const swept = service(() => report(later));
      swept.approvalService.start();
      await vi.waitFor(() => expect(swept.asked).toHaveLength(1));
      const next = await insertRegistration(pool, { providerAgentId: "9323" });
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(swept.asked).toContain(`${HOSTED_ORIGIN}/p/9323/standard-rail/admission`));
      await swept.approvalService.stop();
      await insertRegistration(pool, { providerAgentId: "9324" });
      const count = swept.asked.length;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(swept.asked).toHaveLength(count);
      void next;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the approval routes", () => {
  async function server(origins: string[] = [HOSTED_ORIGIN], rail: typeof railConfig = railConfig) {
    const approvals = new ProviderApprovalStore(pool, CHAIN_ID);
    const approvalService = new ProviderApprovalService({
      config: { ...config, hostedProviderOrigins: origins }, railConfig: rail,
      registrations: new ServiceRegistrationStore(pool), approvals,
      loadJson: async () => { throw new Error("no runtime is asked"); },
    });
    const app = express();
    app.use(express.json());
    app.use(createProviderApprovalRouter({ service: approvalService, operatorToken: OPERATOR_TOKEN }));
    const listening = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => listening.once("listening", () => resolve()));
    const url = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;
    return {
      url,
      call: async (method: string, pathName: string, body?: unknown, token: string | null = OPERATOR_TOKEN) => {
        const response = await fetch(`${url}${pathName}`, {
          method,
          headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(body === undefined ? {} : { "content-type": "application/json" }) },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, cacheControl: response.headers.get("cache-control"),
          body: await response.json() as Record<string, unknown> };
      },
      close: () => new Promise<void>((resolve) => listening.close(() => resolve())),
    };
  }

  it("approves and revokes a hosted provider by hand, recorded as operator actions, and answers its status publicly", async () => {
    const http = await server();
    try {
      const registration = await insertRegistration(pool, { providerAgentId: "9401" });
      const expected = built(registration);
      const status = () => http.call("GET", "/public/v3/providers/9401/approval", undefined, null);
      expect(await status()).toEqual({ status: 200, cacheControl: PUBLIC_APPROVAL_CACHE_CONTROL, body: { approved: false } });

      const approved = await http.call("PUT", "/operator/v1/providers/9401/approval", { reason: "invite checked by hand" });
      expect(approved.status).toBe(200);
      expect(approved.cacheControl).toBe("no-store");
      expect(approved.body).toMatchObject({ approved: true, created: true, inUse: true, record: expected.record,
        recordHash: expected.recordHash });
      const answer = await status();
      expect(answer.cacheControl).toBe(PUBLIC_APPROVAL_CACHE_CONTROL);
      expect(answer.body).toEqual({ approved: true, approvedAt: approved.body.approvedAt, record: expected.record,
        recordHash: expected.recordHash });
      // The served record hashes to the served hash.
      expect(canonicalHash(answer.body.record)).toBe(answer.body.recordHash);
      expect((await pool.query("SELECT approved_by FROM standard_provider_approvals")).rows)
        .toEqual([{ approved_by: "operator:catalog-operator" }]);

      // Approving again changes nothing but is recorded; a label names the operator.
      expect((await http.call("PUT", "/operator/v1/providers/9401/approval",
        { reason: "checked again", operator: "release-desk" })).body).toMatchObject({ created: false });
      const revoked = await http.call("DELETE", "/operator/v1/providers/9401/approval", { reason: "seller asked to stop" });
      expect(revoked).toMatchObject({ status: 200, body: { approved: false, recordHash: expected.recordHash } });
      expect((await status()).body).toEqual({ approved: false });
      expect(await http.call("DELETE", "/operator/v1/providers/9401/approval", { reason: "again" }))
        .toMatchObject({ status: 404, body: { error: { code: "PROVIDER_APPROVAL_NOT_FOUND" } } });

      expect(await operatorActions()).toEqual([
        { actor: "catalog-operator", action: "operator_provider_approved", target_id: "9401", details: {
          chainId: CHAIN_ID, reason: "invite checked by hand", registrationId: registration.registrationId,
          recordHash: expected.recordHash, created: true, replacedRecordHash: null } },
        { actor: "release-desk", action: "operator_provider_approved", target_id: "9401", details: {
          chainId: CHAIN_ID, reason: "checked again", registrationId: registration.registrationId,
          recordHash: expected.recordHash, created: false, replacedRecordHash: null } },
        { actor: "catalog-operator", action: "operator_provider_approval_revoked", target_id: "9401", details: {
          chainId: CHAIN_ID, reason: "seller asked to stop", recordHash: expected.recordHash } },
      ]);
      expect((await pool.query("SELECT revoked_by FROM standard_provider_approvals")).rows)
        .toEqual([{ revoked_by: "operator:catalog-operator" }]);

      // A new approval by hand after a revocation is a new row.
      expect((await http.call("PUT", "/operator/v1/providers/9401/approval", { reason: "resumed" })).body)
        .toMatchObject({ approved: true, created: true });
      expect(await approvalRows("9401")).toHaveLength(2);
    } finally {
      await http.close();
    }
  });

  it("refuses without the operator token, with an invalid body or provider, and for a provider not hosted", async () => {
    const http = await server();
    try {
      await insertRegistration(pool, { providerAgentId: "9402" });
      await insertRegistration(pool, { providerAgentId: "9403", card: hostedCard("9403", hostedStandardRail("9403", OTHER_ORIGIN)) });
      for (const method of ["PUT", "DELETE"]) {
        expect(await http.call(method, "/operator/v1/providers/9402/approval", { reason: "x" }, null))
          .toMatchObject({ status: 401, body: { error: { code: "OPERATOR_AUTH_REQUIRED" } } });
        expect(await http.call(method, "/operator/v1/providers/9402/approval", { reason: "x" }, "wrong-token"))
          .toMatchObject({ status: 401 });
      }
      for (const body of [undefined, {}, { reason: "" }, { reason: "x", extra: 1 }, { reason: "line\nbreak" },
        { reason: "x", operator: "has space" }, [{ reason: "x" }]]) {
        expect((await http.call("PUT", "/operator/v1/providers/9402/approval", body)).body)
          .toMatchObject({ error: { code: "INVALID_PROVIDER_APPROVAL_REQUEST" } });
      }
      for (const agentId of ["0", "01", "abc", "1".repeat(79)]) {
        expect(await http.call("PUT", `/operator/v1/providers/${agentId}/approval`, { reason: "x" }))
          .toMatchObject({ status: 400, body: { error: { code: "INVALID_PROVIDER_AGENT_ID" } } });
        expect((await http.call("GET", `/public/v3/providers/${agentId}/approval`, undefined, null)).status).toBe(400);
      }
      expect(await http.call("PUT", "/operator/v1/providers/9403/approval", { reason: "x" }))
        .toMatchObject({ status: 409, body: { error: { code: "PROVIDER_NOT_HOSTED" } } });
      expect(await http.call("PUT", "/operator/v1/providers/9404/approval", { reason: "x" }))
        .toMatchObject({ status: 409, body: { error: { code: "PROVIDER_NOT_HOSTED" } } });
      expect(await operatorActions()).toEqual([]);
      expect((await pool.query("SELECT count(*)::int AS n FROM standard_provider_approvals")).rows[0].n).toBe(0);
    } finally {
      await http.close();
    }
    // With approvals off no provider is hosted.
    const off = await server([]);
    try {
      expect(await off.call("PUT", "/operator/v1/providers/9402/approval", { reason: "x" }))
        .toMatchObject({ status: 409, body: { error: { code: "PROVIDER_NOT_HOSTED" } } });
    } finally {
      await off.close();
    }
  });

  it("answers approved only while the catalog sells the provider through its approval", async () => {
    // The manifest carries a profile, at epoch 3, for one provider.
    const carried = { ...railConfig, manifest: { providerControlProfiles: [
      { payload: { providerAgentId: "9411", servicingProfileEpoch: 3 } },
    ] } as unknown as StandardRailManifest };
    const http = await server([HOSTED_ORIGIN], carried);
    try {
      const status = async (agentId: string) =>
        (await http.call("GET", `/public/v3/providers/${agentId}/approval`, undefined, null)).body;
      // Approved, the provider with a manifest profile is still sold through that profile.
      await insertRegistration(pool, { providerAgentId: "9411" });
      const withProfile = await http.call("PUT", "/operator/v1/providers/9411/approval", { reason: "manifest provider" });
      expect(withProfile.body).toMatchObject({ approved: true, created: true, inUse: false,
        record: { payload: { servicingProfileEpoch: 4 } } });
      expect(await status("9411")).toEqual({ approved: false });

      // A provider with a current servicing admission is sold through the admission's profile.
      await insertRegistration(pool, { providerAgentId: "9412" });
      expect((await http.call("PUT", "/operator/v1/providers/9412/approval", { reason: "admitted provider" })).body)
        .toMatchObject({ approved: true, inUse: true });
      expect((await status("9412")).approved).toBe(true);
      await pool.query(`INSERT INTO standard_provider_servicing_admissions
        (provider_agent_id,admission_hash,profile_hash,canonical_admission,current,valid_before)
        VALUES ('9412',$1,$2,$3,true,now()+interval '1 day')`, [Buffer.alloc(32, 7), Buffer.alloc(32, 8),
        { payload: { actionCatalogEpoch: 1, servicingProfileEpoch: 1, actionCatalogHash: `0x${"00".repeat(32)}` } }]);
      expect(await status("9412")).toEqual({ approved: false });

      // The approvals themselves stay as they are.
      expect((await pool.query("SELECT count(*)::int AS n FROM standard_provider_approvals WHERE revoked_at IS NULL")).rows[0].n)
        .toBe(2);
    } finally {
      await http.close();
    }
    // With approvals off, no approval is in use.
    const off = await server([]);
    try {
      expect((await off.call("GET", "/public/v3/providers/9412/approval", undefined, null)).body).toEqual({ approved: false });
    } finally {
      await off.close();
    }
  });

  it("answers the shared fixture for a synthetic hosted provider", async () => {
    const http = await server();
    try {
      const registration = await insertRegistration(pool, { providerAgentId: "9001",
        owner: approvalWallet("fixture owner"), agentWallet: approvalWallet("fixture agent wallet") });
      const before = await http.call("GET", "/public/v3/providers/9001/approval", undefined, null);
      await http.call("PUT", "/operator/v1/providers/9001/approval", { reason: "fixture" });
      // A fixed approval time, so the answer is the same bytes on every run.
      await pool.query("UPDATE standard_provider_approvals SET approved_at='2026-11-18T12:00:00Z' WHERE provider_agent_id='9001'");
      const after = await http.call("GET", "/public/v3/providers/9001/approval", undefined, null);
      expect(canonicalHash(after.body.record)).toBe(after.body.recordHash);
      expect(after.body.record).toEqual(built(registration).record);
      const fixture = {
        schemaVersion: 1,
        contract: "The gateway's public answer for a hosted provider's approval, GET /public/v3/providers/:agentId/approval " +
          "(no authentication; Cache-Control: public, max-age=10), before and after the provider was approved. " +
          "Synthetic: example hosts, label-derived wallets, a fixed approval time. Added by the gateway.",
        synthetic: true,
        owner: "daski-io/gateway",
        consumers: ["hosted provider runtimes that check approval records"],
        generator: "test/providerApprovalsPostgres.test.ts " +
          "(UPDATE_PROVIDER_APPROVAL_ANSWER=1 npx vitest run test/providerApprovalsPostgres.test.ts)",
        route: { method: "GET", path: "/public/v3/providers/:agentId/approval", cacheControl: PUBLIC_APPROVAL_CACHE_CONTROL },
        rules: [
          "approved is true only while the gateway sells the provider through its approval record: the provider holds a " +
            "current approval on the gateway's chain, approvals are on for the record's origin, and no servicing admission " +
            "or manifest profile names a control profile for the provider. Otherwise approved is false, with no other field.",
          "record is the ProviderControlProfileV1 envelope the gateway built when it approved the provider and stored; " +
            "signerKeyId is gateway-approval-v1, issuedAt and validBefore are 0 and signature is 0x: it is never signed.",
          "recordHash is the canonical hash of record exactly as served (canonicalHash in src/standardRail/canonical.ts: " +
            "keys sorted, no whitespace, keccak256), signature included. It is the providerControlProfileHash the " +
            "gateway's dispatches carry for the provider.",
          "environment, chainId and audience are those the gateway's manifest profiles carry. providerAudience, origin " +
            "and the six URLs are the provider card's standard-rail values as the gateway stored them; assetResponseKey " +
            "is the registration's agent wallet, checksummed; servicingProfileEpoch is one more than the highest epoch " +
            "of the provider's manifest profiles and earlier approval records, else 1, and never names two records.",
          "approvedAt is when the current approval was made (ISO 8601).",
        ],
        answers: [
          { name: "not approved", providerAgentId: "9001", answer: before.body },
          { name: "approved", providerAgentId: "9001", answer: after.body },
        ],
      };
      const serialized = `${JSON.stringify(fixture, null, 2)}\n`;
      if (update) writeFileSync(FIXTURE, serialized);
      expect(existsSync(FIXTURE), "run with UPDATE_PROVIDER_APPROVAL_ANSWER=1").toBe(true);
      expect(readFileSync(FIXTURE, "utf8")).toBe(serialized);
    } finally {
      await http.close();
    }
  });
});
