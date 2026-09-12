import { verifyToken } from '../lib/licence.js'
import { readJsonBody } from '../lib/validate.js'

const PRESET_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/**
 * A preset is a monitor profile plus the look: LED layout, sampling bands,
 * smoothing constants, power budget. The server stores the payload opaquely on
 * purpose — the engine and the firmware own its meaning, and validating it here
 * would mean redeploying the server every time a tuning knob is added.
 */
const PUT_SPEC = {
  name: { type: 'string', required: true, min: 1, max: 128 },
  payload: { type: 'object', required: true }
}

const asIso = (value) => (value instanceof Date ? value.toISOString() : value)

export default function presetRoutes (app, services) {
  /**
   * The licence token IS the credential — there is no separate session system.
   * It is already signed, already scoped to one licence, and the client already
   * holds it, so adding passwords on top would buy nothing.
   *
   * An expired token is accepted. The alternative is a customer whose presets
   * vanish because our host was asleep when their refresh was due, which is the
   * same fail-closed trap the engine avoids.
   */
  app.use('/v1/presets/*', authenticate)
  app.use('/v1/presets', authenticate)

  function authenticate (context, next) {
    const header = context.req.header('authorization') ?? ''
    const [scheme, token] = header.split(' ')

    if (scheme !== 'Bearer' || !token) {
      return context.json({ error: 'authorization_required' }, 401)
    }

    const result = verifyToken(services.licenceKeys.publicKey, token)
    if (!result.ok) return context.json({ error: result.reason }, 401)

    context.set('licence', {
      key: result.payload.key,
      tier: result.payload.tier,
      features: result.payload.features ?? [],
      expired: result.expired
    })
    return next()
  }

  app.get('/v1/presets', async (context) => {
    const presets = await services.storage.listPresets(context.get('licence').key)
    return context.json({
      presets: presets.map(({ id, name, payload, updatedAt }) => ({
        id,
        name,
        payload,
        updatedAt: asIso(updatedAt)
      }))
    })
  })

  app.put('/v1/presets/:id', async (context) => {
    const id = context.req.param('id')
    if (!PRESET_ID_PATTERN.test(id)) {
      return context.json({ error: 'validation_failed', problems: ['id has an unexpected format'] }, 400)
    }

    const body = await readJsonBody(context, PUT_SPEC)
    if (!body.ok) {
      return context.json({ error: 'validation_failed', problems: body.problems }, 400)
    }

    const row = await services.storage.putPreset({
      licenceKey: context.get('licence').key,
      id,
      name: body.value.name,
      payload: body.value.payload
    })

    return context.json({ id: row.id, name: row.name, updatedAt: asIso(row.updatedAt) })
  })

  app.delete('/v1/presets/:id', async (context) => {
    const id = context.req.param('id')
    if (!PRESET_ID_PATTERN.test(id)) {
      return context.json({ error: 'validation_failed', problems: ['id has an unexpected format'] }, 400)
    }

    const deleted = await services.storage.deletePreset({
      licenceKey: context.get('licence').key,
      id
    })
    if (!deleted) return context.json({ error: 'preset_not_found' }, 404)
    return context.body(null, 204)
  })
}
