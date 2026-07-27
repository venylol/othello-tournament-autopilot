(function () {
  "use strict";
  const PROTOCOL = "ftd-local-autopilot-v1";
  const nonce = crypto.randomUUID();
  let ready = false;
  let port = null;
  let helloTimer = null;
  let heartbeatTimer = null;
  let reloadScheduled = false;
  const pending = [];

  function extensionContextAvailable() {
    try {
      return Boolean(chrome && chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  function recoverInvalidatedContext() {
    if (reloadScheduled) return;
    reloadScheduled = true;
    if (helloTimer) clearInterval(helloTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    // Content scripts cannot reconnect after an extension reload. Reloading the
    // same FTD URL is the only way Chrome can inject the new isolated context.
    setTimeout(() => location.reload(), 250);
  }

  function sendHello() {
    if (ready) return;
    window.postMessage({ protocol: PROTOCOL, type: "FTD_AUTOPILOT_HELLO", nonce }, location.origin);
  }

  function startHelloHandshake() {
    sendHello();
    if (!helloTimer) helloTimer = setInterval(sendHello, 250);
  }

  function connect() {
    if (!extensionContextAvailable()) { recoverInvalidatedContext(); return; }
    try {
      port = chrome.runtime.connect({ name: "ftd-autopilot-tab" });
    } catch (_) {
      recoverInvalidatedContext();
      return;
    }
    port.onMessage.addListener((message) => {
      if (!message || message.type !== "bridge-command" || !message.requestId || !message.command) return;
      port.postMessage({ type: "bridge-trace", requestId: message.requestId, stage: "relay-received" });
      const payload = { protocol: PROTOCOL, type: "FTD_AUTOPILOT_REQUEST", nonce, requestId: message.requestId, command: message.command };
      if (ready) window.postMessage(payload, location.origin);
      else pending.push(payload);
    });
    port.onDisconnect.addListener(() => {
      port = null;
      if (!extensionContextAvailable()) { recoverInvalidatedContext(); return; }
      setTimeout(connect, 1000);
    });
    port.postMessage({ type: "tab-ready", url: location.href });
    if (ready) port.postMessage({ type: "page-bridge-ready", url: location.href });
    if (!heartbeatTimer) {
      heartbeatTimer = setInterval(() => {
        if (!extensionContextAvailable()) { recoverInvalidatedContext(); return; }
        if (port) {
          try { port.postMessage({ type: "tab-heartbeat", url: location.href }); }
          catch (_) { recoverInvalidatedContext(); }
        }
      }, 10000);
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.protocol !== PROTOCOL || event.data.nonce !== nonce) return;
    if (event.data.type === "FTD_AUTOPILOT_HELLO_ACK") {
      ready = true;
      if (helloTimer) clearInterval(helloTimer);
      helloTimer = null;
      while (pending.length) window.postMessage(pending.shift(), location.origin);
      if (port) port.postMessage({ type: "page-bridge-ready", url: location.href });
      return;
    }
    if (event.data.type === "FTD_AUTOPILOT_RESPONSE" && port) {
      port.postMessage({ type: "bridge-trace", requestId: event.data.requestId, stage: "page-response" });
      port.postMessage({
        type: "bridge-response",
        requestId: event.data.requestId,
        ok: event.data.ok === true,
        result: event.data.result,
        error: event.data.error,
      });
    }
    if (event.data.type === "FTD_AUTOPILOT_PROGRESS" && port) {
      port.postMessage({ type: "bridge-trace", requestId: event.data.requestId, stage: "page-started" });
    }
  });

  connect();
  startHelloHandshake();
})();
