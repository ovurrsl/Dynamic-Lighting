/**
 * The application version, reported by /v1/version.
 *
 * Deliberately not `import pkg from '../package.json'`. Node ESM requires import
 * attributes for JSON while bundlers disagree on them, so that import resolves in
 * one environment and fails in the other. Duplicating one string is the smaller
 * problem, and version.test.ts fails the build if this ever drifts from
 * package.json - so the duplication cannot silently become wrong.
 */
export const APP_VERSION = '0.1.0'
