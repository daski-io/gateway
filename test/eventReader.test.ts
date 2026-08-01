import { describe, expect, it, vi } from "vitest";
import { createViemEventReader } from "../src/chain/viemEventReader.js";
import type { Hex } from "../src/types.js";

const ROUTER = "0x0000000000000000000000000000000000000001" as Hex;
const REPUTATION = "0x0000000000000000000000000000000000000002" as Hex;
const EAS = "0x0000000000000000000000000000000000000003" as Hex;
const TOKEN = "0x0000000000000000000000000000000000000004" as Hex;
const UID = `0x${"aa".repeat(32)}` as Hex;
const CONFIRMATION_SCHEMA = `0x${"bb".repeat(32)}` as Hex;
const OTHER_SCHEMA = `0x${"99".repeat(32)}` as Hex;
const SERVICE = `0x${"cc".repeat(32)}` as Hex;
const REF = `0x${"dd".repeat(32)}` as Hex;
const TX = `0x${"ee".repeat(32)}` as Hex;

const located = {
  blockNumber: 100n,
  transactionIndex: 2,
  logIndex: 3,
  transactionHash: TX,
};

// One merged getLogs per page (2026-08-01 post-mortem: six parallel
// getLogs per tick were a per-second credit burst). The mock returns the
// merged log list — including a wrong-schema Revoked and a same-signature
// event from a foreign address, which the demux filters must drop.
describe("Viem projection event reader", () => {
  it("reads all event sources in ONE getLogs and normalizes them", async () => {
    const getLogs = vi.fn(async (input: Record<string, any>) => {
      expect(input.address).toEqual([ROUTER, REPUTATION, EAS]);
      expect(input.events).toHaveLength(6);
      expect(input.fromBlock).toBe(90n);
      expect(input.toBlock).toBe(110n);
      return [
        {
          ...located,
          address: ROUTER,
          eventName: "PaymentSettled",
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
        },
        {
          ...located,
          logIndex: 4,
          address: ROUTER,
          eventName: "Refunded",
          args: {
            paymentId: 1n,
            amountToBuyer: 20n,
            cumulativeRefunded: 20n,
          },
        },
        {
          ...located,
          logIndex: 5,
          address: REPUTATION,
          eventName: "PaymentRecorded",
          args: {
            paymentId: 1n,
            providerAgentId: 3n,
            buyerAgentId: 2n,
            serviceId: SERVICE,
            reputationEligible: true,
          },
        },
        {
          ...located,
          logIndex: 6,
          address: REPUTATION,
          eventName: "OutcomeRecorded",
          args: {
            paymentId: 1n,
            providerAgentId: 3n,
            buyerAgentId: 2n,
            serviceId: SERVICE,
            outcome: 0,
            outcomeAttestationDelay: 45n,
            attestationUid: UID,
          },
        },
        {
          ...located,
          logIndex: 7,
          address: REPUTATION,
          eventName: "BuyerConfirmationSubmitted",
          args: {
            paymentId: 1n,
            providerAgentId: 3n,
            buyerAgentId: 2n,
            serviceId: SERVICE,
            confirmation: 1,
            attestationUid: UID,
            refUid: `0x${"00".repeat(32)}`,
          },
        },
        {
          ...located,
          logIndex: 8,
          address: EAS,
          eventName: "Revoked",
          args: { uid: UID, schemaUID: CONFIRMATION_SCHEMA },
        },
        // Dropped: right signature, foreign schema — the schemaUID filter
        // moved client-side when the queries merged.
        {
          ...located,
          logIndex: 9,
          address: EAS,
          eventName: "Revoked",
          args: { uid: UID, schemaUID: OTHER_SCHEMA },
        },
        // Dropped: same signature emitted by a contract outside the
        // event's home address — the address guard keeps families honest.
        {
          ...located,
          logIndex: 10,
          address: REPUTATION,
          eventName: "PaymentSettled",
          args: {
            paymentId: 99n,
            serviceRef: REF,
            serviceId: SERVICE,
            buyerAgentId: 2n,
            providerAgentId: 3n,
            token: TOKEN,
            totalAmount: 1n,
            providerAmount: 1n,
            commission: 0n,
          },
        },
      ];
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

    expect(getLogs).toHaveBeenCalledTimes(1);
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
