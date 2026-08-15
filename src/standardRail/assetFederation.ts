import { randomBytes } from "node:crypto";
import { getAddress, recoverMessageAddress, type Hex } from "viem";
import type { Pool } from "../db/pool.js";
import { artifactPayloadHash, canonicalHash } from "./canonical.js";
import type { StandardRailConfig } from "./config.js";
import { signEnvelope } from "./signing.js";
import type {
  ProviderAssetQueryResponseV1,
  ProviderServicingAdmissionV1,
  ProviderWalletActionGrantV1,
  SignedEnvelope,
  StandardListing,
  WalletAuthorizationTransport,
} from "./types.js";
import { utf8Hash, ZERO_HASH } from "./walletAuthorization.js";
import type { StandardWalletStore } from "./walletStore.js";
import { readBoundedJsonResponse } from "./boundedJson.js";
import { withFederationPermit } from "./federationPermit.js";

export interface ActiveServicing {
  admissionEnvelope: SignedEnvelope<ProviderServicingAdmissionV1>;
  admissionHash: Hex;
  listing: StandardListing;
}

function exact(value: unknown, keys: readonly string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid provider response");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("invalid provider response");
  }
}

export class StandardAssetFederation {
  private readonly activeAdmissions = new Map<string, SignedEnvelope<ProviderServicingAdmissionV1>>();

  constructor(
    private readonly pool: Pool,
    private readonly config: StandardRailConfig,
    private readonly chainId: number,
    private readonly wallet: StandardWalletStore,
    private readonly providerFetch: (
      listing: StandardListing,
      endpoint: string,
      init: RequestInit,
    ) => Promise<Response>,
    private readonly providerReputation?: (providerAgentId: string) => Promise<unknown>,
    private readonly permitPool: Pool = pool,
  ) {}

