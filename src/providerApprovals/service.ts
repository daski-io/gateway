import type { Config } from "../config.js";
import type { ServiceRegistrationStore, StoredRegistration } from "../serviceRegistration/store.js";
import type { StandardRailConfig } from "../standardRail/config.js";
import { logger } from "../util/logger.js";
import {
  acceptInviteAdmission,
  buildProviderApprovalRecord,
  ProviderApprovalRefused,
  type ProviderApprovalRecord,
} from "./record.js";
import type { ProviderApproval, ProviderApprovalStore } from "./store.js";

/// Approving hosted providers (docs/provider-approvals.md). A provider whose
/// registration's card origin is one of HOSTED_PROVIDER_ORIGINS is approved
/// automatically when its invite authorizes admission, on activation and on a
/// one-minute sweep, or by an operator. The approval is the stored record the
/// catalog sells the provider through when the manifest carries no control
/// profile for it.

/** How often active hosted registrations without an approval are looked at. */
export const PROVIDER_APPROVAL_SWEEP_MS = 60_000;
/** Providers asked about per sweep, least recently asked first. */
const SWEEP_BATCH = 25;
/** Candidates a sweep reads from the database. */
const SWEEP_CANDIDATES = 500;
const DEFAULT_OPERATOR = "catalog-operator";

export class ProviderApprovalError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export type InviteApprovalOutcome =
  | "approved" | "already-approved" | "previously-approved" | "not-hosted" | "unavailable" | "refused";

export interface ProviderApprovalStatus {
  approved: boolean;
  approvedAt?: string;
  record?: ProviderApprovalRecord;
  recordHash?: string;
}

/** The operator's request body: `{ reason, operator? }`. */
export function parseApprovalRequest(raw: unknown): { reason: string; operator: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      Object.keys(raw).some((key) => !["reason", "operator"].includes(key))) {
    throw new ProviderApprovalError(400, "INVALID_PROVIDER_APPROVAL_REQUEST",
      "The body must be { reason: string, operator?: string }.");
  }
  const body = raw as { reason?: unknown; operator?: unknown };
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  const operator = body.operator ?? DEFAULT_OPERATOR;
  if (!/^[^\p{Cc}\p{Cf}]{1,200}$/u.test(reason) ||
      typeof operator !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,63}$/.test(operator)) {
    throw new ProviderApprovalError(400, "INVALID_PROVIDER_APPROVAL_REQUEST",
      "reason must be 1-200 printable characters; operator, when given, a short label.");
  }
  return { reason, operator };
}

export function providerAgentIdParameter(raw: unknown): string {
  if (typeof raw !== "string" || !/^[1-9][0-9]{0,77}$/.test(raw)) {
    throw new ProviderApprovalError(400, "INVALID_PROVIDER_AGENT_ID", "agentId must be a decimal provider agent id.");
  }
  return raw;
}

function statusView(approval: ProviderApproval | null): ProviderApprovalStatus {
  return approval
    ? { approved: true, approvedAt: approval.approvedAt.toISOString(), record: approval.record, recordHash: approval.recordHash }
    : { approved: false };
}

function hostedOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

export class ProviderApprovalService {
  private readonly origins: ReadonlySet<string>;
  private sweepTimer: NodeJS.Timeout | null = null;
  private sweepWork: Promise<void> | null = null;
  private readonly inviteWork = new Map<string, Promise<InviteApprovalOutcome>>();
  /** When each provider was last asked about by invite, for a fair sweep. */
  private readonly lastAsked = new Map<string, number>();

  constructor(private readonly args: {
    config: Pick<Config, "chainId" | "hostedProviderOrigins">;
    railConfig: Pick<StandardRailConfig, "environment" | "gatewayAudience" | "manifest">;
    registrations: Pick<
      ServiceRegistrationStore,
      "listActiveByProvider" | "listHostedApprovalCandidates" | "currentProviderControlProfileHash"
    >;
    approvals: ProviderApprovalStore;
    /** The gateway's bounded, origin-pinned JSON GET for provider documents (cardFetch.ts). */
    loadJson: (url: string) => Promise<unknown>;
    sweepIntervalMs?: number;
  }) {
    this.origins = new Set(args.config.hostedProviderOrigins);
  }

