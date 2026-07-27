#!/usr/bin/env node
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { execFile, spawn } = require("child_process");
const { URL } = require("url");
const { runSelfCheck, paths: SELF_CHECK_PATHS } = require("./self-check.js");
const FTD_TRANSCRIPT = require("./ftd-transcript-shared.js");
const {
  EXPECTED_EXTENSION_ID,
  BridgeBroker,
  FtdAutopilotCoordinator,
} = require("./ftd-autopilot-coordinator.js");

const ROOT = __dirname;
const REPO_ROOT = path.resolve(ROOT, "..", "..");
const WECHAT_DIR = path.join(REPO_ROOT, "wechat-decrypt");
const WECHAT_PY = path.join(WECHAT_DIR, ".venv", "Scripts", "python.exe");
const WECHAT_HELPER = path.join(WECHAT_DIR, "agent_tournament_helper.py");
const EGA_HELPER = path.join(WECHAT_DIR, "agent_egaroucid_analysis.py");
const MAP_COLLAB_SYNC_SCRIPT = path.join(REPO_ROOT, "cloudflare-map-collab", "tools", "sync-map-collab.js");
const MAP_COLLAB_CONFIG = path.join(REPO_ROOT, "cloudflare-map-collab", "map-collab.config.json");
const DATA_DIR = path.join(ROOT, "data");
const STATE_FILE = path.join(DATA_DIR, "checkin-state.json");
const FTD_DIR = path.join(DATA_DIR, "ftd-rounds");
const FTD_CURRENT_FILE = path.join(DATA_DIR, "ftd-round-current.json");
const EGA_CACHE_DIR = path.join(DATA_DIR, "ega-analysis");
const EGA_LOCK_FILE = path.join(EGA_CACHE_DIR, "worker.lock");
const EGA_ENGINE_EXE = path.join(
  REPO_ROOT,
  "Egaroucid_for_Console_7_8_1_Windows_AVX512_AMD",
  "Egaroucid_for_Console_7_8_1_AVX512_AMD.exe",
);
const HOST = process.env.CHECKIN_HOST || "127.0.0.1";
const PORT = Number(process.env.CHECKIN_PORT || process.env.PORT || 4174);
const AUTOMATION_VERSION = "ftd-autopilot.6";
const LOCAL_UI_ORIGIN = `http://127.0.0.1:${PORT}`;
const EXTENSION_ORIGIN = `chrome-extension://${EXPECTED_EXTENSION_ID}`;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_MEMBER_MAP_BYTES = 5 * 1024 * 1024;
const OQ_ACCOUNT_RE = /^[A-Za-z0-9_]{1,14}$/;
const OQ_MODE_ENDPOINTS = {
  "1min": "reversi1",
  "5min": "reversi",
  xot: "reversix",
};
const OQ_VALIDATION_MODE_ORDER = ["5min", "1min", "xot"];
let oqRoundScoreUpdateStatus = {
  running: false,
  lastStartedAt: "",
  lastStartedAtMs: 0,
  lastFinishedAt: "",
  lastFinishedAtMs: 0,
  lastSource: "",
  lastRound: 0,
  lastOk: null,
  lastError: "",
};

const clients = new Set();
let revision = 0;
let lastMtimeMs = 0;
let egaAnalysisProc = null;
let egaAnalysisStartedAt = "";
let egaAnalysisLastOutput = "";
let egaAnalysisLastError = "";
let egaAnalysisStopping = false;
let egaAnalysisLastLevel = 22;
let automationRuntime = null;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function ensureFtdDir() {
  ensureDataDir();
  fs.mkdirSync(FTD_DIR, { recursive: true });
}

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function setFtdCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "https://www.flipthedisc.com");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Access-Control-Max-Age", "600");
}

function sendFtdJson(res, status, payload) {
  setFtdCorsHeaders(res);
  sendJson(res, status, payload);
}

function sendFtdError(res, status, message, detail) {
  sendFtdJson(res, status, {
    ok: false,
    error: String(message || "Unknown error"),
    detail: detail ? String(detail) : undefined,
  });
}

function sendError(res, status, message, detail) {
  sendJson(res, status, {
    ok: false,
    error: String(message || "Unknown error"),
    detail: detail ? String(detail) : undefined,
  });
}

function exactObjectKeys(value, allowed, required = allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const allow = new Set(allowed);
  return Object.keys(value).every((key) => allow.has(key)) && required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function automationRequestOrigin(req) {
  const direct = String(req.headers.origin || "").trim();
  if (direct) return direct;
  const referer = String(req.headers.referer || "").trim();
  if (!referer) return "";
  try {
    return new URL(referer).origin;
  } catch (_) {
    return "";
  }
}

function assertLoopbackRequest(req) {
  const address = String(req.socket && req.socket.remoteAddress || "");
  if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") {
    const error = new Error("automation API accepts loopback requests only");
    error.statusCode = 403;
    throw error;
  }
}

function assertAutomationOrigin(req, expected) {
  assertLoopbackRequest(req);
  const origin = automationRequestOrigin(req);
  if (origin !== expected) {
    const error = new Error(`automation Origin rejected: ${origin || "missing"}`);
    error.statusCode = 403;
    throw error;
  }
  if (expected === EXTENSION_ORIGIN && req.method !== "OPTIONS") {
    if (String(req.headers["x-ftd-bridge-extension"] || "") !== EXPECTED_EXTENSION_ID) {
      const error = new Error("extension identity header rejected");
      error.statusCode = 403;
      throw error;
    }
  }
  return origin;
}

function setAutomationCorsHeaders(res, origin) {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-FTD-Bridge-Extension, X-FTD-Bridge-Id");
  res.setHeader("Access-Control-Max-Age", "600");
}

function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeKey(value) {
  return normalizeWhitespace(value).toLowerCase();
}

function safeFilePart(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 80)
    .replace(/^_+|_+$/g, "") || "ftd";
}

function safeWechatGroupFilePart(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|\r\n\t]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "wechat-group";
}

function defaultWechatGroupName(date = new Date()) {
  return `【${date.getMonth() + 1}月无差别组】栢龙杯棋王赛`;
}

function memberMapCachePath(groupName) {
  return path.join(WECHAT_DIR, "agent_cache", `${safeWechatGroupFilePart(groupName)}.member-map.json`);
}

function normalizeWechatMemberMapPayload(raw) {
  const payload = raw && typeof raw === "object" ? raw : {};
  const members = Array.isArray(payload.members) ? payload.members : [];
  const seen = new Set();
  const groupNicks = [];
  if (Array.isArray(payload.groupNicks)) {
    for (const rawNick of payload.groupNicks) {
      const nick = String(rawNick || "").trim();
      if (!nick || seen.has(nick)) continue;
      seen.add(nick);
      groupNicks.push(nick);
    }
  }
  for (const member of members) {
    if (!member || typeof member !== "object") continue;
    const nick = String(member.group_nick || member.groupNick || "").trim();
    if (!nick || seen.has(nick)) continue;
    seen.add(nick);
    groupNicks.push(nick);
  }
  groupNicks.sort((a, b) => a.localeCompare(b, "zh-Hans"));
  return {
    ok: true,
    groupName: String(payload.group_name || payload.groupName || payload.group_query || ""),
    roomUsername: String(payload.room_username || payload.roomUsername || ""),
    refreshedAt: String(payload.refreshed_at || payload.refreshedAt || ""),
    memberCount: Number(payload.member_count || payload.memberCount) || members.length || groupNicks.length,
    mappedCount: Number(payload.mapped_count || payload.mappedCount) || groupNicks.length,
    groupNicks,
  };
}

function readWechatMemberMap(groupName) {
  const targetGroup = String(groupName || "").trim() || defaultWechatGroupName();
  const file = memberMapCachePath(targetGroup);
  if (!fs.existsSync(file)) {
    const error = new Error(`微信群昵称缓存不存在：${file}`);
    error.statusCode = 404;
    throw error;
  }
  const stat = fs.statSync(file);
  if (stat.size > MAX_MEMBER_MAP_BYTES) {
    throw new Error(`微信群昵称缓存过大：${file}`);
  }
  const payload = JSON.parse(fs.readFileSync(file, "utf8"));
  return {
    ...normalizeWechatMemberMapPayload(payload),
    groupName: payload.group_name || targetGroup,
    cacheFile: file,
  };
}

function stateWithWechatGroupNicks(state, nickPool) {
  if (!state || typeof state !== "object") {
    throw new Error("共享状态不可用，无法写入微信群昵称池");
  }
  const pool = normalizeWechatMemberMapPayload(nickPool);
  if (!Array.isArray(pool.groupNicks) || !pool.groupNicks.length) {
    throw new Error("微信群昵称刷新结果为空，拒绝同步线上映射表");
  }
  const mapping = state.ftdPlayerAccountMapping && typeof state.ftdPlayerAccountMapping === "object"
    ? {
        ...state.ftdPlayerAccountMapping,
        wechatGroupNicks: pool,
      }
    : state.ftdPlayerAccountMapping;
  return {
    ...state,
    wechatGroupNicks: pool,
    ftdPlayerAccountMapping: mapping,
    savedAt: Date.now(),
  };
}

function refreshWechatMemberMap(groupName) {
  const targetGroup = String(groupName || "").trim() || defaultWechatGroupName();
  if (!fs.existsSync(WECHAT_PY)) {
    throw new Error(`找不到 wechat-decrypt venv Python：${WECHAT_PY}`);
  }
  if (!fs.existsSync(WECHAT_HELPER)) {
    throw new Error(`找不到 agent_tournament_helper.py：${WECHAT_HELPER}`);
  }
  return new Promise((resolve, reject) => {
    execFile(
      WECHAT_PY,
      [WECHAT_HELPER, "--group", targetGroup, "refresh-map"],
      { cwd: WECHAT_DIR, windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || stdout || error.message || "").trim()));
          return;
        }
        try {
          const match = String(stdout || "").match(/\{[\s\S]*\}\s*$/);
          const parsed = match ? JSON.parse(match[0]) : {};
          resolve({
            ...readWechatMemberMap(targetGroup),
            refresh: {
              ok: parsed.ok === true,
              cachePath: parsed.cache_path || "",
              refreshedAt: parsed.refreshed_at || "",
            },
          });
        } catch (parseError) {
          reject(new Error(`刷新成功但读取群昵称缓存失败：${parseError.message}`));
        }
      },
    );
  });
}

function runMapCollabSync(action) {
  if (!fs.existsSync(MAP_COLLAB_SYNC_SCRIPT)) {
    throw new Error(`找不到线上映射同步脚本：${MAP_COLLAB_SYNC_SCRIPT}`);
  }
  if (!fs.existsSync(MAP_COLLAB_CONFIG)) {
    throw new Error(`找不到线上映射同步配置：${MAP_COLLAB_CONFIG}`);
  }
  return new Promise((resolve, reject) => {
    execFile(
      "node",
      [MAP_COLLAB_SYNC_SCRIPT, action, "--config", MAP_COLLAB_CONFIG, "--state", STATE_FILE],
      { cwd: REPO_ROOT, windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const text = String(stdout || "").trim();
        let parsed = {};
        try {
          parsed = text ? JSON.parse(text) : {};
        } catch (parseError) {
          parsed = { rawStdout: text, parseError: parseError.message };
        }
        if (error) {
          reject(new Error((stderr || text || error.message || "").trim()));
          return;
        }
        if (!parsed || parsed.ok === false) {
          reject(new Error((parsed && (parsed.detail || parsed.error || parsed.reason)) || stderr || `线上映射同步失败：${action}`));
          return;
        }
        resolve({
          ...parsed,
          stderr: String(stderr || "").trim(),
        });
      },
    );
  });
}

