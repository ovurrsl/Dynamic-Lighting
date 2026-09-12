import assert from 'node:assert/strict'
import test from 'node:test'

import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { generateKeyPair, signToken, loadPrivateKey } from '../src/lib/licence.js'
import { createLogger } from '../src/lib/log.js'
import { createMemoryStorage } from '../src/storage/memory.js'

const SIGNING = generateKeyPair()
const JSON_HEADERS = { 'content-type': 'application/json' }

const BASE_ENV = {
  NODE_ENV: 'test',
  LICENCE_SIGNING_KEY: SIGNING.privateKey,
  STORAGE: 'memory',
  LOG_LEVEL: 'silent',
  // Keep the limiter out of the way of functional assertions; it has its own
  // test below.
  RATE_LIMIT_MAX: '1000',
  WEB_DIR: 'web/does-not-exist'
}

async function harness (overrides = {}) {
  const config = loadConfig({ ...BASE_ENV, ...overrides })
  const storage = createMemoryStorage({
    licences: [
      { key: 'AF-OK-0001', tier: 'pro', maxSeats: 2, features: ['hdr', 'ambilight'] },
      { key: 'AF-REVOKED-1', tier: 'pro', maxSeats: 2, status: 'revoked', features: [] },
      { key: 'AF-OTHER-001', tier: 'free', maxSeats: 1, features: [] }
    ]
  })
  const app = await buildApp({
    config,
    storage,
    log: createLogger({ level: 'silent', write: () => {} })
  })
  return { app, storage, config }
}

const post = (app, url, payload, headers = {}) =>
  app.request(url, {
    method: 'POST',
    headers: { ...JSON_HEADERS, ...headers },
    body: JSON.stringify(payload)
  })

const activate = (app, licenceKey, fingerprint, appVersion = '0.1.0') =>
  post(app, '/v1/licence/activate', { licenceKey, fingerprint, appVersion })

test('healthz answers without touching storage', async () => {
  const { app, storage } = await harness()

  // A storage that throws proves the liveness probe really is independent of it,
  // which is what makes it safe as a wake-up ping on a host that sleeps the app.
  storage.ping = async () => { throw new Error('database is down') }

  const live = await app.request('/healthz')
  assert.equal(live.status, 200)
  assert.deepEqual(await live.json(), { status: 'ok' })

  const ready = await app.request('/readyz')
  assert.equal(ready.status, 503)
  assert.equal((await ready.json()).status, 'degraded')
})

test('version publishes the licence public key so clients can verify offline', async () => {
  const { app } = await harness()

  const response = await app.request('/v1/version')
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.licencePublicKey, SIGNING.publicKey)
  assert.equal(body.licence.ttlSeconds, 30 * 86400)
  assert.equal(body.licence.graceSeconds, 14 * 86400)
})

test('activation issues a verifiable token carrying the licence features', async () => {
  const { app } = await harness()

  const response = await activate(app, 'AF-OK-0001', 'fingerprint-aaaaaaaaaaaa')
  assert.equal(response.status, 200)

  const body = await response.json()
  assert.deepEqual(body.features, ['ambilight', 'hdr'])
  assert.equal(body.tier, 'pro')
  assert.deepEqual(body.seats, { used: 1, max: 2 })
  assert.match(body.token, /^af1\.[\w-]+\.[\w-]+$/)
})

test('unknown and revoked licences are distinguishable', async () => {
  const { app } = await harness()

  const missing = await activate(app, 'AF-NOPE-0001', 'fingerprint-bbbbbbbbbbbb')
  assert.equal(missing.status, 404)
  assert.equal((await missing.json()).error, 'licence_not_found')

  const revoked = await activate(app, 'AF-REVOKED-1', 'fingerprint-bbbbbbbbbbbb')
  assert.equal(revoked.status, 403)
  const body = await revoked.json()
  assert.equal(body.error, 'licence_inactive')
  assert.equal(body.status, 'revoked')
})

test('re-activating the same machine does not consume a second seat', async () => {
  const { app } = await harness()

  const first = await activate(app, 'AF-OK-0001', 'fingerprint-cccccccccccc')
  const second = await activate(app, 'AF-OK-0001', 'fingerprint-cccccccccccc')

  assert.equal((await first.json()).seats.used, 1)
  assert.equal(second.status, 200)
  assert.equal((await second.json()).seats.used, 1, 'the same fingerprint is one seat')
})

