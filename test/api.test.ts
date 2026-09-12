import assert from 'node:assert/strict'
import test from 'node:test'

import { healthz, readyz, version } from '#lib/api/health'
import { activate as activateHandler, refresh as refreshHandler } from '#lib/api/licence'
import { notFound } from '#lib/api/notfound'
import { deletePreset, listPresets, putPreset } from '#lib/api/presets'
import { updatesManifest } from '#lib/api/updates'
import { generateKeyPair, loadPrivateKey, signToken } from '#lib/licence'

import {
  SIGNING,
  bearer,
  bodyRequest,
  deleteRequest,
  getRequest,
  harness,
  readBody
} from '#test/harness'

async function activate (
  licenceKey: string,
  fingerprint: string,
  appVersion = '0.1.0'
): Promise<Response> {
  return activateHandler(
    bodyRequest('POST', '/v1/licence/activate', { licenceKey, fingerprint, appVersion }),
    undefined as never
  )
}

const call = <T>(handler: (r: Request, c: T) => Promise<Response>, request: Request, context?: T) =>
  handler(request, context as T)

test('healthz answers without touching storage', async () => {
  const { context } = harness()

  // A storage that throws proves the liveness probe really is independent of it;
  // this is what makes it safe as a wake-up ping on a host that sleeps the app.
  context.storage.ping = async () => { throw new Error('database is down') }

  const live = await call(healthz, getRequest('/healthz'))
  assert.equal(live.status, 200)
  assert.deepEqual(await readBody(live), { status: 'ok' })

  const ready = await call(readyz, getRequest('/readyz'))
  assert.equal(ready.status, 503)
  assert.equal((await readBody(ready)).status, 'degraded')
})

test('healthz and every licence response forbid caching', async () => {
  harness()
  // A cached token would be handed to the wrong machine, and a cached /healthz
  // would report a dead instance as alive. Both hosts put a CDN in front.
  for (const response of [await call(healthz, getRequest('/healthz')), await activate('AF-OK-0001', 'fingerprint-cache-000000')]) {
    assert.match(response.headers.get('cache-control') ?? '', /no-store/)
  }
})

test('version publishes the licence public key so clients can verify offline', async () => {
  harness()

  const response = await call(version, getRequest('/v1/version'))
  assert.equal(response.status, 200)
  const body = await readBody(response)
  assert.equal(body.licencePublicKey, SIGNING.publicKey)
  assert.equal(body.licence.ttlSeconds, 30 * 86400)
  assert.equal(body.licence.graceSeconds, 14 * 86400)
})

test('activation issues a verifiable token carrying the licence features', async () => {
  harness()

  const response = await activate('AF-OK-0001', 'fingerprint-aaaaaaaaaaaa')
  assert.equal(response.status, 200)

  const body = await readBody(response)
  assert.deepEqual(body.features, ['ambilight', 'hdr'])
  assert.equal(body.tier, 'pro')
  assert.deepEqual(body.seats, { used: 1, max: 2 })
  assert.match(body.token, /^af1\.[\w-]+\.[\w-]+$/)
  assert.equal(typeof body.expiresAt, 'string')
})

test('unknown and revoked licences are distinguishable', async () => {
  harness()

  const missing = await activate('AF-NOPE-0001', 'fingerprint-bbbbbbbbbbbb')
  assert.equal(missing.status, 404)
  assert.equal((await readBody(missing)).error, 'licence_not_found')

  const revoked = await activate('AF-REVOKED-1', 'fingerprint-bbbbbbbbbbbb')
  assert.equal(revoked.status, 403)
  const body = await readBody(revoked)
  assert.equal(body.error, 'licence_inactive')
  assert.equal(body.status, 'revoked')
})

test('re-activating the same machine does not consume a second seat', async () => {
  harness()

  const first = await activate('AF-OK-0001', 'fingerprint-cccccccccccc')
  const second = await activate('AF-OK-0001', 'fingerprint-cccccccccccc')

  assert.equal((await readBody(first)).seats.used, 1)
  assert.equal(second.status, 200)
  assert.equal((await readBody(second)).seats.used, 1, 'the same fingerprint is one seat')
})

test('the seat limit is enforced and the rejected activation is rolled back', async () => {
  const { storage } = harness()

  await activate('AF-OK-0001', 'fingerprint-dddddddddddd')
  await activate('AF-OK-0001', 'fingerprint-eeeeeeeeeeee')

  const third = await activate('AF-OK-0001', 'fingerprint-ffffffffffff')
  assert.equal(third.status, 403)
  assert.equal((await readBody(third)).error, 'seat_limit_reached')

  // The rejected machine must not be left occupying a seat, or the limit would
  // ratchet down every time someone tried to over-activate.
  const activations = await storage.listActivations('AF-OK-0001')
  assert.equal(activations.length, 2)
  assert.ok(!activations.some((row) => row.fingerprint === 'fingerprint-ffffffffffff'))
})

