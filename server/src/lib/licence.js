import crypto from 'node:crypto'

/**
 * Offline licence tokens, signed with Ed25519.
 *
 * The token is verified entirely on the client with an embedded public key, so
 * a client never has to reach the server to know whether it is licensed. That
 * is what lets the engine fail *open*: it keeps running while a refresh is
 * merely late, and the server is only needed to mint the next token.
 *
 * Token layout:  af1.<payload>.<signature>
 *   payload   = base64url(JSON)
 *   signature = base64url(Ed25519 over the ASCII bytes of "af1.<payload>")
 *
 * The signature covers the encoded payload string rather than a re-serialised
 * object, so verification never depends on JSON key order or spacing.
 *
 * `features` is inside the signed payload on purpose: the client reads its
 * entitlements from the verified token instead of from a local boolean, so
 * patching out a licence check leaves premium features *off* rather than on.
 */

const PREFIX = 'af1'
const CURVE = 'ed25519'

function b64urlEncode (buf) {
  return Buffer.from(buf).toString('base64url')
}

function b64urlDecode (str) {
  return Buffer.from(str, 'base64url')
}

/** Generates a fresh signing keypair, exported as base64 DER for env storage. */
export function generateKeyPair () {
  const { privateKey, publicKey } = crypto.generateKeyPairSync(CURVE)
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  }
}

export function loadPrivateKey (base64Der) {
  return crypto.createPrivateKey({
    key: Buffer.from(base64Der, 'base64'),
    format: 'der',
    type: 'pkcs8'
  })
}

export function loadPublicKey (base64Der) {
  return crypto.createPublicKey({
    key: Buffer.from(base64Der, 'base64'),
    format: 'der',
    type: 'spki'
  })
}

/** Derives the public key from a private key, so only one secret needs storing. */
export function publicKeyFromPrivate (privateKey) {
  return crypto.createPublicKey(privateKey)
}

/**
 * Signs a licence payload.
 *
 * @param {crypto.KeyObject} privateKey
 * @param {object} claims
 * @param {string} claims.licenceKey   the customer's licence key
 * @param {string} claims.fingerprint  opaque machine id (already hashed by the client)
 * @param {string} claims.tier
 * @param {string[]} claims.features   entitlements the client reads from the token
 * @param {number} claims.ttlSeconds   token lifetime
 * @param {number} claims.graceSeconds how long the client should keep working past expiry
 * @param {number} [nowSeconds]        injectable clock, for tests
 */
export function signToken (privateKey, claims, nowSeconds = Math.floor(Date.now() / 1000)) {
  const {
    licenceKey,
    fingerprint,
    tier,
    features = [],
    ttlSeconds,
    graceSeconds
  } = claims

  if (!licenceKey) throw new Error('signToken: licenceKey is required')
  if (!fingerprint) throw new Error('signToken: fingerprint is required')
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('signToken: ttlSeconds must be a positive integer')
  }
  if (!Number.isInteger(graceSeconds) || graceSeconds < 0) {
    throw new Error('signToken: graceSeconds must be a non-negative integer')
  }

  const payload = {
    v: 1,
    key: licenceKey,
    fp: fingerprint,
    tier,
    features: [...features].sort(),
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
    grace: graceSeconds
  }

  const encodedPayload = b64urlEncode(JSON.stringify(payload))
  const signingInput = `${PREFIX}.${encodedPayload}`
  const signature = crypto.sign(null, Buffer.from(signingInput, 'ascii'), privateKey)

  return {
    token: `${signingInput}.${b64urlEncode(signature)}`,
    payload
  }
}

/**
 * Verifies a token. Never throws on malformed input — callers get a reason.
 *
 * Note that an expired-but-authentic token returns ok:true with
 * `expired: true`. Deciding what to do about that is deliberately the
 * caller's job: the engine keeps running through the grace window, whereas
 * the server refuses to extend a revoked licence.
 *
 * @returns {{ok: true, payload: object, expired: boolean, withinGrace: boolean}
 *          | {ok: false, reason: string}}
 */
export function verifyToken (publicKey, token, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, reason: 'token_missing' }
  }

  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'token_malformed' }

  const [prefix, encodedPayload, encodedSignature] = parts
  if (prefix !== PREFIX) return { ok: false, reason: 'token_version_unsupported' }

  let signature
  try {
    signature = b64urlDecode(encodedSignature)
  } catch {
    return { ok: false, reason: 'token_malformed' }
  }

  const signingInput = Buffer.from(`${prefix}.${encodedPayload}`, 'ascii')
  let signatureValid = false
  try {
    signatureValid = crypto.verify(null, signingInput, publicKey, signature)
  } catch {
    return { ok: false, reason: 'signature_invalid' }
  }
  if (!signatureValid) return { ok: false, reason: 'signature_invalid' }

  let payload
  try {
    payload = JSON.parse(b64urlDecode(encodedPayload).toString('utf8'))
  } catch {
    return { ok: false, reason: 'payload_malformed' }
  }

  if (payload?.v !== 1) return { ok: false, reason: 'payload_version_unsupported' }
  if (typeof payload.exp !== 'number' || typeof payload.iat !== 'number') {
    return { ok: false, reason: 'payload_malformed' }
  }

  const expired = nowSeconds >= payload.exp
  const grace = typeof payload.grace === 'number' ? payload.grace : 0
  const withinGrace = expired && nowSeconds < payload.exp + grace

  return { ok: true, payload, expired, withinGrace }
}
