import type { AppConfig } from '#lib/config'
import { createMemoryStorage } from '#lib/storage/memory'
import { createSupabaseStorage } from '#lib/storage/supabase'
import type { Storage } from '#lib/storage/types'

export type { Activation, Licence, Preset, Storage } from '#lib/storage/types'

/**
 * A licence that only exists in development, so the endpoints can be exercised
 * without a database. config.ts refuses to start in production with the memory
 * driver, so this can never leak into a real deployment.
 */
export const DEV_LICENCE = {
  key: 'AF-DEV-0000-0000',
  tier: 'pro',
  maxSeats: 3,
  status: 'active',
  features: ['ambilight', 'hdr', 'presets']
}

export function createStorage (config: AppConfig): Storage {
  if (config.storage.driver === 'supabase') {
    return createSupabaseStorage(config.storage.supabase)
  }
  return createMemoryStorage({
    licences: config.isProduction ? [] : [DEV_LICENCE]
  })
}
