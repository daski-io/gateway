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
  | { ok: true; response: SettlementResponse }
  | {
      ok: false;
      errorReason: string;
      message: string;
      status: number;
      response: SettlementResponse;
    };

export type VerifyResult =
  | {
      ok: true;
      alreadyPaid: boolean;
      payer: Hex;
      settleArgs: {
        v: number;
        r: Hex;
        s: Hex;
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
      payer: Hex;
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
