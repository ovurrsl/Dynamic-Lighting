import { apiError } from '#lib/http'

/**
 * JSON 404 for anything under /v1/ that no real route matched.
 *
 * Without this, a typo'd API path falls through to Next's 404 page and an API
 * client gets a chunk of HTML where it expected an error object. The Fastify app
 * had this as a `setNotFoundHandler` that checked for the /v1/ prefix, and there
 * is a test asserting it - the behaviour is deliberate, not incidental.
 */
export const notFound = async (): Promise<Response> => apiError(404, 'not_found')
