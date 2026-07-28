"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const COMMANDS = require("../state-commands.js");

function fixture() {
  return COMMANDS.migrateState({
    version: 2,
    players: [{ id: 1, displayName: "Alpha", account: "alpha" }],
    ftdPlayerAccountMapping: {
      players: [{ ftdName: "Alpha", account: "alpha", groupNick: "Alpha alpha" }],
    },
    ftdPlayerRegistration: {
      rows: [{ rowId: "roster:1", playerId: 1, rosterName: "Alpha", status: "pending" }],
    },
    scoreHelper: {
      roundCount: 1,
      rounds: [{
        round: 1,
        stage: "preliminary",
        ftdPairings: [{ table: 1, black: "Alpha", white: "Beta", status: "imported" }],
        pending: [{ sourceMessageKey: "oq-auto:game-a", pendingTable: "1", pendingKind: "oq-auto-pending" }],
        manualPending: [],
        completed: [],
      }],
    },
  });
}

function patchEntity(state, entry, set, commandId, expectedRevision = entry.entityRevision) {
  return COMMANDS.applyCommand(state, {
    commandId,
    type: "entities.mutate",
    actor: "user",
    payload: {
      mutations: [{
        op: "patch",
        target: { kind: entry.kind, id: entry.entityId },
        expectedRevision,
        set,
      }],
    },
  });
}

test("same-entity conflicts are explicit and never resolved by timestamps", () => {
  const initial = fixture();
  const row = initial.scoreHelper.rounds[0].ftdPairings[0];
  const newer = patchEntity(initial, {
    ...row,
    kind: "scoreRow",
  }, {
    status: "ready",
    blackScore: 40,
    whiteScore: 24,
    lastEditedBy: "user",
    resultSource: "manual",
    updatedAt: 100,
  }, "score-user");

  assert.throws(
    () => patchEntity(newer.state, {
      ...row,
      kind: "scoreRow",
    }, {
      status: "completed",
      blackScore: 20,
      whiteScore: 44,
      updatedAt: 999999999,
    }, "score-stale", 0),
    (error) => error.code === "entity-conflict" &&
      error.statusCode === 409 &&
      error.authoritativeEntity.entity.blackScore === 40,
  );
});

test("terminal pending resolution cannot be resurrected by omission or a later timestamp", () => {
  const initial = fixture();
  const pending = initial.scoreHelper.rounds[0].pending[0];
  const resolved = patchEntity(initial, {
    ...pending,
    kind: "pending",
  }, {
    resolutionStatus: "resolved",
    resolvedByReferee: true,
    resolvedAt: 100,
  }, "pending-resolve");

  assert.throws(
    () => patchEntity(resolved.state, {
      ...pending,
      kind: "pending",
    }, {
      resolutionStatus: "open",
      updatedAt: 999999999,
    }, "pending-reopen", 1),
    (error) => error.code === "resolved-pending-terminal",
  );
});

test("registration and mapping rows use independent revisions", () => {
  const initial = fixture();
  const mapping = initial.ftdPlayerAccountMapping.players[0];
  const registration = initial.ftdPlayerRegistration.rows[0];
  const mapped = patchEntity(initial, {
    ...mapping,
    kind: "mappingRow",
  }, { account: "alpha-new" }, "mapping-edit");
  const registered = patchEntity(mapped.state, {
    ...registration,
    kind: "registrationRow",
  }, { status: "resolved" }, "registration-edit");

  assert.equal(registered.state.ftdPlayerAccountMapping.players[0].account, "alpha-new");
  assert.equal(registered.state.ftdPlayerRegistration.rows[0].status, "resolved");
  assert.equal(registered.revision, 2);
});
