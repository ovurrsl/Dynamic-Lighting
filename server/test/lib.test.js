import assert from 'node:assert/strict'
import test from 'node:test'

import { createLogger } from '../src/lib/log.js'
import { createRateLimiter } from '../src/lib/ratelimit.js'
import { check } from '../src/lib/validate.js'

const SPEC = {
  licenceKey: { type: 'string', required: true, min: 8, max: 64, pattern: /^[A-Za-z0-9-]+$/ },
  appVersion: { type: 'string', max: 8 },
  payload: { type: 'object' }
}

test('the validator accepts a well-formed body', () => {
  assert.equal(check({ licenceKey: 'AF-OK-0001' }, SPEC), null)
  assert.equal(check({ licenceKey: 'AF-OK-0001', appVersion: '1.0.0' }, SPEC), null)
})

test('the validator reports every problem at once', () => {
  // One round-trip per mistake would be a poor client experience, so the
  // validator is expected to return the whole list.
  const problems = check({ licenceKey: 'no', appVersion: 'far-too-long', junk: 1 }, SPEC)
  assert.equal(problems.length, 3)
  assert.ok(problems.some((p) => p.includes('licenceKey')))
  assert.ok(problems.some((p) => p.includes('appVersion')))
  assert.ok(problems.some((p) => p.includes('junk')))
})

test('the validator rejects unknown fields rather than stripping them', () => {
  const problems = check({ licenceKey: 'AF-OK-0001', surprise: true }, SPEC)
  assert.deepEqual(problems, ['surprise is not a known field'])
})

test('the validator rejects non-objects and wrong types', () => {
  assert.deepEqual(check(null, SPEC), ['body must be a JSON object'])
  assert.deepEqual(check([], SPEC), ['body must be a JSON object'])
  assert.deepEqual(check('string', SPEC), ['body must be a JSON object'])
  assert.deepEqual(check({ licenceKey: 12345678 }, SPEC), ['licenceKey must be a string'])
  assert.deepEqual(check({ licenceKey: 'AF-OK-0001', payload: [] }, SPEC), ['payload must be an object'])
})

test('the validator treats a missing optional field as fine but a missing required one as not', () => {
  assert.equal(check({ licenceKey: 'AF-OK-0001' }, SPEC), null)
  assert.deepEqual(check({}, SPEC), ['licenceKey is required'])
})

test('the validator fails loudly on a spec it does not understand', () => {
  // Better to break a test than to silently accept unvalidated input because a
  // rule type was mistyped.
  assert.throws(() => check({ x: 1 }, { x: { type: 'number' } }), /unsupported rule type/)
})

test('the rate limiter allows up to the maximum then refuses', () => {
  let now = 1000
  const limiter = createRateLimiter({ max: 3, windowMs: 60000, now: () => now })

  assert.deepEqual(
    [1, 2, 3].map(() => limiter.hit('a').allowed),
    [true, true, true]
  )

  const refused = limiter.hit('a')
  assert.equal(refused.allowed, false)
  assert.ok(refused.retryAfterSeconds > 0, 'a refused client needs to know when to come back')
})

test('rate limiting is per client', () => {
  let now = 1000
  const limiter = createRateLimiter({ max: 1, windowMs: 60000, now: () => now })

  assert.equal(limiter.hit('a').allowed, true)
  assert.equal(limiter.hit('a').allowed, false)
  assert.equal(limiter.hit('b').allowed, true, 'one noisy client must not lock out everyone else')
})

test('the window resets and stale entries are pruned', () => {
  let now = 1000
  const limiter = createRateLimiter({ max: 1, windowMs: 1000, now: () => now })

  limiter.hit('a')
  assert.equal(limiter.hit('a').allowed, false)

  now += 1001
  assert.equal(limiter.hit('a').allowed, true, 'the window must reset')

  // Without pruning, a burst of unique addresses would grow the map until the
  // process is recycled.
  for (let i = 0; i < 50; i += 1) limiter.hit(`client-${i}`)
  assert.ok(limiter.size > 1)
  now += 5000
  limiter.hit('trigger-prune')
  assert.equal(limiter.size, 1, 'stale windows should be dropped')
})

test('the logger emits one JSON line per record and honours the level', () => {
  const lines = []
  const log = createLogger({ level: 'warn', write: (line) => lines.push(line) })

  log.debug('not emitted')
  log.info('not emitted either')
  log.warn('a warning')
  log.error({ err: 'boom', path: '/v1/x' }, 'a failure')

  assert.equal(lines.length, 2)
  for (const line of lines) assert.ok(line.endsWith('\n'), 'each record must be its own line')

  const warning = JSON.parse(lines[0])
  assert.equal(warning.level, 'warn')
  assert.equal(warning.msg, 'a warning')
  assert.ok(!Number.isNaN(Date.parse(warning.time)))

  const failure = JSON.parse(lines[1])
  assert.equal(failure.err, 'boom')
  assert.equal(failure.path, '/v1/x')
  assert.equal(failure.msg, 'a failure')
})

test('a silent logger writes nothing', () => {
  const lines = []
  const log = createLogger({ level: 'silent', write: (line) => lines.push(line) })
  log.error('still nothing')
  assert.equal(lines.length, 0)
})
