import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { getAddress, keccak256, recoverMessageAddress, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Pool } from "../db/pool.js";
import { canonicalHash } from "./canonical.js";
import { normalizeCallbackUrl, postPinnedJson } from "./callbackNetwork.js";
import type { StandardRailConfig } from "./config.js";
import { signEnvelope } from "./signing.js";
import type { StandardOrderRecord } from "./types.js";

export interface OrderEventPayload {
  eventId: string;
  subscriptionId: string;
  callbackAudienceHash: Hex;
  orderHandle: string;
  state: string;
  reasonClass: string;
  eventTime: number;
  sequence: number;
}

export function retainedPreviousNotificationKeys<T extends { notAfter: number }>(
  keys: readonly T[],
  retryWindowSeconds: number,
  nowSeconds: number,
): T[] {
  return keys.filter((key) => key.notAfter + retryWindowSeconds >= nowSeconds);
}

export function encryptCallback(value: string, key: Buffer, id: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`order-notification:${id}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptCallback(value: Buffer, key: Buffer, id: string): string {
  const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
  decipher.setAAD(Buffer.from(`order-notification:${id}`, "utf8"));
  decipher.setAuthTag(value.subarray(12, 28));
  return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8");
}

function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("NOTIFICATION_INVALID");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) {
    throw new Error("NOTIFICATION_INVALID");
  }
}

export class StandardNotifications {
  constructor(private readonly pool: Pool, private readonly config: StandardRailConfig,
    private readonly chainId: number) {}

  async handle(order: StandardOrderRecord,
    action: "notification-set" | "notification-get" | "notification-delete",
    request: Record<string, unknown>) {
    if (action === "notification-set") return this.set(order, request);
    exact(request, []);
    if (action === "notification-delete") return this.delete(order);
    return this.get(order);
  }

  async signEvent(payload: OrderEventPayload) {
    const retryWindow = this.config.notification.retryDelaysSeconds.reduce((sum, value) => sum + value, 0);
    return signEnvelope({ artifactType: "DaskiOrderEventV1", environment: this.config.environment,
      chainId: this.chainId, audience: `daski-order-callback:${payload.callbackAudienceHash}`,
      signerKeyId: this.config.notification.keyId, privateKey: this.config.notification.privateKey,
      issuedAt: payload.eventTime, validBefore: payload.eventTime + retryWindow + 3_600, payload });
  }

  async keySet(publicUrl: string) {
    const now = Math.floor(Date.now() / 1_000);
    const retryWindow = this.config.notification.retryDelaysSeconds.reduce((sum, value) => sum + value, 0);
    const keys = [{
      keyId: this.config.notification.keyId,
      address: privateKeyToAccount(this.config.notification.privateKey).address,
      algorithm: "secp256k1-eip191-keccak256-rfc8785-v1",
      notBefore: now - 300,
      notAfter: now + 31_536_000,
    }, ...retainedPreviousNotificationKeys(this.config.notification.previousKeys, retryWindow, now)
      .map((key) => ({
        ...key,
        algorithm: "secp256k1-eip191-keccak256-rfc8785-v1" as const,
      }))].sort((left, right) => left.keyId.localeCompare(right.keyId));
    const payload = { activeKeyId: this.config.notification.keyId, keys,
      discoveryUrl: `${publicUrl.replace(/\/$/, "")}/.well-known/daski-order-events.json` };
    return signEnvelope({ artifactType: "DaskiOrderEventKeySetV1", environment: this.config.environment,
      chainId: this.chainId, audience: "daski-order-event-key-discovery", signerKeyId: "gateway-release",
      privateKey: this.config.releasePrivateKey, issuedAt: now, validBefore: now + 86_400, payload });
  }

  private async set(order: StandardOrderRecord, request: Record<string, unknown>) {
    exact(request, ["callbackUrl", "subscriberVerificationAddress"]);
    if (typeof request.callbackUrl !== "string" || !(request.subscriberVerificationAddress === null ||
      (typeof request.subscriberVerificationAddress === "string" &&
        /^0x[0-9a-fA-F]{40}$/.test(request.subscriberVerificationAddress)))) {
      throw new Error("NOTIFICATION_INVALID");
    }
    const callback = normalizeCallbackUrl(request.callbackUrl);
    const audienceHash = keccak256(toHex(callback.canonical));
    const challenge = `0x${randomBytes(32).toString("hex")}` as Hex;
    const challengeHash = canonicalHash({ challenge });
    let subscriptionId: string = randomUUID();
    const subscriber = request.subscriberVerificationAddress === null ? null :
      getAddress(request.subscriberVerificationAddress as string).toLowerCase();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["notification-pending"]);
      const current = await client.query<{ subscription_id: string }>(
        "SELECT subscription_id FROM standard_order_notification_subscriptions WHERE order_id=$1 FOR UPDATE",
        [order.orderId],
      );
      subscriptionId = current.rows[0]?.subscription_id ?? subscriptionId;
      const counts = await client.query<{ payer_count: string; global_count: string }>(
        `SELECT count(*) FILTER (WHERE payer=$1 AND state='pending' AND challenge_expires_at>now())::text AS payer_count,
                count(*) FILTER (WHERE state='pending' AND challenge_expires_at>now())::text AS global_count
           FROM standard_order_notification_subscriptions`, [order.payer!.toLowerCase()]);
      if (Number(counts.rows[0]?.payer_count ?? "0") >= this.config.notification.maxPendingPerPayer ||
        Number(counts.rows[0]?.global_count ?? "0") >= this.config.notification.maxPendingGlobal) {
        throw new Error("NOTIFICATION_LIMIT");
      }
      await client.query(
        `UPDATE standard_order_notification_events SET state='deleted',updated_at=now()
          WHERE subscription_id=$1 AND state IN ('pending','delivering','operator_attention')`,
        [subscriptionId],
      );
      await client.query(
        `INSERT INTO standard_order_notification_subscriptions
          (subscription_id,order_id,payer,callback_audience_hash,callback_display_origin,
           encrypted_callback_url,subscriber_verification_address,challenge_hash,state,challenge_expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',now()+($9||' seconds')::interval)
         ON CONFLICT (order_id) DO UPDATE SET payer=EXCLUDED.payer,
           callback_audience_hash=EXCLUDED.callback_audience_hash,callback_display_origin=EXCLUDED.callback_display_origin,
           encrypted_callback_url=EXCLUDED.encrypted_callback_url,
           subscriber_verification_address=EXCLUDED.subscriber_verification_address,
           challenge_hash=EXCLUDED.challenge_hash,state='pending',challenge_expires_at=EXCLUDED.challenge_expires_at,
           verified_at=NULL,updated_at=now()`,
        [subscriptionId, order.orderId, order.payer!.toLowerCase(), Buffer.from(audienceHash.slice(2), "hex"),
          callback.displayOrigin, encryptCallback(callback.canonical, this.config.encryptionKey, subscriptionId),
          subscriber, Buffer.from(challengeHash.slice(2), "hex"), this.config.notification.verificationTtlSeconds]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
    const responseCore = { subscriptionId, callbackAudienceHash: audienceHash, challenge,
      subscriberVerificationAddress: subscriber };
    const now = Math.floor(Date.now() / 1_000);
    const envelope = await signEnvelope({ artifactType: "DaskiOrderEndpointChallengeV1",
      environment: this.config.environment, chainId: this.chainId,
      audience: `daski-order-callback:${audienceHash}`, signerKeyId: "gateway-release",
      privateKey: this.config.releasePrivateKey, issuedAt: now,
      validBefore: now + this.config.notification.verificationTtlSeconds, payload: responseCore });
    try {
      const response = await postPinnedJson({ url: callback.canonical, body: JSON.stringify(envelope),
        timeoutMs: this.config.notification.verificationTimeoutMs,
        maxResponseBytes: this.config.notification.maxResponseBytes });
      if (response.status < 200 || response.status >= 300) throw new Error("NOTIFICATION_VERIFICATION_FAILED");
      exact(response.value, [...Object.keys(responseCore), "subscriberSignature"]);
      const value = response.value;
      for (const [key, expected] of Object.entries(responseCore)) {
        if (value[key] !== expected) throw new Error("NOTIFICATION_VERIFICATION_FAILED");
      }
      if (subscriber === null ? value.subscriberSignature !== null :
        typeof value.subscriberSignature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(value.subscriberSignature)) {
        throw new Error("NOTIFICATION_VERIFICATION_FAILED");
      }
      if (subscriber) {
        const signer = await recoverMessageAddress({ message: { raw: canonicalHash(responseCore) },
          signature: value.subscriberSignature as Hex });
        if (getAddress(signer) !== getAddress(subscriber)) throw new Error("NOTIFICATION_VERIFICATION_FAILED");
      }
      const activated = await this.pool.query(
        `UPDATE standard_order_notification_subscriptions SET state='active',verified_at=now(),updated_at=now()
          WHERE subscription_id=$1 AND state='pending' AND challenge_hash=$2 AND challenge_expires_at>now()`,
        [subscriptionId, Buffer.from(challengeHash.slice(2), "hex")]);
      if (activated.rowCount !== 1) throw new Error("NOTIFICATION_VERIFICATION_FAILED");
    } catch (error) {
      await this.pool.query(
        `UPDATE standard_order_notification_subscriptions
            SET state='deleted',encrypted_callback_url=$2,updated_at=now()
          WHERE subscription_id=$1 AND state='pending' AND challenge_hash=$3`,
        [subscriptionId, Buffer.alloc(28), Buffer.from(challengeHash.slice(2), "hex")],
      );
      throw error;
    }
    return { subscriptionId, state: "active", callbackAudienceHash: audienceHash,
      callbackOrigin: callback.displayOrigin, subscriberVerificationAddress: subscriber,
      signingKey: this.signingMetadata() };
  }

  private async get(order: StandardOrderRecord) {
    const result = await this.pool.query<{ subscription_id: string; state: string;
      callback_audience_hash: Buffer; callback_display_origin: string;
      subscriber_verification_address: string | null; verified_at: Date | null }>(
      `SELECT subscription_id,state,callback_audience_hash,callback_display_origin,
              subscriber_verification_address,verified_at
         FROM standard_order_notification_subscriptions WHERE order_id=$1 AND state<>'deleted'`,
      [order.orderId]);
    const row = result.rows[0];
    if (!row) return { subscription: null };
    const events = await this.pool.query<{ event_id: string; sequence: string; state: string;
      canonical_event: OrderEventPayload }>(
      `SELECT event_id,sequence,state,canonical_event FROM standard_order_notification_events
        WHERE subscription_id=$1 AND state<>'deleted' ORDER BY sequence DESC LIMIT 25`, [row.subscription_id]);
    return { subscription: { subscriptionId: row.subscription_id, state: row.state,
      callbackAudienceHash: `0x${row.callback_audience_hash.toString("hex")}`,
      callbackOrigin: row.callback_display_origin,
      subscriberVerificationAddress: row.subscriber_verification_address,
      verifiedAt: row.verified_at?.toISOString() ?? null, signingKey: this.signingMetadata() },
      events: events.rows.map((event) => ({ eventId: event.event_id, sequence: event.sequence,
        state: event.state, orderState: event.canonical_event.state,
        eventTime: event.canonical_event.eventTime })) };
  }

  private async delete(order: StandardOrderRecord) {
    const blank = Buffer.alloc(28);
    await this.pool.query(
      `WITH removed AS (UPDATE standard_order_notification_subscriptions
         SET state='deleted',encrypted_callback_url=$2,updated_at=now()
         WHERE order_id=$1 AND state<>'deleted' RETURNING subscription_id)
       UPDATE standard_order_notification_events SET state='deleted',updated_at=now()
        WHERE subscription_id IN (SELECT subscription_id FROM removed) AND state<>'delivered'`,
      [order.orderId, blank]);
    return { deleted: true };
  }

  private signingMetadata() {
    return { keyId: this.config.notification.keyId,
      address: privateKeyToAccount(this.config.notification.privateKey).address,
      algorithm: "secp256k1-eip191-keccak256-rfc8785-v1",
      discoveryPath: "/.well-known/daski-order-events.json" };
  }
}
