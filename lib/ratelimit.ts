/**
 * Fixed-window rate limiter, in process memory.
 *
 * Be clear about what this does and does not do, because the honest version is
 * more useful than a comforting one:
 *
 * - On Hostinger the app is ONE long-lived `next start` process, so this is a
 *   correct global limiter. It is exactly what @fastify/rate-limit was doing.
 * - On Vercel each function instance has its own memory, so the effective limit
 *   is `max` per instance, not per deployment. A determined attacker spread
 *   across instances gets a multiple of `max`.
 *
 * That is accepted rather than papered over, for a specific reason: the only
 * secret worth brute-forcing here is a licence key, and the real backstops are
 * the seat limit and revocation, both of which live in the database and are not
 * per-instance. A shared limiter would mean a network round trip to Redis on the
 * path of the very request it protects.
 *
 * When that trade stops being right - the moment there is real abuse - the swap
 * is this one function, backed by Upstash or Vercel's firewall. Nothing else in
 * the codebase knows how limiting is implemented.
 */

interface Window {
  count: number
  resetAt: number
}

const windows = new Map<string, Window>()

/** Keeps the map from growing without bound on a long-lived process. */
function sweep (now: number): void {
  if (windows.size < 1024) return
  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key)
  }
}

export interface RateLimitResult {
  allowed: boolean
  limit: number
  remaining: number
  resetAt: number
  retryAfterSeconds: number
}

export function checkRateLimit (
  key: string,
  { max, windowMs }: { max: number, windowMs: number },
  now: number = Date.now()
): RateLimitResult {
  sweep(now)

  const existing = windows.get(key)
  if (!existing || existing.resetAt <= now) {
    const window: Window = { count: 1, resetAt: now + windowMs }
    windows.set(key, window)
    return {
      allowed: true,
      limit: max,
      remaining: max - 1,
      resetAt: window.resetAt,
      retryAfterSeconds: 0
    }
  }

  existing.count += 1
  const allowed = existing.count <= max
  return {
    allowed,
    limit: max,
    remaining: Math.max(0, max - existing.count),
    resetAt: existing.resetAt,
    retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((existing.resetAt - now) / 1000))
  }
}

/** Test seam. */
export function resetRateLimits (): void {
  windows.clear()
}

export function rateLimitHeaders (result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    'x-ratelimit-limit': String(result.limit),
    'x-ratelimit-remaining': String(result.remaining),
    'x-ratelimit-reset': String(Math.ceil(result.resetAt / 1000))
  }
  if (!result.allowed) headers['retry-after'] = String(result.retryAfterSeconds)
  return headers
}
