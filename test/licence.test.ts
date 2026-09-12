import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

import {
  generateKeyPair,
  loadPrivateKey,
  loadPublicKey,
  publicKeyFromPrivate,
  signToken,
  verifyToken
} from '#lib/licence'

const DAY = 86400
const NOW = 1_700_000_000

function keys () {
  const pair = generateKeyPair()
  return {
    privateKey: loadPrivateKey(pair.privateKey),
    publicKey: loadPublicKey(pair.publicKey),
    base64: pair
  }
}

function claims (overrides = {}) {
  return {
    licenceKey: 'AF-TEST-0001',
    fingerprint: 'fingerprint-abcdef123456',
    tier: 'pro',
    features: ['hdr', 'ambilight'],
    ttlSeconds: 30 * DAY,
    graceSeconds: 14 * DAY,
    ...overrides
  }
}

test('a signed token verifies and round-trips its claims', () => {
  const { privateKey, publicKey } = keys()
  const { token } = signToken(privateKey, claims(), NOW)

  const result = verifyToken(publicKey, token, NOW)
  assert.equal(result.ok, true)
  assert.equal(result.payload.key, 'AF-TEST-0001')
  assert.equal(result.payload.tier, 'pro')
  assert.equal(result.expired, false)
  assert.equal(result.payload.iat, NOW)
  assert.equal(result.payload.exp, NOW + 30 * DAY)
})

test('features are sorted so the signed payload is stable regardless of input order', () => {
  const { privateKey, publicKey } = keys()
  const a = signToken(privateKey, claims({ features: ['hdr', 'ambilight'] }), NOW)
  const b = signToken(privateKey, claims({ features: ['ambilight', 'hdr'] }), NOW)

  assert.deepEqual(a.payload.features, ['ambilight', 'hdr'])
  assert.equal(a.token, b.token, 'same claims in a different order must produce the same token')
  const verified = verifyToken(publicKey, a.token, NOW)
  assert.ok(verified.ok)
  assert.deepEqual(verified.payload.features, ['ambilight', 'hdr'])
})

test('the public key derived from the private key verifies the same token', () => {
  const { privateKey, base64 } = keys()
  const { token } = signToken(privateKey, claims(), NOW)

  const derived = publicKeyFromPrivate(privateKey)
  assert.equal(verifyToken(derived, token, NOW).ok, true)
  assert.equal(
    derived.export({ type: 'spki', format: 'der' }).toString('base64'),
    base64.publicKey
  )
})

test('a token from another keypair is rejected', () => {
  const alice = keys()
  const bob = keys()
  const { token } = signToken(alice.privateKey, claims(), NOW)

  assert.deepEqual(verifyToken(bob.publicKey, token, NOW), {
    ok: false,
    reason: 'signature_invalid'
  })
})

test('tampering with the payload is detected', () => {
  const { privateKey, publicKey } = keys()
  const { token } = signToken(privateKey, claims({ tier: 'free', features: [] }), NOW)
  const [prefix, payload, signature] = token.split('.') as [string, string, string]

  // Re-encode the payload with an upgraded tier and a premium feature, keeping
  // the original signature. This is the exact attack the design is built to
  // resist: entitlements live inside signed bytes, not in a client-side flag.
  const forged = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  forged.tier = 'pro'
  forged.features = ['hdr']
  const forgedPayload = Buffer.from(JSON.stringify(forged)).toString('base64url')

  const result = verifyToken(publicKey, `${prefix}.${forgedPayload}.${signature}`, NOW)
  assert.deepEqual(result, { ok: false, reason: 'signature_invalid' })
})

test('an expired token stays authentic and reports its grace window', () => {
  const { privateKey, publicKey } = keys()
  const { token } = signToken(privateKey, claims({ ttlSeconds: DAY, graceSeconds: 2 * DAY }), NOW)

  const justExpired = verifyToken(publicKey, token, NOW + DAY + 1)
  assert.equal(justExpired.ok, true, 'expiry is not a signature failure')
  assert.equal(justExpired.expired, true)
  assert.equal(justExpired.withinGrace, true, 'the engine keeps running here')

  const pastGrace = verifyToken(publicKey, token, NOW + DAY + 2 * DAY + 1)
  assert.equal(pastGrace.ok, true)
  assert.equal(pastGrace.expired, true)
  assert.equal(pastGrace.withinGrace, false)
})

test('malformed input returns a reason instead of throwing', () => {
  const { publicKey } = keys()
  const cases = [
    ['', 'token_missing'],
    [undefined, 'token_missing'],
    ['nonsense', 'token_malformed'],
    ['a.b', 'token_malformed'],
    ['af9.abc.def', 'token_version_unsupported'],
    ['af1.!!!.!!!', 'signature_invalid']
  ]

  for (const [token, expected] of cases) {
    const result = verifyToken(publicKey, token, NOW)
    assert.equal(result.ok, false, `expected ${JSON.stringify(token)} to be rejected`)
    assert.equal(result.reason, expected, `for input ${JSON.stringify(token)}`)
  }
})

test('an authentic signature over a non-v1 payload is still rejected', () => {
  const { privateKey, publicKey } = keys()
  const { token } = signToken(privateKey, claims(), NOW)
  const [, payload] = token.split('.') as [string, string, string]

  const bumped = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  bumped.v = 2
  const encoded = Buffer.from(JSON.stringify(bumped)).toString('base64url')

  // Sign the altered payload properly, so the signature check passes and only
  // the version guard can reject it. This proves the guard is real rather than
  // being masked by a signature failure.
  const signature = crypto
    .sign(null, Buffer.from(`af1.${encoded}`, 'ascii'), privateKey)
    .toString('base64url')

  assert.deepEqual(verifyToken(publicKey, `af1.${encoded}.${signature}`, NOW), {
    ok: false,
    reason: 'payload_version_unsupported'
  })
})

test('signToken rejects incomplete claims rather than minting a weak token', () => {
  const { privateKey } = keys()

  assert.throws(() => signToken(privateKey, claims({ licenceKey: '' })), /licenceKey/)
  assert.throws(() => signToken(privateKey, claims({ fingerprint: '' })), /fingerprint/)
  assert.throws(() => signToken(privateKey, claims({ ttlSeconds: 0 })), /ttlSeconds/)
  assert.throws(() => signToken(privateKey, claims({ ttlSeconds: 1.5 })), /ttlSeconds/)
  assert.throws(() => signToken(privateKey, claims({ graceSeconds: -1 })), /graceSeconds/)
})
