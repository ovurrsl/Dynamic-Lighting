/**
 * Getting sound into the engine.
 *
 * The analysis lives in `lib/engine/audio.ts` and is pure; this is the browser
 * glue, and it is shared by both hosts because an `AudioContext` is an
 * `AudioContext` in a page and in an offscreen document alike.
 *
 * Two ways in, and the difference matters to the user rather than to the code:
 *
 * - **The microphone** hears the room, which means it hears the speakers. It
 *   works in every browser including iOS Safari, needs no extension, and picks
 *   up whatever is actually playing - a record player, a television, a guitar.
 *   It also picks up the dog.
 * - **Tab or system audio**, through `getDisplayMedia({ audio: true })`. Clean,
 *   silent, and exactly what is playing - but Chromium only, and only for the
 *   surfaces Chrome is willing to share audio for (a tab, or the whole system
 *   on some platforms). Safari and Firefox return video with no audio track,
 *   which is why this reports what it actually got rather than assuming.
 *
 * Everything is injected - the context constructor, `getUserMedia`,
 * `getDisplayMedia` - so the failure paths that matter (permission refused, a
 * stream with no audio track, a context that will not resume) are exercised in
 * Node against fakes rather than only ever on a real machine with a real
 * microphone.
 */

export type AudioInputKind = 'microphone' | 'display'

export interface AudioSource {
  readonly kind: AudioInputKind
  readonly sampleRate: number
  readonly binCount: number
  /**
   * Fills `bins` with magnitudes 0..1, lowest frequency first.
   *
   * Returns false once the graph is gone - a microphone unplugged, a shared tab
   * closed - so the caller can stop rather than render silence forever.
   */
  read: (bins: Float32Array) => boolean
  stop: () => Promise<void>
}

/** The slice of `AnalyserNode` this needs. */
export interface AnalyserLike {
  fftSize: number
  readonly frequencyBinCount: number
  smoothingTimeConstant: number
  minDecibels: number
  maxDecibels: number
  getByteFrequencyData: (array: Uint8Array) => void
  disconnect?: () => void
}

export interface AudioContextLike {
  readonly sampleRate: number
  readonly state?: string
  createAnalyser: () => AnalyserLike
  createMediaStreamSource: (stream: unknown) => { connect: (node: AnalyserLike) => void, disconnect?: () => void }
  resume?: () => Promise<void>
  close?: () => Promise<void>
}

export interface AudioInputOptions {
  /** Injected; defaults to the browser's own AudioContext. */
  context?: () => AudioContextLike
  /** Injected; defaults to navigator.mediaDevices. */
  getUserMedia?: (constraints: unknown) => Promise<unknown>
  getDisplayMedia?: (constraints: unknown) => Promise<unknown>
  /**
   * FFT size. 2048 gives 1024 bins, about 23 Hz apart at 48 kHz - fine enough
   * to separate a bass note from a kick and coarse enough to stay cheap.
   */
  fftSize?: number
}

const DEFAULT_FFT = 2048

function defaultContext (): AudioContextLike {
  // Through `unknown`: the real AudioContext is structurally wider than the
  // slice above (its connect() takes an AudioNode), and naming that slice is
  // the point - it is what makes this file testable with a fake.
  const scope = globalThis as unknown as {
    AudioContext?: new () => AudioContextLike
    webkitAudioContext?: new () => AudioContextLike
  }
  // webkitAudioContext because older Safari has only the prefixed one, and
  // Safari is a platform this file exists to serve.
  const Ctor = scope.AudioContext ?? scope.webkitAudioContext
  if (Ctor === undefined) throw new Error('audio: this browser has no AudioContext')
  return new Ctor()
}

interface StreamLike {
  getAudioTracks: () => Array<{ stop: () => void, label?: string }>
  getTracks?: () => Array<{ stop: () => void }>
}

