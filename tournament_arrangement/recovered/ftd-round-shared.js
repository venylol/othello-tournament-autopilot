(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.FtdRoundShared = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const STAGES = new Set(["preliminary", "semifinal", "finals"]);

  function text(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }

  function key(value) {
    let result = text(value);
    try { result = result.normalize("NFKC"); } catch (_) {}
    return result.toLowerCase();
  }

  function normalizeFtdStage(value) {
    const stage = text(value).toUpperCase();
    if (stage === "SF" || stage === "SEMI-FINALS" || stage === "SEMIFINAL") return "SF";
    if (stage === "F" || stage === "FINALS" || stage === "FINAL") return "F";
    if (stage === "3/4" || stage === "MATCH FOR 3RD PLACE" || stage === "THIRD-PLACE") return "3/4";
    return "";
  }

  function isByeName(value) {
    return key(value) === "bye";
  }

  function hasScore(row) {
    const black = Number(row && row.blackScore);
    const white = Number(row && row.whiteScore);
    return Number.isInteger(black) && Number.isInteger(white) && black >= 0 && white >= 0 && black <= 64 && white <= 64 && black + white === 64;
  }

  function resolveStageDefinitions(discovery, localStage, localRound) {
    if (!STAGES.has(localStage)) throw new Error("unsupported local stage");
    const round = Math.trunc(Number(localRound));
    if (!Number.isInteger(round) || round < 1) throw new Error("invalid local round");
    if (localStage === "preliminary") return [{ ftdStage: "", actualFtdRound: round }];
    const names = discovery && Array.isArray(discovery.roundNames) ? discovery.roundNames : [];
    const required = localStage === "semifinal" ? ["SF"] : ["F", "3/4"];
    return required.map((ftdStage) => {
      const match = names.find((item) => normalizeFtdStage(item && (item.roundName || item.round_name)) === ftdStage);
      const actualFtdRound = Number(match && match.round);
      if (!Number.isInteger(actualFtdRound) || actualFtdRound < 1) throw new Error(`FTD discovery did not return ${ftdStage}`);
      return { ftdStage, actualFtdRound };
    });
  }

  function assertBridgeRound(snapshot, tournamentId, definition) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("FTD bridge round is empty");
    if (String(snapshot.tournamentId) !== String(tournamentId)) throw new Error("FTD tournament mismatch");
    if (Number(snapshot.actualFtdRound) !== Number(definition.actualFtdRound)) throw new Error("FTD actual round mismatch");
    if (!Array.isArray(snapshot.pairings) || !snapshot.pairings.length) throw new Error("FTD round has no pairings");
    const returnedStage = normalizeFtdStage(snapshot.roundName);
    if (definition.ftdStage && returnedStage !== definition.ftdStage) throw new Error(`FTD stage mismatch: expected ${definition.ftdStage}, got ${returnedStage || "numeric"}`);
    if (!definition.ftdStage && returnedStage) throw new Error(`numeric preliminary round unexpectedly returned stage ${returnedStage}`);
    const tables = new Set();
    snapshot.pairings.forEach((row) => {
      const table = Number(row && row.table);
      if (!Number.isInteger(table) || table < 1 || tables.has(table)) throw new Error("FTD table numbers are invalid or duplicated");
      tables.add(table);
      for (const field of ["gameId", "player0Id", "player1Id", "player0Name", "player1Name", "pairingFingerprint"]) {
        if (!text(row && row[field])) throw new Error(`FTD table ${table} is missing ${field}`);
      }
      if (row.blackScore !== null && !hasScore(row)) throw new Error(`FTD table ${table} has invalid live score`);
    });
    return snapshot;
  }

  function localTableFor(definition, ftdTable) {
    if (definition.ftdStage === "F") return 1;
    if (definition.ftdStage === "3/4") return 2;
    return ftdTable;
  }

  function pairingIdentity(row) {
    return [
      Number(row && row.table) || 0,
      Number(row && row.ftdRound) || 0,
      Number(row && row.ftdTable) || 0,
      text(row && row.gameId),
      text(row && row.player0Id),
      text(row && row.player1Id),
      text(row && row.pairingFingerprint),
    ].join("\n");
  }

  function pairingHasProtectedLocalWork(row) {
    if (!row || typeof row !== "object") return false;
    if (["ready", "completed", "dirty"].includes(text(row.status))) return true;
    if (row.dirty === true || hasScore(row)) return true;
    if (text(row.sourceMessageKey) || text(row.resultText) || text(row.reason)) return true;
    return Boolean(row.ftdScoreReceipt || row.ftdTranscriptReceipt || row.transcriptNotApplicable);
  }

  function buildImportedPairing(snapshotRow, definition, importedAt, existing) {
    const ftdTable = Math.trunc(Number(snapshotRow.table));
    const table = localTableFor(definition, ftdTable);
    const base = {
      table,
      black: text(snapshotRow.player0Name),
      white: text(snapshotRow.player1Name),
      status: "imported",
      dirty: false,
      reporter: "",
      opponent: "",
      blackScore: null,
      whiteScore: null,
      resultText: "",
      reason: "",
      imagePath: "",
      sourceMessageKey: "",
      resultKind: "",
      updatedAt: importedAt,
      completedAt: null,
      lastEditedBy: "automation",
      lastEditedAt: importedAt,
      userEditedFields: {},
      ftdStage: definition.ftdStage,
      ftdRound: definition.actualFtdRound,
      ftdTable,
      gameId: text(snapshotRow.gameId),
      player0Id: text(snapshotRow.player0Id),
      player1Id: text(snapshotRow.player1Id),
      pairingFingerprint: text(snapshotRow.pairingFingerprint),
      ftdImportReceipt: {
        source: "chrome-ftd-bridge",
        importedAt,
        actualFtdRound: definition.actualFtdRound,
        ftdTable,
        gameId: text(snapshotRow.gameId),
        pairingFingerprint: text(snapshotRow.pairingFingerprint),
      },
    };
    if (isByeName(base.black) || isByeName(base.white)) {
      base.status = "completed";
      base.resultKind = "bye";
      base.completedAt = importedAt;
      base.reason = "FTD BYE";
      base.transcriptNotApplicable = { reason: "bye", confirmedBy: "ftd-readback", confirmedAt: importedAt };
    }
    if (!existing) return base;
    return {
      ...base,
      ...existing,
      table: base.table,
      black: base.black,
      white: base.white,
      ftdStage: base.ftdStage,
      ftdRound: base.ftdRound,
      ftdTable: base.ftdTable,
      gameId: base.gameId,
      player0Id: base.player0Id,
      player1Id: base.player1Id,
      pairingFingerprint: base.pairingFingerprint,
      ftdImportReceipt: base.ftdImportReceipt,
    };
  }

  function mergeBridgeRoundsIntoScoreHelper(scoreHelper, snapshots, scope, options) {
    const helper = scoreHelper && typeof scoreHelper === "object" ? JSON.parse(JSON.stringify(scoreHelper)) : null;
    if (!helper || !Array.isArray(helper.rounds)) throw new Error("local score helper is missing");
    const localRound = Math.trunc(Number(scope && scope.localRound));
    const localStage = text(scope && scope.localStage);
    const tournamentId = text(scope && scope.tournamentId);
    if (!STAGES.has(localStage) || !tournamentId || localRound < 1 || localRound > helper.rounds.length) throw new Error("invalid locked local scope");
    const allowInactiveLockedRound = Boolean(options && options.allowInactiveLockedRound);
    if (!allowInactiveLockedRound && Math.trunc(Number(helper.activeRound)) !== localRound) throw new Error("selected local round changed");
    const round = helper.rounds[localRound - 1];
    if (text(round && round.stage) !== localStage) throw new Error("selected local stage changed");
    const definitions = Array.isArray(scope.definitions) ? scope.definitions : [];
    if (definitions.length !== snapshots.length) throw new Error("FTD readback definition count mismatch");
    const importedAt = Number(options && options.importedAt) || Date.now();
    const existing = Array.isArray(round.ftdPairings) ? round.ftdPairings : [];
    const existingByIdentity = new Map(existing.map((row) => [pairingIdentity(row), row]));
    const incoming = [];
    snapshots.forEach((snapshot, index) => {
      const definition = definitions[index];
      assertBridgeRound(snapshot, tournamentId, definition);
      snapshot.pairings.forEach((snapshotRow) => {
        const probe = {
          table: localTableFor(definition, Number(snapshotRow.table)),
          ftdRound: definition.actualFtdRound,
          ftdTable: Number(snapshotRow.table),
          gameId: snapshotRow.gameId,
          player0Id: snapshotRow.player0Id,
          player1Id: snapshotRow.player1Id,
          pairingFingerprint: snapshotRow.pairingFingerprint,
        };
        incoming.push(buildImportedPairing(snapshotRow, definition, importedAt, existingByIdentity.get(pairingIdentity(probe))));
      });
    });
    if (localStage === "semifinal" && incoming.length !== 2) throw new Error(`semifinal requires 2 tables, got ${incoming.length}`);
    if (localStage === "finals") {
      if (incoming.length !== 2 || !incoming.some((row) => row.ftdStage === "F") || !incoming.some((row) => row.ftdStage === "3/4")) throw new Error("combined finals require one F and one 3/4 table");
    }
    const incomingIdentities = new Set(incoming.map(pairingIdentity));
    const changedProtected = existing.filter((row) => pairingHasProtectedLocalWork(row) && !incomingIdentities.has(pairingIdentity(row)));
    if (changedProtected.length) throw new Error(`FTD pairing changed while ${changedProtected.length} local row(s) contain protected work`);
    round.ftdPairings = incoming.sort((a, b) => Number(a.table) - Number(b.table));
    round.ftdDirectImport = {
      source: "chrome-ftd-bridge",
      tournamentId,
      localRound,
      localStage,
      importedAt,
      definitions: definitions.map((item) => ({ ftdStage: item.ftdStage, actualFtdRound: item.actualFtdRound })),
    };
    helper.updatedAt = importedAt;
    return { scoreHelper: helper, pairings: round.ftdPairings, round: round };
  }

  return {
    normalizeFtdStage,
    isByeName,
    hasScore,
    resolveStageDefinitions,
    assertBridgeRound,
    pairingIdentity,
    pairingHasProtectedLocalWork,
    mergeBridgeRoundsIntoScoreHelper,
  };
});
