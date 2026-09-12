import { enforceRateLimit } from '#lib/auth'
import { issueGrant } from '#lib/grant'
import { apiError, json, readJsonBody, validationError, withErrorHandling } from '#lib/http'
import { verifyToken } from '#lib/licence'
import { activateBody, refreshBody } from '#lib/schemas'
import { getContext } from '#lib/server'

export const activate = withErrorHandling(async (request: Request) => {
  const limited = enforceRateLimit(request, 'licence:activate')
  if (limited) return limited

  const body = await readJsonBody(request)
  if (!body.ok) return body.response

  const parsed = activateBody.safeParse(body.value)
  if (!parsed.success) return validationError(parsed.error)

  const { licenceKey, fingerprint, appVersion } = parsed.data
  const { storage, licenceKeys, config } = getContext()

  const licence = await storage.getLicence(licenceKey)
  if (!licence) return apiError(404, 'licence_not_found')
  if (licence.status !== 'active') {
    return apiError(403, 'licence_inactive', { status: licence.status })
  }

  // Record first, then enforce the seat cap, then roll back if we pushed it over.
  // Counting before inserting would let two simultaneous activations both see a
  // free seat and both take it. This is why recordActivation has to decide
  // `created` atomically with the write - see the record_activation SQL function.
  const { created } = await storage.recordActivation({ licenceKey, fingerprint, appVersion })
  const activations = await storage.listActivations(licenceKey)

  if (created && activations.length > licence.maxSeats) {
    await storage.deleteActivation({ licenceKey, fingerprint })
    return apiError(403, 'seat_limit_reached', {
      seats: { used: licence.maxSeats, max: licence.maxSeats }
    })
  }

  return json({
    ...issueGrant(licenceKeys, config, licence, fingerprint),
    seats: { used: activations.length, max: licence.maxSeats }
  })
})

/**
 * Refreshes a token. Deliberately accepts an *expired* token: expiry is how the
 * client knows to ask again, not a reason to refuse. The licence row is the
 * authority, which is what makes revocation work - a refunded key stops
 * refreshing and its last token ages out within one TTL.
 */
export const refresh = withErrorHandling(async (request: Request) => {
  const limited = enforceRateLimit(request, 'licence:refresh')
  if (limited) return limited

  const body = await readJsonBody(request)
  if (!body.ok) return body.response

  const parsed = refreshBody.safeParse(body.value)
  if (!parsed.success) return validationError(parsed.error)

  const { storage, licenceKeys, config } = getContext()

  const result = verifyToken(licenceKeys.publicKey, parsed.data.token)
  if (!result.ok) return apiError(401, result.reason)

  const { key: licenceKey, fp: fingerprint } = result.payload
  const licence = await storage.getLicence(licenceKey)

  if (!licence) return apiError(404, 'licence_not_found')
  if (licence.status !== 'active') {
    return apiError(403, 'licence_inactive', { status: licence.status })
  }

  // A refresh is also a heartbeat: it is how last_seen stays current.
  await storage.recordActivation({ licenceKey, fingerprint })
  const activations = await storage.listActivations(licenceKey)

  return json({
    ...issueGrant(licenceKeys, config, licence, fingerprint),
    seats: { used: activations.length, max: licence.maxSeats }
  })
})
