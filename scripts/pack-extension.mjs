import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs'

/**
 * Produces extension/ambiflux-extension.zip: the extension as something you can
 * hand to someone.
 *
 * `extension/dist` IS committed (deliberately, so a clone loads unpacked
 * without a build), but a directory is not something you can hand to someone
 * or upload to a store: this is the one-file form, with the manifest and the
 * locales in the right places. Chrome's error for pointing it at `extension/`
 * instead is "Could not load background script", which names neither cause
 * nor cure.
 *
 * The zip carries no source maps: they are four times the size of the code,
 * they are useless without the sources, and a Web Store package should not
 * ship them.
 */
const dist = 'extension/dist'
const stage = 'extension/.pack'
const zip = 'ambiflux-extension.zip'

execFileSync('node', ['scripts/build-extension.mjs'], { stdio: 'inherit' })

rmSync(stage, { recursive: true, force: true })
mkdirSync(`${stage}/ambiflux-extension`, { recursive: true })
for (const file of ['manifest.json', 'offscreen.html', 'offscreen.js', 'popup.html', 'popup.js', 'sw.js']) {
  cpSync(`${dist}/${file}`, `${stage}/ambiflux-extension/${file}`)
}
cpSync(`${dist}/_locales`, `${stage}/ambiflux-extension/_locales`, { recursive: true })

rmSync(`extension/${zip}`, { force: true })
// Written straight to extension/, since `stage` lives inside it.
execFileSync('zip', ['-qr', `../${zip}`, 'ambiflux-extension'], { cwd: stage })
rmSync(stage, { recursive: true, force: true })

const version = JSON.parse(readFileSync('extension/manifest.json', 'utf8')).version
console.log(`\n  extension/${zip}  (AmbiFlux ${version})`)
console.log('  Aç, sonra chrome://extensions → Geliştirici modu → Paketlenmemiş öğe yükle → ambiflux-extension')
