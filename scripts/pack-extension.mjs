import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs'

/**
 * Produces extension/ambiflux-extension.zip: the extension as something you can
 * hand to someone.
 *
 * This exists because `extension/dist` is a build output and therefore not in
 * the repository, which makes "load it unpacked" a step that silently fails for
 * anyone who cloned and did not build first - Chrome's error for pointing at
 * `extension/` instead is "Could not load background script", which names
 * neither cause nor cure.
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
