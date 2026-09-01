import { createHmac, randomBytes } from "node:crypto";
import { getAddress, type Hex } from "viem";
import type { PoolClient } from "pg";
import type { Pool } from "../db/pool.js";
import { canonicalHash } from "./canonical.js";
import type { StandardRailConfig } from "./config.js";
import { decryptCursor, encryptCursor, type CursorBinding } from "./cursor.js";
import type {
  WalletActionAuthorizationV1,
  WalletAuthorizationTransport,
} from "./types.js";
import {
  verifyWalletAuthorization,
  walletActionSignRequest,
  walletAuthorizationHash,
  ZERO_HASH,
  utf8Hash,
} from "./walletAuthorization.js";

const bytes = (value: Hex): Buffer => Buffer.from(value.slice(2), "hex");

export class StandardWalletStore {
  constructor(
    private readonly pool: Pool,
    private readonly config: StandardRailConfig,
    private readonly chainId: number,
  ) {}

  private normalizePayer(payer: string): Hex {
    return getAddress(payer).toLowerCase() as Hex;
  }

  async issue(args: {
    action: string;
    payer: string;
    request: unknown;
    absoluteResourceUri: string;
    clientKey: string;
    provider?: Partial<Pick<WalletActionAuthorizationV1,
      "providerAgentId" | "serviceId" | "providerControlProfileHash" |
      "servicingAdmissionHash" | "actionCatalogHash" | "actionCatalogSchemaHash" |
      "actionDefinitionHash" | "actionCatalogEpoch">>;
  }) {
    const payer = this.normalizePayer(args.payer);
    const clientKeyHash = createHmac("sha256", this.config.encryptionKey)
      .update("wallet-challenge-client\0")
      .update(args.clientKey)
      .digest();
    const now = Math.floor(Date.now() / 1_000);
    const message: WalletActionAuthorizationV1 = {
      payer,
      providerAgentId: args.provider?.providerAgentId ?? "0",
      serviceId: args.provider?.serviceId ?? ZERO_HASH,
      providerControlProfileHash: args.provider?.providerControlProfileHash ?? ZERO_HASH,
      servicingAdmissionHash: args.provider?.servicingAdmissionHash ?? ZERO_HASH,
      actionCatalogHash: args.provider?.actionCatalogHash ?? ZERO_HASH,
      actionCatalogSchemaHash: args.provider?.actionCatalogSchemaHash ?? ZERO_HASH,
      actionDefinitionHash: args.provider?.actionDefinitionHash ?? ZERO_HASH,
      actionCatalogEpoch: args.provider?.actionCatalogEpoch ?? 0,
      actionHash: utf8Hash(args.action),
      methodHash: utf8Hash("POST"),
      absoluteResourceUriHash: utf8Hash(args.absoluteResourceUri),
      requestHash: canonicalHash(args.request),
      audienceHash: utf8Hash(this.config.gatewayAudience),
      nonce: `0x${randomBytes(32).toString("hex")}`,
      issuedAt: now,
      validBefore: now + 300,
    };
    const client = await this.pool.connect();
    try {
      // Read committed under the advisory lock: the lock alone serializes the
      // cap check and the insert. SERIALIZABLE fixed the snapshot at the lock
      // statement — before the lock was granted — so concurrent issuers counted
      // from a stale snapshot and the loser could not commit (2026-09-01: an
      // intermittent, non-retryable WALLET_ACCESS_DENIED for parallel clients).
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "standard:wallet-challenge-cap",
      ]);
      await this.cleanupExpired(client);
      const outstanding = await client.query<{ client_count: string; global_count: string }>(
        `SELECT count(*) FILTER (WHERE client_key_hash=$1)::text AS client_count,
                count(*)::text AS global_count
           FROM (
             SELECT client_key_hash FROM standard_wallet_action_challenges
              WHERE consumed_at IS NULL AND valid_before>now()
             UNION ALL
             SELECT client_key_hash FROM standard_action_challenges
              WHERE consumed_at IS NULL AND valid_before>now()
           ) active`, [clientKeyHash]);
      if (Number(outstanding.rows[0]?.client_count ?? "0") >=
          this.config.abuse.walletChallengesOutstandingPerClient ||
        Number(outstanding.rows[0]?.global_count ?? "0") >=
          this.config.abuse.walletChallengesOutstandingGlobal) throw new Error("wallet authorization denied");
      await client.query(
        `INSERT INTO standard_wallet_action_challenges
          (nonce,client_key_hash,payer,action_hash,request_hash,canonical_authorization,issued_at,valid_before)
         VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7),to_timestamp($8))`,
        [bytes(message.nonce), clientKeyHash, payer, bytes(message.actionHash), bytes(message.requestHash), message,
          message.issuedAt, message.validBefore],
      );
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
    const challenge = {
      domain: { name: "DaskiStandardWallet", version: "1", chainId: this.chainId },
      primaryType: "WalletActionAuthorizationV1" as const,
      message,
    };
    return {
      ...challenge,
      signRequest: walletActionSignRequest(message, this.chainId),
    };
  }

  /**
   * Verify a signed challenge and bind it to the payer the current operation
   * targets. `payer` is the subject the caller intends to act for; it must
   * match the payer inside the signed authorization, otherwise a wallet that
   * legitimately signed for itself could be replayed against another wallet.
   * Callers must use the returned `payer` — never their own input — for every
   * subsequent query, claim, and provider grant.
   */
  async consume(args: {
    payer: string;
    authorization: WalletAuthorizationTransport;
    action: string;
    request: unknown;
    operationHash?: Hex;
    allowExactReplay?: boolean;
  }): Promise<{ payer: Hex; authorizationHash: Hex }> {
    const requestedPayer = this.normalizePayer(args.payer);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const nonce = bytes(args.authorization.message.nonce);
      const result = await client.query<{
        canonical_authorization: WalletActionAuthorizationV1;
        consumed_at: Date | null;
      }>(
        `SELECT canonical_authorization,consumed_at
           FROM standard_wallet_action_challenges WHERE nonce=$1 FOR UPDATE`,
        [nonce],
      );
      const row = result.rows[0];
      if (!row) throw new Error("wallet authorization denied");
      if (row.consumed_at && !args.allowExactReplay) throw new Error("wallet authorization denied");
      const expected = row.canonical_authorization;
      if (
        expected.actionHash !== utf8Hash(args.action) ||
        expected.requestHash !== canonicalHash(args.request) ||
        this.normalizePayer(expected.payer) !== requestedPayer
      ) throw new Error("wallet authorization denied");
      const authorizationHash = await verifyWalletAuthorization({
        authorization: args.authorization,
        expected,
        chainId: this.chainId,
      });
      const max = args.action === "list-assets"
        ? this.config.abuse.assetListsPerPayerPerMinute
        : args.action === "list-orders" || args.action === "get-buyer-reputation"
          ? this.config.abuse.protectedReadsPerPayerPerMinute
          : this.config.abuse.assetStateChangesPerPayerPerMinute;
      const rateScope = args.action === "list-assets" ? "asset-list"
        : args.action === "list-orders" || args.action === "get-buyer-reputation"
          ? "protected-read" : "asset-state-change";
      const bucket = canonicalHash({ scope: `wallet-action:${rateScope}`, payer: expected.payer });
      const rate = await client.query<{ request_count: number }>(
        `INSERT INTO rate_limit_buckets(bucket_key,window_started_at,request_count)
         VALUES ($1,now(),1) ON CONFLICT (bucket_key) DO UPDATE SET
           window_started_at=CASE WHEN rate_limit_buckets.window_started_at<=now()-interval '1 minute'
             THEN now() ELSE rate_limit_buckets.window_started_at END,
           request_count=CASE WHEN rate_limit_buckets.window_started_at<=now()-interval '1 minute'
             THEN 1 ELSE rate_limit_buckets.request_count+1 END RETURNING request_count`,
        [`standard-wallet:${bucket}`],
      );
      if ((rate.rows[0]?.request_count ?? max + 1) > max) throw new Error("WALLET_RATE_LIMITED");
      const operationHash = args.operationHash ?? canonicalHash({
        action: args.action,
        request: args.request,
        walletAuthorizationHash: authorizationHash,
      });
      const claimed = await client.query<{ authorization_hash: Buffer; operation_hash: Buffer }>(
        `INSERT INTO standard_wallet_action_nonces
          (payer,nonce,authorization_hash,operation_hash)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (payer,nonce) DO NOTHING
         RETURNING authorization_hash,operation_hash`,
        [expected.payer, nonce, bytes(authorizationHash), bytes(operationHash)],
      );
      const journal = claimed.rows[0] ?? (await client.query<{
        authorization_hash: Buffer;
        operation_hash: Buffer;
      }>(
        `SELECT authorization_hash,operation_hash FROM standard_wallet_action_nonces
          WHERE payer=$1 AND nonce=$2`,
        [expected.payer, nonce],
      )).rows[0];
      if (
        !journal || (!args.allowExactReplay && claimed.rowCount !== 1) ||
        `0x${journal.authorization_hash.toString("hex")}` !== authorizationHash ||
        `0x${journal.operation_hash.toString("hex")}` !== operationHash
      ) throw new Error("wallet authorization denied");
      await client.query(
        "UPDATE standard_wallet_action_challenges SET consumed_at=COALESCE(consumed_at,now()) WHERE nonce=$1",
        [nonce],
      );
      await client.query("COMMIT");
      return {
        payer: this.normalizePayer(expected.payer),
        authorizationHash: walletAuthorizationHash(expected, this.chainId),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async cleanupExpiredAuthorizations(): Promise<void> {
    const client = await this.pool.connect();
    try { await this.cleanupExpired(client); }
    finally { client.release(); }
  }

  private async cleanupExpired(client: PoolClient): Promise<void> {
    await client.query(
      "DELETE FROM standard_wallet_action_nonces WHERE consumed_at<now()-interval '10 minutes'",
    );
    await client.query(
      `DELETE FROM standard_wallet_action_challenges
        WHERE valid_before<now()-interval '5 minutes'
           OR consumed_at<now()-interval '5 minutes'`,
    );
  }

  orderCursorBinding(payer: string, limit: number, paymentIdentifier: string | null = null): CursorBinding {
    return {
      kind: "orders",
      environment: this.config.environment,
      chainId: this.chainId,
      issuer: this.config.gatewayAudience,
      audience: this.config.gatewayAudience,
      payer: this.normalizePayer(payer),
      providerAgentId: "0",
      queryHash: canonicalHash({
        kind: "orders",
        sort: "created_at_desc_order_id_desc",
        limit,
        ...(paymentIdentifier ? { paymentIdentifier } : {}),
      }),
    };
  }

  decodeOrderCursor(token: string, binding: CursorBinding) {
    return decryptCursor({ token, binding, keyRing: this.config.cursorKeyRing });
  }

  encodeOrderCursor(last: { createdAt: string; id: string }, binding: CursorBinding) {
    return encryptCursor({ last, binding, keyRing: this.config.cursorKeyRing });
  }
}
