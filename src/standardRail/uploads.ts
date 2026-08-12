import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Pool } from "../db/pool.js";
import { logger } from "../util/logger.js";
import type { StandardRailConfig } from "./config.js";
import type { StandardAttachmentRef } from "./types.js";

const digest = (value: Buffer): `0x${string}` =>
  `0x${createHash("sha256").update(value).digest("hex")}`;
const sessionDigest = (token: string): Buffer => createHash("sha256").update(token).digest();

async function readBoundedBody(body: unknown, maximumBytes: number): Promise<Buffer> {
  if (!body || typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== "function") {
    throw new Error("BOUND_ATTACHMENT_BODY_INVALID");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of body as AsyncIterable<Uint8Array>) {
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > maximumBytes) throw new Error("BOUND_ATTACHMENT_BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

export class StandardUploadService {
  private readonly client: S3Client;

  constructor(private readonly config: StandardRailConfig, private readonly pool: Pool) {
    this.client = new S3Client({
      endpoint: config.objectStore.endpoint,
      region: config.objectStore.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.objectStore.accessKeyId,
        secretAccessKey: config.objectStore.secretAccessKey,
      },
    });
  }

  async issue(): Promise<Record<string, unknown>> {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + this.config.uploadPolicy.ttlSeconds * 1_000);
    const policy = { ...this.config.uploadPolicy };
    await this.pool.query(
      `INSERT INTO standard_upload_sessions(session_hash,audience,policy,expires_at)
       VALUES ($1,$2,$3,$4)`,
      [sessionDigest(token), this.config.gatewayAudience, policy, expiresAt],
    );
    return {
      artifactType: "UploadCapabilityV1",
      capability: token,
      audience: this.config.gatewayAudience,
      policy,
      expiresAt: Math.floor(expiresAt.getTime() / 1_000),
    };
  }

  async put(args: {
    capability: string;
    objectId?: string;
    mediaType: string;
    contentBase64: string;
    contentHash: string;
  }): Promise<StandardAttachmentRef> {
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(args.capability)) throw new Error("UPLOAD_CAPABILITY_INVALID");
    const objectId = args.objectId ?? randomUUID();
    if (!/^[A-Za-z0-9._-]{1,96}$/.test(objectId)) throw new Error("UPLOAD_OBJECT_ID_INVALID");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(args.contentBase64)) throw new Error("UPLOAD_ENCODING_INVALID");
    const content = Buffer.from(args.contentBase64, "base64");
    if (content.length === 0 || content.length > this.config.uploadPolicy.maxObjectBytes) {
      throw new Error("UPLOAD_OBJECT_SIZE_INVALID");
    }
    const mediaType = args.mediaType.toLowerCase();
    if (!this.config.uploadPolicy.allowedMediaTypes.includes(mediaType)) throw new Error("UPLOAD_MEDIA_TYPE_FORBIDDEN");
    const contentHash = digest(content);
    if (contentHash.toLowerCase() !== args.contentHash.toLowerCase()) throw new Error("UPLOAD_HASH_MISMATCH");
    const sessionHash = sessionDigest(args.capability);
    const storageKey = `standard-rail/${sessionHash.toString("hex")}/${randomUUID()}`;
    await this.pool.query(
      `INSERT INTO standard_upload_attempts(storage_key,session_hash,object_id)
       VALUES ($1,$2,$3)`,
      [storageKey, sessionHash, objectId],
    );
    const client = await this.pool.connect();
    let uploaded = false;
    let committed = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const session = await client.query<{ expires_at: Date; consumed_at: Date | null; bound_order_id: string | null }>(
        "SELECT expires_at,consumed_at,bound_order_id FROM standard_upload_sessions WHERE session_hash=$1 FOR UPDATE",
        [sessionHash],
      );
      const found = session.rows[0];
      if (!found || found.consumed_at || found.bound_order_id || found.expires_at <= new Date()) {
        throw new Error("UPLOAD_CAPABILITY_INVALID_OR_CONSUMED");
      }
      const totals = await client.query<{ count: string; bytes: string }>(
        `SELECT count(*)::text AS count,COALESCE(sum(byte_size),0)::text AS bytes
         FROM standard_upload_objects WHERE session_hash=$1 AND object_id<>$2`,
        [sessionHash, objectId],
      );
      if (
        Number(totals.rows[0]!.count) >= this.config.uploadPolicy.maxObjects ||
        BigInt(totals.rows[0]!.bytes) + BigInt(content.length) > BigInt(this.config.uploadPolicy.maxAggregateBytes)
      ) throw new Error("UPLOAD_SESSION_QUOTA_EXCEEDED");
      await this.client.send(new PutObjectCommand({
        Bucket: this.config.objectStore.bucket,
        Key: storageKey,
        Body: content,
        ContentType: "application/octet-stream",
        ServerSideEncryption: "AES256",
        Metadata: { sha256: contentHash.slice(2), declared: mediaType },
      }), { abortSignal: AbortSignal.timeout(30_000) });
      uploaded = true;
      const previous = await client.query<{ storage_key: string }>(
        "SELECT storage_key FROM standard_upload_objects WHERE session_hash=$1 AND object_id=$2 FOR UPDATE",
        [sessionHash, objectId],
      );
      if (previous.rows[0]) {
        await client.query(
          `INSERT INTO standard_upload_attempts(storage_key,session_hash,object_id)
           VALUES ($1,$2,$3)`,
          [previous.rows[0].storage_key, sessionHash, objectId],
        );
      }
      const stored = await client.query(
        `INSERT INTO standard_upload_objects
          (object_id,session_hash,content_hash,media_type,byte_size,storage_key,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (session_hash,object_id) DO UPDATE SET content_hash=EXCLUDED.content_hash,
           media_type=EXCLUDED.media_type,byte_size=EXCLUDED.byte_size,
           storage_key=EXCLUDED.storage_key,expires_at=EXCLUDED.expires_at`,
        [objectId, sessionHash, Buffer.from(contentHash.slice(2), "hex"), mediaType, content.length, storageKey, found.expires_at],
      );
      if (stored.rowCount !== 1) throw new Error("UPLOAD_OBJECT_ID_CONFLICT");
      await client.query("DELETE FROM standard_upload_attempts WHERE storage_key=$1", [storageKey]);
      await client.query("COMMIT");
      committed = true;
      if (previous.rows[0]) {
        await this.deleteKey(previous.rows[0].storage_key).then(
          () => this.pool.query(
            "DELETE FROM standard_upload_attempts WHERE storage_key=$1",
            [previous.rows[0]!.storage_key],
          ),
          (error) => {
            logger.error("standard upload replacement cleanup failed", { error });
          },
        );
      }
      return {
        objectId,
        contentHash,
        byteSize: content.length,
        mediaType,
        expiresAt: Math.floor(found.expires_at.getTime() / 1_000),
      };
    } catch (error) {
      if (!committed) {
        await client.query("ROLLBACK");
        if (!uploaded) {
          await this.pool.query("DELETE FROM standard_upload_attempts WHERE storage_key=$1", [storageKey])
            .catch(() => undefined);
        } else {
          await this.deleteKey(storageKey).then(
            () => this.pool.query("DELETE FROM standard_upload_attempts WHERE storage_key=$1", [storageKey]),
            () => undefined,
          );
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async remove(capability: string, objectId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ storage_key: string }>(
        `SELECT o.storage_key FROM standard_upload_objects o
          JOIN standard_upload_sessions s USING(session_hash)
         WHERE o.object_id=$1 AND s.session_hash=$2
           AND s.consumed_at IS NULL AND s.bound_order_id IS NULL AND s.expires_at>now()
         FOR UPDATE OF o,s`,
        [objectId, sessionDigest(capability)],
      );
      if (!result.rows[0]) throw new Error("UPLOAD_OBJECT_NOT_MUTABLE");
      await this.deleteKey(result.rows[0].storage_key);
      await client.query(
        "DELETE FROM standard_upload_objects WHERE object_id=$1 AND session_hash=$2 AND storage_key=$3",
        [objectId, sessionDigest(capability), result.rows[0].storage_key],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async capabilityBindsOrder(capability: string, orderId: string): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(capability)) return false;
    const result = await this.pool.query(
      `SELECT 1 FROM standard_upload_sessions
        WHERE session_hash=$1 AND bound_order_id=$2 AND consumed_at IS NOT NULL`,
      [sessionDigest(capability), orderId],
    );
    return result.rowCount === 1;
  }

  async boundContent(orderId: string, references: StandardAttachmentRef[]): Promise<Array<StandardAttachmentRef & { contentBase64: string }>> {
    const result: Array<StandardAttachmentRef & { contentBase64: string }> = [];
    for (const reference of references) {
      const row = await this.pool.query<{ content_hash: Buffer; media_type: string; byte_size: string; expires_at: Date; storage_key: string }>(
        `SELECT o.content_hash,o.media_type,o.byte_size::text,o.expires_at,o.storage_key
         FROM standard_upload_objects o JOIN standard_upload_sessions s USING(session_hash)
         WHERE o.object_id=$1 AND s.bound_order_id=$2 AND s.consumed_at IS NOT NULL`,
        [reference.objectId, orderId],
      );
      const found = row.rows[0];
      if (!found) throw new Error("BOUND_ATTACHMENT_MISSING");
      const response = await this.client.send(new GetObjectCommand({
        Bucket: this.config.objectStore.bucket,
        Key: found.storage_key,
        Range: `bytes=0-${reference.byteSize}`,
      }), { abortSignal: AbortSignal.timeout(30_000) });
      if (response.ContentLength !== reference.byteSize || !response.Body) {
        throw new Error("BOUND_ATTACHMENT_LENGTH_MISMATCH");
      }
      const content = await readBoundedBody(response.Body, reference.byteSize);
      if (
        digest(content).toLowerCase() !== reference.contentHash.toLowerCase() ||
        content.length !== reference.byteSize || found.media_type !== reference.mediaType
      ) throw new Error("BOUND_ATTACHMENT_INTEGRITY_FAILURE");
      result.push({ ...reference, contentBase64: content.toString("base64") });
    }
    return result;
  }

  async cleanupExpired(): Promise<void> {
    const abandoned = await this.pool.query<{ storage_key: string }>(
      `SELECT storage_key FROM standard_upload_attempts
        WHERE created_at<=now()-interval '15 minutes' ORDER BY created_at LIMIT 100`,
    );
    for (const attempt of abandoned.rows) {
      try {
        await this.deleteKey(attempt.storage_key);
        await this.pool.query(
          "DELETE FROM standard_upload_attempts WHERE storage_key=$1",
          [attempt.storage_key],
        );
      } catch (error) {
        logger.error("standard abandoned upload cleanup failed", { error });
      }
    }
    const disposable = await this.pool.query<{ order_id: string }>(
      `SELECT DISTINCT s.bound_order_id AS order_id
         FROM standard_upload_sessions s JOIN standard_orders o ON o.order_id=s.bound_order_id
        WHERE s.bound_order_id IS NOT NULL
          AND (o.provider_task_id IS NOT NULL OR o.state IN ('NO_REFUND','REFUNDED','LEGAL_HOLD'))
        LIMIT 100`,
    );
    for (const { order_id: orderId } of disposable.rows) {
      await this.cleanupBound(orderId).catch((error) => {
        logger.error("standard bound upload cleanup failed", { orderId, error });
      });
    }
    const expired = await this.pool.query<{ object_id: string; storage_key: string }>(
      `SELECT object_id,storage_key FROM standard_upload_objects
       WHERE expires_at<=now() AND session_hash IN (
         SELECT session_hash FROM standard_upload_sessions WHERE bound_order_id IS NULL
       ) ORDER BY expires_at LIMIT 100`,
    );
    for (const object of expired.rows) {
      try {
        await this.deleteKey(object.storage_key);
        await this.pool.query(
          "DELETE FROM standard_upload_objects WHERE object_id=$1 AND storage_key=$2",
          [object.object_id, object.storage_key],
        );
      } catch (error) {
        logger.error("standard upload expiry cleanup failed", { error });
      }
    }
    await this.pool.query(
      `DELETE FROM standard_upload_sessions s WHERE s.expires_at<=now()
       AND s.bound_order_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM standard_upload_objects o WHERE o.session_hash=s.session_hash)`,
    );
  }

  async cleanupBound(orderId: string): Promise<void> {
    const objects = await this.pool.query<{ object_id: string; storage_key: string }>(
      `SELECT o.object_id,o.storage_key
         FROM standard_upload_objects o JOIN standard_upload_sessions s USING(session_hash)
        WHERE s.bound_order_id=$1`,
      [orderId],
    );
    for (const object of objects.rows) {
      await this.deleteKey(object.storage_key);
      await this.pool.query(
        `DELETE FROM standard_upload_objects o USING standard_upload_sessions s
          WHERE o.object_id=$1 AND o.storage_key=$2 AND o.session_hash=s.session_hash
            AND s.bound_order_id=$3`,
        [object.object_id, object.storage_key, orderId],
      );
    }
    await this.pool.query(
      `DELETE FROM standard_upload_sessions s WHERE s.bound_order_id=$1
        AND NOT EXISTS (SELECT 1 FROM standard_upload_objects o WHERE o.session_hash=s.session_hash)`,
      [orderId],
    );
  }

  private async deleteKey(storageKey: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.config.objectStore.bucket,
      Key: storageKey,
    }), { abortSignal: AbortSignal.timeout(30_000) });
  }
}
