import process from 'node:process'

import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { createStorage } from './storage/index.js'

async function main () {
  const config = loadConfig()
  const storage = createStorage(config)

  await storage.init()

  const app = await buildApp({ config, storage })

  // Hostinger stops an idle process and expects a clean exit, so shut the pool
  // down rather than letting connections die with the container.
  const shutdown = async (signal) => {
    app.log.info({ signal }, 'shutting down')
    try {
      await app.close()
      await storage.close()
      process.exit(0)
    } catch (error) {
      app.log.error({ err: error }, 'shutdown failed')
      process.exit(1)
    }
  }

  process.on('SIGTERM', () => { void shutdown('SIGTERM') })
  process.on('SIGINT', () => { void shutdown('SIGINT') })

  await app.listen({ host: config.host, port: config.port })
}

main().catch((error) => {
  // No logger yet if config parsing is what failed, so write plainly and make
  // the reason the first thing visible in Hostinger's log view.
  console.error(`ambiflux-server failed to start:\n${error.message}`)
  process.exitCode = 1
})
