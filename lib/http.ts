import type { ZodError } from 'zod'

/**
 * Response helpers, so every endpoint answers in one shape.
 *
 * The Fastify app had a single error handler that guaranteed this. Route handlers
 * have no equivalent hook, so the guarantee has to come from everything going
 * through these functions.
 *
 * These return a plain web `Response`, not `NextResponse`. Next accepts either,
 * and avoiding the `next/server` import keeps this module - and therefore every
 * handler built on it - importable by the test runner directly, with no build
 * step and no bundler in the loop.
 */

const NO_STORE = {
  // A licence response is specific to one machine and one moment. Next caches
  // aggressively by default and a cached token would be a correctness bug, not
  // just a stale read.
  'cache-control': 'no-store, max-age=0',
  'content-type': 'application/json; charset=utf-8'
} as const

export function json (body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...NO_STORE, ...headers }
  })
}

export function apiError (
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {}
): Response {
  return json({ error: code, ...extra }, status, headers)
}

export function noContent (): Response {
  return new Response(null, {
    status: 204,
    headers: { 'cache-control': 'no-store, max-age=0' }
  })
}

/**
 * Turns a Zod failure into the 400 body.
 *
 * `problems` is a flat array of "field: message" strings, which fixes a mismatch
 * carried over from the Fastify version: the server sent `{error, message}` while
 * the web client read `detail.problems`, so validation detail never actually
 * reached the user - they saw the bare code. The client always expected this
 * shape; now it gets it.
 */
export function validationError (error: ZodError): Response {
  const problems = error.issues.map((issue) => {
    const path = issue.path.join('.')
    return path ? `${path}: ${issue.message}` : issue.message
  })
  return json({ error: 'validation_failed', problems }, 400)
}

/**
 * Parses a JSON body without letting malformed input become a 500.
 *
 * Fastify rejected bad JSON before a handler ran. Here `request.json()` throws,
 * and an unhandled throw in a route handler is a 500 - which would tell a client
 * author "the server is broken" when the truth is "your body is not JSON".
 */
export async function readJsonBody (request: Request): Promise<
  { ok: true, value: unknown } | { ok: false, response: Response }
> {
  try {
    return { ok: true, value: await request.json() }
  } catch {
    return { ok: false, response: apiError(400, 'invalid_json') }
  }
}

/**
 * The client address.
 *
 * TLS terminates in front of the app on both hosts, so the socket address is a
 * proxy and only a forwarded header carries the real client. Without this the
 * rate limiter would see every request as one client and protect nothing - the
 * same reason `trustProxy` defaulted on in the Fastify config.
 *
 * x-forwarded-for may be a comma-separated chain; the left-most entry is the
 * original client.
 */
export function clientIp (request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }
  return request.headers.get('x-real-ip')?.trim() ?? 'unknown'
}

/**
 * Wraps a handler so an unexpected throw becomes a logged 500 with an opaque
 * body, never a stack trace on the wire.
 */
export function withErrorHandling<C> (
  handler: (request: Request, context: C) => Promise<Response>
) {
  return async (request: Request, context: C): Promise<Response> => {
    try {
      return await handler(request, context)
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        msg: 'request failed',
        url: request.url,
        method: request.method,
        err: error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
      }))
      return apiError(500, 'internal_error')
    }
  }
}
