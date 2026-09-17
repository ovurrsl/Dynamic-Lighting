'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Card, Input, Label, Surface, TextField } from '@heroui/react'

import { useEngineText, useTranslate } from '#components/Preferences'
import { type EngineConfig } from '#lib/engine/config'
import {
  exportProfiles,
  importProfiles,
  loadProfiles,
  profileId,
  removeProfile,
  storeProfiles,
  upsertProfile,
  type Profile
} from '#lib/profiles'

/**
 * Named rigs: save the layout you are on, come back to it later.
 *
 * Everything stays in this browser. There is no account to sync to and there
 * will not be one - AmbiFlux is open source and runs entirely client side, so
 * the honest way to move a profile between machines is a file you own, not a
 * row on someone's server. Export writes one; import reads it back.
 *
 * Nothing here applies a profile by itself. Loading one hands it upward and the
 * layout card takes it as a draft, so the same rule holds as everywhere else:
 * the strip changes when someone presses Apply, not while they browse.
 */
export function ProfilesCard ({
  current,
  onLoad
}: {
  /** The configuration the editor is showing, which is what "save" saves. */
  current: EngineConfig
  onLoad: (config: EngineConfig, name: string) => void
}) {
  const t = useTranslate()
  const tx = useEngineText()
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [name, setName] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const file = useRef<HTMLInputElement>(null)

  const latest = useRef(profiles)
  latest.current = profiles

  // Read after mount, never during render: the server has no localStorage and
  // the two would disagree on first paint.
  useEffect(() => {
    const stored = loadProfiles()
    setProfiles(stored.profiles)
    if (stored.problem !== undefined) setNotice(tx(stored.problem))
  }, [])

  const persist = useCallback((next: Profile[]): void => {
    setProfiles(next)
    const failure = storeProfiles(next)
    if (failure !== null) setNotice(t('profiles.storeFailed', { reason: failure }))
  }, [t])

  const save = useCallback(() => {
    const trimmed = name.trim()
    if (trimmed === '') { setNotice(t('profiles.needName')); return }
    const existing = latest.current.find((profile) => profile.name === trimmed)
    const id = existing?.id ?? profileId(trimmed, latest.current.map((profile) => profile.id))
    persist(upsertProfile(latest.current, {
      id, name: trimmed, config: current, updatedAt: new Date().toISOString()
    }))
    setName('')
    setNotice(t(existing === undefined ? 'profiles.saved' : 'profiles.updated'))
  }, [current, name, persist, t])

  /**
   * Writes every profile to a file. A blob URL rather than a data: URL because
   * a rig with many profiles outgrows what some browsers accept in a data URL,
   * and it is revoked straight after so the blob is not held for the session.
   */
  const download = useCallback(() => {
    const blob = new Blob([exportProfiles(latest.current)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = t('profiles.fileName')
    link.click()
    URL.revokeObjectURL(url)
    setNotice(t('profiles.exported', { count: latest.current.length }))
  }, [t])

  const upload = useCallback(async (chosen: File) => {
    setNotice(null)
    const text = await chosen.text()
    const outcome = importProfiles(text, latest.current)
    if (outcome.profiles === null) {
      setNotice(t('profiles.readFailed', { reason: outcome.problem ?? '' }))
      return
    }
    persist(outcome.profiles)
    const added = t('profiles.imported', { count: outcome.added })
    // A partial import still imported something. Saying so and then naming what
    // was skipped is more use than either half alone.
    setNotice(outcome.problem === undefined ? added : `${added} ${tx(outcome.problem)}`)
  }, [persist, t])

  return (
    <Card variant="default">
      <Card.Header>
        <Card.Title>{t('profiles.title')}</Card.Title>
        <Card.Description>{t('profiles.description')}</Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-2">
          <TextField className="min-w-48 flex-1" value={name} variant="secondary" onChange={setName}>
            <Label>{t('profiles.name')}</Label>
            <Input placeholder={t('profiles.namePlaceholder')} />
          </TextField>
          <Button onPress={save}>{t('profiles.save')}</Button>
        </div>

        {profiles.length === 0
          ? (
            <p className="text-sm text-muted">{t('profiles.empty')}</p>
            )
          : (
            <ul className="flex flex-col gap-2">
              {profiles.map((profile) => (
                <li key={profile.id}>
                  <Surface className="flex flex-wrap items-center justify-between gap-2 rounded-xl p-3" variant="secondary">
                    <div className="min-w-0">
                      <div className="truncate text-sm">{profile.name}</div>
                      <div className="text-xs text-muted">
                        {profile.config.layout.kind === 'matrix'
                          ? t('profiles.matrix', {
                            columns: profile.config.layout.columns,
                            rows: profile.config.layout.rows
                          })
                          : `${profile.config.layout.top}/${profile.config.layout.right}/${profile.config.layout.bottom}/${profile.config.layout.left}`}
                        {' · '}
                        {profile.config.colorOrder.order.toUpperCase()}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onPress={() => {
                          onLoad(profile.config, profile.name)
                          setNotice(t('profiles.loaded', { name: profile.name }))
                        }}
                      >
                        {t('profiles.load')}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onPress={() => { setNotice(null); persist(removeProfile(latest.current, profile.id)) }}
                      >
                        {t('profiles.delete')}
                      </Button>
                    </div>
                  </Surface>
                </li>
              ))}
            </ul>
            )}

        <div className="flex flex-wrap gap-2">
          <Button isDisabled={profiles.length === 0} size="sm" variant="secondary" onPress={download}>
            {t('profiles.export')}
          </Button>
          <Button size="sm" variant="secondary" onPress={() => file.current?.click()}>
            {t('profiles.import')}
          </Button>
          <input
            accept="application/json,.json"
            className="hidden"
            ref={file}
            type="file"
            onChange={(event) => {
              const chosen = event.target.files?.[0]
              // Cleared so choosing the same file twice fires again.
              event.target.value = ''
              if (chosen !== undefined) void upload(chosen)
            }}
          />
        </div>

        {notice !== null && (
          <Surface className="rounded-xl p-3 text-sm" variant="secondary">{notice}</Surface>
        )}

        <p className="text-xs text-muted">{t('profiles.local')}</p>
      </Card.Content>
    </Card>
  )
}
