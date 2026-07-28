"use strict";

const LOCAL_ROOT = "http://127.0.0.1:4174";
const EXPECTED_EXTENSION_ID = "kbojmgkjbgokbbhlpkapiobfjnpacnme";
const BRIDGE_VERSION = "0.3.4";
let activePort = null;
let activeTabId = null;
let bridgeId = crypto.randomUUID();
let pageUrl = "";
let pageReady = false;
let polling = false;
let rescuePolling = false;
let registerRetryTimer = null;
let lastBridgeError = "";

function extensionHeaders() {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "X-FTD-Bridge-Extension": chrome.runtime.id,
    "X-FTD-Bridge-Id": bridgeId,
  };
}

async function localFetch(path, options = {}) {
  if (chrome.runtime.id !== EXPECTED_EXTENSION_ID) throw new Error("扩展 ID 与固定 allowlist 不一致");
  return fetch(`${LOCAL_ROOT}${path}`, { cache: "no-store", ...options, headers: { ...extensionHeaders(), ...(options.headers || {}) } });
}

async function registerBridge() {
  if (!activePort || !pageReady) return;
  try {
    const response = await localFetch("/api/automation/bridge/register", {
      method: "POST",
      body: JSON.stringify({ bridgeId, tabId: activeTabId, pageUrl, extensionId: chrome.runtime.id, bridgeVersion: BRIDGE_VERSION }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`bridge register HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    lastBridgeError = "";
    if (registerRetryTimer) clearTimeout(registerRetryTimer);
    registerRetryTimer = null;
    void pollCommands();
  } catch (error) {
    lastBridgeError = String(error && error.message || error);
    if (!registerRetryTimer && activePort && pageReady) {
      registerRetryTimer = setTimeout(() => {
        registerRetryTimer = null;
        void registerBridge();
      }, 1200);
    }
  }
}

async function sendBridgeHeartbeat() {
  if (!activePort || !pageReady) return;
  try {
    const response = await localFetch("/api/automation/bridge/heartbeat", {
      method: "POST",
      body: JSON.stringify({ bridgeId }),
    });
    if (!response.ok) throw new Error(`bridge heartbeat HTTP ${response.status}`);
    lastBridgeError = "";
  } catch (error) {
    lastBridgeError = String(error && error.message || error);
    void registerBridge();
  } finally {
    // MV3 may discard a retry timer when the worker sleeps. Content-relay
    // heartbeats wake the worker, so every heartbeat also repairs a missing
    // command-poll loop.
    if (activePort && pageReady && !polling) void pollCommands();
    // A fetch can remain pending while `polling` stays true. Always issue one
    // independent short poll after a heartbeat so queued commands cannot be
    // stranded behind that stale flag.
    if (activePort && pageReady) void rescuePollCommands();
  }
}

async function postBridgeTrace(requestId, stage) {
  try {
    await localFetch("/api/automation/bridge/trace", {
      method: "POST",
      body: JSON.stringify({ bridgeId, requestId, stage }),
    });
  } catch (_) {}
}

async function deliverBridgeCommand(payload) {
  if (!payload || !payload.command || !payload.requestId || !activePort) return false;
  void postBridgeTrace(payload.requestId, "worker-received");
  try {
    activePort.postMessage({ type: "bridge-command", requestId: payload.requestId, command: payload.command });
  } catch (error) {
    await postBridgeResponse({
      requestId: payload.requestId,
      ok: false,
      error: { code: "relay-delivery-failed", message: String(error && error.message || error) },
    });
  }
  return true;
}

async function rescuePollCommands() {
  if (rescuePolling || !activePort || !pageReady) return;
  rescuePolling = true;
  try {
    const response = await localFetch("/api/automation/bridge/next", {
      method: "POST",
      body: JSON.stringify({ bridgeId, timeoutMs: 1000 }),
    });
    if (!response.ok) throw new Error(`bridge rescue poll HTTP ${response.status}`);
    await deliverBridgeCommand(await response.json());
  } catch (error) {
    lastBridgeError = String(error && error.message || error);
  } finally {
    rescuePolling = false;
  }
}

async function pollCommands() {
  if (polling || !activePort || !pageReady) return;
  polling = true;
  try {
    while (activePort && pageReady) {
      const response = await localFetch("/api/automation/bridge/next", {
        method: "POST",
        body: JSON.stringify({ bridgeId, timeoutMs: 10000 }),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`bridge poll HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
      }
      const payload = await response.json();
      await deliverBridgeCommand(payload);
    }
  } catch (error) {
    lastBridgeError = String(error && error.message || error);
    if (activePort && pageReady) setTimeout(() => { polling = false; void pollCommands(); }, 1200);
    return;
  } finally {
    polling = false;
  }
}

function waitForDownload(downloadId, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error("Chrome 下载确认超时")), timeoutMs);
    function listener(delta) {
      if (!delta || delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === "complete") finish(null);
      if (delta.state.current === "interrupted") finish(new Error(`Chrome 下载中断：${delta.error && delta.error.current || "unknown"}`));
    }
    async function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(listener);
      if (error) { reject(error); return; }
      try {
        const items = await chrome.downloads.search({ id: downloadId });
        const item = items && items[0];
        if (!item || item.state !== "complete" || !item.filename || Number(item.bytesReceived || 0) <= 0) throw new Error("Chrome 下载回读不完整");
        resolve({ downloadId, state: item.state, filename: item.filename, bytesReceived: Number(item.bytesReceived), completedAt: new Date().toISOString() });
      } catch (searchError) { reject(searchError); }
    }
    chrome.downloads.onChanged.addListener(listener);
  });
}

