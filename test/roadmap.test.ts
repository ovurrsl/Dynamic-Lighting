import assert from 'node:assert/strict'
import test from 'node:test'

import { EFFECT_KINDS } from '#lib/engine/effects'
import { LOCALES } from '#lib/i18n/locales'
import { has, translate } from '#lib/i18n/strings'
import { ROADMAP_ITEMS, ROADMAP_STATE_KEY } from '#lib/roadmap'

test('every roadmap item has both its strings in Turkish and English, and a state the page renders', () => {
  for (const item of ROADMAP_ITEMS) {
    for (const locale of ['tr', 'en'] as const) {
      assert.ok(has(locale, item.title), `${locale} ${item.title}`)
      assert.ok(has(locale, item.body), `${locale} ${item.body}`)
    }
    assert.ok(item.state in ROADMAP_STATE_KEY, item.state)
  }
  // No item is listed twice under a different state.
  const titles = ROADMAP_ITEMS.map((item) => item.title)
  assert.equal(new Set(titles).size, titles.length)
})

test('the effect count on the page is the engine\'s own, in every language', () => {
  // The sentence said "seven" while twelve effects were shipping. Now the
  // number is interpolated, so a language that dropped the placeholder would
  // print a stale count again - checked in all of them, not only the two that
  // carry the string themselves.
  const item = ROADMAP_ITEMS.find((entry) => entry.title === 'roadmap.effects.title')
  assert.ok(item !== undefined)
  assert.deepEqual(item.values, { count: EFFECT_KINDS.length })
  for (const entry of LOCALES) {
    const text = translate(entry.code, item.body, item.values)
    assert.match(text, new RegExp(`\\b${EFFECT_KINDS.length}\\b`), entry.code)
    assert.ok(!text.includes('{count}'), entry.code)
  }
})

test('nothing on the roadmap is promised: every item is built or ruled out', () => {
  // 'next' and 'planned' were removed when the last item shipped. A state the
  // type allows but no item carries is fine; a state the page cannot label is
  // not.
  for (const item of ROADMAP_ITEMS) assert.ok(item.state === 'done' || item.state === 'never', item.title)
})
