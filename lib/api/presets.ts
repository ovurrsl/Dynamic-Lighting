import { enforceRateLimit, requireLicence } from '#lib/auth'
import { apiError, json, noContent, readJsonBody, validationError, withErrorHandling } from '#lib/http'
import { presetIdParam, putPresetBody } from '#lib/schemas'
import { getContext } from '#lib/server'

export const listPresets = withErrorHandling(async (request: Request) => {
  const limited = enforceRateLimit(request, 'presets:list')
  if (limited) return limited

  const auth = requireLicence(request)
  if (!auth.ok) return auth.response

  const { storage } = getContext()
  const presets = await storage.listPresets(auth.licence.key)

  return json({
    presets: presets.map(({ id, name, payload, updatedAt }) => ({
      id,
      name,
      payload,
      updatedAt: updatedAt instanceof Date ? updatedAt.toISOString() : updatedAt
    }))
  })
})

export const putPreset = withErrorHandling(async (request: Request, rawId: string) => {
  const limited = enforceRateLimit(request, 'presets:put')
  if (limited) return limited

  const auth = requireLicence(request)
  if (!auth.ok) return auth.response

  const idCheck = presetIdParam.safeParse(rawId)
  if (!idCheck.success) return validationError(idCheck.error)

  const body = await readJsonBody(request)
  if (!body.ok) return body.response

  const parsed = putPresetBody.safeParse(body.value)
  if (!parsed.success) return validationError(parsed.error)

  const { storage } = getContext()
  const row = await storage.putPreset({
    licenceKey: auth.licence.key,
    id: idCheck.data,
    name: parsed.data.name,
    payload: parsed.data.payload as Record<string, unknown>
  })

  return json({
    id: row.id,
    name: row.name,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt
  })
})

export const deletePreset = withErrorHandling(async (request: Request, rawId: string) => {
  const limited = enforceRateLimit(request, 'presets:delete')
  if (limited) return limited

  const auth = requireLicence(request)
  if (!auth.ok) return auth.response

  const idCheck = presetIdParam.safeParse(rawId)
  if (!idCheck.success) return validationError(idCheck.error)

  const { storage } = getContext()
  const deleted = await storage.deletePreset({
    licenceKey: auth.licence.key,
    id: idCheck.data
  })

  if (!deleted) return apiError(404, 'preset_not_found')
  return noContent()
})
