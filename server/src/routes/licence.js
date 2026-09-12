import { signToken, verifyToken } from '../lib/licence.js'

const LICENCE_KEY_PATTERN = '^[A-Za-z0-9-]{8,64}$'
// The client hashes its own machine identifiers before sending them, so the
// server only ever stores an opaque digest. Enforce that shape rather than
// accepting whatever the client feels like sending.
const FINGERPRINT_PATTERN = '^[A-Za-z0-9_-]{16,128}$'

const activateSchema = {
  body: {
    type: 'object',
    required: ['licenceKey', 'fingerprint'],
    additionalProperties: false,
    properties: {
      licenceKey: { type: 'string', pattern: LICENCE_KEY_PATTERN },
      fingerprint: { type: 'string', pattern: FINGERPRINT_PATTERN },
      appVersion: { type: 'string', maxLength: 32 }
    }
  }
}

const refreshSchema = {
  body: {
    type: 'object',
    required: ['token'],
    additionalProperties: false,
    properties: {
      token: { type: 'string', minLength: 32, maxLength: 4096 }
    }
  }
}

/**
 * Builds the token a client will live on for the next TTL window.
 *
 * `features` come from the licence row and are baked into the signed payload,
 * so the client reads its entitlements from verified data rather than from a
 * local flag it could flip.
 */
function issue (fastify, licence, fingerprint) {
  const { token, payload } = signToken(fastify.licenceKeys.privateKey, {
    licenceKey: licence.key,
    fingerprint,
    tier: licence.tier,
    features: licence.features,
    ttlSeconds: fastify.config.licence.ttlSeconds,
    graceSeconds: fastify.config.licence.graceSeconds
  })

  return {
    token,
    tier: payload.tier,
    features: payload.features,
    issuedAt: new Date(payload.iat * 1000).toISOString(),
    expiresAt: new Date(payload.exp * 1000).toISOString(),
    // Told to the client explicitly so its offline behaviour is a policy the
    // server states, not a constant compiled into the binary.
    graceSeconds: payload.grace
  }
}

export default async function licenceRoutes (fastify) {
  fastify.post('/v1/licence/activate', { schema: activateSchema }, async (request, reply) => {
    const { licenceKey, fingerprint, appVersion } = request.body
    const licence = await fastify.storage.getLicence(licenceKey)

    if (!licence) {
      return reply.code(404).send({ error: 'licence_not_found' })
    }
    if (licence.status !== 'active') {
      return reply.code(403).send({ error: 'licence_inactive', status: licence.status })
    }

    // Record first, then enforce the seat cap, then roll back if we pushed it
    // over. Counting before inserting would let two simultaneous activations
    // both see a free seat and both take it.
    const { created } = await fastify.storage.recordActivation({ licenceKey, fingerprint, appVersion })
    const activations = await fastify.storage.listActivations(licenceKey)

    if (created && activations.length > licence.maxSeats) {
      await fastify.storage.deleteActivation({ licenceKey, fingerprint })
      return reply.code(403).send({
        error: 'seat_limit_reached',
        seats: { used: licence.maxSeats, max: licence.maxSeats }
      })
    }

    return {
      ...issue(fastify, licence, fingerprint),
      seats: { used: activations.length, max: licence.maxSeats }
    }
  })

  /**
   * Refreshes a token. Deliberately accepts an *expired* token: expiry is how
   * the client knows to ask again, not a reason to refuse. The licence row is
   * the authority, which is what makes revocation work — a refunded key stops
   * refreshing and its last token ages out within one TTL.
   */
  fastify.post('/v1/licence/refresh', { schema: refreshSchema }, async (request, reply) => {
    const result = verifyToken(fastify.licenceKeys.publicKey, request.body.token)
    if (!result.ok) {
      return reply.code(401).send({ error: result.reason })
    }

    const { key: licenceKey, fp: fingerprint } = result.payload
    const licence = await fastify.storage.getLicence(licenceKey)

    if (!licence) {
      return reply.code(404).send({ error: 'licence_not_found' })
    }
    if (licence.status !== 'active') {
      return reply.code(403).send({ error: 'licence_inactive', status: licence.status })
    }

    // A refresh is also a heartbeat: it is how last_seen stays current.
    await fastify.storage.recordActivation({ licenceKey, fingerprint })
    const activations = await fastify.storage.listActivations(licenceKey)

    return {
      ...issue(fastify, licence, fingerprint),
      seats: { used: activations.length, max: licence.maxSeats }
    }
  })
}
