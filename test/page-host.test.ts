import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { TEXT } from '#lib/engine/text'
import { createPageEngine, pageHostAvailable } from '#lib/page-host'
import type { PoolStats } from '#lib/engine/pool'

/**
 * The page host with a fake document.
 *
 * Everything that is the engine is tested in engine-*.test.ts; what is tested
 * here is the little the page host owns - whether it says it can run, the
 * hidden video elements it adds, and that it takes them out again - because a
 * `<video>` left in the page keeps a capture alive after Stop, and that is a
 * leak nobody sees until the picker refuses a second screen.
 */

interface FakeVideo {
  tag: string
  style: string
  muted: boolean
  playsInline: boolean
  srcObject: unknown
  videoWidth: number
  videoHeight: number
  attached: boolean
  setAttribute: (name: string, value: string) => void
  play: () => Promise<void>
  pause: () => void
  remove: () => void
}

interface FakeCanvas {
  width: number
  height: number
  getContext: () => unknown
}

function fakeDocument (): { document: unknown, videos: FakeVideo[] } {
  const videos: FakeVideo[] = []
  const document = {
    body: { appendChild (node: FakeVideo) { node.attached = true } },
    createElement (tag: string): FakeVideo | FakeCanvas {
      // The host builds its analysis canvas here too, when OffscreenCanvas is
      // absent - which it is in Node.
      if (tag === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: () => ({
            drawImage () {},
            getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) })
          })
        }
      }
      const video: FakeVideo = {
        tag,
        style: '',
        muted: false,
        playsInline: false,
        srcObject: null,
        videoWidth: 0,
        videoHeight: 0,
        attached: false,
        setAttribute (name, value) { if (name === 'style') video.style = value },
        async play () {},
        pause () {},
        remove () { video.attached = false }
      }
      if (tag === 'video') videos.push(video)
      return video
    }
  }
  return { document, videos }
}

function withGlobals<T> (values: Record<string, unknown>, body: () => Promise<T>): Promise<T> {
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [name, value] of Object.entries(values)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  }
  return body().finally(() => {
    for (const [name, original] of originals) {
      if (original === undefined) delete (globalThis as Record<string, unknown>)[name]
      else Object.defineProperty(globalThis, name, original)
    }
  })
}

test('the page host is available exactly where the screen can be captured', () => {
  assert.equal(pageHostAvailable({ navigator: { mediaDevices: { getDisplayMedia () {} } } } as never), true)
  assert.equal(pageHostAvailable({ navigator: { mediaDevices: {} } } as never), false)
  assert.equal(pageHostAvailable({ navigator: {} } as never), false)
  assert.equal(pageHostAvailable({} as never), false)
  // Presence is read, never exercised: a getDisplayMedia that is not a function
  // is a table's claim, not a browser's.
  assert.equal(pageHostAvailable({ navigator: { mediaDevices: { getDisplayMedia: true } } } as never), false)
})

test('a browser with no media devices is told so in the engine\'s words, not with a TypeError', async () => {
  const { document } = fakeDocument()
  await withGlobals({ document, navigator: {} }, async () => {
    const reports: PoolStats[] = []
    const page = createPageEngine((stats) => { reports.push(stats) })
    try {
      await page.pool.start()
      const first = page.pool.stats().instances[0]
      assert.ok(first !== undefined)
      assert.equal(first.state, 'error')
      assert.equal(first.error, TEXT.noMediaDevices)
    } finally {
      page.dispose()
    }
  })
})

test('a stream gets a hidden 1x1 video in the page, and dispose takes it out again', async () => {
  const { document, videos } = fakeDocument()
  const track = { kind: 'video', getSettings: () => ({ width: 1280, height: 720 }), addEventListener () {}, stop () {} }
  const stream = { getVideoTracks: () => [track], getTracks: () => [track], getAudioTracks: () => [] }
  const navigator = { mediaDevices: { getDisplayMedia: async () => stream, getUserMedia: async () => stream } }
  await withGlobals({ document, navigator }, async () => {
    const page = createPageEngine(() => {})
    try {
      await page.pool.start()
      await delay(10)
      assert.equal(videos.length, 1, 'one video per open stream')
      const video = videos[0] as FakeVideo
      assert.ok(video.attached, 'in the document, not detached: a detached video may not play on iOS')
      assert.match(video.style, /width:1px/)
      assert.match(video.style, /opacity:0/)
      assert.ok(!video.style.includes('display:none'), 'a video that is not displayed may stop producing frames')
      assert.equal(video.muted, true)
      assert.equal(video.playsInline, true)
      assert.equal(video.srcObject, stream)
      const first = page.pool.stats().instances[0]
      assert.equal(first?.state, 'running')
    } finally {
      page.dispose()
    }
    await delay(10)
    assert.ok(videos.every((video) => !video.attached), 'dispose removed every video it added')
  })
})
