void (async function () {
  var TARGET_ROUND = __FTD_TARGET_ROUND__;
  var TARGET_STAGE = __FTD_TARGET_STAGE__;
  var TARGET_URL = __FTD_TOURNAMENT_URL__;
  var FTD_PLAYER_ACCOUNT_MAPPING = __FTD_PLAYER_ACCOUNT_MAPPING__;

  function norm(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function safeFilePart(value) {
    return (
      norm(value)
        .replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_")
        .replace(/\s+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 80) || "ftd"
    );
  }

  function isByeName(value) {
    return norm(value).toLowerCase() === "bye";
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

  function fitText(ctx, text, maxWidth) {
    var raw = String(text || "");
    if (!raw || !maxWidth || ctx.measureText(raw).width <= maxWidth) return raw;
    var out = raw;
    while (out.length > 1 && ctx.measureText(out + "…").width > maxWidth) {
      out = out.slice(0, -1);
    }
    return out + "…";
  }

  function drawName(ctx, name, x, y, align, maxWidth) {
    var lines = splitName(name);
    ctx.save();
    ctx.textAlign = align || "left";
    ctx.fillStyle = "#b7b7b7";
    ctx.font = "700 22px Arial, sans-serif";
    var first = fitText(ctx, lines[0] || "", maxWidth || 180);
    ctx.fillText(first, x, y);
    var width = ctx.measureText(first).width;
    if (lines.length > 1) {
      ctx.font = "600 22px Arial, sans-serif";
      var second = fitText(ctx, lines[1] || "", maxWidth || 180);
      ctx.fillText(second, x, y + 30);
      width = Math.max(width, ctx.measureText(second).width);
    }
    ctx.restore();
    return width;
  }

  function normalizeAccountKey(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[\s\u3000\[\]()（）【】{}<>《》,，。:：;；"“”'‘’\-_\/\\|]+/g, "");
  }

  function accountForName(name) {
    var mapping = FTD_PLAYER_ACCOUNT_MAPPING && typeof FTD_PLAYER_ACCOUNT_MAPPING === "object"
      ? FTD_PLAYER_ACCOUNT_MAPPING
      : {};
    var index = {};
    if (mapping.accountIndex && typeof mapping.accountIndex === "object") {
      Object.keys(mapping.accountIndex).forEach(function (key) {
        index[key] = mapping.accountIndex[key];
      });
    } else {
      Object.keys(mapping).forEach(function (key) {
        index[key] = mapping[key];
      });
    }
    if (Array.isArray(mapping.players)) {
      mapping.players.forEach(function (row) {
        if (!row || typeof row !== "object" || row.deleted === true) return;
        var account = norm(row.account || "");
        if (!account) return;
        [
          row.ftdName,
          row.displayName,
          row.name,
          row.wofName,
          row.ftdId
        ].forEach(function (candidate) {
          var rowKey = normalizeAccountKey(candidate);
          if (rowKey) index[rowKey] = { account: account };
        });
      });
    }
    var key = normalizeAccountKey(name);
    var item = key ? index[key] : null;
    var account = item && typeof item === "object" ? item.account : item;
    return norm(account || "");
  }

  function drawOpponentAccount(ctx, account, x, y, align, maxWidth) {
    var text = norm(account);
    if (!text || text === "?" || text === "？") text = "【裁判未登记】";
    ctx.save();
    ctx.textAlign = align || "left";
    ctx.fillStyle = "#f2d36b";
    ctx.textBaseline = "middle";
    ctx.font = "700 15px Arial, sans-serif";
    var label = fitText(ctx, text, maxWidth || 150);
    ctx.fillText(label, x, y);
    var width = ctx.measureText(label).width;
    ctx.restore();
    return width;
  }

  function pad2(value) {
    var n = Math.max(0, Math.trunc(Number(value) || 0));
    return n < 10 ? "0" + n : String(n);
  }

  function pairingPassword(round, table) {
    return pad2(round || 1) + pad2(table || 1);
  }

  function localTableForPayload(payload, table) {
    return norm(payload && payload.stage).toUpperCase() === "3/4" ? 2 : table;
  }

  function pairingTitle(payload) {
    var stage = norm(payload && payload.stage).toUpperCase();
    if (stage === "SF") return "半决赛";
    if (stage === "F") return "决赛";
    if (stage === "3/4") return "3/4 决赛";
    return "Round " + (payload && payload.round != null ? payload.round : "");
  }

  function drawPassword(ctx, password, x, y, align) {
    ctx.save();
    ctx.textAlign = align || "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#f2d36b";
    ctx.font = "800 21px Arial, sans-serif";
    ctx.fillText(password, x, y);
    ctx.restore();
  }

  function drawPasswordBlock(ctx, password, account, x, y) {
    drawPassword(ctx, password, x, y, "center");
    drawOpponentAccount(ctx, account, x, y + 25, "center", 170);
  }

  function drawByeNotice(ctx, x, y) {
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#f2d36b";
    ctx.font = "700 16px 'Microsoft YaHei', 'PingFang SC', 'Noto Sans SC', Arial, sans-serif";
    ctx.fillText("自动算赢", x, y - 2);
    ctx.font = "700 15px 'Microsoft YaHei', 'PingFang SC', 'Noto Sans SC', Arial, sans-serif";
    ctx.fillText("无需匹配", x, y + 24);
    ctx.restore();
  }

  function buildPairingsCanvas(payload) {
    var pairings = payload && payload.blankPairings && payload.blankPairings.length
      ? payload.blankPairings
      : (payload && payload.pairings) || [];
    var scale = Math.max(1, Math.min(3, window.devicePixelRatio || 2));
    var width = 1040;
    var headerHeight = 132;
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
    ctx.fillText(pairingTitle(payload), width / 2, 58);
    ctx.fillStyle = "#d7c77a";
    ctx.font = "600 17px Arial, sans-serif";
    ctx.fillText("四位数字为你本轮的对局密码；密码下方为你对手的OQ账号，若不匹配请及时认输并汇报裁判和对手", width / 2, 92);
    ctx.strokeStyle = "#6d6a66";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, headerHeight - 1);
    ctx.lineTo(width, headerHeight - 1);
    ctx.stroke();

    for (var i = 0; i < pairings.length; i += 1) {
      var row = pairings[i];
      var localTable = localTableForPayload(payload, row.table || i + 1);
      var blackIsBye = isByeName(row.black);
      var whiteIsBye = isByeName(row.white);
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
      ctx.fillText(String(localTable), 48, top + 55);

      if (!blackIsBye) {
        drawChinaFlag(ctx, 84, top + 30, 43, 30);
        drawName(ctx, row.black || "", 138, top + 34, "left", 118);
        if (whiteIsBye) {
          drawByeNotice(ctx, 302, top + 43);
        } else {
          drawPasswordBlock(
            ctx,
            pairingPassword(payload.round, localTable),
            row.whiteAccount || accountForName(row.white),
            302,
            top + 43,
          );
        }
      }

      drawDisc(ctx, 410, top + 46, 36, "black");
      ctx.fillStyle = "#e8e8e8";
      ctx.font = "800 22px Arial, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("-", 474, top + 54);
      drawDisc(ctx, 538, top + 46, 36, "white");

      if (!whiteIsBye) {
        drawChinaFlag(ctx, 594, top + 30, 43, 30);
        drawName(ctx, row.white || "", 648, top + 34, "left", 118);
        if (blackIsBye) {
          drawByeNotice(ctx, 842, top + 43);
        } else {
          drawPasswordBlock(
            ctx,
            pairingPassword(payload.round, localTable),
            row.blackAccount || accountForName(row.black),
            842,
            top + 43,
          );
        }
      }
    }

    return canvas;
  }

  function downloadPairingsPng(payload, filename) {
    var canvas = buildPairingsCanvas(payload);
    if (canvas.toBlob) {
      canvas.toBlob(function (blob) {
        if (blob) downloadBlob(blob, filename);
      }, "image/png");
    } else {
      downloadBlob(dataUrlToBlob(canvas.toDataURL("image/png")), filename);
    }
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

  function findSocket() {
    function isSocket(x) {
      return x && typeof x === "object" && typeof x.emit === "function" && typeof x.on === "function" && typeof x.off === "function";
    }

    var root = document.getElementById("root");
    var key = root && Object.keys(root).find(function (k) { return k.indexOf("__reactContainer$") === 0; });
    var start = key ? root[key] : null;
    var seen = new WeakSet();

    function scanObj(obj, depth) {
      if (!obj || typeof obj !== "object" || seen.has(obj) || depth > 4) return null;
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

  function parseTarget() {
    var raw = norm(TARGET_URL) || location.href;
    var match = raw.match(/\/(live|tournaments)\/([^/?#\s]+)/);
    if (!match) match = location.href.match(/\/(live|tournaments)\/([^/?#\s]+)/);
    if (!match) throw new Error("没有找到 FTD 赛事链接。请在本地比分页填写 /live/ID 或 /tournaments/ID。");
    return {
      kind: match[1] === "live" ? "otb" : "online",
      id: match[2],
      url: raw,
    };
  }

  function playerName(p) {
    if (!p || p.id === -1) return "BYE";
    return norm(p.wof_name || [p.surname, p.name].filter(Boolean).join(" ") || p.nick || p.username || p.id);
  }

  function normalizePair(pair, index) {
    if (typeof pair === "string") return null;
    if (!Array.isArray(pair) || pair.length < 2) return null;

    var black = pair[0];
    var white = pair[1];
    if (black && black.id === -1) {
      black = pair[1];
      white = pair[0];
    }

    var tableRaw = Number(pair[0] && pair[0].gameNumber);
    var table = Number.isFinite(tableRaw) ? tableRaw + 1 : index + 1;

    return {
      table: table,
      black: playerName(black),
      white: playerName(white),
      blackScore: null,
      whiteScore: null,
      gameId: pair[0] && pair[0].gameId,
      raw: pair,
    };
  }

  function requestRound(socket, target, round) {
    return new Promise(function (resolve, reject) {
      var eventName = target.kind === "otb" ? "otb-get-round" : "online-get-round";
      var emitName = target.kind === "otb" ? "get-otb-rounds" : "get-online-rounds";
      var timer = setTimeout(function () {
        socket.off(eventName, handler);
        reject(new Error("等待 " + eventName + " 超时"));
      }, 8000);

      function handler(payload) {
        clearTimeout(timer);
        socket.off(eventName, handler);
        resolve(payload || {});
      }

      socket.on(eventName, handler);
      socket.emit(emitName, target.id, round);
    });
  }

  var roundNumber = Math.max(1, Math.trunc(Number(TARGET_ROUND) || 1));
  var target = parseTarget();
  var socket = findSocket();
  if (!socket) throw new Error("没有找到 FTD 页面里的 socket。请确认 FTD 页面已加载完成、已登录。");

  function stageRoundDefinitions(roundNames, targetStage) {
    var names = Array.isArray(roundNames) ? roundNames : [];
    var wanted = targetStage === "semifinal" ? ["SF"] : targetStage === "finals" ? ["F", "3/4"] : [];
    return wanted.map(function (stage) {
      var found = names.find(function (item) {
        return norm(item && item.round_name).toUpperCase() === stage;
      });
      if (!found || !Number.isFinite(Number(found.round))) {
        throw new Error("FTD 没有返回 " + stage + " 阶段；请确认淘汰赛配对已经生成");
      }
      return { stage: stage, round: Math.trunc(Number(found.round)) };
    });
  }

  var definitions = [];
  if (TARGET_STAGE === "semifinal" || TARGET_STAGE === "finals") {
    var discovery = await requestRound(socket, target, 1);
    definitions = stageRoundDefinitions(discovery && discovery.roundNames, TARGET_STAGE);
  } else {
    definitions = [{ stage: "", round: roundNumber }];
  }

  var exportedPayloads = [];
  for (var definitionIndex = 0; definitionIndex < definitions.length; definitionIndex += 1) {
    var definition = definitions[definitionIndex];
    var data = await requestRound(socket, target, definition.round);
    var pairings = ((data && data.pairing) || []).map(normalizePair).filter(Boolean);
    var round = roundNumber;
    var blankPairings = pairings.map(function (p) {
      return {
        table: p.table,
        black: p.black,
        white: p.white,
        blackAccount: accountForName(p.black),
        whiteAccount: accountForName(p.white),
        blackScore: null,
        whiteScore: null,
      };
    });
    var payload = {
      source: target.kind === "otb" ? "ftd-otb-socket-full-round" : "ftd-online-socket-full-round",
      url: target.url,
      title: document.title,
      exportedAt: new Date().toISOString(),
      competitionName: norm(document.querySelector("nav") && document.querySelector("nav").textContent) || document.title,
      round: round,
      ftdRound: definition.round,
      stage: definition.stage,
      roundName: definition.stage,
      pairings: pairings,
      blankPairings: blankPairings,
      debug: {
        tournamentId: target.id,
        targetKind: target.kind,
        pairingCount: pairings.length,
        rawPairingCount: Array.isArray(data.pairing) ? data.pairing.length : 0,
        responseKeys: Object.keys(data || {}),
      },
    };

    if (!pairings.length) console.warn("FTD 导出得到 0 台配对。返回数据：", data);
    var fileLabel = definition.stage || ("round-" + roundNumber);
    var baseName = "ftd-" + safeFilePart(fileLabel);
    if (TARGET_STAGE !== "finals") {
      downloadBlob(
        new Blob([JSON.stringify(payload, null, 2) + "\n"], { type: "application/json;charset=utf-8" }),
        baseName + ".json",
      );
    }
    downloadPairingsPng(payload, baseName + "-pairings.png");
    exportedPayloads.push(payload);
    if (definitions.length > 1) await new Promise(function (resolve) { setTimeout(resolve, 500); });
  }

  var exportedResult = exportedPayloads.length === 1 ? exportedPayloads[0] : exportedPayloads;
  if (TARGET_STAGE === "finals") {
    var firstPayload = exportedPayloads[0] || {};
    exportedResult = {
      source: "ftd-combined-finals",
      url: firstPayload.url || target.url,
      title: firstPayload.title || document.title,
      exportedAt: new Date().toISOString(),
      competitionName: firstPayload.competitionName || document.title,
      round: roundNumber,
      stage: "finals",
      roundName: "finals",
      ftdRounds: exportedPayloads,
      debug: {
        tournamentId: target.id,
        targetKind: target.kind,
        stages: exportedPayloads.map(function (item) { return item.stage; }),
        ftdRounds: exportedPayloads.map(function (item) { return item.ftdRound; }),
      },
    };
    downloadBlob(
      new Blob([JSON.stringify(exportedResult, null, 2) + "\n"], { type: "application/json;charset=utf-8" }),
      "ftd-finals.json",
    );
  }

  window.__ftdPayload = exportedResult;
  setTimeout(function () {
    try {
      console.clear();
    } catch (_) {}
  }, 80);
})();
