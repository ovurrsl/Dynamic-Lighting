import {
  deserialiseEngineConfig,
  serialiseEngineConfig,
  type EngineConfig
} from '#lib/engine/config'

/**
 * Named rigs.
 *
 * The layout editor produces real settings now, and one monitor is not one
 * setting: a desk rig and a TV rig are different strips, and the same strip
 * wants different band depths for films and for games. Without somewhere to
 * put them, every change overwrites the last one.
 *
 * Everything stays in this browser. There is no account to sync to and there
 * will not be one: AmbiFlux runs entirely client side, so the honest way to
 * move a rig between machines is a file its owner holds, not a row on someone
 * else's server. `exportProfiles` writes one and `importProfiles` reads it.
 *
 * Every access is guarded the same way as lib/config-store.ts: `localStorage`
 * throws outright in a private window with site data blocked, and that is not
 * a reason for the panel to fail.
 */

export const PROFILES_STORAGE_KEY = 'ambiflux/profiles'

/** Ids are the API's too: 1-64 chars of A-Z a-z 0-9 _ - (lib/schemas.ts). */
const ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/

export interface Profile {
  id: string
  name: string
  config: EngineConfig
  updatedAt: string
}

export interface StorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

export interface LoadedProfiles {
  profiles: Profile[]
  /** Set when something was stored and could not be read, so the panel can say so. */
  problem?: string
}

function defaultStorage (): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/**
 * A url- and API-safe id derived from the name, with a suffix when the name is
 * unusable (non-Latin names are ordinary here - the product's first language
 * is Turkish - and "oyun-modu" must not become the empty string).
 */
