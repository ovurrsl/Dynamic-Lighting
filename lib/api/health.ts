import { APP_VERSION } from '#data/version'
import { json, withErrorHandling } from '#lib/http'

/**
 * Liveness, and nothing else.
 *
 * It used to answer readiness too, which meant a database round trip and a
 * report of missing environment variables. AmbiFlux has neither now: there is
 * no account, no licence and no server-side storage, so there is nothing for
 * the panel to be un-ready for. Everything the app does happens in the browser.
 */
export const healthz = withErrorHandling(async (): Promise<Response> => json({ status: 'ok' }))

/**
 * What is deployed. Kept for the support question "which panel is live" - a
 * cheap answer to a real question. The extension does NOT read it (an earlier
 * version of this comment said so and was wrong); the two versions are held
 * equal at build time instead (test/version.test.ts).
 */
export const version = withErrorHandling(async (): Promise<Response> =>
  json({ name: 'ambiflux', version: APP_VERSION }))
