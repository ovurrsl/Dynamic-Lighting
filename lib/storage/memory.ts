import type { Activation, Licence, Preset, Storage } from '#lib/storage/types'

/**
 * In-memory storage for development and tests.
 *
 * Rejected for production in config.ts, and the reason is the same on both
 * hosts: Hostinger stops an idle process and Vercel discards a function
 * instance, either of which would silently wipe every activation and preset.
 */
export interface MemoryStorage extends Storage {
  upsertLicence: (licence: Partial<Licence> & { key: string }) => void
}

export function createMemoryStorage (
  { licences = [] }: { licences?: Array<Partial<Licence> & { key: string }> } = {}
): MemoryStorage {
  const licenceRows = new Map<string, Licence>()
  /** licenceKey -> Map(fingerprint -> row) */
  const activations = new Map<string, Map<string, Activation>>()
  /** licenceKey -> Map(presetId -> row) */
  const presets = new Map<string, Map<string, Preset>>()

  const withDefaults = (licence: Partial<Licence> & { key: string }): Licence => ({
    status: 'active',
    tier: 'pro',
    maxSeats: 3,
    features: [],
    ...licence
  })

  for (const licence of licences) {
    licenceRows.set(licence.key, withDefaults(licence))
  }

  function bucket<T> (map: Map<string, Map<string, T>>, key: string): Map<string, T> {
    let inner = map.get(key)
    if (!inner) {
      inner = new Map<string, T>()
      map.set(key, inner)
    }
    return inner
  }

  return {
    driver: 'memory',

    async close () {},
    async ping () { return true },

    async getLicence (key) {
      return licenceRows.get(key) ?? null
    },

    async listActivations (licenceKey) {
      return [...bucket(activations, licenceKey).values()]
    },

    async recordActivation ({ licenceKey, fingerprint, appVersion }) {
      const seats = bucket(activations, licenceKey)
      const now = new Date()
      const existing = seats.get(fingerprint)
      if (existing) {
        existing.lastSeen = now
        if (appVersion) existing.appVersion = appVersion
        return { created: false }
      }
      seats.set(fingerprint, {
        licenceKey,
        fingerprint,
        appVersion: appVersion ?? null,
        firstSeen: now,
        lastSeen: now
      })
      return { created: true }
    },

    async deleteActivation ({ licenceKey, fingerprint }) {
      return bucket(activations, licenceKey).delete(fingerprint)
    },

    async listPresets (licenceKey) {
      return [...bucket(presets, licenceKey).values()]
        .sort((a, b) => a.id.localeCompare(b.id))
    },

    async putPreset ({ licenceKey, id, name, payload }) {
      const row: Preset = { licenceKey, id, name, payload, updatedAt: new Date() }
      bucket(presets, licenceKey).set(id, row)
      return row
    },

    async deletePreset ({ licenceKey, id }) {
      return bucket(presets, licenceKey).delete(id)
    },

    /** Seed helper for tests and local development; not used by routes. */
    upsertLicence (licence) {
      licenceRows.set(licence.key, withDefaults(licence))
    }
  }
}
