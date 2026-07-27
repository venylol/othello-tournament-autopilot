"use strict";

const assert = require("assert");
const {
  BridgeBroker,
  FtdAutopilotCoordinator,
  safeJournalValue,
  validScorePair,
  sha256,
  localDateTimeValue,
} = require("../ftd-autopilot-coordinator.js");
const { sanitizeLoadedState, renderFtdPairingStatusMetadata } = require("../app.js");

function deepClone(value) { return JSON.parse(JSON.stringify(value)); }

function makeSnapshot(scores = [null, null, null], options = {}) {
  const scorePairs = [[0, 64], [64, 0], [32, 32]];
  return {
    tournamentId: "593",
    actualFtdRound: 1,
    returnedRound: 1,
    roundName: "",
    currentRound: 1,
    started: options.started !== false,
    finished: options.finished === true,
    roundNames: [],
    pairings: scores.map((score, index) => ({
      table: index + 1,
      gameId: `ftd-game-${index + 1}`,
      player0Id: `p0-${index + 1}`,
      player1Id: `p1-${index + 1}`,
      player0Name: `Black ${index + 1}`,
      player1Name: `White ${index + 1}`,
      blackScore: score == null ? null : score,
      whiteScore: score == null ? null : 64 - score,
      transcript: "",
      pairingFingerprint: `fp-${index + 1}`,
      expected: scorePairs[index],
    })),
  };
}

function makeState() {
  return {
    version: 2,
    step: "score-helper",
    players: [],
    ui: { ftdUrl: "https://www.flipthedisc.com/live/593", oqPollSeconds: 5 },
    scoreHelper: {
      version: 1,
      roundCount: 1,
      activeRound: 1,
      rounds: [{
        round: 1,
        stage: "preliminary",
        roundStartAt: "2026-07-27T20:00:00",
        roundStartSource: "frontend",
        pending: [], manualPending: [], completed: [], ftdPairings: [],
      }],
    },
  };
}

function makeBridge(snapshot, behavior = {}) {
  const live = deepClone(snapshot);
  const calls = [];
  let renderCalls = 0;
  const bridge = {
    onRegister: null,
    status() {
      return {
        connected: behavior.connected !== false,
        pageUrl: "https://www.flipthedisc.com/live/593",
        liveProof: {
          ok: true,
          tournamentId: "593",
          localRound: 1,
          localStage: "preliminary",
          verifiedAt: Date.now(),
          transport: "dedicated-second-socket",
          coexistenceObserved: true,
          tdAccess: true,
          definitions: [{ ftdStage: "", actualFtdRound: 1 }],
        },
      };
    },
    setLiveProof() {},
    async send(command) {
      calls.push(deepClone(command));
      if (behavior.send) {
        const custom = await behavior.send(command, live, calls);
        if (custom !== undefined) return custom;
      }
      if (command.action === "probe") {
        return {
          loggedIn: true, tdAccess: true, transport: "dedicated-second-socket",
          dedicatedSocketConnected: true, existingPageSocketConnected: true, coexistenceObserved: true,
          pageTournamentId: "593", discovery: deepClone(live),
        };
      }
      if (command.action === "readRound" || command.action === "readbackRound") return deepClone(live);
      const target = live.pairings.find((row) => row.gameId === command.gameId);
      if (command.action === "writeScore") {
        if (target.blackScore !== null && target.blackScore !== command.blackScore) {
          const error = new Error("conflicting existing score"); error.code = "ftd-score-conflict"; throw error;
        }
        const before = { blackScore: target.blackScore, whiteScore: target.whiteScore };
        target.blackScore = command.blackScore;
        target.whiteScore = command.whiteScore;
        return {
          kind: "ftd-score-receipt-v1", sessionId: command.sessionId, commandId: command.commandId,
          tournamentId: command.tournamentId, actualFtdRound: 1, ftdTable: command.targetTable,
          gameId: command.gameId, pairingFingerprint: command.pairingFingerprint,
          expectedScore: { blackScore: command.blackScore, whiteScore: command.whiteScore }, beforeScore: before,
          readbackScore: { blackScore: target.blackScore, whiteScore: target.whiteScore },
          alreadyCorrect: before.blackScore === command.blackScore, readbackAttempts: 1, verifiedAt: new Date().toISOString(),
        };
      }
      if (command.action === "writeTranscript") {
        if (target.transcript && target.transcript !== command.transcript) {
          const error = new Error("conflicting existing transcript"); error.code = "ftd-transcript-conflict"; throw error;
        }
        const before = target.transcript;
        target.transcript = command.transcript;
        return {
          kind: "ftd-transcript-receipt-v1", sessionId: command.sessionId, commandId: command.commandId,
          tournamentId: command.tournamentId, actualFtdRound: 1, ftdTable: command.targetTable,
          gameId: command.gameId, oqGameId: command.oqGameId, pairingFingerprint: command.pairingFingerprint,
          transcriptHash: sha256(command.transcript), beforeTranscriptHash: before ? sha256(before) : "",
          readbackTranscriptHash: sha256(target.transcript), alreadyCorrect: before === command.transcript,
          readbackAttempts: 1, verifiedAt: new Date().toISOString(),
        };
      }
      if (command.action === "renderVerifiedRoundImage") {
        renderCalls += 1;
        if (behavior.downloadFailure) { const error = new Error("download interrupted"); error.code = "chrome-download-failed"; throw error; }
        return { pngSha256: "png-hash", rowCount: command.snapshot.length, renderedAt: new Date().toISOString(), downloadReceipt: { downloadId: 41, state: "complete", filename: `C:\\Downloads\\${command.filename}`, bytesReceived: 1000 } };
      }
      throw new Error(`unexpected action ${command.action}`);
    },
    calls,
    live,
    get renderCalls() { return renderCalls; },
  };
  return bridge;
}

