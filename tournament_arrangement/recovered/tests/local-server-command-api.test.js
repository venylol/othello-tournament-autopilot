"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function json(method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? "" : JSON.stringify(body);
    const target = new URL(url);
    const request = http.request({
      method,
      host: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {},
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode, body: raw ? JSON.parse(raw) : null });
      });
    });
    request.on("error", reject);
    if (data) request.write(data);
    request.end();
  });
}

async function waitForServer(url, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode != null) throw new Error(`isolated server exited with ${child.exitCode}`);
    try {
      const response = await json("GET", `${url}/api/health`);
      if (response.status === 200) return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("isolated server did not start");
}

function nextSseEvent(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(`${url}/api/events`, (response) => {
      let buffer = "";
      let helloSeen = false;
      response.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const packets = buffer.split("\n\n");
        buffer = packets.pop();
        for (const packet of packets) {
          const line = packet.split("\n").find((item) => item.startsWith("data: "));
          if (!line) continue;
          const payload = JSON.parse(line.slice(6));
          if (!helloSeen && payload.type === "hello") { helloSeen = true; continue; }
          request.destroy();
          resolve(payload);
          return;
        }
      });
    });
    request.on("error", (error) => {
      if (error.code !== "ECONNRESET") reject(error);
    });
  });
}

test("isolated command API persists once, emits one atomic event, and restricts legacy POST", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tournament-command-api-"));
  const stateFile = path.join(temp, "checkin-state.json");
  fs.writeFileSync(stateFile, JSON.stringify({
    version: 2,
    step: "checkin",
    players: [{ id: 1, displayName: "Alpha", checkedIn: false }],
    scoreHelper: { version: 2, roundCount: 1, rounds: [{
      round: 1,
      stage: "preliminary",
      ftdPairings: [{ table: 1, black: "Alpha", white: "Beta", status: "imported" }],
      pending: [
        { sourceMessageKey: "oq-auto:game-a", pendingTable: "1", pendingKind: "oq-auto-multiple" },
        { sourceMessageKey: "oq-auto:game-b", pendingTable: "1", pendingKind: "oq-auto-multiple" },
      ],
      manualPending: [],
      completed: [],
    }] },
  }, null, 2) + "\n", "utf8");
  const port = await freePort();
  const root = path.resolve(__dirname, "..");
  const child = spawn(process.execPath, [path.join(root, "local-server.js")], {
    cwd: root,
    windowsHide: true,
    env: { ...process.env, CHECKIN_PORT: String(port), CHECKIN_STATE_FILE: stateFile, CHECKIN_DATA_DIR: temp },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode == null) child.kill(); });
  const url = `http://127.0.0.1:${port}`;
  await waitForServer(url, child);

  const initial = await json("GET", `${url}/api/state`);
  assert.equal(initial.status, 200);
  const player = initial.body.state.players[0];
  const eventPromise = nextSseEvent(url);
  const applied = await json("POST", `${url}/api/state/commands`, {
    commandId: "integration-checkin",
    type: "entities.mutate",
    actor: "agent",
    payload: { mutations: [{ op: "patch", target: { kind: "player", id: player.entityId }, expectedRevision: 0, set: { checkedIn: true } }] },
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.revision, 1);
  const event = await eventPromise;
  assert.equal(event.type, "entities");
  assert.equal(event.commandId, "integration-checkin");
  assert.equal(event.changedEntities.length, 1);

  const firstStat = fs.statSync(stateFile);
  const healthBeforeNoOp = await json("GET", `${url}/api/health`);
  const noOp = await json("POST", `${url}/api/state/commands`, {
    commandId: "integration-no-op",
    type: "entities.mutate",
    actor: "agent",
    payload: { mutations: [{ op: "patch", target: { kind: "player", id: player.entityId }, expectedRevision: 1, set: { checkedIn: true } }] },
  });
  const secondStat = fs.statSync(stateFile);
  const healthAfterNoOp = await json("GET", `${url}/api/health`);
  assert.equal(noOp.body.changed, false);
  assert.equal(noOp.body.revision, 1);
  assert.equal(secondStat.mtimeMs, firstStat.mtimeMs);
  assert.equal(healthAfterNoOp.body.broadcastCount, healthBeforeNoOp.body.broadcastCount);

  const stale = await json("POST", `${url}/api/state/commands`, {
    commandId: "integration-stale",
    type: "entities.mutate",
    actor: "agent",
    payload: { mutations: [{ op: "patch", target: { kind: "player", id: player.entityId }, expectedRevision: 0, set: { checkedIn: false } }] },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.authoritativeEntity.entity.checkedIn, true);

  const beforeOq = await json("GET", `${url}/api/state`);
  const round = beforeOq.body.state.scoreHelper.rounds[0];
  const score = round.ftdPairings[0];
  const oqEventPromise = nextSseEvent(url);
  const resolved = await json("POST", `${url}/api/state/commands`, {
    commandId: "integration-oq-resolve",
    type: "oq.resolveCandidate",
    actor: "user",
    target: { kind: "scoreRow", id: score.entityId },
    expectedRevision: score.entityRevision,
    preconditions: round.pending.map((item) => ({
      target: { kind: "pending", id: item.entityId },
      expectedRevision: item.entityRevision,
    })),
    payload: {
      blackScore: 40,
      whiteScore: 24,
      sourceKey: "oq-auto:game-b",
      audit: { game: { gameId: "game-b" }, verifiedAccounts: ["alpha", "beta"] },
    },
  });
  const oqEvent = await oqEventPromise;
  assert.equal(resolved.status, 200);
  assert.equal(oqEvent.commandId, "integration-oq-resolve");
  assert.equal(oqEvent.changedEntities.length, 3);
  assert.equal(oqEvent.changedEntities.find((item) => item.kind === "scoreRow").entity.status, "ready");
  assert.ok(oqEvent.changedEntities.filter((item) => item.kind === "pending").every((item) => item.entity.resolutionStatus === "resolved"));

  const legacy = await json("POST", `${url}/api/state`, {
    operation: "import",
    expectedRevision: 0,
    state: initial.body.state,
  });
  assert.equal(legacy.status, 409);
  const routineLegacy = await json("POST", `${url}/api/state`, { state: initial.body.state });
  assert.equal(routineLegacy.status, 400);
  assert.equal(routineLegacy.body.code, "legacy-post-restricted");

  const current = await json("GET", `${url}/api/state`);
  const replacementState = JSON.parse(JSON.stringify(current.body.state));
  replacementState.competitionName = "Explicit fixture import";
  const exactImport = await json("POST", `${url}/api/state`, {
    operation: "import",
    expectedRevision: current.body.revision,
    state: replacementState,
  });
  assert.equal(exactImport.status, 200);
  assert.equal(exactImport.body.changed, true);
  assert.equal(exactImport.body.revision, current.body.revision + 1);
  assert.equal(exactImport.body.state.competitionName, "Explicit fixture import");
});
