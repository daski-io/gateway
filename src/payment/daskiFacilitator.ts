import { x402Facilitator } from "@x402/core/facilitator";
import type {
  Network,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { privateKeyToAccount } from "viem/accounts";
import type { ChainReader } from "../chain/reader.js";
import { type Config, DASKI_X402_EXTENSION_URI } from "../config.js";
import type { Queries } from "../db/queries.js";
import type { FetchAgentCardOptions } from "../identity/fetch-agent-card.js";
import type {
  DaskiPaymentPayload,
  Hex,
  SettlementResponse,
} from "../types.js";
import { logger } from "../util/logger.js";
import type { ChainDeploymentReadinessProbe } from "./deploymentReadiness.js";
import { settleChallenge } from "./settlementCoordinator.js";
import { verifyPaymentPayload } from "./verifyPayload.js";
import { hashCanonical } from "./requirementResponse.js";
import {
  materializePaymentPayload,
  paymentPayloadCorrelation,
} from "./paymentPayload.js";
import { settlementFailure } from "./settlementResults.js";
import type { SettleResult } from "./verifyTypes.js";
import {
  ProviderAuthorityError,
  type ProviderAuthorityService,
} from "./providerAuthority.js";

export interface DaskiFacilitatorDeps {
  config: Config;
  queries: Queries;
  reader: ChainReader;
  deploymentReadiness: ChainDeploymentReadinessProbe;
  providerAuthority: ProviderAuthorityService;
  fetchAgentCardFn?: FetchAgentCardOptions["fetchFn"];
}

export class DaskiFacilitatorService {
  private readonly core: x402Facilitator;
  private readonly adapter: DaskiExactEvmFacilitator;

  constructor(deps: DaskiFacilitatorDeps) {
    this.adapter = new DaskiExactEvmFacilitator(deps);
    this.core = new x402Facilitator()
      .register(deps.config.x402Network, this.adapter)
      .registerExtension({ key: DASKI_X402_EXTENSION_URI });
  }

  verify(
    payload: DaskiPaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const startedAt = Date.now();
    return this.adapter.verify(payload, requirements).then((result) => {
      logger.info("x402.verify", {
        valid: result.isValid,
        reason: result.isValid ? "valid" : result.invalidReason,
        network: requirements.network,
        durationMs: Date.now() - startedAt,
      });
      return result;
    });
  }

  settle(
    payload: DaskiPaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettlementResponse> {
    return this.settleDetailed(payload, requirements).then(
      (result) => result.response,
    );
  }

  settleDetailed(
    payload: DaskiPaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResult> {
    const startedAt = Date.now();
    return this.adapter
      .executeSettlement(payload, requirements)
      .then((result) => {
        logger.info("x402.settle", {
          success: result.response.success,
          reason: result.ok ? "success" : result.failure.code,
          network: requirements.network,
          durationMs: Date.now() - startedAt,
        });
        return result;
      });
  }

  getSupported(): SupportedResponse {
    return this.core.getSupported() as SupportedResponse;
  }
}

class DaskiExactEvmFacilitator implements SchemeNetworkFacilitator {
  readonly scheme = "daski-exact";
  readonly caipFamily = "eip155:*";
  private readonly facilitatorAddress: Hex;

  constructor(private readonly deps: DaskiFacilitatorDeps) {
    if (!deps.config.facilitatorPrivateKey) {
      throw new Error("native facilitator requires FACILITATOR_PRIVATE_KEY");
    }
    const account = privateKeyToAccount(deps.config.facilitatorPrivateKey);
    this.facilitatorAddress = account.address.toLowerCase() as Hex;
  }

  getExtra(_network: Network): Record<string, unknown> {
    return { daskiProfile: "1" };
  }

  getSigners(_network: Network): string[] {
    return [this.facilitatorAddress];
  }

  async verify(
    payload: DaskiPaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const located = await this.loadChallenge(payload);
    if (!located.ok) return located.response;
    if (
      located.challenge.settlementState !== "paid" &&
      located.challenge.settlementState !== "sanctions_rejected" &&
      !(await this.deps.deploymentReadiness.isReady())
    ) {
      // Readiness refusals must carry their reason (2026-08-01 flake).
      // invalidReason stays stable; the probe's failedCheck rides in the
      // message so it reaches whoever logs the refusal.
      const { failedCheck } = this.deps.deploymentReadiness.status();
      const reason = failedCheck ?? "unready";
      logger.warn("x402.readiness_refused", {
        site: "facilitator_verify",
        failedCheck: reason,
      });
      return {
        isValid: false,
        invalidReason: "payment_screening_unready",
        invalidMessage:
          `Payment cannot be processed right now (${reason}). ` +
          "Please try again later.",
      };
    }
    const context = this.materializeContext(
      payload,
      requirements,
      located.challenge,
    );
    if (!context.ok) return context.response;
    const verified = await verifyPaymentPayload(
      { payload: context.payload, challenge: context.challenge },
      this.deps.config,
      this.deps.reader,
      new Date(),
      { queries: this.deps.queries },
    );
    if (!verified.ok) {
      return {
        isValid: false,
        invalidReason: verified.errorReason,
        invalidMessage: verified.message,
        ...(verified.payer ? { payer: verified.payer } : {}),
      };
    }
    if (verified.alreadyPaid) {
      logger.info("x402.challenge_replay", { outcome: "stored_settlement" });
      return { isValid: true, payer: verified.payer };
    }
    return { isValid: true, payer: verified.payer };
  }

  async settle(
    payload: DaskiPaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<import("@x402/core/types").SettleResponse> {
    return (await this.executeSettlement(payload, requirements)).response;
  }

  async executeSettlement(
    payload: DaskiPaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResult> {
    const located = await this.loadChallenge(payload);
    if (!located.ok) {
      return settlementFailure(
        400,
        located.response.invalidReason ?? "invalid_payment",
        located.response.invalidMessage ?? "payment validation failed",
        this.deps.config.x402Network,
      );
    }
    if (
      located.challenge.settlementState !== "paid" &&
      located.challenge.settlementState !== "sanctions_rejected" &&
      !(await this.deps.deploymentReadiness.isReady())
    ) {
      // Same contract as verify(): stable code, reason in the message.
      const { failedCheck } = this.deps.deploymentReadiness.status();
      const reason = failedCheck ?? "unready";
      logger.warn("x402.readiness_refused", {
        site: "facilitator_settle",
        failedCheck: reason,
      });
      return settlementFailure(
        503,
        "payment_screening_unready",
        `Payment cannot be processed right now (${reason}). ` +
          "Please try again later.",
        this.deps.config.x402Network,
      );
    }
    const context = this.materializeContext(
      payload,
      requirements,
      located.challenge,
    );
    if (!context.ok) {
      return settlementFailure(
        400,
        context.response.invalidReason ?? "invalid_payment",
        context.response.invalidMessage ?? "payment validation failed",
        this.deps.config.x402Network,
      );
    }
    if (
      context.challenge.settlementState !== "paid" &&
      !context.challenge.settlementFacilitatorTransactionId
    ) {
      try {
        const authority = await this.deps.providerAuthority.requireFresh(
          context.challenge.providerTokenId,
        );
        if (
          context.challenge.providerAuthorityWallet?.toLowerCase() !==
            authority.walletAddress.toLowerCase() ||
          context.challenge.providerAuthorityAgentUri !== authority.agentURI
        ) {
          return settlementFailure(
            409,
            "provider_authority_changed",
            "Provider authority changed; request a fresh quote and challenge.",
            this.deps.config.x402Network,
          );
        }
      } catch (error) {
        const inactive =
          error instanceof ProviderAuthorityError &&
          error.code === "provider_inactive";
        return settlementFailure(
          inactive ? 409 : 503,
          inactive
            ? "provider_authority_changed"
            : "provider_authority_unavailable",
          inactive
            ? "Provider is no longer active; request a different provider."
            : "Provider authority cannot be verified right now.",
          this.deps.config.x402Network,
        );
      }
    }
    const coordinated = await settleChallenge(
      {
        config: this.deps.config,
        reader: this.deps.reader,
        queries: this.deps.queries,
        fetchAgentCardFn: this.deps.fetchAgentCardFn,
      },
      { challenge: context.challenge, paymentPayload: context.payload },
    );
    if (coordinated.kind !== "result") {
      return settlementFailure(
        400,
        coordinated.kind,
        coordinated.kind === "invalid-registration"
          ? coordinated.message
          : "payment challenge does not match the settlement request",
        this.deps.config.x402Network,
      );
    }
    return coordinated.result;
  }

  private async loadChallenge(payload: DaskiPaymentPayload) {
    if (payload.x402Version !== 2) {
      return invalid("invalid_x402_version");
    }
    const correlation = paymentPayloadCorrelation(payload);
    if (!correlation.ok) return invalid(correlation.reason);
    const challenge = await this.deps.queries.getChallengeByRef(
      correlation.serviceRef,
    );
    if (!challenge) return invalid("challenge_not_found");
    return { ok: true as const, challenge };
  }

  private materializeContext(
    payload: DaskiPaymentPayload,
    requirements: PaymentRequirements,
    challenge: NonNullable<
      Awaited<ReturnType<Queries["getChallengeByRef"]>>
    >,
  ) {
    const expectedRequirements = challenge.paymentRequired?.accepts?.[0];
    if (!expectedRequirements) {
      return invalid("invalid_stored_challenge");
    }
    if (
      hashCanonical(requirements).toLowerCase() !==
      hashCanonical(expectedRequirements).toLowerCase()
    ) {
      return invalid("payment_requirements_mismatch");
    }
    const effectivePayload = materializePaymentPayload(payload, challenge);
    if (!effectivePayload) return invalid("invalid_payment_payload");
    return { ok: true as const, challenge, payload: effectivePayload };
  }
}

function invalid(
  reason: string,
): { ok: false; response: VerifyResponse } {
  return {
    ok: false as const,
    response: { isValid: false, invalidReason: reason },
  };
}
