// extension/src/popup.ts
var msg = (key, ...substitutions) => chrome.i18n.getMessage(key, substitutions);
for (const element of document.querySelectorAll("[data-msg]")) {
  const text = msg(element.dataset.msg ?? "");
  if (text !== "") element.textContent = text;
}
var status = document.getElementById("status");
var say = (text) => {
  status.textContent = text;
};
document.getElementById("serial")?.addEventListener("click", async () => {
  try {
    const port = await navigator.serial.requestPort();
    const info = port.getInfo();
    say(msg("statusPaired", info.usbVendorId?.toString(16) ?? "?", info.usbProductId?.toString(16) ?? "?"));
    const message = { type: "ambiflux/serial", target: "sw" };
    chrome.runtime.sendMessage(message, (response) => say(msg("statusSerialReply", JSON.stringify(response))));
  } catch (error) {
    say(msg("statusNoPort", error instanceof Error ? error.message : String(error)));
  }
});
document.getElementById("start")?.addEventListener("click", () => {
  const message = { type: "ambiflux/start", target: "sw" };
  say(msg("statusPickerOpening"));
  chrome.runtime.sendMessage(message, (response) => {
    const body = response;
    say(body?.state === "running" ? msg("statusCaptureRunning") : msg("statusStartFailed", body?.error ?? JSON.stringify(response)));
  });
});
document.getElementById("selftest")?.addEventListener("click", () => {
  const message = { type: "ambiflux/selftest", target: "sw" };
  chrome.runtime.sendMessage(message, (response) => {
    const body = response;
    say(body?.state === "running" ? msg("statusSelfTestRunning") : msg("statusSelfTestFailed", body?.error ?? JSON.stringify(response)));
  });
});
document.getElementById("stop")?.addEventListener("click", () => {
  const message = { type: "ambiflux/stop", target: "sw" };
  chrome.runtime.sendMessage(message, (response) => say(msg("statusStopped", JSON.stringify(response))));
});
chrome.runtime.sendMessage({ type: "ambiflux/prepare", target: "sw" }, () => {
  void chrome.runtime.lastError;
});
var ping = { type: "ambiflux/ping", target: "sw" };
chrome.runtime.sendMessage(ping, (response) => {
  if (response?.type === "ambiflux/pong") say(msg("statusEngine", response.engine, response.version));
});
//# sourceMappingURL=popup.js.map