  /** Whether the feature is on: at least one hosted origin is configured. */
  get enabled(): boolean {
    return this.origins.size > 0;
  }

  /** Whether a registration's card origin is one of HOSTED_PROVIDER_ORIGINS. */
  isHosted(record: Pick<StoredRegistration, "card">): boolean {
    const origin = hostedOrigin(String(record.card?.standardRail?.origin ?? ""));
    return origin !== null && this.origins.has(origin);
  }

  private build(record: StoredRegistration, minimumEpoch = 1) {
    return buildProviderApprovalRecord({
      domain: {
        environment: this.args.railConfig.environment,
        chainId: this.args.config.chainId,
        gatewayAudience: this.args.railConfig.gatewayAudience,
      },
      registration: record,
      manifestProfiles: this.args.railConfig.manifest.providerControlProfiles,
      minimumEpoch,
    });
  }

  /**
   * Whether the catalog sells the provider through this approval: approvals
   * are on for the record's origin, and neither a servicing admission nor a
   * manifest profile names a profile for the provider, which would come first.
   */
  private async inUse(approval: ProviderApproval): Promise<boolean> {
    const origin = hostedOrigin(approval.record.payload.origin);
    if (origin === null || !this.origins.has(origin)) return false;
    if (this.args.railConfig.manifest.providerControlProfiles.some((profile) =>
      profile.payload.providerAgentId === approval.providerAgentId)) return false;
    return await this.args.registrations.currentProviderControlProfileHash(approval.providerAgentId) === null;
  }

  /**
   * Approves the provider of an active hosted registration when the hosted
   * runtime reports its invite authorizes admission and was redeemed by the
   * registration's owner. A provider that holds or ever held an approval on
   * this chain is left to the operator: a revocation is never undone here.
   */
  approveByInvite(record: StoredRegistration): Promise<InviteApprovalOutcome> {
    const running = this.inviteWork.get(record.providerAgentId);
    if (running) return running;
    const work = this.inviteApproval(record).finally(() => {
      this.inviteWork.delete(record.providerAgentId);
    });
    this.inviteWork.set(record.providerAgentId, work);
    return work;
  }

  private async inviteApproval(record: StoredRegistration): Promise<InviteApprovalOutcome> {
    const providerAgentId = record.providerAgentId;
    if (record.state !== "ACTIVE" || !this.isHosted(record)) return "not-hosted";
    const latest = await this.args.approvals.latest(providerAgentId);
    if (latest) return latest.revokedAt === null ? "already-approved" : "previously-approved";
    this.lastAsked.set(providerAgentId, Date.now());
    const url = new URL(`/p/${providerAgentId}/standard-rail/admission`, record.card.standardRail.origin).toString();
    // Nothing is locked while the runtime is asked: it may read this
    // provider's public approval status meanwhile.
    let report: unknown;
    try {
      report = await this.args.loadJson(url);
    } catch {
      logger.warn("provider approval by invite: admission report unavailable", { providerAgentId });
      return "unavailable";
    }
    try {
      const { inviteId } = acceptInviteAdmission(report, {
        providerAgentId, chainId: this.args.config.chainId, providerOwner: record.providerOwner,
      });
      this.build(record); // refuses an unbuildable registration before taking the provider's lock
      const { approval, created } = await this.args.approvals.approve({
        providerAgentId, build: (minimumEpoch) => this.build(record, minimumEpoch),
        approvedBy: `invite:${inviteId}`, replace: false,
      });
      if (!created) return "already-approved";
      logger.info("provider approved by invite", {
        providerAgentId, inviteId, recordHash: approval.recordHash,
        servicingProfileEpoch: approval.record.payload.servicingProfileEpoch,
      });
      return "approved";
    } catch (error) {
      if (!(error instanceof ProviderApprovalRefused)) throw error;
      logger.info("provider approval by invite refused", { providerAgentId, code: error.code });
      return "refused";
    }
  }

