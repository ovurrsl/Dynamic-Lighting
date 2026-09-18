'use client'

import { useEffect, useRef, useState } from 'react'
import { Card, Surface } from '@heroui/react'

import { useEngine } from '#components/Engine'
import { useTranslate } from '#components/Preferences'
import { OUTPUT_HZ } from '#lib/engine/runtime'
import { pushSample, sparklinePath, stageShares } from '#lib/telemetry'
import type { MessageKey } from '#lib/i18n/strings'

/**
 * The numbers over time.
 *
 * The device page already reports everything worth knowing, as numbers, one
 * instant at a time. That answers "is it working" and is no use at all for "it
 * was fine and then it wasn't", which is the question anyone actually has: a
 * rate that was 59 and is now 41 looks exactly like a rate that has always been
 * 41.
 *
 * Three tracks, chosen because they break in different ways and the plan's four
 * separate counters say so: what the screen delivered, what the strip received,
 * and the slow tail of the arrival interval. A single line would average the
 * three into a number that hides which stage is at fault.
 *
 * **The stage bar is measured against the BUDGET**, not against the other
 * stages. "The downscale is the biggest stage" is always true and says nothing;
 * "the downscale alone is most of the budget" is something to act on, and it is
 * the plan's own first instruction for this - measure where the time goes,
 * do not guess.
 *
 * The limitation is on the card rather than in a comment: samples arrive about
 * once a second, so a stutter shorter than that is invisible here and always
 * will be. That is exactly why p99 and max sit beside the graph instead of
 * being replaced by it.
 */

const WIDTH = 320
const HEIGHT = 40

/** One capture frame's budget at the engine's output rate. */
const BUDGET_MS = 1000 / OUTPUT_HZ

const STAGE_KEY: Record<'downscale' | 'readback' | 'decode' | 'sample', MessageKey> = {
  downscale: 'telemetry.stage.downscale',
  readback: 'telemetry.stage.readback',
  decode: 'telemetry.stage.decode',
  sample: 'telemetry.stage.sample'
}

const STAGE_FILL: Record<'downscale' | 'readback' | 'decode' | 'sample', string> = {
  downscale: 'bg-primary',
  readback: 'bg-success',
  decode: 'bg-warning',
  sample: 'bg-danger'
}

interface Tracks {
  delivered: number[]
  output: number[]
  tail: number[]
}

export function TelemetryCard () {
  const t = useTranslate()
  const { stats, state } = useEngine()
  const [tracks, setTracks] = useState<Tracks>({ delivered: [], output: [], tail: [] })

  /**
   * Sampled on each distinct report rather than on a timer of our own.
   *
   * The engine decides when it has something to say; a second clock here would
   * either duplicate samples or miss them, and either makes the graph's time
   * axis a lie.
   */
  const lastSeen = useRef<EngineStatsLike | null>(null)
  useEffect(() => {
    if (stats === null || stats === lastSeen.current) return
    lastSeen.current = stats as EngineStatsLike
    setTracks((current) => ({
      delivered: pushSample(current.delivered, stats.deliveredFps),
      output: pushSample(current.output, stats.outputFps),
      tail: pushSample(current.tail, stats.interArrivalMs.p99)
    }))
  }, [stats])

  // Cleared when the engine stops: a line that keeps its old shape across a
  // restart invites reading a stall into a session that never had one.
  useEffect(() => {
    if (state === 'idle') setTracks({ delivered: [], output: [], tail: [] })
  }, [state])

  const stages = stats?.stageMs === undefined ? null : stageShares(stats.stageMs, BUDGET_MS)
  const total = stages === null ? 0 : stages.reduce((sum, stage) => sum + stage.ms, 0)

  return (
    <Card variant="default">
      <Card.Header>
        <Card.Title>{t('telemetry.title')}</Card.Title>
        <Card.Description>{t('telemetry.description')}</Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-5">
        <Track
          label={t('telemetry.delivered')}
          note={t('telemetry.delivered.note')}
          // A capture ceiling, so the line's height means the same thing from
          // one session to the next rather than rescaling to whatever arrived.
          max={Math.max(stats?.source?.frameRate ?? 60, 60)}
          unit="fps"
          values={tracks.delivered}
        />
        <Track
          label={t('telemetry.output')}
          note={t('telemetry.output.note')}
          max={OUTPUT_HZ}
          unit="Hz"
          values={tracks.output}
        />
        <Track
          label={t('telemetry.tail')}
          note={t('telemetry.tail.note')}
          unit="ms"
          values={tracks.tail}
        />

        {stages !== null && (
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-medium">{t('telemetry.stages')}</span>
              <span className="font-mono text-xs text-muted">
                {t('telemetry.stages.budget', { total: total.toFixed(2), budget: BUDGET_MS.toFixed(2) })}
              </span>
            </div>
            {/*
              Against the budget, not against each other, and it is allowed to
              overflow: a bar that always fills exactly would say the pipeline is
              always exactly at its limit, which is the one thing it never is.
            */}
            <div className="flex h-3 w-full overflow-hidden rounded-full bg-default/20">
              {stages.map((stage) => (
                <div
                  key={stage.key}
                  aria-hidden
                  className={STAGE_FILL[stage.key]}
                  style={{ width: `${Math.min(100, stage.share * 100)}%` }}
                />
              ))}
            </div>
            <dl className="flex flex-wrap gap-x-4 gap-y-1">
              {stages.map((stage) => (
                <div key={stage.key} className="flex items-center gap-1.5">
                  <span aria-hidden className={`size-2 rounded-full ${STAGE_FILL[stage.key]}`} />
                  <dt className="text-xs text-muted">{t(STAGE_KEY[stage.key])}</dt>
                  <dd className="font-mono text-xs">{stage.ms.toFixed(2)} ms</dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        <p className="text-xs text-muted">{t('telemetry.resolutionNote')}</p>
      </Card.Content>
    </Card>
  )
}

/** Just enough of the stats to compare by identity. */
type EngineStatsLike = object

function Track ({ label, note, values, max, unit }: {
  label: string
  note: string
  values: number[]
  max?: number
  unit: string
}) {
  const line = sparklinePath(values, { width: WIDTH, height: HEIGHT, ...(max === undefined ? {} : { max }) })
  const latest = values[values.length - 1]

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">{label}</span>
        <span className="font-mono text-xs text-muted">
          {latest === undefined ? '—' : `${latest.toFixed(latest < 10 ? 2 : 0)} ${unit}`}
        </span>
      </div>
      <Surface className="rounded-xl p-2" variant="secondary">
        <svg
          aria-label={label}
          className="h-10 w-full"
          preserveAspectRatio="none"
          role="img"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        >
          {line.d === null
            ? null
            : <path d={line.d} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
        </svg>
      </Surface>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-muted">{note}</span>
        <span className="font-mono text-[10px] text-muted">{line.max.toFixed(0)} {unit}</span>
      </div>
    </div>
  )
}
