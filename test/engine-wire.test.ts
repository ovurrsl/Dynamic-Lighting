import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { FrameParser } from '#lib/engine/protocol'
import { DEFAULT_ENGINE_CONFIG } from '#lib/engine/config'
import { createEngine, type CanvasLike, type Engine, type EngineHost } from '#lib/engine/runtime'
import type { FrameSource } from '#lib/engine/source'

/**
 * The engine against a fake serial port: what is actually on the wire.
 *
 * The runtime tests read the muxer's decision; these read the BYTES, through
 * the same reference parser the firmware is written against. That is the only
 * place three things can be seen at all - which colour a frame carries, whether
 * the black frame on Stop really went out, and whether a relink left an error
 * behind - and each of them was a bug that the layer list could not show.
 *
 * `navigator.serial` is stood in for on `globalThis`, which Node lets us do
 * because its own `navigator` is a configurable getter. Every test restores it.
 */

function fakeCanvas (): CanvasLike {
  return {
    getContext: () => ({
      drawImage () {},
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) })
    })
  }
}

interface Wire {
  engine: Engine
  advance: (ms: number) => void
  frames: () => Uint8Array[]
  restore: () => void
}

function wire (writeMs = 0): Wire {
  const written: Uint8Array[] = []
  const port = {
    getInfo: () => ({ usbVendorId: 0x2341, usbProductId: 0x0070 }),
    async open (): Promise<void> {},
    async close (): Promise<void> {},
    addEventListener (): void {},
    writable: {
      getWriter: () => ({
        async write (bytes: Uint8Array): Promise<void> {
          if (writeMs > 0) await delay(writeMs)
          written.push(bytes.slice())
        },
        async close (): Promise<void> {},
        releaseLock (): void {}
      })
    }
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    value: { serial: { getPorts: async () => [port] } },
    configurable: true,
    writable: true
  })
  let at = 0
  const host: EngineHost = {
    clock: () => at,
    createCanvas: fakeCanvas,
    openSource: async (): Promise<FrameSource> => { throw new Error('no capture in this test') }
  }
  return {
    engine: createEngine(host),
    advance: (ms) => { at += ms },
    frames: () => written,
    restore: () => { if (original !== undefined) Object.defineProperty(globalThis, 'navigator', original) }
  }
}

/** The first LED of every frame the parser accepts, as the 16-bit linear triple it carries. */
function firstLeds (frames: readonly Uint8Array[]): Array<[number, number, number]> {
  const parser = new FrameParser()
  const out: Array<[number, number, number]> = []
  for (const bytes of frames) {
    for (const frame of parser.push(bytes)) {
      const p = frame.payload
      out.push([
        ((p[0] as number) << 8) | (p[1] as number),
        ((p[2] as number) << 8) | (p[3] as number),
        ((p[4] as number) << 8) | (p[5] as number)
      ])
    }
  }
  return out
}

/** Moves the engine's clock in output periods while the real timers get to fire. */
async function run (w: Wire, periods: number): Promise<void> {
  for (let i = 0; i < periods; i++) {
    w.advance(8)
    await delay(3)
  }
}

test('a colour reaches a paired port as frames the reference parser accepts', async () => {
  const w = wire()
  try {
    w.engine.setColor({ r: 255, g: 0, b: 0 })
    await run(w, 40)
    assert.equal(w.engine.link().mode, 'port')
    const leds = firstLeds(w.frames())
    assert.ok(leds.length > 0, 'frames went out')
    const last = leds[leds.length - 1] as [number, number, number]
    assert.ok(last[0] >= 65000 && last[1] === 0 && last[2] === 0, `full red on the wire, got ${String(last)}`)
  } finally {
    w.engine.stop()
    w.restore()
  }
})

test('a flash keeps its own buffer, so the base colour it interrupted comes back unchanged', async () => {
  // One buffer served both: the flash painted it blue, and when the flash
  // expired the base layer - still pointing at the same buffer - was blue too.
  const w = wire()
  try {
    w.engine.setColor({ r: 255, g: 0, b: 0 })
    await run(w, 40)
    w.engine.setColor({ r: 0, g: 0, b: 255 }, 200)
    await run(w, 100)
    const leds = firstLeds(w.frames())
    assert.ok(leds.some((l) => l[2] >= 60000 && l[0] < 5000), 'the flash showed blue')
    const last = leds[leds.length - 1] as [number, number, number]
    assert.ok(last[0] >= 65000 && last[2] < 500, `red came back, got ${String(last)}`)
  } finally {
    w.engine.stop()
    w.restore()
  }
})

