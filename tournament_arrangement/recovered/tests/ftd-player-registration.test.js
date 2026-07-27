"use strict";

const assert = require("assert");
const registration = require("../ftd-player-registration-shared.js");
const { mergeStateForApiPost } = require("../local-server.js");

const players = [
  { id: 1, displayName: "Ren Wutong", account: "wutong", group: "open" },
  { id: 2, displayName: "Deng Yuqi", account: "SleepyLagoon", group: "open" },
  { id: 3, displayName: "No Match", account: "none", group: "open" },
  { id: 4, displayName: "New Player", account: "new", group: "open" },
  { id: 5, displayName: "Excluded Player", account: "excluded", group: "open" },
  { id: 6, displayName: "Already Written", account: "written", group: "open" },
];

function row(player, fields) {
  return registration.sanitizeRow({
    rowId: registration.rowIdForPlayer(player),
    playerId: player.id,
    rosterName: player.displayName,
    rosterAccount: player.account,
    rosterGroup: player.group,
    rosterSignature: registration.rosterSignature(player),
    ...fields,
  });
}

async function run() {
  const base = registration.sanitizeRegistration({
    rows: [
      row(players[0], { status: "matched-single", resolutionStatus: "matched-single", selectedPlayer: { id: 14337, wof_id: 61004, surname: "WUTONG", name: "Ren", rating: 1794, country_code: "CN" } }),
      row(players[1], { status: "referee-manual", resolutionStatus: "referee-manual", selectedPlayer: { id: 16463, surname: "Deng", name: "Yuqi", country_code: "CN" }, family: "Deng" }),
      row(players[2], { status: "unmatched" }),
      row(players[3], { status: "referee-new", resolutionStatus: "referee-new", newPlayer: { surname: "New", name: "Player", country: "CN", family: "New", categories: ["open"] } }),
      row(players[4], { status: "excluded" }),
      row(players[5], { status: "ftd-written", resolutionStatus: "matched-single", selectedPlayer: { id: 999, surname: "Already", name: "Written", country_code: "CN" } }),
    ],
  });
  const created = registration.createConsoleBatch(base, players, {
    batchId: "batch-test",
    createdAt: "2026-07-27T00:00:00.000Z",
    sourceRevision: 20,
  });
  assert.deepStrictEqual(created.batch.rows.map((item) => item.rowId), ["roster:1", "roster:2", "roster:4"]);
  assert.deepStrictEqual(created.batch.rows.map((item) => item.kind), ["existing", "existing", "new"]);
  assert.strictEqual(created.registration.rows[0].status, "console-batch-pending");
  assert.strictEqual(created.registration.rows[2].status, "unmatched");
  assert.strictEqual(created.registration.rows[5].status, "ftd-written");

  const recovered = registration.prepareConsoleBatch(created.registration, players, {
    batchId: "must-not-replace-pending-batch",
    createdAt: "2026-07-27T00:05:00.000Z",
    sourceRevision: 21,
  });
  assert.strictEqual(recovered.reused, true);
  assert.strictEqual(recovered.batch.batchId, "batch-test");
  assert.deepStrictEqual(recovered.batch.rows, created.batch.rows);
  assert.strictEqual(recovered.registration.pendingBatch.batchId, "batch-test");

  const preparedNew = registration.prepareConsoleBatch(base, players, {
    batchId: "batch-prepared-new",
    createdAt: "2026-07-27T00:05:00.000Z",
    sourceRevision: 21,
  });
  assert.strictEqual(preparedNew.reused, false);
  assert.strictEqual(preparedNew.batch.batchId, "batch-prepared-new");

  const events = [];
  let remotePlayers = [];
  const result = await registration.executeConsoleBatch(created.batch, {
    tournamentId: "593",
    nowIso: () => "2026-07-27T00:10:00.000Z",
    getPlayers: async () => { events.push("get"); return remotePlayers.slice(); },
    addExisting: async (item) => {
      events.push(`add:${item.selectedPlayer.id}`);
      remotePlayers.push({ ...item.selectedPlayer });
    },
    registerNew: async (item) => {
      events.push(`new:${item.form.surname}`);
      remotePlayers.push({ id: 20000, surname: item.form.surname, name: item.form.name, country_code: item.form.country });
    },
  });
  assert.deepStrictEqual(events, ["get", "add:14337", "get", "add:16463", "get", "new:New", "get"]);
  assert.strictEqual(result.success.length, 3);
  assert.strictEqual(result.failed.length, 0);

  const applied = registration.applyConsoleResult(created.registration, {
    type: registration.RESULT_TYPE,
    schemaVersion: registration.RESULT_SCHEMA_VERSION,
    batchId: "batch-test",
    tournamentId: "593",
    completedAt: "2026-07-27T00:10:00.000Z",
    success: [{ rowId: "roster:1", playerId: 14337, name: "WUTONG Ren" }],
    failed: [{ rowId: "roster:2", errorCode: "verify-not-found", errorMessage: "not found" }],
    unprocessed: [{ rowId: "roster:4", reason: "stopped-after-failure" }],
  });
  assert.strictEqual(applied.registration.rows[0].status, "ftd-written");
  assert.strictEqual(applied.registration.rows[1].status, "ftd-write-failed");
  assert.strictEqual(applied.registration.rows[3].status, "console-batch-pending");
  assert.strictEqual(applied.registration.rows[3].console.lastOutcome, "unprocessed");

  assert.throws(() => registration.applyConsoleResult(created.registration, {
    type: registration.RESULT_TYPE,
    schemaVersion: 1,
    batchId: "wrong-batch",
    success: [], failed: [], unprocessed: [],
  }), /batchId/);
  assert.strictEqual(created.registration.rows[0].status, "console-batch-pending");

  const stopEvents = [];
  const failedResult = await registration.executeConsoleBatch(created.batch, {
    tournamentId: "593",
    getPlayers: async () => [],
    addExisting: async (item) => {
      stopEvents.push(item.rowId);
      const error = new Error("timeout"); error.code = "updated-list-timeout"; throw error;
    },
    registerNew: async () => { throw new Error("must not run"); },
  });
  assert.deepStrictEqual(stopEvents, ["roster:1"]);
  assert.strictEqual(failedResult.failed.length, 1);
  assert.strictEqual(failedResult.unprocessed.length, 2);

  const code = registration.buildConsoleCode(created.batch);
  for (const required of [
    '"is-td"', '"get-otb-reg"', '"add-player-otb"', '"register-new-wof"',
    '"otb-players-list"', "navigator.clipboard.writeText", "document.hasFocus()",
    "window.__FTD_PLAYER_IMPORT_RESULT__", "copy(JSON.stringify(window.__FTD_PLAYER_IMPORT_RESULT__))",
    "localStorage.getItem(\"userData\")", "forceNew: true", "emitAndVerify",
  ]) assert.ok(code.includes(required), required);
  assert.ok(!code.includes('socket.on("updated-players-list"'));
  assert.ok(!code.includes("delete-player-otb"));
  assert.doesNotThrow(() => new Function(code));

  const currentState = {
    version: 2,
    step: "checkin",
    players,
    ftdPlayerRegistration: { ...base, updatedAt: "2026-07-27T00:10:00.000Z" },
  };
  const staleIncoming = {
    ...currentState,
    ftdPlayerRegistration: { ...base, rows: [], updatedAt: "2026-07-27T00:00:00.000Z" },
  };
  const merged = mergeStateForApiPost(staleIncoming, currentState, {
    source: "frontend",
    baseRevision: 1,
    currentRevision: 2,
  });
  assert.strictEqual(merged.preservedFtdPlayerRegistration, true);
  assert.strictEqual(merged.state.ftdPlayerRegistration.rows.length, base.rows.length);

  const agentIncoming = {
    ...staleIncoming,
    competitionName: "stale name",
    ftdPlayerRegistration: { ...base, resolverBatchId: "agent-new" },
  };
  const agentMerged = mergeStateForApiPost(agentIncoming, { ...currentState, competitionName: "current name" }, {
    source: "agent-resolve-ftd-players",
    baseRevision: 1,
    currentRevision: 2,
  });
  assert.strictEqual(agentMerged.state.competitionName, "current name");
  assert.strictEqual(agentMerged.state.ftdPlayerRegistration.resolverBatchId, "agent-new");
}

run().then(
  () => console.log("ftd-player-registration tests passed"),
  (error) => { console.error(error); process.exitCode = 1; },
);