async function downloadRenderedPng(result) {
  if (!result || typeof result.dataUrl !== "string" || !result.dataUrl.startsWith("data:image/png;base64,")) throw new Error("bridge 未返回 PNG data URL");
  if (!/^ftd-[A-Za-z0-9_.-]+-(?:pairings|scores-(?:halfway-verified|verified))\.png$/.test(result.filename || "")) throw new Error("bridge PNG 文件名无效");
  const downloadId = await chrome.downloads.download({ url: result.dataUrl, filename: result.filename, conflictAction: "uniquify", saveAs: false });
  const receipt = await waitForDownload(downloadId);
  return { ...result, dataUrl: undefined, downloadReceipt: receipt };
}

async function postBridgeResponse(message) {
  void postBridgeTrace(message.requestId, "worker-response");
  const body = { bridgeId, requestId: message.requestId, ok: message.ok === true, result: message.result, error: message.error };
  if (message.ok === true && message.result && message.result.dataUrl) {
    try {
      body.result = await downloadRenderedPng(message.result);
    } catch (error) {
      body.ok = false;
      body.result = undefined;
      body.error = { code: "chrome-download-failed", message: String(error && error.message || error) };
    }
  }
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await localFetch("/api/automation/bridge/response", { method: "POST", body: JSON.stringify(body) });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`bridge response HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
      }
      lastBridgeError = "";
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  lastBridgeError = String(lastError && lastError.message || lastError || "bridge response failed");
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "ftd-autopilot-tab" || !port.sender || !port.sender.tab || !/^https:\/\/(?:www\.)?flipthedisc\.com\//.test(port.sender.url || "")) return;
  activePort = port;
  activeTabId = port.sender.tab.id;
  pageUrl = port.sender.url;
  pageReady = false;
  port.onMessage.addListener((message) => {
    if (!message) return;
    if (message.type === "tab-ready") pageUrl = String(message.url || pageUrl);
    if (message.type === "page-bridge-ready") {
      pageReady = true;
      pageUrl = String(message.url || pageUrl);
      void registerBridge();
    }
    if (message.type === "tab-heartbeat") void sendBridgeHeartbeat();
    if (message.type === "bridge-trace") void postBridgeTrace(String(message.requestId || ""), String(message.stage || ""));
    if (message.type === "bridge-response") void postBridgeResponse(message).catch((error) => {
      lastBridgeError = String(error && error.message || error);
    });
  });
  port.onDisconnect.addListener(() => {
    if (activePort !== port) return;
    activePort = null;
    activeTabId = null;
    pageReady = false;
    lastBridgeError = "";
    if (registerRetryTimer) clearTimeout(registerRetryTimer);
    registerRetryTimer = null;
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "get-bridge-status") return false;
  sendResponse({ extensionId: chrome.runtime.id, expectedExtensionId: EXPECTED_EXTENSION_ID, connected: Boolean(activePort), pageReady, pageUrl, localRoot: LOCAL_ROOT, lastBridgeError });
  return true;
});
