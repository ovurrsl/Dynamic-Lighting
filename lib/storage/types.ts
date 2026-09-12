/**
 * The storage contract.
 *
 * This interface is the reason swapping MySQL for Supabase was a day and not a
 * rewrite, so it is worth keeping honest: routes may only use what is declared
 * here, and a driver may not leak its dialect through the return types.
 */

export interface Licence {
  key: string
  tier: string
  maxSeats: number
  status: string
  features: string[]
}

export interface Activation {
  licenceKey: string
  fingerprint: string
  appVersion: string | null
  firstSeen: Date | string
  lastSeen: Date | string
}

export interface Preset {
  licenceKey: string
  id: string
  name: string
  payload: Record<string, unknown>
  updatedAt: Date | string
}

export interface Storage {
  readonly driver: string
  close: () => Promise<void>
  ping: () => Promise<boolean>
  getLicence: (key: string) => Promise<Licence | null>
  listActivations: (licenceKey: string) => Promise<Activation[]>
  /**
   * Upsert one seat. `created` distinguishes a new seat from a returning one and
   * MUST be decided atomically with the write - the seat-limit check in
   * /v1/licence/activate depends on it. See the record_activation SQL function.
   */
  recordActivation: (input: {
    licenceKey: string
    fingerprint: string
    appVersion?: string | null
  }) => Promise<{ created: boolean }>
  deleteActivation: (input: { licenceKey: string, fingerprint: string }) => Promise<boolean>
  listPresets: (licenceKey: string) => Promise<Preset[]>
  putPreset: (input: {
    licenceKey: string
    id: string
    name: string
    payload: Record<string, unknown>
  }) => Promise<Preset>
  deletePreset: (input: { licenceKey: string, id: string }) => Promise<boolean>
}
