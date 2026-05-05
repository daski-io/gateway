import type { Request, Response, NextFunction } from "express";

// Inline equivalents of the bits of `helmet` + `express-rate-limit` we
// actually need. Kept dependency-free so a security audit doesn't require
// an npm install. Trade-offs:
//   * Headers list is a strict subset of helmet defaults — covers nosniff,
//     frameguard, referrer-policy, and HSTS. We skip CSP because the
//     gateway serves /skill.md and /llms-full.txt as markdown intended for
//     LLM crawlers; a CSP would bring no win.
//   * The rate limiter is a leaky-bucket over `req.ip`, in-memory per
//     process. A multi-replica deploy will undercount; that's fine for
//     burst protection (the goal is to make facilitator gas drains
//     expensive), and the operator can add a CDN/edge layer in front for
//     a global view.

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
}

/**
 * Per-IP token bucket. Use on POST endpoints whose work costs facilitator
 * gas (`/register`, `/confirm/:paymentId`) so a
 * single hostile client can't drain operator funds via a tight loop.
 */
export function rateLimit(opts: RateLimitOptions) {
  const buckets = new Map<string, Bucket>();
  const statusCode = opts.statusCode ?? 429;
  // Garbage collect stale buckets every minute to avoid unbounded growth
  // under churning IPs (proxies, mobile NAT).
  const gc = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of buckets) {
      if (v.resetAt < now) buckets.delete(k);
    }
  }, 60_000);
  // Don't keep the event loop alive just for the GC tick.
  if (typeof gc.unref === "function") gc.unref();

  return function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const key = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt < now) {
      bucket = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    res.setHeader("X-RateLimit-Limit", String(opts.max));
    res.setHeader(
      "X-RateLimit-Remaining",
      String(Math.max(0, opts.max - bucket.count)),
    );
    res.setHeader(
      "X-RateLimit-Reset",
      String(Math.floor(bucket.resetAt / 1000)),
    );
    if (bucket.count > opts.max) {
      res.setHeader(
        "Retry-After",
        String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))),
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
  };
}
