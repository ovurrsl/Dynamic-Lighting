import { parseAddress, formatAddress } from '#lib/engine/address'
import type { FrameEncoder } from '#lib/engine/encode'
import type { FrameSink, SinkState } from '#lib/engine/sink'
import type { LedColors } from '#lib/engine/types'
import { wledFrames, wledGoodbye, wledHello, type WledFrameOptions } from '#lib/engine/wled'

/**
 * Sinks that reach a device over the network.
 *
 * This is what makes the platform list real rather than aspirational. A browser
 * has no Web Serial on iOS, no WebUSB, no WebHID and no Web Bluetooth - all
 * four are Chromium-only and Apple requires WebKit - so from an iPhone the
 * network is not one way to a strip, it is the ONLY way. A capture that cannot
 * reach a device is worth nothing, which is why this had to come before
 * effects, audio and everything else on the roadmap.
 *
 * Two sinks:
 *
 * - `createSocketSink` speaks our own protocol as BINARY frames - the very same
 *   `Afx` bytes the serial port carries, to the same parser, covered by the same
 *   firmware tests. Adding a network transport therefore cost no new protocol.
 * - `createWledSink` speaks WLED's JSON over its own WebSocket, because that is
 *   the only door WLED opens to a browser (see lib/engine/wled.ts).
 *
 * The socket is INJECTED. `WebSocket` is a browser global; injecting it is what
 * lets every path below - connect, reconnect, backoff, send-while-closed, close
 * mid-flight, a stalled link - be exercised in Node against a fake, rather
 * than being the part of the engine nobody can test.
 */

/** The subset of WebSocket these sinks use. A real one satisfies this. */
export interface Socket {
  readonly readyState: number
  /**
   * Bytes accepted by `send` and not yet on the wire. A real socket has it; a
   * fake may omit it and is then never considered stalled.
   */
  readonly bufferedAmount?: number
  binaryType?: string
  send: (data: string | ArrayBufferView | ArrayBuffer) => void
  close: () => void
  onopen: ((this: unknown, event: unknown) => unknown) | null
  onclose: ((this: unknown, event: unknown) => unknown) | null
  onerror: ((this: unknown, event: unknown) => unknown) | null
  onmessage?: ((this: unknown, event: unknown) => unknown) | null
}

export type SocketFactory = (url: string) => Socket

/** WebSocket's own constants, spelled out so this module needs no DOM lib. */
export const SOCKET_OPEN = 1

export interface ConnectionOptions {
  url: string
  /** Injected; defaults to the browser's own WebSocket where one exists. */
  factory?: SocketFactory
  /** Backoff between reconnect attempts, ms. Doubles up to `maxRetryMs`. */
  retryMs?: number
  maxRetryMs?: number
  /**
   * Bytes the socket may hold unsent before a frame is dropped instead.
   *
   * `WebSocket.send` never blocks and never fails on a stalled link: it queues,
   * without limit, and a WiFi stall that queued frames would deliver a second
   * of the past once it cleared. The latest-wins writer above this sink only
   * sees a promise that resolved at once, so the queue is invisible from
   * there; this is where it is seen and refused.
   */
  highWaterBytes?: number
  /** Scheduling, injected so tests need no timers. */
  schedule?: (fn: () => void, ms: number) => unknown
  cancel?: (handle: unknown) => void
}

const DEFAULT_RETRY_MS = 1000
const DEFAULT_MAX_RETRY_MS = 15000
/** Roughly 200 ms of frames on either transport at 108 LEDs. */
export const DEFAULT_HIGH_WATER_BYTES = 16 * 1024

function defaultFactory (url: string): Socket {
  const ctor = (globalThis as { WebSocket?: new (url: string) => Socket }).WebSocket
  if (ctor === undefined) throw new Error('net: this runtime has no WebSocket')
  return new ctor(url)
}

function describe (error: unknown): string {
  if (error instanceof Error) return error.name === '' || error.name === 'Error' ? error.message : `${error.name}: ${error.message}`
  return String(error)
}

/**
 * A socket that reconnects, and that never makes a caller wait for it.
 *
 * `send` on a closed connection is a DROP, not a queue and not an error. The
 * reasoning is the same one that governs the whole output path: a frame is only
 * worth sending while it is current, and a WiFi stall that queued frames would
 * deliver a second of the past once it cleared. The drop is counted, so a
 * connection that is failing shows up as a number rather than as silence.
 */
interface Connection {
  state: () => SinkState
  /** True when the socket is open and not stalled: a frame sent now goes. */
  ready: () => boolean
  /** True when the socket took it; false when it was dropped. */
  send: (data: string | ArrayBufferView) => boolean
  close: () => void
  stats: () => Record<string, number | string | boolean>
}

