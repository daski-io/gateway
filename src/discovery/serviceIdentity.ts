import {
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
} from "viem";
import type { CachedProvider, Hex } from "../types.js";
import { cardsOf, parseAgentSkills } from "./agentCard.js";

const DEFAULT_SERVICE_VERSION = "1";

function skillMetadata(
  agentCard: Record<string, unknown>,
  skillId: string,
): Record<string, unknown> | null {
  return (
    parseAgentSkills(agentCard).find((skill) => skill.id === skillId)
      ?.metadata ?? null
  );
}

export function resolveServiceVersion(
  agentCard: Record<string, unknown>,
  skillId: string,
): string {
  const metadata = skillMetadata(agentCard, skillId);
  const raw = metadata?.["serviceVersion"] ?? metadata?.["version"];
  return typeof raw === "string" && raw.length > 0 && raw.length <= 32
    ? raw
    : DEFAULT_SERVICE_VERSION;
}

export function resolveServiceSlug(
  agentCard: Record<string, unknown>,
  skillId: string,
): string | null {
  const raw = skillMetadata(agentCard, skillId)?.["serviceSlug"];
  return typeof raw === "string" && raw.length > 0 && raw.length <= 64
    ? raw
    : null;
}

/** Mirror ServiceRegistry's service identity derivation. */
export function computeServiceId(
  providerAgentId: bigint,
  serviceSlug: string,
  version: string,
): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("uint256, string, string"), [
      providerAgentId,
      serviceSlug,
      version,
    ]),
  ) as Hex;
}

export function derivePrimaryServiceId(
  provider: CachedProvider,
): { serviceSlug: string; serviceVersion: string; serviceId: Hex } | null {
  for (const card of cardsOf(provider)) {
    for (const skill of parseAgentSkills(card.agentCard)) {
      const rawSlug = skill.metadata["serviceSlug"];
      const serviceSlug =
        typeof rawSlug === "string" && rawSlug.length > 0 && rawSlug.length <= 64
          ? rawSlug
          : null;
      if (!serviceSlug) continue;
      const rawVersion =
        skill.metadata["serviceVersion"] ?? skill.metadata["version"];
      const serviceVersion =
        typeof rawVersion === "string" &&
        rawVersion.length > 0 &&
        rawVersion.length <= 32
          ? rawVersion
          : DEFAULT_SERVICE_VERSION;
      return {
        serviceSlug,
        serviceVersion,
        serviceId: computeServiceId(
          provider.agentId,
          serviceSlug,
          serviceVersion,
        ),
      };
    }
  }
  return null;
}
