void (async function () {
  var TARGET_URL = __FTD_TOURNAMENT_URL__;

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

  function downloadJson(payload, filename) {
    var blob = new Blob([JSON.stringify(payload, null, 2) + "\n"], {
      type: "application/json;charset=utf-8",
    });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      if (link.parentNode) link.parentNode.removeChild(link);
    }, 1000);
  }

  function parseTarget() {
    var raw = norm(TARGET_URL) || window.location.href;
    var url;
    try {
      url = new URL(raw, window.location.href);
    } catch (_) {
      url = new URL(window.location.href);
    }
    var liveMatch = url.pathname.match(/\/live\/(\d+)/i);
    var onlineMatch = url.pathname.match(/\/tournaments\/(\d+)/i);
    var looseMatch = raw.match(/\b(\d{2,})\b/);
    var id =
      (liveMatch && liveMatch[1]) ||
      (onlineMatch && onlineMatch[1]) ||
      (looseMatch && looseMatch[1]) ||
      "";
    return {
      id: id,
      kind: liveMatch || !onlineMatch ? "otb" : "online",
      url: raw,
    };
  }

  function isSocket(value) {
    return (
      value &&
      typeof value.emit === "function" &&
      typeof value.on === "function" &&
      typeof value.off === "function"
    );
  }

  function reactRootFiber() {
    var root = document.getElementById("root");
    if (!root) return null;
    var key = Object.keys(root).find(function (item) {
      return item.indexOf("__reactContainer$") === 0 || item.indexOf("__reactFiber$") === 0;
    });
    return key ? root[key] : null;
  }

  function scanObject(start, predicate, options) {
    var maxDepth = options && Number.isFinite(options.maxDepth) ? options.maxDepth : 8;
    var seen = new WeakSet();
    var matches = [];

    function scan(value, path, depth) {
      if (!value || typeof value !== "object" || seen.has(value) || depth > maxDepth) return;
      seen.add(value);
      if (predicate(value, path)) matches.push({ value: value, path: path });
      if (Array.isArray(value)) {
        for (var i = 0; i < value.length; i += 1) scan(value[i], path + "[" + i + "]", depth + 1);
        return;
      }
      Object.keys(value).forEach(function (key) {
        if (
          key === "return" ||
          key === "alternate" ||
          key === "stateNode" ||
          key === "_owner" ||
          key === "ref"
        ) {
          return;
        }
        scan(value[key], path ? path + "." + key : key, depth + 1);
      });
    }

    scan(start, "", 0);
    return matches;
  }

  function findSocket() {
    var fiber = reactRootFiber();
    if (!fiber) return null;
    var matches = scanObject(
      fiber,
      function (value) {
        return isSocket(value) || isSocket(value.socket) || isSocket(value.value && value.value.socket);
      },
      { maxDepth: 10 },
    );
    if (!matches.length) return null;
    var value = matches[0].value;
    if (isSocket(value)) return value;
    if (isSocket(value.socket)) return value.socket;
    if (isSocket(value.value && value.value.socket)) return value.value.socket;
    return null;
  }

  function playerName(player) {
    if (!player || typeof player !== "object") return "";
    return norm(
      player.wof_name ||
        player.fullName ||
        player.playerName ||
        player.displayName ||
        [player.surname, player.name].filter(Boolean).join(" ") ||
        [player.lastName, player.firstName].filter(Boolean).join(" ") ||
        [player.last_name, player.first_name].filter(Boolean).join(" ") ||
        player.name ||
        player.nick ||
        player.username ||
        "",
    );
  }

  function isPlayerLike(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    if (value.id === -1 || norm(value.name).toLowerCase() === "bye") return false;
    var name = playerName(value);
    if (!name) return false;
    var keyCount = [
      "wof_id",
      "wof_name",
      "id",
      "surname",
      "name",
      "nick",
      "username",
      "rating",
      "rank",
      "current_rank",
      "expected_rank",
      "performance",
      "country",
      "country_code",
      "team",
      "club",
      "category_name",
    ].filter(function (key) {
      return Object.prototype.hasOwnProperty.call(value, key);
    }).length;
    return keyCount >= 1;
  }

  function slimPlayer(player, source, index) {
    return {
      id: player.id == null ? "" : player.id,
      wofId: player.wof_id == null ? "" : player.wof_id,
      name: playerName(player),
      surname: norm(player.surname || player.lastName || player.last_name || ""),
      givenName: norm(player.name || player.firstName || player.first_name || ""),
      nick: norm(player.nick || ""),
      username: norm(player.username || ""),
      rating: player.rating == null ? "" : player.rating,
      rank: player.rank == null ? "" : player.rank,
      currentRank: player.current_rank == null ? "" : player.current_rank,
      expectedRank: player.expected_rank == null ? "" : player.expected_rank,
      performance: player.performance == null ? "" : player.performance,
      country: norm(player.country || player.country_code || player.nationality || ""),
      category: norm(player.category_name || player.category || ""),
      playerTableIndex: index + 1,
      source: source,
      raw: player,
    };
  }

  function addPlayersFromArray(array, source, output) {
    var before = output.length;
    if (!Array.isArray(array)) return 0;
    array.forEach(function (entry, index) {
      if (isPlayerLike(entry)) output.push(slimPlayer(entry, source, index));
    });
    return output.length - before;
  }

  function dedupePlayers(players) {
    var seen = new Set();
    var result = [];
    players.forEach(function (player) {
      var key =
        (norm(player.id) && "id:" + norm(player.id)) ||
        (norm(player.wofId) && "wof:" + norm(player.wofId)) ||
        (norm(player.username) && "user:" + norm(player.username).toLowerCase()) ||
        (norm(player.nick) && "nick:" + norm(player.nick).toLowerCase()) ||
        (norm(player.name) && "name:" + norm(player.name).toLowerCase());
      if (!key || seen.has(key)) return;
      seen.add(key);
      result.push(player);
    });
    return result;
  }

  function collectReactPlayerTable(output) {
    var fiber = reactRootFiber();
    if (!fiber) return 0;
    var before = output.length;
    scanObject(
      fiber,
      function (value, path) {
        if (!Array.isArray(value) || value.length < 2) return false;
        var key = String(path || "").split(".").pop() || "";
        if (!/^(players?|participants?|entrants?|registrations?)$/i.test(key)) return false;
        addPlayersFromArray(value, "react-player-table:" + path, output);
        return false;
      },
      { maxDepth: 12 },
    );
    return output.length - before;
  }

  function requestSocket(socket, attempt) {
    return new Promise(function (resolve) {
      var settled = false;
      var timeoutMs = attempt.timeoutMs || 4000;
      var eventName = attempt.event;
      function done(ok, payloadArgs, error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket.off(eventName, handler);
        } catch (_) {}
        resolve({
          ok: ok,
          payloadArgs: payloadArgs || [],
          payload: payloadArgs && payloadArgs.length ? payloadArgs[0] : null,
          error: error || "",
        });
      }
      function handler() {
        done(true, Array.prototype.slice.call(arguments), "");
      }
      var timer = setTimeout(function () {
        done(false, [], "timeout");
      }, timeoutMs);
      try {
        socket.on(eventName, handler);
        socket.emit.apply(socket, [attempt.emit].concat(attempt.args || []));
      } catch (error) {
        done(false, [], error && error.message ? String(error.message) : String(error || ""));
      }
    });
  }

  async function requestOtbPlayerTableViaSocket(target, output, attempts) {
    var socket = findSocket();
    if (!socket) {
      attempts.push({
        source: "socket:get-otb-reg",
        ok: false,
        addedPlayers: 0,
        error: "未找到 FTD socket",
      });
      return { socketFound: false, added: 0 };
    }

    var result = await requestSocket(socket, {
      emit: "get-otb-reg",
      event: "otb-players-list",
      args: [target.id],
    });
    var added = result.ok ? addPlayersFromArray(result.payload, "socket:get-otb-reg", output) : 0;
    attempts.push({
      source: "socket:get-otb-reg",
      emit: "get-otb-reg",
      event: "otb-players-list",
      ok: result.ok,
      addedPlayers: added,
      argCount: result.payloadArgs.length,
      error: result.error || "",
    });
    return { socketFound: true, added: added };
  }

  async function requestOtbPlayerTableViaApi(target, output, attempts) {
    var url = new URL("/api/otb/" + encodeURIComponent(target.id), window.location.origin);
    try {
      var response = await fetch(url.toString(), {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      var contentType = response.headers.get("content-type") || "";
      if (!response.ok) {
        attempts.push({
          source: "api:/api/otb/:id",
          ok: false,
          addedPlayers: 0,
          status: response.status,
          error: "HTTP " + response.status,
        });
        return 0;
      }
      if (contentType && contentType.indexOf("application/json") === -1) {
        attempts.push({
          source: "api:/api/otb/:id",
          ok: false,
          addedPlayers: 0,
          status: response.status,
          contentType: contentType,
          error: "返回内容不是 JSON",
        });
        return 0;
      }
      var payload = await response.json();
      var players = payload && Array.isArray(payload.players) ? payload.players : [];
      var added = addPlayersFromArray(players, "api:/api/otb/" + target.id + ":players", output);
      attempts.push({
        source: "api:/api/otb/:id",
        url: url.toString(),
        ok: true,
        addedPlayers: added,
        responsePlayerCount: players.length,
        responseKeys: payload && typeof payload === "object" ? Object.keys(payload) : [],
      });
      return added;
    } catch (error) {
      attempts.push({
        source: "api:/api/otb/:id",
        ok: false,
        addedPlayers: 0,
        error: error && error.message ? String(error.message) : String(error || ""),
      });
      return 0;
    }
  }

  var target = parseTarget();
  if (!target.id) throw new Error("没有找到 FTD 赛事 ID，请在本地输入 FTD 链接或直接在 FTD 页面执行");
  if (target.kind !== "otb") {
    throw new Error("当前严格名单导出只支持 FTD /live/:id。未验证 /tournaments/:id 的 player 表接口，已拒绝猜测。");
  }

  var players = [];
  var attempts = [];
  var reactAdded = collectReactPlayerTable(players);
  if (reactAdded) {
    attempts.push({
      source: "react-player-table",
      ok: true,
      addedPlayers: reactAdded,
    });
  }

  var socketResult = await requestOtbPlayerTableViaSocket(target, players, attempts);
  if (!players.length) {
    await requestOtbPlayerTableViaApi(target, players, attempts);
  }

  var payload = {
    type: "ftd-player-table",
    source: "ftd-player-console",
    exportedAt: new Date().toISOString(),
    pageUrl: window.location.href,
    target: target,
    socketFound: socketResult.socketFound,
    attempts: attempts,
    reactStateAddedPlayers: reactAdded,
    players: dedupePlayers(players),
  };
  if (!payload.players.length) {
    console.warn("FTD player 表导出失败。诊断信息：", payload);
    throw new Error("没有导出到 FTD player 表。请打开 FTD 的 Players 页面后重试；本脚本不会用 Round 1 配对兜底。");
  }

  downloadJson(
    payload,
    "ftd-players-" + safeFilePart(target.id || "event") + "-" + safeFilePart(new Date().toISOString().slice(0, 19)) + ".json",
  );
  setTimeout(function () {
    try {
      console.clear();
    } catch (_) {}
  }, 80);
})();
