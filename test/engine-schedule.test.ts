import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MINUTES_IN_DAY,
  createScheduler,
  formatMinute,
  momentFrom,
  parseMinute,
  parseRules,
  rulesFor,
  type Moment,
  type ScheduleRule
} from '#lib/engine/schedule'

const rule = (over: Partial<ScheduleRule> = {}): ScheduleRule => ({
  id: 'r',
  enabled: true,
  atMinute: 22 * 60,
  days: [],
  action: { kind: 'stop' },
  ...over
})

/** A moment builder: minutes are the unit a rule is written in. */
const at = (minute: number, atMs = minute * 60_000, weekday = 1): Moment => ({ minute, weekday, atMs })

test('the first tick fires nothing, because it only establishes where we are', () => {
  // Opening the panel at 22:01 must not re-apply the 22:00 rule.
  const scheduler = createScheduler([rule({ atMinute: 22 * 60 })])
  assert.deepEqual(scheduler.tick(at(22 * 60 + 1)), [])
})

test('a rule fires as the clock crosses it, exactly once', () => {
  const scheduler = createScheduler([rule({ atMinute: 600, action: { kind: 'capture' } })])
  scheduler.tick(at(599))
  assert.deepEqual(scheduler.tick(at(600)), [{ kind: 'capture' }])
  // Matching rather than crossing would re-apply this every second for a
  // minute, which on a strip is an effect restarting sixty times.
  assert.deepEqual(scheduler.tick(at(600, 600 * 60_000 + 1000)), [])
  assert.deepEqual(scheduler.tick(at(601)), [])
})

test('a rule is missed by nobody: a tick that skips over it still fires it', () => {
  // The tick runs once a second at best and a browser throttles it; a rule
  // that only fired on an exact match would be lost the moment anything
  // stuttered.
  const scheduler = createScheduler([rule({ atMinute: 600 })])
  scheduler.tick(at(598))
  assert.equal(scheduler.tick(at(603, 603 * 60_000)).length, 1)
})

test('midnight is inside somebody’s evening', () => {
  const scheduler = createScheduler([rule({ atMinute: 0, action: { kind: 'stop' } })])
  scheduler.tick({ minute: 1439, weekday: 1, atMs: 1000 })
  assert.deepEqual(scheduler.tick({ minute: 0, weekday: 2, atMs: 61_000 }), [{ kind: 'stop' }])
})

test('a disabled rule and a wrong weekday both stay quiet', () => {
  const scheduler = createScheduler([
    rule({ id: 'off', atMinute: 600, enabled: false }),
    rule({ id: 'weekend', atMinute: 600, days: [0, 6], action: { kind: 'capture' } })
  ])
  scheduler.tick({ minute: 599, weekday: 3, atMs: 0 })
  assert.deepEqual(scheduler.tick({ minute: 600, weekday: 3, atMs: 60_000 }), [], 'Wednesday is not the weekend')

  const weekend = createScheduler([rule({ atMinute: 600, days: [0, 6], action: { kind: 'capture' } })])
  weekend.tick({ minute: 599, weekday: 6, atMs: 0 })
  assert.deepEqual(weekend.tick({ minute: 600, weekday: 6, atMs: 60_000 }), [{ kind: 'capture' }])
})

test('two rules in one tick run in the order they occur', () => {
  // A minute apart is two deliberate steps, and applying them backwards would
  // leave the strip on the earlier one.
  const scheduler = createScheduler([
    rule({ id: 'late', atMinute: 602, action: { kind: 'capture' } }),
    rule({ id: 'early', atMinute: 601, action: { kind: 'color', color: { r: 1, g: 2, b: 3 } } })
  ])
  scheduler.tick(at(600))
  assert.deepEqual(scheduler.tick(at(603)), [
    { kind: 'color', color: { r: 1, g: 2, b: 3 } },
    { kind: 'capture' }
  ])
})

