import type { Request, Response, NextFunction } from "express";

// Inline equivalents of the bits of `helmet` + `express-rate-limit` we
// actually need. Kept dependency-free so a security audit doesn't require
// an npm install. Trade-offs:
//   * Headers list is a strict subset of helmet defaults — covers nosniff,
//     frameguard, referrer-policy, and HSTS. We skip CSP because the
//     gateway serves /skill.md and /llms-full.txt as markdown intended for
//     LLM crawlers; a CSP would bring no win.
//   * The rate limiter uses PostgreSQL when a shared store is supplied and
//     falls back to process memory for small standalone consumers.

export function securityHeaders(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  // HSTS: 6 months, no preload, no subdomains. Anything stricter requires
  // the operator to opt in.
  res.setHeader(
    "Strict-Transport-Security",
    "max-age=15552000",
  );
  next();
}

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Max requests per window. */
  max: number;
  /** Status code returned when over budget. Default 429. */
  statusCode?: number;
  /** Namespace prevents unrelated endpoint groups sharing a bucket. */
  namespace?: string;
  /** Global buckets cap aggregate work across clients and replicas. */
  keyScope?: "client" | "global";
  /** Shared store used by multi-replica deployments. */
  /** Optional bounded resource key, combined with the namespace. */
  key?: (req: Request) => string;
  store?: {
    consumeRateLimitBucket(
      key: string,
      windowMs: number,
    ): Promise<{ count: number; resetAt: Date }>;
  };
}

/**
 * Per-IP token bucket. Use on POST endpoints whose work costs facilitator
 * gas, including confirmation and settlement, so a
 * single hostile client can't drain operator funds via a tight loop.
 */
export function rateLimit(opts: RateLimitOptions) {
  if (
    !Number.isFinite(opts.windowMs) ||
    opts.windowMs <= 0 ||
    !Number.isInteger(opts.max) ||
    opts.max <= 0
  ) {
    throw new Error("rate-limit windowMs and max must be positive");
  }
  const buckets = new Map<string, Bucket>();
  const statusCode = opts.statusCode ?? 429;
  // Garbage collect stale buckets every minute to avoid unbounded growth
  // under churning IPs (proxies, mobile NAT).
  if (!opts.store) {
    const gc = setInterval(() => {
      const now = Date.now();
      for (const [k, v] of buckets) {
        if (v.resetAt < now) buckets.delete(k);
      }
    }, 60_000);
    gc.unref?.();
  }

  function finish(
    res: Response,
    next: NextFunction,
    count: number,
    resetAt: number,
  ): void {
    res.setHeader("X-RateLimit-Limit", String(opts.max));
    res.setHeader(
      "X-RateLimit-Remaining",
      String(Math.max(0, opts.max - count)),
    );
    res.setHeader("X-RateLimit-Reset", String(Math.floor(resetAt / 1000)));
    if (count > opts.max) {
      const now = Date.now();
      res.setHeader(
        "Retry-After",
        String(Math.max(1, Math.ceil((resetAt - now) / 1000))),
      );
      res.status(statusCode).json({
        error: {
          code: "RATE_LIMITED",
          message: "Too many requests; slow down.",
        },
      });
      return;
    }
    next();
  }

  return function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const clientKey = opts.key
      ? opts.key(req)
      : opts.keyScope === "global"
        ? "global"
        : (req.ip ?? req.socket.remoteAddress ?? "unknown");
    const key = `${opts.namespace ?? "default"}:${clientKey}`;
    if (opts.store) {
      void opts.store
        .consumeRateLimitBucket(key, opts.windowMs)
        .then(({ count, resetAt }) => {
          finish(res, next, count, resetAt.getTime());
        })
        .catch(next);
      return;
    }

    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt < now) {
      bucket = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    finish(res, next, bucket.count, bucket.resetAt);
  };
}
