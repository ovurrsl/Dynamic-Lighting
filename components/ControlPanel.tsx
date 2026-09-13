'use client'

import { useEffect, useState } from 'react'
import { Button, Surface, Switch } from '@heroui/react'

import { ColourCard } from '#components/ColourCard'
import { DeviceCard } from '#components/DeviceCard'
import { useEngine } from '#components/Engine'
import { EngineConfigProvider, useEngineConfig } from '#components/EngineConfig'
import { GuideCard } from '#components/GuideCard'
import { LayoutCard } from '#components/LayoutCard'
import { OverviewCard } from '#components/OverviewCard'
import { PreferencesMenu } from '#components/PreferencesMenu'
import { useTranslate } from '#components/Preferences'
import { ProfilesCard } from '#components/ProfilesCard'
import { RoadmapCard } from '#components/RoadmapCard'
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

function sectionBody (id: SectionId, enabled: boolean) {
  switch (id) {
    case 'overview': return <OverviewCard />
    case 'colour': return <ColourCard enabled={enabled} />
    case 'layout': return <LayoutSection />
    case 'profiles': return <ProfilesSection />
    case 'device': return <DeviceCard />
    case 'guide': return <GuideCard />
    case 'roadmap': return <RoadmapCard />
  }
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
function EngineBadge () {
  const t = useTranslate()
  const { probe, state, stats } = useEngine()
  if (probe === null) return null
  if (!probe.available) {
    return (
      <span className="flex items-center gap-2 text-xs">
        <span aria-hidden className="size-2 rounded-full bg-default" />
        <span className="text-muted">{t('device.absent')}</span>
      </span>
    )
  }
  const fps = stats === null ? null : stats.deliveredFps
  return (
    <span className="flex items-center gap-2 text-xs">
      <span
        aria-hidden
        className={`size-2 rounded-full ${
          state === 'running' ? 'bg-success' : state === 'error' ? 'bg-danger' : 'bg-default'
        }`}
      />
      <span className="text-muted">
        {t(
          state === 'running' ? 'device.state.running'
            : state === 'starting' ? 'device.state.starting'
              : state === 'error' ? 'device.state.error' : 'device.state.idle'
        )}
        {state === 'running' && fps !== null && ` · ${fps.toFixed(0)} fps`}
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
  const [isEnabled, setIsEnabled] = useState(true)
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
        <div className="mt-auto px-3">
          <EngineBadge />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-default/30 p-4 lg:p-6">
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
          <div className="flex flex-wrap items-end gap-4">
            <PreferencesMenu />
            <Switch className="pb-2" isSelected={isEnabled} size="md" onChange={setIsEnabled}>
              <Switch.Content>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
                {t('app.lighting')}
              </Switch.Content>
            </Switch>
          </div>
        </header>

        {menuOpen && (
          <Surface className="m-4 rounded-2xl p-4 lg:hidden" variant="secondary">
            <Nav current={current} onNavigate={go} />
            <div className="mt-4 px-3">
              <EngineBadge />
            </div>
          </Surface>
        )}

        <main className="flex-1 p-4 lg:p-6">{sectionBody(current, isEnabled)}</main>
      </div>
    </div>
  )
}
