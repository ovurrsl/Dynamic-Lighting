import { apiError, clientIp } from '#lib/http'
import { verifyToken } from '#lib/licence'
import { checkRateLimit, rateLimitHeaders } from '#lib/ratelimit'
import { getContext } from '#lib/server'

/**
 * Shared request gates.
 *
 * Fastify expressed these as an `addHook('preHandler')` registered once per
 * plugin. There is no hook here, so each handler calls these explicitly. That is
 * more typing and one better property: which gate applies to which route is
 * visible in the handler instead of inherited from registration order.
 */

export interface LicenceIdentity {
  key: string
  tier: string
  features: string[]
  expired: boolean
}

/**
 * Rate limit gate. Returns a response to send, or null to continue.
 *
 * Keyed by route as well as address so a burst of activations cannot exhaust the
 * budget for preset reads.
 */
export function enforceRateLimit (request: Request, route: string): Response | null {
  const { config } = getContext()
  const result = checkRateLimit(`${route}:${clientIp(request)}`, config.rateLimit)
  if (result.allowed) return null

  return apiError(
    429,
    'rate_limit_exceeded',
    { retryAfterSeconds: result.retryAfterSeconds },
    rateLimitHeaders(result)
  )
}

/**
 * Bearer-token gate for the preset endpoints.
 *
 * The licence token IS the credential - there is no separate session system. It
 * is already signed, already scoped to one licence, and the client already holds
 * it, so adding passwords on top would buy nothing.
 *
 * An expired token is accepted here. The alternative is a customer whose presets
 * vanish because our host was asleep when their refresh was due, which is the
 * same fail-closed trap the engine avoids.
 */
export function requireLicence (
  request: Request
): { ok: true, licence: LicenceIdentity } | { ok: false, response: Response } {
  const header = request.headers.get('authorization') ?? ''
  const [scheme, token] = header.split(' ')

  if (scheme !== 'Bearer' || !token) {
    return { ok: false, response: apiError(401, 'authorization_required') }
  }

  const { licenceKeys } = getContext()
  const result = verifyToken(licenceKeys.publicKey, token)
  if (!result.ok) {
    return { ok: false, response: apiError(401, result.reason) }
  }

  return {
    ok: true,
    licence: {
      key: result.payload.key,
      tier: result.payload.tier,
      features: result.payload.features ?? [],
      expired: result.expired
    }
  }
}
