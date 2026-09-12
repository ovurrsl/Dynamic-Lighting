import { deletePreset, putPreset } from '#lib/api/presets'

// Thin adapter. The handler lives in lib/api so it can be tested without a
// build; this file owns only the URL, the runtime and the method mapping.
//
// runtime: node:crypto Ed25519 signing does not exist in the edge runtime.
// dynamic: a cached licence response would be served to the wrong machine.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Next 15 made dynamic route params a promise. Typing this as a plain object
// compiles and then fails at runtime with an id of `undefined`, which is a nasty
// way to find out - so the await is the whole reason this file is not a
// one-line re-export like its siblings.
type RouteContext = { params: Promise<{ id: string }> }

export async function PUT (request: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params
  return putPreset(request, id)
}

export async function DELETE (request: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params
  return deletePreset(request, id)
}