function makeHarness(options = {}) {
  let state = makeState();
  let revision = 0;
  const snapshot = options.snapshot || makeSnapshot(options.liveScores || [null, null, null]);
  const bridge = makeBridge(snapshot, options.bridgeBehavior || {});
  const expectedScores = [[0, 64], [64, 0], [32, 32]];
  const coordinator = new FtdAutopilotCoordinator({
    dataDir: ".",
    persistFiles: false,
    readState: () => ({ state }),
    writeState: (next) => { state = deepClone(next); revision += 1; return { state }; },
    getRevision: () => revision,
    bridge,
    now: options.now,
    setTimer: () => 1,
    clearTimer: () => {},
    updateOq: async () => {
      const round = state.scoreHelper.rounds[0];
      if (options.oqMutation) return options.oqMutation(round, state);
      round.ftdPairings.forEach((row, index) => {
        row.status = "ready";
        row.blackScore = expectedScores[index][0];
        row.whiteScore = expectedScores[index][1];
        row.lastEditedBy = "script";
        row.sourceMessageKey = `oq-auto:oq-${index + 1}`;
        row.oqAutoAudit = { game: { gameId: `oq-${index + 1}` }, score: { blackScore: row.blackScore, whiteScore: row.whiteScore } };
      });
      return { ok: true, appliedCount: round.ftdPairings.length, skipped: [], mappingIssues: [], queryErrors: {} };
    },
    fetchOqDetail: async () => ({ position: { startPos: "", moves: [{ m: "f5" }, { m: "d6" }] } }),
  });
  return { coordinator, bridge, getState: () => state };
}

async function startAndRun(harness) {
  const started = await harness.coordinator.start({});
  await harness.coordinator.run();
  return started;
}

