import { updatesManifest } from '#lib/api/updates'

// Thin adapter. The handler lives in lib/api so it can be tested without a
// build; this file owns only the URL, the runtime and the method mapping.
//
// runtime: node:crypto Ed25519 signing does not exist in the edge runtime.
// dynamic: a cached licence response would be served to the wrong machine.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = updatesManifest
