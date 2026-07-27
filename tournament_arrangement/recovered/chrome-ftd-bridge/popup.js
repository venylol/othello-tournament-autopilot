"use strict";
chrome.runtime.sendMessage({ type: "get-bridge-status" }, (status) => {
  const ok = status && status.connected && status.pageReady;
  document.getElementById("status").textContent = ok ? "FTD 页面桥已连接" : "FTD 页面桥未连接";
  document.getElementById("page").textContent = status && status.lastBridgeError
    ? status.lastBridgeError
    : status && status.pageUrl ? status.pageUrl : "请打开并登录 FTD /live 页面";
});
document.getElementById("open-local").addEventListener("click", () => {
  chrome.tabs.create({ url: "http://127.0.0.1:4174/" });
});