test('refresh accepts an expired token, because expiry is a prompt not a punishment', async () => {
  const { context } = harness()

  const privateKey = loadPrivateKey(SIGNING.privateKey)
  const longExpired = signToken(
    privateKey,
    {
      licenceKey: 'AF-OK-0001',
      fingerprint: 'fingerprint-gggggggggggg',
      tier: 'pro',
      features: ['hdr'],
      ttlSeconds: context.config.licence.ttlSeconds,
      graceSeconds: context.config.licence.graceSeconds
    },
    // Issued two years ago: well past expiry and past the grace window too.
    Math.floor(Date.now() / 1000) - 730 * 86400
  )

  const response = await call(refreshHandler, bodyRequest('POST', '/v1/licence/refresh', { token: longExpired.token }))
  assert.equal(response.status, 200, 'an authentic token for a live licence must refresh')

  const body = await readBody(response)
  assert.notEqual(body.token, longExpired.token)
  assert.ok(new Date(body.expiresAt).getTime() > Date.now())
})

test('refresh is where revocation bites', async () => {
  const { storage } = harness()

  const activated = await activate('AF-OK-0001', 'fingerprint-hhhhhhhhhhhh')
  const token = (await readBody(activated)).token

  storage.upsertLicence({ key: 'AF-OK-0001', status: 'revoked', maxSeats: 2, features: [] })

  const response = await call(refreshHandler, bodyRequest('POST', '/v1/licence/refresh', { token }))
  assert.equal(response.status, 403)
  assert.equal((await readBody(response)).error, 'licence_inactive')
})

test('refresh rejects a token signed by someone else', async () => {
  const { context } = harness()

  const attacker = loadPrivateKey(generateKeyPair().privateKey)
  const forged = signToken(attacker, {
    licenceKey: 'AF-OK-0001',
    fingerprint: 'fingerprint-iiiiiiiiiiii',
    tier: 'pro',
    features: ['hdr'],
    ttlSeconds: context.config.licence.ttlSeconds,
    graceSeconds: context.config.licence.graceSeconds
  })

  const response = await call(refreshHandler, bodyRequest('POST', '/v1/licence/refresh', { token: forged.token }))
  assert.equal(response.status, 401)
  assert.equal((await readBody(response)).error, 'signature_invalid')
})

test('presets require a bearer token and round-trip', async () => {
  harness()

  const anonymous = await call(listPresets, getRequest('/v1/presets'))
  assert.equal(anonymous.status, 401)
  assert.equal((await readBody(anonymous)).error, 'authorization_required')

  const token = (await readBody(await activate('AF-OK-0001', 'fingerprint-jjjjjjjjjjjj'))).token
  const auth = bearer(token)

  const empty = await call(listPresets, getRequest('/v1/presets', auth))
  assert.deepEqual(await readBody(empty), { presets: [] })

  const payload = { schemaVersion: 1, leds: 108, smoothing: { attackMs: 15, releaseMs: 90 } }
  const saved = await putPreset(
    bodyRequest('PUT', '/v1/presets/desk-27', { name: 'Desk 27 inch', payload }, auth),
    'desk-27'
  )
  assert.equal(saved.status, 200)
  assert.equal((await readBody(saved)).id, 'desk-27')

  const listed = await call(listPresets, getRequest('/v1/presets', auth))
  const listedBody = await readBody(listed)
  assert.equal(listedBody.presets.length, 1)
  assert.deepEqual(listedBody.presets[0].payload, payload)

  const deleted = await deletePreset(deleteRequest('/v1/presets/desk-27', auth), 'desk-27')
  assert.equal(deleted.status, 204)

  const gone = await deletePreset(deleteRequest('/v1/presets/desk-27', auth), 'desk-27')
  assert.equal(gone.status, 404)
})

test('one licence cannot read or delete another licence presets', async () => {
  harness()

  const mine = (await readBody(await activate('AF-OK-0001', 'fingerprint-kkkkkkkkkkkk'))).token
  const theirs = (await readBody(await activate('AF-OTHER-001', 'fingerprint-llllllllllll'))).token

  await putPreset(
    bodyRequest('PUT', '/v1/presets/secret', { name: 'Mine', payload: { schemaVersion: 1 } }, bearer(mine)),
    'secret'
  )

  const leaked = await call(listPresets, getRequest('/v1/presets', bearer(theirs)))
  assert.deepEqual(await readBody(leaked), { presets: [] }, 'presets must be scoped to the licence')

  const crossDelete = await deletePreset(deleteRequest('/v1/presets/secret', bearer(theirs)), 'secret')
  assert.equal(crossDelete.status, 404)

  const stillThere = await call(listPresets, getRequest('/v1/presets', bearer(mine)))
  assert.equal((await readBody(stillThere)).presets.length, 1)
})

