import { signToken, verifyToken } from '../lib/licence.js'
import { readJsonBody } from '../lib/validate.js'

const LICENCE_KEY = { type: 'string', required: true, min: 8, max: 64, pattern: /^[A-Za-z0-9-]+$/ }
// The client hashes its own machine identifiers before sending them, so the
// server only ever stores an opaque digest. Enforce that shape rather than
// accepting whatever the client feels like sending.
const FINGERPRINT = { type: 'string', required: true, min: 16, max: 128, pattern: /^[A-Za-z0-9_-]+$/ }

const ACTIVATE_SPEC = {
  licenceKey: LICENCE_KEY,
  fingerprint: FINGERPRINT,
  appVersion: { type: 'string', max: 32 }
}

const REFRESH_SPEC = {
  token: { type: 'string', required: true, min: 32, max: 4096 }
}

/**
 * Builds the token a client lives on for the next TTL window.
 *
 * `features` come from the licence row and are baked into the signed payload, so
 * the client reads its entitlements from verified data rather than from a local
 * flag it could flip.
 */
function issue (services, licence, fingerprint) {
  const { token, payload } = signToken(services.licenceKeys.privateKey, {
    licenceKey: licence.key,
    fingerprint,
    tier: licence.tier,
    features: licence.features,
    ttlSeconds: services.config.licence.ttlSeconds,
    graceSeconds: services.config.licence.graceSeconds
  })

  return {
    token,
    tier: payload.tier,
    features: payload.features,
    issuedAt: new Date(payload.iat * 1000).toISOString(),
    expiresAt: new Date(payload.exp * 1000).toISOString(),
    // Stated explicitly so the client's offline behaviour is a policy the server
    // declares, not a constant compiled into the binary.
    graceSeconds: payload.grace
  }
}

export default function licenceRoutes (app, services) {
  app.post('/v1/licence/activate', async (context) => {
    const body = await readJsonBody(context, ACTIVATE_SPEC)
    if (!body.ok) {
      return context.json({ error: 'validation_failed', problems: body.problems }, 400)
    }

    const { licenceKey, fingerprint, appVersion } = body.value
    const licence = await services.storage.getLicence(licenceKey)

    if (!licence) return context.json({ error: 'licence_not_found' }, 404)
    if (licence.status !== 'active') {
      return context.json({ error: 'licence_inactive', status: licence.status }, 403)
    }

    // Record first, then enforce the seat cap, then roll back if we pushed it
    // over. Counting before inserting would let two simultaneous activations
    // both see a free seat and both take it.
    const { created } = await services.storage.recordActivation({ licenceKey, fingerprint, appVersion })
    const activations = await services.storage.listActivations(licenceKey)

    if (created && activations.length > licence.maxSeats) {
      await services.storage.deleteActivation({ licenceKey, fingerprint })
      return context.json({
        error: 'seat_limit_reached',
        seats: { used: licence.maxSeats, max: licence.maxSeats }
      }, 403)
    }

    return context.json({
      ...issue(services, licence, fingerprint),
      seats: { used: activations.length, max: licence.maxSeats }
    })
  })

  /**
   * Refreshes a token. Deliberately accepts an *expired* token: expiry is how
   * the client knows to ask again, not a reason to refuse. The licence row is
   * the authority, which is what makes revocation work — a refunded key stops
   * refreshing and its last token ages out within one TTL.
   */
  app.post('/v1/licence/refresh', async (context) => {
    const body = await readJsonBody(context, REFRESH_SPEC)
    if (!body.ok) {
      return context.json({ error: 'validation_failed', problems: body.problems }, 400)
    }

    const result = verifyToken(services.licenceKeys.publicKey, body.value.token)
    if (!result.ok) return context.json({ error: result.reason }, 401)

    const { key: licenceKey, fp: fingerprint } = result.payload
    const licence = await services.storage.getLicence(licenceKey)

    if (!licence) return context.json({ error: 'licence_not_found' }, 404)
    if (licence.status !== 'active') {
      return context.json({ error: 'licence_inactive', status: licence.status }, 403)
    }

    // A refresh is also a heartbeat: it is how last_seen stays current.
    await services.storage.recordActivation({ licenceKey, fingerprint })
    const activations = await services.storage.listActivations(licenceKey)

    return context.json({
      ...issue(services, licence, fingerprint),
      seats: { used: activations.length, max: licence.maxSeats }
    })
  })
}
