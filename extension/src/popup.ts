import type { Message } from '#lib/extension/messages'

/**
 * The popup is the product's controls, and one thing here genuinely needs a
 * user gesture: pairing the serial port. navigator.serial.requestPort() will
 * not run without one; once granted, the permission belongs to the extension
 * origin and the engine picks the same port up with navigator.serial.getPorts().
 *
 * Choosing a screen does NOT happen here. The engine document opens that picker
 * itself - see offscreen.ts openCapture for why nothing else works.
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
  // The picker is opened by the engine document, not here: a streamId chosen in
  // this popup cannot be used there (see offscreen.ts startPicked). All this
  // button does is ask.
  const message: Message = { type: 'ambiflux/start', target: 'sw' }
  say('Ekran seçici açılıyor…')
  chrome.runtime.sendMessage(message, (response: unknown) => {
    const body = response as { state?: string, error?: string } | undefined
    say(body?.state === 'running'
      ? 'Yakalama çalışıyor.'
      : `Başlatılamadı: ${body?.error ?? JSON.stringify(response)}`)
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
 * Build the engine document while the popup is merely open, so pressing Start
 * shows the screen picker at once instead of after a document boot.
 */
chrome.runtime.sendMessage({ type: 'ambiflux/prepare', target: 'sw' } satisfies Message, () => {
  // Nothing to do with the answer; the failure path is the start button's.
  void chrome.runtime.lastError
})

const ping: Message = { type: 'ambiflux/ping', target: 'sw' }
chrome.runtime.sendMessage(ping, (response: Message | undefined) => {
  if (response?.type === 'ambiflux/pong') say(`Motor: ${response.engine} · v${response.version}`)
})
