import { build } from 'esbuild'
import { cpSync, mkdirSync, rmSync } from 'node:fs'

/**
 * Bundles the extension into extension/dist, the directory you load unpacked.
 *
 * esbuild rather than plain ES modules for two concrete reasons: MV3 service
 * workers loading bare modules need every import to carry a `.js` extension,
 * and the engine shares lib/light.ts and lib/engine/* with the panel through
 * package.json subpath imports (`#lib/...`), which a browser cannot resolve.
 * Bundling settles both and leaves one self-contained file per entry point.
 */
const outdir = 'extension/dist'
rmSync(outdir, { recursive: true, force: true })
mkdirSync(outdir, { recursive: true })

await build({
  entryPoints: ['extension/src/sw.ts', 'extension/src/offscreen.ts', 'extension/src/popup.ts'],
  outdir,
  bundle: true,
  format: 'esm',
  target: 'chrome116',
  platform: 'browser',
  sourcemap: true,
  minify: false,
  logLevel: 'info'
})

for (const file of ['manifest.json', 'src/offscreen.html', 'src/popup.html']) {
  cpSync(`extension/${file}`, `${outdir}/${file.replace('src/', '')}`)
}
// The popup's strings, one directory per language, read by chrome.i18n. The
// directory name is fixed by the platform; it must sit beside manifest.json.
cpSync('extension/_locales', `${outdir}/_locales`, { recursive: true })
