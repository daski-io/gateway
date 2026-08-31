import {
  keccak256,
  stringToHex,
  type Hex,
} from "viem";

export type OrderAction =
  | "status"
  | "input"
  | "cancel"
  | "artifact"
  | "support"
  | "confirmation"
  | "revoke-confirmation"
  | "grant-read";

export interface OrderActionChallenge {
  orderId: string;
  action: OrderAction;
  method: "POST";
  absoluteResourceUri: string;
  requestHash: Hex;
  nonce: Hex;
  issuedAt: number;
  validBefore: number;
}

export const ORDER_ACTION_TYPES = {
  OrderActionAuthorizationV1: [
    { name: "orderIdHash", type: "bytes32" },
    { name: "actionHash", type: "bytes32" },
    { name: "methodHash", type: "bytes32" },
    { name: "absoluteResourceUriHash", type: "bytes32" },
    { name: "requestHash", type: "bytes32" },
    { name: "audienceHash", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "validBefore", type: "uint64" },
  ],
} as const;

export function orderActionSignRequest(args: {
  challenge: OrderActionChallenge;
  chainId: number;
  gatewayAudience: string;
}) {
  const challenge = args.challenge;
  return {
    domain: {
      name: "DaskiStandardOrder",
      version: "1",
      chainId: args.chainId,
    },
    types: ORDER_ACTION_TYPES,
    primaryType: "OrderActionAuthorizationV1" as const,
    message: {
      orderIdHash: keccak256(stringToHex(challenge.orderId)),
      actionHash: keccak256(stringToHex(challenge.action)),
      methodHash: keccak256(stringToHex(challenge.method)),
      absoluteResourceUriHash: keccak256(stringToHex(challenge.absoluteResourceUri)),
      requestHash: challenge.requestHash,
      audienceHash: keccak256(stringToHex(args.gatewayAudience)),
      nonce: challenge.nonce,
      issuedAt: challenge.issuedAt,
      validBefore: challenge.validBefore,
    },
  };
}
