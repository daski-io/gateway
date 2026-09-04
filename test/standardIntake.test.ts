import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { recoverMessageAddress, type Hex } from "viem";
import { getIntakeRequirements } from "../src/standardRail/intake.js";
import { canonicalHash, artifactPayloadHash } from "../src/standardRail/canonical.js";
import type { StandardListing } from "../src/standardRail/types.js";

const key = `0x${"11".repeat(32)}` as Hex;
const gateway = privateKeyToAccount(key);
const provider = privateKeyToAccount(`0x${"22".repeat(32)}`);
const schema = { type: "object", properties: { state: { type: "string" } } };
const listing = { runtimeCommitmentHash: canonicalHash(schema), requestSchema: schema,
  commitment: { payload: { outcomeId: "form", providerAgentId: "1", providerAuthorityKey: provider.address } },
  providerControlProfile: { payload: { providerAudience: "provider.example", quoteUrl: "https://provider.example/quote",
    timeoutMs: 5000, maxResponseBytes: 262144 } } } as unknown as StandardListing;

function discover(overrides: Record<string, unknown> = {}, signer = provider) {
  return getIntakeRequirements({ listing, request: { state: "WY" }, environment: "testnet", chainId: 84532,
    privateKey: key, timeoutMs: 5000, fetchProvider: async (url, init) => {
      expect(url).toBe("https://provider.example/quote");
      const request = JSON.parse(String(init.body)).request;
      expect(request.artifactType).toBe("ProviderIntakeRequestV1");
      const { signature: requestSignature, ...unsigned } = request;
      expect(await recoverMessageAddress({ message: { raw: artifactPayloadHash(unsigned) }, signature: requestSignature })).toBe(gateway.address);
      const now = Math.floor(Date.now() / 1000);
      const payload = { outcomeId: "form", listingManifestHash: listing.runtimeCommitmentHash,
        requestHash: canonicalHash({ state: "WY" }), requestSchema: schema, requiredFields: { contactEmail: { required: true } },
        selectorsRequired: ["entityType"], normalizedSelectors: { state: "WY" }, supported: null,
        fieldErrors: [{ path: "contactEmail", rule: "required", message: "Contact email is required." }],
        issuedAt: now, validBefore: now + 60, ...overrides };
      return Response.json({ ...payload, signature: await signer.signMessage({ message: { raw: canonicalHash(payload) } }) });
    } });
}

describe("signed provider intake discovery", () => {
  it("returns signed, bound contextual requirements via the admitted transport", async () => {
    expect(await discover()).toMatchObject({ providerAgentId: "1", outcomeId: "form", requestSchema: schema,
      selectorsRequired: ["entityType"], requiredFields: { contactEmail: { required: true } } });
  });
  it("rejects substitutions, altered schemas, expiry, malformed fields and the wrong authority", async () => {
    for (const patch of [{ outcomeId: "other" }, { requestHash: canonicalHash({}) }, { requestSchema: {} },
      { validBefore: 1 }, { supported: "yes" }, { fieldErrors: [{}] }]) {
      await expect(discover(patch)).rejects.toMatchObject({ code: "PROVIDER_INTAKE_UNAVAILABLE" });
    }
    await expect(discover({}, gateway)).rejects.toMatchObject({ code: "PROVIDER_INTAKE_UNAVAILABLE" });
  });
});