test('a machine that slept through several rules gets only the last one', () => {
  // Waking at nine in the evening to a strip still in its eight-in-the-morning
  // state is wrong; replaying five hours of rules in half a second is sillier.
  const scheduler = createScheduler([
    rule({ id: 'morning', atMinute: 8 * 60, action: { kind: 'capture' } }),
    rule({ id: 'noon', atMinute: 12 * 60, action: { kind: 'color', color: { r: 0, g: 0, b: 0 } } }),
    rule({ id: 'evening', atMinute: 20 * 60, action: { kind: 'effect', spec: { kind: 'candle' } } })
  ])
  scheduler.tick({ minute: 7 * 60, weekday: 1, atMs: 0 })
  // Fourteen hours later, one tick.
  const fired = scheduler.tick({ minute: 21 * 60, weekday: 1, atMs: 14 * 3600_000 })
  assert.deepEqual(fired, [{ kind: 'effect', spec: { kind: 'candle' } }])
})

test('a merely slow tick is not a suspend', () => {
  // A throttled background tab fires at worst once a minute; mistaking that
  // for a suspend would silently drop rules a user set deliberately.
  const scheduler = createScheduler([
    rule({ id: 'a', atMinute: 600, action: { kind: 'capture' } }),
    rule({ id: 'b', atMinute: 601, action: { kind: 'stop' } })
  ], { gapMs: 10 * 60 * 1000 })
  scheduler.tick({ minute: 599, weekday: 1, atMs: 0 })
  const fired = scheduler.tick({ minute: 602, weekday: 1, atMs: 3 * 60_000 })
  assert.equal(fired.length, 2, 'both rules are still deliberate')
})

test('editing the rules does not replay the ones earlier today', () => {
  const scheduler = createScheduler([rule({ atMinute: 600 })])
  scheduler.tick(at(700))
  scheduler.setRules([rule({ id: 'new', atMinute: 601, action: { kind: 'capture' } })])
  assert.deepEqual(scheduler.tick(at(701)), [], 'a rule at 10:01 must not fire at 11:41')
})

test('the rule list handed back is a copy', () => {
  const scheduler = createScheduler([rule({ days: [1, 2] })])
  const copy = scheduler.rules()
  copy[0]!.days.push(6)
  copy[0]!.atMinute = 0
  assert.deepEqual(scheduler.rules()[0]?.days, [1, 2])
  assert.equal(scheduler.rules()[0]?.atMinute, 22 * 60)
})

// ---------------------------------------------------------------------------
// The wire, and the clock.
// ---------------------------------------------------------------------------

test('rules out of storage are validated, because storage is a trust boundary', () => {
  // These were written by some earlier version of the panel. A rule at minute
  // 9999 would simply never fire, with nothing saying why.
  const parsed = parseRules([
    { id: 'a', atMinute: 0, action: { kind: 'stop' } },
    { atMinute: 1439, days: [3, 3, 1], action: { kind: 'effect', spec: { kind: 'rainbow' } } }
  ])
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0]?.enabled, true, 'enabled defaults to on')
  assert.equal(parsed[1]?.id, 'rule-1', 'a missing id is filled in rather than refused')
  assert.deepEqual(parsed[1]?.days, [1, 3], 'sorted and deduplicated, so equal rules compare equal')

  assert.throws(() => parseRules([{ atMinute: 9999, action: { kind: 'stop' } }]), /0\.\.1439/)
  assert.throws(() => parseRules([{ atMinute: 10.5, action: { kind: 'stop' } }]), /0\.\.1439/)
  assert.throws(() => parseRules([{ atMinute: 0, action: { kind: 'dance' } }]), /kind must be one of/)
  assert.throws(() => parseRules([{ atMinute: 0, days: [9], action: { kind: 'stop' } }]), /0\.\.6/)
  assert.throws(() => parseRules([{ atMinute: 0, action: { kind: 'color', color: { r: 300, g: 0, b: 0 } } }]), /0\.\.255/)
  assert.throws(() => parseRules('every evening'), /must be an array/)
})

test('an effect action is validated by the effects module itself', () => {
  // One definition of "a valid effect", not two that can drift apart.
  assert.throws(() => parseRules([{ atMinute: 0, action: { kind: 'effect', spec: { kind: 'disco' } } }]), /kind must be one of/)
})

