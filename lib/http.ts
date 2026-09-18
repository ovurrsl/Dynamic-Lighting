/**
 * Response helpers, so the two endpoints that are left answer in one shape.
 *
 * These return a plain web `Response`, not `NextResponse`. Next accepts either,
 * and avoiding the `next/server` import keeps this module - and therefore every
 * handler built on it - importable by the test runner directly, with no build
 * step and no bundler in the loop.
 */

const NO_STORE = {
  // Liveness answered from a cache stops meaning anything about the deployment
  // behind it, and a version string is the same.
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

/**
 * Turns an unexpected throw into a 500 with a logged cause rather than a stack
 * trace on the wire. Route handlers have no framework-level error hook, so the
 * guarantee has to come from every handler going through this.
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
