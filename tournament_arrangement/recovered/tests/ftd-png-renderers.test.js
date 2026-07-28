"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const SCORE_RENDERER = require("../chrome-ftd-bridge/ftd-score-png-renderer.js");

test("shared score PNG title does not repeat the Round prefix", () => {
  assert.equal(SCORE_RENDERER.roundTitle(1), "Round 1");
  assert.equal(SCORE_RENDERER.roundTitle("round-1"), "Round 1");
  assert.equal(SCORE_RENDERER.roundTitle("round 2"), "Round 2");
  assert.equal(SCORE_RENDERER.roundTitle("SF"), "Round SF");
});

test("unregistered score PNG rows keep both discs but omit their numbers", () => {
  const drawnText = [];
  let drawnDiscs = 0;
  const gradient = { addColorStop() {} };
  const context = {
    arc() { drawnDiscs += 1; },
    beginPath() {},
    closePath() {},
    createRadialGradient() { return gradient; },
    fill() {},
    fillRect() {},
    fillText(value) { drawnText.push(String(value)); },
    lineTo() {},
    moveTo() {},
    restore() {},
    save() {},
    scale() {},
    stroke() {},
    strokeText(value) { drawnText.push(String(value)); },
  };
  const originalWindow = global.window;
  const originalDocument = global.document;
  global.window = { devicePixelRatio: 1 };
  global.document = {
    createElement() {
      return { style: {}, getContext() { return context; } };
    },
  };
  try {
    SCORE_RENDERER.buildPairingsCanvas([
      { table: 1, black: "Alpha", white: "Beta", blackScore: null, whiteScore: null },
    ], 1);
  } finally {
    global.window = originalWindow;
    global.document = originalDocument;
  }
  assert.equal(SCORE_RENDERER.hasPairingScore({ blackScore: null, whiteScore: null }), false);
  assert.equal(SCORE_RENDERER.hasPairingScore({ blackScore: 0, whiteScore: 64 }), true);
  assert.equal(drawnDiscs, 2);
  assert.ok(drawnText.includes("-"));
  assert.ok(!drawnText.includes("0"));
});

test("shared score PNG row logic matches the copied FTD score console", () => {
  const base = { table: 1, black: "Alpha", white: "Beta", written: null, local: null };
  assert.deepEqual(
    SCORE_RENDERER.buildScoreRow({ ...base, ftdBlackScore: null }),
    { table: 1, black: "Alpha", white: "Beta", blackScore: null, whiteScore: null },
  );
  assert.deepEqual(
    SCORE_RENDERER.buildScoreRow({ ...base, ftdBlackScore: 40 }),
    { table: 1, black: "Alpha", white: "Beta", blackScore: 40, whiteScore: 24 },
  );
  assert.deepEqual(
    SCORE_RENDERER.buildScoreRow({ ...base, ftdBlackScore: 0 }),
    { table: 1, black: "Alpha", white: "Beta", blackScore: null, whiteScore: null },
    "an FTD zero remains blank unless it was just written or exists as a complete local score",
  );
  assert.deepEqual(
    SCORE_RENDERER.buildScoreRow({ ...base, written: { blackScore: 0, whiteScore: 64 }, ftdBlackScore: 0 }),
    { table: 1, black: "Alpha", white: "Beta", blackScore: 0, whiteScore: 64 },
  );
  assert.deepEqual(
    SCORE_RENDERER.buildScoreRow({ ...base, local: { blackScore: 32, whiteScore: 32 }, ftdBlackScore: null }),
    { table: 1, black: "Alpha", white: "Beta", blackScore: 32, whiteScore: 32 },
  );
  assert.deepEqual(
    SCORE_RENDERER.buildScoreRow({ ...base, white: "BYE", ftdBlackScore: null }),
    { table: 1, black: "Alpha", white: "BYE", blackScore: 33, whiteScore: 31 },
  );
});
