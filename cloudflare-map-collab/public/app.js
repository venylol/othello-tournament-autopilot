const state = {
  tableId: "",
  token: "",
  mode: "view",
  revision: 0,
  title: "",
  mapping: null,
  links: null,
  dirty: false,
  validating: false,
  saving: false,
  saveTimer: 0,
  saveError: "",
  remoteRowsSignature: "",
  relayPanelOpen: false,
};

const $ = (id) => document.getElementById(id);

function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeKey(value) {
  return normalizeWhitespace(value).toLowerCase();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function isDeleted(row) {
  return Boolean(row && row.deleted);
}

function hasRequiredFields(row) {
  return Boolean(
    row &&
      normalizeWhitespace(row.ftdName) &&
      normalizeWhitespace(row.account) &&
      normalizeWhitespace(row.groupNick),
  );
}

function oqCheckMatches(row) {
  if (!row || !row.oqCheck || typeof row.oqCheck !== "object") return false;
  const checked = normalizeWhitespace(row.oqCheck.account || row.oqCheckAccount || "");
  if (!checked) return true;
  return normalizeKey(checked) === normalizeKey(row.account);
}

function isInvalid(row) {
  if (!row || isDeleted(row)) return false;
  const oqCheck = row.oqCheck && typeof row.oqCheck === "object" ? row.oqCheck : null;
  return hasRequiredFields(row) && Boolean(oqCheck && oqCheckMatches(row) && oqCheck.status === "invalid");
}

function oqCheckPasses(row) {
  const oqCheck = row && row.oqCheck && typeof row.oqCheck === "object" ? row.oqCheck : null;
  return Boolean(oqCheck && oqCheckMatches(row) && (oqCheck.status === "ok" || oqCheck.status === "forced-ok"));
}

function isForced(row) {
  const oqCheck = row && row.oqCheck && typeof row.oqCheck === "object" ? row.oqCheck : null;
  return Boolean(hasRequiredFields(row) && oqCheck && oqCheckMatches(row) && oqCheck.status === "forced-ok");
}

function isComplete(row) {
  return Boolean(
    row &&
      !isDeleted(row) &&
      !isInvalid(row) &&
      normalizeWhitespace(row.ftdName) &&
      normalizeWhitespace(row.account) &&
      normalizeWhitespace(row.groupNick) &&
      row.oqCheck &&
      oqCheckPasses(row),
  );
}

function isUnresolved(row) {
  if (!row || isDeleted(row) || isInvalid(row)) return false;
  const oqCheck = row.oqCheck && typeof row.oqCheck === "object" ? row.oqCheck : null;
  return (
    !normalizeWhitespace(row.ftdName) ||
    !normalizeWhitespace(row.account) ||
    !normalizeWhitespace(row.groupNick) ||
    !oqCheckPasses(row)
  );
}

function sortGroup(row) {
  if (isDeleted(row)) return 4;
  if (isInvalid(row)) return 1;
  if (isForced(row)) return 2;
  if (isUnresolved(row)) return 0;
  return 3;
}

function compareRows(a, b) {
  const groupDiff = sortGroup(a.row || a) - sortGroup(b.row || b);
  if (groupDiff) return groupDiff;
  const orderDiff = Number(a.index ?? a.order) - Number(b.index ?? b.order);
  if (Number.isFinite(orderDiff) && orderDiff !== 0) return orderDiff;
  return normalizeKey((a.row || a).ftdName).localeCompare(normalizeKey((b.row || b).ftdName), "zh-Hans-CN");
}

function rebuildStats(mapping, mappedAt = new Date().toISOString()) {
  const rows = Array.isArray(mapping?.players) ? mapping.players : [];
  const accountIndex = {};
  rows.forEach((row) => {
    delete row.status;
    const key = normalizeKey(row.ftdName);
    if (!key || isDeleted(row)) return;
    const account = normalizeWhitespace(row.account);
    const groupNick = normalizeWhitespace(row.groupNick);
    if (!account) return;
    if (row.oqCheck && !oqCheckMatches(row)) {
      row.oqCheck = null;
      row.reason = "OQ account changed; validation required";
    }
    if (!groupNick || !oqCheckPasses(row)) return;
    accountIndex[key] = {
      ftdName: row.ftdName,
      displayName: row.ftdName,
      account,
      groupNick,
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

function remoteRowsSignature(mapping) {
  const rows = Array.isArray(mapping?.players) ? mapping.players : [];
  return JSON.stringify(rows.map((row) => ({
    ftdName: normalizeWhitespace(row.ftdName),
    ftdId: row.ftdId == null ? "" : row.ftdId,
    account: normalizeWhitespace(row.account),
    groupNick: normalizeWhitespace(row.groupNick),
    reason: normalizeWhitespace(row.reason),
    pendingText: normalizeWhitespace(row.pendingText),
    source: normalizeWhitespace(row.source),
    deleted: Boolean(row.deleted),
    oqCheck: row.oqCheck && typeof row.oqCheck === "object"
      ? {
          account: normalizeWhitespace(row.oqCheck.account),
          status: normalizeWhitespace(row.oqCheck.status),
          checkedAt: String(row.oqCheck.checkedAt || ""),
          mode: normalizeWhitespace(row.oqCheck.mode),
          primaryMode: normalizeWhitespace(row.oqCheck.primaryMode),
          fallbackUsed: row.oqCheck.fallbackUsed === true,
          elapsedMs: Number(row.oqCheck.elapsedMs) || 0,
          totalGames: Number(row.oqCheck.totalGames) || 0,
          windowGames: Number(row.oqCheck.windowGames) || 0,
          error: normalizeWhitespace(row.oqCheck.error),
        }
      : null,
    editAudit: row.editAudit && typeof row.editAudit === "object"
      ? {
          by: normalizeWhitespace(row.editAudit.by),
          action: normalizeWhitespace(row.editAudit.action),
          at: String(row.editAudit.at || ""),
        }
      : null,
  })));
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
  if (!groupNicks.length) return null;
  groupNicks.sort((a, b) => a.localeCompare(b, "zh-Hans"));
  return {
    version: 1,
    groupName: normalizeWhitespace(obj.groupName || obj.group_name || ""),
    refreshedAt: String(obj.refreshedAt || obj.refreshed_at || ""),
    updatedAt: Number.isFinite(Number(obj.updatedAt)) ? Number(obj.updatedAt) : Date.now(),
    groupNicks,
  };
}

function groupNickListKey(groupNicks) {
  return JSON.stringify((Array.isArray(groupNicks) ? groupNicks : [])
    .map(normalizeWhitespace)
    .filter(Boolean)
    .map(normalizeKey)
    .sort());
}

function applyLatestGroupNickPool(rawPool) {
  const pool = sanitizeWechatGroupNicks(rawPool);
  if (!pool) return false;
  const currentKey = groupNickListKey(state.mapping?.wechatGroupNicks?.groupNicks);
  const nextKey = groupNickListKey(pool.groupNicks);
  if (currentKey === nextKey) return false;
  state.mapping = {
    ...(state.mapping || {}),
    wechatGroupNicks: pool,
  };
  return true;
}

function pruneMissingGroupNicksFromMapping(editedAt = new Date().toISOString()) {
  const valid = new Set(groupNickCandidates().map(normalizeKey).filter(Boolean));
  if (!valid.size || !state.mapping || !Array.isArray(state.mapping.players)) return [];
  const removedNames = [];
  const players = state.mapping.players.map((row) => {
    const nick = normalizeWhitespace(row.groupNick);
    if (!nick || valid.has(normalizeKey(nick)) || isDeleted(row)) return row;
    removedNames.push(normalizeWhitespace(row.ftdName || "未命名"));
    return {
      ...row,
      groupNick: "",
      reason: "群昵称有变动，需要重新登记",
      pendingText: `群昵称：；FTD姓名：${normalizeWhitespace(row.ftdName || "")}`,
      source: "agent",
      editAudit: { by: "agent", action: "群昵称有变动", at: editedAt },
    };
  });
  if (!removedNames.length) return [];
  state.mapping = rebuildStats({
    ...state.mapping,
    players,
  }, editedAt);
  state.dirty = true;
  return removedNames;
}

function groupNickChangedNotice(names) {
  const list = (Array.isArray(names) ? names : []).map(normalizeWhitespace).filter(Boolean);
  if (!list.length) return "";
  return `${list.join("，")}，群昵称有变动，需要重新登记。`;
}

function tokenFromLocation() {
  const params = new URLSearchParams(location.search);
  return params.get("token") || "";
}

function tableIdFromLocation() {
  const match = location.pathname.match(/^\/m\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

function setNotice(text, isError = false) {
  const el = $("notice");
  el.hidden = !text;
  el.textContent = text || "";
  el.classList.toggle("notice--error", Boolean(isError));
}

let viewportToastTimer = 0;

function showViewportToast(text) {
  let el = $("viewport-toast");
  if (!el) {
    el = document.createElement("section");
    el.id = "viewport-toast";
    el.className = "viewport-toast";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
  }
  const vv = window.visualViewport;
  const left =
    vv && Number.isFinite(Number(vv.offsetLeft))
      ? Number(vv.offsetLeft) + Number(vv.width || 0) / 2
      : window.innerWidth / 2;
  const top =
    vv && Number.isFinite(Number(vv.offsetTop))
      ? Number(vv.offsetTop) + Number(vv.height || 0) * 0.38
      : window.innerHeight * 0.38;
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  el.textContent = text || "";
  el.hidden = !text;
  window.clearTimeout(viewportToastTimer);
  viewportToastTimer = window.setTimeout(() => {
    el.hidden = true;
  }, 3000);
}

function isRevisionConflict(error) {
  const message = String(error && error.message ? error.message : error || "");
  return message.includes("revision conflict") || /remote=\d+;\s*incoming=\d+/.test(message);
}

function tableApiPath() {
  return `/api/tables/${encodeURIComponent(state.tableId)}?token=${encodeURIComponent(state.token)}`;
}

async function reloadLatestState() {
  const data = await api(tableApiPath());
  state.mode = data.mode;
  state.revision = data.revision;
  state.title = data.title;
  state.mapping = data.mapping;
  state.links = data.links || null;
  state.dirty = false;
  state.saveError = "";
  state.remoteRowsSignature = remoteRowsSignature(data.mapping);
  render();
  return data;
}

function playDoneTone() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.08, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);
    [660, 880].forEach((frequency, index) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(frequency, now + index * 0.12);
      osc.connect(gain);
      osc.start(now + index * 0.12);
      osc.stop(now + index * 0.12 + 0.16);
    });
    window.setTimeout(() => ctx.close().catch(() => {}), 520);
  } catch (_) {
    // Audio is a convenience cue; ignore browser autoplay or device failures.
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const json = await response.json().catch(() => null);
  if (!response.ok || !json || json.ok !== true) {
    throw new Error((json && (json.detail || json.error)) || `HTTP ${response.status}`);
  }
  return json;
}

async function load() {
  state.tableId = tableIdFromLocation();
  state.token = tokenFromLocation();
  if (!state.tableId || !state.token) {
    setNotice("链接缺少表 ID 或 token。", true);
    return;
  }
  await reloadLatestState();
}

function rowClass(row) {
  if (isDeleted(row)) return "deleted";
  if (isInvalid(row)) return "invalid-account";
  if (isForced(row)) return "forced";
  if (isUnresolved(row)) return "unresolved";
  return "matched";
}

function oqStatusInfo(row) {
  const account = normalizeWhitespace(row.account);
  const check = row.oqCheck && oqCheckMatches(row) ? row.oqCheck : null;
  if (normalizeWhitespace(row?.reason).includes("群昵称有变动")) {
    return { text: "群昵称变动", detail: "", cls: "nick-changed" };
  }
  if (!account) return { text: "未填账号", detail: "", cls: "unknown" };
  if (!check || !check.status) return { text: "未检验", detail: "", cls: "unknown" };
  if (check.status === "ok") {
    const mode = normalizeWhitespace(check.mode || "");
    return { text: "已检验", detail: `${mode ? `${mode} ` : ""}${check.totalGames || 0}局`, cls: "ok" };
  }
  if (check.status === "forced-ok") {
    return { text: "强制通过", detail: "", cls: "forced" };
  }
  return { text: "检验失败", detail: "", cls: "invalid" };
}

function normalizeOqAccountInput(value) {
  return String(value || "").replace(/\s+/g, "");
}

function normalizeAccountInputElement(input) {
  if (!input || input.dataset.oqComposing === "1") return;
  const cleaned = normalizeOqAccountInput(input.value || "");
  if (input.value !== cleaned) input.value = cleaned;
}

function invalidOqAccountChars(value) {
  const chars = [];
  const seen = new Set();
  String(value || "").replace(/\s+/g, "").split("").forEach((char) => {
    if (/^[A-Za-z0-9_]$/.test(char) || seen.has(char)) return;
    seen.add(char);
    chars.push(char);
  });
  return chars;
}

function rejectInvalidOqAccount(value) {
  const chars = invalidOqAccountChars(value);
  if (!chars.length) return false;
  setNotice(`OQ账号填写不规范，出现字符“${chars.join("”“")}”。`, true);
  return true;
}

function auditLabel(row) {
  const audit = row && row.editAudit ? row.editAudit : {};
  if (audit.by === "user" || (row && row.source === "user")) return "用户修改";
  return "agent修改";
}

function markDirty() {
  state.dirty = true;
  window.clearTimeout(state.saveTimer);
  renderSaveState();
}

function renderSaveState() {
  const el = $("save-state");
  if (!el) return;
  el.className = "collab-save-state";
  if (state.mode !== "edit") {
    el.textContent = "只读";
    return;
  }
  if (state.saving) {
    el.textContent = "保存中";
    el.classList.add("collab-save-state--saving");
    return;
  }
  if (state.saveError) {
    el.textContent = "保存失败";
    el.title = state.saveError;
    el.classList.add("collab-save-state--error");
    return;
  }
  el.title = "";
  if (state.dirty) {
    el.textContent = "未保存";
    el.classList.add("collab-save-state--dirty");
    return;
  }
  el.textContent = "已保存";
  el.classList.add("collab-save-state--saved");
}

function scheduleAutoSave() {
  window.clearTimeout(state.saveTimer);
}

function updateRow(index, patch) {
  if (state.mode !== "edit" || state.saving || state.validating) return;
  const row = state.mapping.players[index];
  if (!row) return;
  delete patch.status;
  if (Object.prototype.hasOwnProperty.call(patch, "account")) {
    patch.account = normalizeOqAccountInput(patch.account);
    if (rejectInvalidOqAccount(patch.account)) {
      renderRows();
      return;
    }
  }
  const editedAt = new Date().toISOString();
  Object.assign(row, patch, {
    source: "user",
    editAudit: { by: "user", action: patch.__action || "云端编辑", at: editedAt },
  });
  delete row.__action;
  if (Object.prototype.hasOwnProperty.call(patch, "account")) {
    row.oqCheck = null;
    row.reason = row.account ? "OQ account needs validation" : "user cleared account";
  }
  row.pendingText = row.account && row.groupNick ? "" : `群昵称：${row.groupNick || ""}；FTD姓名：${row.ftdName || ""}`;
  state.mapping = rebuildStats(state.mapping, editedAt);
  markDirty();
  renderRows();
  renderStats();
}

async function forceOqValidation(index, name) {
  if (state.mode !== "edit" || state.saving || state.validating) return;
  const row = state.mapping.players[index];
  if (!row || !isInvalid(row)) return;
  if (rejectInvalidOqAccount(normalizeOqAccountInput(row.account))) {
    renderRows();
    return;
  }
  state.saving = true;
  setNotice("正在强制通过校验，请勿操作。");
  render();
  try {
    const result = await api(`/api/tables/${encodeURIComponent(state.tableId)}/force-oq?token=${encodeURIComponent(state.token)}`, {
      method: "POST",
      body: JSON.stringify({
        revision: state.revision,
        index,
        ftdName: name || row.ftdName || "",
      }),
    });
    state.revision = result.revision;
    state.mapping = result.mapping;
    state.dirty = false;
    state.saveError = "";
    state.remoteRowsSignature = remoteRowsSignature(result.mapping);
    setNotice("已强制通过 OQ 校验。");
    render();
  } catch (error) {
    setNotice(isRevisionConflict(error) ? "远端版本已更新。为避免覆盖他人改动，请刷新页面后再操作。" : `强制通过失败：${error.message || error}`, true);
  } finally {
    state.saving = false;
    render();
  }
}

function findRowIndexByName(name) {
  const key = normalizeKey(name);
  const rows = Array.isArray(state.mapping?.players) ? state.mapping.players : [];
  return rows.findIndex((row) => normalizeKey(row.ftdName) === key);
}

function updateRowByName(name, patch) {
  const index = findRowIndexByName(name);
  if (index < 0) return;
  updateRow(index, patch);
}

function setRowDeletedByName(name, deleted) {
  const index = findRowIndexByName(name);
  if (index < 0) return;
  updateRow(index, {
    deleted: Boolean(deleted),
    __action: deleted ? "删除映射" : "恢复映射",
  });
}

function render() {
  $("title").textContent = state.title || "FTD/OQ 映射表";
  $("subtitle").textContent = `revision ${state.revision} · ${state.mapping?.groupName || state.mapping?.group || ""}`;
  $("mode-chip").textContent = state.mode === "edit" ? "编辑链接" : "查看模式";
  const locked = state.saving || state.validating;
  $("validate").disabled = state.mode !== "edit" || locked;
  $("validate").textContent = state.saving ? "保存中" : state.validating ? "检验中" : "保存并校验OQ账号";
  $("download").disabled = locked;
  $("export-png").disabled = locked;
  $("toggle-relay").disabled = locked || !state.mapping?.registrationRelay;
  $("toggle-relay").textContent = state.relayPanelOpen ? "隐藏报名接龙" : "查看报名接龙";
  renderSaveState();
  renderRelayPanel();
  renderStats();
  renderRows();
}

function groupNickCandidates() {
  const fromMapping = state.mapping?.wechatGroupNicks?.groupNicks;
  if (Array.isArray(fromMapping)) return fromMapping.map(normalizeWhitespace).filter(Boolean);
  return [];
}

function nickMatchRank(query, rowKey, nickKey) {
  if (!nickKey) return 10000;
  const q = normalizeKey(query);
  if (q) {
    if (nickKey === q) return 0;
    if (nickKey.startsWith(q)) return 1;
    const qAt = nickKey.indexOf(q);
    if (qAt >= 0) return 10 + qAt;
    return 10000;
  }
  if (rowKey) {
    if (nickKey === rowKey) return 0;
    if (nickKey.startsWith(rowKey)) return 1;
    const rowAt = nickKey.indexOf(rowKey);
    if (rowAt >= 0) return 20 + rowAt;
  }
  return 500;
}

function refreshNickOptions(input) {
  if (!input) return;
  const box = input.closest(".score-ftd-map__nick-options");
  const details = input.closest(".score-ftd-map__nick");
  const rowEl = input.closest("[data-ftd-map-row]");
  if (!box) return;
  if (details) details.open = true;
  const q = normalizeKey(input.value || "");
  const rowKey = normalizeKey(rowEl && rowEl.dataset.ftdMapName);
  const buttons = Array.from(box.querySelectorAll(".score-ftd-map__nick-option[data-nick-key]"));
  const ranked = buttons
    .map((btn, order) => ({
      btn,
      order,
      rank: nickMatchRank(q, rowKey, String(btn.dataset.nickKey || "")),
    }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order);
  let shown = 0;
  const clearButton = box.querySelector(".score-ftd-map__nick-option--clear");
  ranked.forEach(({ btn, rank }) => {
    const show = rank < 10000 && shown < 48;
    btn.hidden = !show;
    if (show) shown += 1;
    if (clearButton) {
      box.insertBefore(btn, clearButton);
    } else {
      box.appendChild(btn);
    }
  });
  const empty = box.querySelector("[data-ftd-map-nick-no-match]");
  if (empty) empty.hidden = shown > 0;
}

function renderStats() {
  const m = state.mapping || {};
  const relayCount = Array.isArray(m.registrationRelay?.entries) ? m.registrationRelay.entries.length : 0;
  $("stats").textContent = relayCount ? `${m.matchedCount || 0}/${m.playerCount || 0} · 接龙 ${relayCount}` : `${m.matchedCount || 0}/${m.playerCount || 0}`;
}

function renderRelayPanel() {
  const panel = $("relay-panel");
  if (!panel) return;
  const relay = state.mapping?.registrationRelay;
  if (!state.relayPanelOpen || !relay) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  const entries = Array.isArray(relay.entries) ? relay.entries : [];
  const ignored = Array.isArray(relay.ignored) ? relay.ignored : [];
  const detectedMonths = Array.isArray(relay.detectedMonths) && relay.detectedMonths.length
    ? relay.detectedMonths.join(", ")
    : "未识别";
  const meta = [
    relay.competitionName ? `比赛：${relay.competitionName}` : "",
    `当前月：${relay.currentMonth || "-"}`,
    `接龙月：${detectedMonths}`,
    `月份匹配：${relay.monthMatched ? "是" : "否"}`,
    `解析：${entries.length}`,
    `未解析：${ignored.length}`,
  ].filter(Boolean);
  const rows = entries.map((entry) => `
    <tr>
      <td>${escapeHtml(entry.index || "")}</td>
      <td>${escapeHtml(entry.name || "")}</td>
      <td>${escapeHtml(entry.account || "")}</td>
      <td>${escapeHtml(entry.rawLine || "")}</td>
    </tr>`).join("");
  const ignoredRows = ignored.length
    ? `<details class="relay-panel__ignored">
        <summary>未自动解析行 ${escapeHtml(ignored.length)}</summary>
        <div class="relay-panel__ignored-list">
          ${ignored.map((item) => `<div>${escapeHtml(item.index || "")}. ${escapeHtml(item.line || "")}${item.reason ? ` <span>${escapeHtml(item.reason)}</span>` : ""}</div>`).join("")}
        </div>
      </details>`
    : "";
  const rawText = normalizeWhitespace(relay.rawText || "")
    ? `<details class="relay-panel__raw">
        <summary>原始接龙文本</summary>
        <pre>${escapeHtml(relay.rawText || "")}</pre>
      </details>`
    : "";
  panel.hidden = false;
  panel.innerHTML = `
    <div class="relay-panel__head">
      <div>
        <h2>报名接龙</h2>
        <p>${escapeHtml(meta.join(" · "))}</p>
      </div>
      <button class="score-card__btn" id="relay-panel-close" type="button">关闭</button>
    </div>
    <div class="relay-panel__table-wrap">
      <table class="relay-panel__table">
        <thead><tr><th>#</th><th>姓名</th><th>OQ账号</th><th>原行</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="4">没有可显示的接龙账号记录。</td></tr>`}</tbody>
      </table>
    </div>
    ${ignoredRows}
    ${rawText}
  `;
  const close = $("relay-panel-close");
  if (close) {
    close.addEventListener("click", () => {
      state.relayPanelOpen = false;
      render();
    }, { once: true });
  }
}

function updateSearchClearButton() {
  const btn = $("clear-search");
  const input = $("search");
  if (!btn || !input) return;
  btn.hidden = !input.value;
}

function renderRows() {
  const term = normalizeKey($("search").value);
  updateSearchClearButton();
  const rows = Array.isArray(state.mapping?.players) ? state.mapping.players : [];
  const nickCandidateCount = groupNickCandidates().length;
  const visible = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => {
      if (!term) return true;
      return [row.ftdName, row.account, row.groupNick, row.reason, row.pendingText]
        .map(normalizeKey)
        .join(" ")
        .includes(term);
    })
    .sort(compareRows);
  const mappedAt = state.mapping?.mappedAt
    ? String(state.mapping.mappedAt).replace("T", " ").replace(/\+\d\d:\d\d$/, "")
    : "未知时间";
  const searchMeta = term
    ? `<div class="score-ftd-map__search-meta">显示 ${escapeHtml(visible.length)}/${escapeHtml(rows.length)}</div>`
    : "";
  const body = visible.map(({ row, index }) => {
    const locked = state.saving || state.validating;
    const readonly = state.mode !== "edit" || locked ? "readonly" : "";
    const disabled = state.mode !== "edit" || locked ? "disabled" : "";
    const deleted = isDeleted(row);
    const statusClass = rowClass(row);
    const oq = oqStatusInfo(row);
    const audit = auditLabel(row);
    const auditClass = audit === "用户修改" ? "user" : "agent";
    const canForceOq = isInvalid(row);
    const showForceOq = !deleted && state.mode === "edit" && (canForceOq || isForced(row));
    const forceOqDisabled = locked || !canForceOq;
    const rowKey = normalizeKey(row.ftdName);
    const nickOptions = groupNickCandidates()
      .filter((nick) => {
        const nickKey = normalizeKey(nick);
        return rowKey && nickKey.includes(rowKey);
      })
      .slice(0, 24);
    const defaultNickSet = new Set(nickOptions.length ? nickOptions : groupNickCandidates().slice(0, 24));
    return `
      <div class="score-ftd-map__row score-ftd-map__row--${escapeHtml(statusClass)}" data-index="${index}" data-ftd-map-row="1" data-ftd-map-name="${escapeHtml(row.ftdName)}">
        <div class="score-ftd-map__name-block">
          <div class="score-ftd-map__caption">姓名</div>
          <div class="score-ftd-map__name">${escapeHtml(row.ftdName || "未命名")}</div>
        </div>
        <label class="score-ftd-map__field">
          <span>OQ 账号</span>
          <input class="score-ftd-map__account" data-field="account" type="text" inputmode="email" lang="en" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" pattern="[A-Za-z0-9_]*" value="${escapeHtml(row.account || "")}" ${readonly} ${deleted || locked ? "disabled" : ""}>
        </label>
        <details class="score-ftd-map__nick">
          <summary>
            <span>群昵称</span>
            <strong>${escapeHtml(row.groupNick || "未选择")}</strong>
          </summary>
          <div class="score-ftd-map__nick-options">
            ${
              nickCandidateCount
                ? `<input class="score-ftd-map__nick-search" type="search" placeholder="搜索群昵称..." autocomplete="off" data-ftd-map-nick-search="1" ${deleted || locked ? "disabled" : ""}>` +
                  `<div class="score-ftd-map__nick-hint">输入只用于筛选，选择下方候选后才会写入。</div>` +
                  `<div class="score-ftd-map__nick-empty" data-ftd-map-nick-no-match hidden>没有匹配的群昵称。</div>` +
                  groupNickCandidates()
                    .map((nick) => `<button class="score-ftd-map__nick-option" type="button" data-ftd-map-action="set-nick" data-index="${index}" data-ftd-map-name="${escapeHtml(row.ftdName)}" data-group-nick="${escapeHtml(nick)}" data-nick-key="${escapeHtml(normalizeKey(nick))}" ${defaultNickSet.has(nick) ? "" : "hidden"} ${deleted || state.mode !== "edit" || locked ? "disabled" : ""}>${escapeHtml(nick)}</button>`)
                    .join("")
                : `<div class="score-ftd-map__nick-empty">当前没有群昵称候选。</div>`
            }
            ${
              row.groupNick && state.mode === "edit" && !deleted && !locked
                ? `<button class="score-ftd-map__nick-option score-ftd-map__nick-option--clear" type="button" data-ftd-map-action="clear-nick" data-index="${index}" data-ftd-map-name="${escapeHtml(row.ftdName)}">清除选择</button>`
                : ""
            }
          </div>
        </details>
        <span class="score-ftd-map__audit score-ftd-map__audit--${escapeHtml(auditClass)}">${escapeHtml(audit)}</span>
        <div class="score-ftd-map__oq-status score-ftd-map__oq-status--${escapeHtml(oq.cls)}">
          ${escapeHtml(oq.text)}
          ${oq.detail ? `<small>${escapeHtml(oq.detail)}</small>` : ""}
        </div>
        <div class="score-ftd-map__actions">
          ${deleted && state.mode === "edit" && !locked ? `<button class="score-card__btn" type="button" data-ftd-map-action="restore" data-index="${index}" data-ftd-map-name="${escapeHtml(row.ftdName)}">恢复</button>` : ""}
          ${showForceOq ? `<button class="score-card__btn score-card__btn--primary score-card__btn--force-oq ${forceOqDisabled ? "score-card__btn--muted" : ""}" type="button" data-ftd-map-action="force-oq" data-index="${index}" data-ftd-map-name="${escapeHtml(row.ftdName)}" ${forceOqDisabled ? "disabled" : ""}>强制通过校验</button>` : ""}
        </div>
      </div>`;
  }).join("");
  $("mapping").innerHTML =
    `<div class="score-ftd-map__summary score-ftd-map__summary--static">
      <div>
        <span class="score-ftd-map__title">FTD Player/OQ 映射表</span>
        <span class="score-ftd-map__hint">白色未完成；黄色为OQ账号校验不通过；绿色需姓名、OQ账号、群昵称齐全且OQ有效。</span>
      </div>
      <span class="score-ftd-map__meta">${escapeHtml(state.mapping?.matchedCount || 0)}/${escapeHtml(state.mapping?.playerCount || 0)} · ${escapeHtml(mappedAt)}</span>
    </div>` +
    searchMeta +
    `<div class="score-ftd-map__body">${body || `<div class="score-ftd-map__empty">没有匹配的映射记录。</div>`}</div>`;
}

async function saveForValidation() {
  if (state.mode !== "edit") return null;
  state.saving = true;
  state.saveError = "";
  setNotice("正在保存中，请勿操作。");
  renderSaveState();
  try {
    const result = await api(tableApiPath(), {
      method: "PUT",
      body: JSON.stringify({
        revision: state.revision,
        title: state.title,
        mapping: rebuildStats(state.mapping),
        action: "save-before-oq-validation",
      }),
    });
    state.revision = result.revision;
    state.mapping = result.mapping;
    state.dirty = false;
    state.saveError = "";
    state.remoteRowsSignature = remoteRowsSignature(result.mapping);
    render();
    return result;
  } catch (error) {
    if (isRevisionConflict(error)) {
      setNotice("远端版本已更新。为避免覆盖他人改动，请刷新页面后再校验。", true);
      throw error;
    }
    state.saveError = error.message || String(error);
    throw error;
  } finally {
    state.saving = false;
    renderSaveState();
  }
}

async function loadLatestGroupNicksBeforeValidation() {
  const latest = await api(tableApiPath());
  if (latest.revision !== state.revision) {
    const knownSignature = state.remoteRowsSignature || remoteRowsSignature(state.mapping);
    const latestSignature = remoteRowsSignature(latest.mapping);
    if (knownSignature && latestSignature !== knownSignature) {
      throw new Error("远端映射行已更新。为避免覆盖他人改动，请刷新页面后再校验。");
    }
    state.revision = latest.revision;
    state.title = latest.title || state.title;
    state.mode = latest.mode || state.mode;
    state.links = latest.links || state.links || null;
    state.remoteRowsSignature = latestSignature;
  }
  const loadedNicks = applyLatestGroupNickPool(latest.mapping?.wechatGroupNicks);
  const hasNickPool = Array.isArray(state.mapping?.wechatGroupNicks?.groupNicks) && state.mapping.wechatGroupNicks.groupNicks.length > 0;
  const removedNames = hasNickPool ? pruneMissingGroupNicksFromMapping(new Date().toISOString()) : [];
  if (loadedNicks || removedNames.length) {
    state.mapping = rebuildStats(state.mapping);
    render();
  }
  return { loadedNicks, removedNames };
}

async function validateOq() {
  if (state.mode !== "edit") return;
  if (state.validating || state.saving) return;
  state.validating = true;
  state.saving = true;
  setNotice("正在保存中，请勿操作。");
  render();
  try {
    const nickRefresh = await loadLatestGroupNicksBeforeValidation();
    const nickNotice = groupNickChangedNotice(nickRefresh.removedNames);
    if (nickNotice) setNotice(nickNotice);
    await saveForValidation();
    state.saving = false;
    setNotice(nickNotice ? `${nickNotice} 正在校验 OQ 账号，请勿操作。` : "映射表已保存，正在校验 OQ 账号，请勿操作。");
    render();
    const result = await api(`/api/tables/${encodeURIComponent(state.tableId)}/validate-oq?token=${encodeURIComponent(state.token)}`, {
      method: "POST",
      body: JSON.stringify({ revision: state.revision, mode: "5min" }),
    });
    state.revision = result.revision;
    state.mapping = result.mapping;
    state.dirty = false;
    state.saveError = "";
    state.remoteRowsSignature = remoteRowsSignature(result.mapping);
    setNotice(`${nickNotice ? `${nickNotice} ` : ""}已保存并完成 OQ 校验：本次 ${result.oqValidation.checkedCount}，有效 ${result.oqValidation.okCount}，异常 ${result.oqValidation.invalidCount}，跳过 ${result.oqValidation.skippedCount || 0}；当前异常 ${result.mapping?.invalidAccountCount || 0}`);
    playDoneTone();
    render();
  } catch (error) {
    setNotice(isRevisionConflict(error) ? "远端版本已更新。为避免覆盖他人改动，请刷新页面后再校验。" : `保存或 OQ 校验失败：${error.message || error}`, true);
  } finally {
    state.saving = false;
    state.validating = false;
    render();
  }
}

function downloadJson() {
  const blob = new Blob([JSON.stringify(state.mapping, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${state.tableId}-ftd-player-account-mapping.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function isIOS() {
  return /iPad|iPhone|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isLikelyMobileDevice() {
  return isIOS() || /Android|Mobile|Tablet/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1;
}

function isLikelyInAppBrowser() {
  return /MicroMessenger|Line\/|FBAN|FBAV|Instagram|Weibo|QQ\//i.test(navigator.userAgent);
}

function canDirectDownloadInCurrentBrowser() {
  return "download" in document.createElement("a") && !isIOS() && !(isLikelyInAppBrowser() && isLikelyMobileDevice());
}

function shouldOpenPNGPreviewWindow() {
  return !canDirectDownloadInCurrentBrowser();
}

function openPNGPreviewWindow() {
  const win = window.open("", "_blank");
  if (!win) return null;
  win.document.write(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>映射表 PNG</title>
  <style>
    body{margin:0;background:#111;color:#f4f4f4;font:14px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .bar{position:sticky;top:0;z-index:2;display:flex;gap:10px;align-items:center;padding:10px;background:#1b1f1d;border-bottom:1px solid #3b4640}
    .btn{display:inline-flex;align-items:center;min-height:34px;padding:7px 12px;border:1px solid #4d5a53;border-radius:8px;background:#26302c;color:#f4f4f4;text-decoration:none;font-weight:800}
    .hint{color:#bac4bd}
    .wrap{padding:12px;overflow:auto}
    img{max-width:100%;height:auto;background:#fff}
  </style>
</head>
<body>
  <div class="bar">
    <button class="btn" id="png-back" type="button">返回</button>
    <a class="btn" id="png-download" href="#" download="映射表.png">下载 PNG</a>
    <span class="hint" id="png-hint">正在生成图片...</span>
  </div>
  <div class="wrap"><img id="png-preview" alt="映射表图片"></div>
</body>
</html>`);
  win.document.close();
  const back = win.document.getElementById("png-back");
  if (back) back.addEventListener("click", () => win.close());
  return win;
}

function renderPNGPreviewWindow(win, imageUrl, filename) {
  if (!win || win.closed) return false;
  const doc = win.document;
  const img = doc.getElementById("png-preview");
  const link = doc.getElementById("png-download");
  const hint = doc.getElementById("png-hint");
  if (!img || !link) return false;
  img.src = imageUrl;
  link.href = imageUrl;
  link.download = filename;
  if (hint) hint.textContent = "图片已生成。可点击下载，或长按/右键保存。";
  return true;
}

function triggerAnchorDownload(url, filename) {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  window.setTimeout(() => link.remove(), 0);
}

function canvasToBlob(canvas) {
  return new Promise((resolve) => {
    if (!canvas || typeof canvas.toBlob !== "function") {
      resolve(null);
      return;
    }
    canvas.toBlob((blob) => resolve(blob || null), "image/png");
  });
}

function fitTextToWidth(ctx, text, maxWidth) {
  const raw = String(text ?? "");
  if (!raw) return "";
  if (ctx.measureText(raw).width <= maxWidth) return raw;
  let out = raw;
  while (out.length > 1 && ctx.measureText(`${out}...`).width > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}...`;
}

function drawRoundRectPath(ctx, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(Number(radius) || 0, width / 2, height / 2));
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, width, height, r);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
}

function fillRoundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  drawRoundRectPath(ctx, x, y, width, height, radius);
  ctx.fill();
}

function strokeRoundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  drawRoundRectPath(ctx, x, y, width, height, radius);
  ctx.stroke();
}

function makeSafeFilename(value) {
  return normalizeWhitespace(value || "映射表").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80) || "映射表";
}

function exportRowsForPng() {
  const rows = Array.isArray(state.mapping?.players) ? state.mapping.players : [];
  return rows
    .map((row, index) => ({ row, index }))
    .sort(compareRows)
    .map(({ row }) => row);
}

function drawPill(ctx, text, x, y, style) {
  const fontFamily = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';
  ctx.font = `700 ${style.fontSize || 20}px ${fontFamily}`;
  const width = Math.ceil(ctx.measureText(text).width) + 30;
  const height = style.height || 34;
  ctx.fillStyle = style.bg;
  fillRoundRect(ctx, x, y - height / 2, width, height, height / 2);
  ctx.strokeStyle = style.border;
  ctx.lineWidth = 1;
  strokeRoundRect(ctx, x + 0.5, y - height / 2 + 0.5, width - 1, height - 1, height / 2);
  ctx.fillStyle = style.fg;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + 15, y);
  return width;
}

function buildMappingPngCanvas(rows, options = {}) {
  const safeIOS = Boolean(options.safeIOS);
  const exportRows = Array.isArray(rows) ? rows : [];
  const title = state.title || "FTD/OQ 映射表";
  const complete = exportRows.filter(isComplete).length;
  const width = safeIOS ? 860 : 960;
  const marginX = safeIOS ? 24 : 30;
  const marginY = safeIOS ? 24 : 30;
  const titleH = safeIOS ? 54 : 62;
  const statsH = safeIOS ? 36 : 40;
  const headerH = safeIOS ? 56 : 62;
  const rowH = safeIOS ? 64 : 70;
  const noteH = safeIOS ? 64 : 42;
  const bottomPad = safeIOS ? 24 : 30;
  const maxCanvasHeight = safeIOS ? 3600 : 32760;
  const tableY = marginY + titleH + statsH + 14;
  const maxRows = Math.max(1, Math.floor((maxCanvasHeight - tableY - headerH - noteH - bottomPad) / rowH));
  const visibleRows = exportRows.slice(0, maxRows);
  const truncated = visibleRows.length < exportRows.length;
  const height = tableY + headerH + visibleRows.length * rowH + (truncated ? noteH : 0) + bottomPad;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = Math.max(height, 240);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法获取 Canvas 2D 上下文");
  const fontFamily = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';

  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillStyle = "#1F2937";
  ctx.font = `700 ${safeIOS ? 36 : 40}px ${fontFamily}`;
  ctx.fillText(title, width / 2, marginY + 26);
  ctx.textAlign = "left";
  ctx.fillStyle = "#4B5563";
  ctx.font = `500 ${safeIOS ? 22 : 24}px ${fontFamily}`;
  ctx.fillText(`已完成：${complete}/${exportRows.length}`, marginX, marginY + titleH);

  const tableX = marginX;
  const tableW = width - marginX * 2;
  const colIndexW = safeIOS ? 54 : 60;
  const colStatusW = safeIOS ? 138 : 150;
  const colAccountW = safeIOS ? 270 : 310;
  const colNameW = tableW - colIndexW - colAccountW - colStatusW;

  ctx.fillStyle = "#F3F4F6";
  ctx.fillRect(tableX, tableY, tableW, headerH);
  ctx.fillStyle = "#111827";
  ctx.font = `700 ${safeIOS ? 23 : 25}px ${fontFamily}`;
  ctx.textAlign = "center";
  ctx.fillText("#", tableX + colIndexW / 2, tableY + headerH / 2);
  ctx.textAlign = "left";
  ctx.fillText("姓名", tableX + colIndexW + 12, tableY + headerH / 2);
  ctx.fillText("OQ账号", tableX + colIndexW + colNameW + 12, tableY + headerH / 2);
  ctx.fillText("标签", tableX + colIndexW + colNameW + colAccountW + 12, tableY + headerH / 2);

  const tagStyles = {
    missing: { bg: "#FEF3C7", border: "#D97706", fg: "#92400E" },
    ok: { bg: "#D1FAE5", border: "#059669", fg: "#065F46" },
    invalid: { bg: "#FEE2E2", border: "#DC2626", fg: "#991B1B" },
    forced: { bg: "#ECF7C8", border: "#84A936", fg: "#3F6212" },
    deleted: { bg: "#FEE2E2", border: "#DC2626", fg: "#991B1B" },
    pending: { bg: "#E5E7EB", border: "#9CA3AF", fg: "#374151" },
  };

  ctx.font = `600 ${safeIOS ? 23 : 25}px ${fontFamily}`;
  visibleRows.forEach((row, i) => {
    const y = tableY + headerH + i * rowH;
    ctx.fillStyle = i % 2 === 0 ? "#FFFFFF" : "#FAFAFA";
    ctx.fillRect(tableX, y, tableW, rowH);
    ctx.strokeStyle = "#E5E7EB";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(tableX, y + rowH);
    ctx.lineTo(tableX + tableW, y + rowH);
    ctx.stroke();

    ctx.fillStyle = "#111827";
    ctx.textAlign = "center";
    ctx.fillText(String(i + 1), tableX + colIndexW / 2, y + rowH / 2);
    ctx.textAlign = "left";
    ctx.fillText(fitTextToWidth(ctx, row.ftdName || "未命名", colNameW - 24), tableX + colIndexW + 12, y + rowH / 2);
    const account = normalizeWhitespace(row.account);
    ctx.fillStyle = account ? "#111827" : "#B45309";
    ctx.fillText(fitTextToWidth(ctx, account || "未填写账号", colAccountW - 24), tableX + colIndexW + colNameW + 12, y + rowH / 2);

    let tag = "未检验";
    let style = tagStyles.pending;
    if (isDeleted(row)) {
      tag = "已删除";
      style = tagStyles.deleted;
    } else if (!account) {
      tag = "未填写账号";
      style = tagStyles.missing;
    } else if (isInvalid(row)) {
      tag = "检验失败";
      style = tagStyles.invalid;
    } else if (isForced(row)) {
      tag = "强制通过";
      style = tagStyles.forced;
    } else if (isComplete(row)) {
      tag = "已检验";
      style = tagStyles.ok;
    }
    drawPill(ctx, tag, tableX + colIndexW + colNameW + colAccountW + 12, y + rowH / 2, style);
  });

  const rowsHeight = headerH + visibleRows.length * rowH;
  ctx.strokeStyle = "#D1D5DB";
  ctx.lineWidth = 1;
  ctx.strokeRect(tableX + 0.5, tableY + 0.5, tableW - 1, rowsHeight - 1);
  if (truncated) {
    ctx.textAlign = "left";
    ctx.fillStyle = "#B45309";
    ctx.font = `600 ${safeIOS ? 18 : 19}px ${fontFamily}`;
    const note = safeIOS
      ? `iOS 兼容模式：PNG 仅导出前 ${visibleRows.length} 人。`
      : `名单较长，PNG 仅导出前 ${visibleRows.length} 人。`;
    ctx.fillText(fitTextToWidth(ctx, note, tableW), tableX, tableY + rowsHeight + Math.floor(noteH / 2));
  }
  return canvas;
}

async function saveCanvasAsPNG(canvas, filename, previewWindow) {
  if (previewWindow) {
    const dataUrl = canvas.toDataURL("image/png");
    if (renderPNGPreviewWindow(previewWindow, dataUrl, filename)) return "preview";
  }
  const blob = await canvasToBlob(canvas);
  if (blob && canDirectDownloadInCurrentBrowser()) {
    const url = URL.createObjectURL(blob);
    triggerAnchorDownload(url, filename);
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    return "download";
  }
  const dataUrl = canvas.toDataURL("image/png");
  const opened = window.open(dataUrl, "_blank");
  if (!opened) triggerAnchorDownload(dataUrl, filename);
  return opened ? "open" : "download";
}

async function exportPng() {
  const rows = exportRowsForPng();
  if (!rows.length) {
    setNotice("当前没有可导出的选手。", true);
    return;
  }
  const btn = $("export-png");
  const idleLabel = "导出 PNG";
  if (btn) {
    btn.disabled = true;
    btn.textContent = isIOS() ? "打开中..." : "生成中...";
  }
  const previewWindow = shouldOpenPNGPreviewWindow() ? openPNGPreviewWindow() : null;
  try {
    const canvas = buildMappingPngCanvas(rows, { safeIOS: isIOS() });
    const filename = `${makeSafeFilename(state.tableId || state.title || "映射表")}_映射表.png`;
    const mode = await saveCanvasAsPNG(canvas, filename, previewWindow);
    setNotice(mode === "preview" || mode === "open" ? "PNG 已打开，请长按/右键保存。" : "已开始下载 PNG。");
  } catch (error) {
    setNotice(`导出 PNG 失败：${error.message || error}`, true);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = idleLabel;
    }
  }
}

async function copyLink(kind) {
  const link = state.links && state.links[kind];
  if (!link) return;
  await navigator.clipboard.writeText(link);
  setNotice("已复制编辑链接。");
}

function setupFtdPlayerMapSwipeGestures() {
  const root = $("mapping");
  if (!root) return;
  let active = null;
  let lastPinchHintAt = 0;
  const threshold = 64;
  const maxVertical = 42;
  const pinchHintText = "为防止误操作，名单区域禁用双指缩放。请在上方标题、统计或搜索区域进行页面缩放。";

  const showPinchZoomHint = () => {
    const now = Date.now();
    if (now - lastPinchHintAt < 3000) return;
    lastPinchHintAt = now;
    showViewportToast(pinchHintText);
  };

  const getRowFromEvent = (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return null;
    if (target.closest("button, input, textarea, select, a, label, details, summary, .score-ftd-map__nick")) return null;
    const row = target.closest('[data-ftd-map-row="1"]');
    if (!row || !row.dataset || !row.dataset.ftdMapName) return null;
    if (row.classList.contains("score-ftd-map__row--deleted")) return null;
    return row;
  };

  const resetRow = (row) => {
    if (!row) return;
    row.style.transform = "";
    row.style.transition = "";
  };

  const start = (row, x, y, pointerId) => {
    if (state.mode !== "edit" || state.saving || state.validating) return;
    active = {
      row,
      name: row.dataset.ftdMapName || "",
      startX: x,
      startY: y,
      lastX: x,
      lastY: y,
      pointerId,
      moved: false,
    };
  };

  const move = (x, y, pointerId) => {
    if (!active) return;
    if (active.pointerId != null && pointerId != null && active.pointerId !== pointerId) return;
    const dx = x - active.startX;
    const dy = y - active.startY;
    active.lastX = x;
    active.lastY = y;
    if (Math.abs(dy) > maxVertical && Math.abs(dy) > Math.abs(dx)) {
      resetRow(active.row);
      active = null;
      return;
    }
    if (dx < -8) {
      active.moved = true;
      active.row.style.transform = `translateX(${Math.max(-96, dx)}px)`;
      active.row.style.transition = "none";
    }
  };

  const finish = () => {
    if (!active) return;
    const row = active.row;
    const dx = active.lastX - active.startX;
    const dy = active.lastY - active.startY;
    const name = active.name;
    resetRow(row);
    if (active.moved && dx <= -threshold && Math.abs(dx) > Math.abs(dy) * 1.25) {
      setRowDeletedByName(name, true);
      setNotice("已删除映射行。");
    }
    active = null;
  };

  if ("PointerEvent" in window) {
    root.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "touch" && event.isPrimary === false) {
        active = null;
        showPinchZoomHint();
        return;
      }
      if (event.button !== undefined && event.button !== 0) return;
      const row = getRowFromEvent(event);
      if (!row) return;
      start(row, event.clientX, event.clientY, event.pointerId);
      try {
        row.setPointerCapture && row.setPointerCapture(event.pointerId);
      } catch (_) {
        // Ignore browsers that reject pointer capture for this target.
      }
    }, { passive: true });
    root.addEventListener("pointermove", (event) => {
      if (event.pointerType === "touch" && event.isPrimary === false) {
        active = null;
        showPinchZoomHint();
        return;
      }
      move(event.clientX, event.clientY, event.pointerId);
    }, { passive: true });
    root.addEventListener("pointerup", finish, { passive: true });
    root.addEventListener("pointercancel", finish, { passive: true });
    return;
  }

  root.addEventListener("touchstart", (event) => {
    if (event.touches && event.touches.length >= 2) {
      active = null;
      showPinchZoomHint();
      return;
    }
    if (!event.touches || event.touches.length !== 1) return;
    const row = getRowFromEvent(event);
    if (!row) return;
    const touch = event.touches[0];
    start(row, touch.clientX, touch.clientY, null);
  }, { passive: true });
  root.addEventListener("touchmove", (event) => {
    if (event.touches && event.touches.length >= 2) {
      if (active) resetRow(active.row);
      active = null;
      showPinchZoomHint();
      return;
    }
    if (!event.touches || event.touches.length !== 1) return;
    const touch = event.touches[0];
    move(touch.clientX, touch.clientY, null);
  }, { passive: true });
  root.addEventListener("touchend", finish, { passive: true });
  root.addEventListener("touchcancel", finish, { passive: true });
}

$("mapping").addEventListener("change", (event) => {
  if (state.saving || state.validating) return;
  const target = event.target;
  const rowEl = target.closest("[data-index]");
  const field = target.dataset.field;
  if (!rowEl || !field) return;
  if (field === "account" && target.dataset.oqComposing === "1") return;
  const index = Number(rowEl.dataset.index);
  const value = field === "account" ? normalizeOqAccountInput(target.value) : normalizeWhitespace(target.value);
  if (field === "account" && target.value !== value) target.value = value;
  const patch = { [field]: value, __action: field === "account" ? "编辑账号" : "编辑群昵称" };
  updateRow(index, patch);
});

$("mapping").addEventListener("input", (event) => {
  const target = event.target;
  if (target.matches("input.score-ftd-map__account[data-field='account']")) {
    if (event.isComposing || target.dataset.oqComposing === "1") return;
    normalizeAccountInputElement(target);
    return;
  }
  if (!target.matches("input[data-ftd-map-nick-search]")) return;
  refreshNickOptions(target);
});

$("mapping").addEventListener("compositionstart", (event) => {
  const target = event.target;
  if (!target.matches("input.score-ftd-map__account[data-field='account']")) return;
  target.dataset.oqComposing = "1";
});

$("mapping").addEventListener("compositionend", (event) => {
  const target = event.target;
  if (!target.matches("input.score-ftd-map__account[data-field='account']")) return;
  delete target.dataset.oqComposing;
  normalizeAccountInputElement(target);
});

$("mapping").addEventListener("focusin", (event) => {
  const target = event.target;
  if (!target.matches("input[data-ftd-map-nick-search]")) return;
  refreshNickOptions(target);
});

$("mapping").addEventListener("click", (event) => {
  if (state.saving || state.validating) return;
  const target = event.target;
  const summary = target.closest(".score-ftd-map__nick summary");
  if (summary) {
    event.preventDefault();
    const details = summary.parentElement;
    if (details) {
      const wasOpen = details.open;
      details.open = !wasOpen;
      if (!wasOpen) {
        const input = details.querySelector("input[data-ftd-map-nick-search]");
        if (input && !input.disabled) {
          window.setTimeout(() => {
            input.focus();
            refreshNickOptions(input);
          }, 0);
        }
      }
    }
    return;
  }
  const actionButton = target.closest("button[data-ftd-map-action]");
  if (actionButton) {
    actionButton.blur();
    const index = Number(actionButton.dataset.index);
    const action = actionButton.dataset.ftdMapAction || "";
    if (!Number.isFinite(index)) return;
    const name = actionButton.dataset.ftdMapName || "";
    if (action === "set-nick") {
      const patch = { groupNick: normalizeWhitespace(actionButton.dataset.groupNick || ""), __action: "选择群昵称" };
      if (name) updateRowByName(name, patch);
      else updateRow(index, patch);
    } else if (action === "clear-nick") {
      const patch = { groupNick: "", __action: "清除群昵称" };
      if (name) updateRowByName(name, patch);
      else updateRow(index, patch);
    } else if (action === "delete") {
      setRowDeletedByName(name || state.mapping.players[index]?.ftdName || "", true);
    } else if (action === "restore") {
      setRowDeletedByName(name || state.mapping.players[index]?.ftdName || "", false);
    } else if (action === "force-oq") {
      forceOqValidation(index, name).catch((error) => setNotice(error.message || String(error), true));
    }
    return;
  }
});

$("search").addEventListener("input", renderRows);
$("clear-search").addEventListener("click", () => {
  $("search").value = "";
  renderRows();
  $("search").focus();
});
$("validate").addEventListener("click", () => validateOq().catch((error) => setNotice(error.message, true)));
$("download").addEventListener("click", downloadJson);
$("export-png").addEventListener("click", () => exportPng().catch((error) => setNotice(error.message, true)));
$("toggle-relay").addEventListener("click", () => {
  if (!state.mapping?.registrationRelay) return;
  state.relayPanelOpen = !state.relayPanelOpen;
  render();
});

setupFtdPlayerMapSwipeGestures();
load().catch((error) => setNotice(error.message, true));


