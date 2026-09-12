import { signToken } from '#lib/licence'
import type { LicenceKeys } from '#lib/server'
import type { AppConfig } from '#lib/config'
import type { Licence } from '#lib/storage/types'

export interface LicenceGrant {
  token: string
  tier: string
  features: string[]
  issuedAt: string
  expiresAt: string
  graceSeconds: number
}

/**
 * Builds the token a client will live on for the next TTL window.
 *
 * `features` come from the licence row and are baked into the signed payload, so
 * the client reads its entitlements from verified data rather than from a local
 * flag it could flip.
 */
export function issueGrant (
  keys: LicenceKeys,
  config: AppConfig,
  licence: Licence,
  fingerprint: string
): LicenceGrant {
  const { token, payload } = signToken(keys.privateKey, {
    licenceKey: licence.key,
    fingerprint,
    tier: licence.tier,
    features: licence.features,
    ttlSeconds: config.licence.ttlSeconds,
    graceSeconds: config.licence.graceSeconds
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