test('times round-trip through the text a user types', () => {
  assert.equal(formatMinute(0), '00:00')
  assert.equal(formatMinute(22 * 60 + 5), '22:05')
  assert.equal(formatMinute(MINUTES_IN_DAY - 1), '23:59')
  assert.equal(parseMinute('22:05'), 1325)
  assert.equal(parseMinute('7:30'), 450)
  assert.equal(parseMinute('  00:00  '), 0)
  assert.throws(() => parseMinute('24:00'), /not a time of day/)
  assert.throws(() => parseMinute('22:60'), /not a time of day/)
  assert.throws(() => parseMinute('sunset'), /not a time of day/)
})

test('the moment is read from a Date in LOCAL time, because a user thinks local', () => {
  const date = new Date(2026, 8, 14, 22, 5, 30)
  const moment = momentFrom(date, 1234)
  assert.equal(moment.minute, 22 * 60 + 5)
  assert.equal(moment.weekday, date.getDay())
  assert.equal(moment.atMs, 1234)
})

// ---------------------------------------------------------------------------
// Which strip.
// ---------------------------------------------------------------------------

test('a rule with no strip applies to all of them', () => {
  // The default, and it has to stay the default: every rule written before
  // there were strips means exactly what it meant then.
  const rules = parseRules([{ atMinute: 600, action: { kind: 'stop' } }])
  assert.equal(rules[0]?.instanceId, undefined)
  assert.equal(rulesFor(rules, 'instance-1').length, 1)
  assert.equal(rulesFor(rules, 'instance-2').length, 1)
})

test('a rule that names a strip reaches only that strip', () => {
  const rules = parseRules([
    { id: 'both', atMinute: 600, action: { kind: 'stop' } },
    { id: 'tv', atMinute: 1320, instanceId: 'instance-2', action: { kind: 'capture' } }
  ])
  assert.deepEqual(rulesFor(rules, 'instance-1').map((rule) => rule.id), ['both'])
  assert.deepEqual(rulesFor(rules, 'instance-2').map((rule) => rule.id), ['both', 'tv'])
  // A strip that no longer exists simply gets nothing extra; it is not an error
  // here, because the strip list can change without the rules being reopened.
  assert.deepEqual(rulesFor(rules, 'instance-9').map((rule) => rule.id), ['both'])
})

test('an empty or blank strip name is the same as naming none', () => {
  // Otherwise a rule could be addressed to a strip that can never exist, and it
  // would simply never fire with nothing saying why.
  assert.equal(parseRules([{ atMinute: 0, instanceId: '   ', action: { kind: 'stop' } }])[0]?.instanceId, undefined)
  assert.equal(parseRules([{ atMinute: 0, instanceId: '', action: { kind: 'stop' } }])[0]?.instanceId, undefined)
  assert.equal(parseRules([{ atMinute: 0, instanceId: ' tv ', action: { kind: 'stop' } }])[0]?.instanceId, 'tv')
})

test('the rules handed to one strip are copies', () => {
  const rules = parseRules([{ atMinute: 600, days: [1, 2], action: { kind: 'stop' } }])
  const mine = rulesFor(rules, 'instance-1')
  mine[0]!.days.push(6)
  assert.deepEqual(rules[0]?.days, [1, 2])
})

test('two rules with one id are told apart rather than refused', () => {
  // Written by an earlier panel whose id counter restarted on every reload.
  // Refusing the list would lose every rule in it to fix one; the second rule
  // gets a free id and both survive.
  const rules = parseRules([
    { id: 'new-0', atMinute: 60, action: { kind: 'stop' } },
    { id: 'new-0', atMinute: 120, action: { kind: 'stop' } },
    { id: 'rule-1', atMinute: 180, action: { kind: 'stop' } }
  ])
  assert.deepEqual(rules.map((rule) => rule.atMinute), [60, 120, 180])
  assert.equal(new Set(rules.map((rule) => rule.id)).size, 3, 'three distinct ids')
  assert.equal(rules[0]?.id, 'new-0', 'the first keeps its id')
  assert.equal(rules[2]?.id, 'rule-1', 'an id nobody else has is left alone')
})
