import { parseAbiItem } from "viem";
import type { Hex } from "../types.js";
import type { ChainProjectionEvent } from "./eventTypes.js";

const paymentSettledEvent = parseAbiItem(
  "event PaymentSettled(uint256 indexed paymentId, bytes32 indexed serviceRef, bytes32 indexed serviceId, uint256 buyerAgentId, uint256 providerAgentId, address token, uint256 totalAmount, uint256 providerAmount, uint256 commission)",
);
const refundedEvent = parseAbiItem(
  "event Refunded(uint256 indexed paymentId, uint256 amountToBuyer, uint256 cumulativeRefunded)",
);
const paymentRecordedEvent = parseAbiItem(
  "event PaymentRecorded(uint256 indexed paymentId, uint256 indexed providerAgentId, uint256 indexed buyerAgentId, bytes32 serviceId, bool reputationEligible)",
);
const outcomeRecordedEvent = parseAbiItem(
  "event OutcomeRecorded(uint256 indexed paymentId, uint256 indexed providerAgentId, uint256 indexed buyerAgentId, bytes32 serviceId, uint8 outcome, uint256 outcomeAttestationDelay, bytes32 attestationUid)",
);
const confirmationSubmittedEvent = parseAbiItem(
  "event BuyerConfirmationSubmitted(uint256 indexed paymentId, uint256 indexed providerAgentId, uint256 indexed buyerAgentId, bytes32 serviceId, uint8 confirmation, bytes32 attestationUid, bytes32 refUid)",
);
const easRevokedEvent = parseAbiItem(
  "event Revoked(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)",
);

interface EventReaderOptions {
  paymentRouterAddress: Hex;
  reputationStorageAddress: Hex;
  easAddress: Hex;
  confirmationSchemaUid: Hex;
}

interface LocatedLog {
  blockNumber: bigint;
  transactionIndex: number;
  logIndex: number;
}

function location(log: {
  blockNumber: bigint | null;
  transactionIndex: number | null;
  logIndex: number | null;
}): LocatedLog {
  if (
    log.blockNumber === null ||
    log.transactionIndex === null ||
    log.logIndex === null
  ) {
    throw new Error("confirmed projection log is missing its chain location");
  }
  return {
    blockNumber: log.blockNumber,
    transactionIndex: log.transactionIndex,
    logIndex: log.logIndex,
  };
}