function connect (options: ConnectionOptions, onOpen?: (send: Connection['send']) => void): Connection {
  const factory = options.factory ?? defaultFactory
  const baseRetry = options.retryMs ?? DEFAULT_RETRY_MS
  const maxRetry = options.maxRetryMs ?? DEFAULT_MAX_RETRY_MS
  const highWater = options.highWaterBytes ?? DEFAULT_HIGH_WATER_BYTES
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const cancel = options.cancel ?? ((handle: unknown) => { clearTimeout(handle as ReturnType<typeof setTimeout>) })

  let socket: Socket | null = null
  let state: SinkState = 'idle'
  let retryMs = baseRetry
  let timer: unknown = null
  let closed = false
  let connects = 0
  let drops = 0
  let stalls = 0
  let closes = 0
  /**
   * Why the link is not open, for the panel. A browser tells a page nothing
   * about WHY a WebSocket failed - the error event is empty by design - so
   * this is the constructor's refusal, the close code, or "no detail", and
   * never a guess.
   */
  let reason: string | undefined

  const ready = (): boolean => {
    if (socket === null || socket.readyState !== SOCKET_OPEN) return false
    return (socket.bufferedAmount ?? 0) <= highWater
  }

  const send = (data: string | ArrayBufferView): boolean => {
    if (socket === null || socket.readyState !== SOCKET_OPEN) {
      drops++
      return false
    }
    if ((socket.bufferedAmount ?? 0) > highWater) {
      // The link is up and not taking bytes off the queue: a stall. Dropping
      // here is what keeps the queue from growing for the rest of the session.
      stalls++
      drops++
      return false
    }
    try {
      socket.send(data)
      return true
    } catch {
      // A socket that throws on send is already gone; the close handler will
      // schedule the retry. Counting it as a drop keeps one meaning for the
      // number: frames that did not reach the device.
      drops++
      return false
    }
  }

  const open = (): void => {
    if (closed) return
    state = 'connecting'
    let next: Socket
    try {
      next = factory(options.url)
    } catch (error) {
      state = 'error'
      reason = describe(error)
      // A URL the constructor refuses is refused for ever: retrying it every
      // second would be the same SyntaxError fifteen thousand times a day, and
      // the panel would show "connecting" for a link that can never open.
      if (error instanceof SyntaxError) return
      retry()
      return
    }
    socket = next
    next.binaryType = 'arraybuffer'
    next.onopen = () => {
      state = 'open'
      reason = undefined
      connects++
      // Reset only on a successful open. Resetting on the attempt would turn
      // the backoff into a fixed interval against a device that is switched off.
      retryMs = baseRetry
      onOpen?.(send)
    }
    next.onclose = (event: unknown) => {
      closes++
      if (socket === next) socket = null
      const { code, reason: why } = (event ?? {}) as { code?: unknown, reason?: unknown }
      if (typeof code === 'number' && code !== 1000 && code !== 1005) {
        reason = typeof why === 'string' && why !== '' ? `closed (${code}): ${why}` : `closed (${code})`
      }
      if (!closed) {
        state = 'connecting'
        retry()
      }
    }
    next.onerror = () => {
      // `error` is always followed by `close`, so the retry is scheduled there.
      // Doing it here as well would double the attempts.
      state = 'error'
      reason ??= 'socket error (the browser gives no detail)'
    }
  }

  const retry = (): void => {
    if (closed || timer !== null) return
    const delay = retryMs
    retryMs = Math.min(maxRetry, retryMs * 2)
    timer = schedule(() => {
      timer = null
      open()
    }, delay)
  }

  open()

  return {
    state: () => state,
    ready,
    send,
    close (): void {
      closed = true
      state = 'idle'
      if (timer !== null) {
        cancel(timer)
        timer = null
      }
      const current = socket
      socket = null
      try { current?.close() } catch { /* already gone */ }
    },
    stats: () => ({ connects, drops, stalls, closes, retryMs, ...(reason !== undefined ? { reason } : {}) })
  }
}

// ---------------------------------------------------------------------------
// Our own protocol, over a socket.
// ---------------------------------------------------------------------------

/** The endpoint our firmware serves. Kept beside the driver that dials it. */
export const AFX_PATH = '/afx'

/**
 * The WebSocket URL for a board, from whatever address the user typed.
 *
 * The same shape as `wledUrl`, and for the same reason: a user types an
 * address, not a URL. A path they typed themselves is kept - someone behind a
 * reverse proxy has put the board somewhere else and knows it - and anything
 * else gets `/afx`, which is the path the firmware registers (see
 * `kWsPath` in firmware/src/main.cpp).
 */
