#!/usr/bin/env node
/**
 * What has Hyperion.NG done that we have not.
 *
 * AmbiFlux's roadmap is Hyperion's feature set, so upstream keeps moving while
 * we port. This turns "check their repository sometimes" into something that
 * actually happens: it reads every commit since the one we last triaged, sorts
 * them into the areas we care about, and prints a digest.
 *
 * Deliberately git, not the GitHub API. Git needs no token, has no rate limit
 * worth thinking about, and - the reason that decides it - `git log --name-only`
 * gives the changed PATHS, which is the whole basis of the triage. A digest that
 * only had commit subjects would need someone to open every one of them.
 *
 * It does not judge. Classifying by path is mechanical and reliable; deciding
 * whether a change is worth porting is not, and a script that guessed would
 * produce a list nobody trusts. The decisions go in docs/hyperion-watch.md by
 * hand, and this only ever says what changed and where.
 *
 *   node scripts/hyperion-watch.mjs            digest since the recorded commit
 *   node scripts/hyperion-watch.mjs --mark     record upstream HEAD as triaged
 *   node scripts/hyperion-watch.mjs --json     machine-readable, for CI
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STATE = join(ROOT, 'docs', 'hyperion-watch.json')
const UPSTREAM = 'https://github.com/hyperion-project/hyperion.ng'
const BRANCH = 'master'

/**
 * Where a checkout of upstream is kept. Under the system temp directory rather
 * than in the repository, because it is a cache: deleting it costs one clone
 * and never costs a decision - those live in the JSON and the markdown.
 */
const CHECKOUT = process.env.HYPERION_CHECKOUT ?? join(
  process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? '/tmp',
  'hyperion-watch-checkout'
)

/**
 * Path prefix -> the part of AmbiFlux it bears on.
 *
 * Ordered: the first match wins, so the specific entries precede the general
 * ones. `ours` names the file that would change here, and is the point of the
 * whole table - a digest that said "libsrc/leddevice changed" would still leave
 * someone to work out whether we even have a serial writer.
 */
const AREAS = [
  { prefix: 'libsrc/leddevice/dev_serial', area: 'Seri LED cihazları', ours: 'lib/engine/protocol.ts, lib/engine/encode.ts, lib/engine/sink.ts' },
  { prefix: 'libsrc/leddevice/dev_net', area: 'Ağ LED cihazları', ours: 'lib/engine/net.ts, lib/engine/wled.ts (WebSocket; UDP tarayıcıda yok)' },
  { prefix: 'libsrc/leddevice/dev_hid', area: 'HID LED cihazları', ours: 'yok — eklentiyle mümkün (navigator.hid)' },
  { prefix: 'libsrc/leddevice/dev_spi', area: 'SPI LED cihazları', ours: 'yok — tarayıcıda imkânsız' },
  { prefix: 'libsrc/leddevice', area: 'LED cihaz altyapısı', ours: 'lib/engine/sink.ts, lib/engine/runtime.ts' },
  { prefix: 'libsrc/hyperion/LinearColorSmoothing', area: 'Yumuşatma', ours: 'lib/engine/smooth.ts' },
  { prefix: 'libsrc/hyperion/ImageToLedsMap', area: 'Bölge örnekleme', ours: 'lib/engine/sample.ts' },
  { prefix: 'libsrc/hyperion/MultiColorAdjustment', area: 'Renk düzeltme', ours: 'lib/engine/adjust.ts' },
  { prefix: 'libsrc/hyperion/LedString', area: 'Yerleşim', ours: 'lib/engine/layout.ts' },
  { prefix: 'libsrc/hyperion/PriorityMuxer', area: 'Öncelik katmanları', ours: 'lib/engine/priority.ts' },
  { prefix: 'libsrc/blackborder', area: 'Siyah kenar algılama', ours: 'lib/engine/border.ts' },
  { prefix: 'libsrc/utils/ColorRgb', area: 'Renk matematiği', ours: 'lib/light.ts' },
  { prefix: 'libsrc/utils/RgbTransform', area: 'Renk dönüşümü', ours: 'lib/engine/adjust.ts' },
  { prefix: 'libsrc/grabber', area: 'Yakalama', ours: 'lib/engine/source.ts, lib/engine/open-source.ts, lib/engine/decode.ts' },
  { prefix: 'libsrc/effectengine', area: 'Efektler', ours: 'lib/engine/effects.ts' },
  { prefix: 'effects', area: 'Efekt tanımları', ours: 'lib/engine/effects.ts' },
  { prefix: 'libsrc/api', area: 'API', ours: 'lib/extension/messages.ts' },
  { prefix: 'libsrc/events', area: 'Olaylar', ours: 'lib/engine/schedule.ts' },
  { prefix: 'assets/webconfig', area: 'Web arayüzü', ours: 'components/' },
  { prefix: 'include/hyperion', area: 'Çekirdek başlıklar', ours: 'lib/engine/' },
  { prefix: 'include', area: 'Başlıklar', ours: 'lib/engine/' },
  { prefix: 'config', area: 'Yapılandırma şeması', ours: 'lib/engine/config.ts' },
  { prefix: 'src/hyperiond', area: 'Servis', ours: 'extension/src/sw.ts' }
]

/**
 * Paths whose changes are real for Hyperion and meaningless for us: their build
 * system, their packaging, their CI. Filtered out rather than shown under a
 * catch-all heading, because a digest padded with CMake churn is one that stops
 * being read - which is the only way this tool actually fails.
 */