async function build (
  kind: AudioInputKind,
  stream: unknown,
  options: AudioInputOptions
): Promise<AudioSource> {
  const tracks = (stream as StreamLike).getAudioTracks?.() ?? []
  if (tracks.length === 0) {
    // Safari and Firefox hand back a display capture with no audio track at
    // all. Saying so is the difference between "this browser cannot do it" and
    // a visualiser that sits at zero with no explanation.
    ;(stream as StreamLike).getTracks?.().forEach((t) => { t.stop() })
    throw new Error(kind === 'display'
      ? 'bu tarayıcı sekme/sistem sesi paylaşmıyor'
      : 'ses izi alınamadı')
  }

  const context = (options.context ?? defaultContext)()
  // Autoplay policy: a context created without a gesture starts suspended and
  // the analyser then reports pure silence with nothing wrong anywhere.
  if (context.state === 'suspended') await context.resume?.()

  const analyser = context.createAnalyser()
  analyser.fftSize = options.fftSize ?? DEFAULT_FFT
  // Smoothing is done in our own visualiser, per band, where it can be a
  // setting. Doing it here as well would be two filters in series with only one
  // of them adjustable.
  analyser.smoothingTimeConstant = 0
  // A wider window than the default -100..-30: music mastered quietly sits
  // below -30 and would clip the top of the display off.
  analyser.minDecibels = -90
  analyser.maxDecibels = -10

  const node = context.createMediaStreamSource(stream)
  node.connect(analyser)

  const bytes = new Uint8Array(analyser.frequencyBinCount)
  let stopped = false

  return {
    kind,
    sampleRate: context.sampleRate,
    binCount: analyser.frequencyBinCount,
    read (bins: Float32Array): boolean {
      if (stopped) return false
      analyser.getByteFrequencyData(bytes)
      const n = Math.min(bins.length, bytes.length)
      for (let i = 0; i < n; i++) bins[i] = (bytes[i] as number) / 255
      // Anything the caller's buffer has beyond our bins is stale, not silent.
      for (let i = n; i < bins.length; i++) bins[i] = 0
      return true
    },
    async stop (): Promise<void> {
      stopped = true
      try { node.disconnect?.() } catch { /* already gone */ }
      try { analyser.disconnect?.() } catch { /* already gone */ }
      for (const track of tracks) {
        try { track.stop() } catch { /* already stopped */ }
      }
      // The video half of a display capture has to go too, or the browser keeps
      // showing "sharing your screen" for an audio visualiser.
      ;(stream as StreamLike).getTracks?.().forEach((t) => { try { t.stop() } catch { /* gone */ } })
      try { await context.close?.() } catch { /* already closed */ }
    }
  }
}

/** The room, through the microphone. Works everywhere, hears everything. */
export async function openMicrophone (options: AudioInputOptions = {}): Promise<AudioSource> {
  const ask = options.getUserMedia ?? ((constraints: unknown) =>
    navigator.mediaDevices.getUserMedia(constraints as MediaStreamConstraints))
  let stream: unknown
  try {
    stream = await ask({
      video: false,
      audio: {
        // All three off: they are designed to make a voice intelligible, and
        // each of them actively fights what a music visualiser wants. Echo
        // cancellation in particular would subtract the speakers - which is the
        // entire signal here.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    })
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    throw new Error(name === 'NotAllowedError' ? 'Mikrofon izni verilmedi.' : describe(error))
  }
  return await build('microphone', stream, options)
}

/** What the browser is playing, with no microphone. Chromium only. */
export async function openDisplayAudio (options: AudioInputOptions = {}): Promise<AudioSource> {
  const ask = options.getDisplayMedia ?? ((constraints: unknown) =>
    navigator.mediaDevices.getDisplayMedia(constraints as DisplayMediaStreamOptions))
  let stream: unknown
  try {
    // Video is requested because Chrome will not share audio on its own: the
    // picker needs a surface. The video track is stopped immediately in build().
    stream = await ask({ video: true, audio: true })
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    throw new Error(name === 'NotAllowedError' ? 'Ses kaynağı seçilmedi.' : describe(error))
  }
  return await build('display', stream, options)
}

function describe (error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return error.name === '' || error.name === 'Error' ? error.message : `${error.name}: ${error.message}`
}
