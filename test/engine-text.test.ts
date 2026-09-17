import assert from 'node:assert/strict'
import test from 'node:test'

import { TEXT } from '#lib/engine/text'
import { ENGINE_TEXT_KEYS, localiseEngineText } from '#lib/i18n/engine-text'
import { has, translate, type MessageKey } from '#lib/i18n/strings'

/**
 * The engine speaks English; the panel says it in the chosen language.
 *
 * Every sentence in TEXT must have a rule, and every rule a Turkish and an
 * English string - otherwise a Turkish-first panel shows an English error,
 * which is the leak this replaced (Turkish literals in a Japanese panel).
 */

/** Every entry, with sample arguments for the builders. */
const SENTENCES: Array<[name: string, text: string]> = Object.entries(TEXT).map(([name, entry]) => {
  if (typeof entry === 'string') return [name, entry]
  const sample = (entry as (...args: never[]) => string)
  switch (name) {
    case 'tooManyStrips': return [name, (sample as (max: number, got?: number) => string)(8, 9)]
    case 'calibrationCornerRange': return [name, (sample as (max: number, got: string) => string)(107, '200')]
    case 'calibrationNotPartition': return [name, (sample as (runs: string, covered: number, total: number) => string)('35 + 19 + 35', 89, 108)]
    case 'calibrationFourCorners': return [name, (sample as (marked: number) => string)(3)]
    case 'stripNotObject': return [name, (sample as (index: number) => string)(2)]
    case 'profilesDropped': return [name, (sample as (count: number) => string)(2)]
    default: return [name, (sample as (arg: string) => string)('sample-value')]
  }
})

const tr = (key: MessageKey, values?: Record<string, string | number>): string => translate('tr', key, values)
const en = (key: MessageKey, values?: Record<string, string | number>): string => translate('en', key, values)

test('every engine sentence is recognised and said in Turkish', () => {
  for (const [name, text] of SENTENCES) {
    const said = localiseEngineText(text, tr)
    assert.notEqual(said, text, `${name} was not recognised: ${text}`)
    assert.doesNotMatch(said, /\{\w+\}/, `${name} left a placeholder unfilled: ${said}`)
    assert.doesNotMatch(said, /^engine\./, `${name} rendered its key`)
  }
})

test('the values a sentence carries survive the translation', () => {
  assert.match(localiseEngineText(TEXT.stripNotFound('nope'), tr), /nope/)
  assert.match(localiseEngineText(TEXT.tooManyStrips(8, 9), tr), /8.*9/)
  assert.match(localiseEngineText(TEXT.calibrationNotPartition('35 + 19', 54, 108), tr), /35 \+ 19.*54.*108/)
  assert.match(localiseEngineText(TEXT.mixedContent('wled'), tr), /^wled:/)
  assert.match(localiseEngineText(TEXT.noControlChannel('loopback'), tr), /^loopback:/)
})

test('in English the sentence reads the same as the engine said it', () => {
  // The English table is the engine's own wording, so nothing changes shape
  // for an English user - and a sentence the rule mangled would show here.
  for (const [name, text] of SENTENCES) {
    const said = localiseEngineText(text, en)
    assert.ok(said.length > 0 && !/\{\w+\}/.test(said), `${name}: ${said}`)
  }
  assert.equal(localiseEngineText(TEXT.noStripEnabled, en), TEXT.noStripEnabled)
  assert.equal(localiseEngineText(TEXT.stripNotFound('x'), en), TEXT.stripNotFound('x'))
})

test('a sentence that is not ours passes through untouched', () => {
  for (const foreign of ['NotReadableError: Could not start video source', 'The device is busy', '', 'refused']) {
    assert.equal(localiseEngineText(foreign, tr), foreign)
  }
})

test('every rule has an English and a Turkish string, and nothing else uses the engine prefix', () => {
  for (const key of ENGINE_TEXT_KEYS) {
    assert.ok(has('en', key), `${key} missing in en`)
    assert.ok(has('tr', key), `${key} missing in tr`)
  }
})

test('a reason inside a panel sentence is translated on the way through translate()', () => {
  // `t('capture.failed', { reason })` is how most cards show an engine error;
  // the reason goes through the same table without the card knowing.
  const said = translate('tr', 'capture.failed', { reason: TEXT.noStripEnabled })
  assert.match(said, /hiçbir şerit açık değil/)
  assert.doesNotMatch(said, /no strip is enabled/)
  // Only reason/problem/error: a name is what the user typed.
  const named = translate('tr', 'strips.leds', { count: 3 })
  assert.match(named, /3/)
})
