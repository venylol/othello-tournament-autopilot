void (async function () {
  var TARGET_ROUND = __FTD_TARGET_ROUND__;
  var TARGET_STAGE = __FTD_TARGET_STAGE__;
  var TARGET_URL = __FTD_TOURNAMENT_URL__;
  var FTD_PLAYER_ACCOUNT_MAPPING = __FTD_PLAYER_ACCOUNT_MAPPING__;
  __FTD_PAIRING_PNG_RENDERER_SOURCE__
  var PAIRING_PNG_RENDERER = window.FTD_PAIRING_PNG_RENDERER;
  if (!PAIRING_PNG_RENDERER) throw new Error("FTD pairing PNG renderer missing");

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

  function downloadPairingsPng(payload, filename) {
    var canvas = PAIRING_PNG_RENDERER.buildPairingsCanvas(payload, accountForName);
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
