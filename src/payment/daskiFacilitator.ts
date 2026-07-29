import { x402Facilitator } from "@x402/core/facilitator";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { privateKeyToAccount } from "viem/accounts";
import type { ChainReader } from "../chain/reader.js";
import {
  type Config,
  DASKI_X402_EXTENSION_URI,
} from "../config.js";
import type { Queries } from "../db/queries.js";
import type { FetchAgentCardOptions } from "../identity/fetch-agent-card.js";
import type { Hex } from "../types.js";
import { logger } from "../util/logger.js";
import type { ChainDeploymentReadinessProbe } from "./deploymentReadiness.js";
import { settleChallenge } from "./settlementCoordinator.js";
import { verifyPaymentPayload } from "./verifyPayload.js";
import { getDaskiDeclaration } from "./x402Extension.js";
import { hashCanonical } from "./requirementResponse.js";

export interface DaskiFacilitatorDeps {
  config: Config;
  queries: Queries;
  reader: ChainReader;
  deploymentReadiness: ChainDeploymentReadinessProbe;
  fetchAgentCardFn?: FetchAgentCardOptions["fetchFn"];
}

export class DaskiFacilitatorService {
  private readonly core: x402Facilitator;

  constructor(deps: DaskiFacilitatorDeps) {
    const adapter = new DaskiExactEvmFacilitator(deps);
    this.core = new x402Facilitator()
      .register(deps.config.x402Network, adapter)
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
  ): Promise<SettleResponse> {
    const startedAt = Date.now();
    return this.core.settle(payload, requirements).then((result) => {
      logger.info("x402.settle", {
        success: result.success,
        reason: result.success ? "success" : result.errorReason,
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
    if (this.deps.reader.simulatePayment) {
      try {
        await this.deps.reader.simulatePayment(
          {
            providerAgentId: context.challenge.providerTokenId,
            serviceId: context.challenge.serviceId,
            amount: context.challenge.amount,
            serviceRef: context.challenge.serviceRef,
            from: verified.payer,
            ...verified.settleArgs,
          },
          context.challenge.registrationDelegation
            ? {
                agentURI: context.challenge.registrationDelegation.agentURI,
                deadline: BigInt(
                  context.challenge.registrationDelegation.deadline,
                ),
                signature:
                  context.challenge.registrationDelegation.signature,
              }
            : undefined,
        );
      } catch {
        return {
          isValid: false,
          invalidReason: "daski_adapter_simulation_failed",
          payer: verified.payer,
        };
      }
    }
    return { isValid: true, payer: verified.payer };
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const context = await this.loadContext(payload, requirements);
    if (!context.ok) return settleFailure(this.deps.config.x402Network, context.response);
    if (context.challenge.settlementState !== "sanctions_rejected") {
      const verification = await this.verify(payload, requirements);
      if (!verification.isValid) {
        return settleFailure(this.deps.config.x402Network, verification);
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
      return settleFailure(this.deps.config.x402Network, {
        isValid: false,
        invalidReason: coordinated.kind,
        invalidMessage:
          coordinated.kind === "invalid-registration"
            ? coordinated.message
            : undefined,
      });
    }
    return coordinated.result.response;
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

function settleFailure(
  network: Network,
  response: VerifyResponse,
): SettleResponse {
  return {
    success: false,
    errorReason: response.invalidReason ?? "invalid_payment",
    errorMessage: response.invalidMessage,
    payer: response.payer,
    transaction: "",
    network,
  };
}