export function profileId (name: string, taken: readonly string[] = []): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56)
  const seed = base.length > 0 ? base : 'profil'
  if (!taken.includes(seed)) return seed
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${seed}-${n}`
    if (!taken.includes(candidate)) return candidate
  }
  return `${seed}-${Date.now()}`
}

export function isProfileId (value: string): boolean {
  return ID_SHAPE.test(value)
}

/**
 * Reads the stored profiles. A single unreadable entry is dropped rather than
 * losing the rest: profiles are independent, and one hand-edited or
 * older-version entry should not cost someone their other four.
 */
export function loadProfiles (storage: StorageLike | null = defaultStorage()): LoadedProfiles {
  if (storage === null) return { profiles: [] }
  let raw: string | null
  try {
    raw = storage.getItem(PROFILES_STORAGE_KEY)
  } catch (error) {
    return { profiles: [], problem: message(error) }
  }
  if (raw === null) return { profiles: [] }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { profiles: [], problem: `kayıtlı profiller okunamadı: ${message(error)}` }
  }
  if (!Array.isArray(parsed)) return { profiles: [], problem: 'kayıtlı profiller bir liste değil' }

  const profiles: Profile[] = []
  let dropped = 0
  for (const entry of parsed) {
    const row = entry as Partial<Record<'id' | 'name' | 'config' | 'updatedAt', unknown>>
    if (typeof row?.id !== 'string' || !isProfileId(row.id) || typeof row.name !== 'string') { dropped += 1; continue }
    try {
      profiles.push({
        id: row.id,
        name: row.name,
        config: deserialiseEngineConfig(typeof row.config === 'string' ? row.config : JSON.stringify(row.config)),
        updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : ''
      })
    } catch {
      dropped += 1
    }
  }
  return dropped === 0
    ? { profiles }
    : { profiles, problem: `${dropped} profil okunamadı ve atlandı` }
}

/** Returns the reason it could not be stored, or null when it was. */
export function storeProfiles (profiles: readonly Profile[], storage: StorageLike | null = defaultStorage()): string | null {
  if (storage === null) return 'tarayıcı yerel depolamaya izin vermiyor'
  try {
    storage.setItem(PROFILES_STORAGE_KEY, JSON.stringify(profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      // Serialised, so a stored profile is exactly what the engine would parse.
      config: serialiseEngineConfig(profile.config),
      updatedAt: profile.updatedAt
    }))))
    return null
  } catch (error) {
    return message(error)
  }
}

/**
 * Adds or replaces a profile by id and returns the new list, newest first.
 * Pure, so the caller decides when to store - and so this is testable without
 * a browser.
 */
export function upsertProfile (profiles: readonly Profile[], profile: Profile): Profile[] {
  const without = profiles.filter((existing) => existing.id !== profile.id)
  return [profile, ...without]
}

export function removeProfile (profiles: readonly Profile[], id: string): Profile[] {
  return profiles.filter((profile) => profile.id !== id)
}

/**
 * Merges imported profiles into the local ones, newest wins per id.
 *
 * Both sides were edited independently - that is the whole point of carrying a
 * file between machines - so neither can simply overwrite the other.
 * `updatedAt` decides, and a missing or unparseable timestamp loses, because a
 * profile that cannot say when it changed cannot claim to be the newer one.
 */
export function mergeProfiles (local: readonly Profile[], remote: readonly Profile[]): Profile[] {
  const byId = new Map<string, Profile>()
  for (const profile of local) byId.set(profile.id, profile)
  for (const profile of remote) {
    const existing = byId.get(profile.id)
    if (existing === undefined || time(profile.updatedAt) > time(existing.updatedAt)) {
      byId.set(profile.id, profile)
    }
  }
  return [...byId.values()].sort((a, b) => time(b.updatedAt) - time(a.updatedAt))
}

function time (value: string): number {
  const at = Date.parse(value)
  return Number.isNaN(at) ? 0 : at
}

function message (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------
// Carrying profiles between machines.
// ---------------------------------------------------------------------------

/** Bumped when the file's shape changes, so an old file can be recognised. */
export const PROFILE_FILE_VERSION = 1

/** Every profile as one JSON document, indented because someone will read it. */
export function exportProfiles (profiles: readonly Profile[]): string {
  return JSON.stringify({
    format: 'ambiflux/profiles',
    version: PROFILE_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    profiles: profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      config: JSON.parse(serialiseEngineConfig(profile.config)) as unknown,
      updatedAt: profile.updatedAt
    }))
  }, null, 2)
}

export interface ImportOutcome {
  /** Null when the file could not be used at all; `problem` then says why. */
  profiles: Profile[] | null
  added: number
  problem?: string
}

/**
 * Reads an exported file and merges it into `existing`.
 *
 * A file is a trust boundary like any other - it may have been hand-edited, or
 * written by a version that is not this one - so every profile in it is parsed
 * and validated, and an unreadable entry is skipped rather than costing the
 * rest. A file with nothing usable in it is reported as a failure, because
 * "imported 0 profiles" reads as success and is not.
 */
export function importProfiles (text: string, existing: readonly Profile[] = []): ImportOutcome {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { profiles: null, added: 0, problem: `geçerli JSON değil: ${message(error)}` }
  }
  const doc = parsed as { format?: unknown, profiles?: unknown }
  if (doc?.format !== 'ambiflux/profiles' || !Array.isArray(doc.profiles)) {
    return { profiles: null, added: 0, problem: 'bu bir AmbiFlux profil dosyası değil' }
  }

  const incoming: Profile[] = []
  let dropped = 0
  const taken = existing.map((profile) => profile.id)
  for (const entry of doc.profiles) {
    const row = entry as Partial<Record<'id' | 'name' | 'config' | 'updatedAt', unknown>>
    if (typeof row?.name !== 'string' || row.name === '') { dropped += 1; continue }
    try {
      const id = typeof row.id === 'string' && isProfileId(row.id) ? row.id : profileId(row.name, taken)
      taken.push(id)
      incoming.push({
        id,
        name: row.name,
        config: deserialiseEngineConfig(
          typeof row.config === 'string' ? row.config : JSON.stringify(row.config)
        ),
        updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : new Date().toISOString()
      })
    } catch {
      dropped += 1
    }
  }

  if (incoming.length === 0) {
    return { profiles: null, added: 0, problem: 'dosyada okunabilir profil yok' }
  }
  return {
    profiles: mergeProfiles(existing, incoming),
    added: incoming.length,
    ...(dropped === 0 ? {} : { problem: `${dropped} profil okunamadı ve atlandı.` })
  }
}
