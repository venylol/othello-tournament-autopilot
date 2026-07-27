(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.FtdTranscriptShared = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var COORD_RE = /^[a-h][1-8]$/i;
  var TRANSCRIPT_RE = /^[a-h1-8]+$/;

  function text(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }

  function normalizeFullName(value) {
    var normalized = text(value);
    try {
      normalized = normalized.normalize("NFKC");
    } catch (_) {
      // Older embedded browsers can lack String.prototype.normalize.
    }
    return normalized.toLowerCase();
  }

  function extractOqGameId(pairing) {
    if (!pairing || typeof pairing !== "object") return "";
    var autoAudit = pairing.oqAutoAudit && typeof pairing.oqAutoAudit === "object"
      ? pairing.oqAutoAudit
      : {};
    var autoGame = autoAudit.game && typeof autoAudit.game === "object"
      ? autoAudit.game
      : {};
    var gameId = text(autoGame.gameId);
    if (gameId) return gameId;

    var availableAudit = pairing.oqGameAvailableAudit && typeof pairing.oqGameAvailableAudit === "object"
      ? pairing.oqGameAvailableAudit
      : {};
    var availableGame = availableAudit.game && typeof availableAudit.game === "object"
      ? availableAudit.game
      : {};
    gameId = text(availableGame.gameId);
    if (gameId) return gameId;

    var sourceKey = text(pairing.sourceMessageKey);
    return sourceKey.indexOf("oq-auto:id:") === 0
      ? text(sourceKey.slice("oq-auto:id:".length))
      : "";
  }

  function sanitizeTranscriptImport(value) {
    if (!value || typeof value !== "object" || text(value.status) !== "imported") return null;
    var oqGameId = text(value.oqGameId);
    var confirmedAt = Number(value.confirmedAt);
    if (!oqGameId || !Number.isFinite(confirmedAt) || confirmedAt <= 0) return null;
    return {
      status: "imported",
      oqGameId: oqGameId,
      confirmedAt: confirmedAt,
      confirmedBy: text(value.confirmedBy) === "user" ? "user" : text(value.confirmedBy),
    };
  }

  function isCurrentTranscriptImport(pairing) {
    var imported = sanitizeTranscriptImport(pairing && pairing.ftdTranscriptImport);
    var currentGameId = extractOqGameId(pairing);
    return Boolean(imported && currentGameId && imported.oqGameId === currentGameId);
  }

  function isByePairing(pairing) {
    return normalizeFullName(pairing && pairing.black) === "bye" ||
      normalizeFullName(pairing && pairing.white) === "bye";
  }

  function classifyPairingForTranscript(pairing) {
    var table = Number(pairing && pairing.table);
    var base = {
      table: Number.isFinite(table) ? Math.trunc(table) : 0,
      ftdBlack: text(pairing && pairing.black),
      ftdWhite: text(pairing && pairing.white),
      oqGameId: extractOqGameId(pairing),
    };
    if (!pairing || typeof pairing !== "object" || !base.table || !base.ftdBlack || !base.ftdWhite) {
      return Object.assign(base, { ok: false, code: "not-two-player", reason: "不是正常双人配对" });
    }
    if (isByePairing(pairing)) {
      return Object.assign(base, { ok: false, code: "bye", reason: "BYE" });
    }
    if (text(pairing.resultKind).toLowerCase() === "absence") {
      return Object.assign(base, { ok: false, code: "absence", reason: "缺席结果" });
    }
    var status = text(pairing.status).toLowerCase();
    if (status !== "ready" && status !== "completed") {
      return Object.assign(base, {
        ok: false,
        code: "score-status",
        reason: "比分状态不是 ready 或 completed",
      });
    }
    if (!base.oqGameId) {
      return Object.assign(base, {
        ok: false,
        code: "missing-oq-game-id",
        reason: "缺少确定的 OQ game ID",
      });
    }
    if (isCurrentTranscriptImport(pairing)) {
      return Object.assign(base, {
        ok: false,
        code: "already-imported",
        reason: "同一 OQ game ID 的棋谱已确认导入",
      });
    }
    return Object.assign(base, { ok: true, code: "eligible", reason: "" });
  }

  function hasNonEmptyStartPosition(value) {
    if (value == null) return false;
    if (typeof value === "string") return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "object") return Object.keys(value).length > 0;
    return Boolean(value);
  }

  function endingStatusFromMoves(moves, detail) {
    for (var i = moves.length - 1; i >= 0; i -= 1) {
      var move = moves[i];
      if (!move || typeof move !== "object") continue;
      var candidate = move.status == null ? (move.s == null ? move.result : move.s) : move.status;
      if (candidate != null && text(candidate)) return text(candidate);
    }
    return text(detail && (detail.endingStatus || detail.status || detail.result));
  }

  function extractTranscriptFromOqDetail(detail) {
    var position = detail && typeof detail === "object" && detail.position && typeof detail.position === "object"
      ? detail.position
      : null;
    if (!position || !Array.isArray(position.moves)) {
      return { ok: false, code: "invalid-position-moves", reason: "缺少或无法解析 position.moves" };
    }
    if (hasNonEmptyStartPosition(position.startPos)) {
      return {
        ok: false,
        code: "unsupported-start-position",
        reason: "不支持非空自定义 startPos",
      };
    }

    // OQ pass entries use m:"-". FTD replays forced passes itself, so only
    // legal OQ in-game coordinate moves are retained and their order is unchanged.
    var coordinates = [];
    for (var i = 0; i < position.moves.length; i += 1) {
      var item = position.moves[i];
      if (!item || typeof item !== "object") continue;
      var move = typeof item.m === "string" ? item.m.trim() : "";
      if (COORD_RE.test(move)) coordinates.push(move.toLowerCase());
    }
    if (!coordinates.length) {
      return { ok: false, code: "no-coordinate-moves", reason: "没有可导入的坐标着手" };
    }
    var transcript = coordinates.join("");
    if (
      transcript.length > 120 ||
      transcript.length % 2 !== 0 ||
      !TRANSCRIPT_RE.test(transcript) ||
      transcript.indexOf("-") !== -1
    ) {
      return { ok: false, code: "invalid-transcript", reason: "生成的 FTD 棋谱格式无效" };
    }
    return {
      ok: true,
      transcript: transcript,
      moveCount: coordinates.length,
      endingStatus: endingStatusFromMoves(position.moves, detail),
    };
  }

  function transcriptBatchItemKey(item) {
    return [
      Math.trunc(Number(item && item.table) || 0),
      normalizeFullName(item && (item.black || item.ftdBlack)),
      normalizeFullName(item && (item.white || item.ftdWhite)),
      text(item && item.oqGameId) || extractOqGameId(item),
    ].join("\n");
  }

  function confirmTranscriptBatchOnRound(round, batch, confirmedAt) {
    var pairings = round && Array.isArray(round.ftdPairings) ? round.ftdPairings : [];
    var items = batch && Array.isArray(batch.items) ? batch.items : [];
    var targetRound = Math.trunc(Number(batch && batch.round) || 0);
    var currentRound = Math.trunc(Number(round && round.round) || 0);
    if (!targetRound || targetRound !== currentRound) {
      return { count: 0, skipped: items.length, code: "round-changed" };
    }
    var targets = new Set(items.map(transcriptBatchItemKey));
    var timestamp = Number(confirmedAt);
    if (!Number.isFinite(timestamp) || timestamp <= 0) timestamp = Date.now();
    var count = 0;
    for (var i = 0; i < pairings.length; i += 1) {
      var pairing = pairings[i];
      if (!pairing || !targets.has(transcriptBatchItemKey(pairing))) continue;
      var gameId = extractOqGameId(pairing);
      if (!gameId) continue;
      pairing.ftdTranscriptImport = {
        status: "imported",
        oqGameId: gameId,
        confirmedAt: timestamp,
        confirmedBy: "user",
      };
      count += 1;
    }
    return { count: count, skipped: Math.max(0, items.length - count), code: count ? "confirmed" : "stale-batch" };
  }

  return {
    COORD_RE: COORD_RE,
    TRANSCRIPT_RE: TRANSCRIPT_RE,
    normalizeFullName: normalizeFullName,
    extractOqGameId: extractOqGameId,
    sanitizeTranscriptImport: sanitizeTranscriptImport,
    isCurrentTranscriptImport: isCurrentTranscriptImport,
    isByePairing: isByePairing,
    classifyPairingForTranscript: classifyPairingForTranscript,
    extractTranscriptFromOqDetail: extractTranscriptFromOqDetail,
    transcriptBatchItemKey: transcriptBatchItemKey,
    confirmTranscriptBatchOnRound: confirmTranscriptBatchOnRound,
  };
});
