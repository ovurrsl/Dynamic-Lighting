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
 * What is deployed. Kept because the extension checks it against its own build
 * to tell someone their panel and their engine have drifted apart, which is a
 * real support question and a cheap answer.
 */
export const version = withErrorHandling(async (): Promise<Response> =>
  json({ name: 'ambiflux', version: APP_VERSION }))
