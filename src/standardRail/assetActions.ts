import { randomBytes } from "node:crypto";
import { getAddress, recoverMessageAddress, type Hex } from "viem";
import type { Pool } from "../db/pool.js";
import type { ActiveServicing, StandardAssetFederation } from "./assetFederation.js";
import { artifactPayloadHash, canonicalHash } from "./canonical.js";
import type { StandardRailConfig } from "./config.js";
import { signEnvelope } from "./signing.js";
import type {
  AssetActionDefinitionV1,
  ProviderAssetActionCatalogV1,
  ProviderWalletActionGrantV1,
  SignedEnvelope,
  WalletAuthorizationTransport,
} from "./types.js";
import {
  deriveActionExecutionId,
  utf8Hash,
  walletAuthorizationHash,
} from "./walletAuthorization.js";
import type { StandardWalletStore } from "./walletStore.js";
import { readBoundedJsonResponse } from "./boundedJson.js";
import {
  assertDestructiveFollowUp,
  claimAssetAction,
  recordAssetActionStage,
  recordAssetActionState,
} from "./assetActionClaims.js";
import { assertSchema, compileClosedResponseSchema } from "./schema.js";

interface ResolvedAction {
  active: ActiveServicing;
  catalogEnvelope: SignedEnvelope<ProviderAssetActionCatalogV1>;
  definition: AssetActionDefinitionV1;
}

function exact(value: unknown, keys: readonly string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid response");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("invalid response");
  }
}

export class StandardAssetActions {
  constructor(
    private readonly pool: Pool,
    private readonly config: StandardRailConfig,
    private readonly chainId: number,
    private readonly wallet: StandardWalletStore,
    private readonly federation: StandardAssetFederation,
    private readonly providerFetch: ActiveServicingFetch,
  ) {}

  async issue(args: {
    payer: string;
    providerAgentId: string;
    actionId: string;
    providerAssetId: string;
    input: Record<string, unknown>;
    absoluteResourceUri: string;
    clientKey: string;
  }) {
    const resolved = this.resolve(args.providerAgentId, args.actionId);
    const action = actionName(args.providerAgentId, args.actionId, args.input);
    return this.wallet.issue({
      action,
      payer: args.payer,
      request: actionRequest(args),
      absoluteResourceUri: args.absoluteResourceUri,
      clientKey: args.clientKey,
      provider: {
        providerAgentId: args.providerAgentId,
        serviceId: resolved.definition.serviceId,
        providerControlProfileHash: resolved.active.admissionEnvelope.payload.providerControlProfileHash,
        servicingAdmissionHash: resolved.active.admissionHash,
        actionCatalogHash: canonicalHash(resolved.catalogEnvelope),
        actionCatalogSchemaHash: resolved.active.admissionEnvelope.payload.actionCatalogSchemaHash,
        actionDefinitionHash: resolved.definition.actionDefinitionHash,
        actionCatalogEpoch: resolved.active.admissionEnvelope.payload.actionCatalogEpoch,
      },
    });
  }

