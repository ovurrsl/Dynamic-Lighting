import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * The popup's strings live in extension/_locales/<lang>/messages.json and reach
 * the page through chrome.i18n, which is silent about every mistake: a key one
 * language lacks renders as an empty string, a placeholder one language spells
 * differently renders literally, and a manifest __MSG_ reference to nothing
 * refuses to load - on the user's machine, not here. So the checks the platform
 * does not do are done here, against the same files the build copies.
 */

const root = new URL('../extension/', import.meta.url)

interface Entry { message: string, placeholders?: Record<string, { content: string }> }

function locale (lang: string): Record<string, Entry> {
  return JSON.parse(readFileSync(new URL(`_locales/${lang}/messages.json`, root), 'utf8'))
}

const languages = readdirSync(new URL('_locales', root)).sort()
const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'))
const tables = Object.fromEntries(languages.map((lang) => [lang, locale(lang)]))
const reference = tables[manifest.default_locale as string]

test('the default locale exists and is the fallback every other language is measured against', () => {
  assert.ok(languages.includes(manifest.default_locale), `default_locale ${manifest.default_locale} has no directory`)
  assert.ok(reference !== undefined)
})

test('every language carries every key, with the same placeholders', () => {
  const keys = Object.keys(reference!).sort()
  for (const lang of languages) {
    assert.deepEqual(Object.keys(tables[lang]!).sort(), keys, `${lang} keys differ from ${manifest.default_locale}`)
    for (const key of keys) {
      const want = Object.keys(reference![key]!.placeholders ?? {}).sort()
      const got = Object.keys(tables[lang]![key]!.placeholders ?? {}).sort()
      assert.deepEqual(got, want, `${lang}.${key} placeholders`)
      // Every declared placeholder is used in the message, and the message
      // uses nothing that is not declared.
      const used = [...tables[lang]![key]!.message.matchAll(/\$([A-Z_]+)\$/g)].map((m) => (m[1] as string).toLowerCase()).sort()
      assert.deepEqual(used, want, `${lang}.${key} uses placeholders it does not declare, or declares ones it does not use`)
      assert.notEqual(tables[lang]![key]!.message.trim(), '', `${lang}.${key} is empty`)
    }
  }
})

test('the manifest only references messages that exist', () => {
  const text = JSON.stringify(manifest)
  for (const [, key] of text.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) {
    assert.ok(reference![key as string] !== undefined, `manifest references __MSG_${key}__ which no language defines`)
  }
  // The name and description are what the Web Store and chrome://extensions
  // show, in the user's language; hardcoding either would undo the point.
  assert.match(manifest.name, /^__MSG_/)
  assert.match(manifest.description, /^__MSG_/)
})

test('every key the popup asks for exists', () => {
  const html = readFileSync(new URL('src/popup.html', root), 'utf8')
  const ts = readFileSync(new URL('src/popup.ts', root), 'utf8')
  const asked = new Set<string>()
  for (const [, key] of html.matchAll(/data-msg="([^"]+)"/g)) asked.add(key as string)
  for (const [, key] of ts.matchAll(/msg\('([^']+)'/g)) asked.add(key as string)
  assert.ok(asked.size >= 10, 'the popup should read its strings through msg()')
  for (const key of asked) assert.ok(reference![key] !== undefined, `popup asks for ${key}, which no language defines`)
})