export function createViemEventReader(
  publicClient: {
    getLogs: (input: Record<string, unknown>) => Promise<any[]>;
    getBlock: (input: { blockNumber: bigint }) => Promise<{ timestamp: bigint }>;
  },
  options: EventReaderOptions,
) {
  return {
    async getChainProjectionEvents(
      fromBlock: bigint,
      toBlock: bigint,
    ): Promise<ChainProjectionEvent[]> {
      // ONE getLogs for all six filters. The previous six parallel
      // getLogs per page were a ~1,530-credit burst on every indexer
      // tick — enough to trip per-second provider throttles each tick
      // and, at the public endpoint, to saturate the gateway's own
      // per-IP allowance (the 2026-08-01 post-mortem attributed ~87% of
      // all RPC traffic and the historical rpc_unavailable flakes to
      // this loop). The six signatures are distinct, so demux is by
      // eventName; the address guard keeps a same-signature event on a
      // foreign contract out of the family, and the Revoked schemaUID
      // filter moves client-side because a merged `events` query cannot
      // carry per-event args.
      const logs = await publicClient.getLogs({
        address: [
          options.paymentRouterAddress,
          options.reputationStorageAddress,
          options.easAddress,
        ],
        events: [
          paymentSettledEvent,
          refundedEvent,
          paymentRecordedEvent,
          outcomeRecordedEvent,
          confirmationSubmittedEvent,
          easRevokedEvent,
        ],
        fromBlock,
        toBlock,
      });
      const from = (log: { address?: unknown }, expected: Hex) =>
        typeof log.address === "string" &&
        log.address.toLowerCase() === expected.toLowerCase();
      const named = (log: { eventName?: unknown }, name: string) =>
        log.eventName === name;
      const settledLogs = logs.filter(
        (log) =>
          named(log, "PaymentSettled") &&
          from(log, options.paymentRouterAddress),
      );
      const refundLogs = logs.filter(
        (log) =>
          named(log, "Refunded") && from(log, options.paymentRouterAddress),
      );
      const paymentLogs = logs.filter(
        (log) =>
          named(log, "PaymentRecorded") &&
          from(log, options.reputationStorageAddress),
      );
      const outcomeLogs = logs.filter(
        (log) =>
          named(log, "OutcomeRecorded") &&
          from(log, options.reputationStorageAddress),
      );
      const confirmationLogs = logs.filter(
        (log) =>
          named(log, "BuyerConfirmationSubmitted") &&
          from(log, options.reputationStorageAddress),
      );
      const revocationLogs = logs.filter((log) => {
        if (!named(log, "Revoked") || !from(log, options.easAddress)) {
          return false;
        }
        const schemaUID = (log.args as { schemaUID?: unknown } | undefined)
          ?.schemaUID;
        return (
          typeof schemaUID === "string" &&
          schemaUID.toLowerCase() ===
            options.confirmationSchemaUid.toLowerCase()
        );
      });

      const timestamps = new Map<bigint, bigint>();
      await Promise.all(
        [...new Set(settledLogs.map((log) => log.blockNumber))].map(
          async (blockNumber) => {
            const block = await publicClient.getBlock({ blockNumber });
            timestamps.set(blockNumber, block.timestamp);
          },
        ),
      );

      return [
        ...settledLogs.map((log): ChainProjectionEvent => {
          const args = log.args as {
            paymentId: bigint;
            serviceRef: Hex;
            serviceId: Hex;
            buyerAgentId: bigint;
            providerAgentId: bigint;
            token: Hex;
            totalAmount: bigint;
            providerAmount: bigint;
            commission: bigint;
          };
          return {
            kind: "payment_settled",
            ...location(log),
            blockTimestamp: timestamps.get(log.blockNumber) ?? 0n,
            transactionHash: log.transactionHash as Hex,
            ...args,
          };
        }),
        ...refundLogs.map((log): ChainProjectionEvent => {
          const args = log.args as {
            paymentId: bigint;
            cumulativeRefunded: bigint;
          };
          return { kind: "refunded", ...location(log), ...args };
        }),
        ...paymentLogs.map((log): ChainProjectionEvent => {
          const args = log.args as {
            paymentId: bigint;
            providerAgentId: bigint;
            buyerAgentId: bigint;
            serviceId: Hex;
            reputationEligible: boolean;
          };
          return { kind: "payment_recorded", ...location(log), ...args };
        }),
        ...outcomeLogs.map((log): ChainProjectionEvent => {
          const args = log.args as {
            paymentId: bigint;
            providerAgentId: bigint;
            buyerAgentId: bigint;
            serviceId: Hex;
            outcome: number;
            outcomeAttestationDelay: bigint;
            attestationUid: Hex;
          };
          return {
            kind: "outcome_recorded",
            ...location(log),
            paymentId: args.paymentId,
            providerAgentId: args.providerAgentId,
            buyerAgentId: args.buyerAgentId,
            serviceId: args.serviceId,
            outcomeCode: args.outcome,
            fulfillmentSeconds: args.outcomeAttestationDelay,
            attestationUid: args.attestationUid,
          };
        }),
        ...confirmationLogs.map((log): ChainProjectionEvent => {
          const args = log.args as {
            paymentId: bigint;
            providerAgentId: bigint;
            buyerAgentId: bigint;
            serviceId: Hex;
            confirmation: number;
            attestationUid: Hex;
          };
          return {
            kind: "confirmation_submitted",
            ...location(log),
            paymentId: args.paymentId,
            providerAgentId: args.providerAgentId,
            buyerAgentId: args.buyerAgentId,
            serviceId: args.serviceId,
            confirmationCode: args.confirmation,
            attestationUid: args.attestationUid,
          };
        }),
        ...revocationLogs.map((log): ChainProjectionEvent => ({
          kind: "confirmation_revoked",
          ...location(log),
          attestationUid: (log.args as { uid: Hex }).uid,
        })),
      ];
    },
  };
}
