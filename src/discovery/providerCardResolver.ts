import type { ProviderLegalMetadata } from "../legal/types.js";
import { parseProviderLegalMetadata } from "../legal/validation.js";
import type { ProviderCard } from "../types.js";
import type { GatewayLogger } from "../util/logger.js";
import type { AgentCardFetcher } from "./agentCardFetcher.js";
import { extractCardServiceSlug } from "./agentCard.js";
import { assertValidServiceTaxonomy } from "./taxonomyValidation.js";

export interface ResolvedProviderCards {
  cards: ProviderCard[];
  providerName: string | null;
  providerDescription: string | null;
  providerImage: string | null;
  providerExternalUrl: string | null;
  providerLegal: ProviderLegalMetadata;
  partialError: string | null;
}

interface ProviderCardResolverOptions {
  fetcher: AgentCardFetcher;
  maxA2AEntries: number;
  fetchConcurrency: number;
  logger: Pick<GatewayLogger, "warn">;
}

export class ProviderCardResolver {
  constructor(private readonly options: ProviderCardResolverOptions) {
    if (
      !Number.isSafeInteger(options.maxA2AEntries) ||
      options.maxA2AEntries <= 0 ||
      !Number.isSafeInteger(options.fetchConcurrency) ||
      options.fetchConcurrency <= 0
    ) {
      throw new Error("discovery limits must be positive integers");
    }
  }

  async resolve(agentURI: string, deadlineAt: number): Promise<ResolvedProviderCards> {
    const doc = await this.options.fetcher.fetchJson(agentURI, deadlineAt);
    const providerLegal = parseProviderLegalMetadata(doc);
    const services = doc.services;
    if (!Array.isArray(services)) {
      throw new Error("agent registration file must contain a services array");
    }
    const entries = services.filter(isA2AEntry);
    if (entries.length === 0) {
      throw new Error("registration file has no A2A service endpoint");
    }
    if (entries.length > this.options.maxA2AEntries) {
      throw new Error(
        `registration file advertises ${entries.length} A2A entries; ` +
          `maximum is ${this.options.maxA2AEntries}`,
      );
    }
    const outcomes = await mapWithConcurrency(
      entries,
      this.options.fetchConcurrency,
      (entry) => this.resolveCard(entry.endpoint, deadlineAt),
    );
    const cards = outcomes.flatMap((outcome) => (outcome.ok ? [outcome.card] : []));
    const errors = outcomes.flatMap((outcome) => (outcome.ok ? [] : [outcome.error]));
    if (cards.length === 0) {
      throw new Error(
        `all ${entries.length} agent card endpoint(s) failed: ${errors.join("; ")}`,
      );
    }
    return {
      cards,
      providerName: stringField(doc, "name"),
      providerDescription: stringField(doc, "description"),
      providerImage: stringField(doc, "image"),
      providerExternalUrl: stringField(doc, "external_url"),
      providerLegal,
      partialError: errors.length > 0 ? `partial card fetch: ${errors.join("; ")}` : null,
    };
  }

  private async resolveCard(endpoint: string, deadlineAt: number) {
    try {
      const agentCard = await this.options.fetcher.fetchJson(endpoint, deadlineAt);
      assertValidServiceTaxonomy(agentCard);
      const serviceSlug = extractCardServiceSlug(agentCard);
      if (!serviceSlug) {
        throw new Error("agent card is missing daski serviceSlug metadata");
      }
      return {
        ok: true as const,
        card: { endpoint, serviceSlug, agentCard },
      };
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      this.options.logger.warn("[cache] failed to fetch agent card", {
        endpoint,
        error,
      });
      return { ok: false as const, error: `${endpoint}: ${message}` };
    }
  }
}

function isA2AEntry(value: unknown): value is { endpoint: string } {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as Record<string, unknown>).name === "A2A" &&
      typeof (value as Record<string, unknown>).endpoint === "string" &&
      ((value as Record<string, unknown>).endpoint as string).length > 0,
  );
}

function stringField(doc: Record<string, unknown>, key: string): string | null {
  const value = doc[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  action: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await action(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