  async activateAdmissions(): Promise<void> {
    const grouped = new Map<string, Array<SignedEnvelope<ProviderServicingAdmissionV1>>>();
    for (const admission of this.config.manifest.servicingAdmissions) {
      const values = grouped.get(admission.payload.providerAgentId) ?? [];
      values.push(admission);
      grouped.set(admission.payload.providerAgentId, values);
    }
    for (const [providerAgentId, admissions] of grouped) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `standard:servicing-admission:${providerAgentId}`,
        ]);
        const current = await client.query<{
          admission_hash: Buffer;
          canonical_admission: SignedEnvelope<ProviderServicingAdmissionV1>;
        }>(
          `SELECT admission_hash,canonical_admission
             FROM standard_provider_servicing_admissions
            WHERE provider_agent_id=$1 AND current=true FOR UPDATE`,
          [providerAgentId],
        );
        let active = current.rows[0]?.canonical_admission ?? null;
        for (const admission of admissions.sort((left, right) =>
          left.payload.servicingProfileEpoch - right.payload.servicingProfileEpoch)) {
          const admissionHash = canonicalHash(admission);
          if (active && canonicalHash(active) === admissionHash) continue;
          if (active && admission.payload.servicingProfileEpoch <= active.payload.servicingProfileEpoch) {
            if (admission.payload.servicingProfileEpoch === active.payload.servicingProfileEpoch) {
              throw new Error("Servicing admission epoch conflicts with the activated admission");
            }
            continue;
          }
          if (
            (!active && (admission.payload.servicingProfileEpoch !== 1 ||
              admission.payload.previousAdmissionHash !== ZERO_HASH)) ||
            (active && (
              admission.payload.servicingProfileEpoch !== active.payload.servicingProfileEpoch + 1 ||
              admission.payload.previousAdmissionHash !== canonicalHash(active)
            ))
          ) throw new Error("Servicing admission chain is invalid");
          await client.query(
            `UPDATE standard_provider_servicing_admissions SET current=false
              WHERE provider_agent_id=$1 AND current=true`,
            [providerAgentId],
          );
          await client.query(
            `INSERT INTO standard_provider_servicing_admissions
              (provider_agent_id,admission_hash,profile_hash,canonical_admission,current,valid_before)
             VALUES ($1,$2,$3,$4,true,to_timestamp($5))
             ON CONFLICT (admission_hash) DO UPDATE SET current=true,
               canonical_admission=EXCLUDED.canonical_admission,
               valid_before=EXCLUDED.valid_before`,
            [providerAgentId, Buffer.from(admissionHash.slice(2), "hex"),
              Buffer.from(admission.payload.providerControlProfileHash.slice(2), "hex"),
              admission, admission.payload.validBefore],
          );
          active = admission;
        }
        if (!active || !admissions.some((item) => canonicalHash(item) === canonicalHash(active!))) {
          throw new Error("Current servicing admission is absent from the runtime release");
        }
        await client.query("COMMIT");
        this.activeAdmissions.set(providerAgentId, active);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally { client.release(); }
    }
  }

  async listAssets(args: {
    payer: string;
    providerAgentId: string | null;
    limit: number;
    cursor: string | null;
    authorization: WalletAuthorizationTransport;
  }) {
    const payer = getAddress(args.payer).toLowerCase() as Hex;
    const walletRequest = { providerAgentId: args.providerAgentId, limit: args.limit, cursor: args.cursor };
    const walletHash = await this.wallet.consume({
      authorization: args.authorization,
      action: "list-assets",
      request: walletRequest,
    });
    const eligible = await this.pool.query<{ provider_agent_id: string }>(
      `SELECT DISTINCT provider_agent_id FROM standard_orders
        WHERE lower(payer)=$1 AND state IN (
          'RELEASE_FINAL','DISPATCH_STARTED','DISPATCHED','DISPATCH_AMBIGUOUS',
          'FULFILLED','PROVIDER_FAILED','INPUT_REQUIRED','LEGAL_HOLD','REFUND_DUE',
          'REFUND_RESERVED','REFUND_INVOKED','REFUND_AMBIGUOUS','REFUNDED','NO_REFUND'
        ) AND ($2::text IS NULL OR provider_agent_id=$2)
        ORDER BY provider_agent_id LIMIT $3`,
      [payer, args.providerAgentId, this.config.abuse.federationMaxProviders],
    );
    const ids = eligible.rows.map((row) => row.provider_agent_id);
    const responses: Array<Record<string, unknown>> = [];
    responses.push(...await Promise.all(ids.map(async (providerAgentId) => {
      try {
        return await withFederationPermit({
          pool: this.permitPool,
          providerAgentId,
          providerLimit: this.config.abuse.federationPerProviderConcurrency,
          globalLimit: this.config.abuse.federationGlobalConcurrency,
          timeoutMs: this.config.dispatchTimeoutMs,
          work: () => this.queryProvider({
            providerAgentId,
            payer,
            request: { limit: args.limit, cursor: args.cursor },
            walletHash,
            authorization: args.authorization,
          }),
        });
      } catch {
        return { providerAgentId, availability: "unavailable", assets: [], nextCursor: null };
      }
    })));
    return {
      providers: responses,
      warning: responses.some((item) => item.availability === "unavailable")
        ? { code: "ASSET_PROVIDERS_PARTIALLY_UNAVAILABLE" }
        : null,
    };
  }

  activeServicing(providerAgentId: string): ActiveServicing | null {
    const now = Math.floor(Date.now() / 1_000);
    const admissionEnvelope = this.activeAdmissions.get(providerAgentId);
    if (!admissionEnvelope || !admissionEnvelope.payload.servicingEnabled ||
      admissionEnvelope.payload.validFrom > now || admissionEnvelope.payload.validBefore <= now) return null;
    const listing = this.config.manifest.listings.find((item) =>
      item.commitment.payload.providerAgentId === providerAgentId &&
      canonicalHash(item.providerControlProfile) === admissionEnvelope.payload.providerControlProfileHash
    );
    return listing ? {
      admissionEnvelope,
      admissionHash: canonicalHash(admissionEnvelope),
      listing,
    } : null;
  }

  private async queryProvider(args: {
    providerAgentId: string;
    payer: Hex;
    request: { limit: number; cursor: string | null };
    walletHash: Hex;
    authorization: WalletAuthorizationTransport;
  }): Promise<Record<string, unknown>> {
    const active = this.activeServicing(args.providerAgentId);
    if (!active) return { providerAgentId: args.providerAgentId, availability: "not-admitted", assets: [], nextCursor: null };
    try {
      await this.consumeFederationRate(args.providerAgentId);
      const grant = await this.createGrant(active, args);
      const response = await this.providerFetch(
        active.listing,
        active.listing.providerControlProfile.payload.assetQueryUrl,
        {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ request: args.request, authorization: args.authorization, grant }),
          signal: AbortSignal.timeout(active.listing.providerControlProfile.payload.timeoutMs),
          redirect: "error",
        },
      );
      if (!response.ok) throw new Error("provider unavailable");
      const envelope = await readBoundedJsonResponse(
        response,
        active.listing.providerControlProfile.payload.maxResponseBytes,
      ) as SignedEnvelope<ProviderAssetQueryResponseV1>;
      const payload = await this.verifyResponse(active, grant, envelope, args);
      return {
        providerAgentId: args.providerAgentId,
        availability: "available",
        reputation: this.providerReputation ? await this.providerReputation(args.providerAgentId) : null,
        assets: payload.assets,
        nextCursor: payload.nextCursor,
      };
    } catch {
      return { providerAgentId: args.providerAgentId, availability: "unavailable", assets: [], nextCursor: null };
    }
  }

  private async consumeFederationRate(providerAgentId: string): Promise<void> {
    for (const bucket of [
      {
        key: `standard-federation:provider:${providerAgentId}`,
        maximum: this.config.abuse.federationPerProviderPerMinute,
      },
      {
        key: "standard-federation:global",
        maximum: this.config.abuse.federationGlobalPerMinute,
      },
    ]) {
      const result = await this.pool.query<{ request_count: number }>(
        `INSERT INTO rate_limit_buckets(bucket_key,window_started_at,request_count)
         VALUES ($1,now(),1) ON CONFLICT (bucket_key) DO UPDATE SET
           window_started_at=CASE WHEN rate_limit_buckets.window_started_at<=now()-interval '1 minute'
             THEN now() ELSE rate_limit_buckets.window_started_at END,
           request_count=CASE WHEN rate_limit_buckets.window_started_at<=now()-interval '1 minute'
             THEN 1 ELSE rate_limit_buckets.request_count+1 END RETURNING request_count`,
        [bucket.key],
      );
      if ((result.rows[0]?.request_count ?? bucket.maximum + 1) > bucket.maximum) {
        throw new Error("federation rate limited");
      }
    }
  }

  private async createGrant(
    active: ActiveServicing,
    args: { providerAgentId: string; payer: Hex; request: unknown; walletHash: Hex;
      authorization: WalletAuthorizationTransport },
  ): Promise<SignedEnvelope<ProviderWalletActionGrantV1>> {
    const now = Math.floor(Date.now() / 1_000);
    const profile = active.listing.providerControlProfile.payload;
    return signEnvelope({
      artifactType: "ProviderWalletActionGrantV1",
      environment: this.config.environment,
      chainId: this.chainId,
      audience: profile.providerAudience,
      signerKeyId: "gateway-lifecycle",
      privateKey: this.config.lifecyclePrivateKey,
      issuedAt: now,
      validBefore: Math.min(now + 300, active.admissionEnvelope.payload.validBefore),
      payload: {
        payer: args.payer,
        providerAgentId: args.providerAgentId,
        serviceId: ZERO_HASH,
        actionHash: utf8Hash("list-assets"),
        methodHash: utf8Hash("POST"),
        absoluteResourceUriHash: args.authorization.message.absoluteResourceUriHash,
        requestHash: canonicalHash(args.request),
        walletAuthorizationHash: args.walletHash,
        providerControlProfileHash: active.admissionEnvelope.payload.providerControlProfileHash,
        servicingAdmissionHash: active.admissionHash,
        servicingProfileEpoch: active.admissionEnvelope.payload.servicingProfileEpoch,
        actionCatalogHash: ZERO_HASH,
        actionCatalogSchemaHash: ZERO_HASH,
        actionCatalogEpoch: 0,
        actionDefinitionHash: ZERO_HASH,
        gatewayAudienceHash: utf8Hash(this.config.gatewayAudience),
        providerAudienceHash: utf8Hash(profile.providerAudience),
        grantNonce: `0x${randomBytes(32).toString("hex")}`,
      },
    });
  }

  private async verifyResponse(
    active: ActiveServicing,
    grant: SignedEnvelope<ProviderWalletActionGrantV1>,
    envelope: SignedEnvelope<ProviderAssetQueryResponseV1>,
    args: { providerAgentId: string; payer: Hex; request: unknown; walletHash: Hex },
  ): Promise<ProviderAssetQueryResponseV1> {
    exact(envelope, ["artifactType", "schemaVersion", "environment", "chainId", "audience",
      "signerKeyId", "issuedAt", "validBefore", "payload", "signature"]);
    const profile = active.listing.providerControlProfile.payload;
    const now = Math.floor(Date.now() / 1_000);
    if (
      envelope.artifactType !== "ProviderAssetQueryResponseV1" ||
      envelope.schemaVersion !== 1 || envelope.issuedAt > now + 30 ||
      envelope.issuedAt >= envelope.validBefore || envelope.validBefore - envelope.issuedAt > 60 ||
      envelope.environment !== this.config.environment || envelope.chainId !== this.chainId ||
      envelope.audience !== this.config.gatewayAudience || envelope.signerKeyId !== profile.assetResponseKeyId ||
      envelope.validBefore <= now || envelope.validBefore > grant.validBefore
    ) throw new Error("invalid provider response");
    const recovered = await recoverMessageAddress({
      message: { raw: artifactPayloadHash(envelope as unknown as Record<string, unknown> & { signature?: Hex }) },
      signature: envelope.signature,
    });
    const payload = envelope.payload;
    exact(payload, ["providerAgentId", "payer", "assets", "nextCursor", "responseNonce",
      "requestHash", "walletAuthorizationHash", "grantHash", "providerControlProfileHash",
      "servicingAdmissionHash", "servicingProfileEpoch"]);
    if (
      getAddress(recovered) !== getAddress(profile.assetResponseKey) ||
      payload.providerAgentId !== args.providerAgentId || payload.payer !== args.payer ||
      payload.requestHash !== canonicalHash(args.request) || payload.walletAuthorizationHash !== args.walletHash ||
      payload.grantHash !== artifactPayloadHash(
        grant as unknown as Record<string, unknown> & { signature?: Hex },
      ) ||
      payload.providerControlProfileHash !== active.admissionEnvelope.payload.providerControlProfileHash ||
      payload.servicingAdmissionHash !== active.admissionHash ||
      payload.servicingProfileEpoch !== active.admissionEnvelope.payload.servicingProfileEpoch ||
      !(payload.nextCursor === null || (typeof payload.nextCursor === "string" &&
        payload.nextCursor.length >= 4 && payload.nextCursor.length <= 4096)) ||
      !/^0x[0-9a-fA-F]{64}$/.test(payload.responseNonce) || !Array.isArray(payload.assets) ||
      payload.assets.length > 100 || payload.assets.some((asset) => {
        try { exact(asset, ["providerAssetId", "serviceSlug", "type", "identifier", "status",
          "createdAt", "expiresAt"]); } catch { return true; }
        return !/^[0-9a-f-]{36}$/.test(asset.providerAssetId) ||
          [asset.serviceSlug, asset.type, asset.identifier, asset.status, asset.createdAt]
            .some((value) => typeof value !== "string" || value.length > 256) ||
          !(asset.expiresAt === null || (typeof asset.expiresAt === "string" && asset.expiresAt.length <= 64));
      })
    ) throw new Error("invalid provider response");
    return payload;
  }
}
