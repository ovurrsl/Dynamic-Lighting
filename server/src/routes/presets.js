import { verifyToken } from '../lib/licence.js'

const PRESET_ID_PATTERN = '^[A-Za-z0-9_-]{1,64}$'

/**
 * A preset is a monitor profile plus the look: LED layout, sampling bands,
 * smoothing constants, power budget. The server stores it opaquely on purpose —
 * the engine and the firmware own its meaning, and versioning it here would
 * mean redeploying the server every time a tuning knob is added.
 */
const presetPayloadSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    schemaVersion: { type: 'integer', minimum: 1 }
  }
}

const putSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', pattern: PRESET_ID_PATTERN } }
  },
  body: {
    type: 'object',
    required: ['name', 'payload'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 128 },
      payload: presetPayloadSchema
    }
  }
}

const idOnlySchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', pattern: PRESET_ID_PATTERN } }
  }
}

export default async function presetRoutes (fastify) {
  /**
   * The licence token IS the credential — there is no separate session system.
   * It is already signed, already scoped to one licence, and the client already
   * holds it, so adding passwords on top would buy nothing.
   *
   * An expired token is accepted here. The alternative is a customer whose
   * presets vanish because our host was asleep when their refresh was due,
   * which is the same fail-closed trap the engine avoids.
   */
  fastify.addHook('preHandler', async (request, reply) => {
    const header = request.headers.authorization ?? ''
    const [scheme, token] = header.split(' ')

    if (scheme !== 'Bearer' || !token) {
      return reply.code(401).send({ error: 'authorization_required' })
    }

    const result = verifyToken(fastify.licenceKeys.publicKey, token)
    if (!result.ok) {
      return reply.code(401).send({ error: result.reason })
    }

    request.licence = {
      key: result.payload.key,
      tier: result.payload.tier,
      features: result.payload.features ?? [],
      expired: result.expired
    }
  })

  fastify.get('/v1/presets', async (request) => {
    const presets = await fastify.storage.listPresets(request.licence.key)
    return {
      presets: presets.map(({ id, name, payload, updatedAt }) => ({
        id,
        name,
        payload,
        updatedAt: updatedAt instanceof Date ? updatedAt.toISOString() : updatedAt
      }))
    }
  })

  fastify.put('/v1/presets/:id', { schema: putSchema }, async (request) => {
    const { id } = request.params
    const { name, payload } = request.body
    const row = await fastify.storage.putPreset({
      licenceKey: request.licence.key,
      id,
      name,
      payload
    })
    return {
      id: row.id,
      name: row.name,
      updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt
    }
  })

  fastify.delete('/v1/presets/:id', { schema: idOnlySchema }, async (request, reply) => {
    const deleted = await fastify.storage.deletePreset({
      licenceKey: request.licence.key,
      id: request.params.id
    })
    if (!deleted) return reply.code(404).send({ error: 'preset_not_found' })
    return reply.code(204).send()
  })
}