async function syncMapCollabSafe() {
  const initialPull = await runMapCollabSync("pull-to-local");
  const refreshedMemberMap = await refreshWechatMemberMap("");
  const beforePush = readStateFile();
  const stateWithNicks = stateWithWechatGroupNicks(beforePush.state, refreshedMemberMap);
  const writtenNicks = writeStateFile(stateWithNicks, "map-collab-refresh-wechat-nicks");
  const pushNicks = await runMapCollabSync("push-nicks");
  const pullMapping = await runMapCollabSync("pull-to-local");
  const current = readStateFile();
  const mapping = current.state && current.state.ftdPlayerAccountMapping;
  const remoteSync = mapping && mapping.remoteSync && typeof mapping.remoteSync === "object"
    ? mapping.remoteSync
    : null;
  if (!remoteSync || !Number(remoteSync.revision)) {
    throw new Error("线上映射表拉取后缺少 remoteSync.revision，拒绝继续使用可能过期的本地状态");
  }
  return {
    ok: true,
    refreshedMemberMap,
    initialPull,
    writtenNicks: {
      revision,
      mtimeMs: writtenNicks.mtimeMs,
      groupNickCandidateCount: refreshedMemberMap.groupNicks.length,
    },
    pushNicks,
    pullMapping,
    revision,
    mtimeMs: current.mtimeMs,
    state: current.state,
    summary: {
      playerCount: mapping && Number(mapping.playerCount) || 0,
      matchedCount: mapping && Number(mapping.matchedCount) || 0,
      invalidAccountCount: mapping && Number(mapping.invalidAccountCount) || 0,
      unmatchedCount: mapping && Number(mapping.unmatchedCount) || 0,
      indexedCount: mapping && Number(mapping.indexedCount) || 0,
      groupNickCandidateCount: Array.isArray(mapping && mapping.wechatGroupNicks && mapping.wechatGroupNicks.groupNicks)
        ? mapping.wechatGroupNicks.groupNicks.length
        : 0,
      registrationRelayEntryCount: Array.isArray(mapping && mapping.registrationRelay && mapping.registrationRelay.entries)
        ? mapping.registrationRelay.entries.length
        : 0,
      remoteTableId: remoteSync.tableId || "",
      remoteRevision: Number(remoteSync.revision) || 0,
    },
  };
}

function validateOqAccounts(options) {
  const opts = options && typeof options === "object" ? options : {};
  if (!fs.existsSync(WECHAT_PY)) {
    throw new Error(`找不到 wechat-decrypt venv Python：${WECHAT_PY}`);
  }
  if (!fs.existsSync(WECHAT_HELPER)) {
    throw new Error(`找不到 agent_tournament_helper.py：${WECHAT_HELPER}`);
  }
  const args = [WECHAT_HELPER, "validate-oq-accounts"];
  if (opts.mode) args.push("--oq-mode", String(opts.mode));
  if (opts.concurrency) args.push("--oq-concurrency", String(opts.concurrency));
  if (opts.timeout) args.push("--oq-timeout", String(opts.timeout));
  if (opts.baseUrl) args.push("--oq-base-url", String(opts.baseUrl));
  if (opts.fromTime) args.push("--from-time", String(opts.fromTime));
  if (opts.toTime) args.push("--to-time", String(opts.toTime));
  return new Promise((resolve, reject) => {
    execFile(
      WECHAT_PY,
      args,
      { cwd: WECHAT_DIR, windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || stdout || error.message || "").trim()));
          return;
        }
        try {
          const match = String(stdout || "").match(/\{[\s\S]*\}\s*$/);
          if (!match) throw new Error("helper returned no JSON payload");
          resolve(JSON.parse(match[0]));
        } catch (parseError) {
          reject(new Error(`OQ账号校验完成但解析输出失败：${parseError.message}`));
        }
      },
    );
  });
}

function oqValidationModes(primaryMode) {
  const first = OQ_MODE_ENDPOINTS[primaryMode] ? primaryMode : "5min";
  return [first, ...OQ_VALIDATION_MODE_ORDER.filter((mode) => mode !== first)];
}

function oqModeLabel(mode) {
  return mode === "5min" ? "5min" : mode;
}

function invalidOqAccountResult(account, started, error) {
  return {
    account: normalizeWhitespace(account),
    ok: false,
    status: "invalid",
    elapsedMs: Date.now() - started,
    totalGames: 0,
    error,
  };
}

async function validateOneOqAccount(account, primaryMode, baseUrl, timeoutSeconds) {
  const started = Date.now();
  const cleanAccount = normalizeWhitespace(account);
  if (!cleanAccount) return invalidOqAccountResult(cleanAccount, started, "OQ account is empty");
  if (!OQ_ACCOUNT_RE.test(cleanAccount)) {
    return invalidOqAccountResult(
      cleanAccount,
      started,
      "OQ account must be 1-14 ASCII letters, digits, or underscores",
    );
  }
  if (typeof fetch !== "function") {
    return invalidOqAccountResult(cleanAccount, started, "local Node.js runtime does not provide fetch");
  }
  const errors = [];
  const root = String(baseUrl || "http://questgames.net").replace(/\/+$/, "");
  for (const mode of oqValidationModes(primaryMode)) {
    const endpoint = OQ_MODE_ENDPOINTS[mode] || OQ_MODE_ENDPOINTS["5min"];
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), Math.max(1, Number(timeoutSeconds) || 20) * 1000)
      : null;
    const url = `${root}/games/${endpoint}/${encodeURIComponent(cleanAccount.toLowerCase())}.json`;
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "onlicheck-local-map-validation/0.1" },
        signal: controller ? controller.signal : undefined,
      });
      if (!response.ok) {
        errors.push(`${oqModeLabel(mode)}: HTTP ${response.status}`);
        continue;
      }
      const data = await response.json();
      const games = Array.isArray(data) ? data : Array.isArray(data && data.games) ? data.games : [];
      if (!games.length) {
        errors.push(`${oqModeLabel(mode)}: no game history`);
        continue;
      }
      return {
        account: cleanAccount,
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
      const message = error && error.name === "AbortError"
        ? "timeout"
        : String(error && error.message ? error.message : error);
      errors.push(`${oqModeLabel(mode)}: ${message}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return invalidOqAccountResult(
    cleanAccount,
    started,
    errors.join("; ") || "OQ account has no game history",
  );
}

async function validateSelectedOqAccounts(accounts, options) {
  const opts = options && typeof options === "object" ? options : {};
  const primaryMode = OQ_MODE_ENDPOINTS[opts.mode] ? opts.mode : "5min";
  const concurrency = Math.max(1, Math.trunc(Number(opts.concurrency) || 8));
  const unique = [...new Map((Array.isArray(accounts) ? accounts : [])
    .map(normalizeWhitespace)
    .filter(Boolean)
    .map((account) => [account.toLowerCase(), account])).values()];
  const started = Date.now();
  const results = [];
  for (let i = 0; i < unique.length; i += concurrency) {
    const batch = unique.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((account) =>
        validateOneOqAccount(account, primaryMode, opts.baseUrl, opts.timeout),
      ),
    );
    results.push(...batchResults);
  }
  results.sort((a, b) => String(a.account || "").localeCompare(String(b.account || "")));
  return {
    ok: true,
    mode: primaryMode,
    baseUrl: String(opts.baseUrl || "http://questgames.net"),
    concurrency,
    checkedAt: new Date().toISOString(),
    wallMs: Date.now() - started,
    checkedCount: results.length,
    okCount: results.filter((item) => item.ok === true).length,
    invalidCount: results.filter((item) => item.ok !== true).length,
    results,
    byAccount: Object.fromEntries(results.map((item) => [normalizeKey(item.account), item])),
  };
}

function updateRoundScoresFromOq(options) {
  const opts = options && typeof options === "object" ? options : {};
  if (!fs.existsSync(WECHAT_PY)) {
    throw new Error(`找不到 wechat-decrypt venv Python：${WECHAT_PY}`);
  }
  if (!fs.existsSync(WECHAT_HELPER)) {
    throw new Error(`找不到 agent_tournament_helper.py：${WECHAT_HELPER}`);
  }
  const round = Math.max(1, Math.min(9, Math.trunc(Number(opts.round || 1))));
  const source = String(opts.source || "frontend").trim() || "frontend";
  const args = [WECHAT_HELPER, "update-round-oq-scores", "--round", String(round)];
  if (opts.roundCount) args.push("--round-count", String(opts.roundCount));
  const roundStart = String(opts.roundStart || opts.start || "").trim();
  if (!roundStart) {
    throw new Error("缺少本轮开始时间；请在前端填写本轮实际开始时间后再从 OQ 更新比分。");
  }
  args.push("--round-start", roundStart.replace("T", " "));
  if (opts.windowMinutes) args.push("--window-minutes", String(opts.windowMinutes));
  if (opts.mode) args.push("--oq-mode", String(opts.mode));
  if (opts.concurrency) args.push("--oq-concurrency", String(opts.concurrency));
  if (opts.timeout) args.push("--oq-timeout", String(opts.timeout));
  if (opts.baseUrl) args.push("--oq-base-url", String(opts.baseUrl));
  if (opts.dryRun) args.push("--dry-run");
  const startedAtMs = Date.now();
  oqRoundScoreUpdateStatus = {
    ...oqRoundScoreUpdateStatus,
    running: true,
    lastStartedAt: new Date(startedAtMs).toISOString(),
    lastStartedAtMs: startedAtMs,
    lastFinishedAt: "",
    lastFinishedAtMs: 0,
    lastSource: source,
    lastRound: round,
    lastOk: null,
    lastError: "",
  };
  return new Promise((resolve, reject) => {
    execFile(
      WECHAT_PY,
      args,
      { cwd: WECHAT_DIR, windowsHide: true, timeout: 180000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const finishedAtMs = Date.now();
        if (error) {
          const message = (stderr || stdout || error.message || "").trim();
          oqRoundScoreUpdateStatus = {
            ...oqRoundScoreUpdateStatus,
            running: false,
            lastFinishedAt: new Date(finishedAtMs).toISOString(),
            lastFinishedAtMs: finishedAtMs,
            lastOk: false,
            lastError: message,
          };
          reject(new Error(message));
          return;
        }
        try {
          const match = String(stdout || "").match(/\{[\s\S]*\}\s*$/);
          if (!match) throw new Error("helper returned no JSON payload");
          const parsed = JSON.parse(match[0]);
          oqRoundScoreUpdateStatus = {
            ...oqRoundScoreUpdateStatus,
            running: false,
            lastFinishedAt: new Date(finishedAtMs).toISOString(),
            lastFinishedAtMs: finishedAtMs,
            lastOk: true,
            lastError: "",
          };
          resolve(parsed);
        } catch (parseError) {
          oqRoundScoreUpdateStatus = {
            ...oqRoundScoreUpdateStatus,
            running: false,
            lastFinishedAt: new Date(finishedAtMs).toISOString(),
            lastFinishedAtMs: finishedAtMs,
            lastOk: false,
            lastError: `OQ比分更新完成但解析输出失败：${parseError.message}`,
          };
          reject(new Error(`OQ比分更新完成但解析输出失败：${parseError.message}`));
        }
      },
    );
  });
}

function projectEgaConsolePidsSync() {
  if (process.platform !== "win32") return [];
  const script = [
    "$target = [System.IO.Path]::GetFullPath($env:EGA_ENGINE_EXE)",
    "Get-Process -ErrorAction SilentlyContinue |",
    "  Where-Object { $_.Path -and ([System.IO.Path]::GetFullPath($_.Path) -ieq $target) } |",
    "  ForEach-Object { [string]$_.Id }",
  ].join("\n");
  try {
    const out = require("child_process").execFileSync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      {
        windowsHide: true,
        timeout: 5000,
        encoding: "utf8",
        env: { ...process.env, EGA_ENGINE_EXE },
      },
    );
    return String(out || "")
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isFinite(pid) && pid > 0);
  } catch (_) {
    return [];
  }
}

function killProjectEgaConsoleSync() {
  const pids = projectEgaConsolePidsSync();
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (_) {
      // Ignore stale process ids.
    }
  }
  return pids;
}

function egaAnalysisStatus() {
  const running = Boolean(egaAnalysisProc && egaAnalysisProc.exitCode == null);
  const consolePids = projectEgaConsolePidsSync();
  return {
    ok: true,
    running,
    workerRunning: running,
    pid: running ? egaAnalysisProc.pid : null,
    consolePids,
    startedAt: running ? egaAnalysisStartedAt : "",
    stopping: Boolean(egaAnalysisStopping),
    lastOutput: egaAnalysisLastOutput,
    lastError: egaAnalysisLastError,
    level: egaAnalysisLastLevel,
  };
}

function startEgaAnalysis(options = {}) {
  if (egaAnalysisProc && egaAnalysisProc.exitCode == null) {
    return { ...egaAnalysisStatus(), alreadyRunning: true };
  }
  killProjectEgaConsoleSync();
  if (!fs.existsSync(WECHAT_PY)) {
    throw new Error(`找不到 wechat-decrypt venv Python：${WECHAT_PY}`);
  }
  if (!fs.existsSync(EGA_HELPER)) {
    throw new Error(`找不到 agent_egaroucid_analysis.py：${EGA_HELPER}`);
  }
  const opts = options && typeof options === "object" ? options : {};
  const roundLimit = Math.max(1, Math.min(9, Math.trunc(Number(opts.roundLimit || 7))));
  const interval = Math.max(2, Math.trunc(Number(opts.interval || 12)));
  const nodeRestart = Math.max(1, Math.trunc(Number(opts.nodeRestart || 1000)));
  const level = Math.max(1, Math.min(60, Math.trunc(Number(opts.level || 22))));
  egaAnalysisLastLevel = level;
  const args = [
    "once",
    "--round-limit",
    String(roundLimit),
    "--node-restart",
    String(nodeRestart),
    "--level",
    String(level),
  ];
  egaAnalysisStopping = false;
  egaAnalysisLastOutput = "";
  egaAnalysisLastError = "";
  egaAnalysisStartedAt = new Date().toISOString();
  egaAnalysisProc = spawn(
    WECHAT_PY,
    [EGA_HELPER, ...args],
    { cwd: WECHAT_DIR, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  egaAnalysisProc.stdout.on("data", (chunk) => {
    egaAnalysisLastOutput = String(chunk || "").trim().slice(-2000);
  });
  egaAnalysisProc.stderr.on("data", (chunk) => {
    egaAnalysisLastError = String(chunk || "").trim().slice(-2000);
  });
  egaAnalysisProc.on("exit", (code, signal) => {
    egaAnalysisLastOutput = [
      egaAnalysisLastOutput,
      `EG分析进程已退出 code=${code == null ? "" : code} signal=${signal || ""}`,
    ]
      .filter(Boolean)
      .join("\n")
      .slice(-2000);
    egaAnalysisProc = null;
    egaAnalysisStartedAt = "";
    egaAnalysisStopping = false;
  });
  return { ...egaAnalysisStatus(), started: true };
}

function stopEgaAnalysis() {
  const killedConsolePids = killProjectEgaConsoleSync();
  if (!egaAnalysisProc || egaAnalysisProc.exitCode != null) {
    egaAnalysisProc = null;
    egaAnalysisStartedAt = "";
    egaAnalysisStopping = false;
    try {
      fs.unlinkSync(EGA_LOCK_FILE);
    } catch (_) {
      // Ignore missing or locked files.
    }
    return { ...egaAnalysisStatus(), alreadyStopped: true, killedConsolePids };
  }
  const pid = egaAnalysisProc.pid;
  egaAnalysisStopping = true;
  if (process.platform === "win32") {
    execFile(
      "taskkill",
      ["/PID", String(pid), "/T", "/F"],
      { windowsHide: true, timeout: 15000 },
      (error, stdout, stderr) => {
        if (error) {
          egaAnalysisLastError = String(stderr || stdout || error.message || "").trim().slice(-2000);
        }
        try {
          fs.unlinkSync(EGA_LOCK_FILE);
        } catch (_) {
          // The Python worker also removes this on graceful exit.
        }
      },
    );
  } else {
    egaAnalysisProc.kill("SIGTERM");
  }
  return { ok: true, running: false, stopping: true, stoppedPid: pid, killedConsolePids };
}

function normalizeOptionalScore(value, fieldName) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${fieldName} must be a number or null`);
  }
  const score = Math.trunc(parsed);
  if (score < 0 || score > 64) {
    throw new Error(`${fieldName} must be between 0 and 64`);
  }
  return score;
}

