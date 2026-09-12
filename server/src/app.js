import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import Fastify from 'fastify'

import { generateKeyPair, loadPrivateKey, loadPublicKey, publicKeyFromPrivate } from './lib/licence.js'
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
 * In development a missing key produces an ephemeral one with a loud warning
 * rather than a crash, so `npm run dev` works out of the box. Every token
 * issued before a restart becomes unverifiable after it, which is exactly the
 * behaviour you want from a throwaway key — it cannot be mistaken for a real one.
 *
 * config.js makes this impossible in production.
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

  log.warn('LICENCE_SIGNING_KEY is not set - generating an ephemeral keypair. Tokens will stop verifying when this process restarts. Run `npm run keygen` for a persistent key.')
  const generated = generateKeyPair()
  return {
    privateKey: loadPrivateKey(generated.privateKey),
    publicKey: loadPublicKey(generated.publicKey),
    publicKeyBase64: generated.publicKey,
    ephemeral: true
  }
}

/**
 * Builds the server without listening, so tests can drive it through
 * `app.inject()` with no ports involved.
 */
export async function buildApp ({ config, storage }) {
  const fastify = Fastify({
    logger: {
      level: config.logLevel,
      // Hostinger captures stdout; pretty-printing would only make those logs
      // harder to grep.
      ...(config.isProduction ? {} : { transport: undefined })
    },
    trustProxy: config.trustProxy,
    // Licence payloads and presets are small. A tight cap is free protection.
    bodyLimit: 256 * 1024,
    ajv: {
      customOptions: {
        // Fastify defaults to removeAdditional:true, which silently strips
        // unknown fields and makes `additionalProperties: false` a no-op. For a
        // licensing API it is better to reject: a client sending a field we do
        // not understand has a bug, and quietly dropping it hides that bug on
        // both sides.
        removeAdditional: false,
        // Report every problem at once so a client author sees the whole list
        // instead of fixing one field per round-trip.
        allErrors: true
      }
    }
  })

  fastify.decorate('config', config)
  fastify.decorate('storage', storage)
  fastify.decorate('appVersion', await readAppVersion())
  fastify.decorate('licenceKeys', resolveLicenceKeys(config, fastify.log))

  await fastify.register(import('@fastify/cors'), {
    // An empty allow-list means same-origin only, which is correct when the
    // hosted page and the API are one deployment.
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : false,
    methods: ['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS']
  })

  await fastify.register(import('@fastify/rate-limit'), {
    max: config.rateLimit.max,
    timeWindow: config.rateLimit.windowMs,
    // Activation and refresh are the endpoints worth brute-forcing, since a
    // valid licence key is the only secret involved.
    allowList: (request) => request.url === '/healthz'
  })

  fastify.setErrorHandler((error, request, reply) => {
    const status = error.statusCode ?? 500
    if (status >= 500) {
      request.log.error({ err: error }, 'request failed')
      return reply.code(status).send({ error: 'internal_error' })
    }
    // Fastify's schema validation errors are safe to surface and are the
    // fastest way for a client author to see what they got wrong.
    return reply.code(status).send({
      error: error.code === 'FST_ERR_VALIDATION' ? 'validation_failed' : 'request_failed',
      message: error.message
    })
  })

  await fastify.register(healthRoutes)
  await fastify.register(licenceRoutes)
  await fastify.register(presetRoutes)
  await fastify.register(updateRoutes)

  // The frontend is served by the same process as the API: one build, one
  // start command, one thing for Hostinger to deploy. Whichever UI kit gets
  // chosen only has to emit static files into this directory.
  const webRoot = resolve(process.cwd(), config.webDir)
  if (existsSync(webRoot)) {
    await fastify.register(import('@fastify/static'), { root: webRoot })
    fastify.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/v1/')) {
        return reply.code(404).send({ error: 'not_found' })
      }
      return reply.sendFile('index.html')
    })
    fastify.log.info({ webRoot }, 'serving frontend')
  } else {
    // Same JSON shape as above, so the API answers identically whether or not a
    // frontend build happens to be present. Without this, an unknown route
    // would return Fastify's default HTML-ish error body in development and a
    // clean JSON error in production — the kind of difference that gets found
    // by a client author rather than by us.
    fastify.setNotFoundHandler((_request, reply) =>
      reply.code(404).send({ error: 'not_found' }))
    fastify.log.warn({ webRoot }, 'no frontend build found - serving API only')
  }

  return fastify
}
