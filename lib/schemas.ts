import { z } from 'zod'

/**
 * Request validation, ported from the Fastify JSON schemas.
 *
 * One trap from the old stack does not exist here and is worth recording,
 * because it cost a test failure to find: Fastify defaults AJV to
 * `removeAdditional: true`, which silently strips unknown fields and turns
 * `additionalProperties: false` into a no-op. The fix there was to disable it
 * explicitly. Zod's `.strict()` rejects unknown keys with no such default to
 * undo - a client sending a field we do not understand gets told, which is the
 * behaviour that was wanted all along.
 */

const LICENCE_KEY = /^[A-Za-z0-9-]{8,64}$/
// The client hashes its own machine identifiers before sending them, so the
// server only ever stores an opaque digest. Enforce that shape rather than
// accepting whatever the client feels like sending.
const FINGERPRINT = /^[A-Za-z0-9_-]{16,128}$/
export const PRESET_ID = /^[A-Za-z0-9_-]{1,64}$/

export const activateBody = z.object({
  licenceKey: z.string().regex(LICENCE_KEY, 'must be 8-64 characters of A-Z, a-z, 0-9 or -'),
  fingerprint: z.string().regex(FINGERPRINT, 'must be 16-128 characters of A-Z, a-z, 0-9, _ or -'),
  appVersion: z.string().max(32).optional()
}).strict()

export const refreshBody = z.object({
  token: z.string().min(32).max(4096)
}).strict()

/**
 * A preset is a monitor profile plus the look: LED layout, sampling bands,
 * smoothing constants, power budget. The server stores it opaquely on purpose -
 * the engine and the firmware own its meaning, and versioning it here would mean
 * redeploying the server every time a tuning knob is added. Hence passthrough on
 * the payload while the envelope around it stays strict.
 */
export const presetPayload = z.looseObject({
  schemaVersion: z.number().int().min(1).optional()
})

export const putPresetBody = z.object({
  name: z.string().min(1).max(128),
  payload: presetPayload
}).strict()

export const presetIdParam = z.string().regex(PRESET_ID, 'must be 1-64 characters of A-Z, a-z, 0-9, _ or -')

export const updatesQuery = z.object({
  channel: z.enum(['stable', 'beta']).default('stable')
})
