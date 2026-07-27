const TOKEN_BYTES = 24;
const OQ_ACCOUNT_RE = /^[A-Za-z0-9_]{1,14}$/;
const OQ_ACCOUNT_ALLOWED_CHARS_RE = /^[A-Za-z0-9_]+$/;
const MODE_ENDPOINTS = {
  "1min": "reversi1",
  "5min": "reversi",
  xot: "reversix",
};
const OQ_VALIDATION_MODE_ORDER = ["5min", "1min", "xot"];

export async function onRequest(context) {
  const { request, env } = context;
  try {
    if (!env.MAP_DB) return jsonError("D1 binding MAP_DB is not configured", 500);
    await ensureSchema(env);
    const url = new URL(request.url);
    const parts = pathParts(context.params.path);
    if (request.method === "POST" && parts.length === 0) return createTable(request, env, url);
    if (parts.length === 1 && request.method === "GET") return getTable(parts[0], request, env, url);
    if (parts.length === 1 && request.method === "PUT") return updateTable(parts[0], request, env, url);
    if (parts.length === 2 && parts[1] === "validate-oq" && request.method === "POST") {
      return validateTableOq(parts[0], request, env, url);
    }
    if (parts.length === 2 && parts[1] === "force-oq" && request.method === "POST") {
      return forceTableOq(parts[0], request, env);
    }
    return jsonError("Not found", 404);
  } catch (error) {
    return jsonError("Request failed", 500, String(error && error.message ? error.message : error));
  }
}

async function ensureSchema(env) {
  await env.MAP_DB.prepare(
    `CREATE TABLE IF NOT EXISTS mapping_tables (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      payload_json TEXT NOT NULL,
      edit_token_hash TEXT NOT NULL,
      view_token_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  ).run();
  await env.MAP_DB.prepare(
    `CREATE TABLE IF NOT EXISTS mapping_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      patch_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (table_id) REFERENCES mapping_tables(id)
    )`,
  ).run();
  await env.MAP_DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_mapping_audit_table_id ON mapping_audit(table_id, id)",
  ).run();
}

function pathParts(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  return String(value).split("/").filter(Boolean);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function jsonError(error, status = 400, detail = "") {
  return json({ ok: false, error, detail }, status);
}

async function readJson(request) {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error.message}`);
  }
}

function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeKey(value) {
  return normalizeWhitespace(value).toLowerCase();
}

function nowIso() {
  return new Date().toISOString();
}

