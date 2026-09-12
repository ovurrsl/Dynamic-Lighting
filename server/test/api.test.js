import assert from 'node:assert/strict'
import test from 'node:test'

import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { generateKeyPair, signToken, loadPrivateKey } from '../src/lib/licence.js'
import { createMemoryStorage } from '../src/storage/memory.js'

const SIGNING = generateKeyPair()

const BASE_ENV = {
  NODE_ENV: 'test',
  LICENCE_SIGNING_KEY: SIGNING.privateKey,
  STORAGE: 'memory',
  LOG_LEVEL: 'silent',
  // Keep the rate limiter out of the way of the functional assertions; it has
  // its own test below.
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
  await storage.init()
  const app = await buildApp({ config, storage })
  return { app, storage, config }
}

async function activate (app, licenceKey, fingerprint, appVersion = '0.1.0') {
  return app.inject({
    method: 'POST',
    url: '/v1/licence/activate',
    payload: { licenceKey, fingerprint, appVersion }
  })
}

test('healthz answers without touching storage', async (t) => {
  const { app } = await harness()
  t.after(() => app.close())

  // A storage that throws proves the liveness probe really is independent of it;
  // this is what makes it safe as a wake-up ping on a host that sleeps the app.
  app.storage.ping = async () => { throw new Error('database is down') }

  const live = await app.inject({ method: 'GET', url: '/healthz' })
  assert.equal(live.statusCode, 200)
  assert.deepEqual(live.json(), { status: 'ok' })

  const ready = await app.inject({ method: 'GET', url: '/readyz' })
  assert.equal(ready.statusCode, 503)
  assert.equal(ready.json().status, 'degraded')
})

test('version publishes the licence public key so clients can verify offline', async (t) => {
  const { app } = await harness()
  t.after(() => app.close())

  const response = await app.inject({ method: 'GET', url: '/v1/version' })
  assert.equal(response.statusCode, 200)
  const body = response.json()
  assert.equal(body.licencePublicKey, SIGNING.publicKey)
  assert.equal(body.licence.ttlSeconds, 30 * 86400)
  assert.equal(body.licence.graceSeconds, 14 * 86400)
})

test('activation issues a verifiable token carrying the licence features', async (t) => {
  const { app } = await harness()
  t.after(() => app.close())

  const response = await activate(app, 'AF-OK-0001', 'fingerprint-aaaaaaaaaaaa')
  assert.equal(response.statusCode, 200)

  const body = response.json()
  assert.deepEqual(body.features, ['ambilight', 'hdr'])
  assert.equal(body.tier, 'pro')
  assert.deepEqual(body.seats, { used: 1, max: 2 })
  assert.match(body.token, /^af1\.[\w-]+\.[\w-]+$/)
  assert.equal(typeof body.expiresAt, 'string')
})

test('unknown and revoked licences are distinguishable', async (t) => {
  const { app } = await harness()
  t.after(() => app.close())

  const missing = await activate(app, 'AF-NOPE-0001', 'fingerprint-bbbbbbbbbbbb')
  assert.equal(missing.statusCode, 404)
  assert.equal(missing.json().error, 'licence_not_found')

  const revoked = await activate(app, 'AF-REVOKED-1', 'fingerprint-bbbbbbbbbbbb')
  assert.equal(revoked.statusCode, 403)
  assert.equal(revoked.json().error, 'licence_inactive')
  assert.equal(revoked.json().status, 'revoked')
})

test('re-activating the same machine does not consume a second seat', async (t) => {
  const { app } = await harness()
  t.after(() => app.close())

  const first = await activate(app, 'AF-OK-0001', 'fingerprint-cccccccccccc')
  const second = await activate(app, 'AF-OK-0001', 'fingerprint-cccccccccccc')

  assert.equal(first.json().seats.used, 1)
  assert.equal(second.statusCode, 200)
  assert.equal(second.json().seats.used, 1, 'the same fingerprint is one seat')
})

