'use client'

import { useEffect, useState } from 'react'
import { Button, Surface } from '@heroui/react'

import { AudioCard } from '#components/AudioCard'
import { AutoLayersCard } from '#components/AutoLayersCard'
import { CalibrationCard } from '#components/CalibrationCard'
import { CapabilitiesCard } from '#components/CapabilitiesCard'
import { CaptureCard } from '#components/CaptureCard'
import { SamplingCard } from '#components/SamplingCard'
import { ColourAdjustCard } from '#components/ColourAdjustCard'
import { ColourCard } from '#components/ColourCard'
import { BoardNetworkCard } from '#components/BoardNetworkCard'
import { BoardSettingsCard } from '#components/BoardSettingsCard'
import { BorderCard } from '#components/BorderCard'
import { DeviceCard } from '#components/DeviceCard'
import { EffectsCard } from '#components/EffectsCard'
import { HostCard } from '#components/HostCard'
import { COMPONENT_KEY, LayersCard } from '#components/LayersCard'
import { useEngine } from '#components/Engine'
import { EngineConfigProvider, useEngineConfig } from '#components/EngineConfig'
import { GuideCard } from '#components/GuideCard'
import { InstancesCard, StripPicker } from '#components/InstancesCard'
import { LayoutCard } from '#components/LayoutCard'
import { OverviewCard } from '#components/OverviewCard'
import { PreferencesMenu } from '#components/PreferencesMenu'
import { patternLabel } from '#components/labels'
import { useTranslate } from '#components/Preferences'
import { ProfilesCard } from '#components/ProfilesCard'
import { RoadmapCard } from '#components/RoadmapCard'
import { ScheduleCard } from '#components/ScheduleCard'
import { TelemetryCard } from '#components/TelemetryCard'
import { SmoothingCard } from '#components/SmoothingCard'
import {
  DEFAULT_SECTION,
  GROUP_TITLE,
  SECTION_GROUPS,
  findSection,
  hashForSection,
  sectionFromHash,
  sectionsInGroup,
  type SectionId
} from '#lib/sections'
import type { EngineState, EngineStats } from '#lib/extension/messages'
import type { MessageKey } from '#lib/i18n/strings'

/**
 * The shell: a sidebar of grouped sections, one section at a time.
 *
 * This replaces a single scrolling page, and the reason is what is coming
 * rather than what is here. Six cards in a column was fine; the roadmap adds an
 * effect engine, network devices, audio, colour adjustment, smoothing profiles,
 * border modes and priority layers, and stacking those vertically produces a
 * page in which nothing can be found. Hyperion's own web interface is built
 * exactly this way, and for exactly this reason.
 *
 * The navigation is data (`lib/sections.ts`), so adding a feature is one entry
 * plus one component - not another card wedged into an ever-longer column.
 */

function sectionBody (id: SectionId) {
  switch (id) {
    case 'overview': return <OverviewSection />
    case 'colour': return <ColourCard />
    case 'strips': return <InstancesCard />
    case 'layout': return <LayoutSection />
    case 'capture': return <CaptureSection />
    case 'picture': return <PictureSection />
    case 'calibration': return <CalibrationCard />
    case 'profiles': return <ProfilesSection />
    case 'effects': return <EffectsSection />
    case 'audio': return <AudioCard />
    case 'schedule': return <ScheduleCard />
    case 'device': return <DeviceSection />
    case 'guide': return <GuideCard />
    case 'roadmap': return <RoadmapCard />
  }
}

/**
 * The device page is diagnostics, and the browser's own capabilities belong
 * with the engine's counters: both answer "why is my strip dark", and the
 * capability table answers it for the half of the world that cannot run the
 * extension at all.
 *
 * The board's own network settings sit here too rather than on the LED hardware
 * page: that page is about what the strip looks like, this one is about the
 * board, and putting it on a network is the second half of choosing a network
 * transport - without it the firmware's socket has no address to be dialled at.
 */
function DeviceSection () {
  return (
    <div className="flex flex-col gap-6">
      <HostCard />
      <DeviceCard />
      <TelemetryCard />
      <BoardSettingsCard />
      <BoardNetworkCard />
      <CapabilitiesCard />
    </div>
  )
}

/**
 * The overview: what the engine is doing, and what the strip is showing.
 *
 * The layer list sits here rather than on the device page because it is a
 * CONTROL, not a diagnostic - it is where someone stops the effect that is
 * covering their capture.
 */
function OverviewSection () {
  return (
    <div className="flex flex-col gap-6">
      <OverviewCard />
      <LayersCard />
    </div>
  )
}

/**
 * What the screen gives us, and how a region of it becomes one LED colour.
 *
 * The two belong together: the analysis grid decides how many pixels a region
 * holds, and the sampling mode decides what is done with them. Reading the
 * grid's "cells per LED" on one page and choosing the reduction on another
 * would split one decision across two.
 */