function randomToken(prefix) {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  const token = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `${prefix}_${token}`;
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(String(text || ""));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function publicBaseUrl(url) {
  return `${url.protocol}//${url.host}`;
}

function tableLinks(base, id, editToken) {
  return {
    edit: `${base}/m/${encodeURIComponent(id)}?token=${encodeURIComponent(editToken)}`,
  };
}

async function createTable(request, env, url) {
  const body = await readJson(request);
  const mapping = sanitizeMapping(body.mapping || body.ftdPlayerAccountMapping);
  if (!mapping) return jsonError("mapping is required");
  const id = normalizeId(body.id || mapping.target?.id || mapping.ftdPageUrl || `map-${Date.now().toString(36)}`);
  const title = normalizeWhitespace(body.title || mapping.groupName || mapping.group || "FTD/OQ 映射表");
  const editToken = randomToken("edit");
  const inactiveToken = randomToken("inactive");
  const createdAt = nowIso();
  const payload = rebuildStats(mapping, createdAt);
  const existing = await env.MAP_DB.prepare("SELECT id FROM mapping_tables WHERE id = ?").bind(id).first();
  if (existing) return jsonError("table id already exists", 409, id);
  await env.MAP_DB.prepare(
    `INSERT INTO mapping_tables
      (id, title, revision, payload_json, edit_token_hash, view_token_hash, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
  )
    .bind(id, title, JSON.stringify(payload), await sha256(editToken), await sha256(inactiveToken), createdAt, createdAt)
    .run();
  await audit(env, id, 1, "owner", "create", { playerCount: payload.playerCount || 0 });
  return json({
    ok: true,
    id,
    title,
    revision: 1,
    mapping: payload,
    links: tableLinks(publicBaseUrl(url), id, editToken),
  }, 201);
}

async function getStoredTable(env, id) {
  return env.MAP_DB.prepare("SELECT * FROM mapping_tables WHERE id = ?").bind(id).first();
}

async function authorize(row, request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || request.headers.get("X-Map-Token") || "";
  if (!token) return null;
  const hash = await sha256(token);
  if (hash === row.edit_token_hash) return "edit";
  return null;
}

async function getTable(id, request, env, url) {
  const row = await getStoredTable(env, id);
  if (!row) return jsonError("table not found", 404);
  const mode = await authorize(row, request);
  if (!mode) return jsonError("invalid token", 403);
  return json({
    ok: true,
    id: row.id,
    title: row.title,
    revision: row.revision,
    mode,
    mapping: JSON.parse(row.payload_json),
    links: mode === "edit"
      ? {
          edit: `${publicBaseUrl(url)}/m/${encodeURIComponent(row.id)}?token=${encodeURIComponent(new URL(request.url).searchParams.get("token") || "")}`,
        }
      : null,
  });
}

async function updateTable(id, request, env) {
  const row = await getStoredTable(env, id);
  if (!row) return jsonError("table not found", 404);
  const mode = await authorize(row, request);
  if (mode !== "edit") return jsonError("edit token required", 403);
  const body = await readJson(request);
  const incomingRevision = Number(body.revision);
  if (!Number.isFinite(incomingRevision) || Math.trunc(incomingRevision) !== row.revision) {
    return jsonError("revision conflict", 409, `remote=${row.revision}; incoming=${body.revision}`);
  }
  const mapping = sanitizeMapping(body.mapping);
  if (!mapping) return jsonError("mapping is required");
  const updatedAt = nowIso();
  const nextRevision = row.revision + 1;
  const nextMapping = rebuildStats(mapping, updatedAt);
  const title = normalizeWhitespace(body.title || row.title);
  await env.MAP_DB.prepare(
    "UPDATE mapping_tables SET title = ?, revision = ?, payload_json = ?, updated_at = ? WHERE id = ?",
  )
    .bind(title, nextRevision, JSON.stringify(nextMapping), updatedAt, id)
    .run();
  await audit(env, id, nextRevision, "editor", normalizeWhitespace(body.action || "update"), summarizePatch(JSON.parse(row.payload_json), nextMapping));
  return json({ ok: true, id, title, revision: nextRevision, mapping: nextMapping });
}

async function validateTableOq(id, request, env) {
  const row = await getStoredTable(env, id);
  if (!row) return jsonError("table not found", 404);
  const mode = await authorize(row, request);
  if (mode !== "edit") return jsonError("edit token required", 403);
  const body = await readJson(request);
  const incomingRevision = Number(body.revision);
  if (!Number.isFinite(incomingRevision) || Math.trunc(incomingRevision) !== row.revision) {
    return jsonError("revision conflict", 409, `remote=${row.revision}; incoming=${body.revision}`);
  }
  const mapping = sanitizeMapping(JSON.parse(row.payload_json));
  const rows = Array.isArray(mapping.players) ? mapping.players : [];
  const accountRows = rows.filter(rowNeedsManualOqValidation);
  const accounts = [...new Map(accountRows
    .map((item) => normalizeWhitespace(item.account))
    .filter(Boolean)
    .map((account) => [account.toLowerCase(), account])).values()];
  const checkedAt = nowIso();
  const oqMode = MODE_ENDPOINTS[body.mode] ? body.mode : "5min";
  const started = Date.now();
  const results = await validateOqAccounts(accounts, oqMode);
  const byAccount = {};
  results.forEach((result) => {
    byAccount[normalizeKey(result.account)] = result;
  });
  mapping.players = rows.map((item) => {
    const rowCopy = { ...item };
    const result = byAccount[normalizeKey(rowCopy.account)];
    if (!result || isDeleted(rowCopy)) return rowCopy;
    const previousOqCheck = rowCopy.oqCheck && typeof rowCopy.oqCheck === "object" ? rowCopy.oqCheck : null;
    if (result.ok || !previousOqCheck || normalizeWhitespace(previousOqCheck.status) !== "forced-ok") {
      rowCopy.oqCheck = {
        account: result.account,
        status: result.ok ? "ok" : "invalid",
        checkedAt,
        mode: result.mode || "",
        primaryMode: result.primaryMode || "",
        fallbackUsed: Boolean(result.fallbackUsed),
        elapsedMs: result.elapsedMs,
        totalGames: result.totalGames || 0,
        windowGames: 0,
        error: result.ok ? "" : result.error || "OQ account validation failed",
      };
    } else {
      rowCopy.oqCheck = {
        ...previousOqCheck,
        account: normalizeWhitespace(rowCopy.account),
        checkedAt: previousOqCheck.checkedAt || checkedAt,
        lastValidationAttemptAt: checkedAt,
        lastValidationError: result.error || "OQ account validation failed",
      };
    }
    delete rowCopy.status;
    if (result.ok && normalizeWhitespace(rowCopy.account) && normalizeWhitespace(rowCopy.groupNick)) {
      rowCopy.reason = "";
      rowCopy.pendingText = "";
    } else if (!result.ok && normalizeWhitespace(rowCopy.oqCheck && rowCopy.oqCheck.status) !== "forced-ok") {
      rowCopy.reason = "OQ account validation failed";
      rowCopy.pendingText = `OQ账号：${rowCopy.account || ""}；FTD姓名：${rowCopy.ftdName || ""}；错误：${rowCopy.oqCheck.error}`;
    }
    return rowCopy;
  });
  const oqValidation = {
    checkedAt,
    checkedCount: results.length,
    okCount: results.filter((item) => item.ok).length,
    invalidCount: results.filter((item) => !item.ok).length,
    skippedCount: Math.max(0, rows.filter((item) => !isDeleted(item) && normalizeWhitespace(item.account)).length - results.length),
    incremental: true,
    wallMs: Date.now() - started,
  };
  mapping.oqValidation = oqValidation;
  const nextRevision = row.revision + 1;
  const nextMapping = rebuildStats(mapping, checkedAt);
  await env.MAP_DB.prepare(
    "UPDATE mapping_tables SET revision = ?, payload_json = ?, updated_at = ? WHERE id = ?",
  )
    .bind(nextRevision, JSON.stringify(nextMapping), checkedAt, id)
    .run();
  await audit(env, id, nextRevision, "editor", "validate-oq", oqValidation);
  return json({ ok: true, id, revision: nextRevision, mapping: nextMapping, oqValidation });
}

async function forceTableOq(id, request, env) {
  const row = await getStoredTable(env, id);
  if (!row) return jsonError("table not found", 404);
  const mode = await authorize(row, request);
  if (mode !== "edit") return jsonError("edit token required", 403);
  const body = await readJson(request);
  const incomingRevision = Number(body.revision);
  if (!Number.isFinite(incomingRevision) || Math.trunc(incomingRevision) !== row.revision) {
    return jsonError("revision conflict", 409, `remote=${row.revision}; incoming=${body.revision}`);
  }
  const mapping = sanitizeMapping(JSON.parse(row.payload_json));
  const rows = Array.isArray(mapping.players) ? mapping.players : [];
  const targetName = normalizeKey(body.ftdName || "");
  const targetIndex = Number.isFinite(Number(body.index)) ? Math.trunc(Number(body.index)) : -1;
  const forcedAt = nowIso();
  let changed = false;
  mapping.players = rows.map((item, index) => {
    const rowCopy = { ...item };
    const nameMatches = targetName && normalizeKey(rowCopy.ftdName) === targetName;
    const indexMatches = targetIndex >= 0 && index === targetIndex;
    if (!changed && (nameMatches || indexMatches) && isInvalid(rowCopy)) {
      const account = normalizeWhitespace(rowCopy.account).replace(/\s+/g, "");
      if (!OQ_ACCOUNT_ALLOWED_CHARS_RE.test(account)) return rowCopy;
      const previous = rowCopy.oqCheck && typeof rowCopy.oqCheck === "object" ? rowCopy.oqCheck : {};
      rowCopy.account = account;
      rowCopy.oqCheck = {
        ...previous,
        account,
        status: "forced-ok",
        checkedAt: previous.checkedAt || forcedAt,
        forcedAt,
        forcedBy: "editor",
        error: "",
      };
      rowCopy.reason = "";
      rowCopy.pendingText = "";
      rowCopy.source = "user";
      rowCopy.editAudit = { by: "user", action: "强制通过OQ校验", at: forcedAt };
      changed = true;
    }
    return rowCopy;
  });
  if (!changed) return jsonError("no invalid row matched for force validation", 400);
  const nextRevision = row.revision + 1;
  const nextMapping = rebuildStats(mapping, forcedAt);
  await env.MAP_DB.prepare(
    "UPDATE mapping_tables SET revision = ?, payload_json = ?, updated_at = ? WHERE id = ?",
  )
    .bind(nextRevision, JSON.stringify(nextMapping), forcedAt, id)
    .run();
  await audit(env, id, nextRevision, "editor", "force-oq", {
    ftdName: body.ftdName || "",
    index: targetIndex,
    forcedAt,
  });
  return json({ ok: true, id, revision: nextRevision, mapping: nextMapping });
}

async function audit(env, tableId, revision, actor, action, patch) {
  await env.MAP_DB.prepare(
    "INSERT INTO mapping_audit (table_id, revision, actor, action, patch_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(tableId, revision, actor, action, JSON.stringify(patch || {}), nowIso())
    .run();
}

function normalizeId(value) {
  const text = normalizeWhitespace(value)
    .replace(/^https?:\/\//i, "")
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return text || `map-${Date.now().toString(36)}`;
}

function sanitizeMapping(raw) {
  if (!raw || typeof raw !== "object") return null;
  const rows = Array.isArray(raw.players) ? raw.players : [];
  if (!rows.length) return null;
  return {
    ...raw,
    type: normalizeWhitespace(raw.type || "ftd-player-oq-account-map"),
    scope: normalizeWhitespace(raw.scope || "ftd-player-table"),
    group: normalizeWhitespace(raw.group || ""),
    groupName: normalizeWhitespace(raw.groupName || raw.group || ""),
    mappedAt: String(raw.mappedAt || ""),
    sourceFile: normalizeWhitespace(raw.sourceFile || ""),
    ftdExportedAt: String(raw.ftdExportedAt || ""),
    ftdPageUrl: normalizeWhitespace(raw.ftdPageUrl || ""),
    output: normalizeWhitespace(raw.output || ""),
    wechatGroupNicks: sanitizeWechatGroupNicks(raw.wechatGroupNicks),
    registrationRelay: sanitizeRegistrationRelay(raw.registrationRelay),
    players: rows.map(sanitizeRow).filter(Boolean).slice(0, 300),
  };
}

function sanitizeRegistrationRelay(raw) {
  const obj = raw && typeof raw === "object" ? raw : null;
  if (!obj) return null;
  const entries = Array.isArray(obj.entries)
    ? obj.entries
      .map((item) => {
        const entry = item && typeof item === "object" ? item : null;
        if (!entry) return null;
        const name = normalizeWhitespace(entry.name || "");
        const account = normalizeWhitespace(entry.account || "");
        if (!name || !account) return null;
        return {
          index: Number.isFinite(Number(entry.index)) ? Math.trunc(Number(entry.index)) : "",
          name,
          account,
          rawLine: normalizeWhitespace(entry.rawLine || ""),
        };
      })
      .filter(Boolean)
      .slice(0, 300)
    : [];
  const ignored = Array.isArray(obj.ignored)
    ? obj.ignored
      .map((item) => {
        const entry = item && typeof item === "object" ? item : null;
        if (!entry) return null;
        const line = normalizeWhitespace(entry.line || "");
        if (!line) return null;
        return {
          index: Number.isFinite(Number(entry.index)) ? Math.trunc(Number(entry.index)) : "",
          line,
          reason: normalizeWhitespace(entry.reason || ""),
        };
      })
      .filter(Boolean)
      .slice(0, 120)
    : [];
  return {
    version: 1,
    source: normalizeWhitespace(obj.source || "frontend-state relayText"),
    checkedAt: String(obj.checkedAt || ""),
    currentMonth: Number.isFinite(Number(obj.currentMonth)) ? Math.trunc(Number(obj.currentMonth)) : "",
    detectedMonths: Array.isArray(obj.detectedMonths)
      ? obj.detectedMonths.map((value) => Math.trunc(Number(value))).filter((value) => value >= 1 && value <= 12)
      : [],
    monthMatched: obj.monthMatched === true,
    titleLine: String(obj.titleLine || ""),
    competitionName: normalizeWhitespace(obj.competitionName || ""),
    mappingTitle: normalizeWhitespace(obj.mappingTitle || ""),
    entryCount: entries.length,
    ignoredCount: ignored.length,
    entries,
    ignored,
    rawText: String(obj.rawText || ""),
  };
}

function sanitizeWechatGroupNicks(raw) {
  const obj = raw && typeof raw === "object" ? raw : null;
  if (!obj) return null;
  const source = Array.isArray(obj.groupNicks)
    ? obj.groupNicks
    : Array.isArray(obj.members)
      ? obj.members.map((item) => item && typeof item === "object" ? item.groupNick || item.group_nick || "" : item)
      : [];
  const seen = new Set();
  const groupNicks = [];
  source.forEach((value) => {
    const nick = normalizeWhitespace(value);
    const key = normalizeKey(nick);
    if (!nick || seen.has(key)) return;
    seen.add(key);
    groupNicks.push(nick);
  });
  groupNicks.sort((a, b) => a.localeCompare(b, "zh-Hans"));
  return {
    version: 1,
    groupName: normalizeWhitespace(obj.groupName || obj.group_name || ""),
    refreshedAt: String(obj.refreshedAt || obj.refreshed_at || ""),
    updatedAt: Number.isFinite(Number(obj.updatedAt)) ? Number(obj.updatedAt) : Date.now(),
    groupNicks,
  };
}

function sanitizeRow(raw) {
  const row = raw && typeof raw === "object" ? raw : {};
  const ftdName = normalizeWhitespace(row.ftdName || row.displayName || row.name || "");
  if (!ftdName) return null;
  const clean = {
    ...row,
    ftdName,
    ftdId: row.ftdId == null ? "" : row.ftdId,
    account: normalizeWhitespace(row.account || "").replace(/\s+/g, ""),
    groupNick: normalizeWhitespace(row.groupNick || row.group_nick || ""),
    reason: normalizeWhitespace(row.reason || ""),
    pendingText: normalizeWhitespace(row.pendingText || ""),
    source: normalizeWhitespace(row.source || ""),
    deleted: row.deleted === true || normalizeWhitespace(row.status) === "deleted",
    oqCheck: sanitizeOqCheck(row.oqCheck || row.oq_check),
    editAudit: row.editAudit && typeof row.editAudit === "object"
      ? {
          by: normalizeWhitespace(row.editAudit.by) === "agent" ? "agent" : "user",
          action: normalizeWhitespace(row.editAudit.action || "编辑"),
          at: String(row.editAudit.at || ""),
        }
      : null,
  };
  delete clean.status;
  return clean;
}

function sanitizeOqCheck(value) {
  const item = value && typeof value === "object" ? value : null;
  if (!item || !normalizeWhitespace(item.status)) return null;
  return {
    account: normalizeWhitespace(item.account || ""),
    status: normalizeWhitespace(item.status || ""),
    checkedAt: String(item.checkedAt || ""),
    forcedAt: String(item.forcedAt || ""),
    forcedBy: normalizeWhitespace(item.forcedBy || ""),
    lastValidationAttemptAt: String(item.lastValidationAttemptAt || ""),
    lastValidationError: normalizeWhitespace(item.lastValidationError || ""),
    mode: normalizeWhitespace(item.mode || ""),
    primaryMode: normalizeWhitespace(item.primaryMode || ""),
    fallbackUsed: item.fallbackUsed === true,
    elapsedMs: Number.isFinite(Number(item.elapsedMs)) ? Number(item.elapsedMs) : 0,
    totalGames: Number.isFinite(Number(item.totalGames)) ? Math.max(0, Math.trunc(Number(item.totalGames))) : 0,
    windowGames: Number.isFinite(Number(item.windowGames)) ? Math.max(0, Math.trunc(Number(item.windowGames))) : 0,
    error: normalizeWhitespace(item.error || ""),
  };
}

function oqCheckMatches(row) {
  if (!row || !row.oqCheck || typeof row.oqCheck !== "object") return false;
  const checked = normalizeWhitespace(row.oqCheck.account || row.oqCheckAccount || "");
  if (!checked) return true;
  return normalizeKey(checked) === normalizeKey(row.account);
}

function rowNeedsManualOqValidation(row) {
  if (!row || isDeleted(row)) return false;
  const account = normalizeWhitespace(row.account);
  if (!account) return false;
  const check = row.oqCheck && typeof row.oqCheck === "object" ? row.oqCheck : null;
  if (!check || !oqCheckMatches(row)) return true;
  const status = normalizeWhitespace(check.status);
  if (status === "invalid") return true;
  if (status === "forced-ok") return true;
  if (status !== "ok") return true;
  const checkedAt = Date.parse(check.checkedAt || "");
  const audit = row.editAudit && typeof row.editAudit === "object" ? row.editAudit : null;
  const auditAt = audit && normalizeWhitespace(audit.by) === "user"
    ? Date.parse(audit.at || "")
    : 0;
  const checked = normalizeWhitespace(check.account || row.oqCheckAccount || "");
  return !checked && Number.isFinite(auditAt) && Number.isFinite(checkedAt) && auditAt > checkedAt;
}

function isDeleted(row) {
  return Boolean(row && row.deleted);
}

function isInvalid(row) {
  if (!row || isDeleted(row)) return false;
  const check = row.oqCheck && typeof row.oqCheck === "object" ? row.oqCheck : null;
  return Boolean(normalizeWhitespace(row.account) && normalizeWhitespace(row.groupNick) && check && oqCheckMatches(row) && check.status === "invalid");
}

function isComplete(row) {
  const check = row && row.oqCheck && typeof row.oqCheck === "object" ? row.oqCheck : null;
  const status = normalizeWhitespace(check && check.status);
  return Boolean(
    row &&
      !isDeleted(row) &&
      !isInvalid(row) &&
      normalizeWhitespace(row.ftdName) &&
      normalizeWhitespace(row.account) &&
      normalizeWhitespace(row.groupNick) &&
      check &&
      (status === "ok" || status === "forced-ok") &&
      oqCheckMatches(row),
  );
}

function rebuildStats(mapping, mappedAt = nowIso()) {
  const rows = Array.isArray(mapping.players) ? mapping.players.map(sanitizeRow).filter(Boolean) : [];
  const accountIndex = {};
  rows.forEach((row) => {
    const key = normalizeKey(row.ftdName);
    if (!key || isDeleted(row)) return;
    if (row.oqCheck && !oqCheckMatches(row)) {
      row.oqCheck = null;
      row.reason = "OQ account changed; validation required";
    }
    const oqStatus = normalizeWhitespace(row.oqCheck && row.oqCheck.status);
    if (!row.account || !row.groupNick || !row.oqCheck || !["ok", "forced-ok"].includes(oqStatus) || !oqCheckMatches(row)) return;
    accountIndex[key] = {
      ftdName: row.ftdName,
      displayName: row.ftdName,
      account: row.account,
      groupNick: row.groupNick,
      ftdId: row.ftdId == null ? "" : row.ftdId,
      source: row.source || "",
      mappedAt,
      oqStatus: row.oqCheck.status || "",
    };
  });
  const active = rows.filter((row) => !isDeleted(row));
  const invalid = active.filter(isInvalid);
  return {
    ...mapping,
    mappedAt,
    updatedAt: Date.now(),
    accountIndex,
    players: rows,
    playerCount: rows.length,
    indexedCount: Object.keys(accountIndex).length,
    matchedCount: active.filter(isComplete).length,
    invalidAccountCount: invalid.length,
    ambiguousCount: 0,
    unmatchedCount: active.filter((row) => !isComplete(row) && !isInvalid(row)).length,
    unmatched: active.filter((row) => !isComplete(row) && !isInvalid(row)).slice(0, 120),
    invalidAccounts: invalid.slice(0, 120),
    ambiguous: [],
  };
}

function summarizePatch(before, after) {
  const beforeRows = Array.isArray(before.players) ? before.players : [];
  const afterRows = Array.isArray(after.players) ? after.players : [];
  let changedRows = 0;
  afterRows.forEach((row, index) => {
    const old = beforeRows[index] || {};
    if (
      normalizeWhitespace(row.account) !== normalizeWhitespace(old.account) ||
      normalizeWhitespace(row.groupNick) !== normalizeWhitespace(old.groupNick) ||
      Boolean(row.deleted) !== Boolean(old.deleted)
    ) {
      changedRows += 1;
    }
  });
  return {
    changedRows,
    before: {
      matchedCount: before.matchedCount || 0,
      invalidAccountCount: before.invalidAccountCount || 0,
      unmatchedCount: before.unmatchedCount || 0,
    },
    after: {
      matchedCount: after.matchedCount || 0,
      invalidAccountCount: after.invalidAccountCount || 0,
      unmatchedCount: after.unmatchedCount || 0,
    },
  };
}

async function validateOqAccounts(accounts, mode) {
  const primaryMode = MODE_ENDPOINTS[mode] ? mode : "5min";
  const unique = [...new Map(accounts
    .map(normalizeWhitespace)
    .filter(Boolean)
    .map((account) => [account.toLowerCase(), account])).values()];
  const batches = [];
  for (let i = 0; i < unique.length; i += 8) batches.push(unique.slice(i, i + 8));
  const out = [];
  for (const batch of batches) {
    const results = await Promise.all(batch.map((account) => validateOneOqAccount(account, primaryMode)));
    out.push(...results);
  }
  return out.sort((a, b) => a.account.localeCompare(b.account));
}

function oqValidationModes(primaryMode) {
  const first = MODE_ENDPOINTS[primaryMode] ? primaryMode : "5min";
  return [first, ...OQ_VALIDATION_MODE_ORDER.filter((mode) => mode !== first)];
}

function oqModeLabel(mode) {
  return mode === "5min" ? "5min" : mode;
}

async function validateOneOqAccount(account, primaryMode) {
  const started = Date.now();
  if (!account) return invalidOq(account, started, "OQ account is empty");
  if (!OQ_ACCOUNT_RE.test(account)) {
    return invalidOq(account, started, "OQ account must be 1-14 ASCII letters, digits, or underscores");
  }
  const errors = [];
  for (const mode of oqValidationModes(primaryMode)) {
    const endpoint = MODE_ENDPOINTS[mode] || MODE_ENDPOINTS["5min"];
    const url = `http://questgames.net/games/${endpoint}/${encodeURIComponent(account.toLowerCase())}.json`;
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "onlicheck-map-collab/0.1" },
        cf: { cacheTtl: 0, cacheEverything: false },
      });
      if (!response.ok) {
        errors.push(`${oqModeLabel(mode)}: HTTP ${response.status}`);
        continue;
      }
      const data = await response.json();
      const games = Array.isArray(data) ? data : Array.isArray(data.games) ? data.games : [];
      if (!games.length) {
        errors.push(`${oqModeLabel(mode)}: no game history`);
        continue;
      }
      return {
        account,
        ok: true,
        status: "ok",
        mode,
        primaryMode,
        fallbackUsed: mode !== primaryMode,
        elapsedMs: Date.now() - started,
        totalGames: games.length,
        error: "",
      };
    } catch (error) {
      errors.push(`${oqModeLabel(mode)}: ${String(error && error.message ? error.message : error)}`);
    }
  }
  return invalidOq(account, started, errors.join("; ") || "OQ account has no game history");
}

function invalidOq(account, started, error) {
  return {
    account: normalizeWhitespace(account),
    ok: false,
    status: "invalid",
    elapsedMs: Date.now() - started,
    totalGames: 0,
    error,
  };
}

