import { FrameParser, type ParserStats } from '#lib/engine/protocol'
import type { FrameEncoder } from '#lib/engine/encode'
import type { LedColors } from '#lib/engine/types'

/**
 * Where a frame goes.
 *
 * Until now the engine had exactly one output - a Web Serial port, with a
 * loopback standing in when no port was paired - and the shape of that code
 * assumed it: the writer took BYTES, because bytes are what a serial port
 * accepts. That assumption is what this file removes, and the reason is
 * concrete rather than architectural tidiness:
 *
 * **A sink takes LED COLOURS, not bytes**, because not every device speaks our
 * bytes. WLED's browser-reachable interface is JSON over a WebSocket
 * (`{"seg":{"i":[…]}}`); handing it an `Afx` frame would mean decoding our own
 * encoding back into colours to re-encode them as text. Our own firmware over a
 * WebSocket wants exactly the `Afx` bytes the serial port wants. Each transport
 * therefore owns its wire representation, and the engine's job ends at
 * "here are the colours".
 *
 * That also moves the one decision that determines what a device actually
 * receives - the wire format - out of the extension and into tested code
 * (lib/engine/encode.ts).
 *
 * Nothing here is browser-specific. Ports and sockets are injected, so every
 * sink below is exercised in Node with a fake.
 */

export type SinkKind = 'loopback' | 'serial' | 'websocket' | 'wled'

/**
 * What a sink is doing, for the panel to show.
 *
 * A network sink needs this in a way a serial port did not: a socket spends
 * real time connecting and can drop at any moment, and "nothing is lighting up"
 * has to be distinguishable from "still dialling".
 */
export type SinkState = 'idle' | 'connecting' | 'open' | 'error'

export interface FrameSink {
  readonly kind: SinkKind
  /** A short label for the panel: the port's ids, the host, "loopback". */
  describe: () => string
  state: () => SinkState
  /**
   * Hands one frame of LED colours to the transport. Resolves when it has been
   * accepted; rejects on a link error.
   *
   * The colours may be overwritten the moment this returns - the engine reuses
   * one buffer - so a sink that defers must copy or encode first.
   */
  send: (colors: LedColors) => Promise<void>
  /**
   * Puts bytes on the link that are not a picture - the AxC control channel.
   *
   * Optional because not every transport has one. Our own bytes go wherever our
   * bytes go, so the serial port and the socket to our firmware both have it
   * and both reach the same parser on the board. WLED speaks its own JSON and
   * has no control channel of ours; the loopback has no board to configure.
   * Absent therefore means "this link cannot be asked", which is exactly what
   * the panel needs to know before it offers the option.
   */
  sendBytes?: (bytes: Uint8Array) => Promise<void>
  close: () => Promise<void>
  /** Whatever this transport counts; merged into the panel's link statistics. */
  stats: () => Record<string, number | string | boolean>
}

// ---------------------------------------------------------------------------
// The gate.
// ---------------------------------------------------------------------------

export interface FrameWriterOptions {
  /** Called with the rejection when a send fails; the writer itself carries on. */
  onError?: (error: unknown) => void
}

export interface FrameWriterStats {
  /** Frames the sink accepted. */
  written: number
  /** Frames dropped because a send was in flight. Healthy is 0. */
  dropped: number
  /** Sends that rejected. */
  errors: number
  inFlight: boolean
}

export interface FrameWriter {
  /**
   * Hands `colors` to the sink unless a send is in flight, in which case the
   * frame is dropped. Returns whether it was accepted. Never throws for a sink
   * failure; see `onError`.
   */
  send: (colors: LedColors) => boolean
  stats: () => FrameWriterStats
  /** Resolves once no send is in flight. */
  idle: () => Promise<void>
}

/**
 * Latest-wins, and never a queue.
 *
 * At most ONE frame is in flight; a frame that arrives while the previous send
 * has not resolved is dropped and counted. This is the single most common
 * mistake in this class of software: a queue turns a 200 ms hiccup into latency
 * that grows for the rest of the session, because the queue never drains faster
 * than frames arrive. Dropping turns the same hiccup into 200 ms of stale LEDs
 * and then the current frame.
 *
 * It matters MORE on a network sink than it did on a serial port. A WiFi stall
 * is longer and more common than a USB one, and a queued second of frames over
 * a WebSocket would arrive as a second of the past.
 *
 * The writer copies the colours into a buffer it owns before handing them over,
 * so the caller may overwrite its own buffer the moment `send` returns. One
 * owned buffer is enough because a frame is only accepted while nothing is in
 * flight.
 */