export function afxUrl (host: string): string {
  const url = parseAddress(host, 'net')
  const path = url.pathname.replace(/\/+$/, '')
  return formatAddress(url, path === '' ? AFX_PATH : path)
}

export interface SocketSinkOptions extends ConnectionOptions {
  encoder: FrameEncoder
}

/**
 * Our firmware, over a WebSocket, carrying the same bytes the serial port does.
 *
 * This is the answer to "a browser cannot open a UDP socket": it is the wrong
 * problem to solve. The firmware is ours, an ESP32-S3 can run a WebSocket
 * server, and the frame it receives is byte-for-byte the one it already parses.
 * No third protocol, no second parser, no separate test suite.
 */
export function createSocketSink (options: SocketSinkOptions): FrameSink {
  const { encoder } = options
  const link = connect(options)
  let sent = 0

  return {
    kind: 'websocket',
    describe: () => options.url,
    state: link.state,
    async send (colors: LedColors): Promise<void> {
      const frame = encoder.encode(colors)
      // A copy, because the socket may read the buffer after send() returns and
      // the encoder reuses one buffer for every frame.
      if (link.send(frame.slice())) sent++
    },
    async sendBytes (raw: Uint8Array): Promise<void> {
      // A control frame is not worth dropping quietly: unlike a picture there
      // is no next one along in 8 ms, so a closed socket is reported.
      if (!link.send(raw.slice())) throw new Error('net: the socket is not open')
    },
    async close (): Promise<void> { link.close() },
    stats: () => ({ sent, format: encoder.format, ...link.stats() })
  }
}

// ---------------------------------------------------------------------------
// WLED, over its own socket.
// ---------------------------------------------------------------------------

export interface WledSinkOptions extends ConnectionOptions, WledFrameOptions {
  leds: number
}

/**
 * A WLED device, driven per-LED as JSON over its WebSocket.
 *
 * The handshake goes out once per connection rather than per frame: it turns
 * the device on, sets its brightness to full and freezes the segment, none of
 * which needs saying sixty times a second to an ESP that is already parsing
 * JSON for a living. It goes out again on every reconnect, because a device
 * that rebooted has forgotten.
 *
 * A frame is one message, or several for a strip longer than the device takes
 * in one piece (lib/engine/wled.ts). Either all of them go or none: a frame
 * whose first half went and second half was dropped would leave the strip
 * showing two moments at once.
 */
export function createWledSink (options: WledSinkOptions): FrameSink {
  const { leds } = options
  if (!Number.isInteger(leds) || leds < 1) {
    throw new RangeError(`net: leds must be a positive integer, got ${String(leds)}`)
  }
  // Refused at construction rather than on the first frame, for the same
  // reason as the LED count: a wrong gamma is a wrong setting, not a bad frame.
  wledFrames(new Float32Array(3), 1, options)
  /**
   * Whether the segment has been handed back since the last hello. The link
   * stays open across a Stop, so the next frame after a release has to say
   * hello again or it lands on a segment whose own effect repaints it - on a
   * device older than 0.13, which does not freeze on a pixel write, at once.
   */
  let released = false
  const link = connect(options, (send) => {
    send(wledHello(options))
    released = false
  })
  let sent = 0
  let messages = 0
  let bytes = 0
  let dropped = 0

  return {
    kind: 'wled',
    describe: () => options.url,
    state: link.state,
    async send (colors: LedColors): Promise<void> {
      if (!link.ready()) {
        dropped++
        return
      }
      if (released) {
        if (!link.send(wledHello(options))) {
          dropped++
          return
        }
        released = false
      }
      const frames = wledFrames(colors, leds, options)
      for (const text of frames) {
        if (!link.send(text)) {
          dropped++
          return
        }
        messages++
        bytes += text.length
      }
      sent++
    },
    async release (): Promise<void> {
      // A socket that is not open has nothing to unfreeze, and the hello on
      // its next open is what puts the device back the way we want it.
      if (link.state() !== 'open' || released) return
      if (link.send(wledGoodbye(options))) released = true
    },
    async close (): Promise<void> {
      // Best effort, and before the close: the socket sends what it was
      // handed before its closing handshake, so the segment gets its effect
      // back.
      if (link.state() === 'open' && !released) link.send(wledGoodbye(options))
      link.close()
    },
    stats: () => ({ sent, messages, bytes, leds, frameDrops: dropped, ...link.stats() })
  }
}
