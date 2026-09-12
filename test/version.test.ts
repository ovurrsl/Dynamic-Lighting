import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { APP_VERSION } from '#data/version'

/**
 * data/version.ts duplicates the version from package.json because a JSON import
 * is not portable between Node and the bundler. This test is what makes that
 * duplication safe: if the two drift, /v1/version would report a version that was
 * never released, and clients use that field to decide whether to update.
 */
test('the reported version matches package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(
    APP_VERSION,
    pkg.version,
    'data/version.ts and package.json disagree - update data/version.ts'
  )
})
