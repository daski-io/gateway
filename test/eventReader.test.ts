import { describe, expect, it, vi } from "vitest";
import { createViemEventReader } from "../src/chain/viemEventReader.js";
import type { Hex } from "../src/types.js";

const ROUTER = "0x0000000000000000000000000000000000000001" as Hex;
const REPUTATION = "0x0000000000000000000000000000000000000002" as Hex;
const EAS = "0x0000000000000000000000000000000000000003" as Hex;
const TOKEN = "0x0000000000000000000000000000000000000004" as Hex;
const UID = `0x${"aa".repeat(32)}` as Hex;
const CONFIRMATION_SCHEMA = `0x${"bb".repeat(32)}` as Hex;
const SERVICE = `0x${"cc".repeat(32)}` as Hex;
const REF = `0x${"dd".repeat(32)}` as Hex;
const TX = `0x${"ee".repeat(32)}` as Hex;

const located = {
  blockNumber: 100n,
  transactionIndex: 2,
  logIndex: 3,
  transactionHash: TX,
};

describe("Viem projection event reader", () => {
  it("reads and normalizes all event sources without per-payment view calls", async () => {
    const getLogs = vi.fn(async (input: Record<string, any>) => {
      switch (input.event.name) {
        case "PaymentSettled":
          return [{
            ...located,
            args: {
              paymentId: 1n,
              serviceRef: REF,
              serviceId: SERVICE,
              buyerAgentId: 2n,
              providerAgentId: 3n,
              token: TOKEN,
              totalAmount: 100n,
              providerAmount: 90n,
              commission: 10n,
            },
          }];
        case "Refunded":
          return [{
            ...located,
            logIndex: 4,
            args: {
              paymentId: 1n,
              amountToBuyer: 20n,
              cumulativeRefunded: 20n,
            },
          }];
        case "PaymentRecorded":
          return [{
            ...located,
            logIndex: 5,
            args: {
              paymentId: 1n,
              providerAgentId: 3n,
              buyerAgentId: 2n,
              serviceId: SERVICE,
              reputationEligible: true,
            },
          }];
        case "OutcomeRecorded":
          return [{
            ...located,
            logIndex: 6,
            args: {
              paymentId: 1n,
              providerAgentId: 3n,
              buyerAgentId: 2n,
              serviceId: SERVICE,
              outcome: 0,
              outcomeAttestationDelay: 45n,
              attestationUid: UID,
            },
          }];
        case "BuyerConfirmationSubmitted":
          return [{
            ...located,
            logIndex: 7,
            args: {
              paymentId: 1n,
              providerAgentId: 3n,
              buyerAgentId: 2n,
              serviceId: SERVICE,
              confirmation: 1,
              attestationUid: UID,
              refUid: `0x${"00".repeat(32)}`,
            },
          }];
        case "Revoked":
          expect(input.args).toEqual({ schemaUID: CONFIRMATION_SCHEMA });
          return [{
            ...located,
            logIndex: 8,
            args: { uid: UID, schemaUID: CONFIRMATION_SCHEMA },
          }];
        default:
          throw new Error(`unexpected event ${input.event.name}`);
      }
    });
    const getBlock = vi.fn(async () => ({ timestamp: 1_700_000_000n }));
    const reader = createViemEventReader(
      { getLogs, getBlock },
      {
        paymentRouterAddress: ROUTER,
        reputationStorageAddress: REPUTATION,
        easAddress: EAS,
        confirmationSchemaUid: CONFIRMATION_SCHEMA,
      },
    );

    const events = await reader.getChainProjectionEvents(90n, 110n);

    expect(getLogs).toHaveBeenCalledTimes(6);
    expect(getBlock).toHaveBeenCalledOnce();
    expect(events.map((event) => event.kind)).toEqual([
      "payment_settled",
      "refunded",
      "payment_recorded",
      "outcome_recorded",
      "confirmation_submitted",
      "confirmation_revoked",
    ]);
    expect(events[0]).toMatchObject({
      kind: "payment_settled",
      blockTimestamp: 1_700_000_000n,
      totalAmount: 100n,
    });
    expect(events[3]).toMatchObject({
      kind: "outcome_recorded",
      outcomeCode: 0,
      fulfillmentSeconds: 45n,
      attestationUid: UID,
    });
  });
});
