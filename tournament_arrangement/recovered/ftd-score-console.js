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

  function splitName(value) {
    var parts = norm(value).split(" ");
    if (parts.length <= 1) return [norm(value)];
    return [parts[0], parts.slice(1).join(" ")];
  }

  function drawChinaFlag(ctx, x, y, w, h) {
    ctx.save();
    ctx.fillStyle = "#ee1c25";
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = "#ffde00";
    function star(cx, cy, r) {
      ctx.beginPath();
      for (var i = 0; i < 10; i += 1) {
        var angle = -Math.PI / 2 + (i * Math.PI) / 5;
        var radius = i % 2 === 0 ? r : r * 0.42;
        ctx.lineTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
      }
      ctx.closePath();
      ctx.fill();
    }
    star(x + w * 0.22, y + h * 0.28, h * 0.14);
    star(x + w * 0.42, y + h * 0.16, h * 0.05);
    star(x + w * 0.50, y + h * 0.30, h * 0.05);
    star(x + w * 0.50, y + h * 0.46, h * 0.05);
    star(x + w * 0.40, y + h * 0.58, h * 0.05);
    ctx.restore();
  }

  function drawDisc(ctx, x, y, r, color) {
    ctx.save();
    var gradient = ctx.createRadialGradient(x - r * 0.4, y - r * 0.5, r * 0.1, x, y, r);
    if (color === "white") {
      gradient.addColorStop(0, "#ffffff");
      gradient.addColorStop(1, "#d8d8d8");
      ctx.shadowColor = "rgba(255,255,255,.34)";
    } else {
      gradient.addColorStop(0, "#111111");
      gradient.addColorStop(1, "#000000");
      ctx.shadowColor = "rgba(255,255,255,.28)";
    }
    ctx.shadowBlur = 8;
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color === "white" ? "#f4f4f4" : "#666";
    ctx.stroke();
    ctx.restore();
  }

  function drawName(ctx, name, x, y, align) {
    var lines = splitName(name);
    ctx.save();
    ctx.textAlign = align || "left";
    ctx.fillStyle = "#b7b7b7";
    ctx.font = "700 22px Arial, sans-serif";
    ctx.fillText(lines[0] || "", x, y);
    if (lines.length > 1) {
      ctx.font = "600 22px Arial, sans-serif";
      ctx.fillText(lines[1] || "", x, y + 34);
    }
    ctx.restore();
  }

  function hasPairingScore(row) {
    return Number.isFinite(Number(row && row.blackScore)) && Number.isFinite(Number(row && row.whiteScore));
  }

  function drawScoreDisc(ctx, x, y, r, color, value) {
    drawDisc(ctx, x, y, r, color);
    ctx.save();
    ctx.fillStyle = color === "white" ? "#111111" : "#ffffff";
    ctx.strokeStyle = color === "white" ? "rgba(255,255,255,.55)" : "rgba(0,0,0,.55)";
    ctx.lineWidth = color === "white" ? 2 : 3;
    ctx.font = "900 21px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.strokeText(String(Math.trunc(Number(value))), x, y + 1);
    ctx.fillText(String(Math.trunc(Number(value))), x, y + 1);
    ctx.restore();
  }

  function buildPairingsCanvas(pairings, round) {
    var scale = Math.max(1, Math.min(3, window.devicePixelRatio || 2));
    var width = 1040;
    var headerHeight = 122;
    var rowHeight = 92;
    var footerHeight = 24;
    var height = headerHeight + rowHeight * pairings.length + footerHeight;
    var canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    var ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);

    ctx.fillStyle = "#211f1d";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#2b2927";
    ctx.fillRect(0, 0, width, headerHeight);
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.font = "700 34px Arial, sans-serif";
    ctx.fillText("Round " + (round == null ? "" : round), width / 2, 74);
    ctx.strokeStyle = "#6d6a66";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, headerHeight - 1);
    ctx.lineTo(width, headerHeight - 1);
    ctx.stroke();

    for (var i = 0; i < pairings.length; i += 1) {
      var row = pairings[i];
      var top = headerHeight + i * rowHeight;
      ctx.fillStyle = i % 2 === 0 ? "#242321" : "#211f1d";
      ctx.fillRect(10, top, width - 20, rowHeight);
      ctx.strokeStyle = "#33302d";
      ctx.beginPath();
      ctx.moveTo(10, top + rowHeight);
      ctx.lineTo(width - 10, top + rowHeight);
      ctx.stroke();

      ctx.fillStyle = "#e8e8e8";
      ctx.textAlign = "center";
      ctx.font = "700 22px Arial, sans-serif";
      ctx.fillText(String(row.table || i + 1), 48, top + 55);

      drawChinaFlag(ctx, 84, top + 30, 43, 30);
      drawName(ctx, row.black || "", 138, top + 38, "left");

      if (hasPairingScore(row)) {
        drawScoreDisc(ctx, 455, top + 46, 36, "black", row.blackScore);
        ctx.fillStyle = "#e8e8e8";
        ctx.font = "800 22px Arial, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("-", 520, top + 54);
        drawScoreDisc(ctx, 585, top + 46, 36, "white", row.whiteScore);
      }

      drawChinaFlag(ctx, 686, top + 30, 43, 30);
      drawName(ctx, row.white || "", 740, top + 38, "left");
    }

    return canvas;
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
        var blackBye = isByeName(blackName);
        var whiteBye = isByeName(whiteName);
        var score = Number(pair[0] && pair[0].score);
        var written = writtenByTable.get(table);
        var localHasScore = hasPairingScore(local) && Math.trunc(Number(local.blackScore)) + Math.trunc(Number(local.whiteScore)) === 64;
        var hasScore = !blackBye && !whiteBye && Number.isFinite(score) && Math.trunc(score) !== 0;
        return {
          table: table,
          black: blackName,
          white: whiteName,
          blackScore: blackBye || whiteBye ? (blackBye ? 31 : 33) : written ? written.blackScore : localHasScore ? Math.trunc(Number(local.blackScore)) : hasScore ? Math.trunc(score) : null,
          whiteScore: blackBye || whiteBye ? (whiteBye ? 31 : 33) : written ? written.whiteScore : localHasScore ? Math.trunc(Number(local.whiteScore)) : hasScore ? 64 - Math.trunc(score) : null,
        };
      });
      var label = groupLabel(groupResults, targetRound);
      downloadCanvasPng(buildPairingsCanvas(pngPairings, label), "ftd-" + label.replace("/", "-") + "-scores.png");
    }
  }
  console.log("done: wrote " + RESULTS.length + " ready result(s)");
})();
