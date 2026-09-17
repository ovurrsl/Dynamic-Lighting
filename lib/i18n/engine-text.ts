import type { MessageKey } from '#lib/i18n/strings'

/**
 * The engine's sentences (lib/engine/text.ts), in the panel's language.
 *
 * Matched by shape rather than looked up by code, because what reaches the
 * panel is TEXT: an error message out of a promise, a `reason` in a reply from
 * the extension, a `problem` out of storage. Each rule names the English
 * sentence and the key that says it in the chosen language; a captured group
 * becomes a placeholder. Anything no rule matches - a browser's own
 * DOMException, a firmware reply - is shown as it came, which is the honest
 * answer for a sentence we did not write.
 *
 * Tested against every entry in TEXT, so an engine sentence without a rule
 * here fails a test rather than shipping raw.
 */
interface Rule {
  match: RegExp
  key: MessageKey
  /** Placeholder names for the capture groups, in order. */
  names?: string[]
}

const RULES: readonly Rule[] = [
  { match: /^no strip is enabled$/, key: 'engine.noStripEnabled' },
  { match: /^no address for the network output$/, key: 'engine.noNetworkAddress' },
  { match: /^(.+): this link has no control channel$/, key: 'engine.noControlChannel', names: ['link'] },
  { match: /^the audio source went away$/, key: 'engine.audioSourceLost' },
  { match: /^(.+): an HTTPS page may not open ws:\/\/ \(mixed content\) - /, key: 'engine.mixedContent', names: ['transport'] },

  { match: /^no video input found$/, key: 'engine.noVideoInput' },
  { match: /^the chosen video input is no longer there; pick it again on the Capture page$/, key: 'engine.videoInputGone' },
  { match: /^camera permission was refused$/, key: 'engine.cameraDenied' },
  { match: /^no screen was picked$/, key: 'engine.screenNotPicked' },
  { match: /^this browser has no media devices$/, key: 'engine.noMediaDevices' },
  { match: /^this browser cannot capture a screen$/, key: 'engine.noScreenCapture' },
  { match: /^the capture gave no video track$/, key: 'engine.noVideoTrack' },
  { match: /^no 2d canvas context$/, key: 'engine.no2dContext' },
  { match: /^this host has no self-test$/, key: 'engine.noSelfTest' },
  { match: /^pair the port from the extension icon$/, key: 'engine.pairFromExtension' },
  { match: /^this browser has no Web Serial$/, key: 'engine.noWebSerial' },

  { match: /^this browser does not share tab or system audio$/, key: 'engine.noDisplayAudio' },
  { match: /^no audio track was given$/, key: 'engine.noAudioTrack' },
  { match: /^microphone permission was refused$/, key: 'engine.microphoneDenied' },
  { match: /^no audio source was picked$/, key: 'engine.audioNotPicked' },

  { match: /^strip not found: (.+)$/, key: 'engine.stripNotFound', names: ['id'] },
  { match: /^instances: at most (\d+) strips, got (\d+)$/, key: 'engine.tooManyStripsGot', names: ['max', 'got'] },
  { match: /^instances: at most (\d+) strips$/, key: 'engine.tooManyStrips', names: ['max'] },
  { match: /^instances: no strip called (.+)$/, key: 'engine.noSuchStrip', names: ['id'] },
  { match: /^instances: the last strip cannot be removed$/, key: 'engine.lastStrip' },
  { match: /^instances: must be a list$/, key: 'engine.instancesNotList' },
  { match: /^instances: at least one strip is needed$/, key: 'engine.instancesEmpty' },
  { match: /^instances: (.+) appears twice$/, key: 'engine.duplicateStripId', names: ['id'] },
  { match: /^instances: strip (\d+) must be an object$/, key: 'engine.stripNotObject', names: ['index'] },

  { match: /^calibration: the strip needs at least 4 LEDs, got (.+)$/, key: 'engine.calibrationTooFew', names: ['total'] },
  { match: /^calibration: four corners must be marked, (\d+) were$/, key: 'engine.calibrationFourCorners', names: ['marked'] },
  { match: /^calibration: a corner index must be 0\.\.(\d+), got (.+)$/, key: 'engine.calibrationCornerRange', names: ['max', 'got'] },
  { match: /^calibration: the corners do not partition the strip \((.+) = (\d+), (\d+) expected\) - /, key: 'engine.calibrationNotPartition', names: ['runs', 'covered', 'total'] },

  { match: /^the browser denies local storage$/, key: 'engine.storageDenied' },
  { match: /^the saved profiles could not be read: (.+)$/s, key: 'engine.profilesUnreadable', names: ['reason'] },
  { match: /^the saved profiles are not a list$/, key: 'engine.profilesNotList' },
  { match: /^(\d+) profile\(s\) could not be read and were skipped$/, key: 'engine.profilesDropped', names: ['count'] },
  { match: /^not valid JSON: (.+)$/s, key: 'engine.notJson', names: ['reason'] },
  { match: /^this is not an AmbiFlux profile file$/, key: 'engine.notProfileFile' },
  { match: /^the file has no readable profile$/, key: 'engine.noReadableProfiles' },

  { match: /^the extension gave an unexpected reply$/, key: 'engine.unexpectedReply' },
  { match: /^the extension did not accept the configuration$/, key: 'engine.configRefused' },
  { match: /^the board did not accept the request$/, key: 'engine.boardRefused' },
  { match: /^the extension did not accept the strip list$/, key: 'engine.stripsRefused' }
]

export type Translate = (key: MessageKey, values?: Record<string, string | number>) => string

/** The sentence in the panel's language when it is one of ours, else as it came. */
export function localiseEngineText (text: string, t: Translate): string {
  for (const rule of RULES) {
    const found = rule.match.exec(text)
    if (found === null) continue
    const values: Record<string, string> = {}
    rule.names?.forEach((name, at) => { values[name] = found[at + 1] ?? '' })
    return t(rule.key, values)
  }
  return text
}

/** For the test that checks every rule has a key: the keys, in order. */
export const ENGINE_TEXT_KEYS: readonly MessageKey[] = RULES.map((rule) => rule.key)
