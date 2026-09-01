import { randomBytes } from "node:crypto";
import {
  getAddress,
  recoverMessageAddress,
  type Hex,
} from "viem";
import type { Config } from "../config.js";
import { discardResponseBody, readBoundedJsonResponse } from "./boundedJson.js";
import { canonicalHash } from "./canonical.js";
import type { StandardRailConfig } from "./config.js";
import type { EvidenceResult, ReleaseEvidenceResult } from "./evidence.js";
import { StandardRailJournal } from "./journal.js";
import { isReputationEligiblePayer } from "./reputationEligibility.js";
import { signEnvelope } from "./signing.js";
import { StandardRailStore } from "./store.js";
import type {
  DispatchStatusQueryV1,
  SignedEnvelope,
  StandardListing,
  StandardOrderRecord,
  StandardRailDispatchV2,
} from "./types.js";
import { buildStandardEvidenceBundleV2 } from "./wireContracts.js";

const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;

type ProviderFetch = (
  listing: StandardListing,
  endpoint: string,
  init: RequestInit,
) => Promise<Response>;

function assertExactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  ) {
    throw new Error(`${label} fields are invalid`);
  }
}

export class StandardProviderDispatch {
  constructor(
    private readonly appConfig: Pick<Config, "chainId">,
    private readonly railConfig: StandardRailConfig,
    private readonly journal: StandardRailJournal,
    private readonly store: StandardRailStore,
    private readonly providerFetch: ProviderFetch,
    private readonly railProfileHash: Hex,
  ) {}

