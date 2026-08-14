import {
  encodeFunctionData,
  getAddress,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import type { StandardRailConfig } from "./config.js";
import type { StandardReputationOrderV1 } from "./reputationOrders.js";

const reputationAbi = parseAbi([
  "function registerOrder((bytes32 orderKey,bytes32 authorizationKey,uint256 providerAgentId,bytes32 serviceId,address payer,address providerOwner,address providerAgentWallet,address providerPayee,address identityRegistry,address providerRegistry,address serviceRegistry,uint256 blockNumber,bytes32 blockHash,address canonicalToken,uint256 grossAmount,uint64 paidAt,bytes32 providerIdentitySnapshotHash,bytes32 listingManifestHash,bytes32 releaseEvidenceHash,bool reputationEligible,uint64 validBefore) permit,bytes signature)",
  "function recordRefund((bytes32 orderKey,bytes32 authorizationKey,uint256 cumulativeRefundedAmount,bytes32 refundEvidenceHash,uint64 validBefore) permit,bytes signature)",
]);

const easAbi = parseAbi([
  "function attestByDelegation((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value) data,(uint8 v,bytes32 r,bytes32 s) signature,address attester,uint64 deadline) delegatedRequest) payable returns (bytes32)",
  "function revokeByDelegation((bytes32 schema,(bytes32 uid,uint256 value) data,(uint8 v,bytes32 r,bytes32 s) signature,address revoker,uint64 deadline) delegatedRequest) payable",
]);

type StoredOrderPermit = Omit<StandardReputationOrderV1,
  "providerAgentId" | "blockNumber" | "grossAmount" | "paidAt" | "validBefore"> & {
  providerAgentId: string;
  blockNumber: string;
  grossAmount: string;
  paidAt: string;
  validBefore: string;
};

export interface RegisterIntent {
  operation: "register-order";
  permit: StoredOrderPermit;
  signature: Hex;
}

export interface RefundIntent {
  operation: "record-refund";
  permit: {
    orderKey: Hex;
    authorizationKey: Hex;
    cumulativeRefundedAmount: string;
    refundEvidenceHash: Hex;
    validBefore: string;
  };
  signature: Hex;
}

interface DelegatedSignature { v: number; r: Hex; s: Hex }

export interface ConfirmationIntent {
  operation: "attest-confirmation";
  orderKey: Hex;
  orderId: string;
  outcomeId: string;
  confirmation: "Confirmed" | "NotConfirmed";
  transitionsUsed: number;
  request: {
    schema: Hex;
    data: {
      recipient: Address;
      expirationTime: "0";
      revocable: true;
      refUID: Hex;
      data: Hex;
      value: "0";
    };
    signature: DelegatedSignature;
    attester: Address;
    deadline: string;
  };
}

export interface RevokeConfirmationIntent {
  operation: "revoke-confirmation";
  orderKey: Hex;
  orderId: string;
  outcomeId: string;
  transitionsUsed: number;
  request: {
    schema: Hex;
    data: { uid: Hex; value: "0" };
    signature: DelegatedSignature;
    revoker: Address;
    deadline: string;
  };
}

export type ReputationOperationIntent =
  | RegisterIntent
  | RefundIntent
  | ConfirmationIntent
  | RevokeConfirmationIntent;

export function encodeReputationOperation(
  intent: ReputationOperationIntent,
  config: StandardRailConfig,
): { data: Hex; destination: Address; gas: bigint } {
  if (intent.operation === "register-order") {
    return {
      destination: config.reputationContract,
      gas: config.reputationRegisterGasLimit,
      data: encodeFunctionData({
        abi: reputationAbi,
        functionName: "registerOrder",
        args: [{
          ...intent.permit,
          providerAgentId: BigInt(intent.permit.providerAgentId),
          blockNumber: BigInt(intent.permit.blockNumber),
          grossAmount: BigInt(intent.permit.grossAmount),
          paidAt: BigInt(intent.permit.paidAt),
          validBefore: BigInt(intent.permit.validBefore),
        }, intent.signature],
      }),
    };
  }
  if (intent.operation === "record-refund") {
    return {
      destination: config.reputationContract,
      gas: config.reputationRefundGasLimit,
      data: encodeFunctionData({
        abi: reputationAbi,
        functionName: "recordRefund",
        args: [{
          ...intent.permit,
          cumulativeRefundedAmount: BigInt(intent.permit.cumulativeRefundedAmount),
          validBefore: BigInt(intent.permit.validBefore),
        }, intent.signature],
      }),
    };
  }
  if (intent.operation === "attest-confirmation") {
    return {
      destination: config.easAddress,
      gas: config.reputationConfirmationGasLimit,
      data: encodeFunctionData({
        abi: easAbi,
        functionName: "attestByDelegation",
        args: [{
          ...intent.request,
          data: {
            ...intent.request.data,
            expirationTime: 0n,
            value: 0n,
          },
          attester: getAddress(intent.request.attester),
          deadline: BigInt(intent.request.deadline),
        }],
      }),
    };
  }
  return {
    destination: config.easAddress,
    gas: config.reputationConfirmationGasLimit,
    data: encodeFunctionData({
      abi: easAbi,
      functionName: "revokeByDelegation",
      args: [{
        ...intent.request,
        data: { ...intent.request.data, value: 0n },
        revoker: getAddress(intent.request.revoker),
        deadline: BigInt(intent.request.deadline),
      }],
    }),
  };
}
