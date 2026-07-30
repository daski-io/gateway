import { x402Facilitator } from "@x402/core/facilitator";
import type {
  Network,
  PaymentPayload,
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
import type { Hex } from "../types.js";
import type { SettlementResponse } from "../types.js";
import { logger } from "../util/logger.js";
import type { ChainDeploymentReadinessProbe } from "./deploymentReadiness.js";
import { settleChallenge } from "./settlementCoordinator.js";
import { verifyPaymentPayload } from "./verifyPayload.js";
import { getDaskiDeclaration } from "./x402Extension.js";
import { hashCanonical } from "./requirementResponse.js";
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
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const startedAt = Date.now();
    return this.core.verify(payload, requirements).then((result) => {
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
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettlementResponse> {
    return this.settleDetailed(payload, requirements).then(
      (result) => result.response,
    );
  }

  settleDetailed(
    payload: PaymentPayload,
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
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const context = await this.loadContext(payload, requirements);
    if (!context.ok) return context.response;
    if (
      context.challenge.settlementState !== "paid" &&
      context.challenge.settlementState !== "sanctions_rejected" &&
      !(await this.deps.deploymentReadiness.isReady())
    ) {
      return {
        isValid: false,
        invalidReason: "payment_screening_unready",
      };
    }
    const verified = await verifyPaymentPayload(
      { payload, challenge: context.challenge },
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
        payer: verified.payer,
      };
    }
    if (verified.alreadyPaid) {
      logger.info("x402.challenge_replay", { outcome: "stored_settlement" });
      return { isValid: true, payer: verified.payer };
    }
    return { isValid: true, payer: verified.payer };
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<import("@x402/core/types").SettleResponse> {
    return (await this.executeSettlement(payload, requirements)).response;
  }

  async executeSettlement(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResult> {
    const context = await this.loadContext(payload, requirements);
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
      context.challenge.settlementState !== "sanctions_rejected" &&
      !(await this.deps.deploymentReadiness.isReady())
    ) {
      return settlementFailure(
        503,
        "payment_screening_unready",
        "Payment cannot be processed right now. Please try again later.",
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
      { challenge: context.challenge, paymentPayload: payload },
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

  private async loadContext(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<
    | {
        ok: true;
        challenge: NonNullable<
          Awaited<ReturnType<Queries["getChallengeByRef"]>>
        >;
      }
    | { ok: false; response: VerifyResponse }
  > {
    if (payload.x402Version !== 2) {
      return invalid("invalid_x402_version");
    }
    const declaration = getDaskiDeclaration(payload);
    if (!declaration) return invalid("daski_extension_missing");
    const challenge = await this.deps.queries.getChallengeByRef(
      declaration.info.serviceRef.toLowerCase() as Hex,
    );
    if (!challenge) return invalid("challenge_not_found");
    if (
      !challenge.paymentRequired ||
      hashCanonical(requirements).toLowerCase() !==
        hashCanonical(payload.accepted).toLowerCase()
    ) {
      return invalid("payment_requirements_mismatch");
    }
    return { ok: true, challenge };
  }
}

function invalid(reason: string) {
  return {
    ok: false as const,
    response: { isValid: false, invalidReason: reason },
  };
}
