(function () {
  "use strict";

  const PROTOCOL = "ftd-local-autopilot-v1";
  const FINISHED_ROUND_TEST_TOURNAMENT_ID = "593";
  const FINISHED_ROUND_TEST_STARTS_AT = Date.parse("2026-07-27T23:40:00+08:00");
  const FINISHED_ROUND_TEST_EXPIRES_AT = Date.parse("2026-07-28T23:59:59+08:00");
  const REQUEST_TYPE = "FTD_AUTOPILOT_REQUEST";
  const RESPONSE_TYPE = "FTD_AUTOPILOT_RESPONSE";
  const HELLO_TYPE = "FTD_AUTOPILOT_HELLO";
  const HELLO_ACK_TYPE = "FTD_AUTOPILOT_HELLO_ACK";
  const ACTIONS = new Set([
    "probe",
    "readRound",
    "writeScore",
    "writeTranscript",
    "readbackRound",
    "renderVerifiedRoundImage",
  ]);
  const COMMON_KEYS = [
    "action", "sessionId", "commandId", "tournamentId", "localRound",
    "localStage", "actualFtdRound", "targetTable", "gameId",
    "pairingFingerprint", "player0Id", "player1Id",
  ];
  const ACTION_KEYS = {
    probe: COMMON_KEYS,
    readRound: COMMON_KEYS,
    readbackRound: COMMON_KEYS,
    writeScore: COMMON_KEYS.concat([
      "blackScore", "whiteScore", "localStatus", "localDirty",
      "localPending", "localManualLocked", "localRevision", "allowFinishedRoundWrite",
    ]),
    writeTranscript: COMMON_KEYS.concat([
      "transcript", "oqGameId", "localStatus", "localDirty",
      "localPending", "localManualLocked", "localRevision", "allowFinishedRoundWrite",
    ]),
    renderVerifiedRoundImage: COMMON_KEYS.concat(["snapshot", "filename"]),
  };
  let relayNonce = "";
  let dedicatedSocket = null;
  let connectPromise = null;
  let writeTransportProof = null;

  function text(value, max = 500) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
  }

  function exactKeys(object, allowed) {
    if (!object || typeof object !== "object" || Array.isArray(object)) return false;
    const allowedSet = new Set(allowed);
    return Object.keys(object).every((key) => allowedSet.has(key)) &&
      allowed.every((key) => Object.prototype.hasOwnProperty.call(object, key));
  }

  function validId(value, max = 160) {
    const valueText = text(value, max + 1);
    return Boolean(valueText && valueText.length <= max && !/[\r\n\u0000-\u001f]/.test(valueText));
  }

  function integer(value, min, max) {
    const number = Number(value);
    return Number.isInteger(number) && number >= min && number <= max;
  }

  function validateCommand(command) {
    if (!command || !ACTIONS.has(command.action)) throw bridgeError("unknown-action", "未知 bridge 动作");
    if (!exactKeys(command, ACTION_KEYS[command.action])) throw bridgeError("schema-fields", "bridge 请求字段不完整或包含未知字段");
    if (!validId(command.sessionId) || !validId(command.commandId)) throw bridgeError("schema-id", "sessionId/commandId 无效");
    if (!/^\d{1,12}$/.test(String(command.tournamentId))) throw bridgeError("schema-tournament", "tournamentId 无效");
    if (!integer(command.localRound, 1, 20)) throw bridgeError("schema-local-round", "本地轮次无效");
    if (!["preliminary", "semifinal", "finals"].includes(command.localStage)) throw bridgeError("schema-local-stage", "本地阶段无效");
    if (!(command.actualFtdRound === "discover" || integer(command.actualFtdRound, 1, 999))) throw bridgeError("schema-ftd-round", "FTD 轮次无效");
    if (!integer(command.targetTable, 0, 999)) throw bridgeError("schema-table", "FTD 台号无效");
    for (const key of ["gameId", "pairingFingerprint", "player0Id", "player1Id"]) {
      if (typeof command[key] !== "string" || command[key].length > 300) throw bridgeError("schema-target", `${key} 无效`);
    }
    if (command.action === "writeScore") {
      if (typeof command.allowFinishedRoundWrite !== "boolean") throw bridgeError("finished-round-authorization-schema", "已结束轮测试授权字段无效");
      if (!integer(command.blackScore, 0, 64) || !integer(command.whiteScore, 0, 64) || command.blackScore + command.whiteScore !== 64) {
        throw bridgeError("invalid-score", "比分必须是 0-64 的整数且总和为 64");
      }
      validateLocalWriteGuard(command);
    }
    if (command.action === "writeTranscript") {
      if (typeof command.allowFinishedRoundWrite !== "boolean") throw bridgeError("finished-round-authorization-schema", "已结束轮测试授权字段无效");
      if (!validTranscript(command.transcript) || !validId(command.oqGameId, 300)) throw bridgeError("invalid-transcript", "棋谱或 OQ game ID 无效");
      validateLocalWriteGuard(command);
    }
    if (command.action === "renderVerifiedRoundImage") {
      if (!Array.isArray(command.snapshot) || !command.snapshot.length || command.snapshot.length > 256) throw bridgeError("invalid-snapshot", "最终回读快照无效");
      if (!/^ftd-[A-Za-z0-9_.-]+-scores-verified\.png$/.test(command.filename)) throw bridgeError("invalid-filename", "PNG 文件名无效");
    }
    return command;
  }

  function validateLocalWriteGuard(command) {
    if (!["ready", "completed"].includes(command.localStatus)) throw bridgeError("local-status-blocked", "本地行状态不允许自动写入");
    if (command.localDirty !== false || command.localPending !== false || command.localManualLocked !== false) {
      throw bridgeError("local-write-locked", "本地行存在 dirty/pending/人工锁");
    }
    if (!integer(command.localRevision, 0, Number.MAX_SAFE_INTEGER)) throw bridgeError("local-revision", "本地 revision 无效");
  }

  function validTranscript(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 120 && value.length % 2 === 0 && /^[a-h1-8]+$/.test(value) && !value.includes("-");
  }

  function bridgeError(code, message, extra) {
    const error = new Error(message);
    error.code = code;
    if (extra) error.extra = extra;
    return error;
  }

  function parsePageTournamentId() {
    const match = location.pathname.match(/^\/live\/(\d+)/);
    return match ? match[1] : "";
  }

  function readAuthPresence() {
    try {
      const data = JSON.parse(localStorage.getItem("userData") || "null");
      return Boolean(data && data.token && data.sid);
    } catch (_) {
      return false;
    }
  }

  function findExistingPageSocket() {
    function isSocket(value) {
      return value && typeof value === "object" && typeof value.emit === "function" && typeof value.on === "function" && typeof value.off === "function";
    }
    const root = document.getElementById("root");
    const key = root && Object.keys(root).find((name) => name.startsWith("__reactContainer$"));
    const start = key ? root[key] : null;
    const seen = new WeakSet();
    function scan(value, depth) {
      if (!value || typeof value !== "object" || seen.has(value) || depth > 6) return null;
      seen.add(value);
      if (isSocket(value)) return value;
      if (isSocket(value.socket)) return value.socket;
      if (isSocket(value.value && value.value.socket)) return value.value.socket;
      for (const name of Object.keys(value)) {
        if (name === "return" || name === "alternate" || name === "stateNode") continue;
        const found = scan(value[name], depth + 1);
        if (found) return found;
      }
      return null;
    }
    function walk(fiber) {
      let current = fiber;
      while (current) {
        const found = scan(current.memoizedProps, 0) || scan(current.pendingProps, 0) || scan(current.memoizedState, 0);
        if (found) return found;
        if (current.child) {
          const child = walk(current.child);
          if (child) return child;
        }
        current = current.sibling;
      }
      return null;
    }
    return walk(start);
  }

  function ensureDedicatedSocket() {
    if (dedicatedSocket && dedicatedSocket.connected) return Promise.resolve(dedicatedSocket);
    if (connectPromise) return connectPromise;
    if (typeof window.io !== "function") return Promise.reject(bridgeError("socket-client-missing", "本地 Socket.IO client 未加载"));
    if (!readAuthPresence()) return Promise.reject(bridgeError("not-logged-in", "FTD 页面未登录"));
    connectPromise = new Promise((resolve, reject) => {
      let settled = false;
      const socket = window.io(location.origin, {
        auth: async (callback) => {
          try {
            const data = JSON.parse(localStorage.getItem("userData") || "null");
            callback({ token: data && data.token, sid: data && data.sid });
          } catch (_) {
            callback({ token: undefined, sid: undefined });
          }
        },
        forceNew: true,
        withCredentials: true,
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
      });
      dedicatedSocket = socket;
      const timer = setTimeout(() => finish(bridgeError("socket-connect-timeout", "第二条 FTD socket 连接超时")), 10000);
      function finish(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off("connect", onConnect);
        socket.off("connect_error", onError);
        connectPromise = null;
        if (error) reject(error);
        else resolve(socket);
      }
      function onConnect() { finish(null); }
      function onError() { finish(bridgeError("socket-connect-error", "第二条 FTD socket 连接失败")); }
      socket.on("connect", onConnect);
      socket.on("connect_error", onError);
      if (socket.connected) finish(null);
    });
    return connectPromise;
  }

  function requestRound(socket, tournamentId, round) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(bridgeError("read-round-timeout", `读取 FTD 第 ${round} 轮超时`)), 9000);
      function handler(payload) { finish(null, payload || {}); }
      function finish(error, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off("otb-get-round", handler);
        if (error) reject(error); else resolve(value);
      }
      socket.on("otb-get-round", handler);
      socket.emit("get-otb-rounds", tournamentId, round);
    });
  }

  function requestTdAccess(socket, tournamentId) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(bridgeError("td-probe-timeout", "FTD TD 权限探测超时")), 9000);
      function handler(isTD, isAssistant, name, currentRound, roundFinished, system, isPlayer, categories, test, tournamentFinished) {
        finish(null, {
          isTD: isTD === true,
          isAssistant: isAssistant === true,
          tournamentName: text(name, 240),
          currentRound: Number.isFinite(Number(currentRound)) ? Math.trunc(Number(currentRound)) : null,
          roundFinished: roundFinished === true,
          tournamentFinished: tournamentFinished === true,
          isPlayer: Boolean(isPlayer),
        });
      }
      function finish(error, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off("td", handler);
        if (error) reject(error); else resolve(value);
      }
      socket.on("td", handler);
      socket.emit("is-td", tournamentId);
    });
  }

  function playerName(player) {
    if (!player || player.id === -1) return "BYE";
    return text(player.wof_name || [player.surname, player.name].filter(Boolean).join(" ") || player.nick || player.username || player.id, 240);
  }

  function stablePlayerId(player) {
    if (!player || player.id == null) return "";
    return String(player.id).slice(0, 200);
  }

  async function sha256Hex(value) {
    const bytes = new TextEncoder().encode(String(value));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function sanitizeRoundPayload(tournamentId, requestedRound, data) {
    const pairings = [];
    const rows = Array.isArray(data && data.pairing) ? data.pairing : [];
    for (let index = 0; index < rows.length; index += 1) {
      const pair = rows[index];
      if (!Array.isArray(pair) || !pair[0] || !pair[1]) continue;
      const table = Number.isFinite(Number(pair[0].gameNumber)) ? Math.trunc(Number(pair[0].gameNumber)) + 1 : index + 1;
      const gameId = pair[0].gameId == null ? "" : String(pair[0].gameId);
      const player0Id = stablePlayerId(pair[0]);
      const player1Id = stablePlayerId(pair[1]);
      const fingerprint = await sha256Hex([tournamentId, requestedRound, table, gameId, player0Id, player1Id].join("\n"));
      const score = pair[0].score === null || pair[0].score === undefined ? null : Number(pair[0].score);
      pairings.push({
        table,
        gameId,
        player0Id,
        player1Id,
        player0Name: playerName(pair[0]),
        player1Name: playerName(pair[1]),
        blackScore: Number.isInteger(score) ? score : null,
        whiteScore: Number.isInteger(score) ? 64 - score : null,
        transcript: typeof pair[0].transcript === "string" ? pair[0].transcript : "",
        comment: text(pair[0].comment, 300),
        pairingFingerprint: fingerprint,
      });
    }
    const roundNames = Array.isArray(data && data.roundNames)
      ? data.roundNames.map((item) => ({
          round: Number.isFinite(Number(item && item.round)) ? Math.trunc(Number(item.round)) : null,
          roundName: text(item && item.round_name, 80),
        })).filter((item) => item.round != null)
      : [];
    const roundName = (roundNames.find((item) => item.round === requestedRound) || {}).roundName || "";
    return {
      tournamentId: String(tournamentId),
      actualFtdRound: requestedRound,
      roundName,
      currentRound: Number.isFinite(Number(data && data.currentRound)) ? Math.trunc(Number(data.currentRound)) : null,
      returnedRound: Number.isFinite(Number(data && data.round)) ? Math.trunc(Number(data.round)) : requestedRound,
      started: data && data.started === true,
      finished: data && data.finished === true,
      roundNames,
      pairings,
    };
  }

  function assertPageScope(command) {
    const pageTournamentId = parsePageTournamentId();
    if (!pageTournamentId || pageTournamentId !== String(command.tournamentId)) {
      throw bridgeError("wrong-ftd-tab", "当前 FTD 标签页与锁定赛事不一致", { pageTournamentId });
    }
  }

  async function readSanitizedRound(command) {
    assertPageScope(command);
    if (!integer(command.actualFtdRound, 1, 999)) throw bridgeError("round-not-resolved", "必须先解析实际 FTD 轮次");
    const socket = await ensureDedicatedSocket();
    return sanitizeRoundPayload(command.tournamentId, command.actualFtdRound, await requestRound(socket, command.tournamentId, command.actualFtdRound));
  }

  function findTarget(round, command) {
    const target = round.pairings.find((item) => item.table === command.targetTable);
    if (!target) throw bridgeError("table-missing", "FTD 回读中找不到目标台");
    if (target.gameId !== command.gameId || target.player0Id !== command.player0Id || target.player1Id !== command.player1Id || target.pairingFingerprint !== command.pairingFingerprint) {
      throw bridgeError("pairing-changed", "FTD 配对指纹、gameId 或稳定选手 ID 已变化", { live: target });
    }
    return target;
  }

  async function readbackWithRetries(command, predicate) {
    let lastRound = null;
    const delays = [250, 500, 1000, 1600];
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      lastRound = await readSanitizedRound(command);
      const target = findTarget(lastRound, command);
      if (predicate(target)) return { round: lastRound, target, attempts: attempt + 1 };
    }
    throw bridgeError("readback-timeout", "FTD 写入后精确回读超时", { lastRound });
  }

  async function handleProbe(command) {
    assertPageScope(command);
    const socket = await ensureDedicatedSocket();
    const td = await requestTdAccess(socket, command.tournamentId);
    const existing = findExistingPageSocket();
    const discoveryRound = td.currentRound && td.currentRound > 0 ? td.currentRound : 1;
    const round = await sanitizeRoundPayload(command.tournamentId, discoveryRound, await requestRound(socket, command.tournamentId, discoveryRound));
    const result = {
      loggedIn: readAuthPresence(),
      tdAccess: td.isTD,
      td,
      transport: "dedicated-second-socket",
      dedicatedSocketConnected: socket.connected === true,
      existingPageSocketConnected: Boolean(existing && existing.connected),
      coexistenceObserved: Boolean(socket.connected && existing && existing.connected && existing !== socket),
      pageTournamentId: parsePageTournamentId(),
      discovery: round,
    };
    if (result.loggedIn && result.tdAccess && result.dedicatedSocketConnected && result.existingPageSocketConnected && result.coexistenceObserved) {
      writeTransportProof = { tournamentId: String(command.tournamentId), verifiedAt: Date.now() };
    } else {
      writeTransportProof = null;
    }
    return result;
  }

  function assertWriteTransportProof(command) {
    if (!writeTransportProof || writeTransportProof.tournamentId !== String(command.tournamentId) || Date.now() - writeTransportProof.verifiedAt > 30 * 60 * 1000) {
      throw bridgeError("readonly-proof-required", "FTD 写入保持禁用：请先完成当前赛事的只读双 Socket 共存探测");
    }
  }

  function finishedRoundWriteTestAuthorized(command) {
    const now = Date.now();
    return command.allowFinishedRoundWrite === true && String(command.tournamentId) === FINISHED_ROUND_TEST_TOURNAMENT_ID &&
      now >= FINISHED_ROUND_TEST_STARTS_AT && now <= FINISHED_ROUND_TEST_EXPIRES_AT;
  }

  async function handleWriteScore(command) {
    assertWriteTransportProof(command);
    const beforeRound = await readSanitizedRound(command);
    const before = findTarget(beforeRound, command);
    if (before.blackScore !== null) {
      if (before.blackScore === command.blackScore && before.whiteScore === command.whiteScore) {
        return makeScoreReceipt(command, before, before, true, 1);
      }
      throw bridgeError("ftd-score-conflict", "FTD 已存在不同非空比分，自动化不会覆盖", { before });
    }
    if (beforeRound.finished && !finishedRoundWriteTestAuthorized(command)) throw bridgeError("ftd-round-finished", "FTD 轮次已结束，禁止自动写分");
    const socket = await ensureDedicatedSocket();
    socket.emit("score-otb", command.tournamentId, command.gameId, command.blackScore);
    const readback = await readbackWithRetries(command, (target) => target.blackScore === command.blackScore && target.whiteScore === command.whiteScore);
    return makeScoreReceipt(command, before, readback.target, false, readback.attempts);
  }

  function makeScoreReceipt(command, before, readback, alreadyCorrect, attempts) {
    return {
      kind: "ftd-score-receipt-v1",
      sessionId: command.sessionId,
      commandId: command.commandId,
      tournamentId: command.tournamentId,
      actualFtdRound: command.actualFtdRound,
      ftdTable: command.targetTable,
      gameId: command.gameId,
      pairingFingerprint: command.pairingFingerprint,
      expectedScore: { blackScore: command.blackScore, whiteScore: command.whiteScore },
      beforeScore: { blackScore: before.blackScore, whiteScore: before.whiteScore },
      readbackScore: { blackScore: readback.blackScore, whiteScore: readback.whiteScore },
      alreadyCorrect,
      readbackAttempts: attempts,
      verifiedAt: new Date().toISOString(),
    };
  }

  async function handleWriteTranscript(command) {
    assertWriteTransportProof(command);
    const beforeRound = await readSanitizedRound(command);
    const before = findTarget(beforeRound, command);
    if (before.transcript) {
      if (before.transcript === command.transcript) return makeTranscriptReceipt(command, before.transcript, before.transcript, true, 1);
      throw bridgeError("ftd-transcript-conflict", "FTD 已存在不同棋谱，自动化不会覆盖", { existingTranscriptHash: await sha256Hex(before.transcript) });
    }
    if (beforeRound.finished && !finishedRoundWriteTestAuthorized(command)) throw bridgeError("ftd-round-finished", "FTD 轮次已结束，禁止自动写棋谱");
    const socket = await ensureDedicatedSocket();
    socket.emit("otb-paste-transcript", command.tournamentId, command.gameId, command.transcript);
    const readback = await readbackWithRetries(command, (target) => target.transcript === command.transcript);
    return makeTranscriptReceipt(command, before.transcript, readback.target.transcript, false, readback.attempts);
  }

  async function makeTranscriptReceipt(command, before, readback, alreadyCorrect, attempts) {
    return {
      kind: "ftd-transcript-receipt-v1",
      sessionId: command.sessionId,
      commandId: command.commandId,
      tournamentId: command.tournamentId,
      actualFtdRound: command.actualFtdRound,
      ftdTable: command.targetTable,
      gameId: command.gameId,
      oqGameId: command.oqGameId,
      pairingFingerprint: command.pairingFingerprint,
      transcriptHash: await sha256Hex(command.transcript),
      beforeTranscriptHash: before ? await sha256Hex(before) : "",
      readbackTranscriptHash: await sha256Hex(readback),
      alreadyCorrect,
      readbackAttempts: attempts,
      verifiedAt: new Date().toISOString(),
    };
  }

  function fitText(context, value, width) {
    const raw = text(value, 240);
    if (context.measureText(raw).width <= width) return raw;
    let out = raw;
    while (out.length > 1 && context.measureText(`${out}…`).width > width) out = out.slice(0, -1);
    return `${out}…`;
  }

  async function handleRenderImage(command) {
    assertWriteTransportProof(command);
    const rows = command.snapshot.map((item) => {
      if (!item || typeof item !== "object") throw bridgeError("invalid-snapshot-row", "最终快照行无效");
      const blackScore = Number(item.blackScore);
      const whiteScore = Number(item.whiteScore);
      if (!Number.isInteger(blackScore) || !Number.isInteger(whiteScore) || blackScore + whiteScore !== 64 || item.verified !== true) {
        throw bridgeError("unverified-image-row", "PNG 只能使用最终 FTD 已验证比分");
      }
      return {
        label: text(item.label, 80),
        black: text(item.black, 240),
        white: text(item.white, 240),
        blackScore,
        whiteScore,
      };
    });
    const width = 1040;
    const headerHeight = 122;
    const rowHeight = 92;
    const height = headerHeight + rows.length * rowHeight + 24;
    const scale = Math.max(1, Math.min(3, window.devicePixelRatio || 2));
    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    const context = canvas.getContext("2d");
    context.scale(scale, scale);
    context.fillStyle = "#211f1d";
    context.fillRect(0, 0, width, height);
    context.fillStyle = "#2b2927";
    context.fillRect(0, 0, width, headerHeight);
    context.fillStyle = "#fff";
    context.textAlign = "center";
    context.font = "700 34px Arial, sans-serif";
    const title = command.localStage === "semifinal" ? "Semi-Finals" : command.localStage === "finals" ? "Finals & 3rd Place" : `Round ${command.localRound}`;
    context.fillText(title, width / 2, 74);
    context.strokeStyle = "#6d6a66";
    context.beginPath(); context.moveTo(0, headerHeight - 1); context.lineTo(width, headerHeight - 1); context.stroke();
    rows.forEach((row, index) => {
      const top = headerHeight + index * rowHeight;
      context.fillStyle = index % 2 ? "#211f1d" : "#242321";
      context.fillRect(10, top, width - 20, rowHeight);
      context.fillStyle = "#e8e8e8";
      context.textAlign = "center";
      context.font = "700 20px Arial, sans-serif";
      context.fillText(row.label || String(index + 1), 65, top + 55);
      context.textAlign = "left";
      context.fillStyle = "#b7b7b7";
      context.font = "700 22px Arial, sans-serif";
      context.fillText(fitText(context, row.black, 260), 130, top + 55);
      context.textAlign = "center";
      context.fillStyle = "#fff";
      context.font = "900 28px Arial, sans-serif";
      context.fillText(`${row.blackScore}  -  ${row.whiteScore}`, 520, top + 57);
      context.textAlign = "left";
      context.fillStyle = "#b7b7b7";
      context.font = "700 22px Arial, sans-serif";
      context.fillText(fitText(context, row.white, 260), 690, top + 55);
    });
    const dataUrl = canvas.toDataURL("image/png");
    return { filename: command.filename, dataUrl, pngSha256: await sha256Hex(dataUrl), rowCount: rows.length, renderedAt: new Date().toISOString() };
  }

  async function dispatch(command) {
    validateCommand(command);
    if (command.action === "probe") return handleProbe(command);
    if (command.action === "readRound" || command.action === "readbackRound") return readSanitizedRound(command);
    if (command.action === "writeScore") return handleWriteScore(command);
    if (command.action === "writeTranscript") return handleWriteTranscript(command);
    if (command.action === "renderVerifiedRoundImage") return handleRenderImage(command);
    throw bridgeError("unknown-action", "未知 bridge 动作");
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window || !event.data || event.data.protocol !== PROTOCOL) return;
    if (event.data.type === HELLO_TYPE) {
      const nonce = typeof event.data.nonce === "string" ? event.data.nonce : "";
      if (!validId(nonce) || (relayNonce && relayNonce !== nonce)) return;
      relayNonce = nonce;
      window.postMessage({ protocol: PROTOCOL, type: HELLO_ACK_TYPE, nonce }, location.origin);
      return;
    }
    if (event.data.type !== REQUEST_TYPE || !relayNonce || event.data.nonce !== relayNonce) return;
    const requestId = text(event.data.requestId, 180);
    if (!requestId) return;
    window.postMessage({ protocol: PROTOCOL, type: "FTD_AUTOPILOT_PROGRESS", nonce: relayNonce, requestId }, location.origin);
    try {
      const result = await dispatch(event.data.command);
      window.postMessage({ protocol: PROTOCOL, type: RESPONSE_TYPE, nonce: relayNonce, requestId, ok: true, result }, location.origin);
    } catch (error) {
      window.postMessage({
        protocol: PROTOCOL,
        type: RESPONSE_TYPE,
        nonce: relayNonce,
        requestId,
        ok: false,
        error: { code: text(error && error.code || "bridge-error", 100), message: text(error && error.message || "bridge error", 500), extra: error && error.extra ? error.extra : undefined },
      }, location.origin);
    }
  });
})();
