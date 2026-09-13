import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_LOCALE,
  FALLBACK_LOCALE,
  isLocale,
  LOCALES,
  negotiateLocale
} from '#lib/i18n/locales'
import { completeness, has, translate } from '#lib/i18n/strings'
import { DEFAULT_THEME, isTheme, resolveTheme, THEMES } from '#lib/theme'

test('the locale list has no duplicates and both special locales are in it', () => {
  const codes = LOCALES.map((entry) => entry.code)
  assert.equal(new Set(codes).size, codes.length)
  assert.ok(codes.includes(DEFAULT_LOCALE))
  assert.ok(codes.includes(FALLBACK_LOCALE))
})

test('every locale is named in its own language, not only in English', () => {
  // A list that says "German" is no use to someone who only reads Deutsch, so
  // the native name has to be present and it has to be a real second string.
  for (const entry of LOCALES) {
    assert.notEqual(entry.name, '')
    if (entry.code !== 'en') assert.notEqual(entry.name, entry.english)
  }
})

test('negotiation prefers an exact tag, then the language, then the default', () => {
  assert.equal(negotiateLocale(['tr-TR', 'en']), 'tr')
  assert.equal(negotiateLocale(['zh-CN']), 'zh-CN')
  // A regional German has no table of its own and must not fall to English.
  assert.equal(negotiateLocale(['de-AT', 'en-GB']), 'de')
  // The first SUPPORTED preference wins, not the first preference.
  assert.equal(negotiateLocale(['ko', 'fr']), 'fr')
  assert.equal(negotiateLocale(['ko', 'sw']), DEFAULT_LOCALE)
  assert.equal(negotiateLocale([]), DEFAULT_LOCALE)
})

test('isLocale rejects anything not in the list', () => {
  assert.ok(isLocale('tr'))
  assert.ok(!isLocale('tr-TR'))
  assert.ok(!isLocale(''))
  assert.ok(!isLocale('klingon'))
})

test('Turkish and English are complete', () => {
  // The point of the flat table: a language claiming to be the default or the
  // fallback while missing keys is a bug the tests must see, not a UI surprise.
  assert.equal(completeness('tr'), 100)
  assert.equal(completeness('en'), 100)
})

test('an untranslated key falls back to English rather than showing its name', () => {
  // The core set stops short of the long explanatory prose, so every partial
  // language must read that in English - never as "layout.cornersHelp".
  for (const entry of LOCALES) {
    if (entry.code === 'tr' || entry.code === 'en') continue
    assert.ok(!has(entry.code, 'layout.cornersHelp'), entry.code)
    const text = translate(entry.code, 'layout.cornersHelp')
    assert.equal(text, translate('en', 'layout.cornersHelp'), entry.code)
    assert.ok(!text.includes('layout.'), `${entry.code} leaked a key name`)
  }
})

test('every listed language has the whole core set, not a different half each', () => {
  // The point of one shared core: a user who picks any language in the list can
  // operate the panel. A language missing a button label would break that
  // silently, so the set is asserted rather than assumed.
  const core = [
    'app.tagline', 'app.lighting', 'app.language', 'app.theme',
    'theme.system', 'theme.light', 'theme.dark',
    'colour.title', 'colour.pick', 'colour.brightness',
    'preview.title', 'layout.title', 'layout.showScreen', 'layout.releaseScreen',
    'layout.top', 'layout.right', 'layout.bottom', 'layout.left',
    'layout.apply', 'layout.applying', 'layout.reset', 'layout.leds',
    'profiles.title', 'profiles.save', 'profiles.load', 'profiles.delete',
    'device.title', 'device.state.running', 'device.retry', 'device.stop',
    'guide.title'
  ] as const
  for (const entry of LOCALES) {
    for (const key of core) {
      assert.ok(has(entry.code, key), `${entry.code} has no own string for ${key}`)
    }
  }
})

test('a placeholder survives translation in every language', () => {
  // A translator who drops {count} produces a sentence that silently loses the
  // number, which no type can catch - so the interpolation is checked instead.
  for (const entry of LOCALES) {
    assert.match(translate(entry.code, 'layout.leds', { count: 108 }), /108/, entry.code)
  }
})

test('a translated key uses the translation', () => {
  assert.equal(translate('tr', 'layout.apply'), 'Uygula')
  assert.equal(translate('de', 'layout.apply'), 'Übernehmen')
})

test('interpolation fills named holes and leaves unknown ones alone', () => {
  assert.equal(translate('en', 'layout.leds', { count: 108 }), '108 LEDs')
  assert.equal(translate('tr', 'layout.leds', { count: 108 }), '108 LED')
  // A missing value must not render "undefined" into the sentence.
  assert.equal(translate('en', 'layout.leds', {}), '{count} LEDs')
})

test('every locale that has any strings at all has them from the English key set', () => {
  // `completeness` divides by the English total, so a stray key in one language
  // would push it past 100 - which is the cheapest way to catch a typo'd key.
  for (const entry of LOCALES) {
    const done = completeness(entry.code)
    assert.ok(done >= 0 && done <= 100, `${entry.code} is ${done}% done`)
  }
})

test('a theme resolves with the system preference only when it says system', () => {
  assert.equal(resolveTheme('system', true), 'dark')
  assert.equal(resolveTheme('system', false), 'light')
  // The whole point of keeping three states: an explicit choice ignores the OS.
  assert.equal(resolveTheme('light', true), 'light')
  assert.equal(resolveTheme('dark', false), 'dark')
})

test('the default theme follows the system and isTheme guards the stored value', () => {
  assert.equal(DEFAULT_THEME, 'system')
  for (const theme of THEMES) assert.ok(isTheme(theme))
  assert.ok(!isTheme('Dark'))
  assert.ok(!isTheme(null))
  assert.ok(!isTheme(undefined))
})
