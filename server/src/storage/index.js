import { createMemoryStorage } from './memory.js'
import { createMysqlStorage } from './mysql.js'

/**
 * A licence that only exists in development, so the endpoints can be exercised
 * without a database. config.js refuses to start in production with the memory
 * driver, so this can never leak into a real deployment.
 */
export const DEV_LICENCE = {
  key: 'AF-DEV-0000-0000',
  tier: 'pro',
  maxSeats: 3,
  status: 'active',
  features: ['ambilight', 'hdr', 'presets']
}

export function createStorage (config) {
  if (config.storage.driver === 'mysql') {
    return createMysqlStorage(config.storage.mysql)
  }
  return createMemoryStorage({
    licences: config.isProduction ? [] : [DEV_LICENCE]
  })
}
