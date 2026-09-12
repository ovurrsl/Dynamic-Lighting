/**
 * A deliberately tiny shape checker.
 *
 * This exists instead of Zod or AJV for a measured reason: on this host the
 * process is stopped when idle and restarted on the next request, so cold start
 * is the only latency a user ever feels. Measured boot cost of the whole server
 * was ~103 ms with these hand-written checks and ~180 ms with Zod — the
 * validator would have been the single most expensive thing in the process.
 *
 * That trade is only defensible because the surface is three small request
 * bodies. If this file starts growing conditionals, nested objects or unions,
 * the trade has stopped being worth it — reach for Zod at that point rather
 * than extending this.
 */

/** Returns null when valid, or an array of human-readable problems. */
export function check (value, spec) {
  const problems = []

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return ['body must be a JSON object']
  }

  for (const [field, rule] of Object.entries(spec)) {
    const present = Object.hasOwn(value, field)

    if (!present) {
      if (rule.required) problems.push(`${field} is required`)
      continue
    }

    const actual = value[field]

    if (rule.type === 'string') {
      if (typeof actual !== 'string') {
        problems.push(`${field} must be a string`)
        continue
      }
      if (rule.min !== undefined && actual.length < rule.min) {
        problems.push(`${field} must be at least ${rule.min} characters`)
      }
      if (rule.max !== undefined && actual.length > rule.max) {
        problems.push(`${field} must be at most ${rule.max} characters`)
      }
      if (rule.pattern && !rule.pattern.test(actual)) {
        problems.push(`${field} has an unexpected format`)
      }
    } else if (rule.type === 'object') {
      if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
        problems.push(`${field} must be an object`)
      }
    } else {
      throw new Error(`check: unsupported rule type "${rule.type}" for ${field}`)
    }
  }

  // Unknown fields are rejected rather than stripped. A client sending a field
  // we do not understand has a bug, and silently dropping it hides that bug on
  // both sides.
  for (const field of Object.keys(value)) {
    if (!Object.hasOwn(spec, field)) problems.push(`${field} is not a known field`)
  }

  return problems.length > 0 ? problems : null
}

/**
 * Reads and validates a JSON body.
 *
 * @returns {Promise<{ok: true, value: object} | {ok: false, problems: string[]}>}
 */
export async function readJsonBody (context, spec) {
  let parsed
  try {
    parsed = await context.req.json()
  } catch {
    return { ok: false, problems: ['body must be valid JSON'] }
  }

  const problems = check(parsed, spec)
  if (problems) return { ok: false, problems }
  return { ok: true, value: parsed }
}