test('input validation rejects malformed activation bodies', async () => {
  harness()

  const cases: Array<Record<string, unknown>> = [
    { licenceKey: 'short', fingerprint: 'fingerprint-mmmmmmmmmmmm' },
    { licenceKey: 'AF-OK-0001', fingerprint: 'tooshort' },
    { licenceKey: 'AF-OK-0001' },
    // The extra field matters: Fastify defaulted AJV to removeAdditional:true,
    // which silently stripped it and made additionalProperties:false a no-op.
    // Zod's .strict() has no such default to undo.
    { licenceKey: 'AF-OK-0001', fingerprint: 'fingerprint-nnnnnnnnnnnn', extra: 'nope' }
  ]

  for (const payload of cases) {
    const response = await call(activateHandler, bodyRequest('POST', '/v1/licence/activate', payload))
    assert.equal(response.status, 400, `expected rejection for ${JSON.stringify(payload)}`)
    const body = await readBody(response)
    assert.equal(body.error, 'validation_failed')
    // The client reads `problems`; the Fastify version sent `message`, so the
    // detail never actually reached the user.
    assert.ok(Array.isArray(body.problems) && body.problems.length > 0, 'problems must explain what was wrong')
  }
})

test('the update manifest is served per channel', async () => {
  harness()

  const stable = await call(updatesManifest, getRequest('/v1/updates/manifest'))
  assert.equal(stable.status, 200)
  const stableBody = await readBody(stable)
  assert.equal(stableBody.channel, 'stable')
  assert.ok(stableBody.firmware, 'the manifest must describe a firmware build')

  const missing = await call(updatesManifest, getRequest('/v1/updates/manifest?channel=beta'))
  assert.equal(missing.status, 404)
  assert.equal((await readBody(missing)).error, 'channel_not_found')
})

test('an unknown update channel is rejected by the schema', async () => {
  harness()

  const response = await call(updatesManifest, getRequest('/v1/updates/manifest?channel=nonsense'))
  assert.equal(response.status, 400)
})

test('the rate limiter protects activation but never the liveness probe', async () => {
  harness({ RATE_LIMIT_MAX: '3' })

  const statuses: number[] = []
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await activate('AF-NOPE-0001', 'fingerprint-oooooooooooo')
    statuses.push(response.status)
  }
  assert.ok(statuses.includes(429), `expected a 429 among ${statuses.join(',')}`)

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await call(healthz, getRequest('/healthz'))
    assert.equal(response.status, 200, 'the wake-up ping must never be throttled')
  }
})

test('a throttled response tells the client when to come back', async () => {
  harness({ RATE_LIMIT_MAX: '1' })

  await activate('AF-NOPE-0001', 'fingerprint-retryafter-0')
  const throttled = await activate('AF-NOPE-0001', 'fingerprint-retryafter-0')

  assert.equal(throttled.status, 429)
  // Without this a client has to guess, and guessing means retrying immediately.
  assert.ok(Number(throttled.headers.get('retry-after')) >= 1)
  assert.equal(throttled.headers.get('x-ratelimit-limit'), '1')
})

test('a non-JSON body is rejected rather than crashing the handler', async () => {
  harness()

  const response = await call(
    activateHandler,
    bodyRequest('POST', '/v1/licence/activate', 'this is not json')
  )
  assert.equal(response.status, 400)
  assert.equal((await readBody(response)).error, 'invalid_json')
})

test('preset ids are validated so they cannot escape their licence scope', async () => {
  harness()

  const token = (await readBody(await activate('AF-OK-0001', 'fingerprint-pppppppppppp'))).token

  // Next decodes route params before a handler sees them, so this is what
  // /v1/presets/has%20a%20space actually delivers.
  const response = await putPreset(
    bodyRequest('PUT', '/v1/presets/has a space', { name: 'x', payload: {} }, bearer(token)),
    'has a space'
  )
  assert.equal(response.status, 400)

  for (const id of ['../secret', 'a/b', '']) {
    const attempt = await putPreset(
      bodyRequest('PUT', '/v1/presets/x', { name: 'x', payload: {} }, bearer(token)),
      id
    )
    assert.equal(attempt.status, 400, `preset id ${JSON.stringify(id)} must be rejected`)
  }
})

test('an unknown API path returns JSON, not the SPA fallback', async () => {
  harness()

  const response = await notFound()
  assert.equal(response.status, 404)
  assert.equal((await readBody(response)).error, 'not_found')
  assert.match(response.headers.get('content-type') ?? '', /application\/json/)
})

test('an unexpected storage failure becomes a logged 500, not a stack trace', async () => {
  const { context } = harness()
  context.storage.getLicence = async () => { throw new Error('connection reset') }

  const originalError = console.error
  console.error = () => {}
  try {
    const response = await activate('AF-OK-0001', 'fingerprint-storagefail-1')
    assert.equal(response.status, 500)
    const body = await readBody(response)
    assert.deepEqual(body, { error: 'internal_error' }, 'the body must not leak the message')
  } finally {
    console.error = originalError
  }
})
