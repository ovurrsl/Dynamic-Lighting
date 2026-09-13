import type { Clock, LedColors, LinearGrid } from '#lib/engine/types'

/**
 * Priority multiplexer: decides which source feeds the pipeline right now.
 *
 * Port of Hyperion's PriorityMuxer (libsrc/hyperion/PriorityMuxer.cpp, tag
 * 2.2.2-beta.1; bare `:line` references below point into that file). It
 * arbitrates and nothing else. Sources register at a priority and push input;
 * once per frame the pipeline calls tick() and processes whatever came back.
 * Lower number wins. 255 is the background and loses to everything else; real
 * sources use 1..254.
 *
 * Where this port departs from Hyperion, on purpose:
 *
 * - Arbitration happens in tick(), once per frame, on an injected clock.
 *   Hyperion re-arbitrates inside setInput and clearAll (:289, :373) and on top
 *   of that polls wall-clock time every 250 ms (:74, :390), so a timeout lands
 *   up to a quarter of a second late and a source swapped between two frames
 *   still flickers through the event stream. Deferring to the frame makes the
 *   winner exactly what the LEDs show, and the events describe only that.
 * - "No source" is null. Hyperion keeps a synthetic black colour registered at
 *   255 (:39-49) and the device layer recognises "nothing left" by comparing
 *   the visible priority against that magic number (Hyperion.cpp:676). A null
 *   in the type cannot be forgotten by a caller the way a sentinel can.
 * - A source's lifetime and its inactivity limit are two options given once at
 *   registration, not a `timeout_ms` argument on every setInput (:244-251)
 *   whose meaning depends on the caller remembering to pass it every time.
 */

/** Highest priority a source can register at (Hyperion: FG_PRIORITY, :14). */
export const HIGHEST_PRIORITY = 1

/** Lowest priority for a real source; the background sits one below. */
export const LOWEST_SOURCE_PRIORITY = 254

/**
 * The background slot. Hyperion reserves 254 for its background effect and
 * pins a synthetic black colour at 255 (:15, :17, :39-49). We have no synthetic
 * entry, so 255 is free to be the real background and 254 is a real source.
 */
export const BACKGROUND_PRIORITY = 255

/**
 * How long each of Hyperion's streaming sources may go silent before it stands
 * down (CaptureCont.cpp:19-21, applied at :59, :65, :71). Exported so the
 * capture stages register with the same figures rather than each inventing one.
 */
export const DEFAULT_STREAM_TIMEOUT_MS = Object.freeze({ capture: 5000, video: 1000, audio: 1000 })

/**
 * What kind of thing a source is. The four named tags are the ones the rest of
 * the pipeline reacts to (Hyperion's COMP_GRABBER, COMP_EFFECT, COMP_COLOR and
 * its background effect); any other string passes through untouched. The
 * `string & {}` keeps the named ones as editor suggestions without closing
 * the set.
 */
export type Component = 'capture' | 'effect' | 'color' | 'background' | (string & {})

/** A captured frame: the sampling stage turns it into LED colours. */
export interface GridInput {
  readonly kind: 'grid'
  readonly grid: LinearGrid
}

/** Colours already per LED: a solid colour, an effect's output. */
export interface ColorsInput {
  readonly kind: 'colors'
  readonly colors: LedColors
}

/**
 * A source holds exactly one of these at a time. Hyperion stores both an image
 * and a colour vector per input and clears whichever one was not just set
 * (:278-279, :330-331), with a header comment warning callers not to use both
 * together; the union makes that state impossible to reach.
 */
export type SourceInput = GridInput | ColorsInput

export interface SourceOptions {
  component: Component
  /**
   * Streaming sources: dropped once no setInput() has arrived for this long.
   * Hyperion's screen capture uses 5000, video and audio 1000; see
   * DEFAULT_STREAM_TIMEOUT_MS. Endless when absent.
   */
  timeoutMs?: number
  /**
   * Timed sources: dropped this long after registration, fed or not. This is
   * how "show red for ten seconds" is expressed. Endless when absent.
   */
  durationMs?: number
}

/** The source tick() chose. `input` is whatever setInput() last delivered. */
export interface Winner {
  readonly priority: number
  readonly component: Component
  readonly input: SourceInput
  readonly registeredAt: number
}

/**
 * One event for what Hyperion splits into visiblePriorityChanged and
 * visibleComponentChanged (:470-476). Either side is null when there was, or
 * is, no live source; the null <-> non-null edges are what switch the LEDs
 * off and back on (Hyperion.cpp:667-700, handleSourceAvailability).
 */
export interface WinnerChange {
  readonly previous: Winner | null
  readonly current: Winner | null
}

