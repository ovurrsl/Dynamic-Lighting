import type { MessageKey } from '#lib/i18n/strings'

/**
 * The panel's navigation, as data.
 *
 * Until now the panel was one scrolling page, and that worked while it held six
 * cards. It does not survive what is coming: Hyperion has an effect engine,
 * eighteen network drivers, audio reactivity, priority layers, per-instance
 * configuration and a colour-adjustment page of its own, and stacking all of
 * that vertically produces a page nobody can find anything in.
 *
 * So the shape here is Hyperion's own: grouped sections in a sidebar, one
 * section at a time. Adding a feature becomes one entry in this table plus one
 * component - not another card wedged into an ever-longer column.
 *
 * This file is deliberately pure and free of JSX, which is what lets it be
 * tested: the ordering, the ids and the hash round-trip are the parts that
 * break silently, and `node --test` cannot strip JSX.
 */

export const SECTION_IDS = [
  'overview',
  'colour',
  'effects',
  'audio',
  'layout',
  'capture',
  'calibration',
  'schedule',
  'profiles',
  'device',
  'guide',
  'roadmap'
] as const

export type SectionId = (typeof SECTION_IDS)[number]

/**
 * The groups, in the order they appear. Named after what the user is trying to
 * do rather than after our modules: someone looking for the LED count is
 * looking for the hardware, not for "engine config".
 */
export const SECTION_GROUPS = ['control', 'setup', 'system', 'help'] as const

export type SectionGroup = (typeof SECTION_GROUPS)[number]

export interface Section {
  id: SectionId
  group: SectionGroup
  /** The sidebar label and the page heading; the same string, on purpose. */
  titleKey: MessageKey
  descriptionKey: MessageKey
  /**
   * A single emoji, used as the sidebar glyph. Not an icon set: a dependency
   * whose whole job is twenty small pictures is a dependency to keep updated
   * forever, and every platform this has to run on already ships these.
   */
  glyph: string
}

export const SECTIONS: readonly Section[] = [
  { id: 'overview', group: 'control', titleKey: 'nav.overview', descriptionKey: 'nav.overview.description', glyph: '◉' },
  { id: 'colour', group: 'control', titleKey: 'nav.colour', descriptionKey: 'nav.colour.description', glyph: '◆' },
  { id: 'effects', group: 'control', titleKey: 'nav.effects', descriptionKey: 'nav.effects.description', glyph: '✦' },
  { id: 'audio', group: 'control', titleKey: 'nav.audio', descriptionKey: 'nav.audio.description', glyph: '♪' },
  { id: 'layout', group: 'setup', titleKey: 'nav.layout', descriptionKey: 'nav.layout.description', glyph: '▦' },
  { id: 'capture', group: 'setup', titleKey: 'nav.capture', descriptionKey: 'nav.capture.description', glyph: '▣' },
  { id: 'calibration', group: 'setup', titleKey: 'nav.calibration', descriptionKey: 'nav.calibration.description', glyph: '◈' },
  { id: 'schedule', group: 'system', titleKey: 'nav.schedule', descriptionKey: 'nav.schedule.description', glyph: '◷' },
  { id: 'profiles', group: 'system', titleKey: 'nav.profiles', descriptionKey: 'nav.profiles.description', glyph: '▤' },
  { id: 'device', group: 'system', titleKey: 'nav.device', descriptionKey: 'nav.device.description', glyph: '⚡' },
  { id: 'guide', group: 'help', titleKey: 'nav.guide', descriptionKey: 'nav.guide.description', glyph: 'ⓘ' },
  { id: 'roadmap', group: 'help', titleKey: 'nav.roadmap', descriptionKey: 'nav.roadmap.description', glyph: '↗' }
]

export const DEFAULT_SECTION: SectionId = 'overview'

/** The label for each group heading in the sidebar. */
export const GROUP_TITLE: Record<SectionGroup, MessageKey> = {
  control: 'nav.group.control',
  setup: 'nav.group.setup',
  system: 'nav.group.system',
  help: 'nav.group.help'
}

export function isSectionId (value: unknown): value is SectionId {
  return typeof value === 'string' && (SECTION_IDS as readonly string[]).includes(value)
}

export function sectionsInGroup (group: SectionGroup): Section[] {
  return SECTIONS.filter((section) => section.group === group)
}

export function findSection (id: SectionId): Section {
  const found = SECTIONS.find((section) => section.id === id)
  // Unreachable while SectionId is derived from SECTIONS' own ids, and here so
  // a future id added to the union but not to the table fails loudly.
  if (found === undefined) throw new Error(`unknown section: ${id}`)
  return found
}

/**
 * Which section a URL names.
 *
 * The hash, not a path. The whole panel is one client component with shared
 * engine state, so real routes would buy server rendering it cannot use and
 * cost a provider around every page; the hash gives the two things that
 * actually matter - a link someone can send, and a working back button - with
 * no routing at all.
 */
export function sectionFromHash (hash: string): SectionId {
  const id = hash.replace(/^#\/?/, '')
  return isSectionId(id) ? id : DEFAULT_SECTION
}

export function hashForSection (id: SectionId): string {
  return `#/${id}`
}
