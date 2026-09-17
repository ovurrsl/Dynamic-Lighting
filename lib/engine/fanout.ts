import type { FrameHandler, FrameSource, SourceFrame, SourceKind } from '#lib/engine/source'

/**
 * One capture, several engines.
 *
 * This is the piece that makes multiple instances possible without asking the
 * user to pick their screen twice. A `getDisplayMedia` grant belongs to the
 * call that made it: two engines each opening their own capture means two
 * pickers, two grants, and a very good chance that the second one gets a
 * different window - so the desk strip follows the game and the TV strip
 * follows the picker dialog that opened it.
 *
 * So the frame is read ONCE and handed to everyone. Each consumer gets a
 * `FrameSource` of its own with its own `start`/`stop`, and downstream of that
 * nothing changes: the engine cannot tell whether it owns the capture or shares
 * it, which is the point - a pipeline that branched on that would have a path
 * that only runs with two strips attached, and therefore a path nobody tests.
 *
 * Three things this has to get right, all of them the kind that show up as a
 * capture that stops after forty frames:
 *
 * - **Reference counting, not copying.** A `VideoFrame` is a handle to a buffer
 *   the browser owns, and the source's pool is small - `maxBufferSize: 1`. The
 *   upstream frame is released only once every consumer that was handed it has
 *   let go, because `createImageBitmap` is asynchronous and a frame closed
 *   underneath it takes the whole stream down with it.
 * - **Release is idempotent PER CONSUMER.** The engine releases twice on its
 *   happy path (once it has the bitmap, and again in a `finally`), which is
 *   correct for a `VideoFrame` because closing one twice is a no-op. Counting
 *   those two as two consumers letting go would free the frame while another
 *   instance is still reading it.
 * - **A consumer that throws still lets go.** One instance failing must not
 *   strand the buffer for the others; a stranded buffer is not an error anyone
 *   sees, it is a capture that quietly stops.
 *
 * The upstream is started when the first consumer starts and stopped when the
 * last one stops, so turning off one strip leaves the other's capture alone and
 * turning off the last one really does end the capture rather than leaving a
 * screen being read with nothing watching.
 *
 * Pure: the upstream source is injected, so all of this is exercised in Node
 * against a fake that hands out frames on demand.
 */

export interface Fanout {
  readonly kind: SourceKind
  /**
   * A `FrameSource` for one consumer. Independent of every other: starting it
   * joins the capture, stopping it leaves.
   */
  attach: () => FrameSource
  /** How many consumers are currently started. */
  active: () => number
  /** How many have been attached, started or not. */
  attached: () => number
  /**
   * Whether the upstream has finished - the track stopped, or it errored.
   *
   * A pool that keeps fanouts by source has to know: attaching to an ended one
   * gives a consumer that is told "over" the instant it starts, which reads as
   * a capture that refuses to run with no way to tell why.
   */
  ended: () => boolean
  /** Stops the upstream and ends every consumer, whatever their state. */
  stop: () => Promise<void>
}

interface Consumer {
  started: boolean
  onFrame: FrameHandler | null
  onEnd: ((error?: unknown) => void) | null
}

export function createFanout (upstream: FrameSource): Fanout {
  const consumers = new Set<Consumer>()
  let upstreamStarted = false
  let ended = false

  /**
   * Hands one upstream frame to everyone, then lets go of our own hold on it.
   *
   * The extra hold is not decoration: without it, a consumer that releases
   * synchronously inside its handler would take the count to zero and close the
   * frame before the next consumer in the loop had even been offered it.
   */
  const deliver: FrameHandler = (frame, at) => {
    const live = [...consumers].filter((consumer) => consumer.started && consumer.onFrame !== null)
    if (live.length === 0) {
      frame.release()
      return
    }

    let holds = live.length + 1
    const letGo = (): void => {
      holds--
      if (holds === 0) frame.release()
    }

    for (const consumer of live) {
      let releasedByThisConsumer = false
      const view: SourceFrame = {
        image: frame.image,
        width: frame.width,
        height: frame.height,
        release: () => {
          // Per consumer, because the engine releases twice on its happy path.
          if (releasedByThisConsumer) return
          releasedByThisConsumer = true
          letGo()
        }
      }
      try {
        consumer.onFrame?.(view, at)
      } catch {
        // Its own problem; the others still get the frame and the buffer is
        // still freed. A consumer that throws has not released.
        view.release()
      }
    }

    letGo()
  }

  const finish = (error?: unknown): void => {
    ended = true
    upstreamStarted = false
    for (const consumer of [...consumers]) {
      if (consumer.started) consumer.onEnd?.(error)
      consumer.started = false
    }
  }

  function startUpstream (): void {
    if (upstreamStarted) return
    upstreamStarted = true
    ended = false
    upstream.start(deliver, (error) => { finish(error) })
  }

  async function stopUpstreamIfIdle (): Promise<void> {
    if (!upstreamStarted) return
    for (const consumer of consumers) if (consumer.started) return
    upstreamStarted = false
    // An idle fanout is an ENDED fanout. `FrameSource.start` is once - a
    // stopped track cannot be started again - so the next consumer must not
    // be attached to this upstream: the pool checks `ended()` and opens a
    // fresh capture instead. Left false, the second Start after a Stop joined
    // the dead capture and read as "the capture ended on its own" with no
    // frame ever delivered - measured on the panel, not inferred.
    ended = true
    await upstream.stop()
  }

  return {
    kind: upstream.kind,
    active: () => [...consumers].filter((consumer) => consumer.started).length,
    attached: () => consumers.size,
    ended: () => ended,

    attach (): FrameSource {
      const consumer: Consumer = { started: false, onFrame: null, onEnd: null }
      consumers.add(consumer)
      return {
        kind: upstream.kind,
        settings: () => upstream.settings(),
        start (onFrame, onEnd): void {
          consumer.onFrame = onFrame
          consumer.onEnd = onEnd ?? null
          consumer.started = true
          // A consumer that joins after the capture has already ended is told
          // so rather than left waiting for a frame that cannot arrive.
          if (ended) {
            consumer.started = false
            onEnd?.()
            return
          }
          startUpstream()
        },
        async stop (): Promise<void> {
          consumer.started = false
          consumer.onFrame = null
          consumer.onEnd = null
          consumers.delete(consumer)
          await stopUpstreamIfIdle()
        }
      }
    },

    async stop (): Promise<void> {
      const wasStarted = upstreamStarted
      upstreamStarted = false
      ended = true
      for (const consumer of consumers) consumer.started = false
      consumers.clear()
      if (wasStarted) await upstream.stop()
    }
  }
}
