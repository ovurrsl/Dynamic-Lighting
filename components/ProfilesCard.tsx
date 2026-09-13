'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Card, Input, Label, Surface, TextField } from '@heroui/react'

import {
  ApiError,
  deletePreset,
  listPresets,
  readStoredToken,
  savePreset
} from '#lib/client-api'
import { parseEngineConfig, type EngineConfig } from '#lib/engine/config'
import {
  loadProfiles,
  mergeProfiles,
  profileId,
  removeProfile,
  storeProfiles,
  upsertProfile,
  type Profile
} from '#lib/profiles'

/**
 * Named rigs: save the layout you are on, come back to it later.
 *
 * Local first. The panel opens without a licence, so profiles work without one
 * too; what a licence buys is carrying them between machines. Building it the
 * other way - the feature missing until you pay - would make the free panel
 * worse at the thing it is for.
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
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [name, setName] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [synced, setSynced] = useState(false)

  const latest = useRef(profiles)
  latest.current = profiles

  /**
   * Local profiles first so the list is there immediately, then the server's if
   * there is a licence. Reading storage happens after mount, never during
   * render: the server has none, and the two would disagree on first paint.
   */
  useEffect(() => {
    let cancelled = false
    const local = loadProfiles()
    setProfiles(local.profiles)
    if (local.problem !== undefined) setNotice(local.problem)

    const token = readStoredToken()
    if (token === null) return
    void listPresets(token).then(
      (presets) => {
        if (cancelled) return
        const remote: Profile[] = []
        for (const preset of presets) {
          // The server stores an opaque payload; an older version's is not
          // ours to trust just because it came back from our own API.
          try {
            remote.push({
              id: preset.id,
              name: preset.name,
              config: parseEngineConfig(preset.payload),
              updatedAt: preset.updatedAt
            })
          } catch { /* skipped, like an unreadable local one */ }
        }
        const merged = mergeProfiles(latest.current, remote)
        setProfiles(merged)
        storeProfiles(merged)
        setSynced(true)
      },
      (error: unknown) => {
        if (cancelled) return
        // A licence that the server will not honour is worth saying once; it
        // is not a reason to hide the local profiles.
        setNotice(error instanceof ApiError && error.status === 401
          ? 'Lisans doğrulanamadı; profiller yalnız bu tarayıcıda.'
          : null)
      }
    )
    return () => { cancelled = true }
  }, [])

  const persist = useCallback((next: Profile[]): void => {
    setProfiles(next)
    const failure = storeProfiles(next)
    if (failure !== null) setNotice(`Bu tarayıcıya kaydedilemedi: ${failure}`)
  }, [])

  const save = useCallback(() => {
    const trimmed = name.trim()
    if (trimmed === '') { setNotice('Profile bir ad ver.'); return }
    setNotice(null)
    setBusy(true)

    const existing = latest.current.find((profile) => profile.name === trimmed)
    const id = existing?.id ?? profileId(trimmed, latest.current.map((profile) => profile.id))
    const profile: Profile = { id, name: trimmed, config: current, updatedAt: new Date().toISOString() }
    persist(upsertProfile(latest.current, profile))
    setName('')

    const token = readStoredToken()
    if (token === null) {
      setBusy(false)
      setNotice(existing === undefined ? 'Kaydedildi (bu tarayıcıda).' : 'Güncellendi (bu tarayıcıda).')
      return
    }
    void savePreset(token, id, trimmed, profile.config as unknown as Record<string, unknown>).then(
      () => { setBusy(false); setSynced(true); setNotice('Kaydedildi ve hesaba eşitlendi.') },
      (error: unknown) => {
        setBusy(false)
        // The local copy is already saved; only the sync failed.
        setNotice(`Kaydedildi, ama hesaba eşitlenemedi: ${error instanceof Error ? error.message : String(error)}`)
      }
    )
  }, [current, name, persist])

  const drop = useCallback((profile: Profile) => {
    setNotice(null)
    persist(removeProfile(latest.current, profile.id))
    const token = readStoredToken()
    if (token === null) return
    void deletePreset(token, profile.id).catch((error: unknown) => {
      // 404 means the server never had it - a local-only profile - which is
      // not a failure worth showing.
      if (error instanceof ApiError && error.status === 404) return
      setNotice(`Silindi, ama hesaptan kaldırılamadı: ${error instanceof Error ? error.message : String(error)}`)
    })
  }, [persist])

  return (
    <Card variant="default">
      <Card.Header>
        <Card.Title>Profiller</Card.Title>
        <Card.Description>
          Bir yerleşimi adıyla sakla, sonra geri dön. Masaüstü ve TV aynı şerit
          değil; film ve oyun aynı bant derinliğini istemiyor.
        </Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-2">
          <TextField className="min-w-48 flex-1" value={name} variant="secondary" onChange={setName}>
            <Label>Profil adı</Label>
            <Input placeholder="Masaüstü" />
          </TextField>
          <Button isDisabled={busy} onPress={save}>
            {busy ? 'Kaydediliyor…' : 'Şu ankini kaydet'}
          </Button>
        </div>

        {profiles.length === 0
          ? (
            <p className="text-sm text-muted">
              Henüz profil yok. Yerleşimi ayarla, buraya bir ad yaz ve kaydet.
            </p>
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
                          ? `${profile.config.layout.columns}×${profile.config.layout.rows} matris`
                          : `${profile.config.layout.top}/${profile.config.layout.right}/${profile.config.layout.bottom}/${profile.config.layout.left}`}
                        {' · '}
                        {profile.config.colorOrder.order.toUpperCase()}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" variant="secondary" onPress={() => { onLoad(profile.config, profile.name); setNotice(`"${profile.name}" editöre yüklendi. Şeride göndermek için Uygula.`) }}>
                        Yükle
                      </Button>
                      <Button size="sm" variant="secondary" onPress={() => drop(profile)}>Sil</Button>
                    </div>
                  </Surface>
                </li>
              ))}
            </ul>
            )}

        {notice !== null && (
          <Surface className="rounded-xl p-3 text-sm" variant="secondary">{notice}</Surface>
        )}

        <p className="text-xs text-muted">
          {synced
            ? 'Profiller hesabına eşitleniyor, yani başka bir makinede de duruyorlar.'
            : 'Profiller bu tarayıcıda saklanıyor. Lisans eklersen hesabına eşitlenir ve başka makinelerde de çıkar.'}
        </p>
      </Card.Content>
    </Card>
  )
}