  /** One pass over active hosted registrations whose provider never held an approval. */
  async sweep(): Promise<void> {
    if (!this.enabled) return;
    const candidates = await this.args.registrations.listHostedApprovalCandidates(
      [...this.origins], this.args.config.chainId, SWEEP_CANDIDATES,
    );
    const batch = candidates
      .filter((record) => this.isHosted(record))
      .sort((left, right) =>
        (this.lastAsked.get(left.providerAgentId) ?? 0) - (this.lastAsked.get(right.providerAgentId) ?? 0))
      .slice(0, SWEEP_BATCH);
    for (const record of batch) {
      try {
        await this.approveByInvite(record);
      } catch (error) {
        logger.warn("provider approval by invite failed", {
          providerAgentId: record.providerAgentId,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** Called when a registration becomes ACTIVE; never delays the activation. */
  activated(record: StoredRegistration): void {
    if (!this.enabled || !this.isHosted(record)) return;
    void this.approveByInvite(record).catch((error: unknown) => {
      logger.warn("provider approval by invite failed", {
        providerAgentId: record.providerAgentId,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /** Builds the record from the provider's newest active hosted registration and approves it. */
  async approveByOperator(providerAgentId: string, request: { reason: string; operator: string }) {
    const hosted = (await this.args.registrations.listActiveByProvider(providerAgentId))
      .filter((record) => this.isHosted(record));
    const record = hosted.at(-1);
    if (!record) {
      throw new ProviderApprovalError(409, "PROVIDER_NOT_HOSTED",
        "The provider has no active registration on a hosted provider origin.");
    }
    let outcome: Awaited<ReturnType<ProviderApprovalStore["approve"]>>;
    try {
      this.build(record); // refuses an unbuildable registration before taking the provider's lock
      outcome = await this.args.approvals.approve({
        providerAgentId, build: (minimumEpoch) => this.build(record, minimumEpoch),
        approvedBy: `operator:${request.operator}`, replace: true,
        audit: (result) => ({
          actor: request.operator, action: "operator_provider_approved",
          details: {
            chainId: this.args.config.chainId, reason: request.reason, registrationId: record.registrationId,
            recordHash: result.approval.recordHash, created: result.created,
            replacedRecordHash: result.replaced?.recordHash ?? null,
          },
        }),
      });
    } catch (error) {
      if (error instanceof ProviderApprovalRefused) {
        throw new ProviderApprovalError(409, error.code, "The provider's registration cannot be approved.");
      }
      throw error;
    }
    const { approval, created, replaced } = outcome;
    logger.info("provider approved by operator", {
      providerAgentId, recordHash: approval.recordHash, created, replaced: replaced !== null,
    });
    return { ...statusView(approval), created, inUse: await this.inUse(approval) };
  }

  async revokeByOperator(providerAgentId: string, request: { reason: string; operator: string }) {
    const revoked = await this.args.approvals.revoke({
      providerAgentId, revokedBy: `operator:${request.operator}`,
      audit: (approval) => ({
        actor: request.operator, action: "operator_provider_approval_revoked",
        details: { chainId: this.args.config.chainId, reason: request.reason, recordHash: approval.recordHash },
      }),
    });
    if (!revoked) {
      throw new ProviderApprovalError(404, "PROVIDER_APPROVAL_NOT_FOUND", "The provider holds no current approval.");
    }
    logger.info("provider approval revoked by operator", { providerAgentId, recordHash: revoked.recordHash });
    return { approved: false, revokedAt: revoked.revokedAt?.toISOString() ?? null, recordHash: revoked.recordHash };
  }

  /**
   * The provider's approval as the catalog uses it: approved only while it
   * holds a current approval that the catalog sells it through.
   */
  async publicStatus(providerAgentId: string): Promise<ProviderApprovalStatus> {
    const approval = await this.args.approvals.read(providerAgentId);
    return statusView(approval && await this.inUse(approval) ? approval : null);
  }

  start(): void {
    if (this.sweepTimer || !this.enabled) return;
    const run = () => {
      if (this.sweepWork) return;
      this.sweepWork = this.sweep()
        .catch((error: unknown) => {
          logger.warn("provider approval sweep failed", {
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          this.sweepWork = null;
        });
    };
    run();
    this.sweepTimer = setInterval(run, this.args.sweepIntervalMs ?? PROVIDER_APPROVAL_SWEEP_MS);
    this.sweepTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    await this.sweepWork;
    await Promise.allSettled([...this.inviteWork.values()]);
  }
}
