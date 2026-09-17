/**
 * Every sentence the engine, the two hosts and the panel's storage layer can
 * say to a person, in one place and in English.
 *
 * They used to be Turkish literals scattered through twelve files. The engine
 * runs in an extension whose language is not the panel's and in a page whose
 * user may have chosen any of twelve, and a Turkish sentence in a Japanese
 * panel is the same leak as a raw identifier - only harder to notice for the
 * one person who reads Turkish. English here, because it is what the browser's
 * own errors arrive in (a DOMException message is English wherever it lands)
 * and what the panel's fallback table is; the panel translates what it
 * recognises (lib/i18n/engine-text.ts) and shows the rest as it came.
 *
 * Constants where the sentence is fixed, functions where it carries a value.
 * The panel's table is tested against every entry here, so a sentence added
 * without a translation fails a test rather than shipping raw.
 */
export const TEXT = Object.freeze({
  // The engine.
  noStripEnabled: 'no strip is enabled',
  noNetworkAddress: 'no address for the network output',
  noControlChannel: (link: string): string => `${link}: this link has no control channel`,
  audioSourceLost: 'the audio source went away',
  mixedContent: (transport: string): string =>
    `${transport}: an HTTPS page may not open ws:// (mixed content) - from this page a board on the LAN is reached only over wss:// (a TLS bridge on your network that the board sits behind); run the panel on localhost, where ws:// is allowed, or use the extension host`,

  // Frame sources.
  noVideoInput: 'no video input found',
  videoInputGone: 'the chosen video input is no longer there; pick it again on the Capture page',
  cameraDenied: 'camera permission was refused',
  screenNotPicked: 'no screen was picked',
  noMediaDevices: 'this browser has no media devices',
  noScreenCapture: 'this browser cannot capture a screen',
  noVideoTrack: 'the capture gave no video track',
  no2dContext: 'no 2d canvas context',
  noSelfTest: 'this host has no self-test',
  pairFromExtension: 'pair the port from the extension icon',
  noWebSerial: 'this browser has no Web Serial',

  // Audio.
  noDisplayAudio: 'this browser does not share tab or system audio',
  noAudioTrack: 'no audio track was given',
  microphoneDenied: 'microphone permission was refused',
  audioNotPicked: 'no audio source was picked',

  // Strips.
  stripNotFound: (id: string): string => `strip not found: ${id}`,
  tooManyStrips: (max: number, got?: number): string =>
    got === undefined ? `instances: at most ${max} strips` : `instances: at most ${max} strips, got ${got}`,
  noSuchStrip: (id: string): string => `instances: no strip called ${id}`,
  lastStrip: 'instances: the last strip cannot be removed',
  instancesNotList: 'instances: must be a list',
  instancesEmpty: 'instances: at least one strip is needed',
  duplicateStripId: (id: string): string => `instances: ${id} appears twice`,
  stripNotObject: (index: number): string => `instances: strip ${index} must be an object`,

  // Calibration.
  calibrationTooFew: (total: string): string => `calibration: the strip needs at least 4 LEDs, got ${total}`,
  calibrationFourCorners: (marked: number): string => `calibration: four corners must be marked, ${marked} were`,
  calibrationCornerRange: (max: number, got: string): string => `calibration: a corner index must be 0..${max}, got ${got}`,
  calibrationNotPartition: (runs: string, covered: number, total: number): string =>
    `calibration: the corners do not partition the strip (${runs} = ${covered}, ${total} expected) - mark the corners in the order the light reaches them`,

  // Storage and profiles.
  storageDenied: 'the browser denies local storage',
  profilesUnreadable: (reason: string): string => `the saved profiles could not be read: ${reason}`,
  profilesNotList: 'the saved profiles are not a list',
  profilesDropped: (count: number): string => `${count} profile(s) could not be read and were skipped`,
  notJson: (reason: string): string => `not valid JSON: ${reason}`,
  notProfileFile: 'this is not an AmbiFlux profile file',
  noReadableProfiles: 'the file has no readable profile',

  // The extension, as the panel sees it.
  unexpectedReply: 'the extension gave an unexpected reply',
  configRefused: 'the extension did not accept the configuration',
  boardRefused: 'the board did not accept the request',
  stripsRefused: 'the extension did not accept the strip list'
})
