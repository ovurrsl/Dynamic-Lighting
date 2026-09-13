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
  chrome.desktopCapture.chooseDesktopMedia(['screen', 'window'], (streamId) => {
    if (!streamId) { say('Ekran seçilmedi.'); return }
    const message: Message = { type: 'ambiflux/start', target: 'sw', streamId }
    chrome.runtime.sendMessage(message, (response: unknown) => {
      say(`Başlatıldı: ${JSON.stringify(response)}`)
    })
  })
})

document.getElementById('stop')?.addEventListener('click', () => {
  const message: Message = { type: 'ambiflux/stop', target: 'sw' }
  chrome.runtime.sendMessage(message, (response: unknown) => say(`Durduruldu: ${JSON.stringify(response)}`))
})

const ping: Message = { type: 'ambiflux/ping', target: 'sw' }
chrome.runtime.sendMessage(ping, (response: Message | undefined) => {
  if (response?.type === 'ambiflux/pong') say(`Motor: ${response.engine} · v${response.version}`)
})
