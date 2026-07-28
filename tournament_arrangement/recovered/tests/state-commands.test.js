"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const COMMANDS = require("../state-commands.js");
const { FtdAutopilotCoordinator, isVerifiedOqReadyRow } = require("../ftd-autopilot-coordinator.js");

function fixture() {
  return COMMANDS.migrateState({
    version: 2,
    step: "checkin",
    competitionName: "Fixture Cup",
    nextPlayerId: 3,
    players: [
      { id: 1, displayName: "Alpha", account: "alpha", checkedIn: false },
      { id: 2, displayName: "Beta", account: "beta", checkedIn: false },
    ],
    ftdPlayerAccountMapping: {
      players: [
        { ftdName: "Alpha", account: "alpha", groupNick: "Alpha alpha" },
        { ftdName: "Beta", account: "beta", groupNick: "Beta beta" },
      ],
    },
    scoreHelper: {
      version: 2,
      preliminaryRoundCount: 1,
      roundCount: 3,
      activeRound: 1,
      rounds: [{
        round: 1,
        stage: "preliminary",
        roundStartAt: "2026-07-28 20:00:00",
        ftdPairings: [{ table: 1, black: "Alpha", white: "Beta", status: "imported" }],
        pending: [
          { sourceMessageKey: "oq-auto:game-a", pendingTable: "1", pendingKind: "oq-auto-multiple", oqPendingDetail: { candidates: [{ candidateKey: "game-a" }] } },
          { sourceMessageKey: "oq-auto:game-b", pendingTable: "1", pendingKind: "oq-auto-multiple", oqPendingDetail: { candidates: [{ candidateKey: "game-b" }] } },
        ],
        manualPending: [],
        completed: [],
      }],
    },
    egaAnalysis: { schema: "ega-analysis-state-v1", gameCount: 0 },
  });
}

function mutate(state, id, kind, expectedRevision, set, commandId) {
  return COMMANDS.applyCommand(state, {
    commandId,
    type: "entities.mutate",
    actor: "user",
    payload: { mutations: [{ op: "patch", target: { kind, id }, expectedRevision, set }] },
  });
}

test("migration preserves valid persisted entity identities", () => {
  const initial = fixture();
  initial.players[0].entityId = "player:client:107ff614-714e-4f56-8157-6007f4737333";
  initial.players[0].displayName = "Edited after identity assignment";
  const migrated = COMMANDS.migrateState(initial);
  assert.equal(migrated.players[0].entityId, "player:client:107ff614-714e-4f56-8157-6007f4737333");
  assert.throws(
    () => COMMANDS.migrateState({ ...initial, players: [initial.players[0], { ...initial.players[0] }] }),
    (error) => error.code === "identity-collision",
  );
});

test("unrelated entity commands from one snapshot both survive", () => {
  const initial = fixture();
  const [a, b] = initial.players;
  const first = mutate(initial, a.entityId, "player", 0, { checkedIn: true }, "different-a");
  const second = mutate(first.state, b.entityId, "player", 0, { isNew: true }, "different-b");
  assert.equal(second.state.players.find((row) => row.entityId === a.entityId).checkedIn, true);
  assert.equal(second.state.players.find((row) => row.entityId === b.entityId).isNew, true);
  assert.equal(second.revision, 2);
});

test("stale same-entity command is rejected with authoritative entity", () => {
  const initial = fixture();
  const player = initial.players[0];
  const first = mutate(initial, player.entityId, "player", 0, { checkedIn: true }, "same-new");
  assert.throws(
    () => mutate(first.state, player.entityId, "player", 0, { checkedIn: false }, "same-stale"),
    (error) => error.code === "entity-conflict" && error.statusCode === 409 && error.authoritativeEntity.entity.checkedIn === true,
  );
});

test("commandId retry is idempotent and semantic no-op does not increment", () => {
  const initial = fixture();
  const player = initial.players[0];
  const first = mutate(initial, player.entityId, "player", 0, { checkedIn: true }, "retry-me");
  const retry = mutate(first.state, player.entityId, "player", 0, { checkedIn: true }, "retry-me");
  assert.equal(retry.idempotent, true);
  assert.equal(retry.revision, first.revision);
  assert.equal(retry.changedEntities[0].entity.checkedIn, true, "lost-response retries return the authoritative entity");
  const noOp = mutate(first.state, player.entityId, "player", 1, { checkedIn: true }, "no-op");
  assert.equal(noOp.changed, false);
  assert.equal(noOp.revision, first.revision);
});