async function run() {
  assert.strictEqual(validScorePair(0, 64), true);
  assert.strictEqual(validScorePair(64, 0), true);
  assert.strictEqual(validScorePair(32, 32), true);
  assert.strictEqual(validScorePair(33, 32), false);
  assert.strictEqual(validScorePair(-1, 65), false);

  {
    const authorizedAt = Date.parse("2026-07-28T12:00:00+08:00");
    const harness = makeHarness({ now: () => authorizedAt, snapshot: makeSnapshot([null, null, null], { finished: true }) });
    const started = await startAndRun(harness);
    assert.strictEqual(harness.coordinator.session.phase, "done", "explicit tournament 593 test authorization permits a finished round");
    assert.strictEqual(started.session.finishedRoundWriteTestAuthorization.tournamentId, "593");
    const writes = harness.bridge.calls.filter((command) => command.action === "writeScore" || command.action === "writeTranscript");
    assert.ok(writes.length > 0 && writes.every((command) => command.allowFinishedRoundWrite === true));
  }

  {
    const expiredAt = Date.parse("2026-07-29T00:00:00+08:00");
    const harness = makeHarness({ now: () => expiredAt, snapshot: makeSnapshot([null, null, null], { finished: true }) });
    await harness.coordinator.start({});
    await harness.coordinator.run();
    assert.strictEqual(harness.coordinator.session.phase, "paused", "expired finished-round authorization stays blocked");
    assert.strictEqual(harness.coordinator.session.pauseReason.code, "ftd-round-finished");
  }

  {
    const instant = Date.now();
    const harness = makeHarness({ now: () => instant });
    const round = harness.getState().scoreHelper.rounds[0];
    round.roundStartAt = "";
    round.roundStartSource = "";
    const started = await harness.coordinator.start({});
    assert.strictEqual(started.session.scope.roundStartAt, localDateTimeValue(instant));
    assert.strictEqual(started.session.scope.roundStartSource, "ftd-autopilot-start");
    assert.strictEqual(started.session.scope.roundStartDefaulted, true);
  }

  {
    const harness = makeHarness();
    const original = harness.getState().scoreHelper.rounds[0].roundStartAt;
    const started = await harness.coordinator.start({});
    assert.strictEqual(started.session.scope.roundStartAt, original);
    assert.strictEqual(started.session.scope.roundStartSource, "frontend");
    assert.strictEqual(started.session.scope.roundStartDefaulted, false);
  }

  {
    const source = makeState();
    source.scoreHelper.rounds[0].ftdPairings = [{
      table: 1, black: "Black", white: "White", status: "completed", blackScore: 40, whiteScore: 24,
      lastEditedBy: "automation", gameId: "ftd-game", player0Id: "p0", player1Id: "p1", pairingFingerprint: "fp",
      oqAutoAudit: { game: { gameId: "oq-game" } },
      ftdScoreReceipt: { sessionId: "session", verifiedAt: "2026-07-27T20:05:00Z" },
      ftdTranscriptReceipt: { sessionId: "session", verifiedAt: "2026-07-27T20:06:00Z" },
      ftdTranscriptImport: { status: "imported", oqGameId: "oq-game", confirmedBy: "automation", confirmedAt: 1 },
    }];
    source.scoreHelper.rounds[0].ftdDirectImport = { source: "chrome-ftd-bridge", tournamentId: "593" };
    const loaded = sanitizeLoadedState(source);
    const row = loaded.scoreHelper.rounds[0].ftdPairings[0];
    assert.strictEqual(row.lastEditedBy, "automation");
    assert.strictEqual(row.gameId, "ftd-game");
    assert.strictEqual(row.ftdScoreReceipt.sessionId, "session");
    assert.strictEqual(row.ftdTranscriptReceipt.sessionId, "session");
    assert.strictEqual(loaded.scoreHelper.rounds[0].ftdDirectImport.source, "chrome-ftd-bridge");
    assert.ok(renderFtdPairingStatusMetadata(row).includes("本轮自律验证"));
    assert.ok(renderFtdPairingStatusMetadata(row).includes("FTD已验证"));
  }

  const broker = new BridgeBroker({ now: () => 1000 });
  assert.throws(() => broker.register({ bridgeId: "valid_bridge_123", tabId: -1, pageUrl: "https://www.flipthedisc.com/live/593", extensionId: "kbojmgkjbgokbbhlpkapiobfjnpacnme" }, "chrome-extension://kbojmgkjbgokbbhlpkapiobfjnpacnme"), /tabId rejected/);
  assert.deepStrictEqual(safeJournalValue({ token: "secret", sid: "secret", cookie: "secret", nested: { authorization: "secret", gameId: "ok" } }), { nested: { gameId: "ok" } });

  {
    const harness = makeHarness();
    const started = await startAndRun(harness);
    assert.strictEqual(harness.coordinator.session.phase, "done");
    assert.strictEqual(harness.bridge.renderCalls, 1, "exactly one download command");
    const rows = harness.getState().scoreHelper.rounds[0].ftdPairings;
    assert.deepStrictEqual(rows.map((row) => [row.blackScore, row.whiteScore]), [[0, 64], [64, 0], [32, 32]]);
    rows.forEach((row) => {
      assert.strictEqual(row.status, "completed");
      assert.strictEqual(row.lastEditedBy, "automation");
      assert.strictEqual(row.ftdScoreReceipt.sessionId, started.sessionId);
      assert.strictEqual(row.ftdTranscriptReceipt.sessionId, started.sessionId);
      assert.strictEqual(row.ftdTranscriptImport.confirmedBy, "automation");
      assert.ok(row.oqAutoAudit, "OQ provenance retained");
    });
    assert.ok(harness.coordinator.memoryJournal.every((entry) => !JSON.stringify(entry).includes(started.token)), "control token absent from journal");
  }

  {
    const harness = makeHarness({ liveScores: [0, 64, 32] });
    await startAndRun(harness);
    assert.strictEqual(harness.coordinator.session.phase, "done", "already-correct scores are idempotently accepted");
    const scoreCalls = harness.bridge.calls.filter((call) => call.action === "writeScore");
    assert.strictEqual(scoreCalls.length, 3);
  }

  {
    const harness = makeHarness({ liveScores: [1, null, null] });
    await startAndRun(harness);
    const pending = harness.getState().scoreHelper.rounds[0].pending;
    assert.ok(pending.some((item) => item.pendingKind === "automation-ftd-score-conflict" && item.pendingTable === "1"));
    assert.ok(harness.bridge.calls.some((call) => call.action === "writeScore" && call.targetTable === 2), "other tables continue after one conflict");
  }

  {
    const harness = makeHarness({
      oqMutation(round) {
        const row = round.ftdPairings[0];
        row.status = "dirty"; row.dirty = true; row.lastEditedBy = "user";
        const second = round.ftdPairings[1];
        second.status = "ready"; second.blackScore = 64; second.whiteScore = 0; second.lastEditedBy = "script"; second.oqAutoAudit = { game: { gameId: "oq-2" } };
        round.manualPending.push({ table: "2", pendingTable: "2", pendingKind: "user-pending", sourceMessageKey: "user:2" });
        return { ok: true, skipped: [{ table: 1, reason: "dirty row" }, { table: 2, reason: "user-pending" }, { table: 3, reason: "no matching OQ game" }], mappingIssues: [{ table: 3 }], queryErrors: {} };
      },
    });
    await startAndRun(harness);
    assert.strictEqual(harness.bridge.calls.filter((call) => call.action === "writeScore").length, 0, "dirty/manual-pending/missing-mapping rows never write");
    const pending = harness.getState().scoreHelper.rounds[0].pending;
    assert.ok(pending.some((item) => item.pendingKind === "automation-mapping-missing"));
  }

  {
    let first = true;
    const harness = makeHarness({ bridgeBehavior: {
      async send(command, live) {
        if (command.action === "writeScore" && command.targetTable === 1 && first) {
          first = false;
          const target = live.pairings[0]; target.blackScore = command.blackScore; target.whiteScore = command.whiteScore;
          const error = new Error("response lost"); error.code = "bridge-timeout"; throw error;
        }
        return undefined;
      },
    } });
    await harness.coordinator.start({});
    await harness.coordinator.run();
    assert.ok(harness.coordinator.session.tables["1:1:ftd-game-1"].uncertainScore);
    await harness.coordinator.run();
    assert.strictEqual(harness.getState().scoreHelper.rounds[0].ftdPairings[0].status, "completed", "uncertain score recovers by read-first");
  }

  {
    const harness = makeHarness({ bridgeBehavior: {
      async send(command, live) {
        if (command.action === "writeTranscript" && command.targetTable === 1) live.pairings[0].transcript = "c4c3";
        return undefined;
      },
    } });
    await startAndRun(harness);
    const pending = harness.getState().scoreHelper.rounds[0].pending;
    assert.ok(pending.some((item) => item.pendingKind === "automation-ftd-transcript-conflict"));
    assert.ok(harness.bridge.calls.some((call) => call.action === "writeTranscript" && call.targetTable === 2), "other tables continue after transcript conflict");
  }

  {
    const harness = makeHarness({ bridgeBehavior: {
      async send(command) {
        if (command.action === "writeScore" && command.targetTable === 1) { const error = new Error("readback timeout"); error.code = "readback-timeout"; throw error; }
        if (command.action === "writeTranscript" && command.targetTable === 2) { const error = new Error("transcript readback timeout"); error.code = "readback-timeout"; throw error; }
        return undefined;
      },
    } });
    await startAndRun(harness);
    const pendingKinds = harness.getState().scoreHelper.rounds[0].pending.map((item) => item.pendingKind);
    assert.ok(pendingKinds.includes("automation-readback-timeout"), "score/transcript readback timeouts pause affected tables");
  }

  {
    const harness = makeHarness();
    await harness.coordinator.start({});
    await harness.coordinator.readAndImportRound();
    const command = {
      action: "writeScore", commandId: "interrupted-score", targetTable: 1, gameId: "ftd-game-1",
      blackScore: 0, whiteScore: 64, startedAt: Date.now(),
    };
    assert.strictEqual(harness.coordinator.restoreInterruptedWrite(command), true);
    assert.strictEqual(harness.coordinator.session.tables["1:1:ftd-game-1"].uncertainScore.recoveredAfterRestart, true);
    assert.strictEqual(harness.coordinator.session.tables["1:1:ftd-game-1"].uncertainScore.commandId, "interrupted-score");
  }

  {
    const harness = makeHarness({
      oqMutation(round) {
        round.ftdPairings.forEach((row) => { row.status = "imported"; });
        return { ok: true, skipped: [], mappingIssues: [], queryErrors: {} };
      },
    });
    await harness.coordinator.start({});
    await harness.coordinator.run();
    harness.coordinator.session.phase = "paused";
    harness.coordinator.session.pauseReason = { code: "bridge-disconnected", message: "disconnected" };
    harness.coordinator.onBridgeConnected();
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(harness.coordinator.session.phase, "polling-oq", "reconnect performs a fresh read-only proof before resuming");
  }

  {
    let finalReadback = false;
    const harness = makeHarness({ bridgeBehavior: {
      async send(command, live) {
        if (command.action === "readbackRound" && live.pairings.every((row) => row.transcript)) {
          finalReadback = true;
          const altered = deepClone(live); altered.pairings[0].blackScore = 1; altered.pairings[0].whiteScore = 63; return altered;
        }
        return undefined;
      },
    } });
    await startAndRun(harness);
    assert.strictEqual(finalReadback, true);
    assert.strictEqual(harness.bridge.renderCalls, 0, "image is never generated from mismatching/unverified final readback");
    assert.strictEqual(harness.coordinator.session.phase, "failed");
  }

  {
    const harness = makeHarness({ bridgeBehavior: { downloadFailure: true } });
    await startAndRun(harness);
    assert.strictEqual(harness.coordinator.session.phase, "paused");
    assert.strictEqual(harness.coordinator.session.pauseReason.code, "chrome-download-failed");
    assert.strictEqual(harness.bridge.renderCalls, 1);
    await harness.coordinator.run();
    assert.strictEqual(harness.bridge.renderCalls, 1, "failed/uncertain download is never duplicated");
  }

  {
    const harness = makeHarness({
      snapshot: makeSnapshot([null], {}),
      oqMutation(round) {
        const row = round.ftdPairings[0];
        row.status = "completed"; row.blackScore = 64; row.whiteScore = 0; row.resultKind = "absence"; row.lastEditedBy = "user";
        return { ok: true, skipped: [], mappingIssues: [], queryErrors: {} };
      },
    });
    await startAndRun(harness);
    const row = harness.getState().scoreHelper.rounds[0].ftdPairings[0];
    assert.strictEqual(row.transcriptNotApplicable.reason, "referee-confirmed-absence");
    assert.strictEqual(row.transcriptNotApplicable.refereeSource, "user");
  }

  console.log("FTD autopilot coordinator tests passed");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
