import { manifest, type ChannelName } from '#data/updates'
import { apiError, json, validationError, withErrorHandling } from '#lib/http'
import { updatesQuery } from '#lib/schemas'

export const updatesManifest = withErrorHandling(async (request: Request) => {
  const url = new URL(request.url)
  const raw = url.searchParams.get('channel')
  const parsed = updatesQuery.safeParse(raw === null ? {} : { channel: raw })
  if (!parsed.success) return validationError(parsed.error)

  const channel = parsed.data.channel as ChannelName
  const entry = manifest[channel]

  // A channel that is valid in the schema but not yet published is a 404, not a
  // validation error: `beta` is a real channel name with nothing in it today.
  if (!entry) return apiError(404, 'channel_not_found', { channel })

  return json({ channel, ...entry })
})
