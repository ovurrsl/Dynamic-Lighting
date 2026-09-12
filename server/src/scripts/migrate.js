import process from 'node:process'

import { loadConfig } from '../config.js'
import { createLogger } from '../lib/log.js'
import { createStorage } from '../storage/index.js'

/**
 * Creates the database schema.
 *
 * Split out of the boot path deliberately: running DDL on startup meant every
 * cold start imported the MySQL driver (~78 ms measured) and spent three
 * round-trips before serving anything, including requests that never touch the
 * database. On a host that stops the process when idle, that was paid constantly.
 *
 * Run once after deploying, and again only when the schema changes.
 */
const log = createLogger({ level: 'info' })
const config = loadConfig()
const storage = createStorage(config)

try {
  await storage.migrate()
  log.info({ driver: storage.driver }, 'schema is up to date')
} catch (error) {
  log.error({ err: error.message, driver: storage.driver }, 'migration failed')
  process.exitCode = 1
} finally {
  await storage.close()
}
