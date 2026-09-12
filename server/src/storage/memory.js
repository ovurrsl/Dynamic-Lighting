/**
 * In-memory storage for development and tests.
 *
 * Deliberately rejected for production in config.js: Hostinger stops an idle
 * Node process, which would silently wipe every activation and preset.
 */
export function createMemoryStorage ({ licences = [] } = {}) {
  const licenceRows = new Map()
  /** licenceKey -> Map(fingerprint -> row) */
  const activations = new Map()
  /** licenceKey -> Map(presetId -> row) */
  const presets = new Map()

  const withDefaults = (licence) => ({
    status: 'active',
    tier: 'pro',
    maxSeats: 3,
    features: [],
    ...licence
  })

  for (const licence of licences) {
    licenceRows.set(licence.key, withDefaults(licence))
  }

  const bucket = (map, key) => {
    let inner = map.get(key)
    if (!inner) {
      inner = new Map()
      map.set(key, inner)
    }
    return inner
  }

  return {
    driver: 'memory',

    async migrate () {},
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
      const row = { licenceKey, id, name, payload, updatedAt: new Date() }
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