function CaptureSection () {
  return (
    <div className="flex flex-col gap-6">
      <CaptureCard />
      <SamplingCard />
    </div>
  )
}

/**
 * The picture page: everything between the captured frame and the strip.
 *
 * Smoothing and colour correction sit together because they are the same kind
 * of decision - how the picture is TREATED, rather than where it comes from or
 * where it goes - and because anyone tuning one is usually about to tune the
 * other - and the border detector is the third, because it decides which part
 * of the frame is picture in the first place.
 */
function PictureSection () {
  return (
    <div className="flex flex-col gap-6">
      <SmoothingCard />
      <ColourAdjustCard />
      <BorderCard />
    </div>
  )
}

/**
 * Effects, and the two layers nobody starts by hand.
 *
 * The background and the boot animation sit with the effects because that is
 * what they usually are, and because the alternative is a page of their own
 * holding two switches.
 */
function EffectsSection () {
  return (
    <div className="flex flex-col gap-6">
      <EffectsCard />
      <AutoLayersCard />
    </div>
  )
}

/** Thin wrappers, so the two cards that need shared state do not have to know about the shell. */
function LayoutSection () {
  const { loaded, setConfig, setDraft } = useEngineConfig()
  return <LayoutCard loaded={loaded} onConfig={setConfig} onDraft={setDraft} />
}

function ProfilesSection () {
  const { draft, load } = useEngineConfig()
  return <ProfilesCard current={draft} onLoad={(profile) => load(profile)} />
}

/**
 * A live word for the engine, in the sidebar, on every page.
 *
 * The point of splitting the panel is that you are usually not on the device
 * page; the cost is that the device page was where you could see whether
 * anything was running. This pays that back in one line.
 */
/**
 * What the badge says beside "running".
 *
 * An effect or a test pattern has NO CAPTURE, so `deliveredFps` is 0 for them -
 * and "running · 0 fps" beside a strip that is visibly animating reads as a
 * fault. What is running is the useful thing to say there; the capture rate is
 * only meaningful when something is being captured.
 */
function describeRate (stats: EngineStats, t: (key: MessageKey) => string): string {
  // Through the string table, like the layer tags below: an effect's `kind` is
  // an internal identifier, and "twinkle" in a Turkish panel is the same leak
  // as showing a component tag.
  if (stats.audio !== undefined) return t(`audio.kind.${stats.audio.kind}` as MessageKey)
  if (stats.effect !== undefined) return t(`effects.kind.${stats.effect}` as MessageKey)
  if (stats.pattern !== undefined) return patternLabel(stats.pattern, t)
  // No capture layer means `deliveredFps` counts nothing, and "0 fps" beside a
  // strip that is visibly lit reads as a fault. Naming what is actually
  // showing is both true and more use - and this now covers the background and
  // the startup layer as well as a plain colour.
  const winning = stats.layers?.find((layer) => layer.winning)
  if (winning !== undefined && winning.component !== 'capture') {
    // Through the same table the layer list uses: this is the one place in the
    // panel where an internal tag would otherwise reach a user.
    const key = COMPONENT_KEY[winning.component]
    return key === undefined ? winning.component : t(key)
  }
  return `${stats.deliveredFps.toFixed(0)} fps`
}

/** One place for the four state words, so the badge and the device page agree. */
const STATE_LABEL: Record<EngineState, MessageKey> = {
  idle: 'device.state.idle',
  starting: 'device.state.starting',
  running: 'device.state.running',
  error: 'device.state.error'
}

function EngineBadge () {
  const t = useTranslate()
  const { probe, host, pageCapable, state, stats } = useEngine()
  // The badge used to speak for the extension, because the extension was the
  // engine. Now it speaks for whichever host is live - saying "not installed"
  // beside a strip the page is actively driving is worse than saying nothing.
  if (host === 'page') {
    const running = state === 'running'
    return (
      <span className="flex items-center gap-2 text-xs">
        <span aria-hidden className={`size-2 rounded-full ${running ? 'bg-success' : state === 'error' ? 'bg-danger' : 'bg-default'}`} />
        <span className="text-muted">
          {t(STATE_LABEL[state])}
          {running && stats !== null && ` · ${describeRate(stats, t)}`}
          {` · ${t('host.page')}`}
        </span>
      </span>
    )
  }
  if (probe === null) return null
  if (!probe.available) {
    // With a page host available this is a choice, not a dead end.
    if (pageCapable) return null
    return (
      <span className="flex items-center gap-2 text-xs">
        <span aria-hidden className="size-2 rounded-full bg-default" />
        <span className="text-muted">{t('device.absent')}</span>
      </span>
    )
  }
  return (
    <span className="flex items-center gap-2 text-xs">
      <span
        aria-hidden
        className={`size-2 rounded-full ${
          state === 'running' ? 'bg-success' : state === 'error' ? 'bg-danger' : 'bg-default'
        }`}
      />
      <span className="text-muted">
        {t(STATE_LABEL[state])}
        {state === 'running' && stats !== null && ` · ${describeRate(stats, t)}`}
      </span>
    </span>
  )
}

