import { loadConfig, type EnvLike } from '#lib/config'
import { generateKeyPair, loadPrivateKey, loadPublicKey } from '#lib/licence'
import { resetRateLimits } from '#lib/ratelimit'
import { createMemoryStorage, type MemoryStorage } from '#lib/storage/memory'
import { setContext, type AppContext } from '#lib/server'

/**
 * Test harness.
 *
 * Replaces Fastify's `app.inject()`. The handlers in lib/api take a web `Request`
 * and return a web `Response`, so a test can call them directly - no server, no
 * port, no build, and no framework in the loop. The route files in app/ are thin
 * adapters over exactly these functions, which is what makes that honest rather
 * than a shortcut.
 */

export const SIGNING = generateKeyPair()

const BASE_ENV: EnvLike = {
  NODE_ENV: 'test',
  LICENCE_SIGNING_KEY: SIGNING.privateKey,
  STORAGE: 'memory',
  LOG_LEVEL: 'silent',
  // Keep the rate limiter out of the way of the functional assertions; it has
  // its own test.
  RATE_LIMIT_MAX: '1000'
}

export interface Harness {
  storage: MemoryStorage
  context: AppContext
}

export function harness (overrides: EnvLike = {}): Harness {
  // The limiter is module-level state keyed by route and address, and every test
  // presents the same (absent) address. Without this, a test that exhausts the
  // budget would fail the next one.
  resetRateLimits()

  const config = loadConfig({ ...BASE_ENV, ...overrides })
  const storage = createMemoryStorage({
    licences: [
      { key: 'AF-OK-0001', tier: 'pro', maxSeats: 2, features: ['hdr', 'ambilight'] },
      { key: 'AF-REVOKED-1', tier: 'pro', maxSeats: 2, status: 'revoked', features: [] },
      { key: 'AF-OTHER-001', tier: 'free', maxSeats: 1, features: [] }
    ]
  })

  const privateKey = loadPrivateKey(SIGNING.privateKey)
  const context: AppContext = {
    config,
    storage,
    licenceKeys: {
      privateKey,
      publicKey: loadPublicKey(SIGNING.publicKey),
      publicKeyBase64: SIGNING.publicKey,
      ephemeral: false
    },
    appVersion: '0.1.0-test'
  }
  setContext(context)

  return { storage, context }
}

const ORIGIN = 'http://localhost'

export function getRequest (path: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, { method: 'GET', headers })
}

export function bodyRequest (
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    // A string body passes through untouched, so a test can send text that is
    // deliberately not JSON.
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })
}

export function deleteRequest (path: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, { method: 'DELETE', headers })
}

export function bearer (token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

/** Reads a JSON response body, tolerating an empty one (204). */
export async function readBody (response: Response): Promise<any> {
  const text = await response.text()
  if (text.length === 0) return undefined
  return JSON.parse(text)
}