function normalizeFtdPairing(raw, index) {
  const item = raw && typeof raw === "object" ? raw : {};
  const tableRaw = Number(item.table != null ? item.table : index + 1);
  const table =
    Number.isFinite(tableRaw) && tableRaw > 0 ? Math.trunc(tableRaw) : index + 1;
  const black = String(item.black || "").replace(/\s+/g, " ").trim();
  const white = String(item.white || "").replace(/\s+/g, " ").trim();
  if (!black || !white) {
    throw new Error(`pairings[${index}] must include black and white names`);
  }
  return {
    table,
    black,
    white,
    blackAccount: String(item.blackAccount || "").trim(),
    whiteAccount: String(item.whiteAccount || "").trim(),
  };
}

function normalizeFtdStage(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim().toUpperCase();
  if (text === "SF" || text === "SEMI-FINALS" || text === "SEMIFINAL") return "SF";
  if (text === "F" || text === "FINALS" || text === "FINAL") return "F";
  if (text === "3/4" || text === "MATCH FOR 3RD PLACE" || text === "THIRD-PLACE") return "3/4";
  return "";
}

function normalizeFtdRoundPayload(raw) {
  const wrappedFtdRound =
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    raw.ftdRound &&
    typeof raw.ftdRound === "object" &&
    !Array.isArray(raw.ftdRound)
      ? raw.ftdRound
      : null;
  const input = wrappedFtdRound || raw;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("FTD payload must be a JSON object");
  }
  const roundRaw = Number(input.round);
  if (!Number.isFinite(roundRaw) || roundRaw < 1) {
    throw new Error("round must be a positive number");
  }
  const ftdRoundRaw = Number(input.ftdRound != null ? input.ftdRound : input.round);
  if (!Number.isFinite(ftdRoundRaw) || ftdRoundRaw < 1) {
    throw new Error("ftdRound must be a positive number");
  }
  const pairingsSource = Array.isArray(input.pairings)
    ? input.pairings
    : Array.isArray(input.blankPairings)
      ? input.blankPairings
      : [];
  if (!pairingsSource.length) {
    throw new Error("pairings must be a non-empty array");
  }
  const pairings = pairingsSource.map(normalizeFtdPairing);
  const stage = normalizeFtdStage(
    input.stage || input.roundName || input.round_name || input.ftdStage,
  );
  const blankPairings = pairings.map((item) => ({
    table: item.table,
    black: item.black,
    white: item.white,
    blackScore: null,
    whiteScore: null,
  }));
  const nowIso = new Date().toISOString();
  return {
    source: String(input.source || "ftd-console-dom"),
    url: String(input.url || ""),
    title: String(input.title || ""),
    exportedAt: String(input.exportedAt || nowIso),
    receivedAt: nowIso,
    competitionName: String(input.competitionName || "").replace(/\s+/g, " ").trim(),
    round: Math.trunc(roundRaw),
    ftdRound: Math.trunc(ftdRoundRaw),
    stage,
    roundName: stage || String(input.roundName || input.round_name || "").trim(),
    pairings,
    blankPairings,
    debug: input.debug && typeof input.debug === "object" ? input.debug : undefined,
  };
}

function writeJsonFileAtomic(file, payload) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

function writeFtdRoundFile(payload) {
  ensureFtdDir();
  const normalized = normalizeFtdRoundPayload(payload);
  const stamp = new Date(normalized.receivedAt)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const competition = safeFilePart(normalized.competitionName || "competition");
  const file = path.join(
    FTD_DIR,
    `${stamp}_${safeFilePart(normalized.stage || `round-${normalized.round}`)}_${competition}.json`,
  );
  writeJsonFileAtomic(file, normalized);
  writeJsonFileAtomic(FTD_CURRENT_FILE, normalized);
  return { payload: normalized, file, currentFile: FTD_CURRENT_FILE };
}

function readFtdRoundFile() {
  if (!fs.existsSync(FTD_CURRENT_FILE)) {
    return { payload: null, mtimeMs: 0 };
  }
  const stat = fs.statSync(FTD_CURRENT_FILE);
  const raw = fs.readFileSync(FTD_CURRENT_FILE, "utf8").replace(/^\uFEFF/, "");
  if (!raw.trim()) return { payload: null, mtimeMs: stat.mtimeMs };
  return { payload: JSON.parse(raw), mtimeMs: stat.mtimeMs };
}

function readStateFile() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return { state: null, mtimeMs: 0 };
    }
    const stat = fs.statSync(STATE_FILE);
    const raw = fs.readFileSync(STATE_FILE, "utf8").replace(/^\uFEFF/, "");
    if (!raw.trim()) return { state: null, mtimeMs: stat.mtimeMs };
    const state = JSON.parse(raw);
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      throw new Error("state file root must be an object");
    }
    return { state, mtimeMs: stat.mtimeMs };
  } catch (error) {
    error.message = `Cannot read ${STATE_FILE}: ${error.message}`;
    throw error;
  }
}

function validateState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("state must be a JSON object");
  }
  if (Number(state.version) !== 2) {
    throw new Error("state.version must be 2");
  }
  if (
    state.step !== "import" &&
    state.step !== "checkin" &&
    state.step !== "score-helper"
  ) {
    throw new Error('state.step must be "import", "checkin", or "score-helper"');
  }
  if (!Array.isArray(state.players)) {
    throw new Error("state.players must be an array");
  }
}

