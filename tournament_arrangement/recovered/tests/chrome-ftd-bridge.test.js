"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const extensionRoot = path.join(root, "chrome-ftd-bridge");
const read = (file) => fs.readFileSync(path.join(extensionRoot, file), "utf8").replace(/^\uFEFF/, "");

function run() {
  const manifest = JSON.parse(read("manifest.json"));
  assert.strictEqual(manifest.manifest_version, 3);
  assert.deepStrictEqual(manifest.permissions, ["downloads"]);
  assert.deepStrictEqual(manifest.host_permissions.sort(), ["http://127.0.0.1:4174/*", "https://flipthedisc.com/*", "https://www.flipthedisc.com/*"].sort());
  for (const forbidden of ["debugger", "cookies", "history", "clipboardRead", "clipboardWrite", "<all_urls>"]) {
    assert.ok(!JSON.stringify(manifest).includes(forbidden), `manifest must not request ${forbidden}`);
  }

  const page = read("page-bridge.js");
  const relay = read("content-relay.js");
  const worker = read("service-worker.js");
  const pairingRenderer = read("ftd-pairing-png-renderer.js");
  const scoreRenderer = read("ftd-score-png-renderer.js");
  const mainScripts = manifest.content_scripts.find((entry) => entry.world === "MAIN").js;
  assert.deepStrictEqual(mainScripts.slice(-3), ["ftd-pairing-png-renderer.js", "ftd-score-png-renderer.js", "page-bridge.js"]);
  assert.ok(page.includes("window.FTD_PAIRING_PNG_RENDERER"));
  assert.ok(page.includes("window.FTD_SCORE_PNG_RENDERER"));
  assert.ok(!page.includes('createElement("canvas")'), "AP must not contain a separate PNG canvas implementation");
  assert.ok(page.includes('forceNew: true'));
  assert.ok(page.includes('assertWriteTransportProof(command)'));
  assert.ok(page.includes('FINISHED_ROUND_TEST_TOURNAMENT_ID = "593"'));
  assert.ok(page.includes("finishedRoundWriteTestAuthorized(command)"));
  assert.ok(page.includes('"dedicated-second-socket"'));
  assert.ok(page.includes('socket.emit("get-otb-rounds"'));
  assert.ok(page.includes('socket.emit("score-otb"'));
  assert.ok(page.includes('socket.emit("otb-paste-transcript"'));
  assert.ok(page.includes('socket.emit("is-td"'));
  for (const forbiddenEvent of ["finish-round", "publish-round", "next-round", "delete-round"]) {
    assert.ok(!page.includes(forbiddenEvent), `${forbiddenEvent} must never be present`);
  }
  assert.ok(!/\beval\s*\(|new\s+Function\s*\(/.test(page + relay + worker), "no arbitrary code execution");
  assert.ok(!relay.includes("localStorage") && !worker.includes("localStorage"), "FTD credentials stay in MAIN page context");
  assert.ok(!relay.includes("userData") && !worker.includes("userData"));
  assert.ok(worker.includes('conflictAction: "uniquify"'));
  assert.ok(worker.includes("delta.id !== downloadId"), "only the initiated download ID is tracked");
  assert.ok(worker.includes('item.state !== "complete"'));
  assert.ok(relay.includes("recoverInvalidatedContext"), "an extension reload recovers by refreshing the FTD tab");
  assert.ok(worker.includes("timeoutMs: 10000"), "MV3 long polling yields before worker idle timeout");
  assert.ok(worker.includes('code: "relay-delivery-failed"'), "relay delivery failures return without a generic command timeout");
  assert.ok(worker.includes("if (activePort && pageReady && !polling) void pollCommands()"), "every heartbeat repairs an MV3-suspended poll loop");
  assert.ok(worker.includes("void rescuePollCommands()"), "heartbeat bypasses a stale polling flag with an independent short poll");
  assert.ok(worker.includes("timeoutMs: 1000"), "rescue poll returns promptly");
  assert.ok(worker.includes('localFetch("/api/automation/bridge/next", {'), "bridge command polling uses POST so Chrome supplies extension Origin");

  const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const pairingConsole = fs.readFileSync(path.join(root, "ftd-download-console.js"), "utf8");
  const scoreConsole = fs.readFileSync(path.join(root, "ftd-score-console.js"), "utf8");
  for (const label of ["复制 FTD 导出代码", "复制 FTD 登分代码", "复制本轮棋谱导入代码", "导入本轮 JSON"]) {
    assert.ok(index.includes(label), `manual workflow retained: ${label}`);
  }
  for (const functionName of ["copyFtdConsoleDownloadCode", "copyFtdScoreConsoleCode", "copyFtdTranscriptConsoleCode", "importFtdRoundFromJSONFile"]) {
    assert.ok(app.includes(`function ${functionName}`), `manual implementation retained: ${functionName}`);
  }
  assert.ok(app.includes("runManualFtdAction"), "active automation warns and pauses before manual flow");
  assert.ok(app.includes("ftd-pairing-png-renderer.js") && app.includes("ftd-score-png-renderer.js"));
  assert.ok(pairingConsole.includes("__FTD_PAIRING_PNG_RENDERER_SOURCE__"));
  assert.ok(scoreConsole.includes("__FTD_SCORE_PNG_RENDERER_SOURCE__"));
  assert.ok(!pairingConsole.includes("function buildPairingsCanvas"), "manual pairing export must use the shared renderer");
  assert.ok(!scoreConsole.includes("function buildPairingsCanvas"), "manual score export must use the shared renderer");
  assert.ok(pairingRenderer.includes("function buildPairingsCanvas"));
  assert.ok(scoreRenderer.includes("function buildPairingsCanvas"));

  const generatedPairingConsole = pairingConsole
    .replace("__FTD_PAIRING_PNG_RENDERER_SOURCE__", pairingRenderer)
    .replace("__FTD_TARGET_ROUND__", "1")
    .replace("__FTD_TARGET_STAGE__", '"preliminary"')
    .replace("__FTD_TOURNAMENT_URL__", '"https://flipthedisc.com/live/593"')
    .replace("__FTD_PLAYER_ACCOUNT_MAPPING__", "{}");
  const generatedScoreConsole = scoreConsole
    .replace("__FTD_SCORE_PNG_RENDERER_SOURCE__", scoreRenderer)
    .replace("__FTD_SCORE_TOURNAMENT_ID__", '"593"')
    .replace("__FTD_SCORE_ROUND__", "1")
    .replace("__FTD_SCORE_RESULTS__", "[]")
    .replace("__FTD_SCORE_PAIRINGS_ASSIGN__", "LOCAL_PAIRINGS = [];")
    .replace("__FTD_SCORE_DOWNLOAD_PNG__", "true");
  assert.doesNotThrow(() => new Function(generatedPairingConsole));
  assert.doesNotThrow(() => new Function(generatedScoreConsole));
  assert.ok(!page.includes("score-scan") && !worker.includes("score-scan"));
  assert.ok(!page.includes("wechat") && !worker.includes("wechat"));

  console.log("Chrome FTD bridge security/manual-compatibility tests passed");
}

run();
