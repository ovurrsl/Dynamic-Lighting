import type { Message } from '#lib/extension/messages'

/**
 * The popup is where user gestures happen, and two things in this product are
 * gated on a gesture that the offscreen document cannot provide:
 *
 * 1. Choosing what to capture. chrome.desktopCapture.chooseDesktopMedia shows
 *    the picker and returns a streamId that is single-use and expires within
 *    seconds - so it is forwarded to the engine immediately, not stored.
 * 2. Pairing the serial port. navigator.serial.requestPort() needs a gesture;
 *    once granted, the permission belongs to the extension origin and the
 *    offscreen document retrieves the same port with navigator.serial.getPorts().
 */

const status = document.getElementById('status') as HTMLDivElement
const say = (text: string): void => { status.textContent = text }

document.getElementById('serial')?.addEventListener('click', async () => {
  try {
    const port = await navigator.serial.requestPort()
    const info = port.getInfo()
    say(`Port eşleşti (VID ${info.usbVendorId?.toString(16) ?? '?'}, PID ${info.usbProductId?.toString(16) ?? '?'}).\nMotor bağlanıyor…`)
    // The permission now belongs to the extension origin; tell the engine to
    // look again with getPorts() and open it.
    const message: Message = { type: 'ambiflux/serial', target: 'sw' }
    chrome.runtime.sendMessage(message, (response: unknown) => say(`Seri: ${JSON.stringify(response)}`))
  } catch (error) {
    say(`Port seçilmedi: ${error instanceof Error ? error.message : String(error)}`)
  }
})

document.getElementById('start')?.addEventListener('click', () => {
  const asked = performance.now()
  chrome.desktopCapture.chooseDesktopMedia(['screen', 'window'], (streamId) => {
    if (!streamId) { say('Ekran seçilmedi.'); return }
    // How long the id had been alive when the engine got it. It expires within
    // seconds, so this number is the first thing to look at when a capture
    // fails for no apparent reason.
    const aged = Math.round(performance.now() - asked)
    const message: Message = { type: 'ambiflux/start', target: 'sw', streamId }
    chrome.runtime.sendMessage(message, (response: unknown) => {
      const body = response as { state?: string, error?: string } | undefined
      say(body?.state === 'running'
        ? `Yakalama çalışıyor. (seçim ${aged} ms sürdü)`
        : `Başlatılamadı: ${body?.error ?? JSON.stringify(response)}\n(seçim ${aged} ms sürdü)`)
    })
  })
})

/**
 * Runs the engine on a generated picture. No picker, no screen, no board - so
 * when the strip stays dark this is what separates "the engine is broken" from
 * "the capture never started".
 */
document.getElementById('selftest')?.addEventListener('click', () => {
  const message: Message = { type: 'ambiflux/selftest', target: 'sw' }
  chrome.runtime.sendMessage(message, (response: unknown) => {
    const body = response as { state?: string, error?: string } | undefined
    say(body?.state === 'running'
      ? 'Sınama çalışıyor: motor üretilmiş bir resmi işliyor.'
      : `Sınama başlatılamadı: ${body?.error ?? JSON.stringify(response)}`)
  })
})

document.getElementById('stop')?.addEventListener('click', () => {
  const message: Message = { type: 'ambiflux/stop', target: 'sw' }
  chrome.runtime.sendMessage(message, (response: unknown) => say(`Durduruldu: ${JSON.stringify(response)}`))
})

/**
 * Build the engine document while the popup is merely open. By the time a
 * screen has been chosen it already exists, so the streamId is consumed
 * immediately instead of waiting out the document's startup - and the id only
 * lives for a few seconds.
 */
chrome.runtime.sendMessage({ type: 'ambiflux/prepare', target: 'sw' } satisfies Message, () => {
  // Nothing to do with the answer; the failure path is the start button's.
  void chrome.runtime.lastError
})

const ping: Message = { type: 'ambiflux/ping', target: 'sw' }
chrome.runtime.sendMessage(ping, (response: Message | undefined) => {
  if (response?.type === 'ambiflux/pong') say(`Motor: ${response.engine} · v${response.version}`)
})
