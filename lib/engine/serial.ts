import { FrameParser, type ParserStats } from '#lib/engine/protocol'

/**
 * The link to the device: a latest-wins writer over any byte sink.
 *
 * At most ONE frame is in flight. A frame that arrives while the previous
 * write has not resolved is dropped and counted - never queued. This is the
 * single most common mistake in this class of software (docs/hyperion-port-plan
 * .md, and the original design plan's "seven critical decisions"): a queue
 * turns a 200 ms USB hiccup into latency that grows for the rest of the
 * session, because the queue never drains faster than frames arrive. Dropping
 * turns the same hiccup into 200 ms of stale LEDs and then the current frame.
 *
 * Hyperion's equivalent is the coalescing gate in LedDeviceWrapper together
 * with the device's latch-time gate (plan section 10, "three rate limiters in
 * series"); this is the one gate we keep, and it is a drop, not a wait.
 *
 * The writer copies the frame into a buffer it owns before handing it to the
 * sink, so the caller may overwrite its own buffer the moment `send` returns.
 * Web Serial reads the chunk asynchronously, after `write()` has returned, and
 * a frame overwritten mid-transfer goes out torn. One owned buffer is enough
 * because a frame is only accepted while nothing is in flight.
 *
 * Nothing here is browser-specific: the sink is injected, so the tests use a
 * fake with hand-resolved promises and the extension wraps a Web Serial port.
 */

export interface SerialSink {
  /** Resolves when the bytes are handed to the OS; rejects on a link error. */
  write (bytes: Uint8Array): Promise<void>
}

export interface SerialWriterOptions {
  /** Called with the rejection when a write fails; the writer itself carries on. */
  onError?: (error: unknown) => void
}

export interface SerialWriterStats {
  /** Frames handed to the sink whose write resolved. */
  written: number
  /** Frames dropped because a write was in flight. Healthy is 0. */
  dropped: number
  /** Writes that rejected. */
  errors: number
  /** Bytes of the frames whose write resolved. */
  bytes: number
  inFlight: boolean
}

export interface SerialWriter {
  /**
   * Hands `frame` to the sink unless a write is in flight, in which case the
   * frame is dropped. Returns whether it was accepted. Never throws for a
   * sink failure; see `onError`.
   */
  send (frame: Uint8Array): boolean
  stats (): SerialWriterStats
  /** Resolves once no write is in flight. */
  idle (): Promise<void>
}

export function createSerialWriter (sink: SerialSink, options: SerialWriterOptions = {}): SerialWriter {
  const onError = options.onError
  let owned = new Uint8Array(0)
  let inFlight: Promise<void> | null = null
  let written = 0
  let dropped = 0
  let errors = 0
  let bytes = 0

  return {
    send (frame: Uint8Array): boolean {
      if (inFlight !== null) {
        dropped++
        return false
      }
      if (owned.length !== frame.length) owned = new Uint8Array(frame.length)
      owned.set(frame)
      const length = frame.length
      let pending: Promise<void>
      try {
        pending = sink.write(owned)
      } catch (error) {
        // A sink that throws synchronously is treated like one that rejects.
        pending = Promise.reject(error)
      }
      inFlight = pending.then(
        () => {
          written++
          bytes += length
        },
        (error: unknown) => {
          errors++
          onError?.(error)
        }
      ).finally(() => {
        inFlight = null
      })
      return true
    },
    stats (): SerialWriterStats {
      return { written, dropped, errors, bytes, inFlight: inFlight !== null }
    },
    idle (): Promise<void> {
      return inFlight ?? Promise.resolve()
    }
  }
}

export interface LoopbackOptions {
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
  /** Total bytes received. */
  bytes: number
  /** The stream parser's own counters: resyncs, bad checksums, count mismatches. */
  parser: ParserStats
  /** The last delivered frame's payload, for a preview. */
  lastPayload: Uint8Array | null
}

export interface LoopbackSink extends SerialSink {
  stats (): LoopbackStats
}

/**
 * A sink for running the whole pipeline without a device: every write is fed
 * to the reference stream parser - the one the firmware is written against -
 * and counted. This is how the capture and pipeline are measured today, before
 * the firmware exists, and it is what the engine falls back to when no serial
 * port has been paired, so "no device" is never "nothing runs".
 *
 * The writer only ever hands over whole frames, so a write that yields no
 * frame is a rejected frame. The parser's stream-level counters are exposed
 * as well, because they say WHY.
 */
export function createLoopbackSink (options: LoopbackOptions = {}): LoopbackSink {
  const latencyMs = options.latencyMs ?? 0
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const parser = new FrameParser()
  let accepted = 0
  let rejected = 0
  let bytes = 0
  let lastPayload: Uint8Array | null = null

  return {
    async write (frame: Uint8Array): Promise<void> {
      bytes += frame.length
      // Parse before waiting: the writer's buffer is only guaranteed stable
      // until this promise resolves, and by then it has done its job.
      const frames = parser.push(frame)
      if (frames.length === 0) {
        rejected++
      } else {
        accepted += frames.length
        lastPayload = (frames[frames.length - 1] as { payload: Uint8Array }).payload
      }
      if (latencyMs > 0) await wait(latencyMs)
    },
    stats (): LoopbackStats {
      return { accepted, rejected, bytes, parser: { ...parser.stats }, lastPayload }
    }
  }
}
