import { EFFECT_KINDS } from '#lib/engine/effects'
import type { MessageKey } from '#lib/i18n/strings'

/**
 * The roadmap's data, out of its card so a test can read it.
 *
 * What the test guards: every item's keys exist in the message table, the
 * effect count is the engine's own and not a number typed into a sentence,
 * and no item claims a state the page cannot render.
 */

/**
 * Two states, not four. 'next' and 'planned' existed while the list still had
 * things ahead of it; every item is now built or ruled out, and a state no
 * item can have is a promise the page cannot keep.
 */
export type RoadmapState = 'done' | 'never'

export interface RoadmapItem {
  title: MessageKey
  body: MessageKey
  state: RoadmapState
  values?: Record<string, number>
}

export const ROADMAP_ITEMS: readonly RoadmapItem[] = [
  // Reordered 2026-09-14. An iPhone was shown capturing its own screen and
  // feeding our sampler - and iOS Safari has no Web Serial, WebUSB, WebHID or
  // Web Bluetooth, so a captured frame there has nowhere to go. The output
  // abstraction and the network driver stopped being "later".
  //
  // The 'done' entries stay on the page rather than being deleted. This list is
  // the answer to "what can this thing do compared with Hyperion", and a list
  // that only ever shows what is missing answers half of it.
  { title: 'roadmap.sink.title', body: 'roadmap.sink.body', state: 'done' },
  { title: 'roadmap.wled.title', body: 'roadmap.wled.body', state: 'done' },
  { title: 'roadmap.host.title', body: 'roadmap.host.body', state: 'done' },
  // Counted from the engine's own list, so the sentence cannot fall behind it
  // again: it said "seven" while twelve were shipping.
  { title: 'roadmap.effects.title', body: 'roadmap.effects.body', state: 'done', values: { count: EFFECT_KINDS.length } },
  { title: 'roadmap.audio.title', body: 'roadmap.audio.body', state: 'done' },
  { title: 'roadmap.capture.title', body: 'roadmap.capture.body', state: 'done' },
  { title: 'roadmap.priority.title', body: 'roadmap.priority.body', state: 'done' },
  { title: 'roadmap.events.title', body: 'roadmap.events.body', state: 'done' },
  { title: 'roadmap.instances.title', body: 'roadmap.instances.body', state: 'done' },
  { title: 'roadmap.udp.title', body: 'roadmap.udp.body', state: 'never' },
  { title: 'roadmap.spi.title', body: 'roadmap.spi.body', state: 'never' }
]

export const ROADMAP_STATE_KEY: Record<RoadmapState, MessageKey> = {
  done: 'roadmap.state.done',
  never: 'roadmap.state.never'
}
