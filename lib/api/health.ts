import { configProblems } from '#lib/config'
import { json, withErrorHandling } from '#lib/http'
import { getContext } from '#lib/server'

/**
 * Liveness. Deliberately does NOT touch the database, and not for tidiness.
 *
 * Both hosts put the app to sleep - Hostinger stops the process, Vercel discards
 * the instance - so this doubles as the cheapest possible warm-up ping. If it
 * needed a database round trip, waking the app would cost a connection handshake
 * every time. It also must not reach the storage driver at all, which is why the
 * Supabase client is imported lazily.
 */
export const healthz = withErrorHandling(async (): Promise<Response> => json({ status: 'ok' }))

/**
 * Readiness. This one does check the database, so keep it off any hot path.
 *
 * It also reports configuration problems, which matters more here than it did on
 * Fastify. There, a misconfigured app refused to boot and the operator saw it in
 * the start-up log. Serverless has no boot, so without this the only symptom of a
 * missing environment variable would be 500s with nothing to read.
 */
export const readyz = withErrorHandling(async (): Promise<Response> => {
  const problems = configProblems()
  if (problems) {
    return json({ status: 'misconfigured', problems }, 503)
  }

  const { storage } = getContext()
  try {
    await storage.ping()
    return json({ status: 'ok', storage: storage.driver })
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      msg: 'storage ping failed',
      err: error instanceof Error ? error.message : String(error)
    }))
    return json({ status: 'degraded', storage: storage.driver }, 503)
  }
})

export const version = withErrorHandling(async (): Promise<Response> => {
  const { appVersion, licenceKeys, config } = getContext()
  return json({
    name: 'ambiflux-server',
    version: appVersion,
    // The client needs this to verify licence tokens offline. Publishing it is
    // the point: it is a public key, and shipping it over the API means the
    // engine can be built without a key baked in at compile time.
    licencePublicKey: licenceKeys.publicKeyBase64,
    licence: {
      ttlSeconds: config.licence.ttlSeconds,
      graceSeconds: config.licence.graceSeconds
    }
  })
})
