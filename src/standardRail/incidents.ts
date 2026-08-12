import { randomUUID } from "node:crypto";
import type { Pool } from "../db/pool.js";
import type { StandardOrderRecord } from "./types.js";

export class StandardRailIncidentStore {
  constructor(private readonly pool: Pool) {}

  async recordRecoveryApprovalExpiry(order: StandardOrderRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO standard_security_incidents(
         incident_id,incident_kind,order_id,state,details
       ) VALUES ($1,'recovery_approval_expired',$2,$3,$4)
       ON CONFLICT (incident_kind,order_id) DO NOTHING`,
      [randomUUID(), order.orderId, order.state, {
        railEpoch: order.railEpoch,
        runtimeEpoch: order.runtimeEpoch,
      }],
    );
  }

  async record(args: {
    kind: string;
    orderId: string;
    state: string;
    details?: Record<string, unknown>;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO standard_security_incidents(
         incident_id,incident_kind,order_id,state,details
       ) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (incident_kind,order_id) DO NOTHING`,
      [randomUUID(), args.kind, args.orderId, args.state, args.details ?? {}],
    );
  }
}
