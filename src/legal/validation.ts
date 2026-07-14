import type { ProviderLegalMetadata } from "./types.js";

export class ProviderLegalValidationError extends Error {
  constructor(message: string) {
    super(`invalid provider legal metadata: ${message}`);
    this.name = "ProviderLegalValidationError";
  }
}

function nonemptyTrimmed(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProviderLegalValidationError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

export function parseHttpsUrl(value: unknown, field: string): string {
  const raw = nonemptyTrimmed(value, field);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ProviderLegalValidationError(`${field} must be a valid URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new ProviderLegalValidationError(`${field} must use HTTPS`);
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new ProviderLegalValidationError(
      `${field} must not contain embedded credentials`,
    );
  }
  return parsed.toString();
}

export function requireMarketplaceHttpsUrl(
  name: string,
  value: string | undefined,
): string {
  if (value === undefined) {
    throw new Error(`${name} env var is required`);
  }
  try {
    return parseHttpsUrl(value, name);
  } catch (error) {
    throw new Error((error as Error).message);
  }
}

export function parseProviderLegalMetadata(
  registration: Record<string, unknown>,
): ProviderLegalMetadata {
  return {
    legalName: nonemptyTrimmed(registration.legalName, "legalName"),
    termsUrl: parseHttpsUrl(registration.termsUrl, "termsUrl"),
    privacyUrl: parseHttpsUrl(registration.privacyUrl, "privacyUrl"),
  };
}
