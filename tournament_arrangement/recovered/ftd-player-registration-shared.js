(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.FtdPlayerRegistrationShared = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const REGISTRATION_SCHEMA_VERSION = 1;
  const RESULT_TYPE = "ftd-player-import-result";
  const RESULT_SCHEMA_VERSION = 1;
  const BATCH_TYPE = "ftd-player-import-batch";

  const STATUS_LABELS = Object.freeze({
    pending: "待核对",
    "matched-single": "唯一匹配",
    "matched-highest-rating": "最高分匹配",
    "matched-random-tie": "并列随机匹配",
    unmatched: "无法匹配",
    "name-parse-unresolved": "姓名无法解析",
    "referee-manual": "裁判手动指定",
    "referee-new": "新人（裁判确认）",
    excluded: "已排除",
    "console-batch-pending": "待写入 FTD",
    "ftd-written": "已写入 FTD",
    "ftd-write-failed": "写入失败",
  });

  const RESOLVED_STATUSES = new Set([
    "matched-single",
    "matched-highest-rating",
    "matched-random-tie",
    "referee-manual",
    "referee-new",
  ]);

  function text(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function numberOrNull(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function rowIdForPlayer(player) {
    const id = Number(player && player.id);
    if (!Number.isFinite(id) || id <= 0) return "";
    return `roster:${Math.trunc(id)}`;
  }

  function rosterSignature(player) {
    return [
      text(player && (player.displayName || player.name)).toLowerCase(),
      text(player && player.account).toLowerCase(),
      text(player && player.group).toLowerCase(),
    ].join("|");
  }

  function sanitizeSelectedPlayer(raw) {
    if (!raw || typeof raw !== "object") return null;
    const id = numberOrNull(raw.id);
    if (id === null) return null;
    return {
      id,
      wof_id: numberOrNull(raw.wof_id != null ? raw.wof_id : raw.wofId),
      surname: text(raw.surname),
      name: text(raw.name),
      rating: numberOrNull(raw.rating),
      country_code: text(raw.country_code || raw.countryCode).toUpperCase(),
    };
  }

  function sanitizeNewPlayer(raw) {
    if (!raw || typeof raw !== "object") return null;
    return {
      surname: text(raw.surname),
      name: text(raw.name),
      country: text(raw.country || raw.country_code || raw.countryCode).toUpperCase(),
      family: text(raw.family),
      categories: Array.isArray(raw.categories)
        ? raw.categories.map(text).filter(Boolean)
        : [],
    };
  }

  function sanitizeRow(raw) {
    if (!raw || typeof raw !== "object") return null;
    const rowId = text(raw.rowId);
    const playerId = Number(raw.playerId);
    if (!rowId || !Number.isFinite(playerId) || playerId <= 0) return null;
    const rawStatus = text(raw.status);
    const status = Object.prototype.hasOwnProperty.call(STATUS_LABELS, rawStatus)
      ? rawStatus
      : "pending";
    const resolutionStatus = RESOLVED_STATUSES.has(text(raw.resolutionStatus))
      ? text(raw.resolutionStatus)
      : RESOLVED_STATUSES.has(status)
        ? status
        : "";
    const consoleState = raw.console && typeof raw.console === "object" ? raw.console : {};
    return {
      rowId,
      playerId: Math.trunc(playerId),
      rosterName: text(raw.rosterName),
      rosterAccount: text(raw.rosterAccount),
      rosterGroup: text(raw.rosterGroup),
      rosterSignature: text(raw.rosterSignature),
      normalizedName: text(raw.normalizedName),
      nameSource: text(raw.nameSource),
      status,
      resolutionStatus,
      selectionRule: text(raw.selectionRule),
      selectedPlayer: sanitizeSelectedPlayer(raw.selectedPlayer),
      tiedPlayerIds: Array.isArray(raw.tiedPlayerIds)
        ? Array.from(new Set(raw.tiedPlayerIds.map(numberOrNull).filter((item) => item !== null)))
        : [],
      candidateCount: Math.max(0, Math.trunc(Number(raw.candidateCount) || 0)),
      resolverBatchId: text(raw.resolverBatchId),
      resolvedAt: text(raw.resolvedAt),
      newPlayer: sanitizeNewPlayer(raw.newPlayer),
      categories: Array.isArray(raw.categories) ? raw.categories.map(text).filter(Boolean) : [],
      family: text(raw.family),
      errorCode: text(raw.errorCode),
      errorMessage: text(raw.errorMessage),
      console: {
        batchId: text(consoleState.batchId),
        preparedAt: text(consoleState.preparedAt),
        lastOutcome: text(consoleState.lastOutcome),
        lastResultAt: text(consoleState.lastResultAt),
        tournamentId: text(consoleState.tournamentId),
      },
    };
  }

  function sanitizeBatchRow(raw) {
    if (!raw || typeof raw !== "object") return null;
    const rowId = text(raw.rowId);
    if (!rowId) return null;
    const kind = raw.kind === "new" ? "new" : "existing";
    const selectedPlayer = sanitizeSelectedPlayer(raw.selectedPlayer);
    const form = sanitizeNewPlayer(raw.form);
    if (kind === "existing" && !selectedPlayer) return null;
    if (kind === "new" && (!form || !form.surname || !form.name || !form.country || !form.family)) {
      return null;
    }
    return {
      rowId,
      playerId: Math.trunc(Number(raw.playerId) || 0),
      rosterName: text(raw.rosterName),
      rosterAccount: text(raw.rosterAccount),
      resolutionStatus: text(raw.resolutionStatus),
      kind,
      selectedPlayer,
      form,
      categories: Array.isArray(raw.categories) ? raw.categories.map(text).filter(Boolean) : [],
      countryCode: text(raw.countryCode).toUpperCase(),
      family: text(raw.family),
    };
  }

  function sanitizeBatch(raw) {
    if (!raw || typeof raw !== "object") return null;
    const batchId = text(raw.batchId);
    if (!batchId || raw.type !== BATCH_TYPE || Number(raw.schemaVersion) !== RESULT_SCHEMA_VERSION) {
      return null;
    }
    const rows = Array.isArray(raw.rows) ? raw.rows.map(sanitizeBatchRow).filter(Boolean) : [];
    return {
      type: BATCH_TYPE,
      schemaVersion: RESULT_SCHEMA_VERSION,
      batchId,
      createdAt: text(raw.createdAt),
      sourceRevision: numberOrNull(raw.sourceRevision),
      status: raw.status === "consumed" ? "consumed" : "pending",
      consumedAt: text(raw.consumedAt),
      rows,
      resultSummary: raw.resultSummary && typeof raw.resultSummary === "object"
        ? clone(raw.resultSummary)
        : null,
    };
  }

  function emptyRegistration() {
    return {
      type: "ftd-player-registration",
      schemaVersion: REGISTRATION_SCHEMA_VERSION,
      updatedAt: "",
      resolverBatchId: "",
      resolvedAt: "",
      sourceRevision: null,
      rows: [],
      pendingBatch: null,
      consumedBatchIds: [],
    };
  }

  function sanitizeRegistration(raw) {
    const safe = emptyRegistration();
    if (!raw || typeof raw !== "object") return safe;
    safe.updatedAt = text(raw.updatedAt);
    safe.resolverBatchId = text(raw.resolverBatchId);
    safe.resolvedAt = text(raw.resolvedAt);
    safe.sourceRevision = numberOrNull(raw.sourceRevision);
    safe.rows = Array.isArray(raw.rows) ? raw.rows.map(sanitizeRow).filter(Boolean) : [];
    safe.pendingBatch = sanitizeBatch(raw.pendingBatch);
    if (safe.pendingBatch && safe.pendingBatch.status !== "pending") safe.pendingBatch = null;
    safe.consumedBatchIds = Array.isArray(raw.consumedBatchIds)
      ? Array.from(new Set(raw.consumedBatchIds.map(text).filter(Boolean))).slice(-50)
      : [];
    return safe;
  }

  function makePendingRow(player) {
    return sanitizeRow({
      rowId: rowIdForPlayer(player),
      playerId: player.id,
      rosterName: text(player.displayName || player.name),
      rosterAccount: text(player.account),
      rosterGroup: text(player.group),
      rosterSignature: rosterSignature(player),
      status: "pending",
    });
  }

  function syncRowsWithPlayers(registration, players) {
    const safe = sanitizeRegistration(registration);
    const byId = new Map(safe.rows.map((row) => [row.rowId, row]));
    safe.rows = (Array.isArray(players) ? players : []).map((player) => {
      const rowId = rowIdForPlayer(player);
      const current = byId.get(rowId);
      if (!current) return makePendingRow(player);
      const signature = rosterSignature(player);
      const changed = Boolean(current.rosterSignature && current.rosterSignature !== signature);
      const locked = current.status === "ftd-written" || current.status === "console-batch-pending";
      const next = clone(current);
      next.rosterName = text(player.displayName || player.name);
      next.rosterAccount = text(player.account);
      next.rosterGroup = text(player.group);
      next.rosterSignature = signature;
      if (changed && !locked) {
        return makePendingRow(player);
      }
      return sanitizeRow(next);
    });
    return safe;
  }

  function statusLabel(status) {
    return STATUS_LABELS[text(status)] || STATUS_LABELS.pending;
  }

  function uniqueBatchId(nowValue, randomValue) {
    const stamp = Number.isFinite(Number(nowValue)) ? Number(nowValue) : Date.now();
    const random = text(randomValue) || Math.random().toString(36).slice(2, 10);
    return `ftd-player-${stamp}-${random.replace(/[^a-z0-9-]/gi, "").slice(0, 20)}`;
  }

  function resolutionKind(row) {
    const status = text(row && row.resolutionStatus);
    if (status === "referee-new") return "new";
    if (RESOLVED_STATUSES.has(status)) return "existing";
    return "";
  }

  function createConsoleBatch(registration, players, options) {
    const opts = options || {};
    const safe = syncRowsWithPlayers(registration, players);
    if (safe.pendingBatch && safe.pendingBatch.status === "pending") {
      throw new Error("已有待确认的 Console 批次，请先按 Shift+Enter 读取结果");
    }
    const createdAt = text(opts.createdAt) || new Date().toISOString();
    const batchId = text(opts.batchId) || uniqueBatchId(Date.parse(createdAt));
    const rows = [];
    for (const row of safe.rows) {
      if (row.status === "ftd-written" || row.status === "excluded") continue;
      const kind = resolutionKind(row);
      if (!kind) continue;
      if (kind === "existing") {
        if (!row.selectedPlayer) continue;
        rows.push({
          rowId: row.rowId,
          playerId: row.playerId,
          rosterName: row.rosterName,
          rosterAccount: row.rosterAccount,
          resolutionStatus: row.resolutionStatus,
          kind,
          selectedPlayer: clone(row.selectedPlayer),
          form: null,
          categories: clone(row.categories || []),
          countryCode: text(row.selectedPlayer.country_code || "CN").toUpperCase(),
          family: text(row.family || row.selectedPlayer.surname),
        });
      } else {
        const form = sanitizeNewPlayer(row.newPlayer);
        if (!form || !form.surname || !form.name || !form.country || !form.family) continue;
        rows.push({
          rowId: row.rowId,
          playerId: row.playerId,
          rosterName: row.rosterName,
          rosterAccount: row.rosterAccount,
          resolutionStatus: row.resolutionStatus,
          kind,
          selectedPlayer: null,
          form,
          categories: clone(form.categories || []),
          countryCode: form.country,
          family: form.family,
        });
      }
    }
    if (!rows.length) throw new Error("当前没有可登记的 FTD Player 项目");
    const batch = sanitizeBatch({
      type: BATCH_TYPE,
      schemaVersion: RESULT_SCHEMA_VERSION,
      batchId,
      createdAt,
      sourceRevision: opts.sourceRevision,
      status: "pending",
      rows,
    });
    const batchIds = new Set(rows.map((row) => row.rowId));
    safe.rows = safe.rows.map((row) => {
      if (!batchIds.has(row.rowId)) return row;
      const next = clone(row);
      next.status = "console-batch-pending";
      next.console = {
        ...(next.console || {}),
        batchId,
        preparedAt: createdAt,
        lastOutcome: "pending",
      };
      return sanitizeRow(next);
    });
    safe.pendingBatch = batch;
    safe.updatedAt = createdAt;
    return { registration: safe, batch };
  }

  function prepareConsoleBatch(registration, players, options) {
    const safe = sanitizeRegistration(registration);
    if (safe.pendingBatch && safe.pendingBatch.status === "pending") {
      return {
        registration: safe,
        batch: clone(safe.pendingBatch),
        reused: true,
      };
    }
    return {
      ...createConsoleBatch(safe, players, options),
      reused: false,
    };
  }

  function normalizeNameKey(value) {
    return text(value).toLowerCase().replace(/[^a-z0-9\u00c0-\u024f]+/g, "");
  }

  function playerDisplayName(player) {
    if (!player || typeof player !== "object") return "";
    const surname = text(player.surname || player.lastName || player.last_name);
    const name = text(player.name || player.firstName || player.first_name);
    return text(player.wof_name || player.displayName || `${surname} ${name}`);
  }

  function findRegisteredPlayer(players, batchRow) {
    const list = Array.isArray(players) ? players : [];
    if (batchRow.kind === "existing" && batchRow.selectedPlayer) {
      const expectedId = String(batchRow.selectedPlayer.id);
      return list.find((player) => String(player && player.id) === expectedId) || null;
    }
    const form = batchRow.form || {};
    const forward = normalizeNameKey(`${form.surname} ${form.name}`);
    const reverse = normalizeNameKey(`${form.name} ${form.surname}`);
    const matches = list.filter((player) => {
      const surname = text(player && player.surname);
      const name = text(player && player.name);
      const candidates = [
        normalizeNameKey(`${surname} ${name}`),
        normalizeNameKey(`${name} ${surname}`),
        normalizeNameKey(playerDisplayName(player)),
      ];
      return candidates.includes(forward) || candidates.includes(reverse);
    });
    return matches.length === 1 ? matches[0] : null;
  }

  async function executeConsoleBatch(batchInput, adapter) {
    const batch = sanitizeBatch(batchInput);
    if (!batch || !batch.rows.length) throw new Error("Console 批次为空或格式无效");
    if (!adapter || typeof adapter.getPlayers !== "function") throw new Error("缺少 Player 列表读取器");
    const result = {
      type: RESULT_TYPE,
      schemaVersion: RESULT_SCHEMA_VERSION,
      batchId: batch.batchId,
      tournamentId: text(adapter.tournamentId),
      completedAt: "",
      success: [],
      failed: [],
      unprocessed: [],
    };
    let players = await adapter.getPlayers();
    for (let index = 0; index < batch.rows.length; index += 1) {
      const row = batch.rows[index];
      try {
        let verified = findRegisteredPlayer(players, row);
        if (!verified) {
          if (row.kind === "new") {
            if (typeof adapter.registerNew !== "function") throw new Error("缺少新人登记器");
            await adapter.registerNew(row);
          } else {
            if (typeof adapter.addExisting !== "function") throw new Error("缺少已有 Player 登记器");
            await adapter.addExisting(row);
          }
          players = await adapter.getPlayers();
          verified = findRegisteredPlayer(players, row);
          if (!verified) {
            const verifyError = new Error("重新读取 Player 列表后仍未找到该项目");
            verifyError.code = "verify-not-found";
            throw verifyError;
          }
        }
        result.success.push({
          rowId: row.rowId,
          playerId: numberOrNull(verified.id),
          name: playerDisplayName(verified) || row.rosterName,
        });
      } catch (error) {
        result.failed.push({
          rowId: row.rowId,
          errorCode: text(error && error.code) || "write-or-verify-failed",
          errorMessage: text(error && error.message) || "写入或验证失败",
        });
        for (let rest = index + 1; rest < batch.rows.length; rest += 1) {
          result.unprocessed.push({
            rowId: batch.rows[rest].rowId,
            reason: "stopped-after-failure",
          });
        }
        break;
      }
    }
    result.completedAt = typeof adapter.nowIso === "function"
      ? text(adapter.nowIso())
      : new Date().toISOString();
    return result;
  }

  function validateResultAgainstBatch(result, batch, consumedBatchIds) {
    if (!result || typeof result !== "object") throw new Error("剪贴板内容不是结果对象");
    if (result.type !== RESULT_TYPE) throw new Error("剪贴板不是 FTD Player 导入结果");
    if (Number(result.schemaVersion) !== RESULT_SCHEMA_VERSION) throw new Error("FTD Player 结果版本不兼容");
    if (text(result.batchId) !== batch.batchId) throw new Error("batchId 与当前待确认批次不匹配");
    if ((consumedBatchIds || []).includes(batch.batchId)) throw new Error("该 Console 结果已经应用过");
    const allowed = new Set(batch.rows.map((row) => row.rowId));
    const seen = new Set();
    const groups = ["success", "failed", "unprocessed"];
    for (const group of groups) {
      if (!Array.isArray(result[group])) throw new Error(`结果缺少 ${group} 数组`);
      for (const item of result[group]) {
        const rowId = text(item && item.rowId);
        if (!allowed.has(rowId)) throw new Error(`结果包含不属于当前批次的行：${rowId || "(空)"}`);
        if (seen.has(rowId)) throw new Error(`结果行重复：${rowId}`);
        seen.add(rowId);
      }
    }
    if (seen.size !== allowed.size) throw new Error("结果未覆盖当前批次的全部行");
  }

  function applyConsoleResult(registration, resultInput) {
    const safe = sanitizeRegistration(registration);
    const batch = safe.pendingBatch;
    if (!batch || batch.status !== "pending") throw new Error("当前没有待确认的 Console 批次");
    validateResultAgainstBatch(resultInput, batch, safe.consumedBatchIds);
    const result = clone(resultInput);
    const success = new Map(result.success.map((item) => [text(item.rowId), item]));
    const failed = new Map(result.failed.map((item) => [text(item.rowId), item]));
    const unprocessed = new Map(result.unprocessed.map((item) => [text(item.rowId), item]));
    const completedAt = text(result.completedAt) || new Date().toISOString();
    safe.rows = safe.rows.map((row) => {
      if (success.has(row.rowId)) {
        const item = success.get(row.rowId);
        const next = clone(row);
        next.status = "ftd-written";
        next.errorCode = "";
        next.errorMessage = "";
        if (numberOrNull(item.playerId) !== null) {
          next.selectedPlayer = {
            ...(next.selectedPlayer || { wof_id: null, surname: "", name: "", rating: null, country_code: "" }),
            id: numberOrNull(item.playerId),
          };
        }
        next.console = {
          ...(next.console || {}),
          lastOutcome: "success",
          lastResultAt: completedAt,
          tournamentId: text(result.tournamentId),
        };
        return sanitizeRow(next);
      }
      if (failed.has(row.rowId)) {
        const item = failed.get(row.rowId);
        const next = clone(row);
        next.status = "ftd-write-failed";
        next.errorCode = text(item.errorCode) || "write-or-verify-failed";
        next.errorMessage = text(item.errorMessage) || "写入或验证失败";
        next.console = {
          ...(next.console || {}),
          lastOutcome: "failed",
          lastResultAt: completedAt,
          tournamentId: text(result.tournamentId),
        };
        return sanitizeRow(next);
      }
      if (unprocessed.has(row.rowId)) {
        const next = clone(row);
        next.status = "console-batch-pending";
        next.console = {
          ...(next.console || {}),
          lastOutcome: "unprocessed",
          lastResultAt: completedAt,
          tournamentId: text(result.tournamentId),
        };
        return sanitizeRow(next);
      }
      return row;
    });
    safe.pendingBatch = null;
    safe.consumedBatchIds = Array.from(new Set([...safe.consumedBatchIds, batch.batchId])).slice(-50);
    safe.updatedAt = completedAt;
    return {
      registration: safe,
      counts: {
        success: success.size,
        failed: failed.size,
        unprocessed: unprocessed.size,
      },
    };
  }

  function buildConsoleCode(batchInput) {
    const batch = sanitizeBatch(batchInput);
    if (!batch || !batch.rows.length) throw new Error("无法生成空的 Console 批次");
    const serialized = JSON.stringify(batch);
    return `void (async function () {
  "use strict";
  const BATCH = ${serialized};
  const RESULT_TYPE = ${JSON.stringify(RESULT_TYPE)};
  const SCHEMA_VERSION = ${RESULT_SCHEMA_VERSION};
  const timeoutMs = 12000;
  const verifyTimeoutMs = 20000;
  const verifyPollMs = 500;
  const clean = (value) => String(value == null ? "" : value).replace(/\\s+/g, " ").trim();
  const key = (value) => clean(value).toLowerCase().replace(/[^a-z0-9\\u00c0-\\u024f]+/g, "");
  const displayName = (player) => clean(player && (player.wof_name || player.displayName || [player.surname, player.name].filter(Boolean).join(" ")));
  const result = { type: RESULT_TYPE, schemaVersion: SCHEMA_VERSION, batchId: BATCH.batchId, tournamentId: "", completedAt: "", success: [], failed: [], unprocessed: [] };
  let socket = null;
  let stoppedAt = -1;
  function fail(code, message) { const error = new Error(message); error.code = code; return error; }
  function parseTournamentId() {
    const match = String(location.pathname || "").match(/^\\/live\\/(\\d+)\\/?$/i);
    if (!match) throw fail("invalid-live-page", "请在 https://flipthedisc.com/live/<tournamentId> 页面运行代码");
    return match[1];
  }
  function readCredentials() {
    let data = null;
    try { data = JSON.parse(localStorage.getItem("userData") || "null"); } catch (_) {}
    if (!data || !data.token || !data.sid) throw fail("missing-auth", "localStorage.userData 缺少 token 或 sid，请先登录 FTD");
    return { token: data.token, sid: data.sid };
  }
  function loadSocketClient() {
    if (typeof window.io === "function") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = location.origin + "/socket.io/socket.io.js";
      script.onload = () => typeof window.io === "function" ? resolve() : reject(fail("socket-client-missing", "Socket.IO 客户端加载后仍不可用"));
      script.onerror = () => reject(fail("socket-client-load-failed", "无法加载 FTD Socket.IO 客户端"));
      document.head.appendChild(script);
    });
  }
  function connect(credentials) {
    return new Promise((resolve, reject) => {
      let done = false;
      const candidate = window.io(location.origin, {
        auth: async (callback) => callback({ token: credentials.token, sid: credentials.sid }),
        forceNew: true,
        withCredentials: true,
        reconnection: false,
      });
      const timer = setTimeout(() => finish(fail("socket-connect-timeout", "FTD Socket.IO 连接超时")), timeoutMs);
      function finish(error) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        candidate.off("connect", onConnect);
        candidate.off("connect_error", onError);
        if (error) reject(error); else resolve(candidate);
      }
      function onConnect() { finish(null); }
      function onError(error) { finish(fail("socket-connect-error", clean(error && error.message) || "FTD Socket.IO 连接失败")); }
      candidate.on("connect", onConnect);
      candidate.on("connect_error", onError);
      if (candidate.connected) finish(null);
    });
  }
  function checkTd(tournamentId) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => finish(fail("td-check-timeout", "is-td 权限检查超时")), timeoutMs);
      function finish(error, allowed) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.off("td", onTd);
        if (error) reject(error); else resolve(allowed);
      }
      function onTd(isTD) { finish(null, isTD === true); }
      socket.on("td", onTd);
      socket.emit("is-td", tournamentId);
    });
  }
  function getPlayers(tournamentId) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => finish(fail("player-list-timeout", "get-otb-reg 读取 Player 列表超时")), timeoutMs);
      function finish(error, players) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.off("otb-players-list", onList);
        if (error) reject(error); else resolve(players);
      }
      function onList(players) {
        if (!Array.isArray(players)) return finish(fail("invalid-player-list", "otb-players-list 返回格式异常"));
        finish(null, players);
      }
      socket.on("otb-players-list", onList);
      socket.emit("get-otb-reg", tournamentId);
    });
  }
  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
  function findPlayer(players, row) {
    if (row.kind === "existing") {
      return players.find((player) => String(player && player.id) === String(row.selectedPlayer && row.selectedPlayer.id)) || null;
    }
    const form = row.form || {};
    const forward = key(form.surname + " " + form.name);
    const reverse = key(form.name + " " + form.surname);
    const matches = players.filter((player) => {
      const a = key(clean(player && player.surname) + " " + clean(player && player.name));
      const b = key(clean(player && player.name) + " " + clean(player && player.surname));
      const c = key(displayName(player));
      return a === forward || a === reverse || b === forward || b === reverse || c === forward || c === reverse;
    });
    return matches.length === 1 ? matches[0] : null;
  }
  async function emitAndVerify(eventName, args, tournamentId, row) {
    const errorEvents = ["registration-error", "otb-update-error", "tournament-update-error"];
    let responseError = null;
    function onError(message) {
      responseError = fail("ftd-response-error", clean(message) || "FTD 返回写入错误");
    }
    errorEvents.forEach((name) => socket.on(name, onError));
    try {
      socket.emit.apply(socket, [eventName].concat(args));
      const deadline = Date.now() + verifyTimeoutMs;
      while (true) {
        if (responseError) throw responseError;
        const players = await getPlayers(tournamentId);
        const verified = findPlayer(players, row);
        if (verified) return { players, verified };
        if (Date.now() >= deadline) {
          throw fail("verify-not-found", eventName + " 后轮询 Player 列表仍未找到该项目");
        }
        await sleep(verifyPollMs);
      }
    } finally {
      errorEvents.forEach((name) => socket.off(name, onError));
    }
  }
  function markStopped(index, error) {
    stoppedAt = index;
    const row = BATCH.rows[index];
    result.failed.push({ rowId: row.rowId, errorCode: clean(error && error.code) || "write-or-verify-failed", errorMessage: clean(error && error.message) || "写入或验证失败" });
    BATCH.rows.slice(index + 1).forEach((item) => result.unprocessed.push({ rowId: item.rowId, reason: "stopped-after-failure" }));
  }
  try {
    const tournamentId = parseTournamentId();
    result.tournamentId = tournamentId;
    const credentials = readCredentials();
    await loadSocketClient();
    socket = await connect(credentials);
    if (!(await checkTd(tournamentId))) throw fail("not-td", "当前登录账号不是该比赛 TD，已停止且未写入");
    let players = await getPlayers(tournamentId);
    for (let index = 0; index < BATCH.rows.length; index += 1) {
      const row = BATCH.rows[index];
      try {
        let verified = findPlayer(players, row);
        if (!verified) {
          let writeResult;
          if (row.kind === "new") {
            writeResult = await emitAndVerify("register-new-wof", [row.form, row.categories || [], tournamentId], tournamentId, row);
          } else {
            writeResult = await emitAndVerify("add-player-otb", [row.selectedPlayer.id, row.categories || [], row.countryCode, row.family, tournamentId], tournamentId, row);
          }
          players = writeResult.players;
          verified = writeResult.verified;
        }
        result.success.push({ rowId: row.rowId, playerId: verified.id == null ? null : Number(verified.id), name: displayName(verified) || row.rosterName });
        console.log("[FTD Player] 成功", row.rosterName, verified.id);
      } catch (error) {
        markStopped(index, error);
        console.error("[FTD Player] 失败并停止", row.rosterName, error);
        break;
      }
    }
  } catch (error) {
    if (stoppedAt < 0 && BATCH.rows.length) markStopped(0, error);
    console.error("[FTD Player] 批次停止", error);
  } finally {
    result.completedAt = new Date().toISOString();
    if (socket && typeof socket.disconnect === "function") socket.disconnect();
    console.table({ success: result.success.length, failed: result.failed.length, unprocessed: result.unprocessed.length });
    console.log("[FTD Player] 结构化结果（不含登录凭证）", result);
    window.__FTD_PLAYER_IMPORT_RESULT__ = result;
    let copied = false;
    if (navigator.clipboard && document.hasFocus()) {
      try {
        await navigator.clipboard.writeText(JSON.stringify(result));
        copied = true;
      } catch (error) {
        console.warn("[FTD Player] 自动写入剪贴板失败，结果仍已保存在 window.__FTD_PLAYER_IMPORT_RESULT__。", error);
      }
    }
    if (copied) {
      console.log("[FTD Player] 结果 JSON 已写入剪贴板。返回本地页面按 Shift+Enter。");
    } else {
      console.warn("[FTD Player] 页面当前未聚焦，浏览器禁止自动写剪贴板。请在本 Console 运行下一行命令，再返回本地页面按 Shift+Enter：");
      console.log("copy(JSON.stringify(window.__FTD_PLAYER_IMPORT_RESULT__))");
    }
  }
})();`;
  }

  return {
    REGISTRATION_SCHEMA_VERSION,
    RESULT_TYPE,
    RESULT_SCHEMA_VERSION,
    BATCH_TYPE,
    STATUS_LABELS,
    RESOLVED_STATUSES: Array.from(RESOLVED_STATUSES),
    text,
    rowIdForPlayer,
    rosterSignature,
    sanitizeSelectedPlayer,
    sanitizeNewPlayer,
    sanitizeRow,
    sanitizeBatch,
    emptyRegistration,
    sanitizeRegistration,
    syncRowsWithPlayers,
    statusLabel,
    uniqueBatchId,
    createConsoleBatch,
    prepareConsoleBatch,
    normalizeNameKey,
    playerDisplayName,
    findRegisteredPlayer,
    executeConsoleBatch,
    applyConsoleResult,
    buildConsoleCode,
  };
});
