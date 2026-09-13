import assert from 'node:assert/strict'
import test from 'node:test'

import { LOCALES } from '#lib/i18n/locales'
import { has, translate } from '#lib/i18n/strings'
import {
  DEFAULT_SECTION,
  GROUP_TITLE,
  SECTIONS,
  SECTION_GROUPS,
  SECTION_IDS,
  findSection,
  hashForSection,
  isSectionId,
  sectionFromHash,
  sectionsInGroup
} from '#lib/sections'

test('every id in the union has exactly one entry, and every entry a known group', () => {
  assert.equal(SECTIONS.length, SECTION_IDS.length)
  const ids = SECTIONS.map((section) => section.id)
  assert.deepEqual([...ids].sort(), [...SECTION_IDS].sort())
  for (const section of SECTIONS) {
    assert.ok((SECTION_GROUPS as readonly string[]).includes(section.group), section.id)
  }
})

test('every section is reachable from a group, so none can be orphaned by a typo', () => {
  // The sidebar renders group by group. A section whose group is not in
  // SECTION_GROUPS would compile and then simply never appear - the exact bug
  // this asserts away.
  const reachable = SECTION_GROUPS.flatMap((group) => sectionsInGroup(group)).map((section) => section.id)
  assert.deepEqual([...reachable].sort(), [...SECTION_IDS].sort())
})

test('the hash round-trips, and anything else lands on the default', () => {
  for (const id of SECTION_IDS) {
    assert.equal(sectionFromHash(hashForSection(id)), id)
  }
  // A bare id, with and without the slash: a link someone typed by hand.
  assert.equal(sectionFromHash('#layout'), 'layout')
  assert.equal(sectionFromHash('#/layout'), 'layout')
  // Everything else is the default rather than a crash: the hash is user input.
  assert.equal(sectionFromHash(''), DEFAULT_SECTION)
  assert.equal(sectionFromHash('#'), DEFAULT_SECTION)
  assert.equal(sectionFromHash('#/nope'), DEFAULT_SECTION)
  assert.equal(sectionFromHash('#/../etc/passwd'), DEFAULT_SECTION)
})

test('isSectionId rejects anything not in the table', () => {
  assert.ok(isSectionId('overview'))
  assert.ok(!isSectionId('Overview'))
  assert.ok(!isSectionId(''))
  assert.ok(!isSectionId(null))
})

test('findSection throws rather than returning undefined', () => {
  assert.equal(findSection('device').id, 'device')
  // @ts-expect-error deliberately outside the union: the guard exists for the
  // day someone widens SectionId and forgets the table.
  assert.throws(() => findSection('nope'), /unknown section/)
})

test('every section and group label exists, in the default language and in English', () => {
  // A missing nav key renders the key's name in the sidebar - the most visible
  // possible place for it - so this is checked rather than trusted.
  for (const section of SECTIONS) {
    for (const key of [section.titleKey, section.descriptionKey]) {
      assert.ok(has('tr', key), `tr is missing ${key}`)
      assert.ok(has('en', key), `en is missing ${key}`)
      assert.ok(!translate('tr', key).startsWith('nav.'), key)
    }
  }
  for (const group of SECTION_GROUPS) {
    assert.ok(has('tr', GROUP_TITLE[group]), group)
    assert.ok(has('en', GROUP_TITLE[group]), group)
  }
})

test('every listed language names every section in the sidebar', () => {
  // The nav is chrome, not prose: a language that falls back to English here
  // shows a half-translated menu, which reads worse than no translation at all.
  for (const entry of LOCALES) {
    for (const section of SECTIONS) {
      assert.ok(has(entry.code, section.titleKey), `${entry.code} is missing ${section.titleKey}`)
    }
    for (const group of SECTION_GROUPS) {
      assert.ok(has(entry.code, GROUP_TITLE[group]), `${entry.code} is missing ${GROUP_TITLE[group]}`)
    }
  }
})

test('the default section is one of the sections, and is first in its group', () => {
  assert.ok(isSectionId(DEFAULT_SECTION))
  // Landing somewhere in the middle of the sidebar reads as a bug to a user.
  assert.equal(SECTIONS[0]?.id, DEFAULT_SECTION)
})

test('each section has a glyph, and no two share one', () => {
  const glyphs = SECTIONS.map((section) => section.glyph)
  assert.equal(new Set(glyphs).size, glyphs.length)
  for (const glyph of glyphs) assert.notEqual(glyph.trim(), '')
})
