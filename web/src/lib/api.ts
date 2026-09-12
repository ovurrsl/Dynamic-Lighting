/**
 * Client for the control plane.
 *
 * Two behaviours mirror deliberate server-side decisions and should not be
 * "improved" without changing the server too:
 *
 * - The token is the only credential; there is no session. It goes in an
 *   Authorization header and nothing else is needed.
 * - The server accepts an expired token for refresh and for reading presets, so
 *   the client never needs to panic about expiry. It refreshes opportunistically
 *   and keeps working if that fails.
 */

export interface LicenceGrant {
  token: string
  tier: string
  features: string[]
  issuedAt: string
  expiresAt: string
  graceSeconds: number
  seats: { used: number, max: number }
}

export interface Preset {
  id: string
  name: string
  payload: Record<string, unknown>
  updatedAt: string
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly problems: string[]

  constructor (status: number, code: string, problems: string[] = []) {
    super(problems.length > 0 ? problems.join(', ') : code)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.problems = problems
  }
}

const TOKEN_STORAGE_KEY = 'ambiflux.licence.token'

/**
 * localStorage can throw (private windows, blocked site data), and a control
 * panel that cannot start because storage is unavailable would be a silly
 * failure mode. Treat persistence as best-effort.
 */
export function readStoredToken (): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY)
  } catch {
    return null
  }
}

export function storeToken (token: string | null): void {
  try {
    if (token === null) localStorage.removeItem(TOKEN_STORAGE_KEY)
    else localStorage.setItem(TOKEN_STORAGE_KEY, token)
  } catch {
    // Not fatal: the session simply will not survive a reload.
  }
}

async function request<T> (path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers
    }
  })

  if (response.status === 204) return undefined as T

  let body: unknown
  try {
    body = await response.json()
  } catch {
    body = {}
  }

  if (!response.ok) {
    const detail = body as { error?: string, problems?: string[] }
    throw new ApiError(response.status, detail.error ?? 'unknown_error', detail.problems)
  }

  return body as T
}

export async function activate (
  licenceKey: string,
  fingerprint: string,
  appVersion: string
): Promise<LicenceGrant> {
  return request<LicenceGrant>('/v1/licence/activate', {
    method: 'POST',
    body: JSON.stringify({ licenceKey, fingerprint, appVersion })
  })
}

export async function refresh (token: string): Promise<LicenceGrant> {
  return request<LicenceGrant>('/v1/licence/refresh', {
    method: 'POST',
    body: JSON.stringify({ token })
  })
}

export async function listPresets (token: string): Promise<Preset[]> {
  const body = await request<{ presets: Preset[] }>('/v1/presets', {
    headers: { authorization: `Bearer ${token}` }
  })
  return body.presets
}

export async function savePreset (
  token: string,
  id: string,
  name: string,
  payload: Record<string, unknown>
): Promise<void> {
  await request(`/v1/presets/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, payload })
  })
}

export async function deletePreset (token: string, id: string): Promise<void> {
  await request(`/v1/presets/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` }
  })
}

/**
 * An opaque, stable-per-browser machine identifier.
 *
 * The server only ever stores a digest, and the privacy claim in the README
 * ("we never send your machine name") depends on that being true here. So this
 * hashes a random per-install value rather than fingerprinting the device: it
 * still counts seats correctly, and it carries nothing identifying.
 */
export async function machineFingerprint (): Promise<string> {
  const STORAGE_KEY = 'ambiflux.install.id'
  let installId: string | null = null

  try {
    installId = localStorage.getItem(STORAGE_KEY)
  } catch {
    installId = null
  }

  if (installId === null) {
    installId = crypto.randomUUID()
    try {
      localStorage.setItem(STORAGE_KEY, installId)
    } catch {
      // Without storage the seat is re-taken on each visit. The server's
      // per-machine seat limit is the backstop.
    }
  }

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(installId))
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 64)
}
