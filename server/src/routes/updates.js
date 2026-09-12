import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const MANIFEST_PATH = fileURLToPath(new URL('../../data/updates.json', import.meta.url))
const CHANNELS = new Set(['stable', 'beta'])

/**
 * The manifest lives in a checked-in JSON file rather than the database.
 *
 * Releases are a git operation anyway (tag, build, publish artefacts), so
 * keeping the manifest next to them means a release is one commit and one
 * deploy, with no chance of the database and the published binaries disagreeing.
 *
 * Read once per process. The host restarts the process on deploy, which is
 * exactly when the file changes, so the cache cannot go stale.
 */
let cached = null

async function readManifest (log) {
  if (cached) return cached
  try {
    cached = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))
  } catch (error) {
    log.error({ err: error.message, path: MANIFEST_PATH }, 'update manifest unreadable')
    cached = { channels: {} }
  }
  return cached
}

export default function updateRoutes (app, services) {
  app.get('/v1/updates/manifest', async (context) => {
    const channel = context.req.query('channel') ?? 'stable'
    if (!CHANNELS.has(channel)) {
      return context.json({ error: 'validation_failed', problems: ['channel must be stable or beta'] }, 400)
    }

    const manifest = await readManifest(services.log)
    const entry = manifest.channels?.[channel]
    if (!entry) return context.json({ error: 'channel_not_found', channel }, 404)

    return context.json({ channel, ...entry })
  })
}
