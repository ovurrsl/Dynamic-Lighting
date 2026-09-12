import type { KeyObject } from 'node:crypto'

import { APP_VERSION } from '#data/version'
import { getConfig, type AppConfig } from '#lib/config'
import {
  generateKeyPair,
  loadPrivateKey,
  loadPublicKey,
  publicKeyFromPrivate
} from '#lib/licence'
import { createStorage } from '#lib/storage/index'
import type { Storage } from '#lib/storage/types'

/**
 * The per-instance application context: config, storage and the signing keypair.
 *
 * This is what `fastify.decorate(...)` used to hold. It is built lazily on first
 * use and cached for the life of the instance, so a warm Hostinger process or a
 * warm Vercel function does the key parsing once rather than per request.
 *
 * The version comes from a module constant, not a filesystem read. The Fastify
 * version read package.json relative to the module URL, which works on a normal
 * host and breaks on a bundler that does not copy the file next to the output.
 */

export interface LicenceKeys {
  privateKey: KeyObject
  publicKey: KeyObject
  publicKeyBase64: string
  ephemeral: boolean
}

export interface AppContext {
  config: AppConfig
  storage: Storage
  licenceKeys: LicenceKeys
  appVersion: string
}

/**
 * Resolves the signing keypair.
 *
 * In development a missing key produces an ephemeral one with a loud warning
 * rather than a crash, so `npm run dev` works out of the box. Every token issued
 * before a restart becomes unverifiable after it, which is exactly the behaviour
 * you want from a throwaway key - it cannot be mistaken for a real one.
 *
 * config.ts makes this impossible in production.
 */
function resolveLicenceKeys (config: AppConfig): LicenceKeys {
  if (config.licence.signingKey) {
    const privateKey = loadPrivateKey(config.licence.signingKey)
    const publicKey = publicKeyFromPrivate(privateKey)
    return {
      privateKey,
      publicKey,
      publicKeyBase64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      ephemeral: false
    }
  }

  console.warn('LICENCE_SIGNING_KEY is not set - generating an ephemeral keypair. Tokens will stop verifying when this process restarts. Run `npm run keygen` for a persistent key.')
  const generated = generateKeyPair()
  return {
    privateKey: loadPrivateKey(generated.privateKey),
    publicKey: loadPublicKey(generated.publicKey),
    publicKeyBase64: generated.publicKey,
    ephemeral: true
  }
}

let context: AppContext | null = null

export function getContext (): AppContext {
  if (context) return context
  const config = getConfig()
  context = {
    config,
    storage: createStorage(config),
    licenceKeys: resolveLicenceKeys(config),
    appVersion: APP_VERSION
  }
  return context
}

/** Test seam: drops the cached context so a test can build a fresh one. */
export function resetContext (): void {
  context = null
}

/** Overrides the context, for tests that need a seeded in-memory storage. */
export function setContext (next: AppContext): void {
  context = next
}
