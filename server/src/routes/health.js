export default async function healthRoutes (fastify) {
  /**
   * Liveness. Deliberately does NOT touch the database.
   *
   * Hostinger stops the process when it is idle and restarts it on the next
   * request, so this endpoint doubles as the cheapest possible warm-up ping. If
   * it needed a database round-trip, waking the app would cost a connection
   * handshake every time.
   */
  fastify.get('/healthz', async () => ({ status: 'ok' }))

  /** Readiness. This one does check the database, so keep it off any hot path. */
  fastify.get('/readyz', async (request, reply) => {
    try {
      await fastify.storage.ping()
      return { status: 'ok', storage: fastify.storage.driver }
    } catch (error) {
      request.log.error({ err: error }, 'storage ping failed')
      return reply.code(503).send({ status: 'degraded', storage: fastify.storage.driver })
    }
  })

  fastify.get('/v1/version', async () => ({
    name: 'ambiflux-server',
    version: fastify.appVersion,
    // The client needs this to verify licence tokens offline. Publishing it is
    // the point: it is a public key, and shipping it over the API means the
    // engine can be built without a key baked in at compile time.
    licencePublicKey: fastify.licenceKeys.publicKeyBase64,
    licence: {
      ttlSeconds: fastify.config.licence.ttlSeconds,
      graceSeconds: fastify.config.licence.graceSeconds
    }
  }))
}
