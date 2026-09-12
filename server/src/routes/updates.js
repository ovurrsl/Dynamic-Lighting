import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const MANIFEST_PATH = fileURLToPath(new URL('../../data/updates.json', import.meta.url))

const querySchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      channel: { type: 'string', enum: ['stable', 'beta'], default: 'stable' }
    }
  }
}

/**
 * The manifest lives in a checked-in JSON file rather than the database.
 *
 * Releases are a git operation anyway (tag, build, publish artefacts), so
 * keeping the manifest next to them means a release is one commit and one
 * deploy, with no chance of the database and the published binaries disagreeing.
 *
 * Cached in-process after the first read. Hostinger restarts the process on
 * deploy, which is exactly when the file changes, so the cache cannot go stale.
 */
let cached = null

async function readManifest (log) {
  if (cached) return cached
  try {
    cached = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))
  } catch (error) {
    log.error({ err: error, path: MANIFEST_PATH }, 'update manifest unreadable')
    cached = { channels: {} }
  }
  return cached
}

export default async function updateRoutes (fastify) {
  fastify.get('/v1/updates/manifest', { schema: querySchema }, async (request, reply) => {
    const channel = request.query.channel ?? 'stable'
    const manifest = await readManifest(request.log)
    const entry = manifest.channels?.[channel]

    if (!entry) {
      return reply.code(404).send({ error: 'channel_not_found', channel })
    }

    return { channel, ...entry }
  })
}