export type ChangeListener = (change: WinnerChange) => void

/** A registered source as the control panel would list it. */
export interface SourceInfo {
  readonly priority: number
  readonly component: Component
  readonly registeredAt: number
  /**
   * Has delivered input at least once. Expiry is applied by tick(), so a source
   * that is overdue but not yet swept still reads active until the next frame.
   */
  readonly active: boolean
}

interface Source {
  readonly priority: number
  readonly component: Component
  readonly registeredAt: number
  /** First instant the source is gone. Infinity when endless. */
  readonly expiresAt: number
  /** Silence allowed between two setInput() calls. Infinity when unlimited. */
  readonly timeoutMs: number
  input: SourceInput | null
  /** Clock reading at the last setInput(). Meaningless until `input` is set. */
  lastSeen: number
}

export class PriorityMuxer {
  /** Hyperion's `_activeInputs`, keyed by priority. */
  private readonly inputs = new Map<number, Source>()
  private readonly listeners = new Set<ChangeListener>()
  /** The pinned priority, or null for automatic selection. */
  private manual: number | null = null
  /** What the last tick() decided; what the LEDs are showing. */
  private winner: Winner | null = null
  /** True while listeners are being called; a tick() from inside one is refused. */
  private dispatching = false
  private readonly clock: Clock

  // Not a parameter property: Node's type stripping runs the tests without a
  // build step and cannot lower that syntax (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX).
  constructor (clock: Clock) {
    this.clock = clock
  }

  /**
   * Adds a source at `priority`, replacing any source already there.
   *
   * A new source is registered but not a candidate until its first setInput():
   * Hyperion marks it TIMEOUT_NOT_ACTIVE_PRIO (:214) and skips it during
   * selection (:423-427), and so do we, because a grabber that has registered
   * but not yet produced a frame has nothing the LEDs could show.
   *
   * Replacing is a deliberate departure. Hyperion re-registering an occupied
   * priority keeps the previous input and timeout (:199-227, "Reuse input"), so
   * a new effect started on the priority of an old one shows the old effect's
   * last frame until the new one delivers. Here the slot starts clean: the old
   * input is gone, and `registeredAt` and the duration restart from now. The
   * constraint that buys: re-register and the first setInput() must land in
   * the same frame, or the next-best source shows for the frame in between.
   */
  register (priority: number, options: SourceOptions): void {
    checkPriority(priority)
    checkComponent(options.component)
    checkSpan('timeoutMs', options.timeoutMs)
    checkSpan('durationMs', options.durationMs)

    const now = this.clock()
    this.inputs.set(priority, {
      priority,
      component: options.component,
      registeredAt: now,
      expiresAt: options.durationMs === undefined ? Infinity : now + options.durationMs,
      timeoutMs: options.timeoutMs ?? Infinity,
      input: null,
      lastSeen: now
    })
  }

  /**
   * Delivers input to a registered source and restarts its inactivity clock,
   * as every frame in Hyperion restarts the grabber's inactive timer
   * (CaptureCont.cpp:121-122).
   *
   * Throws on an unregistered priority. Hyperion logs an error and returns
   * false (:232-236), which lets a capture loop run for ever feeding a source
   * that timed out minutes ago and quietly lights nothing. A streaming source
   * that was dropped for inactivity must be registered again before it is fed;
   * has() is the cheap check to make before each frame.
   */
  setInput (priority: number, input: SourceInput): void {
    const source = this.inputs.get(priority)
    if (source === undefined) {
      throw new Error(`muxer: setInput on unregistered priority ${priority}; register it first (it may have timed out)`)
    }
    checkInput(input)
    source.input = input
    source.lastSeen = this.clock()
  }

  /**
   * Removes one source; returns whether there was one. The background can be
   * removed too, because it is a real source here and not Hyperion's fixed
   * sentinel (:357 refuses to clear 255). The removal shows at the next tick();
   * a pin on the removed priority is released at once, so that a source
   * registered at that priority before the next frame does not inherit it.
   */
  clear (priority: number): boolean {
    const removed = this.inputs.delete(priority)
    if (removed && this.manual === priority) this.manual = null
    return removed
  }

  /**
   * Removes every source except the background, capture included: this is
   * "back to the background", and a capture that survived it would win again
   * on the next frame. Hyperion's non-forced clearAll (:377-385) spares
   * grabbers and its background slot 254 because its grabbers never re-register
   * on their own; ours are expected to check has() before each frame. A pin on
   * anything but the background is released with its source.
   */
  clearAll (): void {
    for (const priority of this.inputs.keys()) {
      if (priority !== BACKGROUND_PRIORITY) this.inputs.delete(priority)
    }
    if (this.manual !== null && this.manual !== BACKGROUND_PRIORITY) this.manual = null
  }