function Nav ({ current, onNavigate }: { current: SectionId, onNavigate: (id: SectionId) => void }) {
  const t = useTranslate()
  return (
    <nav aria-label={t('nav.menu')} className="flex flex-col gap-5">
      {SECTION_GROUPS.map((group) => (
        <div key={group} className="flex flex-col gap-1">
          <h2 className="px-3 text-xs font-semibold uppercase tracking-wide text-muted">
            {t(GROUP_TITLE[group])}
          </h2>
          {sectionsInGroup(group).map((section) => {
            const active = section.id === current
            return (
              <a
                key={section.id}
                aria-current={active ? 'page' : undefined}
                className={`flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition-colors ${
                  active ? 'bg-default/20 font-medium' : 'text-muted hover:bg-default/10'
                }`}
                href={hashForSection(section.id)}
                onClick={() => onNavigate(section.id)}
              >
                <span aria-hidden className="w-4 text-center opacity-70">{section.glyph}</span>
                {t(section.titleKey)}
              </a>
            )
          })}
        </div>
      ))}
    </nav>
  )
}

export function ControlPanel () {
  return (
    <EngineConfigProvider>
      <Shell />
    </EngineConfigProvider>
  )
}

function Shell () {
  const t = useTranslate()
  const [menuOpen, setMenuOpen] = useState(false)
  /**
   * Starts on the default and is corrected from the hash after mount, for the
   * same reason the language is: the server cannot see a fragment - browsers
   * never send it - so rendering the hash's section on the server is not merely
   * hard, it is impossible.
   */
  const [current, setCurrent] = useState<SectionId>(DEFAULT_SECTION)

  useEffect(() => {
    const read = (): void => setCurrent(sectionFromHash(window.location.hash))
    read()
    window.addEventListener('hashchange', read)
    return () => window.removeEventListener('hashchange', read)
  }, [])

  const section = findSection(current)

  const go = (id: SectionId): void => {
    setCurrent(id)
    setMenuOpen(false)
  }

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-7xl">
      {/*
        Two renders of one nav rather than one repositioned by CSS. A drawer
        that overlays the page needs a focus trap, an escape key and a scroll
        lock to be usable with a keyboard; this needs none of them, because on a
        narrow screen the menu is simply part of the page.
      */}
      <aside className="hidden w-60 shrink-0 flex-col gap-6 border-e border-default/30 p-4 lg:flex">
        <div className="px-3">
          <h1 className="text-lg font-semibold">AmbiFlux</h1>
          <p className="text-xs text-muted">{t('app.tagline')}</p>
        </div>
        <Nav current={current} onNavigate={go} />
        {/*
          The strip picker lives beside the navigation because it changes what
          every page below it means: the layout, the capture settings and the
          board's network all belong to the selected strip. It renders nothing
          at all with one strip, which is every fresh installation.
        */}
        <StripPicker />
        <div className="mt-auto px-3">
          <EngineBadge />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-default/30 p-4 lg:p-6">
          {/*
            The page's h1 is the product name in the aside - which is
            display:none on a phone, and display:none removes it from the
            accessibility tree too, so a phone had a page with no h1 at all.
            This one is read by a screen reader and seen by nobody, and it is
            itself removed at lg where the aside's takes over: one h1 at every
            width, and the h2 section title below keeps its place under it.
          */}
          <h1 className="sr-only lg:hidden">AmbiFlux</h1>
          <div className="flex min-w-0 items-center gap-3">
            <Button
              className="lg:hidden"
              size="sm"
              variant="secondary"
              onPress={() => setMenuOpen((open) => !open)}
            >
              {t('nav.menu')}
            </Button>
            <div className="min-w-0">
              <h2 className="truncate text-xl font-semibold">{t(section.titleKey)}</h2>
              <p className="truncate text-sm text-muted">{t(section.descriptionKey)}</p>
            </div>
          </div>
          {/*
            No "Lighting" switch here any more. It looked like a master switch
            for the strip and blanked one preview on one page - a control that
            promises more than it does is worse than none. Stopping the strip
            is the overview's Stop button, and it really stops it.
          */}
          <div className="flex flex-wrap items-end gap-4">
            <PreferencesMenu />
          </div>
        </header>

        {menuOpen && (
          <Surface className="m-4 rounded-2xl p-4 lg:hidden" variant="secondary">
            <Nav current={current} onNavigate={go} />
            <StripPicker className="mt-4" />
            <div className="mt-4 px-3">
              <EngineBadge />
            </div>
          </Surface>
        )}

        <main className="flex-1 p-4 lg:p-6">{sectionBody(current)}</main>
      </div>
    </div>
  )
}