export function createFrameWriter (sink: FrameSink, options: FrameWriterOptions = {}): FrameWriter {
  const onError = options.onError
  let owned = new Float32Array(0)
  let inFlight: Promise<void> | null = null
  let written = 0
  let dropped = 0
  let errors = 0

  return {
    send (colors: LedColors): boolean {
      if (inFlight !== null) {
        dropped++
        return false
      }
      if (owned.length !== colors.length) owned = new Float32Array(colors.length)
      owned.set(colors)
      let pending: Promise<void>
      try {
        pending = sink.send(owned)
      } catch (error) {
        // A sink that throws synchronously is treated like one that rejects.
        pending = Promise.reject(error)
      }
      inFlight = pending.then(
        () => { written++ },
        (error: unknown) => {
          errors++
          onError?.(error)
        }
      ).finally(() => { inFlight = null })
      return true
    },
    stats (): FrameWriterStats {
      return { written, dropped, errors, inFlight: inFlight !== null }
    },
    idle (): Promise<void> {
      return inFlight ?? Promise.resolve()
    }
  }
}

// ---------------------------------------------------------------------------
// Byte transports: anything that takes our encoded frame.
// ---------------------------------------------------------------------------

/** A thing that accepts bytes. A Web Serial writer, a WebSocket, a test double. */
export interface ByteTransport {
  write: (bytes: Uint8Array) => Promise<void>
  close?: () => Promise<void>
}

export interface BytesSinkOptions {
  kind: SinkKind
  label: string
  encoder: FrameEncoder
  transport: ByteTransport
}

/**
 * Encodes, then writes. The shared half of every sink that speaks our protocol:
 * the serial port and the WebSocket to our own firmware differ only in what
 * they hand the bytes to.
 */
export function createBytesSink (options: BytesSinkOptions): FrameSink {
  const { kind, label, encoder, transport } = options
  let state: SinkState = 'open'
  let bytes = 0

  return {
    kind,
    describe: () => label,
    state: () => state,
    async send (colors: LedColors): Promise<void> {
      const frame = encoder.encode(colors)
      try {
        await transport.write(frame)
      } catch (error) {
        state = 'error'
        throw error
      }
      bytes += frame.length
    },
    async sendBytes (raw: Uint8Array): Promise<void> {
      await transport.write(raw)
    },
    async close (): Promise<void> {
      state = 'idle'
      await transport.close?.()
    },
    stats: () => ({ bytes, format: encoder.format, frameBytes: encoder.frameBytes })
  }
}

// ---------------------------------------------------------------------------
// Loopback.
// ---------------------------------------------------------------------------

export interface LoopbackOptions {
  encoder: FrameEncoder
  /** Simulated link time per frame; 0 resolves on the next microtask. */
  latencyMs?: number
  /** How to wait; injected so tests can drive it. Default setTimeout. */
  wait?: (ms: number) => Promise<void>
}

export interface LoopbackStats {
  /** Writes from which the reference parser delivered a frame. */
  accepted: number
  /** Writes from which it delivered none - a framing bug, never expected. */
  rejected: number
  bytes: number
  /** The stream parser's own counters: resyncs, bad checksums, count mismatches. */
  parser: ParserStats
  /** The last delivered frame's payload, for a preview. */
  lastPayload: Uint8Array | null
}

export interface LoopbackSink extends FrameSink {
  loopback: () => LoopbackStats
}

/**
 * Runs the whole pipeline with no device: every frame is encoded and fed to the
 * reference stream parser - the one the firmware is written against - and
 * counted.
 *
 * This is how the capture and the pipeline were measured before the firmware
 * existed, and it is what the engine falls back to when nothing is connected,
 * so "no device" is never "nothing runs". A write that yields no frame is a
 * framing bug, which is why `rejected` is expected to be exactly 0.
 */
export function createLoopbackSink (options: LoopbackOptions): LoopbackSink {
  const { encoder } = options
  const latencyMs = options.latencyMs ?? 0
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const parser = new FrameParser()
  let accepted = 0
  let rejected = 0
  let bytes = 0
  let lastPayload: Uint8Array | null = null

  return {
    kind: 'loopback',
    describe: () => 'loopback',
    state: () => 'open',
    async send (colors: LedColors): Promise<void> {
      const frame = encoder.encode(colors)
      bytes += frame.length
      // Parse before waiting: the encoder's buffer is only stable until the
      // next encode, and by then it has done its job.
      const frames = parser.push(frame)
      if (frames.length === 0) {
        rejected++
      } else {
        accepted += frames.length
        lastPayload = (frames[frames.length - 1] as { payload: Uint8Array }).payload
      }
      if (latencyMs > 0) await wait(latencyMs)
    },
    async close (): Promise<void> { /* nothing to release */ },
    stats: () => ({ accepted, rejected, bytes }),
    loopback: () => ({ accepted, rejected, bytes, parser: { ...parser.stats }, lastPayload })
  }
}
