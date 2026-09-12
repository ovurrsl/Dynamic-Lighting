import crypto from 'node:crypto'

/**
 * Mints the licence signing keypair.
 *
 * Run once, put the private key in the host's environment variables, and never
 * commit it. The public key is not a secret - it ships in the engine and is also
 * served from /v1/version so a client can fetch it instead of embedding it.
 *
 * Rotating this key invalidates every token in the field, so clients will
 * re-activate on their next refresh. That is survivable but not free: do it
 * deliberately, not as a fix for something else.
 *
 * Deliberately does not import lib/licence.ts. Keeping this as plain .mjs with
 * one inlined keygen call means it runs on any Node without type stripping and
 * cannot be broken by an unrelated change to the app's module graph. The
 * equivalence is covered by a test.
 */
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')

const privateDer = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
const publicDer = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')

console.log('Licence signing keypair (Ed25519)\n')
console.log('Set this in your host -> your app -> environment variables.')
console.log('  Hostinger: hPanel -> your app -> environment variables')
console.log('  Vercel:    Project -> Settings -> Environment Variables')
console.log('Keep it secret. Anyone holding it can mint valid licences.')
console.log('Do NOT prefix it with NEXT_PUBLIC_ - that would inline it into the browser bundle.\n')
console.log(`LICENCE_SIGNING_KEY=${privateDer}\n`)
console.log('Public key, for embedding in the engine (safe to publish):\n')
console.log(`${publicDer}\n`)
