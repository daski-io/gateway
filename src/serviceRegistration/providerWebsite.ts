import type { MarketplaceChainReader } from "../marketplace/reader.js";
import { assertNoDuplicateJsonKeys } from "../standardRail/canonical.js";
import { logger } from "../util/logger.js";
import { fetchProviderCardJson } from "./cardFetch.js";

/*
 * A provider's website, as its ERC-8004 registration file states it in
 * `external_url`, for the public service views (`providerWebsiteUrl`). The
 * file is the one the identity registry's `tokenURI` names, read with one
 * uncached chain read, and fetched like an AgentCard: HTTPS to public
 * addresses only, no redirects, bounded size and time. An inline `data:` file
 * is read in place; no other scheme is fetched. Only a credential-free HTTPS
 * URL without a fragment is shown; anything else is no website.
 *
 * A display enrichment: a provider's answer is used for an hour, a failed
 * read keeps the last answer for up to a day and is tried again after five
 * minutes, and a view never fails for it. A view waits briefly only before a
 * provider's very first read, then shows it without a website until a read
 * lands. At most two reads, chain read and fetch together, run at once, so
 * neither a cold catalog nor the hour all providers fall due crowds the chain
 * reader's lane. A failing provider is logged when it starts failing, not at
 * every retry.
 */

const MAXIMUM_URL_LENGTH = 2_048;
const MAXIMUM_INLINE_URI_LENGTH = 90_000;
const MAXIMUM_INLINE_BYTES = 65_536;
const FRESH_MS = 60 * 60_000;
const RETRY_MS = 5 * 60_000;
const STALE_LIMIT_MS = 24 * 60 * 60_000;
const FIRST_READ_WAIT_MS = 1_500;
const MAXIMUM_PROVIDERS = 1_000;
const CONCURRENT_READS = 2;

/** The website a registration file states, or null when it states none this gateway shows. */
export function providerWebsite(registration: unknown): string | null {
  if (!registration || typeof registration !== "object" || Array.isArray(registration)) return null;
  const raw = (registration as Record<string, unknown>).external_url;
  if (
    typeof raw !== "string" || raw.length === 0 || raw.length > MAXIMUM_URL_LENGTH ||
    raw.includes("#") || /[\s\u0000-\u001f\u007f]/.test(raw)
  ) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) return null;
  return url.href.length <= MAXIMUM_URL_LENGTH ? url.href : null;
}

/** The JSON of an inline `data:` registration file, held to the rules of a fetched one. */
function inlineJson(uri: string): unknown {
  if (uri.length > MAXIMUM_INLINE_URI_LENGTH) throw new Error("inline registration file is too large");
  const comma = uri.indexOf(",");
  if (comma < 0) throw new Error("inline registration file is malformed");
  const metadata = uri.slice(5, comma);
  const payload = uri.slice(comma + 1);
  const decoded = /;base64(?:;|$)/i.test(metadata)
    ? Buffer.from(payload, "base64").toString("utf8")
    : decodeURIComponent(payload);
  if (Buffer.byteLength(decoded, "utf8") > MAXIMUM_INLINE_BYTES) {
    throw new Error("inline registration file is too large");
  }
  assertNoDuplicateJsonKeys(decoded);
  return JSON.parse(decoded) as unknown;
}

interface Entry {
  /** The last answer read; null when the file states no website. */
  value: string | null;
  /** When that answer was read; null before any read succeeded. */
  readAt: number | null;
  /** When to read again; 0 before the first attempt. */
  next: number;
  /** Whether the last attempt failed: logged once when it starts. */
  failing: boolean;
  work: Promise<void> | null;
}

export class ProviderWebsites {
  private readonly entries = new Map<string, Entry>();
  private readonly queue: Array<() => void> = [];
  private running = 0;

  constructor(
    private readonly chain: Pick<MarketplaceChainReader, "getAgentUri">,
    private readonly loadJson: (url: string) => Promise<unknown> = (url) => fetchProviderCardJson(url),
    private readonly now: () => number = Date.now,
    private readonly firstReadWaitMs = FIRST_READ_WAIT_MS,
  ) {}

  /** Each provider's website as known now; only a provider's first read is waited for, briefly. Never rejects. */
  async websites(agentIds: readonly string[]): Promise<Map<string, string | null>> {
    const unique = [...new Set(agentIds)];
    const firstReads: Promise<void>[] = [];
    for (const agentId of unique) {
      const first = (this.entries.get(agentId)?.next ?? 0) === 0;
      const work = this.refreshIfDue(agentId);
      if (first && work) firstReads.push(work);
    }
    if (firstReads.length > 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled(firstReads),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.firstReadWaitMs);
          timer.unref();
        }),
      ]);
      clearTimeout(timer);
    }
    return new Map(unique.map((agentId) => [agentId, this.current(agentId)]));
  }

  private current(agentId: string): string | null {
    const entry = this.entries.get(agentId);
    if (!entry || entry.readAt === null || this.now() - entry.readAt > STALE_LIMIT_MS) return null;
    return entry.value;
  }

  private refreshIfDue(agentId: string): Promise<void> | null {
    let entry = this.entries.get(agentId);
    if (!entry) {
      this.makeRoom();
      entry = { value: null, readAt: null, next: 0, failing: false, work: null };
      this.entries.set(agentId, entry);
    }
    if (entry.work) return entry.work;
    if (entry.next !== 0 && this.now() < entry.next) return null;
    const target = entry;
    // From here on the provider is no longer first-read: a view never waits for it again.
    target.next = this.now() + RETRY_MS;
    target.work = this.limited(() => this.read(agentId))
      .then((value) => {
        target.value = value;
        target.readAt = this.now();
        target.next = this.now() + FRESH_MS;
        target.failing = false;
      }, (error: unknown) => {
        target.next = this.now() + RETRY_MS;
        if (!target.failing) {
          logger.warn("provider website unavailable", {
            providerAgentId: agentId,
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        }
        target.failing = true;
      })
      .finally(() => {
        target.work = null;
      });
    return target.work;
  }

  /** Drops the oldest entry no read is running for, once the table is full. */
  private makeRoom(): void {
    if (this.entries.size < MAXIMUM_PROVIDERS) return;
    for (const [agentId, entry] of this.entries) {
      if (entry.work) continue;
      this.entries.delete(agentId);
      return;
    }
  }

  private async read(agentId: string): Promise<string | null> {
    const agentUri = await this.chain.getAgentUri(BigInt(agentId));
    if (typeof agentUri !== "string" || agentUri.length === 0) return null;
    if (agentUri.startsWith("data:")) return providerWebsite(inlineJson(agentUri));
    // A file this gateway does not fetch (IPFS, plain HTTP) states no website it shows.
    if (!agentUri.startsWith("https://")) return null;
    return providerWebsite(await this.loadJson(agentUri));
  }

  private async limited<T>(task: () => Promise<T>): Promise<T> {
    // A finished read hands its slot to the next waiting one directly.
    if (this.running >= CONCURRENT_READS) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else {
      this.running += 1;
    }
    try {
      return await task();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.running -= 1;
    }
  }
}
