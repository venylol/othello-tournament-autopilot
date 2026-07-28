"use strict";

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const net = require("net");
const { spawn } = require("child_process");

const root = path.resolve(__dirname, "..");
let port = 0;
let localOrigin = "";
const extensionId = "kbojmgkjbgokbbhlpkapiobfjnpacnme";
const extensionOrigin = `chrome-extension://${extensionId}`;

async function waitForHealth() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${localOrigin}/api/health`);
      if (response.ok) return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("test server did not start");
}

async function run() {
  port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const selected = probe.address().port;
      probe.close(() => resolve(selected));
    });
  });
  localOrigin = `http://127.0.0.1:${port}`;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ftd-autopilot-api-"));
  const stateFile = path.join(temp, "checkin-state.json");
  fs.writeFileSync(stateFile, JSON.stringify({ version: 2, step: "checkin", players: [], scoreHelper: { version: 2, rounds: [] } }, null, 2) + "\n", "utf8");
  const child = spawn(process.execPath, ["local-server.js"], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CHECKIN_PORT: String(port), CHECKIN_STATE_FILE: stateFile, CHECKIN_DATA_DIR: temp },
  });
  try {
    await waitForHealth();
    const statusResponse = await fetch(`${localOrigin}/api/automation/status`, { headers: { Origin: localOrigin } });
    assert.strictEqual(statusResponse.status, 200);
    const status = await statusResponse.json();
    assert.strictEqual(status.ok, true);
    assert.strictEqual(status.bridge.connected, false);

    const missingOrigin = await fetch(`${localOrigin}/api/automation/status`);
    assert.strictEqual(missingOrigin.status, 403);

    const wrongOrigin = await fetch(`${localOrigin}/api/automation/status`, { headers: { Origin: "http://localhost:4175" } });
    assert.strictEqual(wrongOrigin.status, 403);

    const preflight = await fetch(`${localOrigin}/api/automation/bridge/register`, {
      method: "OPTIONS",
      headers: {
        Origin: extensionOrigin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-ftd-bridge-extension,x-ftd-bridge-id",
      },
    });
    assert.strictEqual(preflight.status, 204);
    assert.strictEqual(preflight.headers.get("access-control-allow-origin"), extensionOrigin);

    const register = await fetch(`${localOrigin}/api/automation/bridge/register`, {
      method: "POST",
      headers: { Origin: extensionOrigin, "Content-Type": "application/json", "X-FTD-Bridge-Extension": extensionId },
      body: JSON.stringify({ bridgeId: "mock_bridge_123456", tabId: 7, pageUrl: "https://www.flipthedisc.com/live/593", extensionId, bridgeVersion: "0.3.4" }),
    });
    assert.strictEqual(register.status, 200);
    assert.strictEqual((await register.json()).ok, true);

    const unknown = await fetch(`${localOrigin}/api/automation/not-allowed`, { method: "POST", headers: { Origin: localOrigin, "Content-Type": "application/json" }, body: "{}" });
    assert.strictEqual(unknown.status, 404);

    console.log("FTD autopilot loopback API tests passed");
  } finally {
    child.kill();
    await new Promise((resolve) => {
      if (child.exitCode != null) resolve();
      else { child.once("exit", resolve); setTimeout(resolve, 2000); }
    });
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
