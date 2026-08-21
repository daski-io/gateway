import type { Pool } from "../db/pool.js";

interface OperationalSummary {
  pending: number;
  attention: number;
  aborted: number;
  blocked: number;
  exhausted: number;
  oldest_pending_seconds: number;
}

interface GroupCount {
  key: string;
  count: number;
}

function keyedCounts(rows: GroupCount[]): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.key, row.count]));
}

export interface ReputationAccountHealthReader {
  accountHealth(): Promise<unknown>;
}

export class StandardOperationalHealth {
  constructor(
    private readonly pool: Pool,
    private readonly reputation: ReputationAccountHealthReader,
  ) {}

  async read() {
    const [operations, operationCauses, oldestByKind, transactionStates, relayer] =
      await Promise.all([
        this.pool.query<OperationalSummary>(
          `SELECT count(*) FILTER (WHERE state IN ('pending','broadcast'))::int AS pending,
                  count(*) FILTER (WHERE state='operator_attention')::int AS attention,
                  count(*) FILTER (WHERE state='aborted_unattested')::int AS aborted,
                  count(*) FILTER (WHERE state='blocked_parent_aborted')::int AS blocked,
                  count(*) FILTER (WHERE state='operator_attention' AND attempts>=5)::int AS exhausted,
                  COALESCE(extract(epoch FROM now()-min(created_at) FILTER
                    (WHERE state IN ('pending','broadcast'))),0)::int AS oldest_pending_seconds
             FROM standard_reputation_operations`,
        ),
        this.pool.query<GroupCount>(
          `SELECT last_error_class AS key,count(*)::int AS count
             FROM standard_reputation_operations WHERE last_error_class IS NOT NULL
            GROUP BY last_error_class`,
        ),
        this.pool.query<{ key: string; oldest_pending_seconds: number }>(
          `SELECT kind AS key,COALESCE(extract(epoch FROM now()-min(created_at)),0)::int
                    AS oldest_pending_seconds
             FROM standard_reputation_operations
            WHERE state IN ('pending','broadcast') GROUP BY kind`,
        ),
        this.pool.query<GroupCount>(
          `SELECT state AS key,count(*)::int AS count FROM standard_reputation_transactions
            WHERE state IN ('prepared','broadcast','operator_attention') GROUP BY state`,
        ),
        this.reputation.accountHealth(),
      ]);
    return {
      reputation: {
        ...operations.rows[0],
        causes: keyedCounts(operationCauses.rows),
        oldestPendingSecondsByKind: Object.fromEntries(oldestByKind.rows.map(
          (row) => [row.key, row.oldest_pending_seconds],
        )),
        transactionStates: keyedCounts(transactionStates.rows),
        relayer,
      },
    };
  }
}
