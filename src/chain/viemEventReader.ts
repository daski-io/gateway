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
      const [
        settledLogs,
        refundLogs,
        paymentLogs,
        outcomeLogs,
        confirmationLogs,
        revocationLogs,
      ] = await Promise.all([
        publicClient.getLogs({
          address: options.paymentRouterAddress,
          event: paymentSettledEvent,
          fromBlock,
          toBlock,
        }),
        publicClient.getLogs({
          address: options.paymentRouterAddress,
          event: refundedEvent,
          fromBlock,
          toBlock,
        }),
        publicClient.getLogs({
          address: options.reputationStorageAddress,
          event: paymentRecordedEvent,
          fromBlock,
          toBlock,
        }),
        publicClient.getLogs({
          address: options.reputationStorageAddress,
          event: outcomeRecordedEvent,
          fromBlock,
          toBlock,
        }),
        publicClient.getLogs({
          address: options.reputationStorageAddress,
          event: confirmationSubmittedEvent,
          fromBlock,
          toBlock,
        }),
        publicClient.getLogs({
          address: options.easAddress,
          event: easRevokedEvent,
          args: { schemaUID: options.confirmationSchemaUid },
          fromBlock,
          toBlock,
        }),
      ]);

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
