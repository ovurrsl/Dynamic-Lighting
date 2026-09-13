import {
  DEFAULT_ENGINE_CONFIG,
  deserialiseEngineConfig,
  serialiseEngineConfig,
  type EngineConfig
} from '#lib/engine/config'

/**
 * The panel's copy of the engine configuration.
 *
 * The extension owns the configuration the engine runs on; this is the copy the
 * panel keeps so that the layout editor works with no extension installed -
 * the panel is also the shop window, and a page that cannot show you the
 * editor until you install something is a page that sells nothing.
 *
 * Every access is guarded. `localStorage` is not merely absent during a server
 * render: reading it throws outright in a Chrome private window with site data
 * blocked, and writing throws when the origin's quota is full. Neither is a
 * reason for the panel to fail to render, so both fall back to the reference
 * rig and say so through the return value rather than through an exception.
 */

export const CONFIG_STORAGE_KEY = 'ambiflux/config'

/** Just enough of the Storage interface to be injectable in a test. */
export interface StorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

export type LoadOutcome =
  /** Nothing stored yet: the reference rig, which is what a fresh install runs. */
  | { config: EngineConfig, source: 'default', problem?: undefined }
  | { config: EngineConfig, source: 'stored', problem?: undefined }
  /**
   * Something was stored and could not be used - written by an older version,
   * or hand-edited. The reference rig stands and `problem` says why, so the
   * panel can offer to overwrite instead of silently losing the user's work.
   *
   * `problem` is declared on every arm (as `undefined`) rather than only on
   * this one so a caller can read `outcome.problem` without narrowing first:
   * an `in` check to find out whether something went wrong is a trap, since
   * forgetting it compiles on the happy path and fails on the sad one.
   */
  | { config: EngineConfig, source: 'default', problem: string }

function defaultStorage (): StorageLike | null {
  try {
    // Both the `typeof` and the access can throw; the access is the one that
    // does in a private window.
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function loadStoredConfig (storage: StorageLike | null = defaultStorage()): LoadOutcome {
  if (storage === null) return { config: DEFAULT_ENGINE_CONFIG, source: 'default' }
  let raw: string | null
  try {
    raw = storage.getItem(CONFIG_STORAGE_KEY)
  } catch (error) {
    return { config: DEFAULT_ENGINE_CONFIG, source: 'default', problem: message(error) }
  }
  if (raw === null) return { config: DEFAULT_ENGINE_CONFIG, source: 'default' }
  try {
    return { config: deserialiseEngineConfig(raw), source: 'stored' }
  } catch (error) {
    return { config: DEFAULT_ENGINE_CONFIG, source: 'default', problem: message(error) }
  }
}

/** Returns the reason it could not be stored, or null when it was. */
export function storeConfig (config: EngineConfig, storage: StorageLike | null = defaultStorage()): string | null {
  if (storage === null) return 'tarayıcı yerel depolamaya izin vermiyor'
  try {
    storage.setItem(CONFIG_STORAGE_KEY, serialiseEngineConfig(config))
    return null
  } catch (error) {
    return message(error)
  }
}

export function clearStoredConfig (storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.removeItem(CONFIG_STORAGE_KEY)
  } catch {
    // Nothing to do about it, and nothing depends on it having worked.
  }
}

function message (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