test("OQ candidate resolution changes score and all candidates atomically", () => {
  const initial = fixture();
  const round = initial.scoreHelper.rounds[0];
  const score = round.ftdPairings[0];
  const pending = round.pending;
  const result = COMMANDS.applyCommand(initial, {
    commandId: "select-game-b",
    type: "oq.resolveCandidate",
    actor: "user",
    target: { kind: "scoreRow", id: score.entityId },
    expectedRevision: 0,
    preconditions: pending.map((item) => ({ target: { kind: "pending", id: item.entityId }, expectedRevision: 0 })),
    payload: {
      blackScore: 40,
      whiteScore: 24,
      sourceKey: "oq-auto:game-b",
      resultTime: "2026-07-28 20:08:00",
      audit: { verifiedAccounts: ["alpha", "beta"], game: { gameId: "game-b" } },
    },
  });
  assert.equal(result.revision, 1);
  assert.equal(result.changedEntities.length, 3);
  const selected = result.state.scoreHelper.rounds[0].ftdPairings[0];
  assert.equal(selected.status, "ready");
  assert.equal(selected.sourceMessageKey, "oq-auto:game-b");
  assert.equal(selected.lastEditedBy, "user");
  assert.equal(selected.resultSource, "oq-auto");
  assert.equal(isVerifiedOqReadyRow(selected), true, "autopilot validates OQ evidence independently from human actor");
  assert.ok(result.state.scoreHelper.rounds[0].pending.every((item) => item.resolutionStatus === "resolved"));
  const autopilotPendingView = {
    pendingMatchesTable: FtdAutopilotCoordinator.prototype.pendingMatchesTable,
  };
  assert.equal(
    FtdAutopilotCoordinator.prototype.rowHasBlockingPending.call(
      autopilotPendingView,
      result.state.scoreHelper.rounds[0],
      selected,
    ),
    false,
    "resolved competing candidates do not block autopilot",
  );

  assert.throws(
    () => mutate(result.state, score.entityId, "scoreRow", 0, { blackScore: 10, whiteScore: 54 }, "old-poll"),
    (error) => error.code === "entity-conflict",
  );
  const resolved = result.state.scoreHelper.rounds[0].pending[0];
  assert.throws(
    () => mutate(result.state, resolved.entityId, "pending", 1, { resolutionStatus: "open" }, "repeat-poll"),
    (error) => error.code === "resolved-pending-terminal",
  );
});

test("stale mapping validation cannot overwrite an edited account", () => {
  const initial = fixture();
  const mapping = initial.ftdPlayerAccountMapping.players[0];
  const edit = mutate(initial, mapping.entityId, "mappingRow", 0, { account: "alpha_new" }, "mapping-edit");
  assert.throws(
    () => mutate(edit.state, mapping.entityId, "mappingRow", 0, { oqCheck: { account: "alpha", status: "ok" } }, "stale-validation"),
    (error) => error.code === "entity-conflict",
  );
  assert.equal(edit.state.ftdPlayerAccountMapping.players[0].account, "alpha_new");
});

test("EGA domain update coexists with a score edit", () => {
  const initial = fixture();
  const score = initial.scoreHelper.rounds[0].ftdPairings[0];
  const edited = mutate(initial, score.entityId, "scoreRow", 0, { status: "ready", blackScore: 34, whiteScore: 30, lastEditedBy: "user", resultSource: "manual" }, "score-edit");
  const analysis = COMMANDS.applyCommand(edited.state, {
    commandId: "ega-finish",
    type: "entities.mutate",
    actor: "script",
    payload: { mutations: [{
      op: "patchDomain",
      target: { kind: "domain", id: "domain:egaAnalysis" },
      expectedRevision: 0,
      set: { egaAnalysis: { schema: "ega-analysis-state-v1", gameCount: 1 } },
    }] },
  });
  assert.equal(analysis.state.scoreHelper.rounds[0].ftdPairings[0].blackScore, 34);
  assert.equal(analysis.state.egaAnalysis.gameCount, 1);
});

