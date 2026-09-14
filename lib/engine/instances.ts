import { DEFAULT_ENGINE_CONFIG, parseEngineConfig, type EngineConfig } from '#lib/engine/config'

/**
 * More than one strip at once.
 *
 * Hyperion's last structural feature and the one this project did not have: a
 * single installation driving several LED instances, each with its own layout
 * and its own device. Desk and TV, both following the same screen, wired
 * differently and plugged into different boards.
 *
 * This is NOT what profiles are. A profile is a configuration you switch TO;
 * an instance is a configuration that runs ALONGSIDE the others. Switching is
 * what you do when one of them is wrong; running together is what you do when
 * both are right.
 *
 * Three decisions, and the first is the whole design:
 *
 * - **The capture is shared; nothing else is.** Two instances asking the
 *   browser for a screen means two pickers and two grants, and a user who
 *   picked the wrong window in the second one gets an ambilight that follows
 *   something else. One capture is read once and the frame is handed to every
 *   instance (`lib/engine/fanout.ts`), so there is one picker no matter how
 *   many strips are attached. Everything downstream of that frame - crop,
 *   grid, sampling, smoothing, output - is per instance, because a desk strip
 *   and a TV strip have nothing in common but the screen.
 * - **An instance owns a whole `EngineConfig`.** Not a layout with a shared
 *   everything-else: the output transport differs (one on USB, one on WiFi),
 *   the crop differs (a strip behind a monitor and one behind a TV are looking
 *   at different rectangles of the same desktop), and the colour order differs
 *   the moment the two strips are from different reels.
 * - **There is never zero.** An empty list is a state the panel has no button
 *   to leave: with no instance there is nothing to configure, and "add one" has
 *   to know what to add. Removing the last instance is refused here rather than
 *   defended against in every card that reads the list.
 *
 * Everything in this file is pure. The list is validated coming out of storage
 * exactly as the configuration is, and for the same reason: it was written by
 * an older version of the panel, which is a trust boundary like any other.
 */

export interface Instance {
  /**
   * Stable and never shown. Rules, statistics and stored state key off this, so
   * renaming a strip must not orphan any of them.
   */
  id: string
  /**
   * What the user calls it. Free text, and deliberately NOT unique: someone
   * with two identical strips either side of a desk may reasonably call them
   * the same thing, and refusing that would be the panel arguing with them.
   */
  name: string
  /**
   * Off means "configured but not running". Worth having as a state: the
   * alternative is deleting a strip to silence it for an evening, and then
   * typing its whole layout back in.
   */
  enabled: boolean
  config: EngineConfig
}

/** How many strips one host will drive. */
export const MAX_INSTANCES = 8

/**
 * The list a fresh install has: exactly one, carrying the reference rig.
 *
 * Named rather than left blank because the panel shows the name in a selector
 * from the first launch, and an unnamed row reads as a bug.
 */
export function defaultInstances (): Instance[] {
  return [{ id: 'instance-1', name: 'Şerit 1', enabled: true, config: DEFAULT_ENGINE_CONFIG }]
}

/**
 * The next free id, derived rather than random.
 *
 * A counter keeps stored state readable and every test deterministic;
 * `crypto.randomUUID` would give neither and buys nothing here, since the list
 * is small and its ids never leave this installation. Taken ids are skipped, so
 * removing instance-2 and adding one does not resurrect its stored state under
 * a name the user has forgotten.
 */
export function nextInstanceId (existing: readonly Instance[]): string {
  const taken = new Set(existing.map((instance) => instance.id))
  for (let n = 1; ; n++) {
    const id = `instance-${n}`
    if (!taken.has(id)) return id
  }
}

export interface AddInstanceOptions {
  name?: string
  config?: EngineConfig
  enabled?: boolean
}

/**
 * Appends one.
 *
 * The new instance copies the configuration of the one it was added from, not
 * the reference rig: someone adding a second strip to the same desk has just
 * finished describing the first, and making them type it all again is the kind
 * of thing that loses a customer at the second strip. They can change what
 * differs, which is usually the output and a handful of LED counts.
 */
export function addInstance (list: readonly Instance[], options: AddInstanceOptions = {}): Instance[] {
  if (list.length >= MAX_INSTANCES) {
    throw new RangeError(`instances: en fazla ${MAX_INSTANCES} şerit sürülebilir`)
  }
  const id = nextInstanceId(list)
  const from = list[list.length - 1]
  return [...list, {
    id,
    name: options.name ?? `Şerit ${list.length + 1}`,
    enabled: options.enabled ?? true,
    config: options.config ?? from?.config ?? DEFAULT_ENGINE_CONFIG
  }]
}

/** Refuses to remove the last one; see the note at the top of the file. */
export function removeInstance (list: readonly Instance[], id: string): Instance[] {
  const next = list.filter((instance) => instance.id !== id)
  if (next.length === list.length) throw new RangeError(`instances: ${id} diye bir şerit yok`)
  if (next.length === 0) throw new RangeError('instances: son şerit silinemez')
  return next
}

/** Replaces one in place, keeping the order - the selector is a list the user reads. */
export function updateInstance (
  list: readonly Instance[],
  id: string,
  change: Partial<Omit<Instance, 'id'>>
): Instance[] {
  let found = false
  const next = list.map((instance) => {
    if (instance.id !== id) return instance
    found = true
    return { ...instance, ...change, id: instance.id }
  })
  if (!found) throw new RangeError(`instances: ${id} diye bir şerit yok`)
  return next
}

export function findInstance (list: readonly Instance[], id: string): Instance | null {
  return list.find((instance) => instance.id === id) ?? null
}

/** The ones that should actually be running. */
export function enabledInstances (list: readonly Instance[]): Instance[] {
  return list.filter((instance) => instance.enabled)
}

// ---------------------------------------------------------------------------
// The wire.
// ---------------------------------------------------------------------------

export class InstanceError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'InstanceError'
  }
}

/**
 * Validates a stored or received list.
 *
 * A duplicate id is the failure that matters here and it is refused rather than
 * repaired: two instances sharing an id means two strips sharing stored state,
 * and the symptom is one of them silently taking the other's settings whenever
 * either is saved. Everything else is filled in - a missing name is cosmetic,
 * a missing `enabled` means on.
 */
export function parseInstances (value: unknown): Instance[] {
  if (!Array.isArray(value)) throw new InstanceError('instances: bir dizi olmalı')
  if (value.length === 0) throw new InstanceError('instances: en az bir şerit olmalı')
  if (value.length > MAX_INSTANCES) {
    throw new InstanceError(`instances: en fazla ${MAX_INSTANCES} şerit sürülebilir, ${value.length} geldi`)
  }
  const seen = new Set<string>()
  return value.map((entry, index) => {
    const instance = parseInstance(entry, index)
    if (seen.has(instance.id)) throw new InstanceError(`instances: ${instance.id} iki kez geçiyor`)
    seen.add(instance.id)
    return instance
  })
}

export function parseInstance (value: unknown, index = 0): Instance {
  if (typeof value !== 'object' || value === null) {
    throw new InstanceError(`instances: ${index}. şerit bir nesne olmalı`)
  }
  const raw = value as Record<string, unknown>
  const id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : `instance-${index + 1}`
  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : `Şerit ${index + 1}`
  return {
    id,
    name,
    enabled: raw.enabled !== false,
    // Thrown as it comes: a ConfigError names the field that is wrong, which is
    // more use than an "instance 2 is invalid" that hides it.
    config: parseEngineConfig(raw.config)
  }
}
