import type { FetchAgentCardOptions } from "../identity/fetch-agent-card.js";
import type {
  Hex,
  PaymentPayload,
  SettlementResponse,
  StoredChallenge,
} from "../types.js";

export interface SettleInput {
  payload: PaymentPayload;
  challenge: StoredChallenge;
}

export type SettleResult =
  | { ok: true; status: 200; response: SettlementResponse }
  | {
      ok: false;
      status: number;
      response: SettlementResponse;
      failure: {
        code: string;
        message: string;
        retryable?: boolean;
      };
    };

export type VerifyResult =
  | {
      ok: true;
      alreadyPaid: boolean;
      payer: Hex;
      settleArgs: {
        signature: Hex;
        nonceSalt: Hex;
        validAfter: bigint;
        validBefore: bigint;
        nonce: Hex;
      };
    }
  | {
      ok: false;
      errorReason: string;
      message: string;
      status: number;
      payer?: Hex;
    };

export interface RegistrationDelegation {
  agentURI: string;
  deadline: bigint;
  signature: Hex;
}

export interface VerifyAndSettleWithRegistrationOptions {
  fetchAgentCardFn?: FetchAgentCardOptions["fetchFn"];
}

export interface AtomicSettlementOptions {
  registration: RegistrationDelegation;
  options: VerifyAndSettleWithRegistrationOptions;
}
