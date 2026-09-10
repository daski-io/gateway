import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { baseSepolia } from "viem/chains";
import type { Hex } from "viem";
import { createPool, runMigrations } from "../src/db/pool.js";
import { StandardRailStore, type CreateDraftInput } from "../src/standardRail/store.js";
import { DirectReputationReader } from "../src/standardRail/reputationReader.js";
import type { StandardRailConfig } from "../src/standardRail/config.js";
import type { StandardListing } from "../src/standardRail/types.js";

const hash = (byte: string): Hex => `0x${byte.repeat(64)}` as Hex;
const address = `0x${"1".repeat(40)}` as Hex;
const databaseUrl = process.env.DATABASE_URL_TEST ??
  "postgresql://postgres:password@localhost:5433/daski_gateway_test";

describe("persisted Activity history", () => {
  it("reads checkout names and legacy skill IDs from real order snapshots after manifest replacement", async () => {
    const schema = `gateway_activity_${randomUUID().replaceAll("-", "")}`;
    const bootstrap = createPool({ connectionString: databaseUrl, max: 1 });
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    const pool = createPool({ connectionString: databaseUrl, searchPath: `${schema},public`, max: 2 });
    try {
      await runMigrations(pool);
      const store = new StandardRailStore(pool);
      const input: CreateDraftInput = {
        providerAgentId: "8327", outcomeId: "form-entity", bindingProfile: "recipe-bound-v2",
        listingManifestHash: hash("1"), providerOfferHash: hash("2"),
        listing: {
          commitment: { payload: { serviceId: hash("3") } },
          presentation: { serviceName: "Entity Formation", skillName: "Form Entity" },
        } as StandardListing,
        quoteHash: hash("4"), quote: {} as CreateDraftInput["quote"], orderNonce: hash("5"),
        intentId: `int_${randomUUID()}`, canonicalRequestHash: hash("6"), canonicalRequest: {},
        grossAmount: "27100000", railEpoch: "1", listingEpoch: "1",
        expiresAt: new Date(Date.now() + 600_000),
      };
      const first = await store.createDraft(input);
      input.listing.presentation = { serviceName: "Renamed Service", skillName: "Renamed Skill" };
      const retry = await store.createDraft(input);
      expect(retry.order.orderId).toBe(first.order.orderId);
      expect(retry.order.listing.presentation).toEqual({ serviceName: "Entity Formation", skillName: "Form Entity" });
      delete input.listing.presentation;
      const legacy = await store.createDraft({ ...input, intentId: `int_${randomUUID()}`, orderNonce: hash("7"), canonicalRequestHash: hash("8") });
      const keys = [first.order.orderKey, legacy.order.orderKey];
      const reader = new DirectReputationReader({
        evidenceRpcUrls: ["https://rpc.example"], reputationContract: address,
      } as unknown as StandardRailConfig, baseSepolia, pool, { agentIndex: address, identityRegistry: address });
      const client = {
        getBlock: async () => ({ number: 123n }),
        readContract: async () => 2n,
        multicall: async ({ contracts }: { contracts: Array<{ functionName: string }> }) =>
          contracts.map(({ functionName }, index) => {
            if (functionName === "recordKeys") return keys[index];
            if (functionName === "refundedAmount") return 0n;
            if (functionName === "resolve") return { status: "success", result: [0n, false] };
            if (functionName === "getRecord") return {
              orderKey: keys[index], providerAgentId: 8327n, serviceId: hash("3"),
              listingManifestHash: hash("1"), payer: address, grossAmount: 27_100_000n,
              paidAt: 1_700_000_000n + BigInt(index), outcome: 0, confirmation: 0,
              outcomeAttestationDelay: 0n, outcomeRecorded: false, reputationEligible: true,
            };
            throw new Error(`unexpected multicall ${functionName}`);
          }),
      };
      Object.assign(reader, { clients: [{ host: "rpc.example", client }] });
      const snapshot = await reader.forOutcomes([{
        providerAgentId: "8327", serviceId: hash("3"),
        outcomeId: "renew-registered-agent", listingManifestHash: hash("9"),
      }]);
      const purchases = snapshot.services.get(hash("3"))!.recentPurchases;
      expect(purchases.map((purchase) => purchase.outcomeId)).toEqual(["form-entity", "form-entity"]);
      expect(purchases[1]).toMatchObject({ serviceName: "Entity Formation", skillName: "Form Entity" });
      expect(purchases[0]!.skillName).toBeUndefined();
    } finally {
      await pool.end();
      await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`);
      await bootstrap.end();
    }
  }, 60_000);
});