  /**
   * Pins one priority, or null to return to automatic selection.
   *
   * The priority must be registered, as Hyperion's setPriority requires
   * (:120-130); pinning something that does not exist is a typo, not a wish.
   * Once pinned, the pin holds for as long as the source stays registered and
   * is released the moment it is gone (:452-461) - cleared, expired or timed
   * out - so the LEDs never sit dark waiting for a source that will not return.
   * Pinning the background is allowed and is the one case where 255 beats a
   * live source: it is how "show me the background" is expressed.
   */
  setManual (priority: number | null): void {
    if (priority === null) {
      this.manual = null
      return
    }
    checkPriority(priority)
    if (!this.inputs.has(priority)) {
      throw new Error(`muxer: cannot select unregistered priority ${priority}`)
    }
    this.manual = priority
  }

  /** The pinned priority, or null under automatic selection. */
  manualPriority (): number | null {
    return this.manual
  }

  has (priority: number): boolean {
    return this.inputs.has(priority)
  }

  /** Every registered source, highest priority first. */
  sources (): SourceInfo[] {
    return [...this.inputs.values()]
      .sort((a, b) => a.priority - b.priority)
      .map((s) => ({ priority: s.priority, component: s.component, registeredAt: s.registeredAt, active: s.input !== null }))
  }

  /** What the last tick() decided. Null until the first tick(). */
  current (): Winner | null {
    return this.winner
  }

