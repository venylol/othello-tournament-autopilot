(async function () {
  "use strict";

  var TOURNAMENT_ID = __FTD_TRANSCRIPT_TOURNAMENT_ID__;
  var TARGET_ROUND = __FTD_TRANSCRIPT_ROUND__;
  var GAMES = __FTD_TRANSCRIPT_GAMES__;
  var RESULT_GLOBAL = "__ftdTranscriptImportResult";

  function norm(value) {
    var result = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    try { result = result.normalize("NFKC"); } catch (_) {}
    return result.toLowerCase();
  }

  function playerName(player) {
    if (!player || player.id === -1) return "BYE";
    return (
      player.wof_name ||
      [player.surname, player.name].filter(Boolean).join(" ") ||
      player.playerName ||
      player.fullName ||
      [player.lastName, player.firstName].filter(Boolean).join(" ") ||
      [player.last_name, player.first_name].filter(Boolean).join(" ") ||
      player.nick ||
      player.username ||
      ""
    );
  }

  function validTranscript(value) {
    var transcript = String(value || "");
    return Boolean(
      transcript &&
      transcript.length % 2 === 0 &&
      transcript.length <= 120 &&
      /^[a-h1-8]+$/.test(transcript) &&
      transcript.indexOf("-") === -1
    );
  }

  function findSocket() {
    function isSocket(value) {
      return value && typeof value === "object" &&
        typeof value.emit === "function" &&
        typeof value.on === "function" &&
        typeof value.off === "function";
    }
    var root = document.getElementById("root");
    var key = root && Object.keys(root).find(function (name) {
      return name.indexOf("__reactContainer$") === 0;
    });
    var start = key ? root[key] : null;
    var seen = new WeakSet();

    function scanObject(value, depth) {
      if (!value || typeof value !== "object" || seen.has(value) || depth > 6) return null;
      seen.add(value);
      if (isSocket(value)) return value;
      if (isSocket(value.socket)) return value.socket;
      if (isSocket(value.value && value.value.socket)) return value.value.socket;
      var keys = Object.keys(value);
      for (var i = 0; i < keys.length; i += 1) {
        var name = keys[i];
        if (name === "return" || name === "alternate" || name === "stateNode") continue;
        var found = scanObject(value[name], depth + 1);
        if (found) return found;
      }
      return null;
    }

    function walkFiber(fiber) {
      var current = fiber;
      while (current) {
        var found = scanObject(current.memoizedProps, 0) ||
          scanObject(current.pendingProps, 0) ||
          scanObject(current.memoizedState, 0);
        if (found) return found;
        if (current.child) {
          var childFound = walkFiber(current.child);
          if (childFound) return childFound;
        }
        current = current.sibling;
      }
      return null;
    }

    return walkFiber(start);
  }

  function requestRound(socket, round) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        socket.off("otb-get-round", handler);
        reject(new Error("读取 FTD 第 " + round + " 轮超时"));
      }, 8000);
      function handler(payload) {
        clearTimeout(timer);
        socket.off("otb-get-round", handler);
        resolve(payload || {});
      }
      socket.on("otb-get-round", handler);
      socket.emit("get-otb-rounds", TOURNAMENT_ID, round);
    });
  }

  function pairingsByTable(roundData) {
    return new Map(
      ((roundData && roundData.pairing) || []).filter(Array.isArray).map(function (pair, index) {
        var gameNumber = pair[0] && pair[0].gameNumber;
        return [Number(gameNumber == null ? index : gameNumber) + 1, pair];
      }),
    );
  }

  function makeResult(fields) {
    var rounds = Array.from(new Set(GAMES.map(itemRound))).sort(function (a, b) { return a - b; });
    return Object.assign({
      ok: false,
      tournamentId: String(TOURNAMENT_ID),
      round: rounds.length === 1 ? rounds[0] : null,
      rounds: rounds,
      intended: GAMES.length,
      writtenAndVerified: [],
      alreadyPresent: [],
      failedReadback: [],
      conflicts: [],
      preflightErrors: [],
      cancelled: false,
    }, fields || {});
  }

  function itemRound(item) {
    return Number.isFinite(Number(item && item.ftdRound))
      ? Math.trunc(Number(item.ftdRound))
      : Number(TARGET_ROUND);
  }

  function itemTable(item) {
    return Number.isFinite(Number(item && item.ftdTable))
      ? Math.trunc(Number(item.ftdTable))
      : Number(item && item.table);
  }

  function itemStage(item) {
    return String(item && item.ftdStage || "").trim();
  }

  function groupLabel(round, items) {
    var stage = itemStage(items && items[0]);
    return stage ? stage + "=" + round : "round=" + round;
  }

  var socket = findSocket();
  if (!socket) throw new Error("未找到 FTD socket，请确认 /live 页面已加载且已登录");

  var groupedGames = new Map();
  GAMES.forEach(function (item) {
    var round = itemRound(item);
    if (!groupedGames.has(round)) groupedGames.set(round, []);
    groupedGames.get(round).push(item);
  });
  var writable = [];
  var alreadyPresent = [];
  var conflicts = [];
  var preflightErrors = [];

  for (var groupEntry of groupedGames.entries()) {
    var targetRound = groupEntry[0];
    var groupGames = groupEntry[1];
    var firstRound = await requestRound(socket, targetRound);
    var firstByTable = pairingsByTable(firstRound);
    for (var i = 0; i < groupGames.length; i += 1) {
      var intended = groupGames[i] || {};
      var table = itemTable(intended);
      var base = { round: targetRound, stage: itemStage(intended), table: table, oqGameId: intended.oqGameId };
      var pair = firstByTable.get(table);
      if (!pair || !pair[0] || !pair[1]) {
        preflightErrors.push(Object.assign({}, base, { reason: "table missing or not a two-player pairing" }));
        continue;
      }
      var liveBlack = playerName(pair[0]);
      var liveWhite = playerName(pair[1]);
      if (norm(liveBlack) === "bye" || norm(liveWhite) === "bye") {
        preflightErrors.push(Object.assign({}, base, { reason: "live FTD row is BYE" }));
        continue;
      }
      if (norm(liveBlack) !== norm(intended.ftdBlack) || norm(liveWhite) !== norm(intended.ftdWhite)) {
        preflightErrors.push(Object.assign({}, base, {
          reason: "normalized full FTD player names differ",
          expected: [intended.ftdBlack, intended.ftdWhite],
          live: [liveBlack, liveWhite],
        }));
        continue;
      }
      if (!pair[0].gameId) {
        preflightErrors.push(Object.assign({}, base, { reason: "missing live FTD game ID" }));
        continue;
      }
      if (!validTranscript(intended.transcript)) {
        preflightErrors.push(Object.assign({}, base, { reason: "invalid intended transcript" }));
        continue;
      }
      var existing = String(pair[0].transcript || "").trim();
      if (!existing) {
        writable.push({ intended: intended, ftdGameId: pair[0].gameId, round: targetRound, table: table });
      } else if (existing === intended.transcript) {
        alreadyPresent.push(base);
      } else {
        conflicts.push(Object.assign({}, base, {
          existingTranscript: existing,
          intendedTranscript: intended.transcript,
        }));
      }
    }
  }

  if (preflightErrors.length || conflicts.length) {
    var failedPreflight = makeResult({
      conflicts: conflicts,
      preflightErrors: preflightErrors,
      alreadyPresent: alreadyPresent,
      phase: "preflight",
    });
    window[RESULT_GLOBAL] = failedPreflight;
    console.error("FTD 棋谱导入预检失败；未写入任何棋谱", failedPreflight);
    throw new Error("FTD 棋谱导入预检失败；详情见 window." + RESULT_GLOBAL);
  }

  var roundLabels = Array.from(groupedGames.entries()).map(function (entry) {
    return groupLabel(entry[0], entry[1]);
  });
  if (!window.confirm("确认同步导入 FTD " + roundLabels.join("、") + " 的棋谱？可写 " + writable.length + " 局，已存在 " + alreadyPresent.length + " 局。")) {
    var cancelled = makeResult({
      alreadyPresent: alreadyPresent,
      cancelled: true,
      phase: "confirmation",
    });
    window[RESULT_GLOBAL] = cancelled;
    console.log("已取消 FTD 棋谱导入", cancelled);
    return;
  }

  for (var writeIndex = 0; writeIndex < writable.length; writeIndex += 1) {
    var writeItem = writable[writeIndex];
    socket.emit(
      "otb-paste-transcript",
      TOURNAMENT_ID,
      writeItem.ftdGameId,
      writeItem.intended.transcript,
    );
    await new Promise(function (resolve) { setTimeout(resolve, 350); });
  }

  await new Promise(function (resolve) { setTimeout(resolve, 900); });
  var writtenAndVerified = [];
  var alreadyPresentAndVerified = [];
  var failedReadback = [];
  var writableTables = new Set(writable.map(function (item) {
    return item.round + ":" + item.table;
  }));

  for (var verifyGroupEntry of groupedGames.entries()) {
    var verifyRound = verifyGroupEntry[0];
    var verifyGames = verifyGroupEntry[1];
    var pending = verifyGames.slice();
    var lastByTable = new Map();
    var lastReadError = "";
    for (var attempt = 0; attempt < 4 && pending.length; attempt += 1) {
      if (attempt) await new Promise(function (resolve) { setTimeout(resolve, 700); });
      try {
        lastByTable = pairingsByTable(await requestRound(socket, verifyRound));
        lastReadError = "";
      } catch (readbackError) {
        lastReadError = String(readbackError && readbackError.message || readbackError);
        continue;
      }
      pending = pending.filter(function (item) {
        var table = itemTable(item);
        var pair = lastByTable.get(table);
        return String(pair && pair[0] && pair[0].transcript || "").trim() !== item.transcript;
      });
    }
    for (var verifyIndex = 0; verifyIndex < verifyGames.length; verifyIndex += 1) {
      var verifiedItem = verifyGames[verifyIndex];
      var verifiedTable = itemTable(verifiedItem);
      var readbackPair = lastByTable.get(verifiedTable);
      var readbackTranscript = String(readbackPair && readbackPair[0] && readbackPair[0].transcript || "").trim();
      var verifiedSummary = {
        round: verifyRound,
        stage: itemStage(verifiedItem),
        table: verifiedTable,
        oqGameId: verifiedItem.oqGameId,
      };
      if (readbackTranscript === verifiedItem.transcript) {
        if (writableTables.has(verifyRound + ":" + verifiedTable)) writtenAndVerified.push(verifiedSummary);
        else alreadyPresentAndVerified.push(verifiedSummary);
      } else {
        failedReadback.push(Object.assign({}, verifiedSummary, {
          expectedTranscript: verifiedItem.transcript,
          readbackTranscript: readbackTranscript,
          reason: lastReadError,
        }));
      }
    }
  }

  var result = makeResult({
    ok: failedReadback.length === 0,
    phase: "readback",
    writtenAndVerified: writtenAndVerified,
    alreadyPresent: alreadyPresentAndVerified,
    failedReadback: failedReadback,
  });
  window[RESULT_GLOBAL] = result;
  console.log("FTD 棋谱导入汇总", {
    rounds: result.rounds,
    writtenAndVerified: writtenAndVerified.length,
    alreadyPresent: alreadyPresentAndVerified.length,
    failedReadback: failedReadback.length,
    conflicts: 0,
  });
  if (failedReadback.length) console.error("FTD 棋谱回读失败", failedReadback);
})();
