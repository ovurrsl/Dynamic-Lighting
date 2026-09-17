import { CORNERS, type Corner } from '#lib/engine/layout'
import { TEXT } from '#lib/engine/text'

/**
 * Working out a rig's layout by walking its strip.
 *
 * This is the piece that makes the application worth anything to somebody whose
 * monitor is not the one it was developed on. Everything else can be typed in -
 * badly, and wrongly, and with a preview that looks plausible while the strip
 * disagrees. The four numbers that actually matter (how many LEDs on each edge)
 * cannot be counted reliably by eye on a 108-LED reel, and the two that go with
 * them (which corner the wire starts at, which way it runs) are exactly the
 * kind of thing people get backwards.
 *
 * So the strip tells us instead: light one LED at a time, and let the person
 * press a button when the light turns a corner. The arithmetic below is all
 * that is needed afterwards, and it is pure - the panel owns the walking, this
 * owns the answer.
 *
 * The one thing this cannot do is guess. If the four marks do not partition the
 * loop - because they were pressed out of order, or one was missed - it says
 * so rather than producing a layout that is wrong in a way nobody will notice
 * until the strip is on the wall.
 */

/** What the user marked, and the two orientation answers. */
export interface CornerMarks {
  /**
   * The LED index at each corner, in the order the light reached them.
   *
   * The FIRST LED of each new edge: the instruction is to press as the light
   * turns the corner, which is the moment it lands on the next edge.
   */
  indices: readonly number[]
  /** Which corner of the monitor the first marked LED sits at. */
  firstCorner: Corner
  /** Whether the light ran clockwise from there, seen from the front. */
  clockwise: boolean
  /** LEDs on the strip. */
  total: number
}

export interface CalibratedLayout {
  top: number
  right: number
  bottom: number
  left: number
  start: Corner
  clockwise: boolean
  offset: number
}

export class CalibrationError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'CalibrationError'
  }
}

/**
 * The corner the light reaches next, and the edge it travels to get there.
 *
 * Clockwise is seen FROM THE FRONT, which is how the person doing this is
 * looking at it - and the opposite of how it looks from behind the monitor,
 * where the strip actually is. That is why the panel asks rather than infers.
 */
const CLOCKWISE_NEXT: Readonly<Record<Corner, Corner>> = Object.freeze({
  'top-left': 'top-right',
  'top-right': 'bottom-right',
  'bottom-right': 'bottom-left',
  'bottom-left': 'top-left'
})

const ANTICLOCKWISE_NEXT: Readonly<Record<Corner, Corner>> = Object.freeze({
  'top-left': 'bottom-left',
  'bottom-left': 'bottom-right',
  'bottom-right': 'top-right',
  'top-right': 'top-left'
})

/** Which edge you travel leaving a corner in each direction. */
const CLOCKWISE_EDGE: Readonly<Record<Corner, keyof CalibratedLayout>> = Object.freeze({
  'top-left': 'top',
  'top-right': 'right',
  'bottom-right': 'bottom',
  'bottom-left': 'left'
})

const ANTICLOCKWISE_EDGE: Readonly<Record<Corner, keyof CalibratedLayout>> = Object.freeze({
  'top-left': 'left',
  'bottom-left': 'bottom',
  'bottom-right': 'right',
  'top-right': 'top'
})

/** The corners the light reaches, in order, starting from `firstCorner`. */
export function cornerOrder (firstCorner: Corner, clockwise: boolean): Corner[] {
  const next = clockwise ? CLOCKWISE_NEXT : ANTICLOCKWISE_NEXT
  const order: Corner[] = [firstCorner]
  for (let i = 1; i < CORNERS.length; i++) order.push(next[order[i - 1] as Corner])
  return order
}

export function layoutFromCorners (marks: CornerMarks): CalibratedLayout {
  const { indices, firstCorner, clockwise, total } = marks
  if (!Number.isInteger(total) || total < 4) {
    throw new CalibrationError(TEXT.calibrationTooFew(String(total)))
  }
  if (indices.length !== 4) {
    throw new CalibrationError(TEXT.calibrationFourCorners(indices.length))
  }
  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0 || index >= total) {
      throw new CalibrationError(TEXT.calibrationCornerRange(total - 1, String(index)))
    }
  }

  // How far the light travelled from each corner to the next: that IS the
  // number of LEDs on the edge it crossed.
  const runs = indices.map((at, i) => (((indices[(i + 1) % 4] as number) - at) % total + total) % total)
  const covered = runs.reduce((sum, run) => sum + run, 0)
  if (covered !== total) {
    // The marks do not partition the loop. Pressed out of order, or one was
    // missed - and a layout derived from them would be wrong in a way nobody
    // notices until the strip is on the wall.
    throw new CalibrationError(TEXT.calibrationNotPartition(runs.join(' + '), covered, total))
  }

  const order = cornerOrder(firstCorner, clockwise)
  const edge = clockwise ? CLOCKWISE_EDGE : ANTICLOCKWISE_EDGE
  const counts = { top: 0, right: 0, bottom: 0, left: 0 }
  order.forEach((corner, i) => {
    counts[edge[corner] as 'top' | 'right' | 'bottom' | 'left'] = runs[i] as number
  })

  return {
    ...counts,
    start: firstCorner,
    clockwise,
    // `offset` counts from the corner the way the strip runs, and the LED AT
    // that corner is `indices[0]` - so LED 0 is the rest of the way round.
    offset: (total - (indices[0] as number)) % total
  }
}

/**
 * Steps a walk position, wrapping.
 *
 * Its own function because the wizard drives it from four different controls
 * and an off-by-one at the wrap is the sort of thing that makes a user mark the
 * wrong LED as a corner and never find out why the result was refused.
 */
export function stepWalk (at: number, by: number, total: number): number {
  if (total <= 0) return 0
  return ((at + by) % total + total) % total
}
