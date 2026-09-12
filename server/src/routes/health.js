export default function healthRoutes (app, services) {
  /**
   * Liveness. Deliberately does NOT touch the database.
   *
   * The host stops the process when idle and restarts it on the next request, so
   * this doubles as the cheapest possible warm-up ping. If it needed a database
   * round-trip, waking the app would import the driver and pay a connection
   * handshake every time.
   */
  app.get('/healthz', (context) => context.json({ status: 'ok' }))

  /** Readiness. This one does check the database, so keep it off any hot path. */
  app.get('/readyz', async (context) => {
    try {
      await services.storage.ping()
      return context.json({ status: 'ok', storage: services.storage.driver })
    } catch (error) {
      services.log.error({ err: error.message }, 'storage ping failed')
      return context.json({ status: 'degraded', storage: services.storage.driver }, 503)
    }
  })

  app.get('/v1/version', (context) => context.json({
    name: 'ambiflux-server',
    version: services.appVersion,
    // The client needs this to verify licence tokens offline. Publishing it is
    // the point: it is a public key, and serving it means the engine and the
    // extension can be built without a key baked in at compile time.
    licencePublicKey: services.licenceKeys.publicKeyBase64,
    licence: {
      ttlSeconds: services.config.licence.ttlSeconds,
      graceSeconds: services.config.licence.graceSeconds
    }
  }))
}