test('the seat limit is enforced and the rejected activation is rolled back', async () => {
  const { app, storage } = await harness()

  await activate(app, 'AF-OK-0001', 'fingerprint-dddddddddddd')
  await activate(app, 'AF-OK-0001', 'fingerprint-eeeeeeeeeeee')

  const third = await activate(app, 'AF-OK-0001', 'fingerprint-ffffffffffff')
  assert.equal(third.status, 403)
  assert.equal((await third.json()).error, 'seat_limit_reached')

  // The rejected machine must not be left occupying a seat, or the limit would
  // ratchet down every time someone tried to over-activate.
  const activations = await storage.listActivations('AF-OK-0001')
  assert.equal(activations.length, 2)
  assert.ok(!activations.some((row) => row.fingerprint === 'fingerprint-ffffffffffff'))
})

test('refresh accepts an expired token, because expiry is a prompt not a punishment', async () => {
  const { app, config } = await harness()

  const longExpired = signToken(
    loadPrivateKey(SIGNING.privateKey),
    {
      licenceKey: 'AF-OK-0001',
      fingerprint: 'fingerprint-gggggggggggg',
      tier: 'pro',
      features: ['hdr'],
      ttlSeconds: config.licence.ttlSeconds,
      graceSeconds: config.licence.graceSeconds
    },
    // Issued two years ago: well past expiry and past the grace window too.
    Math.floor(Date.now() / 1000) - 730 * 86400
  )

  const response = await post(app, '/v1/licence/refresh', { token: longExpired.token })
  assert.equal(response.status, 200, 'an authentic token for a live licence must refresh')
  const body = await response.json()
  assert.notEqual(body.token, longExpired.token)
  assert.ok(new Date(body.expiresAt).getTime() > Date.now())
})

test('refresh is where revocation bites', async () => {
  const { app, storage } = await harness()

  const activated = await activate(app, 'AF-OK-0001', 'fingerprint-hhhhhhhhhhhh')
  const { token } = await activated.json()

  storage.upsertLicence({ key: 'AF-OK-0001', status: 'revoked', maxSeats: 2, features: [] })

  const response = await post(app, '/v1/licence/refresh', { token })
  assert.equal(response.status, 403)
  assert.equal((await response.json()).error, 'licence_inactive')
})

test('refresh rejects a token signed by someone else', async () => {
  const { app, config } = await harness()

  const forged = signToken(loadPrivateKey(generateKeyPair().privateKey), {
    licenceKey: 'AF-OK-0001',
    fingerprint: 'fingerprint-iiiiiiiiiiii',
    tier: 'pro',
    features: ['hdr'],
    ttlSeconds: config.licence.ttlSeconds,
    graceSeconds: config.licence.graceSeconds
  })

  const response = await post(app, '/v1/licence/refresh', { token: forged.token })
  assert.equal(response.status, 401)
  assert.equal((await response.json()).error, 'signature_invalid')
})

test('presets require a bearer token and round-trip', async () => {
  const { app } = await harness()

  const anonymous = await app.request('/v1/presets')
  assert.equal(anonymous.status, 401)
  assert.equal((await anonymous.json()).error, 'authorization_required')

  const activated = await activate(app, 'AF-OK-0001', 'fingerprint-jjjjjjjjjjjj')
  const { token } = await activated.json()
  const auth = { authorization: `Bearer ${token}` }

  const empty = await app.request('/v1/presets', { headers: auth })
  assert.deepEqual(await empty.json(), { presets: [] })

  const payload = { schemaVersion: 1, leds: 108, smoothing: { attackMs: 15, releaseMs: 90 } }
  const saved = await app.request('/v1/presets/desk-27', {
    method: 'PUT',
    headers: { ...JSON_HEADERS, ...auth },
    body: JSON.stringify({ name: 'Desk 27 inch', payload })
  })
  assert.equal(saved.status, 200)
  assert.equal((await saved.json()).id, 'desk-27')

  const listed = await app.request('/v1/presets', { headers: auth })
  const body = await listed.json()
  assert.equal(body.presets.length, 1)
  assert.deepEqual(body.presets[0].payload, payload)

  const deleted = await app.request('/v1/presets/desk-27', { method: 'DELETE', headers: auth })
  assert.equal(deleted.status, 204)

  const gone = await app.request('/v1/presets/desk-27', { method: 'DELETE', headers: auth })
  assert.equal(gone.status, 404)
})

