import type { Pool } from "../db/pool.js";
import { logger } from "../util/logger.js";
import { postPinnedJson } from "./callbackNetwork.js";
import type { StandardRailConfig } from "./config.js";
import { decryptCallback } from "./notifications.js";

interface EventRow {
  event_id: string;
  subscription_id: string;
  signed_envelope: Record<string, unknown>;
  attempts: number;
  encrypted_callback_url: Buffer;
}

export class StandardNotificationWorker {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly pool: Pool, private readonly config: StandardRailConfig) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.schedule(), this.config.recoveryIntervalMs);
    this.timer.unref();
    this.schedule();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  private schedule(): void {
    if (this.running) return;
    this.running = this.tick()
      .catch((error) => logger.error("order notification recovery failed", { error }))
      .finally(() => { this.running = null; });
  }

  private async tick(): Promise<void> {
    await this.pool.query(
      `WITH expired AS (
         UPDATE standard_order_notification_subscriptions
            SET state='deleted',encrypted_callback_url=$1,updated_at=now()
          WHERE state='pending' AND challenge_expires_at<=now()
          RETURNING subscription_id
       )
       UPDATE standard_order_notification_events SET state='deleted',updated_at=now()
        WHERE subscription_id IN (SELECT subscription_id FROM expired) AND state<>'delivered'`,
      [Buffer.alloc(28)],
    );
    await this.pool.query(
      `DELETE FROM standard_confirmation_preparations
        WHERE consumed_at IS NULL AND expires_at<now()-interval '1 day'`,
    );
    for (let i = 0; i < 20; i += 1) {
      const result = await this.pool.query<EventRow>(
        `UPDATE standard_order_notification_events e SET state='delivering',updated_at=now()
          FROM standard_order_notification_subscriptions s
         WHERE e.event_id=(
           SELECT candidate.event_id FROM standard_order_notification_events candidate
             JOIN standard_order_notification_subscriptions active
               ON active.subscription_id=candidate.subscription_id AND active.state='active'
            WHERE candidate.state IN ('pending','delivering')
              AND (candidate.next_attempt_at IS NULL OR candidate.next_attempt_at<=now())
            ORDER BY candidate.created_at LIMIT 1 FOR UPDATE OF candidate SKIP LOCKED)
           AND s.subscription_id=e.subscription_id
         RETURNING e.event_id,e.subscription_id,e.signed_envelope,e.attempts,s.encrypted_callback_url`,
      );
      const event = result.rows[0];
      if (!event) return;
      await this.deliver(event);
    }
  }

  private async deliver(event: EventRow): Promise<void> {
    try {
      const url = decryptCallback(
        event.encrypted_callback_url,
        this.config.encryptionKey,
        event.subscription_id,
      );
      const response = await postPinnedJson({
        url,
        body: JSON.stringify(event.signed_envelope),
        timeoutMs: this.config.notification.verificationTimeoutMs,
        maxResponseBytes: this.config.notification.maxResponseBytes,
        responseMode: "ignore",
      });
      if (response.status < 200 || response.status >= 300) throw new Error("callback_rejected");
      await this.pool.query(
        `UPDATE standard_order_notification_events SET state='delivered',attempts=attempts+1,
           next_attempt_at=NULL,last_error_class=NULL,updated_at=now() WHERE event_id=$1`,
        [event.event_id],
      );
    } catch {
      const attempts = event.attempts + 1;
      const terminal = attempts >= this.config.notification.maxAttempts;
      const delay = terminal ? null : this.config.notification.retryDelaysSeconds[attempts - 1]!;
      await this.pool.query(
        `UPDATE standard_order_notification_events SET state=$2,attempts=$3,
           next_attempt_at=CASE WHEN $4::integer IS NULL THEN NULL
             ELSE now()+($4||' seconds')::interval END,
           last_error_class='delivery_failed',updated_at=now() WHERE event_id=$1`,
        [event.event_id, terminal ? "operator_attention" : "pending", attempts, delay],
      );
    }
  }
}
