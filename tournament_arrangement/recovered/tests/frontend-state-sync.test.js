"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const SERVER = require("../state-commands.js");
const CLIENT = require("../frontend-state-sync.js");

function fixture() {
  return SERVER.migrateState({
    version: 2,
    step: "checkin",
    players: [{ id: 1, displayName: "A" }, { id: 2, displayName: "B" }],
    ui: { checkinView: "players" },
    scoreHelper: { version: 2, activeRound: 1, rounds: [
      { round: 1, stage: "preliminary", pending: [], manualPending: [], completed: [], ftdPairings: [{ table: 1, black: "A", white: "B", status: "imported" }] },
      { round: 2, stage: "preliminary", pending: [], manualPending: [], completed: [], ftdPairings: [{ table: 1, black: "C", white: "D", status: "imported" }] },
    ] },
  });
}

test("viewed page, viewed round, and UI preferences are not domain mutations", () => {
  const base = fixture();
  const working = CLIENT.clone(base);
  working.step = "score-helper";
  working.ui.checkinView = "mapping";
  working.scoreHelper.activeRound = 2;
  assert.deepEqual(CLIENT.buildMutations(base, working), []);
});

test("frontend entity mutations omit immutable synchronization identity fields", () => {
  const base = fixture();
  const working = CLIENT.clone(base);
  working.players[0].displayName = "Edited";
  const mutations = CLIENT.buildMutations(base, working);
  assert.equal(mutations.length, 1);
  assert.equal(Object.hasOwn(mutations[0].set, "entityId"), false);
  assert.equal(Object.hasOwn(mutations[0].set, "entityRevision"), false);
  const result = SERVER.applyCommand(base, {
    commandId: "frontend-mutation",
    type: "entities.mutate",
    actor: "user",
    payload: { mutations },
  });
  assert.equal(result.state.players[0].displayName, "Edited");
});

test("missing round or metadata parents are never emitted as remove commands", () => {
  const base = fixture();
  const working = CLIENT.clone(base);
  working.scoreHelper.rounds = working.scoreHelper.rounds.slice(1);
  const mutations = CLIENT.buildMutations(base, working);
  assert.deepEqual(mutations, [], "a transiently missing parent must not cascade into unsupported or destructive removes");
});

test("clearing children of an existing round emits only removable child commands", () => {
  const base = fixture();
  const working = CLIENT.clone(base);
  working.scoreHelper.rounds[0].ftdPairings = [];
  const mutations = CLIENT.buildMutations(base, working);
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].op, "remove");
  assert.equal(mutations[0].target.kind, "scoreRow");
  const result = SERVER.applyCommand(base, {
    commandId: "frontend-clear-round-children",
    type: "entities.mutate",
    actor: "user",
    payload: { mutations },
  });
  assert.equal(result.state.scoreHelper.rounds[0].ftdPairings.length, 0);
  assert.equal(result.state.scoreHelper.rounds.length, 2);
});

test("an SSE change to another row preserves the focused row object and draft", () => {
  const state = fixture();
  const focused = state.players[0];
  focused.displayName = "uncommitted draft";
  const other = state.players[1];
  const result = CLIENT.applyChangedEntities(state, [{
    kind: "player",
    id: other.entityId,
    revision: 1,
    entity: { ...other, checkedIn: true, entityRevision: 1 },
  }], { blockedEntityId: focused.entityId });
  assert.equal(state.players[0], focused);
  assert.equal(state.players[0].displayName, "uncommitted draft");
  assert.equal(state.players[1].checkedIn, true);
  assert.deepEqual(result.conflicts, []);
});

test("same-entity SSE is retained as a conflict instead of snapping draft back", () => {
  const state = fixture();
  const focused = state.players[0];
  focused.displayName = "draft";
  const result = CLIENT.applyChangedEntities(state, [{
    kind: "player",
    id: focused.entityId,
    revision: 1,
    entity: { ...focused, displayName: "server", entityRevision: 1 },
  }], { blockedEntityId: focused.entityId });
  assert.equal(state.players[0].displayName, "draft");
  assert.equal(result.conflicts.length, 1);
});

test("an OQ response stays on its captured round after the browser views another round", () => {
  const state = fixture();
  const capturedRow = state.scoreHelper.rounds[0].ftdPairings[0];
  const viewedRoundRow = state.scoreHelper.rounds[1].ftdPairings[0];
  state.scoreHelper.activeRound = 2;
  CLIENT.applyChangedEntities(state, [{
    kind: "scoreRow",
    id: capturedRow.entityId,
    revision: 1,
    entity: { ...capturedRow, status: "ready", blackScore: 40, whiteScore: 24, entityRevision: 1 },
  }]);
  assert.equal(state.scoreHelper.activeRound, 2);
  assert.equal(state.scoreHelper.rounds[0].ftdPairings[0].status, "ready");
  assert.equal(state.scoreHelper.rounds[1].ftdPairings[0], viewedRoundRow);
});

test("score-helper and round metadata patches preserve browser-local viewed round and child collections", () => {
  const state = fixture();
  const rounds = state.scoreHelper.rounds;
  const pairings = rounds[0].ftdPairings;
  state.scoreHelper.activeRound = 2;
  CLIENT.applyChangedEntities(state, [{
    kind: "scoreHelperMetadata",
    id: state.scoreHelper.entityId,
    revision: 1,
    entity: { entityId: state.scoreHelper.entityId, entityRevision: 1, roundCount: 2, activeRound: 1, rounds: [] },
  }, {
    kind: "round",
    id: rounds[0].entityId,
    revision: 1,
    entity: { entityId: rounds[0].entityId, entityRevision: 1, roundStartAt: "2026-07-28 20:00:00", ftdPairings: [] },
  }]);
  assert.equal(state.scoreHelper.activeRound, 2);
  assert.equal(state.scoreHelper.rounds, rounds);
  assert.equal(state.scoreHelper.rounds[0].ftdPairings, pairings);
  assert.equal(state.scoreHelper.rounds[0].roundStartAt, "2026-07-28 20:00:00");
});

test("round import hydrates newly added score rows into the live browser state", () => {
  const serverState = fixture();
  const targetRound = serverState.scoreHelper.rounds[0];
  targetRound.ftdPairings = [];
  const browserState = CLIENT.clone(serverState);
  const result = SERVER.applyCommand(serverState, {
    commandId: "frontend-live-round-import",
    type: "round.import",
    actor: "automation",
    target: { kind: "round", id: targetRound.entityId },
    expectedRevision: targetRound.entityRevision,
    preconditions: [],
    payload: {
      pairings: [
        { table: 1, black: "A", white: "B", status: "imported" },
        { table: 2, black: "C", white: "D", status: "imported" },
      ],
      roundPatch: { round: 1, stage: "preliminary" },
    },
  });

  const addedRows = result.changedEntities.filter((change) => change.kind === "scoreRow" && !change.removed);
  assert.equal(addedRows.length, 2);
  assert.ok(addedRows.every((change) => change.collection === "scoreRows" && change.parentId === targetRound.entityId));
  CLIENT.applyChangedEntities(browserState, result.changedEntities);
  assert.deepEqual(
    browserState.scoreHelper.rounds[0].ftdPairings.map((row) => [row.table, row.black, row.white]),
    [[1, "A", "B"], [2, "C", "D"]],
  );
});

test("startup code restores browser preferences, not stale domain state", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  assert.match(app, /loadBrowserPreferences\(\)/);
  assert.doesNotMatch(app, /function loadFromStorage\(/);
  assert.doesNotMatch(app, /setInterval\(\(\) => \{\s*fetchLocalSyncState/);
});
