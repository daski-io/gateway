import type { PaymentChainGateway } from "../chain/reader.js";
import type { Config } from "../config.js";
import type { Queries } from "../db/queries.js";
import { verifyAndSettleUnlocked } from "./settlementExecution.js";
import type {
  RegistrationDelegation,
  SettleInput,
  SettleResult,
  VerifyAndSettleWithRegistrationOptions,
} from "./verifyTypes.js";

export {
  persistSettlementEvent,
  validateSettlementEvent,
} from "./settlementResults.js";
export { verifyPaymentPayload } from "./verifyPayload.js";
export type {
  RegistrationDelegation,
  SettleInput,
  SettleResult,
  VerifyAndSettleWithRegistrationOptions,
  VerifyResult,
} from "./verifyTypes.js";

export async function verifyAndSettle(
  input: SettleInput,
  config: Config,
  reader: PaymentChainGateway,
  queries: Queries,
  now: Date = new Date(),
): Promise<SettleResult> {
  return withCurrentChallenge(input, queries, (current) =>
    verifyAndSettleUnlocked(current, config, reader, queries, now),
  );
}

export async function verifyAndSettleWithRegistration(
  input: SettleInput,
  registration: RegistrationDelegation,
  config: Config,
  reader: PaymentChainGateway,
  queries: Queries,
  now: Date = new Date(),
  options: VerifyAndSettleWithRegistrationOptions = {},
): Promise<SettleResult> {
  return withCurrentChallenge(input, queries, (current) =>
    verifyAndSettleUnlocked(current, config, reader, queries, now, {
      registration,
      options,
    }),
  );
}

function withCurrentChallenge(
  input: SettleInput,
  queries: Queries,
  action: (input: SettleInput) => Promise<SettleResult>,
): Promise<SettleResult> {
  return queries.withChallengeSettlementLock(
    input.challenge.serviceRef,
    async () => {
      const challenge =
        (await queries.getChallengeByRef(input.challenge.serviceRef)) ??
        input.challenge;
      return action({ ...input, challenge });
    },
  );
}
