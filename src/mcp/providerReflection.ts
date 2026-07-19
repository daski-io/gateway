import { sanitizeForLlmReflection } from "../util/sanitize.js";

const REFLECTION_OPTIONS = { stringMax: 4000, maxDepth: 12 };

export function sanitizeProviderValue<T>(value: T): T {
  return sanitizeForLlmReflection(value, REFLECTION_OPTIONS);
}

export function sanitizeProviderArtifacts(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((artifact) => {
    if (!isRecord(artifact)) return sanitizeProviderValue(artifact);
    const reflected = sanitizeProviderValue({
      ...artifact,
      parts: undefined,
    }) as Record<string, unknown>;
    if (typeof artifact.name === "string") {
      reflected.name = sanitizeProviderValue(artifact.name);
    }
    if (Array.isArray(artifact.parts)) {
      reflected.parts = artifact.parts.map(sanitizePart);
    }
    return reflected;
  });
}

export function sanitizeProviderTaskEvent(
  event: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!event) return null;
  const reflected = sanitizeProviderValue({
    ...event,
    artifacts: undefined,
  }) as Record<string, unknown>;
  if (Array.isArray(event.artifacts)) {
    reflected.artifacts = sanitizeProviderArtifacts(event.artifacts);
  }
  return reflected;
}

function sanitizePart(part: unknown): unknown {
  if (!isRecord(part)) return sanitizeProviderValue(part);
  const kind =
    typeof part.kind === "string"
      ? part.kind
      : typeof part.type === "string"
        ? part.type
        : null;
  if (kind === "file" && isRecord(part.file)) {
    const file = part.file;
    return {
      ...sanitizeProviderValue({ ...part, file: undefined }),
      file: {
        ...sanitizeProviderValue({
          ...file,
          bytes: undefined,
          url: undefined,
        }),
        ...(typeof file.bytes === "string" ? { bytes: file.bytes } : {}),
        ...(typeof file.url === "string" ? { url: file.url } : {}),
      },
    };
  }
  return sanitizeProviderValue(part);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
