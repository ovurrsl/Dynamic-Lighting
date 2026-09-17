/**
 * A WebSocket address from whatever a user typed.
 *
 * The output cards take an ADDRESS, not a URL: `192.168.1.40`, `wled.local:81`,
 * a line pasted from the browser's bar with `http://` on the front, or a
 * `ws://` URL from someone who knows what they are doing. The two drivers used
 * to turn that into a URL with string surgery, and string surgery is how an
 * IPv6 address became a port number, an upper-case `WS://` became `ws://WS://`,
 * and `http://wled.local/ws` became `/ws/ws`.
 *
 * The platform's parser does this properly. What it cannot do is explain,
 * which is why every refusal here names what was wrong: a WebSocket that fails
 * to construct says `SyntaxError` and nothing else, and from the panel that
 * reads as a device that is switched off.
 */

const SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i

/** What a user may type in front of an address, and what it becomes. */
const TO_WS: Readonly<Record<string, string>> = Object.freeze({
  http: 'ws',
  https: 'wss',
  ws: 'ws',
  wss: 'wss'
})

/**
 * Parses an address into a URL with a `ws:` or `wss:` scheme.
 *
 * The scheme is compared without regard to case, `http(s)` is mapped to the
 * socket scheme it implies, and an address with no scheme gets `ws://`. A bare
 * IPv6 address is bracketed first, because a parser cannot otherwise tell its
 * colons from a port's. The fragment is dropped (a WebSocket refuses one) and
 * embedded credentials are refused outright (so does the socket, silently).
 */
export function parseAddress (typed: string, label: string): URL {
  const trimmed = typed.trim()
  if (trimmed === '') throw new RangeError(`${label}: host is empty`)
  const match = SCHEME.exec(trimmed)
  let text: string
  if (match === null) {
    const bareV6 = /^[0-9a-f:]+$/i.test(trimmed) && trimmed.split(':').length > 2
    text = `ws://${bareV6 ? `[${trimmed}]` : trimmed}`
  } else {
    const typedScheme = match[1] as string
    const scheme = TO_WS[typedScheme.toLowerCase()]
    if (scheme === undefined) throw new RangeError(`${label}: ${typedScheme}:// is not a WebSocket address`)
    text = `${scheme}://${trimmed.slice(match[0].length)}`
  }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new RangeError(`${label}: not an address: ${trimmed}`)
  }
  if (url.hostname === '') throw new RangeError(`${label}: host is empty`)
  if (url.username !== '' || url.password !== '') {
    throw new RangeError(`${label}: an address cannot carry a user name or password`)
  }
  url.hash = ''
  return url
}

/** The URL string for `url` with `path` in place of whatever it had. */
export function formatAddress (url: URL, path: string): string {
  return `${url.protocol}//${url.host}${path}${url.search}`
}
