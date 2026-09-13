/**
 * The Chrome extension's identity, as the panel needs it.
 *
 * The ID is derived from the public key in extension/manifest.json, which is
 * why it is stable across unpacked installs on every machine. If the key ever
 * changes, this changes with it - regenerate both together.
 */
export const EXTENSION_ID = 'klgpcmbfjpkeodnfphjlbehkgdmomdlb'
