import type { FeedbackInput } from "../chain/reader.js";
import type { Config } from "../config.js";
import type { Hex } from "../types.js";

const CONFIRMED_VALUE = 100n;

export function easscanAttestationUrl(chainId: number, uid: Hex): string {
  const host =
    chainId === 8453 ? "base.easscan.org" : "base-sepolia.easscan.org";
  return `https://${host}/attestation/view/${uid}`;
}

export function buildFeedbackInput(input: {
  config: Config;
  providerAgentId: bigint;
  confirmation: "Confirmed" | "NotConfirmed";
  attestationUid: Hex;
  serviceSlug: string;
}): FeedbackInput {
  return {
    agentId: input.providerAgentId,
    value: input.confirmation === "Confirmed" ? CONFIRMED_VALUE : 0n,
    valueDecimals: 0,
    tag1: "daski",
    tag2: input.serviceSlug,
    endpoint: "",
    feedbackURI: easscanAttestationUrl(
      input.config.chainId,
      input.attestationUid,
    ),
    feedbackHash: input.attestationUid,
  };
}