  async dispatch(
    order: StandardOrderRecord,
    listing: StandardListing,
    request: unknown,
    confirmationHash: Hex,
    evidenceBundle: { deposit: EvidenceResult; release: ReleaseEvidenceResult },
  ): Promise<StandardOrderRecord> {
    if (
      !order.payer || !order.settlementTxHash || !order.depositEvidenceHash ||
      !order.releaseTxHash || !order.releaseEvidenceHash ||
      !order.providerNetAmount || !order.daskiCommissionAmount ||
      order.settlementTxHash !== evidenceBundle.deposit.transactionHash ||
      order.depositEvidenceHash !== evidenceBundle.deposit.evidenceHash ||
      order.releaseTxHash !== evidenceBundle.release.transactionHash ||
      order.releaseEvidenceHash !== evidenceBundle.release.evidenceHash ||
      order.providerNetAmount !== evidenceBundle.release.providerNetAmount.toString() ||
      order.daskiCommissionAmount !==
        evidenceBundle.release.daskiCommissionAmount.toString()
    ) throw new Error("Dispatch evidence does not match the order");
    const payer = order.payer;
    const providerNetAmount = order.providerNetAmount;
    const daskiCommissionAmount = order.daskiCommissionAmount;
    const wireEvidenceBundle = buildStandardEvidenceBundleV2(
      evidenceBundle.deposit,
      evidenceBundle.release,
    );
    const buildPayload = (
      nonce: Hex,
      issuedAt: number,
      validBefore: number,
      providerRequest: unknown,
    ): StandardRailDispatchV2 => ({
      environment: this.railConfig.environment,
      chainId: this.appConfig.chainId,
      gatewayAudience: this.railConfig.gatewayAudience,
      providerAudience: listing.providerControlProfile.payload.providerAudience,
      providerControlProfileHash:
        listing.commitment.payload.providerControlProfileHash,
      orderId: order.orderId,
      orderKey: order.orderKey,
      serviceId: listing.commitment.payload.serviceId,
      reputationEligible: isReputationEligiblePayer(
        payer,
        listing,
        this.railConfig,
      ),
      reputationContract: this.railConfig.reputationContract,
      outcomeSchemaUid: this.railConfig.reputationOutcomeSchemaUid,
      dispatchNonce: nonce,
      payer,
      listingManifestHash: order.listingManifestHash,
      providerOfferHash: order.providerOfferHash,
      quoteHash: order.quoteHash,
      bindingProfile: listing.commitment.payload.bindingProfile,
      canonicalRequestHash: order.canonicalRequestHash,
      orderNonce: order.orderNonce,
      buyerIdentityProofHash: ZERO_HASH,
      activeRailProfileHash: this.railProfileHash,
      facilitatorConfirmationHash: confirmationHash,
      settlementTxHash: wireEvidenceBundle.deposit.transactionHash,
      depositEvidenceHash: wireEvidenceBundle.deposit.evidenceHash,
      depositBlockNumber: wireEvidenceBundle.deposit.blockNumber,
      depositBlockHash: wireEvidenceBundle.deposit.blockHash,
      depositTransactionIndex: wireEvidenceBundle.deposit.transactionIndex,
      depositLogIndex: wireEvidenceBundle.deposit.logIndex,
      releaseTxHash: wireEvidenceBundle.release.transactionHash,
      releaseEvidenceHash: wireEvidenceBundle.release.evidenceHash,
      releaseBlockNumber: wireEvidenceBundle.release.blockNumber,
      releaseBlockHash: wireEvidenceBundle.release.blockHash,
      releaseTransactionIndex: wireEvidenceBundle.release.transactionIndex,
      releaseLogIndex: wireEvidenceBundle.release.logIndex,
      releaseSequence: wireEvidenceBundle.release.releaseSequence,
      grossAmount: order.grossAmount,
      providerNetAmount,
      daskiCommissionAmount,
      canonicalProviderRequestHash: canonicalHash(providerRequest),
      dispatchDeadlineSeconds: listing.deadlinePolicy.dispatchSeconds,
      issuedAt,
      validBefore,
    });
    const persisted = await this.journal.dispatchClaim(order.orderId);
    const mayInvokeProvider = persisted === null;
    let dispatch: SignedEnvelope<StandardRailDispatchV2, 2>;
    let dispatchHash: Hex;
    let effectiveRequest = request;
    if (persisted) {
      dispatch = persisted.dispatch;
      dispatchHash = canonicalHash(dispatch);
      effectiveRequest = persisted.request;
      const expectedPayload = buildPayload(
        dispatch.payload.dispatchNonce,
        dispatch.payload.issuedAt,
        dispatch.payload.validBefore,
        effectiveRequest,
      );
      if (
        dispatch.payload.validBefore !==
          dispatch.payload.issuedAt + listing.deadlinePolicy.dispatchSeconds ||
        canonicalHash(dispatch.payload) !== canonicalHash(expectedPayload)
      ) throw new Error("Persisted dispatch does not match the order");
    } else {
      const nonce = `0x${randomBytes(32).toString("hex")}` as Hex;
      const now = Math.floor(Date.now() / 1_000);
      const payload = buildPayload(
        nonce,
        now,
        now + listing.deadlinePolicy.dispatchSeconds,
        request,
      );
      dispatch = await signEnvelope<StandardRailDispatchV2, 2>({
        artifactType: "StandardRailDispatchV2",
        schemaVersion: 2,
        environment: this.railConfig.environment,
        chainId: this.appConfig.chainId,
        audience: listing.providerControlProfile.payload.providerAudience,
        signerKeyId: "gateway-dispatch",
        privateKey: this.railConfig.dispatchPrivateKey,
        issuedAt: now,
        validBefore: now + listing.deadlinePolicy.dispatchSeconds,
        payload,
      });
      dispatchHash = canonicalHash(dispatch);
      if (!await this.journal.claimDispatch({
        orderId: order.orderId,
        nonce,
        dispatchHash,
        requestHash: canonicalHash(request),
        dispatch,
        request,
      })) throw new Error("Dispatch claim changed concurrently");
    }
    if (order.state === "RELEASE_FINAL") {
      order = await this.store.transition(
        order,
        "DISPATCH_STARTED",
        "dispatch_invocation_persisted",
      );
    } else if (
      order.state !== "DISPATCH_STARTED" &&
      order.state !== "DISPATCH_AMBIGUOUS"
    ) {
      throw new Error(
        `Order ${order.orderId} is not dispatchable from ${order.state}`,
      );
    }
    if (!mayInvokeProvider || order.state === "DISPATCH_AMBIGUOUS") {
      try {
        const response = await this.queryProviderDispatchStatus(
          listing,
          order.orderId,
          dispatchHash,
        );
        return this.applyDispatchResponse(order, listing, dispatchHash, response);
      } catch {
        return order.state === "DISPATCH_STARTED"
          ? this.store.transition(
              order,
              "DISPATCH_AMBIGUOUS",
              "provider_dispatch_outcome_unknown",
            )
          : order;
      }
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.min(
        this.railConfig.dispatchTimeoutMs,
        listing.providerControlProfile.payload.timeoutMs,
      ),
    );
    try {
      const response = await this.providerFetch(
        listing,
        listing.providerControlProfile.payload.dispatchUrl,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            dispatch,
            quote: order.quote,
            request: effectiveRequest,
            evidenceBundle: wireEvidenceBundle,
          }),
          signal: controller.signal,
          redirect: "error",
        },
      );
      if (!response.ok) {
        await discardResponseBody(response);
        throw new Error("provider_dispatch_rejected");
      }
      const body = await readBoundedJsonResponse(
        response,
        listing.providerControlProfile.payload.maxResponseBytes,
      );
      return this.applyDispatchResponse(order, listing, dispatchHash, body);
    } catch {
      return order.state === "DISPATCH_STARTED"
        ? this.store.transition(
            order,
            "DISPATCH_AMBIGUOUS",
            "provider_dispatch_response_unknown",
          )
        : order;
    } finally {
      clearTimeout(timeout);
    }
  }

  async reconcile(
    order: StandardOrderRecord,
    listing: StandardListing,
    dispatchHash: Hex,
  ): Promise<StandardOrderRecord> {
    const response = await this.queryProviderDispatchStatus(listing, order.orderId, dispatchHash);
    return this.applyDispatchResponse(order, listing, dispatchHash, response);
  }

  private async queryProviderDispatchStatus(
    listing: StandardListing,
    orderId: string,
    dispatchHash: Hex,
  ): Promise<unknown> {
    const now = Math.floor(Date.now() / 1_000);
    const query = await signEnvelope<DispatchStatusQueryV1>({
      artifactType: "DispatchStatusQueryV1",
      environment: this.railConfig.environment,
      chainId: this.appConfig.chainId,
      audience: listing.providerControlProfile.payload.providerAudience,
      signerKeyId: "gateway-dispatch",
      privateKey: this.railConfig.dispatchPrivateKey,
      issuedAt: now,
      validBefore: now + 60,
      payload: { orderId, dispatchHash, issuedAt: now, validBefore: now + 60 },
    });
    const response = await this.providerFetch(
      listing,
      listing.providerControlProfile.payload.dispatchStatusUrl,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(
          this.railConfig.dispatchTimeoutMs,
          listing.providerControlProfile.payload.timeoutMs,
        )),
      },
    );
    if (!response.ok) {
      await discardResponseBody(response);
      throw new Error("PROVIDER_DISPATCH_STATUS_UNAVAILABLE");
    }
    return readBoundedJsonResponse(
      response,
      listing.providerControlProfile.payload.maxResponseBytes,
    );
  }

  private async applyDispatchResponse(
    initial: StandardOrderRecord,
    listing: StandardListing,
    dispatchHash: Hex,
    value: unknown,
  ): Promise<StandardOrderRecord> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("provider_dispatch_response_malformed");
    }
    const body = value as {
      taskId?: unknown;
      dispatchHash?: unknown;
      signature?: unknown;
      state?: unknown;
      terminalAttestation?: {
        payload?: Record<string, unknown>;
        signature?: unknown;
      };
    };
    const terminal = ["completed", "failed", "canceled"].includes(
      String(body.state),
    );
    assertExactKeys(
      body,
      terminal
        ? ["taskId", "dispatchHash", "signature", "state", "terminalAttestation"]
        : ["taskId", "dispatchHash", "signature", "state"],
      "provider dispatch response",
    );
    if (
      typeof body.taskId !== "string" || body.taskId.length === 0 ||
      body.taskId.length > 128 || body.dispatchHash !== dispatchHash ||
      typeof body.signature !== "string" ||
      ![
        "dispatching",
        "submitted",
        "working",
        "input-required",
        "completed",
        "failed",
        "canceled",
      ].includes(String(body.state))
    ) throw new Error("provider_dispatch_response_malformed");
    const responseHash = canonicalHash({
      taskId: body.taskId,
      dispatchHash,
      state: body.state,
    });
    const signer = await recoverMessageAddress({
      message: { raw: responseHash },
      signature: body.signature as Hex,
    });
    if (
      getAddress(signer) !==
        getAddress(listing.commitment.payload.providerAuthorityKey)
    ) throw new Error("provider_dispatch_response_signature_invalid");
    await this.journal.resolveDispatch(initial.orderId, body.taskId, responseHash);
    let order = initial;
    if (["DISPATCH_STARTED", "DISPATCH_AMBIGUOUS"].includes(order.state)) {
      order = await this.store.transition(
        order,
        "DISPATCHED",
        "provider_dispatch_accepted",
        { providerTaskId: body.taskId },
      );
    } else if (order.providerTaskId !== body.taskId) {
      throw new Error("provider_dispatch_task_binding_invalid");
    }
    if (body.state === "input-required" && order.state === "DISPATCHED") {
      order = await this.store.transition(
        order,
        "INPUT_REQUIRED",
        "provider_pre_execute_hold",
      );
    } else if (
      ["dispatching", "submitted", "working"].includes(String(body.state)) &&
      order.state === "INPUT_REQUIRED"
    ) {
      order = await this.store.transition(
        order,
        "DISPATCHED",
        "provider_input_accepted",
      );
    } else if (terminal) {
      const attestation = body.terminalAttestation;
      if (!attestation?.payload || typeof attestation.signature !== "string") {
        throw new Error("provider_terminal_attestation_missing");
      }
      assertExactKeys(
        attestation,
        ["payload", "signature"],
        "provider terminal attestation",
      );
      assertExactKeys(
        attestation.payload,
        ["taskId", "dispatchHash", "state", "resultHash", "completedAt"],
        "provider terminal attestation payload",
      );
      const completedAt = attestation.payload.completedAt;
      if (
        typeof completedAt !== "number" || !Number.isSafeInteger(completedAt) ||
        completedAt <= 0 || completedAt > Math.floor(Date.now() / 1_000) + 30 ||
        typeof attestation.payload.resultHash !== "string" ||
        !/^0x[0-9a-fA-F]{64}$/.test(attestation.payload.resultHash)
      ) throw new Error("provider_terminal_attestation_time_invalid");
      const terminalSigner = await recoverMessageAddress({
        message: { raw: canonicalHash(attestation.payload) },
        signature: attestation.signature as Hex,
      });
      if (
        getAddress(terminalSigner) !==
          getAddress(
            listing.commitment.payload.providerTerminalAttestationKey,
          ) ||
        attestation.payload.taskId !== body.taskId ||
        attestation.payload.dispatchHash !== dispatchHash ||
        attestation.payload.state !== body.state
      ) throw new Error("provider_terminal_attestation_invalid");
      if (["DISPATCHED", "INPUT_REQUIRED"].includes(order.state)) {
        order = await this.store.transition(
          order,
          body.state === "completed" ? "FULFILLED" : "PROVIDER_FAILED",
          body.state === "completed"
            ? "provider_terminal_completed"
            : "provider_terminal_failed",
        );
      }
    }
    return order;
  }
}