test('the black frame on Stop is delivered even while a write is in flight', async () => {
  // The writer is latest-wins and drops while a send is in flight, which on a
  // Stop is exactly when the previous frame is still being written. The black
  // frame was the one dropped, and the strip held the last picture.
  const w = wire(25)
  try {
    w.engine.setColor({ r: 255, g: 255, b: 255 })
    await run(w, 20)
    w.engine.stop()
    await delay(90)
    const leds = firstLeds(w.frames())
    assert.ok(leds.length > 0)
    assert.deepEqual(leds[leds.length - 1], [0, 0, 0], 'the last frame on the wire is black')
  } finally {
    w.restore()
  }
})

test('a relink leaves the port open and no stale serial error behind', async () => {
  const w = wire()
  try {
    w.engine.setColor({ r: 1, g: 2, b: 3 })
    await run(w, 10)
    assert.equal(w.engine.link().mode, 'port')
    await w.engine.relink()
    await run(w, 10)
    assert.equal(w.engine.link().mode, 'port')
    assert.equal(w.engine.error(), undefined)
  } finally {
    w.engine.stop()
    w.restore()
  }
})

/** LED `n` of every frame the parser accepts, as the 16-bit linear triple it carries. */
function ledOf (frames: readonly Uint8Array[], n: number): Array<[number, number, number]> {
  const parser = new FrameParser()
  const out: Array<[number, number, number]> = []
  for (const bytes of frames) {
    for (const frame of parser.push(bytes)) {
      const p = frame.payload
      const at = n * 6
      out.push([
        ((p[at] as number) << 8) | (p[at + 1] as number),
        ((p[at + 2] as number) << 8) | (p[at + 3] as number),
        ((p[at + 4] as number) << 8) | (p[at + 5] as number)
      ])
    }
  }
  return out
}

const last = <T>(items: readonly T[]): T => items[items.length - 1] as T

test('the colour adjustment applies to a colour and an effect, not only to the capture', async () => {
  // It used to run inside processFrame, on captured frames alone: the
  // brightness ceiling and the white balance the user set had no effect on
  // "warm white" or on the rainbow, which is where they would have noticed.
  const w = wire()
  try {
    w.engine.applyConfig({ ...DEFAULT_ENGINE_CONFIG, color: { ...DEFAULT_ENGINE_CONFIG.color, brightness: 50 } })
    w.engine.setColor({ r: 255, g: 255, b: 255 })
    await run(w, 40)
    const dimmed = last(firstLeds(w.frames()))
    assert.ok(dimmed[0] < 60000 && dimmed[0] > 1000, `the ceiling should have dimmed white, got ${String(dimmed)}`)

    w.engine.applyConfig({ ...DEFAULT_ENGINE_CONFIG, color: { ...DEFAULT_ENGINE_CONFIG.color, brightness: 100 } })
    await run(w, 40)
    const full = last(firstLeds(w.frames()))
    assert.ok(full[0] >= 65000, `and back to full at 100, got ${String(full)}`)
  } finally {
    w.engine.stop()
    w.restore()
  }
})

test('the backlight floor lifts a dark CAPTURE only: a colour somebody chose as black stays black', async () => {
  // Hyperion.cpp:655-664 - the floor is for the picture, where "the scene is
  // dark" and "it broke" look the same. On a chosen colour it would make
  // "turn the strip black" impossible.
  const w = wire()
  try {
    w.engine.applyConfig({ ...DEFAULT_ENGINE_CONFIG, color: { ...DEFAULT_ENGINE_CONFIG.color, backlightThreshold: 40 } })
    w.engine.setColor({ r: 0, g: 0, b: 0 })
    await run(w, 40)
    assert.deepEqual(last(firstLeds(w.frames())), [0, 0, 0])
  } finally {
    w.engine.stop()
    w.restore()
  }
})

test('a blacklisted LED is sent black whatever a colour or an effect painted on it', async () => {
  // The sampler kept the blacklist on its own - a zero-area rectangle samples
  // black - but every other source writes all LEDs, and a blacklisted LED lit
  // up the moment an effect ran. The mask now sits where every frame passes.
  const w = wire()
  try {
    w.engine.applyConfig({ ...DEFAULT_ENGINE_CONFIG, blacklist: [{ start: 0, length: 1 }] })
    w.engine.setColor({ r: 255, g: 255, b: 255 })
    await run(w, 40)
    assert.deepEqual(last(ledOf(w.frames(), 0)), [0, 0, 0], 'LED 0 is blacklisted')
    const neighbour = last(ledOf(w.frames(), 1))
    assert.ok(neighbour[0] >= 65000, `LED 1 is not, got ${String(neighbour)}`)

    w.engine.runEffect({ kind: 'rainbow' })
    await run(w, 40)
    assert.deepEqual(last(ledOf(w.frames(), 0)), [0, 0, 0], 'and stays black under an effect')
  } finally {
    w.engine.stop()
    w.restore()
  }
})
