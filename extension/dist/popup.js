// extension/src/popup.ts
var status = document.getElementById("status");
var say = (text) => {
  status.textContent = text;
};
document.getElementById("serial")?.addEventListener("click", async () => {
  try {
    const port = await navigator.serial.requestPort();
    const info = port.getInfo();
    say(`Port e\u015Fle\u015Fti (VID ${info.usbVendorId?.toString(16) ?? "?"}, PID ${info.usbProductId?.toString(16) ?? "?"}).
Motor ba\u011Flan\u0131yor\u2026`);
    const message = { type: "ambiflux/serial", target: "sw" };
    chrome.runtime.sendMessage(message, (response) => say(`Seri: ${JSON.stringify(response)}`));
  } catch (error) {
    say(`Port se\xE7ilmedi: ${error instanceof Error ? error.message : String(error)}`);
  }
});
document.getElementById("start")?.addEventListener("click", () => {
  const message = { type: "ambiflux/start", target: "sw" };
  say("Ekran se\xE7ici a\xE7\u0131l\u0131yor\u2026");
  chrome.runtime.sendMessage(message, (response) => {
    const body = response;
    say(body?.state === "running" ? "Yakalama \xE7al\u0131\u015F\u0131yor." : `Ba\u015Flat\u0131lamad\u0131: ${body?.error ?? JSON.stringify(response)}`);
  });
});
document.getElementById("selftest")?.addEventListener("click", () => {
  const message = { type: "ambiflux/selftest", target: "sw" };
  chrome.runtime.sendMessage(message, (response) => {
    const body = response;
    say(body?.state === "running" ? "S\u0131nama \xE7al\u0131\u015F\u0131yor: motor \xFCretilmi\u015F bir resmi i\u015Fliyor." : `S\u0131nama ba\u015Flat\u0131lamad\u0131: ${body?.error ?? JSON.stringify(response)}`);
  });
});
document.getElementById("stop")?.addEventListener("click", () => {
  const message = { type: "ambiflux/stop", target: "sw" };
  chrome.runtime.sendMessage(message, (response) => say(`Durduruldu: ${JSON.stringify(response)}`));
});
chrome.runtime.sendMessage({ type: "ambiflux/prepare", target: "sw" }, () => {
  void chrome.runtime.lastError;
});
var ping = { type: "ambiflux/ping", target: "sw" };
chrome.runtime.sendMessage(ping, (response) => {
  if (response?.type === "ambiflux/pong") say(`Motor: ${response.engine} \xB7 v${response.version}`);
});
//# sourceMappingURL=popup.js.map
