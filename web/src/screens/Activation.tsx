import { useState } from 'react'
import {
  Button,
  Description,
  InputGroup,
  Label,
  Surface,
  TextField
} from '@heroui/react'

import { ApiError, activate, machineFingerprint, type LicenceGrant } from '../lib/api'

const APP_VERSION = '0.1.0'

/**
 * Turns a server error code into something a customer can act on.
 *
 * The server distinguishes these cases deliberately (not-found vs inactive vs
 * seat limit), so throwing that away and showing "activation failed" would waste
 * the design and generate support mail.
 */
function explain (error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'Sunucuya ulaşılamadı. Bağlantını kontrol edip tekrar dene.'
  }

  switch (error.code) {
    case 'licence_not_found':
      return 'Bu lisans anahtarı bulunamadı. Satın alma e-postandaki anahtarla karşılaştır.'
    case 'licence_inactive':
      return 'Bu lisans artık etkin değil. İade veya iptal edilmiş olabilir.'
    case 'seat_limit_reached':
      return 'Bu lisansın tüm cihaz hakları kullanılmış. Başka bir cihazdan çıkış yapman gerekiyor.'
    case 'rate_limited':
      return 'Çok fazla deneme yapıldı. Bir dakika bekleyip tekrar dene.'
    case 'validation_failed':
      return error.problems.length > 0
        ? `Girdi hatalı: ${error.problems.join(', ')}`
        : 'Girdiğin anahtar beklenen biçimde değil.'
    default:
      return 'Beklenmeyen bir hata oluştu. Sorun sürerse destek ile iletişime geç.'
  }
}

interface ActivationProps {
  onActivated: (grant: LicenceGrant) => void
}

export function Activation ({ onActivated }: ActivationProps) {
  const [licenceKey, setLicenceKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isPending, setIsPending] = useState(false)

  const submit = async () => {
    setError(null)
    setIsPending(true)
    try {
      const fingerprint = await machineFingerprint()
      onActivated(await activate(licenceKey.trim(), fingerprint, APP_VERSION))
    } catch (caught) {
      setError(explain(caught))
    } finally {
      setIsPending(false)
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <Surface
        className="flex w-full max-w-md flex-col gap-6 rounded-3xl p-8"
        variant="default"
      >
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">AmbiFlux</h1>
          <p className="text-sm text-muted">
            Devam etmek için lisans anahtarını gir.
          </p>
        </div>

        <TextField
          isDisabled={isPending}
          isInvalid={error !== null}
          value={licenceKey}
          onChange={setLicenceKey}
        >
          <Label>Lisans anahtarı</Label>
          {/* variant="secondary" because this sits inside a Surface. */}
          <InputGroup variant="secondary">
            <InputGroup.Input
              autoComplete="off"
              placeholder="AF-XXXX-XXXX-XXXX"
              spellCheck={false}
            />
          </InputGroup>
          <Description>
            Anahtar yalnızca bu cihaz için kaydedilir. Makine adın ya da başka bir
            kimlik bilgisi gönderilmez.
          </Description>
        </TextField>

        {error !== null && (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        )}

        <Button
          fullWidth
          isDisabled={licenceKey.trim().length < 8}
          isPending={isPending}
          variant="primary"
          onPress={() => { void submit() }}
        >
          Etkinleştir
        </Button>
      </Surface>
    </div>
  )
}
