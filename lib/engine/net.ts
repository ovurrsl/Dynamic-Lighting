import type { FrameEncoder } from '#lib/engine/encode'
import type { FrameSink, SinkState } from '#lib/engine/sink'
import type { LedColors } from '#lib/engine/types'
import { wledFrame, wledHello, type WledFrameOptions } from '#lib/engine/wled'

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
 * mid-flight - be exercised in Node against a fake, rather than being the part
 * of the engine nobody can test.
 */

/** The subset of WebSocket these sinks use. A real one satisfies this. */
export interface Socket {
  readonly readyState: number
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
  /** Scheduling, injected so tests need no timers. */
  schedule?: (fn: () => void, ms: number) => unknown
  cancel?: (handle: unknown) => void
}

const DEFAULT_RETRY_MS = 1000
const DEFAULT_MAX_RETRY_MS = 15000

function defaultFactory (url: string): Socket {
  const ctor = (globalThis as { WebSocket?: new (url: string) => Socket }).WebSocket
  if (ctor === undefined) throw new Error('net: this runtime has no WebSocket')
  return new ctor(url)
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
  /** True when the socket took it; false when it was dropped. */
  send: (data: string | ArrayBufferView) => boolean
  close: () => void
  stats: () => { connects: number, drops: number, closes: number, retryMs: number }
}

function connect (options: ConnectionOptions, onOpen?: (send: Connection['send']) => void): Connection {
  const factory = options.factory ?? defaultFactory
  const baseRetry = options.retryMs ?? DEFAULT_RETRY_MS
  const maxRetry = options.maxRetryMs ?? DEFAULT_MAX_RETRY_MS
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const cancel = options.cancel ?? ((handle: unknown) => { clearTimeout(handle as ReturnType<typeof setTimeout>) })

  let socket: Socket | null = null
  let state: SinkState = 'idle'
  let retryMs = baseRetry
  let timer: unknown = null
  let closed = false
  let connects = 0
  let drops = 0
  let closes = 0

  const send = (data: string | ArrayBufferView): boolean => {
    if (socket === null || socket.readyState !== SOCKET_OPEN) {
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
    } catch {
      state = 'error'
      retry()
      return
    }
    socket = next
    next.binaryType = 'arraybuffer'
    next.onopen = () => {
      state = 'open'
      connects++
      // Reset only on a successful open. Resetting on the attempt would turn
      // the backoff into a fixed interval against a device that is switched off.
      retryMs = baseRetry
      onOpen?.(send)
    }
    next.onclose = () => {
      closes++
      if (socket === next) socket = null
      if (!closed) {
        state = 'connecting'
        retry()
      }
    }
    next.onerror = () => {
      // `error` is always followed by `close`, so the retry is scheduled there.
      // Doing it here as well would double the attempts.
      state = 'error'
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
    stats: () => ({ connects, drops, closes, retryMs })
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
  const trimmed = host.trim()
  if (trimmed === '') throw new RangeError('net: host is empty')
  const scheme = trimmed.startsWith('wss://') || trimmed.startsWith('https://') ? 'wss' : 'ws'
  const bare = trimmed.replace(/^(wss?|https?):\/\//, '').replace(/\/+$/, '')
  if (bare === '') throw new RangeError('net: host is empty')
  const slash = bare.indexOf('/')
  return slash === -1 ? `${scheme}://${bare}${AFX_PATH}` : `${scheme}://${bare}`
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
 * The `live` handshake goes out once per connection rather than per frame: a
 * WLED running an effect ignores pixel writes until something claims realtime
 * control, and a user whose strip keeps showing a rainbow has no way to work
 * that out from here. Sending it on every frame would be a few wasted bytes at
 * 60 Hz against an ESP that is already parsing JSON for a living.
 */
export function createWledSink (options: WledSinkOptions): FrameSink {
  const { leds } = options
  if (!Number.isInteger(leds) || leds < 1) {
    throw new RangeError(`net: leds must be a positive integer, got ${String(leds)}`)
  }
  const link = connect(options, (send) => { send(wledHello(options)) })
  let sent = 0
  let bytes = 0

  return {
    kind: 'wled',
    describe: () => options.url,
    state: link.state,
    async send (colors: LedColors): Promise<void> {
      const text = wledFrame(colors, leds, options)
      if (link.send(text)) {
        sent++
        bytes += text.length
      }
    },
    async close (): Promise<void> { link.close() },
    stats: () => ({ sent, bytes, leds, ...link.stats() })
  }
}