test("agent check-in and mapping edit coexist", () => {
  const initial = fixture();
  const player = initial.players[0];
  const mapping = initial.ftdPlayerAccountMapping.players[0];
  const mapEdit = mutate(initial, mapping.entityId, "mappingRow", 0, { groupNick: "Alpha new_alpha" }, "map-edit");
  const checkin = COMMANDS.applyCommand(mapEdit.state, {
    commandId: "agent-checkin",
    type: "entities.mutate",
    actor: "agent",
    payload: { mutations: [{ op: "patch", target: { kind: "player", id: player.entityId }, expectedRevision: 0, set: { checkedIn: true, checkedInAt: 123 } }] },
  });
  assert.equal(checkin.state.players[0].checkedIn, true);
  assert.equal(checkin.state.ftdPlayerAccountMapping.players[0].groupNick, "Alpha new_alpha");
});

test("round import preserves existing results, is a semantic no-op when repeated, and rejects stale scope", () => {
  const initial = fixture();
  const round = initial.scoreHelper.rounds[0];
  const score = round.ftdPairings[0];
  const edited = mutate(initial, score.entityId, "scoreRow", 0, {
    status: "ready",
    blackScore: 38,
    whiteScore: 26,
    lastEditedBy: "user",
    resultSource: "manual",
  }, "round-score-edit");
  const repeated = COMMANDS.applyCommand(edited.state, {
    commandId: "round-import-same",
    type: "round.import",
    actor: "agent",
    target: { kind: "round", id: round.entityId },
    expectedRevision: round.entityRevision,
    preconditions: [{
      target: { kind: "scoreRow", id: score.entityId },
      expectedRevision: 1,
    }],
    payload: { pairings: [{ table: 1, black: "Alpha", white: "Beta" }], roundPatch: { round: 1, stage: "preliminary" } },
  });
  assert.equal(repeated.changed, false);
  assert.equal(repeated.state.scoreHelper.rounds[0].ftdPairings[0].blackScore, 38);

  const imported = COMMANDS.applyCommand(repeated.state, {
    commandId: "round-import-account",
    type: "round.import",
    actor: "agent",
    target: { kind: "round", id: round.entityId },
    expectedRevision: round.entityRevision,
    preconditions: [{
      target: { kind: "scoreRow", id: score.entityId },
      expectedRevision: 1,
    }],
    payload: { pairings: [{ table: 1, black: "Alpha", white: "Beta", blackAccount: "alpha" }], roundPatch: { round: 1, stage: "preliminary" } },
  });
  const importedScore = imported.state.scoreHelper.rounds[0].ftdPairings[0];
  assert.equal(importedScore.blackAccount, "alpha");
  assert.equal(importedScore.blackScore, 38);
  assert.equal(importedScore.status, "ready");
  assert.throws(
    () => COMMANDS.applyCommand(imported.state, {
      commandId: "round-import-stale",
      type: "round.import",
      actor: "agent",
      target: { kind: "round", id: round.entityId },
      expectedRevision: round.entityRevision,
      preconditions: [{
        target: { kind: "scoreRow", id: score.entityId },
        expectedRevision: 1,
      }],
      payload: { pairings: [{ table: 1, black: "Alpha", white: "Beta" }] },
    }),
    (error) => error.code === "entity-conflict",
  );
});

test("long-running captured diffs coexist with unrelated edits and conflict on their stale target", () => {
  const captured = fixture();
  const score = captured.scoreHelper.rounds[0].ftdPairings[0];
  const desired = COMMANDS.clone(captured);
  desired.scoreHelper.rounds[0].ftdPairings[0].oqGameAvailable = true;
  const capturedMutations = COMMANDS.diffState(captured, desired).mutations;

  const mapping = captured.ftdPlayerAccountMapping.players[0];
  const unrelated = mutate(captured, mapping.entityId, "mappingRow", 0, { groupNick: "Alpha changed" }, "concurrent-mapping");
  const committed = COMMANDS.applyCommand(unrelated.state, {
    commandId: "captured-oq-result",
    type: "entities.mutate",
    actor: "automation",
    payload: { mutations: capturedMutations },
  });
  assert.equal(committed.state.ftdPlayerAccountMapping.players[0].groupNick, "Alpha changed");
  assert.equal(committed.state.scoreHelper.rounds[0].ftdPairings[0].oqGameAvailable, true);

  const sameEntity = mutate(captured, score.entityId, "scoreRow", 0, { status: "dirty" }, "concurrent-score");
  assert.throws(
    () => COMMANDS.applyCommand(sameEntity.state, {
      commandId: "captured-oq-stale",
      type: "entities.mutate",
      actor: "automation",
      payload: { mutations: capturedMutations },
    }),
    (error) => error.code === "entity-conflict",
  );
});
