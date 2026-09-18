import { AUDIO_KINDS } from '#lib/engine/audio'
import { EFFECT_KINDS } from '#lib/engine/effects'
import { PATTERN_KINDS } from '#lib/engine/patterns'
import type { MessageKey } from '#lib/i18n/strings'

/**
 * The engine's internal identifiers, as things a person can read.
 *
 * The engine reports what it is running by its own names - `single`, `walk`,
 * `spectrum`, `display` - and those reached the badge, the device page and the
 * layer list unchanged: "running · single" in a Turkish panel is the same leak
 * as showing a component tag. Each mapping here is guarded by the list the
 * engine itself exports, so a name it does not know falls back to the raw
 * identifier rather than to a missing-key marker.
 */

const AUDIO_INPUTS = ['microphone', 'display'] as const

export function patternLabel (kind: string, t: (key: MessageKey) => string): string {
  return (PATTERN_KINDS as readonly string[]).includes(kind) ? t(`pattern.kind.${kind}` as MessageKey) : kind
}

export function effectLabel (kind: string, t: (key: MessageKey) => string): string {
  return (EFFECT_KINDS as readonly string[]).includes(kind) ? t(`effects.kind.${kind}` as MessageKey) : kind
}

export function audioKindLabel (kind: string, t: (key: MessageKey) => string): string {
  return (AUDIO_KINDS as readonly string[]).includes(kind) ? t(`audio.kind.${kind}` as MessageKey) : kind
}

export function audioInputLabel (input: string, t: (key: MessageKey) => string): string {
  return (AUDIO_INPUTS as readonly string[]).includes(input) ? t(`audio.input.${input}` as MessageKey) : input
}
