import { findUnknownServiceArgKeys } from "./util.js";

export function unknownServiceArgWarnings(
  skillMeta: { requiredFields?: unknown; optionalFields?: unknown },
  rawServiceArgs: Record<string, unknown> | undefined,
): string[] {
  const required = Array.isArray(skillMeta.requiredFields)
    ? (skillMeta.requiredFields as string[])
    : [];
  const optional = Array.isArray(skillMeta.optionalFields)
    ? (skillMeta.optionalFields as string[])
    : [];
  const unknown = findUnknownServiceArgKeys(rawServiceArgs, required, optional);
  if (unknown.length === 0) return [];
  return [
    `Unsupported serviceArgs ignored by this skill: ${unknown.join(", ")}. ` +
      `Supported fields — required: [${required.join(", ") || "none"}]; ` +
      `optional: [${optional.join(", ") || "none"}]. The skill will not ` +
      "act on ignored fields.",
  ];
}
