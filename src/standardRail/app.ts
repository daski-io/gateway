import type { Express } from "express";
import type { Config } from "../config.js";
import {
  createPool,
  runMigrations,
  type Pool,
} from "../db/pool.js";
import { createRateLimitQueries } from "../db/rateLimitQueries.js";
import { createStandardGatewayHttp } from "../http/gatewayApp.js";
import type { McpWiring } from "../mcp/httpTransport.js";
import { ApplicationLifecycle } from "../runtime/applicationLifecycle.js";
import { logger } from "../util/logger.js";
import type { StandardRailConfig } from "./config.js";

/**
 * Concurrent settlement pipelines each hold up to three advisory-lock
 * connections (listing, rail fence, relayer nonce); beyond this many the
 * next holder waits on checkout and hands its order to recovery.
 */
const LOCK_POOL_SIZE = 12;
const RATE_LIMIT_PRUNE_INTERVAL_MS = 60_000;

function quotedIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function configureRuntimePrivileges(
  migrationPool: Pool,
  runtimeDatabaseUrl: string,
  migrationDatabaseUrl: string,
): Promise<void> {
  const runtimeRole = decodeURIComponent(new URL(runtimeDatabaseUrl).username);
  const migrationRole = decodeURIComponent(new URL(migrationDatabaseUrl).username);
  if (!runtimeRole || runtimeRole === migrationRole) {
    throw new Error("DATABASE_URL and MIGRATION_DATABASE_URL must use distinct database roles");
  }
  const role = quotedIdentifier(runtimeRole);
  const migrator = quotedIdentifier(migrationRole);
  const client = await migrationPool.connect();
  try {
    const rolePolicy = await client.query<{
      rolsuper: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
      rolbypassrls: boolean;
      member_of_any_role: boolean;
    }>(
      `SELECT r.rolsuper,r.rolcreaterole,r.rolcreatedb,r.rolbypassrls,
              EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) AS member_of_any_role
         FROM pg_roles r WHERE r.rolname=$1`,
      [runtimeRole],
    );
    const runtimePolicy = rolePolicy.rows[0];
    if (
      !runtimePolicy || runtimePolicy.rolsuper || runtimePolicy.rolcreaterole ||
      runtimePolicy.rolcreatedb || runtimePolicy.rolbypassrls || runtimePolicy.member_of_any_role
    ) throw new Error("The standard runtime database role has privileged or migration-role authority");
    const schemaResult = await client.query<{ schema: string }>("SELECT current_schema() AS schema");
    const schemaName = schemaResult.rows[0]?.schema;
    if (!schemaName) throw new Error("Cannot determine the standard-rail database schema");
    const schema = quotedIdentifier(schemaName);
    const databaseResult = await client.query<{ database: string }>("SELECT current_database() AS database");
    const databaseName = databaseResult.rows[0]?.database;
    if (!databaseName) throw new Error("Cannot determine the standard-rail database");
    const database = quotedIdentifier(databaseName);
    const tables = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
        WHERE schemaname=$1 AND (tablename LIKE 'standard\\_%' ESCAPE '\\' OR tablename='rate_limit_buckets')`,
      [schemaName],
    );
    if (!tables.rows.some((row) => row.tablename === "standard_orders")) {
      throw new Error("Standard-rail schema is incomplete");
    }
    const admittedTables = tables.rows.map((row) => `${schema}.${quotedIdentifier(row.tablename)}`);
    const relations = await client.query<{ relation_name: string; relation_kind: string }>(
      `SELECT c.relname AS relation_name,c.relkind AS relation_kind
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','S')`,
      [schemaName],
    );
    const sequences = await client.query<{ sequencename: string }>(
      `SELECT sequencename FROM pg_sequences WHERE schemaname=$1 AND sequencename LIKE 'standard\\_%' ESCAPE '\\'`,
      [schemaName],
    );
    await client.query("BEGIN");
    await client.query(`ALTER DATABASE ${database} OWNER TO ${migrator}`);
    await client.query(`ALTER SCHEMA ${schema} OWNER TO ${migrator}`);
    for (const relation of relations.rows) {
      const relationType = relation.relation_kind === "S"
        ? "SEQUENCE"
        : relation.relation_kind === "v"
          ? "VIEW"
          : relation.relation_kind === "m"
            ? "MATERIALIZED VIEW"
            : "TABLE";
      await client.query(
        `ALTER ${relationType} ${schema}.${quotedIdentifier(relation.relation_name)} OWNER TO ${migrator}`,
      );
    }
    await client.query(`REVOKE CREATE ON SCHEMA ${schema} FROM PUBLIC`);
    await client.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schema} FROM PUBLIC`);
    await client.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${schema} FROM PUBLIC`);
    await client.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schema} FROM ${role}`);
    await client.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${role}`);
    await client.query(`REVOKE CREATE, TEMPORARY ON DATABASE ${database} FROM PUBLIC`);
    await client.query(`REVOKE CREATE, TEMPORARY ON DATABASE ${database} FROM ${role}`);
    await client.query(`REVOKE CREATE ON SCHEMA ${schema} FROM ${role}`);
    await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${admittedTables.join(", ")} TO ${role}`,
    );
    if (sequences.rows.length > 0) {
      const admittedSequences = sequences.rows
        .map((row) => `${schema}.${quotedIdentifier(row.sequencename)}`)
        .join(", ");
      await client.query(
        `GRANT USAGE, SELECT, UPDATE ON SEQUENCE ${admittedSequences} TO ${role}`,
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface StandardAppBundle {
  app: Express;
  pool: Pool;
  mcp: McpWiring | null;
  beginShutdown(): void;
  shutdown(httpClosed?: Promise<void>): Promise<void>;
}

export async function createStandardApp(options: {
  config: Config;
  standardRailConfig: StandardRailConfig;
  pool?: Pool;
  federationPermitPool?: Pool;
  a2aFetch?: typeof fetch;
}): Promise<StandardAppBundle> {
  if (!options.pool) {
    const migrationPool = createPool({
      connectionString: options.standardRailConfig.migrationDatabaseUrl,
      max: 1,
      connectionTimeoutMs: 0,
      statementTimeoutMs: 0,
      lockTimeoutMs: 0,
    });
    try {
      await runMigrations(migrationPool);
      await configureRuntimePrivileges(
        migrationPool,
        options.config.databaseUrl,
        options.standardRailConfig.migrationDatabaseUrl,
      );
    } finally {
      await migrationPool.end();
    }
  }
  const pool = options.pool ?? createPool({
    connectionString: options.config.databaseUrl,
    max: 10,
  });
  const ownsPool = options.pool === undefined;
  const federationPermitPool = options.federationPermitPool ?? (options.pool
    ? pool
    : createPool({
      connectionString: options.config.databaseUrl,
      max: options.standardRailConfig.abuse.federationGlobalConcurrency,
    }));
  const ownsFederationPermitPool = options.federationPermitPool === undefined && options.pool === undefined;
  const lifecycle = new ApplicationLifecycle();
  const rateLimitStore = createRateLimitQueries(pool);
  const { app, mcp, standardRailStop } = await createStandardGatewayHttp({
    config: options.config,
    pool,
    federationPermitPool,
    lifecycle,
    standardRailConfig: options.standardRailConfig,
    rateLimitStore,
    a2aFetch: options.a2aFetch,
  });

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (httpClosed: Promise<void> = Promise.resolve()): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    lifecycle.beginShutdown();
    shutdownPromise = (async () => {
      const drains = await Promise.allSettled([
        httpClosed,
        mcp?.close() ?? Promise.resolve(),
        standardRailStop(),
      ]);
      const poolClose = await Promise.allSettled([
        ...(ownsPool ? [pool.end()] : []),
        ...(ownsFederationPermitPool ? [federationPermitPool.end()] : []),
        ...(ownsLockPool ? [lockPool.end()] : []),
      ]);
      const failure = [...drains, ...poolClose].find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    })();
    return shutdownPromise;
  };

  return {
    app,
    pool,
    mcp,
    beginShutdown: () => lifecycle.beginShutdown(),
    shutdown,
  };
}
