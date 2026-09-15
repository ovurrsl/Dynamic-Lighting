import { healthz } from '#lib/api/health'

// Thin adapter. The handler lives in lib/api so it can be tested without a
// build; this file owns only the URL, the runtime and the method mapping.
//
export const dynamic = 'force-dynamic'

export const GET = healthz
