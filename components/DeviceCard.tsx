'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button, Card, Surface } from '@heroui/react'

import { fetchStatus, probeExtension, stopEngine, type ExtensionProbe } from '#lib/extension-client'
import type { EngineState, EngineStats } from '#lib/extension/messages'

const STATE_LABEL: Record<EngineState, string> = {
  idle: 'Beklemede',
  starting: 'Başlıyor',
  running: 'Çalışıyor',
  error: 'Hata'
}

const LINK_LABEL = {
  none: 'bağlı değil',
  loopback: 'cihazsız (loopback)',
  port: 'seri port'
} as const

const fmt = (n: number, digits = 1): string => (Number.isFinite(n) ? n.toFixed(digits) : '–')

/**
 * The live view of the engine. Polls the extension once a second while it
 * answers; the numbers are the four counters the plan asks for, shown apart
 * because they fail apart. A missing extension is shown as missing.
 */
export function DeviceCard () {
  const [probe, setProbe] = useState<ExtensionProbe | null>(null)
  const [stats, setStats] = useState<EngineStats | null>(null)
  const [state, setState] = useState<EngineState>('idle')
  const [version, setVersion] = useState<string>('')

  const reprobe = useCallback(() => {
    setProbe(null)
    void probeExtension().then(setProbe)
  }, [])

  useEffect(() => { reprobe() }, [reprobe])

  useEffect(() => {
    if (probe?.available !== true) return
    let cancelled = false
    const tick = async (): Promise<void> => {
      const status = await fetchStatus()
      if (cancelled) return
      if (status === null) {
        setProbe({ available: false, reason: 'not-installed', detail: 'yanıt yok' })
        return
      }
      setStats(status.stats)
      setState(status.state)
      setVersion(status.version)
    }
    void tick()
    const id = setInterval(() => { void tick() }, 1000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [probe])

  return (
    <Card variant="default">
      <Card.Header>
        <Card.Title>Cihaz</Card.Title>
        <Card.Description>
          Yakalama ve seri port tarayıcı eklentisinde çalışıyor; bu kart eklentiden okur.
        </Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-4">
        {probe === null && <p className="text-sm text-muted">Eklenti aranıyor…</p>}

        {probe?.available === false && (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-muted">
              {probe.reason === 'no-runtime'
                ? 'Bu tarayıcı eklenti mesajlaşmasını desteklemiyor (Chromium gerekir) ya da bu adres eklentinin izin listesinde değil.'
                : 'Eklenti bulunamadı. Yüklüyse Chrome\'da chrome://extensions altında etkin olduğundan emin olun.'}
            </span>
            <Button size="sm" variant="secondary" onPress={reprobe}>Yeniden dene</Button>
          </div>
        )}

        {probe?.available === true && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <span className="rounded-full bg-background/60 px-3 py-1 text-sm">
                {STATE_LABEL[state]}
              </span>
              <span className="text-xs text-muted">eklenti v{version}</span>
              {state === 'running' && (
                <Button size="sm" variant="secondary" onPress={() => { void stopEngine() }}>Durdur</Button>
              )}
            </div>

            {stats !== null && (
              <Surface className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-xl p-3 font-mono text-xs sm:grid-cols-3" variant="secondary">
                <Stat label="teslim edilen" value={`${fmt(stats.deliveredFps)} fps`} />
                <Stat label="varış p50 / p99" value={`${fmt(stats.interArrivalMs.p50)} / ${fmt(stats.interArrivalMs.p99)} ms`} />
                <Stat label="çıkış" value={`${fmt(stats.outputFps)} fps`} />
                <Stat label="yakalama boşluğu" value={String(stats.captureGaps)} />
                <Stat label="hat düşüşü" value={String(stats.pipelineDrops)} />
                <Stat label="seri düşüşü" value={String(stats.link.dropped)} />
                <Stat label="işleme p50 / p99" value={`${fmt(stats.processMs.p50, 2)} / ${fmt(stats.processMs.p99, 2)} ms`} />
                <Stat label="bağlantı" value={LINK_LABEL[stats.link.mode] + (stats.link.port !== undefined ? ` ${stats.link.port}` : '')} />
                <Stat
                  label="kenar"
                  value={stats.border.unknown ? 'bilinmiyor' : `${stats.border.topBottom} / ${stats.border.leftRight} px`}
                />
                {stats.link.mode === 'loopback' && (
                  <Stat label="kabul / ret" value={`${stats.link.accepted} / ${stats.link.rejected}`} />
                )}
                {stats.source !== undefined && (
                  <Stat label="kaynak" value={`${stats.source.width}×${stats.source.height}`} />
                )}
                {stats.error !== undefined && <Stat label="hata" value={stats.error} />}
              </Surface>
            )}

            <p className="text-xs text-muted">
              Yakalamayı başlatmak için araç çubuğundaki eklenti simgesine tıklayın: ekran seçimi
              tarayıcı gereği eklentinin kendi penceresinden yapılır ve Chrome oturumu boyunca geçerlidir.
              Seri port aynı yerden eşleştirilir; port yoksa motor cihazsız modda çalışır ve kareleri sayar.
              DRM korumalı içerik (Netflix, Prime, Disney+) yakalamada siyah gelir; bu bir tarayıcı sınırıdır.
            </p>
          </>
        )}
      </Card.Content>
    </Card>
  )
}

function Stat ({ label, value }: { label: string, value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  )
}
