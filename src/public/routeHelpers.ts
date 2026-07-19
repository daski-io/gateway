import type { Response } from "express";
import type { Config } from "../config.js";
import type { DiscoveryCache } from "../discovery/cache.js";
import { formatServicesForPublic } from "./format.js";
import type { Hex } from "../types.js";

export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await fn(items[index]!, index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return output;
}

export function buildServiceNameResolver(
  cache: DiscoveryCache,
  config: Config,
) {
  const byServiceId = new Map<string, string>();
  const bySlug = new Map<string, string>();
  for (const provider of cache.getAll()) {
    for (const service of formatServicesForPublic(provider, config)) {
      if (service.serviceId) {
        byServiceId.set(service.serviceId.toLowerCase(), service.name);
      }
      if (service.serviceSlug) {
        bySlug.set(
          `${provider.agentId.toString()}:${service.serviceSlug}`,
          service.name,
        );
      }
    }
  }
  return (
    providerAgentId: bigint,
    serviceId: Hex,
    serviceSlug: string | null,
  ): string | null => {
    const name = byServiceId.get(serviceId.toLowerCase());
    if (name) return name;
    return serviceSlug
      ? (bySlug.get(`${providerAgentId.toString()}:${serviceSlug}`) ?? null)
      : null;
  };
}

export function parseLimit(
  raw: unknown,
  fallback: number,
  cap: number,
): number {
  if (typeof raw !== "string") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(Math.floor(parsed), cap)
    : fallback;
}

export function serviceNotFound(res: Response): void {
  res.status(404).json({
    error: { code: "SERVICE_NOT_FOUND", message: "unknown service" },
  });
}
