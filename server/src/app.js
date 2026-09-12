import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Hono } from 'hono'

import { createLogger } from './lib/log.js'
import { generateKeyPair, loadPrivateKey, loadPublicKey, publicKeyFromPrivate } from './lib/licence.js'
import { clientKey, createRateLimiter } from './lib/ratelimit.js'
import healthRoutes from './routes/health.js'
import licenceRoutes from './routes/licence.js'
import presetRoutes from './routes/presets.js'
import updateRoutes from './routes/updates.js'

const PACKAGE_PATH = fileURLToPath(new URL('../../package.json', import.meta.url))

async function readAppVersion () {
  try {
    const pkg = JSON.parse(await readFile(PACKAGE_PATH, 'utf8'))
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * Resolves the signing keypair.
 *
 * A missing key in development produces an ephemeral one with a loud warning
 * rather than a crash, so `npm run dev` works out of the box. Tokens issued
 * before a restart stop verifying after it, which is exactly what you want from
 * a throwaway key: it cannot be mistaken for a real one. config.js makes this
 * impossible in production.
 */
function resolveLicenceKeys (config, log) {
  if (config.licence.signingKey) {
    const privateKey = loadPrivateKey(config.licence.signingKey)
    const publicKey = publicKeyFromPrivate(privateKey)
    return {
      privateKey,
      publicKey,
      publicKeyBase64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      ephemeral: false
    }
  }

  log.warn('LICENCE_SIGNING_KEY is not set - generating an ephemeral keypair. Tokens stop verifying when this process restarts. Run `npm run keygen` for a persistent key.')
  const generated = generateKeyPair()
  return {
    privateKey: loadPrivateKey(generated.privateKey),
    publicKey: loadPublicKey(generated.publicKey),
    publicKeyBase64: generated.publicKey,
    ephemeral: true
  }
}

/**
 * Builds the app without listening. Hono's `app.request()` drives it in tests
 * with no ports and no server involved.
 */
export async function buildApp ({ config, storage, log = createLogger({ level: config.logLevel }) }) {
  const app = new Hono()

  /**
   * Shared state hangs off one object rather than per-request context writes, so
   * handlers read it directly without Hono's generic plumbing.
   */
  const services = {
    config,
    storage,
    log,
    appVersion: await readAppVersion(),
    licenceKeys: resolveLicenceKeys(config, log),
    limiter: createRateLimiter({
      max: config.rateLimit.max,
      windowMs: config.rateLimit.windowMs
    })
  }

  app.onError((error, context) => {
    log.error({ err: error.message, path: context.req.path }, 'request failed')
    return context.json({ error: 'internal_error' }, 500)
  })

  // CORS. An empty allow-list means same-origin only, which is correct when the
  // page and the API are one deployment.
  if (config.corsOrigins.length > 0) {
    app.use('/v1/*', async (context, next) => {
      const origin = context.req.header('origin')
      if (origin && config.corsOrigins.includes(origin)) {
        context.header('access-control-allow-origin', origin)
        context.header('vary', 'origin')
        context.header('access-control-allow-headers', 'authorization,content-type')
        context.header('access-control-allow-methods', 'GET,PUT,POST,DELETE,OPTIONS')
      }
      if (context.req.method === 'OPTIONS') return context.body(null, 204)
      await next()
    })
  }

  // Rate limiting covers /v1/* only. /healthz is deliberately exempt: it is the
  // cheapest way to wake this app on a host that sleeps it, and throttling the
  // wake-up ping would be self-defeating.
  app.use('/v1/*', async (context, next) => {
    const result = services.limiter.hit(clientKey(context, config.trustProxy))
    if (!result.allowed) {
      context.header('retry-after', String(result.retryAfterSeconds))
      return context.json({ error: 'rate_limited' }, 429)
    }
    await next()
  })

  healthRoutes(app, services)
  licenceRoutes(app, services)
  presetRoutes(app, services)
  updateRoutes(app, services)

  // The frontend is served by the same process as the API: one build, one start
  // command, one thing to deploy. Whichever UI kit is used only has to emit
  // static files into this directory.
  const webRoot = resolve(process.cwd(), config.webDir)
  if (existsSync(webRoot)) {
    const { serveStatic } = await import('@hono/node-server/serve-static')
    const relativeRoot = config.webDir.replace(/^\.?\//, '')
    app.use('/*', serveStatic({ root: relativeRoot }))
    // SPA fallback, but never for the API: an unknown /v1 path is a client bug
    // and should say so rather than returning HTML.
    app.notFound((context) =>
      (context.req.path.startsWith('/v1/')
        ? context.json({ error: 'not_found' }, 404)
        : serveStatic({ root: relativeRoot, path: 'index.html' })(context, async () => {})))
    log.info({ webRoot }, 'serving frontend')
  } else {
    app.notFound((context) => context.json({ error: 'not_found' }, 404))
    log.warn({ webRoot }, 'no frontend build found - serving API only')
  }

  app.services = services
  return app
}
