import { notFound } from '#lib/api/notfound'

// Thin adapter. Catches every method under /v1/ that no real route matched.
//
// Static and dynamic segments both win over a catch-all in Next's route
// precedence, so this cannot shadow /v1/presets/[id] or any sibling.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = notFound
export const POST = notFound
export const PUT = notFound
export const PATCH = notFound
export const DELETE = notFound
