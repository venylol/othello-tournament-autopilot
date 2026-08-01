"use strict";

const assert = require("assert");
const FTD = require("../ftd-round-shared.js");

function roundSnapshot(tournamentId, actualFtdRound, roundName, rows) {
  return {
    tournamentId: String(tournamentId),
    actualFtdRound,
    returnedRound: actualFtdRound,
    roundName,
    started: true,
    finished: false,
    roundNames: [],
    pairings: rows.map((row, index) => ({
      table: row.table || index + 1,
      gameId: row.gameId || `game-${actualFtdRound}-${index + 1}`,
      player0Id: row.player0Id || `p0-${actualFtdRound}-${index + 1}`,
      player1Id: row.player1Id || `p1-${actualFtdRound}-${index + 1}`,
      player0Name: row.player0Name || `Black ${index + 1}`,
      player1Name: row.player1Name || `White ${index + 1}`,
      blackScore: row.blackScore === undefined ? null : row.blackScore,
      whiteScore: row.whiteScore === undefined ? null : row.whiteScore,
      transcript: row.transcript || "",
      pairingFingerprint: row.pairingFingerprint || `fingerprint-${actualFtdRound}-${index + 1}`,
    })),
  };
}

function helper(stage, round = 1, existing = []) {
  return {
    version: 1,
    activeRound: round,
    roundCount: round,
    rounds: Array.from({ length: round }, (_, index) => ({
      round: index + 1,
      stage: index + 1 === round ? stage : "preliminary",
      pending: [], manualPending: [], completed: [],
      ftdPairings: index + 1 === round ? existing : [],
    })),
  };
}

function run() {
  assert.deepStrictEqual(FTD.resolveStageDefinitions({}, "preliminary", 3), [{ ftdStage: "", actualFtdRound: 3 }]);
  const discovery = { roundNames: [{ round: 6, roundName: "SF" }, { round: 7, roundName: "F" }, { round: 8, roundName: "3/4" }] };
  assert.deepStrictEqual(FTD.resolveStageDefinitions(discovery, "semifinal", 6), [{ ftdStage: "SF", actualFtdRound: 6 }]);
  assert.deepStrictEqual(FTD.resolveStageDefinitions(discovery, "finals", 7), [
    { ftdStage: "F", actualFtdRound: 7 },
    { ftdStage: "3/4", actualFtdRound: 8 },
  ]);

  const prelim = roundSnapshot("593", 1, "", [
    { blackScore: 0, whiteScore: 64 },
    { blackScore: 64, whiteScore: 0 },
    { blackScore: 32, whiteScore: 32 },
    { player0Name: "BYE", player0Id: "-1", player1Name: "Player" },
  ]);
  const prelimMerge = FTD.mergeBridgeRoundsIntoScoreHelper(helper("preliminary"), [prelim], {
    tournamentId: "593", localRound: 1, localStage: "preliminary",
    definitions: [{ ftdStage: "", actualFtdRound: 1 }],
  }, { importedAt: 1000 });
  assert.strictEqual(prelimMerge.pairings.length, 4);
  assert.strictEqual(prelimMerge.pairings[0].blackScore, null, "live FTD values are not imported as intended local scores");
  assert.strictEqual(prelimMerge.pairings[3].status, "completed");
  assert.strictEqual(prelimMerge.pairings[3].transcriptNotApplicable.reason, "bye");
  assert.strictEqual(prelimMerge.pairings[0].gameId, "game-1-1");
  assert.strictEqual(prelimMerge.pairings[0].ftdImportReceipt.tournamentId, "593");

  const sf = roundSnapshot("593", 6, "SF", [{}, {}]);
  const sfMerge = FTD.mergeBridgeRoundsIntoScoreHelper(helper("semifinal"), [sf], {
    tournamentId: "593", localRound: 1, localStage: "semifinal",
    definitions: [{ ftdStage: "SF", actualFtdRound: 6 }],
  }, { importedAt: 1100 });
  assert.deepStrictEqual(sfMerge.pairings.map((row) => [row.table, row.ftdStage, row.ftdRound, row.ftdTable]), [[1, "SF", 6, 1], [2, "SF", 6, 2]]);

  const final = roundSnapshot("593", 7, "F", [{}]);
  const third = roundSnapshot("593", 8, "3/4", [{}]);
  const finalsMerge = FTD.mergeBridgeRoundsIntoScoreHelper(helper("finals"), [final, third], {
    tournamentId: "593", localRound: 1, localStage: "finals",
    definitions: [{ ftdStage: "F", actualFtdRound: 7 }, { ftdStage: "3/4", actualFtdRound: 8 }],
  }, { importedAt: 1200 });
  assert.deepStrictEqual(finalsMerge.pairings.map((row) => [row.table, row.ftdStage, row.ftdRound, row.ftdTable]), [[1, "F", 7, 1], [2, "3/4", 8, 1]]);

  const protectedRow = { ...prelimMerge.pairings[0], status: "dirty", dirty: true };
  assert.throws(() => FTD.mergeBridgeRoundsIntoScoreHelper(helper("preliminary", 1, [protectedRow]), [roundSnapshot("593", 1, "", [{ gameId: "changed" }])], {
    tournamentId: "593", localRound: 1, localStage: "preliminary", definitions: [{ ftdStage: "", actualFtdRound: 1 }],
  }), /pairing changed/);

  const staleFinalsRows = finalsMerge.pairings.map((row) => {
    const stale = { ...row, status: "completed", ftdImportReceipt: { ...row.ftdImportReceipt } };
    delete stale.ftdImportReceipt.tournamentId;
    stale.ftdScoreReceipt = { tournamentId: "593" };
    return stale;
  });
  const currentFinal = roundSnapshot("610", 110, "F", [{ gameId: "current-final" }]);
  const currentThird = roundSnapshot("610", 109, "3/4", [{ gameId: "current-third" }]);
  const currentFinalsMerge = FTD.mergeBridgeRoundsIntoScoreHelper(helper("finals", 1, staleFinalsRows), [currentFinal, currentThird], {
    tournamentId: "610", localRound: 1, localStage: "finals",
    definitions: [{ ftdStage: "F", actualFtdRound: 110 }, { ftdStage: "3/4", actualFtdRound: 109 }],
  }, { importedAt: 1300 });
  assert.deepStrictEqual(currentFinalsMerge.pairings.map((row) => [row.table, row.gameId, row.status]), [
    [1, "current-final", "imported"],
    [2, "current-third", "imported"],
  ]);
  assert.ok(currentFinalsMerge.pairings.every((row) => row.ftdImportReceipt.tournamentId === "610"));

  const unknownProtected = { ...protectedRow, ftdImportReceipt: null };
  assert.throws(() => FTD.mergeBridgeRoundsIntoScoreHelper(helper("preliminary", 1, [unknownProtected]), [roundSnapshot("610", 1, "", [{ gameId: "unknown-source-change" }])], {
    tournamentId: "610", localRound: 1, localStage: "preliminary", definitions: [{ ftdStage: "", actualFtdRound: 1 }],
  }), /pairing changed/);
  assert.throws(() => FTD.assertBridgeRound({ ...prelim, tournamentId: "wrong" }, "593", { ftdStage: "", actualFtdRound: 1 }), /tournament mismatch/);
  assert.throws(() => FTD.assertBridgeRound({ ...prelim, actualFtdRound: 2 }, "593", { ftdStage: "", actualFtdRound: 1 }), /actual round mismatch/);

  console.log("FTD shared round tests passed");
}

run();