test('the seat limit is enforced and the rejected activation is rolled back', async (t) => {
  const { app, storage } = await harness()
  t.after(() => app.close())

  await activate(app, 'AF-OK-0001', 'fingerprint-dddddddddddd')
  await activate(app, 'AF-OK-0001', 'fingerprint-eeeeeeeeeeee')

  const third = await activate(app, 'AF-OK-0001', 'fingerprint-ffffffffffff')
  assert.equal(third.statusCode, 403)
  assert.equal(third.json().error, 'seat_limit_reached')

  // The rejected machine must not be left occupying a seat, or the limit would
  // ratchet down every time someone tried to over-activate.
  const activations = await storage.listActivations('AF-OK-0001')
  assert.equal(activations.length, 2)
  assert.ok(!activations.some((row) => row.fingerprint === 'fingerprint-ffffffffffff'))
})

test('refresh accepts an expired token, because expiry is a prompt not a punishment', async (t) => {
  const { app, config } = await harness()
  t.after(() => app.close())

  const privateKey = loadPrivateKey(SIGNING.privateKey)
  const longExpired = signToken(
    privateKey,
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

  const response = await app.inject({
    method: 'POST',
    url: '/v1/licence/refresh',
    payload: { token: longExpired.token }
  })

  assert.equal(response.statusCode, 200, 'an authentic token for a live licence must refresh')
  const body = response.json()
  assert.notEqual(body.token, longExpired.token)
  assert.ok(new Date(body.expiresAt).getTime() > Date.now())
})

test('refresh is where revocation bites', async (t) => {
  const { app, storage } = await harness()
  t.after(() => app.close())

  const activated = await activate(app, 'AF-OK-0001', 'fingerprint-hhhhhhhhhhhh')
  const token = activated.json().token

  storage.upsertLicence({ key: 'AF-OK-0001', status: 'revoked', maxSeats: 2, features: [] })

  const response = await app.inject({
    method: 'POST',
    url: '/v1/licence/refresh',
    payload: { token }
  })
  assert.equal(response.statusCode, 403)
  assert.equal(response.json().error, 'licence_inactive')
})

test('refresh rejects a token signed by someone else', async (t) => {
  const { app, config } = await harness()
  t.after(() => app.close())

  const attacker = loadPrivateKey(generateKeyPair().privateKey)
  const forged = signToken(attacker, {
    licenceKey: 'AF-OK-0001',
    fingerprint: 'fingerprint-iiiiiiiiiiii',
    tier: 'pro',
    features: ['hdr'],
    ttlSeconds: config.licence.ttlSeconds,
    graceSeconds: config.licence.graceSeconds
  })

  const response = await app.inject({
    method: 'POST',
    url: '/v1/licence/refresh',
    payload: { token: forged.token }
  })
  assert.equal(response.statusCode, 401)
  assert.equal(response.json().error, 'signature_invalid')
})

test('presets require a bearer token and round-trip', async (t) => {
  const { app } = await harness()
  t.after(() => app.close())

  const anonymous = await app.inject({ method: 'GET', url: '/v1/presets' })
  assert.equal(anonymous.statusCode, 401)
  assert.equal(anonymous.json().error, 'authorization_required')

  const token = (await activate(app, 'AF-OK-0001', 'fingerprint-jjjjjjjjjjjj')).json().token
  const auth = { authorization: `Bearer ${token}` }

  const empty = await app.inject({ method: 'GET', url: '/v1/presets', headers: auth })
  assert.deepEqual(empty.json(), { presets: [] })

  const payload = { schemaVersion: 1, leds: 108, smoothing: { attackMs: 15, releaseMs: 90 } }
  const saved = await app.inject({
    method: 'PUT',
    url: '/v1/presets/desk-27',
    headers: auth,
    payload: { name: 'Desk 27 inch', payload }
  })
  assert.equal(saved.statusCode, 200)
  assert.equal(saved.json().id, 'desk-27')

  const listed = await app.inject({ method: 'GET', url: '/v1/presets', headers: auth })
  assert.equal(listed.json().presets.length, 1)
  assert.deepEqual(listed.json().presets[0].payload, payload)

  const deleted = await app.inject({ method: 'DELETE', url: '/v1/presets/desk-27', headers: auth })
  assert.equal(deleted.statusCode, 204)

  const gone = await app.inject({ method: 'DELETE', url: '/v1/presets/desk-27', headers: auth })
  assert.equal(gone.statusCode, 404)
})

test('one licence cannot read or delete another licence presets', async (t) => {
  const { app } = await harness()
  t.after(() => app.close())

  const mine = (await activate(app, 'AF-OK-0001', 'fingerprint-kkkkkkkkkkkk')).json().token
  const theirs = (await activate(app, 'AF-OTHER-001', 'fingerprint-llllllllllll')).json().token

  await app.inject({
    method: 'PUT',
    url: '/v1/presets/secret',
    headers: { authorization: `Bearer ${mine}` },
    payload: { name: 'Mine', payload: { schemaVersion: 1 } }
  })

  const leaked = await app.inject({
    method: 'GET',
    url: '/v1/presets',
    headers: { authorization: `Bearer ${theirs}` }
  })
  assert.deepEqual(leaked.json(), { presets: [] }, 'presets must be scoped to the licence')

  const crossDelete = await app.inject({
    method: 'DELETE',
    url: '/v1/presets/secret',
    headers: { authorization: `Bearer ${theirs}` }
  })
  assert.equal(crossDelete.statusCode, 404)

  const stillThere = await app.inject({
    method: 'GET',
    url: '/v1/presets',
    headers: { authorization: `Bearer ${mine}` }
  })
  assert.equal(stillThere.json().presets.length, 1)
})

test('input validation rejects malformed activation bodies', async (t) => {
  const { app } = await harness()
  t.after(() => app.close())

  const cases = [
    { licenceKey: 'short', fingerprint: 'fingerprint-mmmmmmmmmmmm' },
    { licenceKey: 'AF-OK-0001', fingerprint: 'tooshort' },
    { licenceKey: 'AF-OK-0001' },
    { licenceKey: 'AF-OK-0001', fingerprint: 'fingerprint-nnnnnnnnnnnn', extra: 'nope' }
  ]

  for (const payload of cases) {
    const response = await app.inject({ method: 'POST', url: '/v1/licence/activate', payload })
    assert.equal(response.statusCode, 400, `expected rejection for ${JSON.stringify(payload)}`)
    assert.equal(response.json().error, 'validation_failed')
  }
})

test('the update manifest is served per channel', async (t) => {
  const { app } = await harness()
  t.after(() => app.close())

  const stable = await app.inject({ method: 'GET', url: '/v1/updates/manifest' })
  assert.equal(stable.statusCode, 200)
  assert.equal(stable.json().channel, 'stable')
  assert.ok(stable.json().firmware, 'the manifest must describe a firmware build')

  const missing = await app.inject({ method: 'GET', url: '/v1/updates/manifest?channel=beta' })
  assert.equal(missing.statusCode, 404)
  assert.equal(missing.json().error, 'channel_not_found')
})

test('the rate limiter protects activation but never the liveness probe', async (t) => {
  const { app } = await harness({ RATE_LIMIT_MAX: '3' })
  t.after(() => app.close())

  const statuses = []
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await activate(app, 'AF-NOPE-0001', 'fingerprint-oooooooooooo')
    statuses.push(response.statusCode)
  }
  assert.ok(statuses.includes(429), `expected a 429 among ${statuses.join(',')}`)

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await app.inject({ method: 'GET', url: '/healthz' })
    assert.equal(response.statusCode, 200, 'the wake-up ping must never be throttled')
  }
})
