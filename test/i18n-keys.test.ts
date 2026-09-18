import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { ENGINE_TEXT_KEYS } from '#lib/i18n/engine-text'
import { MESSAGE_KEYS } from '#lib/i18n/strings'

/**
 * The message table against the code that reads it.
 *
 * Two mistakes the type system cannot see. A key referenced from a template
 * literal - `t(\`effects.kind.${kind}\`)` - is a string to TypeScript, so a
 * renamed or deleted entry is only found when that branch renders. And a key
 * that nothing references at all is dead weight in twelve languages, and the
 * cheapest kind of drift: the audit that wrote this found eight.
 *
 * The scan is textual on purpose. Importing every component under Node would
 * need a DOM; reading the files needs nothing, and a false positive here is a
 * one-line allowance below, not a silent miss.
 */

const ROOT = join(import.meta.dirname, '..')
const SOURCE_DIRS = ['components', 'app', 'lib', 'extension/src']

function sources (): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.tsx?$/.test(entry.name) && !path.endsWith(join('lib', 'i18n', 'strings.ts'))) out.push(path)
    }
  }
  for (const dir of SOURCE_DIRS) walk(join(ROOT, dir))
  return out
}

/** Quoted strings that look like a message key: `a.b`, `a.b.c-d`. */
const LITERAL = /'([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9-]+)+)'/g
/** A key built at runtime: `prefix.${...}` in a template, or a `'prefix.'` string. */
const TEMPLATE_PREFIX = /`([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)*\.)\$\{/g
const STRING_PREFIX = /'([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)*\.)'/g

/**
 * Dotted literals that are not message keys: the two storage names and the
 * offscreen document's file name. Prefixes, and deliberately narrow ones - a
 * broad `layout.` allowance would hide a typo'd `layout.aply`.
 */
const NOT_KEYS = ['ambiflux.', 'offscreen.html']
/** The configuration parser names fields as `layout.gap.length` in its errors; those are paths, not keys. */
const EXEMPT_FILES = [join('lib', 'engine', 'config.ts')]

test('every dotted literal in the code that looks like a message key is one', () => {
  const known = new Set<string>(MESSAGE_KEYS)
  const unknown: string[] = []
  for (const file of sources()) {
    const text = readFileSync(file, 'utf8')
    if (EXEMPT_FILES.some((exempt) => file.endsWith(exempt))) continue
    for (const match of text.matchAll(LITERAL)) {
      const key = match[1] as string
      if (known.has(key)) continue
      if (NOT_KEYS.some((prefix) => key.startsWith(prefix))) continue
      unknown.push(`${file.slice(ROOT.length + 1)}: ${key}`)
    }
  }
  assert.deepEqual(unknown, [])
})

test('every English key is read somewhere: by name, by a runtime prefix, or by the engine-text rules', () => {
  const referenced = new Set<string>(ENGINE_TEXT_KEYS)
  const prefixes = new Set<string>()
  for (const file of sources()) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(LITERAL)) referenced.add(match[1] as string)
    for (const match of text.matchAll(TEMPLATE_PREFIX)) prefixes.add(match[1] as string)
    for (const match of text.matchAll(STRING_PREFIX)) prefixes.add(match[1] as string)
  }
  const orphans = MESSAGE_KEYS.filter((key) =>
    !referenced.has(key) && ![...prefixes].some((prefix) => key.startsWith(prefix)))
  assert.deepEqual(orphans, [])
})
