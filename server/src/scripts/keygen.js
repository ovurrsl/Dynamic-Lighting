import { generateKeyPair } from '../lib/licence.js'

/**
 * Mints the licence signing keypair.
 *
 * Run once, put the private key in Hostinger's environment variables, and never
 * commit it. The public key is not a secret — it ships in the engine and is
 * also served from /v1/version so a client can fetch it instead of embedding it.
 *
 * Rotating this key invalidates every token in the field, so clients will
 * re-activate on their next refresh. That is survivable but not free: do it
 * deliberately, not as a fix for something else.
 */
const { privateKey, publicKey } = generateKeyPair()

console.log('Licence signing keypair (Ed25519)\n')
console.log('Set this in Hostinger -> your app -> environment variables.')
console.log('Keep it secret. Anyone holding it can mint valid licences.\n')
console.log(`LICENCE_SIGNING_KEY=${privateKey}\n`)
console.log('Public key, for embedding in the engine (safe to publish):\n')
console.log(`${publicKey}\n`)