  async perform(args: {
    payer: string;
    providerAgentId: string;
    actionId: string;
    providerAssetId: string;
    input: Record<string, unknown>;
    authorization: WalletAuthorizationTransport;
  }): Promise<unknown> {
    const request = actionRequest(args);
    const resolved = this.resolve(args.providerAgentId, args.actionId);
    const action = actionName(args.providerAgentId, args.actionId, args.input);
    this.assertCurrentAuthorization(args.authorization, resolved, action, request);
    const requestDigest = canonicalHash(request);
    const presentedWalletHash = walletAuthorizationHash(args.authorization.message, this.chainId);
    const followUp = destructiveFollowUp(args.input);
    const recovery = actionRecovery(args.input);
    if (followUp && !resolved.definition.destructive) throw new Error("wallet authorization denied");
    const expectedResponse = resolved.definition.destructive && recovery === null && followUp?.operation !== "confirm"
      ? {
          artifactType: "ProviderAssetActionStageResponseV1" as const,
          status: followUp?.operation === "cancel" ? "canceled" as const : "staged" as const,
        }
      : { artifactType: "ProviderAssetActionResponseV1" as const, status: null };
    const executionId = followUp?.operation === "confirm"
      ? canonicalHash({
          operation: "confirm-destructive",
          actionExecutionId: followUp.stagedExecutionId,
          confirmationHash: followUp.confirmationHash,
          walletAuthorizationHash: presentedWalletHash,
        })
      : deriveActionExecutionId({
          walletAuthorizationHash: presentedWalletHash,
          providerAgentId: BigInt(args.providerAgentId),
          serviceId: resolved.definition.serviceId,
          providerControlProfileHash: resolved.active.admissionEnvelope.payload.providerControlProfileHash,
          servicingAdmissionHash: resolved.active.admissionHash,
          actionCatalogHash: canonicalHash(resolved.catalogEnvelope),
          actionCatalogSchemaHash: resolved.active.admissionEnvelope.payload.actionCatalogSchemaHash,
          actionCatalogEpoch: BigInt(resolved.active.admissionEnvelope.payload.actionCatalogEpoch),
          actionDefinitionHash: resolved.definition.actionDefinitionHash,
          requestHash: requestDigest,
        });
    // Authorize first: the payer this operation acts for is whichever payer the
    // signed authorization proves, never the caller-supplied field.
    const { payer, authorizationHash: walletHash } = await this.wallet.consume({
      payer: args.payer,
      authorization: args.authorization,
      action,
      request,
      operationHash: executionId,
      allowExactReplay: true,
    });
    if (walletHash !== presentedWalletHash) throw new Error("wallet authorization denied");
    const eligible = await this.pool.query(
      `SELECT 1 FROM standard_orders WHERE lower(payer)=$1 AND provider_agent_id=$2
        AND state NOT IN ('DRAFT','CHALLENGE_ISSUED','ATTEMPT_OPENED','VERIFIED','VERIFY_REJECTED',
          'SETTLE_INVOKED','FACILITATOR_CONFIRMED','SETTLEMENT_AMBIGUOUS','SETTLEMENT_FAILED',
          'EXTERNAL_OR_UNPROVEN_DEPOSIT','DEPOSIT_FINAL') LIMIT 1`,
      [payer, args.providerAgentId],
    );
    if (eligible.rowCount !== 1) throw new Error("wallet authorization denied");
    if (followUp) {
      await assertDestructiveFollowUp(this.pool, {
        payer,
        providerAgentId: args.providerAgentId,
        actionDefinitionHash: resolved.definition.actionDefinitionHash,
        executionId: followUp.stagedExecutionId,
        followUpExecutionId: executionId,
        confirmationHash: followUp.confirmationHash,
        operation: followUp.operation,
      });
    }
    await claimAssetAction(this.pool, {
      executionId,
      payer,
      providerAgentId: args.providerAgentId,
      serviceId: resolved.definition.serviceId,
      operation: recovery ? "recover" : followUp?.operation ?? "use",
      stagedExecutionId: recovery?.originalExecutionId ?? followUp?.stagedExecutionId ?? null,
      walletAuthorizationHash: walletHash,
      requestHash: requestDigest,
      providerControlProfileHash: resolved.active.admissionEnvelope.payload.providerControlProfileHash,
      servicingAdmissionHash: resolved.active.admissionHash,
      actionCatalogHash: canonicalHash(resolved.catalogEnvelope),
      actionCatalogSchemaHash: resolved.active.admissionEnvelope.payload.actionCatalogSchemaHash,
      actionCatalogEpoch: resolved.active.admissionEnvelope.payload.actionCatalogEpoch,
      actionDefinitionHash: resolved.definition.actionDefinitionHash,
      stageValidBefore: resolved.definition.destructive && followUp === null && recovery === null
        ? Math.min(
            Math.floor(Date.now() / 1_000) +
              Math.min(86_400, resolved.definition.retentionSeconds) +
              Math.ceil(resolved.active.listing.providerControlProfile.payload.timeoutMs / 1_000),
            resolved.definition.validBefore,
            resolved.active.admissionEnvelope.payload.validBefore,
          )
        : null,
    });
    const grant = await this.grant(resolved, payer, request, walletHash, args.authorization);
    const response = await this.providerFetch(
      resolved.active,
      resolved.active.listing.providerControlProfile.payload.assetActionUrl,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ request, authorization: args.authorization, grant }),
        signal: AbortSignal.timeout(resolved.active.listing.providerControlProfile.payload.timeoutMs),
        redirect: "error",
      },
    );
    if (!response.ok) {
      throw new Error(response.status === 429 ? "WALLET_RATE_LIMITED" : "ASSET_ACTION_REJECTED");
    }
    const body = await readBoundedJsonResponse(response, resolved.active.listing.providerControlProfile.payload.maxResponseBytes);
    const payload = await this.verifyResponse(
      resolved,
      grant,
      body,
      payer,
      request,
      walletHash,
      recovery?.originalExecutionId ?? followUp?.stagedExecutionId ?? executionId,
      expectedResponse,
    );
    const state = payload.status as "staged" | "completed" | "failed" | "canceled";
    const retryable = state === "failed" && payload.errorClass === "provider_retryable";
    if (!retryable) {
      if (state === "staged") {
        await recordAssetActionStage(
          this.pool,
          executionId,
          payload.confirmationHash as Hex,
          Number(payload.earliestExecutionAt),
          Number(payload.stageValidBefore),
        );
      } else {
        await recordAssetActionState(this.pool, executionId, state);
      }
      if (followUp) await recordAssetActionState(this.pool, followUp.stagedExecutionId, state);
    }
    return payload;
  }

  private resolve(providerAgentId: string, actionId: string): ResolvedAction {
    const active = this.federation.activeServicing(providerAgentId);
    if (!active) throw new Error("ASSET_ACTION_NOT_ADMITTED");
    const catalogEnvelope = this.config.manifest.actionCatalogs.find((item) =>
      item.payload.providerAgentId === providerAgentId &&
      canonicalHash(item) === active.admissionEnvelope.payload.actionCatalogHash
    );
    const definition = catalogEnvelope?.payload.actions.find((item) => item.actionId === actionId);
    const now = Math.floor(Date.now() / 1_000);
    if (
      !catalogEnvelope || !definition || definition.validFrom > now || definition.validBefore <= now ||
      definition.actionDefinitionHash !== canonicalHash(omitHash(definition))
    ) throw new Error("ASSET_ACTION_NOT_ADMITTED");
    return { active, catalogEnvelope, definition };
  }

  private assertCurrentAuthorization(
    authorization: WalletAuthorizationTransport,
    resolved: ResolvedAction,
    action: string,
    request: unknown,
  ): void {
    const message = authorization.message;
    const admission = resolved.active.admissionEnvelope.payload;
    if (
      message.providerAgentId !== admission.providerAgentId ||
      message.serviceId !== resolved.definition.serviceId ||
      message.providerControlProfileHash !== admission.providerControlProfileHash ||
      message.servicingAdmissionHash !== resolved.active.admissionHash ||
      message.actionCatalogHash !== canonicalHash(resolved.catalogEnvelope) ||
      message.actionCatalogSchemaHash !== admission.actionCatalogSchemaHash ||
      message.actionCatalogEpoch !== admission.actionCatalogEpoch ||
      message.actionDefinitionHash !== resolved.definition.actionDefinitionHash ||
      message.actionHash !== utf8Hash(action) ||
      message.requestHash !== canonicalHash(request)
    ) throw new Error("wallet authorization denied");
  }

  private grant(
    resolved: ResolvedAction,
    payer: Hex,
    request: unknown,
    walletHash: Hex,
    authorization: WalletAuthorizationTransport,
  ): Promise<SignedEnvelope<ProviderWalletActionGrantV1>> {
    const now = Math.floor(Date.now() / 1_000);
    const admission = resolved.active.admissionEnvelope.payload;
    const profile = resolved.active.listing.providerControlProfile.payload;
    return signEnvelope({
      artifactType: "ProviderWalletActionGrantV1",
      environment: this.config.environment,
      chainId: this.chainId,
      audience: profile.providerAudience,
      signerKeyId: "gateway-lifecycle",
      privateKey: this.config.lifecyclePrivateKey,
      issuedAt: now,
      validBefore: Math.min(now + 300, admission.validBefore),
      payload: {
        payer,
        providerAgentId: admission.providerAgentId,
        serviceId: resolved.definition.serviceId,
        actionHash: authorization.message.actionHash,
        methodHash: utf8Hash("POST"),
        absoluteResourceUriHash: authorization.message.absoluteResourceUriHash,
        requestHash: canonicalHash(request),
        walletAuthorizationHash: walletHash,
        providerControlProfileHash: admission.providerControlProfileHash,
        servicingAdmissionHash: resolved.active.admissionHash,
        servicingProfileEpoch: admission.servicingProfileEpoch,
        actionCatalogHash: canonicalHash(resolved.catalogEnvelope),
        actionCatalogSchemaHash: admission.actionCatalogSchemaHash,
        actionCatalogEpoch: admission.actionCatalogEpoch,
        actionDefinitionHash: resolved.definition.actionDefinitionHash,
        gatewayAudienceHash: utf8Hash(this.config.gatewayAudience),
        providerAudienceHash: utf8Hash(profile.providerAudience),
        grantNonce: `0x${randomBytes(32).toString("hex")}`,
      },
    });
  }

  private async verifyResponse(
    resolved: ResolvedAction,
    grant: SignedEnvelope<ProviderWalletActionGrantV1>,
    body: unknown,
    payer: Hex,
    request: unknown,
    walletHash: Hex,
    expectedProviderExecutionId: Hex,
    expectedResponse: {
      artifactType: "ProviderAssetActionResponseV1" | "ProviderAssetActionStageResponseV1";
      status: "staged" | "canceled" | null;
    },
  ): Promise<Record<string, unknown>> {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid response");
    const envelope = body as SignedEnvelope<Record<string, unknown>>;
    const profile = resolved.active.listing.providerControlProfile.payload;
    const payload = envelope.payload;
    exact(envelope, ["artifactType", "schemaVersion", "environment", "chainId", "audience",
      "signerKeyId", "issuedAt", "validBefore", "payload", "signature"]);
    const common = ["providerAgentId", "payer", "actionExecutionId", "status", "responseNonce",
      "requestHash", "walletAuthorizationHash", "grantHash", "providerControlProfileHash",
      "servicingAdmissionHash", "servicingProfileEpoch", "actionCatalogHash",
      "actionCatalogSchemaHash", "actionCatalogEpoch", "actionDefinitionHash"];
    exact(payload, envelope.artifactType === "ProviderAssetActionStageResponseV1"
      ? [...common, "effectSummary", "confirmationHash", "earliestExecutionAt", "stageValidBefore"]
      : [...common, "result", "errorClass"]);
    const now = Math.floor(Date.now() / 1_000);
    const finalResponse = envelope.artifactType === "ProviderAssetActionResponseV1";
    const statusValid = finalResponse
      ? ["completed", "failed"].includes(String(payload.status))
      : ["staged", "canceled"].includes(String(payload.status));
    const resultSemanticsValid = !finalResponse ||
      (payload.status === "completed"
        ? payload.result !== null && payload.errorClass === null &&
          typeof payload.result === "object" && !Array.isArray(payload.result)
        : payload.result === null && typeof payload.errorClass === "string" &&
          /^[a-z0-9_]{1,64}$/.test(payload.errorClass));
    const stageSemanticsValid = finalResponse || (
      payload.effectSummary !== null && typeof payload.effectSummary === "object" &&
      !Array.isArray(payload.effectSummary) &&
      typeof payload.confirmationHash === "string" && /^0x[0-9a-f]{64}$/.test(payload.confirmationHash) &&
      Number.isSafeInteger(payload.earliestExecutionAt) && Number.isSafeInteger(payload.stageValidBefore) &&
      Number(payload.earliestExecutionAt) < Number(payload.stageValidBefore) &&
      Number(payload.stageValidBefore) <= Math.min(
        envelope.issuedAt + 86_400,
        envelope.issuedAt + resolved.definition.retentionSeconds,
        resolved.definition.validBefore,
        resolved.active.admissionEnvelope.payload.validBefore,
      )
    );
    if (
      envelope.artifactType !== expectedResponse.artifactType ||
      envelope.schemaVersion !== 1 || envelope.issuedAt > now + 30 || envelope.issuedAt >= envelope.validBefore ||
      envelope.validBefore - envelope.issuedAt > 60 ||
      envelope.environment !== this.config.environment || envelope.chainId !== this.chainId ||
      envelope.audience !== this.config.gatewayAudience || envelope.signerKeyId !== profile.assetResponseKeyId ||
      envelope.validBefore <= now || envelope.validBefore > grant.validBefore ||
      !statusValid || !resultSemanticsValid || !stageSemanticsValid ||
      (expectedResponse.status !== null && payload.status !== expectedResponse.status)
    ) throw new Error("invalid response");
    const recovered = await recoverMessageAddress({
      message: { raw: artifactPayloadHash(envelope as unknown as Record<string, unknown> & { signature?: Hex }) },
      signature: envelope.signature,
    });
    if (
      getAddress(recovered) !== getAddress(profile.assetResponseKey) ||
      payload.providerAgentId !== resolved.active.admissionEnvelope.payload.providerAgentId ||
      payload.actionExecutionId !== expectedProviderExecutionId ||
      payload.payer !== payer || payload.requestHash !== canonicalHash(request) ||
      payload.walletAuthorizationHash !== walletHash || payload.grantHash !== artifactPayloadHash(
        grant as unknown as Record<string, unknown> & { signature?: Hex },
      ) ||
      payload.providerControlProfileHash !== resolved.active.admissionEnvelope.payload.providerControlProfileHash ||
      payload.servicingAdmissionHash !== resolved.active.admissionHash ||
      payload.servicingProfileEpoch !== resolved.active.admissionEnvelope.payload.servicingProfileEpoch ||
      payload.actionCatalogHash !== canonicalHash(resolved.catalogEnvelope) ||
      payload.actionCatalogSchemaHash !== resolved.active.admissionEnvelope.payload.actionCatalogSchemaHash ||
      payload.actionCatalogEpoch !== resolved.active.admissionEnvelope.payload.actionCatalogEpoch ||
      typeof payload.responseNonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(payload.responseNonce) ||
      payload.actionDefinitionHash !== resolved.definition.actionDefinitionHash
    ) throw new Error("invalid response");
    if (finalResponse && payload.status === "completed") {
      assertSchema(
        compileClosedResponseSchema(resolved.definition.responseSchema),
        payload.result,
        "Response",
      );
    }
    if (!finalResponse) {
      assertSchema(
        compileClosedResponseSchema(resolved.definition.confirmationSummarySchema!),
        payload.effectSummary,
        "Response",
      );
      if (payload.status === "staged") {
        const confirmationHash = canonicalHash({
          request,
          effectSummary: payload.effectSummary,
          providerControlProfileHash: resolved.active.admissionEnvelope.payload.providerControlProfileHash,
          servicingAdmissionHash: resolved.active.admissionHash,
          servicingProfileEpoch: resolved.active.admissionEnvelope.payload.servicingProfileEpoch,
          actionCatalogHash: canonicalHash(resolved.catalogEnvelope),
          actionCatalogSchemaHash: resolved.active.admissionEnvelope.payload.actionCatalogSchemaHash,
          actionCatalogEpoch: resolved.active.admissionEnvelope.payload.actionCatalogEpoch,
          actionDefinitionHash: resolved.definition.actionDefinitionHash,
          actionExecutionId: payload.actionExecutionId,
          earliestExecutionAt: payload.earliestExecutionAt,
          stageValidBefore: payload.stageValidBefore,
        });
        if (confirmationHash !== payload.confirmationHash) throw new Error("invalid response");
      }
    }
    return payload;
  }
}