test('one licence cannot read or delete another licence presets', async () => {
  const { app } = await harness()

  const mine = (await (await activate(app, 'AF-OK-0001', 'fingerprint-kkkkkkkkkkkk')).json()).token
  const theirs = (await (await activate(app, 'AF-OTHER-001', 'fingerprint-llllllllllll')).json()).token

  await app.request('/v1/presets/secret', {
    method: 'PUT',
    headers: { ...JSON_HEADERS, authorization: `Bearer ${mine}` },
    body: JSON.stringify({ name: 'Mine', payload: { schemaVersion: 1 } })
  })

  const leaked = await app.request('/v1/presets', { headers: { authorization: `Bearer ${theirs}` } })
  assert.deepEqual(await leaked.json(), { presets: [] }, 'presets must be scoped to the licence')

  const crossDelete = await app.request('/v1/presets/secret', {
    method: 'DELETE',
    headers: { authorization: `Bearer ${theirs}` }
  })
  assert.equal(crossDelete.status, 404)

  const stillThere = await app.request('/v1/presets', { headers: { authorization: `Bearer ${mine}` } })
  assert.equal((await stillThere.json()).presets.length, 1)
})

test('input validation rejects malformed activation bodies', async () => {
  const { app } = await harness()

  const cases = [
    { licenceKey: 'short', fingerprint: 'fingerprint-mmmmmmmmmmmm' },
    { licenceKey: 'AF-OK-0001', fingerprint: 'tooshort' },
    { licenceKey: 'AF-OK-0001' },
    { licenceKey: 'AF-OK-0001', fingerprint: 'fingerprint-nnnnnnnnnnnn', extra: 'nope' },
    { licenceKey: 'AF OK 0001', fingerprint: 'fingerprint-nnnnnnnnnnnn' },
    { licenceKey: 42, fingerprint: 'fingerprint-nnnnnnnnnnnn' }
  ]

  for (const payload of cases) {
    const response = await post(app, '/v1/licence/activate', payload)
    assert.equal(response.status, 400, `expected rejection for ${JSON.stringify(payload)}`)
    const body = await response.json()
    assert.equal(body.error, 'validation_failed')
    assert.ok(Array.isArray(body.problems) && body.problems.length > 0, 'the client should be told what was wrong')
  }
})

test('a non-JSON body is rejected rather than crashing the handler', async () => {
  const { app } = await harness()

  const response = await app.request('/v1/licence/activate', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: 'this is not json'
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error, 'validation_failed')
})

test('preset ids are validated so they cannot escape their licence scope', async () => {
  const { app } = await harness()
  const activated = await activate(app, 'AF-OK-0001', 'fingerprint-pppppppppppp')
  const auth = { authorization: `Bearer ${(await activated.json()).token}` }

  const response = await app.request('/v1/presets/has%20a%20space', {
    method: 'PUT',
    headers: { ...JSON_HEADERS, ...auth },
    body: JSON.stringify({ name: 'x', payload: {} })
  })
  assert.equal(response.status, 400)
})

test('the update manifest is served per channel', async () => {
  const { app } = await harness()

  const stable = await app.request('/v1/updates/manifest')
  assert.equal(stable.status, 200)
  const body = await stable.json()
  assert.equal(body.channel, 'stable')
  assert.ok(body.firmware, 'the manifest must describe a firmware build')

  const missing = await app.request('/v1/updates/manifest?channel=beta')
  assert.equal(missing.status, 404)
  assert.equal((await missing.json()).error, 'channel_not_found')

  const invalid = await app.request('/v1/updates/manifest?channel=nonsense')
  assert.equal(invalid.status, 400)
})

test('the rate limiter protects the API but never the liveness probe', async () => {
  const { app } = await harness({ RATE_LIMIT_MAX: '3' })

  const statuses = []
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await activate(app, 'AF-NOPE-0001', 'fingerprint-oooooooooooo')
    statuses.push(response.status)
  }
  assert.ok(statuses.includes(429), `expected a 429 among ${statuses.join(',')}`)

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await app.request('/healthz')
    assert.equal(response.status, 200, 'the wake-up ping must never be throttled')
  }
})

test('an unknown API path returns JSON, not the SPA fallback', async () => {
  const { app } = await harness()

  const response = await app.request('/v1/nope')
  assert.equal(response.status, 404)
  assert.equal((await response.json()).error, 'not_found')
})
