"use strict";

const assert = require("assert");
const {
  normalizePlayerName,
  dedupePackets,
  exactNameCandidates,
  chooseCandidate,
  resolveState,
  fixtureQuery,
  buildNameReviewPacket,
} = require("../resolve_ftd_players.js");

function normalized(displayName, extra = {}) {
  return normalizePlayerName({ id: 1, displayName, ...extra }, {});
}

async function run() {
  for (const value of [
    "Ren Wutong",
    "  ren   wutong  ",
    "ren　wutong",
    "ren_wutong",
    "ren-wutong",
    "ren/wutong",
    "RenWutong",
    "renwutong",
  ]) {
    const parsed = normalized(value);
    assert.strictEqual(parsed.ok, true, value);
    assert.strictEqual(parsed.normalizedName, "Ren Wutong", value);
  }
  assert.strictEqual(normalized("Alex").ok, false);
  assert.strictEqual(normalized("liangwei").ok, false, "Li Angwei and Liang Wei are both plausible");
  assert.strictEqual(normalized("梧桐").ok, false);

  const historyState = {
    ftdPlayerAccountMapping: {
      players: [{ ftdName: "WUTONG Ren", account: "wutong" }],
    },
  };
  const testOverrides = [{ account: "wutong", rosterName: "", normalizedName: "Ren Wutong" }];
  const overridden = normalizePlayerName(
    { id: 1, displayName: "梧桐", account: "wutong" },
    historyState,
    testOverrides,
  );
  assert.strictEqual(overridden.normalizedName, "Ren Wutong");
  assert.strictEqual(overridden.source, "manual-name-override-table");
  const notOverridden = normalizePlayerName(
    { id: 2, displayName: "别的选手", account: "other" },
    { ftdPlayerAccountMapping: { players: [{ ftdName: "WUTONG Ren", account: "other" }] } },
  );
  assert.strictEqual(notOverridden.normalizedName, "Wutong Ren");
  assert.strictEqual(notOverridden.source, "historical-ftd-map");

  const repeated = [
    [{ id: 14337, surname: "WUTONG", name: "Ren", rating: 1794 }],
    [{ id: 14337, surname: "WUTONG", name: "Ren", rating: 1794 }],
    [{ id: 14337, surname: "WUTONG", name: "Ren", rating: 1794 }, { id: 14337, surname: "WUTONG", name: "Ren" }],
  ];
  const deduped = dedupePackets(repeated);
  assert.strictEqual(deduped.packetCount, 2);
  assert.strictEqual(deduped.candidates.length, 1);

  const reverseOrder = exactNameCandidates(
    [{ id: 1, surname: "Wutong", name: "Ren" }, { id: 2, surname: "Other", name: "Person" }],
    "Ren Wutong",
  );
  assert.deepStrictEqual(reverseOrder.map((item) => item.id), [1]);

  let picked = chooseCandidate([{ id: 1, surname: "Ren", name: "Wutong", rating: 1000 }]);
  assert.strictEqual(picked.status, "matched-single");
  picked = chooseCandidate([
    { id: 1, surname: "A", name: "B", rating: null },
    { id: 2, surname: "A", name: "B", rating: 1500 },
    { id: 3, surname: "A", name: "B", rating: 1600 },
  ]);
  assert.strictEqual(picked.status, "matched-highest-rating");
  assert.strictEqual(picked.selectedPlayer.id, 3);
  picked = chooseCandidate([
    { id: 16463, surname: "Deng", name: "Yuqi", rating: 1600 },
    { id: 19806, surname: "Deng", name: "Yuqi", rating: 1600 },
  ], () => 0.99);
  assert.strictEqual(picked.status, "matched-random-tie");
  assert.strictEqual(picked.selectedPlayer.id, 19806);
  assert.deepStrictEqual(picked.tiedPlayerIds, [16463, 19806]);
  picked = chooseCandidate([
    { id: 16463, surname: "Deng", name: "Yuqi", rating: null },
    { id: 19806, surname: "Deng", name: "Yuqi", rating: null },
  ], () => 0);
  assert.strictEqual(picked.status, "matched-random-tie");
  assert.strictEqual(picked.selectionRule, "random-all-null-rating-tie");
  assert.strictEqual(picked.selectedPlayer.id, 16463);
  assert.strictEqual(chooseCandidate([]).status, "unmatched");

  const state = {
    players: [
      { id: 1, displayName: "ren wutong", account: "wutong", group: "open" },
      { id: 2, displayName: "dengyuqi", account: "SleepyLagoon", group: "open" },
      { id: 3, displayName: "jiu hangqiep", account: "none", group: "open" },
      { id: 4, displayName: "Alex", account: "alex", group: "open" },
    ],
  };
  const fixture = fixtureQuery({
    "ren wutong": repeated,
    "deng yuqi": [[
      { id: 16463, surname: "Deng", name: "Yuqi", rating: null, country_code: "CN" },
      { id: 19806, surname: "Deng", name: "Yuqi", rating: null, country_code: "CN" },
    ]],
    "jiu hangqiep": [[]],
  });
  const resolved = await resolveState(state, 10, fixture, () => 0, "2026-07-27T00:00:00.000Z", "resolver-test");
  assert.strictEqual(resolved.summary.total, 4);
  assert.strictEqual(resolved.summary.single, 1);
  assert.strictEqual(resolved.summary.randomTie, 1);
  assert.strictEqual(resolved.summary.unmatched, 1);
  assert.strictEqual(resolved.summary.nameParseUnresolved, 1);
  assert.strictEqual(resolved.registration.rows[2].status, "unmatched");
  assert.notStrictEqual(resolved.registration.rows[2].status, "referee-new");
  assert.strictEqual(resolved.registration.rows[3].status, "name-parse-unresolved");
  assert.strictEqual(resolved.review.length, 2);

  const reviewPacket = buildNameReviewPacket(state, 10);
  assert.strictEqual(reviewPacket.queryStarted, false);
  assert.strictEqual(reviewPacket.stateWritten, false);
  assert.strictEqual(reviewPacket.rows.length, 4);
  assert.ok(reviewPacket.instruction.includes("逐行查阅全部名单"));
  assert.ok(reviewPacket.nextCommand.includes("--names-reviewed"));
}

run().then(
  () => console.log("resolve_ftd_players tests passed"),
  (error) => { console.error(error); process.exitCode = 1; },
);
