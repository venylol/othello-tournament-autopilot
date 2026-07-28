(async function () {
  var TOURNAMENT_ID = __FTD_SCORE_TOURNAMENT_ID__;
  var TARGET_ROUND = __FTD_SCORE_ROUND__;
  var RESULTS = __FTD_SCORE_RESULTS__;
  var LOCAL_PAIRINGS = [];
  try {
    __FTD_SCORE_PAIRINGS_ASSIGN__
  } catch (_) {
    LOCAL_PAIRINGS = [];
  }
  var DOWNLOAD_PNG = __FTD_SCORE_DOWNLOAD_PNG__;
  __FTD_SCORE_PNG_RENDERER_SOURCE__
  var SCORE_PNG_RENDERER = window.FTD_SCORE_PNG_RENDERER;
  if (!SCORE_PNG_RENDERER) throw new Error("FTD score PNG renderer missing");

  function norm(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function normKey(value) {
    return norm(value).toLowerCase();
  }

  function lastToken(value) {
    var parts = normKey(value).split(" ").filter(Boolean);
    return parts[parts.length - 1] || "";
  }

  function nameMatches(ftdName, localName) {
    var a = normKey(ftdName);
    var b = normKey(localName);
    return a === b || a.endsWith(" " + b) || b.endsWith(" " + a) || lastToken(a) === lastToken(b);
  }

  function playerName(p) {
    return (
      (p && (p.name || p.playerName || p.fullName)) ||
      [p && p.firstName, p && p.lastName].filter(Boolean).join(" ") ||
      [p && p.first_name, p && p.last_name].filter(Boolean).join(" ") ||
      (p && p.username) ||
      ""
    );
  }

  function isByeName(value) {
    return normKey(value) === "bye";
  }

  function hasPairingScore(row) {
    return SCORE_PNG_RENDERER.hasPairingScore(row);
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      if (a.parentNode) a.parentNode.removeChild(a);
    }, 1000);
  }

  function dataUrlToBlob(dataUrl) {
    var parts = dataUrl.split(",");
    var mime = (parts[0].match(/:(.*?);/) || [])[1] || "image/png";
    var bin = atob(parts[1]);
    var len = bin.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i += 1) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  function downloadCanvasPng(canvas, filename) {
    if (canvas.toBlob) {
      canvas.toBlob(function (blob) {
        if (blob) downloadBlob(blob, filename);
      }, "image/png");
    } else {
      downloadBlob(dataUrlToBlob(canvas.toDataURL("image/png")), filename);
    }
  }

  function findSocket() {
    function isSocket(x) {
      return x && typeof x === "object" && typeof x.emit === "function" && typeof x.on === "function" && typeof x.off === "function";
    }
    var root = document.getElementById("root");
    var key = root && Object.keys(root).find(function (k) { return k.indexOf("__reactContainer$") === 0; });
    var start = key ? root[key] : null;
    var seen = new WeakSet();
    function scanObj(obj, depth) {
      if (!obj || typeof obj !== "object" || seen.has(obj) || depth > 6) return null;
      seen.add(obj);
      if (isSocket(obj)) return obj;
      if (isSocket(obj.socket)) return obj.socket;
      if (isSocket(obj.value && obj.value.socket)) return obj.value.socket;
      var keys = Object.keys(obj);
      for (var i = 0; i < keys.length; i += 1) {
        var k = keys[i];
        if (k === "return" || k === "alternate" || k === "stateNode") continue;
        var found = scanObj(obj[k], depth + 1);
        if (found) return found;
      }
      return null;
    }
    function walkFiber(fiber) {
      var f = fiber;
      while (f) {
        var found = scanObj(f.memoizedProps, 0) || scanObj(f.pendingProps, 0) || scanObj(f.memoizedState, 0);
        if (found) return found;
        if (f.child) {
          var childFound = walkFiber(f.child);
          if (childFound) return childFound;
        }
        f = f.sibling;
      }
      return null;
    }
    return walkFiber(start);
  }

  function requestRound(socket, tournamentId, round) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        socket.off("otb-get-round", handler);
        reject(new Error("read round timeout"));
      }, 8000);
      function handler(payload) {
        clearTimeout(timer);
        socket.off("otb-get-round", handler);
        resolve(payload || {});
      }
      socket.on("otb-get-round", handler);
      socket.emit("get-otb-rounds", tournamentId, round);
    });
  }

  var socket = findSocket();
  if (!socket) throw new Error("FTD socket not found");

  function itemRound(item) {
    return Number.isFinite(Number(item && item.ftdRound)) ? Math.trunc(Number(item.ftdRound)) : TARGET_ROUND;
  }
  function itemTable(item) {
    return Number.isFinite(Number(item && item.ftdTable)) ? Math.trunc(Number(item.ftdTable)) : Number(item && item.table);
  }
  function groupLabel(items, round) {
    var stage = String(items[0] && items[0].ftdStage || "").trim();
    return stage || ("round-" + round);
  }

  var groupedResults = new Map();
  RESULTS.forEach(function (item) {
    var targetRound = itemRound(item);
    if (!groupedResults.has(targetRound)) groupedResults.set(targetRound, []);
    groupedResults.get(targetRound).push(item);
  });
  var groupedLocal = new Map();
  (Array.isArray(LOCAL_PAIRINGS) ? LOCAL_PAIRINGS : []).forEach(function (item) {
    var targetRound = itemRound(item);
    if (!groupedLocal.has(targetRound)) groupedLocal.set(targetRound, []);
    groupedLocal.get(targetRound).push(item);
  });

  for (var groupEntry of groupedResults.entries()) {
    var targetRound = groupEntry[0];
    var groupResults = groupEntry[1];
    var data = await requestRound(socket, TOURNAMENT_ID, targetRound);
    var byTable = new Map(
      ((data && data.pairing) || []).filter(Array.isArray).map(function (pair, i) {
        return [Number((pair[0] && pair[0].gameNumber) == null ? i : pair[0].gameNumber) + 1, pair];
      }),
    );
    var writtenByTable = new Map();
    for (var i = 0; i < groupResults.length; i += 1) {
      var r = groupResults[i];
      var targetTable = itemTable(r);
      var pair = byTable.get(targetTable);
      if (!pair) throw new Error("table not found: " + groupLabel(groupResults, targetRound) + " #" + targetTable);
      var ftdBlack = playerName(pair[0]);
      var ftdWhite = playerName(pair[1]);
      if (normKey(ftdBlack) === "bye" || normKey(ftdWhite) === "bye") continue;
      if (!nameMatches(ftdBlack, r.black) || !nameMatches(ftdWhite, r.white)) {
        throw new Error("name mismatch " + groupLabel(groupResults, targetRound) + " #" + targetTable + ": FTD=" + ftdBlack + " vs " + ftdWhite);
      }
      socket.emit("score-otb", TOURNAMENT_ID, pair[0].gameId, r.blackScore);
      writtenByTable.set(targetTable, {
        blackScore: r.blackScore,
        whiteScore: Number.isFinite(Number(r.whiteScore)) ? r.whiteScore : 64 - r.blackScore,
      });
      console.log(groupLabel(groupResults, targetRound) + " #" + targetTable + ": " + ftdBlack + " " + r.blackScore + "-" + (64 - r.blackScore) + " " + ftdWhite);
      await new Promise(function (resolve) { setTimeout(resolve, 300); });
    }

    if (DOWNLOAD_PNG) {
      await new Promise(function (resolve) { setTimeout(resolve, 600); });
      var latestData = await requestRound(socket, TOURNAMENT_ID, targetRound);
      var latestByTable = new Map(
        ((latestData && latestData.pairing) || []).filter(Array.isArray).map(function (pair, i) {
          return [Number((pair[0] && pair[0].gameNumber) == null ? i : pair[0].gameNumber) + 1, pair];
        }),
      );
      var localByTable = new Map(
        (groupedLocal.get(targetRound) || []).map(function (item) { return [itemTable(item), item || {}]; }),
      );
      var pngPairings = Array.from(latestByTable.entries()).sort(function (a, b) { return a[0] - b[0]; }).map(function (entry) {
        var table = entry[0];
        var pair = entry[1];
        var local = localByTable.get(table) || {};
        var blackName = local.black || playerName(pair[0]);
        var whiteName = local.white || playerName(pair[1]);
        var score = Number(pair[0] && pair[0].score);
        var written = writtenByTable.get(table);
        return SCORE_PNG_RENDERER.buildScoreRow({
          table: table,
          black: blackName,
          white: whiteName,
          written: written || null,
          local: local,
          ftdBlackScore: score,
        });
      });
      var label = groupLabel(groupResults, targetRound);
      downloadCanvasPng(SCORE_PNG_RENDERER.buildPairingsCanvas(pngPairings, label), "ftd-" + label.replace("/", "-") + "-scores.png");
    }
  }
  console.log("done: wrote " + RESULTS.length + " ready result(s)");
})();
