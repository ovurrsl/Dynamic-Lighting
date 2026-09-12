// Caches V8 compilation to disk. Measured worth ~35 ms on a cold start, which
// matters here because this host stops the process when idle and restarts it on
// the next request — so a "cold" start is the normal case, not the rare one.
// Must run before the heavy imports below to cover them.
import { enableCompileCache } from 'node:module'
try {
  enableCompileCache?.()
} catch {
  // Older Node, or a read-only cache directory. Not worth failing a boot over.
}

import process from 'node:process'

import { serve } from '@hono/node-server'

import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { createLogger } from './lib/log.js'
import { createStorage } from './storage/index.js'

async function main () {
  const config = loadConfig()
  const log = createLogger({ level: config.logLevel })
  const storage = createStorage(config)

  // No storage.migrate() here on purpose. Schema creation is `npm run migrate`,
  // so a cold start never imports the database driver or spends round-trips on
  // DDL before it can serve a request that may not need the database at all.
  const app = await buildApp({ config, storage, log })

  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    log.info({ port: info.port, host: config.host, storage: storage.driver }, 'listening')
  })

  const shutdown = (signal) => {
    log.info({ signal }, 'shutting down')
    server.close(async () => {
      try {
        await storage.close()
        process.exit(0)
      } catch (error) {
        log.error({ err: error.message }, 'shutdown failed')
        process.exit(1)
      }
    })
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((error) => {
  // There may be no logger yet if config parsing is what failed, so write
  // plainly and make the reason the first thing visible in the host's log view.
  console.error(`ambiflux-server failed to start:\n${error.message}`)
  process.exitCode = 1
})
