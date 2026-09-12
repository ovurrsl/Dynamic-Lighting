/**
 * Fixed-window rate limiter, in process memory.
 *
 * In-process is the right scope here rather than a limitation: this host runs
 * one process and stops it when idle, so there is nothing to share state with.
 * A Redis-backed limiter would add a network round-trip to the very requests it
 * is meant to protect, and a dependency to the cold start it would slow down.
 *
 * What it actually protects: a valid licence key is the only secret involved in
 * activation, so activation and refresh are the endpoints worth guessing at.
 */
export function createRateLimiter ({ max, windowMs, now = () => Date.now() }) {
  const windows = new Map()

  // Without this, a burst of unique client addresses would grow the Map without
  // bound until the process is recycled.
  const prune = (currentTime) => {
    for (const [key, window] of windows) {
      if (currentTime - window.start > windowMs) windows.delete(key)
    }
  }

  let lastPrune = now()

  return {
    /** @returns {{allowed: boolean, remaining: number, retryAfterSeconds: number}} */
    hit (key) {
      const currentTime = now()

      if (currentTime - lastPrune > windowMs) {
        prune(currentTime)
        lastPrune = currentTime
      }

      const window = windows.get(key)
      if (!window || currentTime - window.start > windowMs) {
        windows.set(key, { start: currentTime, count: 1 })
        return { allowed: true, remaining: max - 1, retryAfterSeconds: 0 }
      }

      window.count += 1
      if (window.count > max) {
        const msLeft = windowMs - (currentTime - window.start)
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil(msLeft / 1000))
        }
      }

      return { allowed: true, remaining: max - window.count, retryAfterSeconds: 0 }
    },

    get size () {
      return windows.size
    }
  }
}

/**
 * Resolves the client address.
 *
 * TLS terminates in front of the app on this host, so the socket address is
 * always the proxy. Without reading the forwarded header the limiter would see
 * every request as one client and protect nothing.
 */
export function clientKey (context, trustProxy) {
  if (trustProxy) {
    const forwarded = context.req.header('x-forwarded-for')
    if (forwarded) return forwarded.split(',')[0].trim()
  }
  return context.env?.incoming?.socket?.remoteAddress ?? 'unknown'
}