type ActiveServicingFetch = (
  active: ActiveServicing,
  endpoint: string,
  init: RequestInit,
) => Promise<Response>;

function actionRequest(args: {
  actionId: string; providerAssetId: string; input: Record<string, unknown>;
}) {
  return {
    actionId: args.actionId, providerAssetId: args.providerAssetId, input: args.input,
  };
}

function actionName(providerAgentId: string, actionId: string, input: Record<string, unknown>) {
  return input.operation === "confirm-destructive"
    ? `confirm-destructive:${providerAgentId}:${actionId}`
    : input.operation === "recover-action"
      ? `recover-action:${providerAgentId}:${actionId}`
    : `use-asset:${providerAgentId}:${actionId}`;
}

function actionRecovery(input: Record<string, unknown>): { originalExecutionId: Hex } | null {
  if (input.operation !== "recover-action") return null;
  exact(input, ["operation", "actionExecutionId", "originalInput"]);
  if (typeof input.actionExecutionId !== "string" || !/^0x[0-9a-f]{64}$/.test(input.actionExecutionId) ||
    !input.originalInput || typeof input.originalInput !== "object" || Array.isArray(input.originalInput)) {
    throw new Error("wallet authorization denied");
  }
  return { originalExecutionId: input.actionExecutionId as Hex };
}

function destructiveFollowUp(input: Record<string, unknown>): {
  operation: "confirm" | "cancel";
  stagedExecutionId: Hex;
  confirmationHash: Hex;
} | null {
  if (input.operation !== "confirm-destructive" && input.operation !== "cancel-staged-action") return null;
  exact(input, ["operation", "actionExecutionId", "confirmationHash"]);
  if (
    typeof input.actionExecutionId !== "string" || !/^0x[0-9a-f]{64}$/.test(input.actionExecutionId) ||
    typeof input.confirmationHash !== "string" || !/^0x[0-9a-f]{64}$/.test(input.confirmationHash)
  ) throw new Error("wallet authorization denied");
  return {
    operation: input.operation === "confirm-destructive" ? "confirm" : "cancel",
    stagedExecutionId: input.actionExecutionId as Hex,
    confirmationHash: input.confirmationHash as Hex,
  };
}

function omitHash(definition: AssetActionDefinitionV1) {
  const { actionDefinitionHash: _hash, ...preimage } = definition;
  return preimage;
}