  /**
   * Fires when, and only when, the winner changes: a different priority, a
   * different component at the same priority, or a live source appearing where
   * there was none or vice versa. A winner refreshing its own input is not a
   * change. Returns the unsubscribe function.
   */
  onChange (listener: ChangeListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Arbitrates for this frame: sweeps dead sources, picks the winner, reports a
   * change if there was one, and returns the winner - or null when nothing is
   * live, which is the device layer's cue to switch the LEDs off.
   *
   * Order mirrors updatePriorities (:388-484): sweep first, so nothing that has
   * already died can win this frame; honour the pin second; otherwise take the
   * lowest number. `now` defaults to the injected clock and exists so a caller
   * that already read the clock for this frame can pass the same instant - it
   * must be a reading of THAT clock, since `lastSeen` is stamped from it and a
   * timestamp from another timebase would silently break every deadline. A
   * non-finite instant is refused: NaN compares false against every deadline
   * and would keep an overdue source alive for ever, Infinity would sweep
   * exactly the sources that were promised to be endless.
   *
   * Listeners must not tick() from inside a change callback; a re-entrant
   * tick() throws rather than hand later listeners two edges in the wrong order.
   */
  tick (now: number = this.clock()): Winner | null {
    if (!Number.isFinite(now)) throw new RangeError(`muxer: tick needs a finite instant, got ${now}`)
    if (this.dispatching) throw new Error('muxer: tick() called from inside an onChange listener')
    for (const [priority, source] of this.inputs) {
      if (isDead(source, now)) this.inputs.delete(priority)
    }

    let chosen: Source | null = null
    if (this.manual !== null) {
      const pinned = this.inputs.get(this.manual)
      if (pinned === undefined) {
        this.manual = null
      } else if (pinned.input !== null) {
        chosen = pinned
      }
      // A pinned source that is registered but has not delivered yet keeps its
      // pin and lets the automatic choice through meanwhile. Hyperion makes the
      // pinned priority visible on registration alone (:452-455), and an input
      // that has no data yet leaves the LEDs frozen on whatever they last had.
    }
    if (chosen === null) {
      for (const source of this.inputs.values()) {
        if (source.input !== null && (chosen === null || source.priority < chosen.priority)) chosen = source
      }
    }

    const previous = this.winner
    const next = snapshot(previous, chosen)
    this.winner = next
    if (!sameWinner(previous, next)) this.dispatch({ previous, current: next })
    return next
  }

  /**
   * Delivers one edge to every listener subscribed when it began. The winner
   * is already committed, so an edge that fails to reach a listener is never
   * re-delivered - and for the device layer the null <-> non-null edge is
   * "switch the LEDs on". Every listener therefore runs even if an earlier one
   * throws; the first error is rethrown once all of them have seen the edge.
   */
  private dispatch (change: WinnerChange): void {
    // Copy first: a listener may unsubscribe, or subscribe another, mid-loop.
    const listeners = [...this.listeners]
    let failure: unknown
    let failed = false
    this.dispatching = true
    try {
      for (const listener of listeners) {
        try {
          listener(change)
        } catch (error) {
          if (!failed) {
            failed = true
            failure = error
          }
        }
      }
    } finally {
      this.dispatching = false
    }
    if (failed) throw failure
  }
}

/**
 * A deadline is the first instant the source is gone, for both kinds of limit,
 * so the two can never disagree at the boundary. Hyperion uses the same
 * inclusive test for its single timeout (:411, `timeoutTime_ms <= now`). Read
 * literally, "older than timeoutMs" would be strict and keep the source one
 * more millisecond; the inclusive rule is chosen deliberately, for that parity
 * and for one rule shared by both limits.
 *
 * The inactivity limit only starts counting once the source has delivered:
 * silence before the first frame is not a stall, and Hyperion likewise never
 * expires an input that is still TIMEOUT_NOT_ACTIVE_PRIO (:411 is guarded by
 * `> 0`). The duration counts from registration regardless.
 *
 * On a stall Hyperion deactivates the grabber and keeps it registered
 * (CaptureCont.cpp:295-307, setInputInactive); we drop it, so that a stalled
 * source and a cleared one look the same to everything downstream and there is
 * one way for a source to be absent rather than two.
 */
function isDead (source: Source, now: number): boolean {
  if (now >= source.expiresAt) return true
  return source.input !== null && now >= source.lastSeen + source.timeoutMs
}

/**
 * What makes a winner "the same" for change reporting: the slot and what kind
 * of thing fills it, exactly the two signals Hyperion emits (:465-476). A new
 * buffer from the same source, or the same slot re-registered with the same
 * component, is not a change - the LEDs keep following the same source.
 */
function sameWinner (a: Winner | null, b: Winner | null): boolean {
  if (a === null || b === null) return a === b
  return a.priority === b.priority && a.component === b.component
}

/**
 * Builds the Winner for `chosen`, reusing the previous object when nothing in
 * it would differ so that an unchanged frame hands back the identical object
 * and allocates nothing at 120 Hz.
 */
function snapshot (previous: Winner | null, chosen: Source | null): Winner | null {
  if (chosen === null || chosen.input === null) return null
  if (
    previous !== null &&
    previous.priority === chosen.priority &&
    previous.component === chosen.component &&
    previous.registeredAt === chosen.registeredAt &&
    previous.input === chosen.input
  ) {
    return previous
  }
  return { priority: chosen.priority, component: chosen.component, input: chosen.input, registeredAt: chosen.registeredAt }
}

function checkPriority (priority: number): void {
  if (!Number.isInteger(priority) || priority < HIGHEST_PRIORITY || priority > BACKGROUND_PRIORITY) {
    throw new RangeError(`muxer: priority must be an integer ${HIGHEST_PRIORITY}..${BACKGROUND_PRIORITY}, got ${priority}`)
  }
}

function checkComponent (component: unknown): void {
  if (typeof component !== 'string' || component.length === 0) {
    throw new TypeError(`muxer: component must be a non-empty string, got ${String(component)}`)
  }
}

/**
 * Absent means endless; there is no second spelling of it, so `Infinity` is
 * refused rather than accepted as a synonym. A limit is at least one
 * millisecond: Hyperion's is integer milliseconds (:244), and a positive span
 * below the clock's resolution (Number.MIN_VALUE passes a `> 0` test) would
 * make the deadline the instant of the last frame itself, killing the source
 * on the tick after its own feed.
 */
function checkSpan (name: string, ms: number | undefined): void {
  if (ms === undefined) return
  if (!(Number.isFinite(ms) && ms >= 1)) {
    throw new RangeError(`muxer: ${name} must be a finite number of milliseconds of at least 1, or absent, got ${ms}`)
  }
}

/**
 * Runtime shape check for JavaScript callers, matching what register() does
 * for its options: an `undefined` input would pass the `!== null` liveness
 * test and become a Winner the sampler cannot read, a `null` would silently
 * un-deliver the source, and a wrong `kind` would reach the pipeline as is.
 */
function checkInput (input: unknown): void {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError(`muxer: input must be a SourceInput object, got ${String(input)}`)
  }
  const kind = (input as { kind?: unknown }).kind
  if (kind === 'grid') {
    const grid = (input as { grid?: unknown }).grid
    if (typeof grid !== 'object' || grid === null || !((grid as { data?: unknown }).data instanceof Float32Array)) {
      throw new TypeError('muxer: a grid input needs a LinearGrid with Float32Array data')
    }
    return
  }
  if (kind === 'colors') {
    if (!((input as { colors?: unknown }).colors instanceof Float32Array)) {
      throw new TypeError('muxer: a colors input needs a Float32Array')
    }
    return
  }
  throw new TypeError(`muxer: input kind must be 'grid' or 'colors', got ${String(kind)}`)
}