const IGNORED = [
  'cmake/', 'CMakeLists.txt', '.github/', 'test/', 'debian/', 'deploy/',
  'dependencies/', 'doc/', 'docs/', '.gitmodules', '.version', 'resources/',
  // Their translation files, deliberately. We do not share Hyperion's string
  // set - lib/i18n is our own - so their POEditor churn tells us nothing, and
  // it is the single largest source of commits in the repository. Left in, it
  // made "Çeviriler" the biggest heading in every digest and filed real feature
  // work under it, because a large commit touches the strings too.
  'assets/webconfig/i18n'
]

/** Separator between commits in the log output: a byte no commit message has. */
const RECORD = String.fromCharCode(1)
const FIELD = String.fromCharCode(0)

function git (args, cwd = CHECKOUT) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()
}

/**
 * A blobless clone, not a shallow one. Shallow is faster but has no history, so
 * the moment the recorded commit is older than the depth the range would fail -
 * and it would fail later, silently, on a machine nobody is watching.
 * `--filter=blob:none` keeps every commit and fetches no file contents, which is
 * exactly what `--name-only` needs.
 */
function sync () {
  if (!existsSync(join(CHECKOUT, '.git'))) {
    mkdirSync(dirname(CHECKOUT), { recursive: true })
    execFileSync('git', [
      'clone', '--filter=blob:none', '--no-checkout', '--single-branch',
      '--branch', BRANCH, UPSTREAM, CHECKOUT
    ], { stdio: 'inherit' })
  } else {
    git(['fetch', '--filter=blob:none', 'origin', BRANCH])
  }
  return git(['rev-parse', `origin/${BRANCH}`])
}

function classify (path) {
  if (IGNORED.some((prefix) => path.startsWith(prefix))) return null
  return AREAS.find((entry) => path.startsWith(entry.prefix)) ?? null
}

/**
 * Commits since the marker, each with the areas it touches. A commit whose every
 * path is ignored is dropped entirely - not listed as "other", which would put
 * the noise straight back.
 */
function collect (from, to) {
  const raw = git([
    'log', '--no-merges', '--name-only',
    `--format=${RECORD}%H%x00%aI%x00%an%x00%s`, `${from}..${to}`
  ])
  const commits = []
  for (const chunk of raw.split(RECORD)) {
    if (chunk.trim() === '') continue
    const [header, ...rest] = chunk.split('\n')
    const [sha, date, author, subject] = header.split(FIELD)
    const paths = rest.filter((line) => line.trim() !== '')
    const areas = new Map()
    for (const path of paths) {
      const hit = classify(path)
      if (hit !== null) areas.set(hit.area, hit)
    }
    if (areas.size === 0) continue
    commits.push({ sha, date, author, subject, areas: [...areas.values()], paths })
  }
  return commits
}

function digest (state, head, commits) {
  const lines = []
  lines.push(`# Hyperion.NG takibi — ${commits.length} ilgili commit`)
  lines.push('')
  lines.push(`Son incelenen: [\`${state.reviewed.slice(0, 10)}\`](${UPSTREAM}/commit/${state.reviewed}) (${state.reviewedAt})`)
  lines.push(`Şu anki \`${BRANCH}\`: [\`${head.slice(0, 10)}\`](${UPSTREAM}/commit/${head})`)
  lines.push('')

  if (commits.length === 0) {
    lines.push('Bizi ilgilendiren bir değişiklik yok. Yalnız derleme, paketleme ve')
    lines.push('CI dosyaları değiştiyse burası boş kalır — bu doğru davranış.')
    return lines.join('\n')
  }

  // Grouped by area rather than chronologically: the question this answers is
  // "does any of this touch our smoothing", not "what happened on Tuesday".
  const byArea = new Map()
  for (const commit of commits) {
    for (const area of commit.areas) {
      if (!byArea.has(area.area)) byArea.set(area.area, { ours: area.ours, commits: [] })
      byArea.get(area.area).commits.push(commit)
    }
  }
  // Ordered by how much the area matters to us - the order AREAS is written in -
  // not by commit count. Counting would put whichever part of Hyperion happens
  // to be churning at the top, which is not the same question as "what should
  // we look at first".
  const rank = new Map(AREAS.map((entry, at) => [entry.area, at]))
  const ordered = [...byArea.entries()].sort((a, b) => (rank.get(a[0]) ?? 99) - (rank.get(b[0]) ?? 99))

  for (const [area, group] of ordered) {
    lines.push(`## ${area} — ${group.commits.length}`)
    lines.push('')
    lines.push(`Bizdeki karşılığı: \`${group.ours}\``)
    lines.push('')
    for (const commit of group.commits) {
      lines.push(`- [\`${commit.sha.slice(0, 10)}\`](${UPSTREAM}/commit/${commit.sha}) ${commit.subject} — ${commit.date.slice(0, 10)}, ${commit.author}`)
    }
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push("Her maddeyi `docs/hyperion-watch.md`'de karara bağla, sonra")
  lines.push('`node scripts/hyperion-watch.mjs --mark` ile işareti ilerlet.')
  return lines.join('\n')
}

const args = new Set(process.argv.slice(2))
const state = JSON.parse(readFileSync(STATE, 'utf8'))
const head = sync()
const commits = collect(state.reviewed, head)

if (args.has('--mark')) {
  const next = { ...state, reviewed: head, reviewedAt: new Date().toISOString().slice(0, 10) }
  writeFileSync(STATE, `${JSON.stringify(next, null, 2)}\n`)
  console.log(`İşaret ${head.slice(0, 10)} olarak güncellendi (${commits.length} commit incelenmiş sayıldı).`)
} else if (args.has('--json')) {
  console.log(JSON.stringify({ reviewed: state.reviewed, head, count: commits.length, commits }, null, 2))
} else {
  console.log(digest(state, head, commits))
}
