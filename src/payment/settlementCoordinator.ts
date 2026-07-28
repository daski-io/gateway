import type { ChainReader } from "../chain/reader.js";
import type { Config } from "../config.js";
import type { Queries } from "../db/queries.js";
import type { FetchAgentCardOptions } from "../identity/fetch-agent-card.js";
import type { Hex, PaymentPayload, StoredChallenge } from "../types.js";
import {
  verifyAndSettle,
  verifyAndSettleWithRegistration,
  type RegistrationDelegation,
  type SettleResult,
} from "./verify.js";

export interface SettlementCoordinatorDeps {
  config: Config;
  reader: ChainReader;
  queries: Queries;
  fetchAgentCardFn?: FetchAgentCardOptions["fetchFn"];
}

export interface RegistrationInput {
  agentURI?: unknown;
  deadline?: unknown;
  signature?: unknown;
}

export type CoordinatedSettlement =
  | { kind: "registration-required" }
  | { kind: "invalid-registration"; message: string }
  | { kind: "result"; result: SettleResult };

export function parseRegistration(
  raw: RegistrationInput | undefined,
): RegistrationDelegation | { error: string } {
  if (!raw || typeof raw !== "object") {
    return { error: "registration must be an object" };
  }
  const agentURI = typeof raw.agentURI === "string" ? raw.agentURI : "";
  if (typeof raw.deadline !== "string" || !/^[1-9][0-9]*$/.test(raw.deadline)) {
    return {
      error: "registration.deadline must be a positive decimal string",
    };
  }
  if (
    typeof raw.signature !== "string" ||
    !/^0x([0-9a-fA-F]{2})+$/.test(raw.signature) ||
    raw.signature.length < 4
  ) {
    return {
      error: "registration.signature must be a non-empty hex string",
    };
  }
  return {
    agentURI,
    deadline: BigInt(raw.deadline),
    signature: raw.signature as Hex,
  };
}

export async function settleChallenge(
  deps: SettlementCoordinatorDeps,
  input: {
    challenge: StoredChallenge;
    paymentPayload: PaymentPayload;
    registration?: RegistrationInput;
  },
): Promise<CoordinatedSettlement> {
  if (input.challenge.buyerTokenId !== 0n) {
    return {
      kind: "result",
      result: await verifyAndSettle(
        {
          payload: input.paymentPayload,
          challenge: input.challenge,
        },
        deps.config,
        deps.reader,
        deps.queries,
      ),
    };
  }

  const rawRegistration =
    input.registration ?? input.challenge.registrationDelegation ?? undefined;
  if (!rawRegistration) {
    return { kind: "registration-required" };
  }
  const registration = parseRegistration(rawRegistration);
  if ("error" in registration) {
    return {
      kind: "invalid-registration",
      message: registration.error,
    };
  }
  return {
    kind: "result",
    result: await verifyAndSettleWithRegistration(
      {
        payload: input.paymentPayload,
        challenge: input.challenge,
      },
      registration,
      deps.config,
      deps.reader,
      deps.queries,
      new Date(),
      { fetchAgentCardFn: deps.fetchAgentCardFn },
    ),
  };
}