async function fetchOqGameDetailForTranscript(gameId, options = {}) {
  const cleanGameId = String(gameId || "").trim();
  if (!cleanGameId) throw new Error("OQ game ID is empty");
  if (typeof fetch !== "function") throw new Error("local Node.js runtime does not provide fetch");
  const root = String(options.baseUrl || "http://questgames.net").replace(/\/+$/, "");
  const timeoutMs = Math.max(1000, Math.min(30000, Number(options.timeoutMs) || 12000));
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(`${root}/game/${encodeURIComponent(cleanGameId)}.json`, {
      headers: { "User-Agent": "onlicheck-local-ftd-transcript/0.1" },
      signal: controller ? controller.signal : undefined,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const detail = await response.json();
    if (!detail || typeof detail !== "object" || Array.isArray(detail) || detail.error) {
      throw new Error(String(detail && detail.error || "invalid OQ game detail"));
    }
    return detail;
  } catch (error) {
    if (error && error.name === "AbortError") throw new Error("OQ game detail fetch timeout");
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const count = Math.max(1, Math.min(items.length || 1, Math.trunc(Number(concurrency) || 4)));
  await Promise.all(Array.from({ length: count }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

async function prepareFtdTranscriptPacket(state, request = {}, options = {}) {
  const helper = state && state.scoreHelper && typeof state.scoreHelper === "object"
    ? state.scoreHelper
    : {};
  const rounds = Array.isArray(helper.rounds) ? helper.rounds : [];
  const activeRound = Math.trunc(Number(helper.activeRound) || 1);
  const requestedRound = Math.trunc(Number(request.round) || activeRound);
  if (requestedRound !== activeRound) {
    throw new Error(`只能准备当前活动轮次；当前为第 ${activeRound} 轮`);
  }
  const round = rounds.find((item, index) => {
    const roundNo = Math.trunc(Number(item && item.round) || index + 1);
    return roundNo === requestedRound;
  });
  if (!round || !Array.isArray(round.ftdPairings)) {
    throw new Error(`第 ${requestedRound} 轮尚未导入 FTD 配对`);
  }

  const skipped = [];
  const candidates = [];
  for (const pairing of round.ftdPairings) {
    const eligibility = FTD_TRANSCRIPT.classifyPairingForTranscript(pairing);
    if (!eligibility.ok) {
      skipped.push(eligibility);
      continue;
    }
    candidates.push({ pairing, eligibility });
  }

  const fetchGameDetail = typeof options.fetchGameDetail === "function"
    ? options.fetchGameDetail
    : (gameId) => fetchOqGameDetailForTranscript(gameId, options);
  const prepared = await mapWithConcurrency(
    candidates,
    options.concurrency || 4,
    async ({ pairing, eligibility }) => {
      try {
        const detail = await fetchGameDetail(eligibility.oqGameId, pairing);
        const extracted = FTD_TRANSCRIPT.extractTranscriptFromOqDetail(detail);
        if (!extracted.ok) {
          return {
            game: null,
            skipped: { ...eligibility, code: extracted.code, reason: extracted.reason },
          };
        }
        return {
          game: {
            table: eligibility.table,
            ftdStage: String(pairing.ftdStage || "").trim(),
            ftdRound: Number.isFinite(Number(pairing.ftdRound))
              ? Math.trunc(Number(pairing.ftdRound))
              : requestedRound,
            ftdTable: Number.isFinite(Number(pairing.ftdTable))
              ? Math.trunc(Number(pairing.ftdTable))
              : eligibility.table,
            ftdBlack: eligibility.ftdBlack,
            ftdWhite: eligibility.ftdWhite,
            oqGameId: eligibility.oqGameId,
            transcript: extracted.transcript,
            moveCount: extracted.moveCount,
            endingStatus: extracted.endingStatus || "",
          },
          skipped: null,
        };
      } catch (error) {
        return {
          game: null,
          skipped: {
            ...eligibility,
            ok: false,
            code: "oq-detail-fetch-failed",
            reason: `OQ detail 获取失败：${String(error && error.message ? error.message : error)}`,
          },
        };
      }
    },
  );
  const games = [];
  for (const item of prepared) {
    if (item && item.game) games.push(item.game);
    if (item && item.skipped) skipped.push(item.skipped);
  }
  games.sort((a, b) => Number(a.table) - Number(b.table));
  skipped.sort((a, b) => Number(a.table) - Number(b.table));
  return {
    round: requestedRound,
    tournamentId: String(request.tournamentId || "").trim(),
    games,
    skipped,
  };
}

function normalizeMergeKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

function ftdPairingKey(item) {
  if (!item || typeof item !== "object") return "";
  const table = Number(item.table);
  const tableKey = Number.isFinite(table) && table > 0
    ? String(Math.trunc(table))
    : String(item.table || "");
  const black = normalizeMergeKey(item.black);
  const white = normalizeMergeKey(item.white);
  if (!tableKey || !black || !white) return "";
  return `${tableKey}\n${black}\n${white}`;
}

function egaAnalyzablePairingId(roundNo, item) {
  if (!item || typeof item !== "object") return "";
  const status = String(item.status || "");
  if (status !== "ready" && status !== "completed") return "";
  const gameId = FTD_TRANSCRIPT.extractOqGameId(item);
  if (!gameId) return "";
  const table = Number(item.table);
  const tableKey = Number.isFinite(table) && table > 0
    ? String(Math.trunc(table))
    : String(item.table || "").trim();
  return `${Math.trunc(Number(roundNo) || 0)}:${tableKey}:${gameId}`;
}

function mergePairingOqAvailability(currentItem, incomingItem) {
  if (!currentItem || typeof currentItem !== "object" || !incomingItem || typeof incomingItem !== "object") {
    return currentItem;
  }
  if (incomingItem.oqGameAvailable !== true) return currentItem;
  const incomingAt = numericTimestamp(incomingItem.oqGameAvailableAt);
  const currentAt = numericTimestamp(currentItem.oqGameAvailableAt);
  if (currentItem.oqGameAvailable === true && currentAt && incomingAt && currentAt >= incomingAt) {
    return currentItem;
  }
  return {
    ...currentItem,
    oqGameAvailable: true,
    oqGameAvailableAt: incomingAt || Date.now(),
    oqGameAvailableAudit:
      incomingItem.oqGameAvailableAudit && typeof incomingItem.oqGameAvailableAudit === "object"
        ? incomingItem.oqGameAvailableAudit
        : currentItem.oqGameAvailableAudit || null,
  };
}

function mergePairingTranscriptImport(currentItem, incomingItem, metadataItem = incomingItem) {
  const merged = { ...(incomingItem && typeof incomingItem === "object" ? incomingItem : {}) };
  delete merged.ftdTranscriptImport;
  const currentImport = FTD_TRANSCRIPT.sanitizeTranscriptImport(
    currentItem && currentItem.ftdTranscriptImport,
  );
  const incomingImport = FTD_TRANSCRIPT.sanitizeTranscriptImport(
    metadataItem && metadataItem.ftdTranscriptImport,
  );
  const chosen = !currentImport
    ? incomingImport
    : !incomingImport
      ? currentImport
      : incomingImport.confirmedAt >= currentImport.confirmedAt
        ? incomingImport
        : currentImport;
  if (chosen) merged.ftdTranscriptImport = chosen;
  return merged;
}

function collectEgaAnalyzablePairingIds(state) {
  const ids = new Set();
  const helper = state && state.scoreHelper && typeof state.scoreHelper === "object"
    ? state.scoreHelper
    : {};
  const rounds = Array.isArray(helper.rounds) ? helper.rounds : [];
  rounds.forEach((round, roundIndex) => {
    if (!round || typeof round !== "object" || !Array.isArray(round.ftdPairings)) return;
    const roundNo = Math.trunc(Number(round.round || roundIndex + 1) || roundIndex + 1);
    for (const item of round.ftdPairings) {
      const id = egaAnalyzablePairingId(roundNo, item);
      if (id) ids.add(id);
    }
  });
  return ids;
}

function hasNewEgaAnalyzablePairing(previousState, nextState) {
  const previous = collectEgaAnalyzablePairingIds(previousState);
  for (const id of collectEgaAnalyzablePairingIds(nextState)) {
    if (!previous.has(id)) return true;
  }
  return false;
}

function maybeStartEgaAnalysisForNewReady(previousState, nextState) {
  if (!hasNewEgaAnalyzablePairing(previousState, nextState)) return null;
  if (egaAnalysisProc && egaAnalysisProc.exitCode == null) {
    return { ok: true, alreadyRunning: true };
  }
  const helper = nextState && nextState.scoreHelper && typeof nextState.scoreHelper === "object"
    ? nextState.scoreHelper
    : {};
  const roundCount = Math.max(1, Math.min(9, Math.trunc(Number(helper.roundCount || 7) || 7)));
  try {
    return startEgaAnalysis({ roundLimit: roundCount, interval: 12, nodeRestart: 1000, level: 22 });
  } catch (error) {
    egaAnalysisLastError = String(error && error.message ? error.message : error || "").slice(-2000);
    return { ok: false, error: egaAnalysisLastError };
  }
}

function numericTimestamp(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function hasPairingResult(item) {
  if (!item || typeof item !== "object") return false;
  const status = String(item.status || "");
  if (status === "ready" || status === "completed" || status === "dirty") {
    return true;
  }
  if (String(item.sourceMessageKey || "").trim()) return true;
  if (String(item.resultText || "").trim()) return true;
  if (String(item.reason || "").trim()) return true;
  if (String(item.imagePath || "").trim()) return true;
  return Number.isFinite(Number(item.blackScore)) &&
    Number.isFinite(Number(item.whiteScore)) &&
    Number(item.blackScore) + Number(item.whiteScore) === 64;
}

function pairingUpdatedAt(item) {
  if (!item || typeof item !== "object") return 0;
  const candidates = [
    item.updatedAt,
    item.lastEditedAt,
    item.completedAt,
    item.resultSortKey,
    item.oqGameAvailableAt,
  ];
  const editedFields =
    item.userEditedFields && typeof item.userEditedFields === "object"
      ? item.userEditedFields
      : {};
  for (const value of Object.values(editedFields)) {
    candidates.push(value);
  }
  return candidates.reduce((max, value) => {
    const n = numericTimestamp(value);
    return n > max ? n : max;
  }, 0);
}

function isBlankImportedPairing(item) {
  if (!item || typeof item !== "object") return true;
  const status = String(item.status || "imported");
  if (status !== "imported" && status !== "") return false;
  if (String(item.sourceMessageKey || "").trim()) return false;
  if (String(item.resultText || "").trim()) return false;
  if (String(item.reason || "").trim()) return false;
  if (String(item.imagePath || "").trim()) return false;
  return true;
}

function incomingPairingHasUserIntent(incoming) {
  if (!incoming || typeof incoming !== "object") return false;
  const editedFields = incoming.userEditedFields && typeof incoming.userEditedFields === "object"
    ? incoming.userEditedFields
    : {};
  if (Object.values(editedFields).some((value) => numericTimestamp(value) > 0)) {
    return true;
  }
  if (incoming.lastEditedBy !== "user") return false;
  return hasPairingResult(incoming) && !isBlankImportedPairing(incoming);
}

function isUserProtectedScoreResolution(item) {
  if (!item || typeof item !== "object") return false;
  if (item.lastEditedBy !== "user") return false;
  if (String(item.resultKind || "").trim() === "absence") return true;
  const editedFields =
    item.userEditedFields && typeof item.userEditedFields === "object"
      ? item.userEditedFields
      : {};
  if (editedFields.userPending) return true;
  if (
    (String(item.status || "") === "ready" || String(item.status || "") === "completed") &&
    (editedFields.status || editedFields.blackScore || editedFields.whiteScore || editedFields.resultKind)
  ) {
    return true;
  }
  return false;
}

function shouldPreserveCurrentPairing(current, incoming, options = {}) {
  const preferIncomingUserIntent = options.preferIncomingUserIntent === true;
  const currentStatus = String(current && current.status || "");
  const incomingStatus = String(incoming && incoming.status || "");
  const currentFreshness = pairingUpdatedAt(current);
  const incomingFreshness = pairingUpdatedAt(incoming);
  const editedFields = current && current.userEditedFields && typeof current.userEditedFields === "object"
    ? current.userEditedFields
    : {};
  const protectedFields = [
    "status",
    "reporter",
    "opponent",
    "blackScore",
    "whiteScore",
    "resultText",
    "reason",
    "imagePath",
    "sourceMessageKey",
    "resultKind",
    "resultTime",
    "resultSortKey",
    "completedAt",
    "userPending",
  ];
  if (isUserProtectedScoreResolution(current) && !incomingPairingHasUserIntent(incoming)) {
    return true;
  }
  if (
    preferIncomingUserIntent &&
    incomingPairingHasUserIntent(incoming) &&
    incomingFreshness &&
    (!currentFreshness || incomingFreshness >= currentFreshness)
  ) {
    return false;
  }
  if (protectedFields.some((field) => editedFields[field])) return true;
  if (current && current.lastEditedBy === "user" && hasPairingResult(current)) return true;
  if (currentFreshness && (!incomingFreshness || currentFreshness > incomingFreshness)) {
    return true;
  }
  if (
    (currentStatus === "ready" || currentStatus === "completed") &&
    currentStatus !== incomingStatus
  ) {
    return true;
  }
  if (
    (currentStatus === "ready" || currentStatus === "completed") &&
    incomingStatus === currentStatus &&
      !hasPairingResult(incoming)
  ) {
    return true;
  }
  if (!hasPairingResult(current)) return false;
  if (!isBlankImportedPairing(incoming)) return false;
  return !incomingFreshness || currentFreshness >= incomingFreshness;
}

function scoreItemStableKey(item) {
  if (!item || typeof item !== "object") return "";
  const sourceKey = String(item.sourceMessageKey || "").trim();
  if (sourceKey) return `source:${sourceKey}`;
  const id = String(item.id || "").trim();
  if (id) return `id:${id}`;
  const table = String(item.pendingTable || item.table || item.dirtyTable || "").trim();
  const sender = normalizeMergeKey(item.wechatSender || item.sender);
  const verdict = normalizeMergeKey(item.verdict || item.status);
  if (table && sender && verdict) return `table:${table}\nsender:${sender}\nverdict:${verdict}`;
  return "";
}

function hasAgentPendingDetail(item) {
  if (!item || typeof item !== "object") return false;
  if (String(item.accountMismatchText || "").trim()) return true;
  if (String(item.pendingKind || "").trim()) return true;
  if (String(item.reviewAction || "").trim()) return true;
  if (String(item.wechatSender || "").trim()) return true;
  return false;
}

function isAgentManagedPendingItem(item) {
  if (!item || typeof item !== "object") return false;
  const pendingKind = String(item.pendingKind || "").trim();
  const verdict = String(item.verdict || item.status || "").trim();
  if (pendingKind === "user-pending") return false;
  if (item.resolvedByReferee === true) return false;
  if (pendingKind.startsWith("agent-") || pendingKind.startsWith("oq-auto-") || pendingKind.startsWith("automation-")) return true;
  if (String(item.accountMismatchText || "").trim()) return true;
  if (String(item.reviewAction || "").trim()) return true;
  if (
    [
      "account-mismatch",
      "account-mapping-unresolved",
      "account-incomplete",
      "account-gate-incomplete",
      "oq-auto-pending",
      "oq-auto-followup",
    ].includes(verdict)
  ) {
    return true;
  }
  return false;
}

function mergeAgentPendingItem(incomingItem, currentItem) {
  if (!currentItem || !hasAgentPendingDetail(currentItem)) return incomingItem;
  const merged = { ...incomingItem };
  let changed = false;
  for (const field of ["accountMismatchText", "pendingKind", "reviewAction", "wechatSender"]) {
    if (!String(merged[field] || "").trim() && String(currentItem[field] || "").trim()) {
      merged[field] = currentItem[field];
      changed = true;
    }
  }
  return changed ? merged : incomingItem;
}

function mergeScoreHelperPendingForFrontendPost(incomingRound, currentRound, options = {}) {
  const preserveCurrent = options.preserveCurrent !== false;
  if (
    !incomingRound ||
    typeof incomingRound !== "object" ||
    !currentRound ||
    typeof currentRound !== "object" ||
    !Array.isArray(incomingRound.pending) ||
    !Array.isArray(currentRound.pending)
  ) {
    return [];
  }

  const currentByKey = new Map();
  for (const item of currentRound.pending) {
    const key = scoreItemStableKey(item);
    if (key) currentByKey.set(key, item);
  }

  const preserved = [];
  const incomingKeys = new Set();
  incomingRound.pending = incomingRound.pending.map((incomingItem) => {
    const key = scoreItemStableKey(incomingItem);
    if (key) incomingKeys.add(key);
    const currentItem = key ? currentByKey.get(key) : null;
    const merged = preserveCurrent ? mergeAgentPendingItem(incomingItem, currentItem) : incomingItem;
    if (merged !== incomingItem) {
      preserved.push({
        round: Number(incomingRound.round || 0),
        table: merged.pendingTable || merged.table || "",
        sourceMessageKey: merged.sourceMessageKey || "",
      });
    }
    return merged;
  });

  if (!preserveCurrent) return preserved;

  for (const currentItem of currentRound.pending) {
    const key = scoreItemStableKey(currentItem);
    if (!key || incomingKeys.has(key) || !isAgentManagedPendingItem(currentItem)) continue;
    incomingRound.pending.unshift(currentItem);
    incomingKeys.add(key);
    preserved.push({
      round: Number(incomingRound.round || currentRound.round || 0),
      table: currentItem.pendingTable || currentItem.table || "",
      sourceMessageKey: currentItem.sourceMessageKey || "",
      preservedMissingAgentPending: true,
    });
  }
  return preserved;
}

function mergeScoreHelperFtdPairingsForFrontendPost(incomingState, currentState, options = {}) {
  const preserveCurrent = options.preserveCurrent !== false;
  const preferIncomingUserIntent = options.preferIncomingUserIntent === true;
  const incomingHelper = incomingState && incomingState.scoreHelper;
  const currentHelper = currentState && currentState.scoreHelper;
  if (
    !incomingHelper ||
    typeof incomingHelper !== "object" ||
    !currentHelper ||
    typeof currentHelper !== "object" ||
    !Array.isArray(incomingHelper.rounds) ||
    !Array.isArray(currentHelper.rounds)
  ) {
    return mergeFtdPlayerAccountMappingForFrontendPost(incomingState, currentState, {
      preserved: [],
      preservedPending: [],
    });
  }

  const nextState = {
    ...incomingState,
    scoreHelper: {
      ...incomingHelper,
      rounds: [],
    },
  };
  const preserved = [];
  const preservedPending = [];
  const incomingRoundCount = Number(incomingHelper.roundCount);
  const currentRoundCount = Number(currentHelper.roundCount);
  const incomingExplicitRoundCount = Number.isFinite(incomingRoundCount) && incomingRoundCount >= 1;
  const nextRoundCount = incomingExplicitRoundCount
    ? Math.max(1, Math.min(9, Math.trunc(incomingRoundCount)))
    : Math.max(
        1,
        Math.min(
          9,
          Math.trunc(
            Math.max(
              Number.isFinite(incomingRoundCount) ? incomingRoundCount : 0,
              Number.isFinite(currentRoundCount) ? currentRoundCount : 0,
              incomingHelper.rounds.length,
              currentHelper.rounds.length,
              1,
            ),
          ),
        ),
      );
  nextState.scoreHelper.roundCount = nextRoundCount;
  if (
    !Number.isFinite(Number(nextState.scoreHelper.activeRound)) ||
    Number(nextState.scoreHelper.activeRound) < 1 ||
    Number(nextState.scoreHelper.activeRound) > nextRoundCount
  ) {
    const currentActiveRound = Number(currentHelper.activeRound);
    nextState.scoreHelper.activeRound =
      Number.isFinite(currentActiveRound) && currentActiveRound >= 1 && currentActiveRound <= nextRoundCount
        ? Math.trunc(currentActiveRound)
        : 1;
  }
  for (let i = 0; i < nextRoundCount; i += 1) {
    const incomingRound = incomingHelper.rounds[i];
    const currentRound = currentHelper.rounds[i];
    nextState.scoreHelper.rounds.push(
      incomingRound && typeof incomingRound === "object"
        ? { ...incomingRound, round: i + 1 }
        : currentRound && typeof currentRound === "object"
          ? { ...currentRound, round: i + 1 }
          : {
              round: i + 1,
              pending: [],
              manualPending: [],
              completed: [],
              ftdPairings: [],
            },
    );
  }

  for (let roundIndex = 0; roundIndex < nextState.scoreHelper.rounds.length; roundIndex += 1) {
    const incomingRound = nextState.scoreHelper.rounds[roundIndex];
    const currentRound = currentHelper.rounds[roundIndex];
    if (
      !incomingRound ||
      typeof incomingRound !== "object" ||
      !currentRound ||
      typeof currentRound !== "object" ||
      !Array.isArray(incomingRound.ftdPairings) ||
      !Array.isArray(currentRound.ftdPairings)
    ) {
      continue;
    }

    preservedPending.push(
      ...mergeScoreHelperPendingForFrontendPost(incomingRound, currentRound, { preserveCurrent }),
    );

    const currentByKey = new Map();
    for (const item of currentRound.ftdPairings) {
      const key = ftdPairingKey(item);
      if (key) currentByKey.set(key, item);
    }

    incomingRound.ftdPairings = incomingRound.ftdPairings.map((incomingItem) => {
      const key = ftdPairingKey(incomingItem);
      const currentItem = key ? currentByKey.get(key) : null;
      if (
        preserveCurrent &&
        currentItem &&
        shouldPreserveCurrentPairing(currentItem, incomingItem, {
          preferIncomingUserIntent,
        })
      ) {
        const preservedItem = mergePairingTranscriptImport(
          currentItem,
          mergePairingOqAvailability(currentItem, incomingItem),
          incomingItem,
        );
        preserved.push({
          round: Number(incomingRound.round || roundIndex + 1),
          table: preservedItem.table,
          status: preservedItem.status || "imported",
          sourceMessageKey: preservedItem.sourceMessageKey || "",
        });
        return preservedItem;
      }
      return currentItem ? mergePairingTranscriptImport(currentItem, incomingItem) : incomingItem;
    });
  }

  return mergeFtdPlayerAccountMappingForFrontendPost(nextState, currentState, {
    preserved,
    preservedPending,
  });
}

function mergeFtdPlayerAccountMappingForAnyPost(incomingState, currentState) {
  return mergeScoreHelperFtdPairingsForFrontendPost(incomingState, currentState);
}

function ftdPlayerRegistrationUpdatedAt(registration) {
  if (!registration || typeof registration !== "object") return 0;
  const values = [registration.updatedAt, registration.resolvedAt];
  if (Array.isArray(registration.rows)) {
    for (const row of registration.rows) {
      if (!row || typeof row !== "object") continue;
      values.push(row.resolvedAt);
      if (row.console && typeof row.console === "object") values.push(row.console.lastResultAt);
    }
  }
  return values.reduce((max, value) => {
    const parsed = typeof value === "number" ? value : Date.parse(String(value || ""));
    return Number.isFinite(parsed) && parsed > max ? parsed : max;
  }, 0);
}

function preserveFtdPlayerRegistration(result, incomingState, currentState, preserveCurrent) {
  const incoming = incomingState && incomingState.ftdPlayerRegistration;
  const current = currentState && currentState.ftdPlayerRegistration;
  if (!current || typeof current !== "object") return result;
  const shouldPreserve = !incoming || typeof incoming !== "object" || (
    preserveCurrent && ftdPlayerRegistrationUpdatedAt(current) > ftdPlayerRegistrationUpdatedAt(incoming)
  );
  if (!shouldPreserve) return result;
  return {
    ...result,
    state: {
      ...(result && result.state ? result.state : incomingState),
      ftdPlayerRegistration: current,
    },
    preservedFtdPlayerRegistration: true,
  };
}

function mergeStateForApiPost(incomingState, currentState, options = {}) {
  const source = typeof options.source === "string" ? options.source : "frontend";
  const baseRevision = Number(options.baseRevision);
  const currentRevision = Number(options.currentRevision);
  const preserveCurrent =
    source !== "frontend" ||
    !Number.isFinite(baseRevision) ||
    !Number.isFinite(currentRevision) ||
    baseRevision < currentRevision;
  if (source === "map-collab-overwrite-local") {
    return { state: incomingState };
  }
  if (source === "agent-resolve-ftd-players") {
    if (!incomingState || !incomingState.ftdPlayerRegistration) {
      throw new Error("agent-resolve-ftd-players post is missing ftdPlayerRegistration");
    }
    return {
      state: {
        ...currentState,
        ftdPlayerRegistration: incomingState.ftdPlayerRegistration,
        savedAt: incomingState.savedAt,
      },
    };
  }
  if (source === "frontend") {
    const result = mergeScoreHelperFtdPairingsForFrontendPost(incomingState, currentState, {
      preserveCurrent,
      preferIncomingUserIntent: true,
    });
    return preserveFtdPlayerRegistration(result, incomingState, currentState, preserveCurrent);
  }
  const result = mergeFtdPlayerAccountMappingForAnyPost(incomingState, currentState);
  return preserveFtdPlayerRegistration(result, incomingState, currentState, true);
}

function mappingUpdatedAt(mapping) {
  if (!mapping || typeof mapping !== "object") return 0;
  const candidates = [
    mapping.updatedAt,
    mapping.mappedAt ? Date.parse(mapping.mappedAt) : 0,
    mapping.clearedAt ? Date.parse(mapping.clearedAt) : 0,
  ];
  if (Array.isArray(mapping.players)) {
    for (const row of mapping.players) {
      if (!row || typeof row !== "object") continue;
      const audit = row.editAudit && typeof row.editAudit === "object" ? row.editAudit : null;
      if (audit && audit.at) candidates.push(Date.parse(audit.at));
    }
  }
  return candidates.reduce((max, value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
}

function mappingHasRows(mapping) {
  return Boolean(
    mapping &&
      typeof mapping === "object" &&
      Array.isArray(mapping.players) &&
      mapping.players.length > 0,
  );
}

function mappingIsExplicitClear(mapping) {
  return Boolean(
    mapping &&
      typeof mapping === "object" &&
      mapping.type === "ftd-player-oq-account-map-clear" &&
      mapping.cleared === true,
  );
}

function normalizeMappingRowKey(row) {
  if (!row || typeof row !== "object") return "";
  return normalizeMergeKey(row.ftdName || row.displayName || row.name || row.ftdId);
}

function mappingRowUpdatedAt(row) {
  if (!row || typeof row !== "object") return 0;
  const audit = row.editAudit && typeof row.editAudit === "object" ? row.editAudit : null;
  const oqCheck = row.oqCheck && typeof row.oqCheck === "object" ? row.oqCheck : null;
  const candidates = [
    row.updatedAt,
    row.mappedAt ? Date.parse(row.mappedAt) : 0,
    audit && audit.at ? Date.parse(audit.at) : 0,
    oqCheck && oqCheck.checkedAt ? Date.parse(oqCheck.checkedAt) : 0,
  ];
  return candidates.reduce((max, value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
}

function oqCheckMatchesAccount(row, oqCheck, account) {
  if (!row || !oqCheck || typeof oqCheck !== "object") return false;
  const checkedAccount = String(oqCheck.account || row.oqCheckAccount || "").trim();
  if (!checkedAccount) return true;
  return checkedAccount.toLowerCase() === String(account || "").trim().toLowerCase();
}

function mappingRowHasRequiredFields(row) {
  return Boolean(
    row &&
      String(row.ftdName || row.displayName || row.name || "").trim() &&
      String(row.account || "").trim() &&
      String(row.groupNick || row.group_nick || "").trim(),
  );
}

function mappingRowIsDeleted(row) {
  return Boolean(row && row.deleted === true);
}

function mappingRowIsInvalid(row) {
  if (!row || mappingRowIsDeleted(row) || !mappingRowHasRequiredFields(row)) return false;
  const account = String(row.account || "").trim();
  const oqCheck = row.oqCheck && typeof row.oqCheck === "object" ? row.oqCheck : null;
  return Boolean(oqCheck && oqCheckMatchesAccount(row, oqCheck, account) && String(oqCheck.status || "").trim() === "invalid");
}

function mappingRowIsComplete(row) {
  if (!row || mappingRowIsDeleted(row) || mappingRowIsInvalid(row) || !mappingRowHasRequiredFields(row)) return false;
  const account = String(row.account || "").trim();
  const oqCheck = row.oqCheck && typeof row.oqCheck === "object" ? row.oqCheck : null;
  const status = String(oqCheck && oqCheck.status || "").trim();
  return Boolean(oqCheck && oqCheckMatchesAccount(row, oqCheck, account) && (status === "ok" || status === "forced-ok"));
}

function mappingRowNeedsManualOqValidation(row) {
  if (!row || mappingRowIsDeleted(row)) return false;
  const account = normalizeWhitespace(row.account);
  if (!account) return false;
  const oqCheck = row.oqCheck && typeof row.oqCheck === "object" ? row.oqCheck : null;
  if (!oqCheck || !oqCheckMatchesAccount(row, oqCheck, account)) return true;
  const status = normalizeWhitespace(oqCheck.status);
  if (status === "invalid") return true;
  if (status === "forced-ok") return true;
  if (status !== "ok") return true;
  const checkedAt = Date.parse(oqCheck.checkedAt || "");
  const audit = row.editAudit && typeof row.editAudit === "object" ? row.editAudit : null;
  const auditAt = audit && normalizeWhitespace(audit.by) === "user"
    ? Date.parse(audit.at || "")
    : 0;
  const checkedAccount = normalizeWhitespace(oqCheck.account || row.oqCheckAccount || "");
  return !checkedAccount && Number.isFinite(auditAt) && Number.isFinite(checkedAt) && auditAt > checkedAt;
}

function preserveMappingRemoteSync(incomingMapping, currentMapping) {
  if (!incomingMapping || typeof incomingMapping !== "object") return incomingMapping;
  if (
    incomingMapping.remoteSync &&
    typeof incomingMapping.remoteSync === "object" &&
    Number(incomingMapping.remoteSync.revision)
  ) {
    return incomingMapping;
  }
  const currentRemoteSync = currentMapping && currentMapping.remoteSync && typeof currentMapping.remoteSync === "object"
    ? currentMapping.remoteSync
    : null;
  if (!currentRemoteSync || !Number(currentRemoteSync.revision)) return incomingMapping;
  return {
    ...incomingMapping,
    remoteSync: currentRemoteSync,
  };
}

function oqCheckFromValidationResult(result, checkedAt) {
  const ok = result && result.ok === true;
  return {
    account: normalizeWhitespace(result && result.account),
    status: ok ? "ok" : "invalid",
    checkedAt,
    mode: normalizeWhitespace(result && result.mode),
    primaryMode: normalizeWhitespace(result && result.primaryMode),
    fallbackUsed: Boolean(result && result.fallbackUsed),
    elapsedMs: result && Number.isFinite(Number(result.elapsedMs)) ? Number(result.elapsedMs) : 0,
    totalGames: result && Number.isFinite(Number(result.totalGames)) ? Math.max(0, Math.trunc(Number(result.totalGames))) : 0,
    windowGames: result && Number.isFinite(Number(result.windowGames)) ? Math.max(0, Math.trunc(Number(result.windowGames))) : 0,
    error: ok ? "" : normalizeWhitespace(result && result.error) || "OQ account validation failed",
  };
}

async function validateOqAccountsForManualFrontend(options) {
  const opts = options && typeof options === "object" ? options : {};
  const current = readStateFile().state;
  const mapping = current && current.ftdPlayerAccountMapping;
  const rows = mapping && Array.isArray(mapping.players) ? mapping.players : [];
  if (!mapping || !rows.length) {
    throw new Error("frontend state has no ftdPlayerAccountMapping.players rows");
  }
  const targetRows = rows.filter(mappingRowNeedsManualOqValidation);
  const validation = await validateSelectedOqAccounts(
    targetRows.map((row) => row.account),
    opts,
  );
  const checkedAt = validation.checkedAt;
  const byAccount = validation.byAccount || {};
  const nextRows = rows.map((row) => {
    if (!row || typeof row !== "object") return row;
    const nextRow = { ...row };
    const result = byAccount[normalizeKey(nextRow.account)];
    if (result && !mappingRowIsDeleted(nextRow)) {
      const previousOqCheck = nextRow.oqCheck && typeof nextRow.oqCheck === "object" ? nextRow.oqCheck : null;
      if (result.ok || !previousOqCheck || normalizeWhitespace(previousOqCheck.status) !== "forced-ok") {
        nextRow.oqCheck = oqCheckFromValidationResult(result, checkedAt);
      } else {
        nextRow.oqCheck = {
          ...previousOqCheck,
          account: normalizeWhitespace(nextRow.account),
          checkedAt: previousOqCheck.checkedAt || checkedAt,
          lastValidationAttemptAt: checkedAt,
          lastValidationError: normalizeWhitespace(result.error) || "OQ account validation failed",
        };
      }
      delete nextRow.status;
      if (result.ok && normalizeWhitespace(nextRow.account) && normalizeWhitespace(nextRow.groupNick || nextRow.group_nick)) {
        delete nextRow.reason;
        delete nextRow.pendingText;
      } else if (!result.ok && (!nextRow.oqCheck || normalizeWhitespace(nextRow.oqCheck.status) !== "forced-ok")) {
        nextRow.reason = "OQ account validation failed";
        nextRow.pendingText = `OQ???${nextRow.account || ""}?FTD???${nextRow.ftdName || ""}????${nextRow.oqCheck.error}`;
      }
    }
    return nextRow;
  });
  const rebuiltMapping = rebuildFtdPlayerAccountMappingCounts({
    ...mapping,
    mappedAt: mapping.mappedAt || checkedAt,
    updatedAt: Date.now(),
    players: nextRows,
    oqValidation: {
      checkedAt,
      checkedCount: validation.checkedCount,
      okCount: validation.okCount,
      invalidCount: validation.invalidCount,
      skippedCount: Math.max(0, rows.filter((row) => !mappingRowIsDeleted(row) && normalizeWhitespace(row.account)).length - validation.checkedCount),
      wallMs: validation.wallMs,
      incremental: true,
    },
  });
  const written = validation.checkedCount > 0
    ? writeStateFile({ ...current, ftdPlayerAccountMapping: rebuiltMapping }, "oq-account-validation")
    : { state: { ...current, ftdPlayerAccountMapping: rebuiltMapping }, mtimeMs: readStateFile().mtimeMs };
  const latestMapping = written.state.ftdPlayerAccountMapping || rebuiltMapping;
  return {
    ok: true,
    type: "oq-account-validation",
    incremental: true,
    checkedAt,
    checkedCount: validation.checkedCount,
    okCount: validation.okCount,
    invalidCount: validation.invalidCount,
    skippedCount: rebuiltMapping.oqValidation.skippedCount,
    totalInvalidAccountCount: Number(latestMapping.invalidAccountCount) || 0,
    wallMs: validation.wallMs,
    results: validation.results,
    invalidAccounts: Array.isArray(latestMapping.invalidAccounts) ? latestMapping.invalidAccounts.slice(0, 40) : [],
    revision,
    mtimeMs: written.mtimeMs,
  };
}

function rebuildFtdPlayerAccountMappingCounts(mapping) {
  if (!mapping || typeof mapping !== "object" || !Array.isArray(mapping.players)) {
    return mapping;
  }

  const players = mapping.players.map((row) => {
    if (!row || typeof row !== "object") return row;
    const nextRow = { ...row };
    if (String(row.status || "").trim() === "deleted") nextRow.deleted = true;
    delete nextRow.status;
    delete nextRow.reason;
    delete nextRow.pendingText;
    delete nextRow.candidates;
    delete nextRow.debugIssue;
    delete nextRow.debugCandidates;
    return nextRow;
  });
  const accountIndex = {};

  for (const row of players) {
    if (!row || typeof row !== "object") continue;
    const key = normalizeMappingRowKey(row);
    const account = String(row.account || "").trim();
    const groupNick = String(row.groupNick || row.group_nick || "").trim();
    const oqCheck = row.oqCheck && typeof row.oqCheck === "object" ? row.oqCheck : null;
    const oqCheckCurrent = oqCheckMatchesAccount(row, oqCheck, account);
    if (account && oqCheck && !oqCheckCurrent) {
      row.oqCheck = null;
    }
    if (!mappingRowIsDeleted(row) && key && account && groupNick && row.oqCheck && oqCheckMatchesAccount(row, row.oqCheck, account) && ["ok", "forced-ok"].includes(String(row.oqCheck.status || "").trim())) {
      if (key) {
        accountIndex[key] = {
          ftdName: row.ftdName || row.displayName || row.name || "",
          displayName: row.ftdName || row.displayName || row.name || "",
          account,
          groupNick,
          ftdId: row.ftdId == null ? "" : row.ftdId,
          source: row.source || "",
          mappedAt:
            (row.editAudit && row.editAudit.at) ||
            row.mappedAt ||
            mapping.mappedAt ||
            "",
        };
      }
    }
  }
  const activePlayers = players.filter((row) => row && typeof row === "object" && !mappingRowIsDeleted(row));
  const invalidAccounts = activePlayers.filter(mappingRowIsInvalid);
  const unmatched = activePlayers.filter((row) => !mappingRowIsComplete(row) && !mappingRowIsInvalid(row));

  return {
    ...mapping,
    accountIndex,
    players,
    playerCount: players.length,
    indexedCount: Object.keys(accountIndex).length,
    matchedCount: activePlayers.filter(mappingRowIsComplete).length,
    invalidAccountCount: invalidAccounts.length,
    ambiguousCount: 0,
    unmatchedCount: unmatched.length,
    unmatched: unmatched.slice(0, 120),
    invalidAccounts: invalidAccounts.slice(0, 120),
    ambiguous: [],
  };
}

function mergeFtdPlayerAccountMappingForFrontendPost(incomingState, currentState, result) {
  if (!incomingState || typeof incomingState !== "object") {
    return { state: incomingState, ...(result || {}) };
  }
  const incomingMapping = incomingState.ftdPlayerAccountMapping;
  const currentMapping = currentState && currentState.ftdPlayerAccountMapping;
  if (mappingIsExplicitClear(incomingMapping)) {
    return {
      state: {
        ...incomingState,
        ftdPlayerAccountMapping: null,
      },
      ...(result || {}),
    };
  }
  if (!mappingHasRows(currentMapping)) {
    return { state: incomingState, ...(result || {}) };
  }
  const incomingFreshness = mappingUpdatedAt(incomingMapping);
  const currentFreshness = mappingUpdatedAt(currentMapping);
  if (!mappingHasRows(incomingMapping)) {
    return {
      state: {
        ...incomingState,
        ftdPlayerAccountMapping: currentMapping,
      },
      ...(result || {}),
      preservedFtdPlayerAccountMapping: true,
    };
  }
  if (mappingHasRows(incomingMapping)) {
    const incomingRows = Array.isArray(incomingMapping.players) ? incomingMapping.players : [];
    const currentRows = Array.isArray(currentMapping.players) ? currentMapping.players : [];
    const mergedRows = [];
    const currentByKey = new Map();
    let rowPreservedCount = 0;
    for (const row of currentRows) {
      const key = normalizeMappingRowKey(row);
      if (key && !currentByKey.has(key)) currentByKey.set(key, row);
    }
    const seen = new Set();
    for (const incomingRow of incomingRows) {
      const key = normalizeMappingRowKey(incomingRow);
      const currentRow = key ? currentByKey.get(key) : null;
      if (key) seen.add(key);
      if (currentRow && mappingRowUpdatedAt(currentRow) > mappingRowUpdatedAt(incomingRow) + 1000) {
        mergedRows.push(currentRow);
        rowPreservedCount += 1;
      } else {
        mergedRows.push(incomingRow);
      }
    }
    for (const currentRow of currentRows) {
      const key = normalizeMappingRowKey(currentRow);
      if (key && seen.has(key)) continue;
      if (mappingRowUpdatedAt(currentRow) > incomingFreshness + 1000) {
        mergedRows.push(currentRow);
        rowPreservedCount += 1;
      }
    }
    if (rowPreservedCount > 0) {
      const mergedMapping = rebuildFtdPlayerAccountMappingCounts({
        ...preserveMappingRemoteSync(incomingMapping, currentMapping),
        players: mergedRows,
        mappedAt: currentFreshness > incomingFreshness
          ? currentMapping.mappedAt || incomingMapping.mappedAt
          : incomingMapping.mappedAt || currentMapping.mappedAt,
        updatedAt: Math.max(
          Number(incomingMapping.updatedAt) || 0,
          Number(currentMapping.updatedAt) || 0,
          Date.now(),
        ),
      });
      return {
        state: {
          ...incomingState,
          ftdPlayerAccountMapping: mergedMapping,
        },
        ...(result || {}),
        preservedFtdPlayerAccountMapping: true,
        preservedFtdPlayerAccountMappingRows: rowPreservedCount,
      };
    }
    return {
      state: {
        ...incomingState,
        ftdPlayerAccountMapping: rebuildFtdPlayerAccountMappingCounts(
          preserveMappingRemoteSync(incomingMapping, currentMapping),
        ),
      },
      ...(result || {}),
    };
  }
  return { state: incomingState, ...(result || {}) };
}

function writeStateFile(state, source) {
  validateState(state);
  ensureDataDir();

  const next = {
    ...state,
    savedAt: Number.isFinite(Number(state.savedAt)) ? Number(state.savedAt) : Date.now(),
    localSync: {
      ...(state.localSync && typeof state.localSync === "object"
        ? state.localSync
        : {}),
      source: source || "api",
      savedAt: Date.now(),
    },
  };

  const tmp = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, STATE_FILE);
  const stat = fs.statSync(STATE_FILE);
  lastMtimeMs = stat.mtimeMs;
  revision += 1;
  broadcast({ type: "state", revision, mtimeMs: lastMtimeMs, source });
  return { state: next, mtimeMs: lastMtimeMs };
}

function getAutomationRuntime() {
  if (automationRuntime) return automationRuntime;
  const bridge = new BridgeBroker({ extensionId: EXPECTED_EXTENSION_ID });
  const coordinator = new FtdAutopilotCoordinator({
    dataDir: DATA_DIR,
    readState: readStateFile,
    writeState: (state, source) => writeStateFile(state, source),
    getRevision: () => revision,
    updateOq: updateRoundScoresFromOq,
    fetchOqDetail: fetchOqGameDetailForTranscript,
    bridge,
  });
  automationRuntime = { bridge, coordinator };
  return automationRuntime;
}

function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of Array.from(clients)) {
    try {
      res.write(data);
    } catch (_) {
      clients.delete(res);
    }
  }
}

function watchStateFile() {
  ensureDataDir();
  try {
    if (fs.existsSync(STATE_FILE)) {
      lastMtimeMs = fs.statSync(STATE_FILE).mtimeMs;
    }
    fs.watch(DATA_DIR, { persistent: false }, (eventType, filename) => {
      if (String(filename || "") !== "checkin-state.json") return;
      try {
        const stat = fs.existsSync(STATE_FILE) ? fs.statSync(STATE_FILE) : null;
        const mtimeMs = stat ? stat.mtimeMs : 0;
        if (mtimeMs === lastMtimeMs) return;
        lastMtimeMs = mtimeMs;
        revision += 1;
        broadcast({
          type: "state",
          revision,
          mtimeMs,
          source: "file-watch",
        });
      } catch (error) {
        revision += 1;
        broadcast({
          type: "error",
          revision,
          error: String(error && error.message ? error.message : error),
        });
      }
    });
  } catch (error) {
    console.error("[checkin] Failed to watch data directory:", error);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body exceeds 8MB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleAutomationApi(req, res, pathname) {
  if (!pathname.startsWith("/api/automation/")) return false;
  const bridgeRoute = pathname.startsWith("/api/automation/bridge/");
  const expectedOrigin = bridgeRoute ? EXTENSION_ORIGIN : LOCAL_UI_ORIGIN;
  try {
    const origin = assertAutomationOrigin(req, expectedOrigin);
    setAutomationCorsHeaders(res, origin);
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Cache-Control": "no-store" });
      res.end();
      return true;
    }
    const { bridge, coordinator } = getAutomationRuntime();
    if (pathname === "/api/automation/status" && req.method === "GET") {
      sendJson(res, 200, coordinator.status());
      return true;
    }
    if ((pathname === "/api/automation/probe" || pathname === "/api/automation/start") && req.method === "POST") {
      const raw = await readBody(req);
      const parsed = raw.trim() ? JSON.parse(raw) : {};
      if (!exactObjectKeys(parsed, ["tournamentId", "localRound", "localStage"], [])) throw Object.assign(new Error("automation scope schema rejected"), { statusCode: 400 });
      const result = pathname.endsWith("/probe") ? await coordinator.readOnlyProbe(parsed) : await coordinator.start(parsed);
      sendJson(res, 200, { ok: true, ...result });
      return true;
    }
    if (["/api/automation/pause", "/api/automation/resume", "/api/automation/stop"].includes(pathname) && req.method === "POST") {
      const raw = await readBody(req);
      const parsed = raw.trim() ? JSON.parse(raw) : {};
      if (!exactObjectKeys(parsed, ["sessionId", "token"])) throw Object.assign(new Error("automation control schema rejected"), { statusCode: 400 });
      let session;
      if (pathname.endsWith("/pause")) session = coordinator.pause(String(parsed.sessionId), String(parsed.token));
      else if (pathname.endsWith("/resume")) session = coordinator.resume(String(parsed.sessionId), String(parsed.token));
      else session = coordinator.emergencyStop(String(parsed.sessionId), String(parsed.token));
      sendJson(res, 200, { ok: true, session });
      return true;
    }
    if (pathname === "/api/automation/bridge/register" && req.method === "POST") {
      const raw = await readBody(req);
      const parsed = raw.trim() ? JSON.parse(raw) : {};
      const status = bridge.register(parsed, expectedOrigin);
      sendJson(res, 200, { ok: true, bridge: status });
      return true;
    }
    if (pathname === "/api/automation/bridge/next" && req.method === "POST") {
      const raw = await readBody(req);
      const parsed = raw.trim() ? JSON.parse(raw) : {};
      if (!exactObjectKeys(parsed, ["bridgeId", "timeoutMs"])) throw Object.assign(new Error("bridge poll schema rejected"), { statusCode: 400 });
      if (!Number.isInteger(Number(parsed.timeoutMs))) throw Object.assign(new Error("bridge poll timeout rejected"), { statusCode: 400 });
      const item = await bridge.next(String(parsed.bridgeId), expectedOrigin, Number(parsed.timeoutMs));
      sendJson(res, 200, item);
      return true;
    }
    if (pathname === "/api/automation/bridge/heartbeat" && req.method === "POST") {
      const raw = await readBody(req);
      const parsed = raw.trim() ? JSON.parse(raw) : {};
      if (!exactObjectKeys(parsed, ["bridgeId"])) throw Object.assign(new Error("bridge heartbeat schema rejected"), { statusCode: 400 });
      sendJson(res, 200, { ok: true, bridge: bridge.heartbeat(String(parsed.bridgeId), expectedOrigin) });
      return true;
    }
    if (pathname === "/api/automation/bridge/trace" && req.method === "POST") {
      const raw = await readBody(req);
      const parsed = raw.trim() ? JSON.parse(raw) : {};
      sendJson(res, 200, { ok: true, ...bridge.trace(parsed, expectedOrigin) });
      return true;
    }
    if (pathname === "/api/automation/bridge/response" && req.method === "POST") {
      const raw = await readBody(req);
      const parsed = raw.trim() ? JSON.parse(raw) : {};
      sendJson(res, 200, { ok: true, ...bridge.respond(parsed, expectedOrigin) });
      return true;
    }
    sendJson(res, 404, { ok: false, error: "Unknown automation endpoint" });
    return true;
  } catch (error) {
    setAutomationCorsHeaders(res, expectedOrigin);
    sendJson(res, Number(error.statusCode) || 400, {
      ok: false,
      code: String(error.code || "automation-request-rejected"),
      error: String(error.message || error),
    });
    return true;
  }
}

async function handleApi(req, res, pathname) {
  if (await handleAutomationApi(req, res, pathname)) return true;
  if (pathname === "/api/ftd-round" && req.method === "OPTIONS") {
    setFtdCorsHeaders(res);
    res.writeHead(204, { "Cache-Control": "no-store" });
    res.end();
    return true;
  }

  if (pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      automationVersion: AUTOMATION_VERSION,
      stateFile: STATE_FILE,
      revision,
      now: Date.now(),
    });
    return true;
  }

  if (pathname === "/api/self-check" && req.method === "GET") {
    try {
      const latestFile = SELF_CHECK_PATHS.SELF_CHECK_REPORT_FILE;
      const latest = fs.existsSync(latestFile)
        ? JSON.parse(fs.readFileSync(latestFile, "utf8"))
        : null;
      sendJson(res, 200, {
        ok: true,
        latest,
        paths: {
          report: latestFile,
          runtimeLock: SELF_CHECK_PATHS.RUNTIME_LOCK_FILE,
          state: STATE_FILE,
          frontendApi: `http://${HOST}:${PORT}/api/state`,
        },
      });
    } catch (error) {
      sendError(res, 500, "Failed to read self-check report", error.message);
    }
    return true;
  }

  if (pathname === "/api/self-check/run" && req.method === "POST") {
    try {
      const text = await readBody(req);
      const parsed = text.trim() ? JSON.parse(text) : {};
      const result = await runSelfCheck({
        event: String(parsed.event || "open").trim() || "open",
        full: parsed.full === true,
        checkinReady: parsed.checkinReady === true || parsed.checkin_ready === true,
        round: parsed.round ? Math.max(1, Math.trunc(Number(parsed.round))) : 0,
        group: String(parsed.group || "").trim(),
        writeLock: parsed.writeLock !== false,
        writeReport: true,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendError(res, 500, "Failed to run self-check", error.message);
    }
    return true;
  }

  if (pathname === "/api/wechat-member-map" && req.method === "GET") {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || HOST}`);
      sendJson(res, 200, readWechatMemberMap(url.searchParams.get("group") || ""));
    } catch (error) {
      sendError(res, error.statusCode || 500, "Failed to read WeChat member map", error.message);
    }
    return true;
  }

  if (pathname === "/api/wechat-member-map/refresh" && req.method === "POST") {
    try {
      const text = await readBody(req);
      const parsed = text.trim() ? JSON.parse(text) : {};
      const result = await refreshWechatMemberMap(parsed && parsed.group);
      sendJson(res, 200, result);
    } catch (error) {
      sendError(res, 400, "Failed to refresh WeChat member map", error.message);
    }
    return true;
  }

  if (pathname === "/api/oq-accounts/validate" && req.method === "POST") {
    try {
      const text = await readBody(req);
      const parsed = text.trim() ? JSON.parse(text) : {};
      const result = await validateOqAccountsForManualFrontend(parsed);
      sendJson(res, 200, result);
    } catch (error) {
      sendError(res, 400, "Failed to validate OQ accounts", error.message);
    }
    return true;
  }

  if (pathname === "/api/map-collab/sync" && req.method === "POST") {
    try {
      const result = await syncMapCollabSafe();
      sendJson(res, 200, result);
    } catch (error) {
      sendError(res, 500, "Failed to sync online mapping table", error.message);
    }
    return true;
  }

  if (pathname === "/api/oq-games/update-round-scores" && req.method === "POST") {
    try {
      const text = await readBody(req);
      const parsed = text.trim() ? JSON.parse(text) : {};
      const result = await updateRoundScoresFromOq(parsed);
      sendJson(res, 200, result);
    } catch (error) {
      sendError(res, 400, "Failed to update round scores from OQ", error.message);
    }
    return true;
  }

  if (pathname === "/api/oq-games/update-round-scores/status" && req.method === "GET") {
    sendJson(res, 200, { ok: true, ...oqRoundScoreUpdateStatus });
    return true;
  }

  if (pathname === "/api/oq-games/update-round-scores/mark-request" && req.method === "POST") {
    try {
      const text = await readBody(req);
      const parsed = text.trim() ? JSON.parse(text) : {};
      const startedAtMs = Date.now();
      oqRoundScoreUpdateStatus = {
        ...oqRoundScoreUpdateStatus,
        lastStartedAt: new Date(startedAtMs).toISOString(),
        lastStartedAtMs: startedAtMs,
        lastSource: String(parsed.source || "agent").trim() || "agent",
        lastRound: Math.max(1, Math.min(9, Math.trunc(Number(parsed.round || 1)))),
        lastOk: null,
        lastError: "",
      };
      sendJson(res, 200, { ok: true, ...oqRoundScoreUpdateStatus });
    } catch (error) {
      sendError(res, 400, "Failed to mark OQ update request", error.message);
    }
    return true;
  }

  if (pathname === "/api/ega-analysis/status" && req.method === "GET") {
    sendJson(res, 200, egaAnalysisStatus());
    return true;
  }

  if (pathname === "/api/ega-analysis/start" && req.method === "POST") {
    try {
      const text = await readBody(req);
      const parsed = text.trim() ? JSON.parse(text) : {};
      sendJson(res, 200, startEgaAnalysis(parsed));
    } catch (error) {
      sendError(res, 400, "Failed to start Egaroucid analysis", error.message);
    }
    return true;
  }

  if (pathname === "/api/ega-analysis/stop" && req.method === "POST") {
    try {
      sendJson(res, 200, stopEgaAnalysis());
    } catch (error) {
      sendError(res, 400, "Failed to stop Egaroucid analysis", error.message);
    }
    return true;
  }

  if (pathname === "/api/ftd-round" && req.method === "GET") {
    try {
      const current = readFtdRoundFile();
      sendFtdJson(res, 200, {
        ok: true,
        mtimeMs: current.mtimeMs,
        file: FTD_CURRENT_FILE,
        ftdRound: current.payload,
      });
    } catch (error) {
      sendFtdError(res, 500, "Failed to read FTD round", error.message);
    }
    return true;
  }

  if (pathname === "/api/ftd-round" && req.method === "POST") {
    try {
      const text = await readBody(req);
      const parsed = JSON.parse(text || "{}");
      const written = writeFtdRoundFile(parsed);
      revision += 1;
      broadcast({
        type: "ftd-round",
        revision,
        round: written.payload.round,
        competitionName: written.payload.competitionName,
        file: written.currentFile,
      });
      sendFtdJson(res, 200, {
        ok: true,
        file: written.file,
        currentFile: written.currentFile,
        ftdRound: written.payload,
      });
    } catch (error) {
      sendFtdError(res, 400, "Failed to write FTD round", error.message);
    }
    return true;
  }

  if (pathname === "/api/ftd-transcripts/prepare" && req.method === "POST") {
    try {
      const text = await readBody(req);
      const parsed = text.trim() ? JSON.parse(text) : {};
      const current = readStateFile().state;
      const packet = await prepareFtdTranscriptPacket(current, parsed);
      sendJson(res, 200, { ok: true, ...packet });
    } catch (error) {
      sendError(res, 400, "Failed to prepare FTD transcripts", error.message);
    }
    return true;
  }

  if (pathname === "/api/state" && req.method === "GET") {
    try {
      const current = readStateFile();
      sendJson(res, 200, {
        ok: true,
        revision,
        mtimeMs: current.mtimeMs,
        state: current.state,
      });
    } catch (error) {
      sendError(res, 500, "Failed to read shared state", error.message);
    }
    return true;
  }

  if (pathname === "/api/state" && req.method === "POST") {
    try {
      const text = await readBody(req);
      const parsed = JSON.parse(text || "{}");
      const state = parsed && parsed.state ? parsed.state : parsed;
      const source =
        parsed && typeof parsed.source === "string" ? parsed.source : "frontend";
      const baseRevision = Number(
        parsed && Object.prototype.hasOwnProperty.call(parsed, "baseRevision")
          ? parsed.baseRevision
          : state && state.localSync && state.localSync.baseRevision,
      );
      const current = readStateFile().state;
      const mergeResult = mergeStateForApiPost(state, current, {
        source,
        baseRevision,
        currentRevision: revision,
      });
      const written = writeStateFile(mergeResult.state, source);
      const egaAutoStart = maybeStartEgaAnalysisForNewReady(current, written.state);
      sendJson(res, 200, {
        ok: true,
        revision,
        mtimeMs: written.mtimeMs,
        state: written.state,
        preservedFtdPairings: mergeResult.preserved,
        preservedAgentPending: mergeResult.preservedPending || [],
        preservedFtdPlayerAccountMapping: Boolean(mergeResult.preservedFtdPlayerAccountMapping),
        preservedFtdPlayerRegistration: Boolean(mergeResult.preservedFtdPlayerRegistration),
        egaAutoStart,
      });
    } catch (error) {
      sendError(res, 400, "Failed to write shared state", error.message);
    }
    return true;
  }

  if (pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`data: ${JSON.stringify({ type: "hello", revision })}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return true;
  }

  return false;
}

function serveStatic(req, res, pathname) {
  const cleanPath = decodeURIComponent(pathname);
  const relative = cleanPath === "/" ? "index.html" : cleanPath.replace(/^\/+/, "");
  const target = path.resolve(ROOT, relative);

  if (!target.startsWith(ROOT + path.sep) && target !== ROOT) {
    sendError(res, 403, "Forbidden path");
    return;
  }

  let file = target;
  try {
    const stat = fs.existsSync(file) ? fs.statSync(file) : null;
    if (stat && stat.isDirectory()) file = path.join(file, "index.html");
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      sendError(res, 404, "Not found");
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const cacheControl =
      ext === ".html"
        ? "no-cache"
        : ext === ".js" || ext === ".css"
          ? "no-cache"
          : "public, max-age=3600";
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": cacheControl,
      ...(pathname === "/ftd-export.js"
        ? {
            "Access-Control-Allow-Origin": "https://www.flipthedisc.com",
            "Access-Control-Allow-Private-Network": "true",
          }
        : {}),
    });
    fs.createReadStream(file).pipe(res);
  } catch (error) {
    sendError(res, 500, "Failed to serve file", error.message);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || HOST}`);
  const pathname = url.pathname;

  try {
    if (req.method === "OPTIONS" && pathname === "/ftd-export.js") {
      setFtdCorsHeaders(res);
      res.writeHead(204, { "Cache-Control": "no-store" });
      res.end();
      return;
    }

    if (pathname.startsWith("/api/")) {
      const handled = await handleApi(req, res, pathname);
      if (handled) return;
      sendError(res, 404, "Unknown API endpoint");
      return;
    }

    serveStatic(req, res, pathname);
  } catch (error) {
    sendError(res, 500, "Unexpected server error", error.message);
  }
});

if (require.main === module) {
  ensureDataDir();
  watchStateFile();
  getAutomationRuntime();

  server.listen(PORT, HOST, () => {
    console.log(`[checkin] Local server: http://${HOST}:${PORT}/`);
    console.log(`[checkin] Shared state: ${STATE_FILE}`);
    console.log("[checkin] Stop with Ctrl+C.");
  });
}

module.exports = {
  normalizeFtdRoundPayload,
  rebuildFtdPlayerAccountMappingCounts,
  mappingRowNeedsManualOqValidation,
  fetchOqGameDetailForTranscript,
  prepareFtdTranscriptPacket,
  mergeFtdPlayerAccountMappingForAnyPost,
  mergeStateForApiPost,
  mergeScoreHelperFtdPairingsForFrontendPost,
  updateRoundScoresFromOq,
  readStateFile,
  writeStateFile,
  getAutomationRuntime,
  handleAutomationApi,
};
