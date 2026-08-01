#!/usr/bin/env node
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");
const { URL } = require("url");
const { runSelfCheck, paths: SELF_CHECK_PATHS } = require("./self-check.js");
const FTD_TRANSCRIPT = require("./ftd-transcript-shared.js");
const {
  EXPECTED_EXTENSION_ID,
  BridgeBroker,
  FtdAutopilotCoordinator,
} = require("./ftd-autopilot-coordinator.js");
const STATE_COMMANDS = require("./state-commands.js");

const ROOT = __dirname;
const REPO_ROOT = path.resolve(ROOT, "..", "..");
const WECHAT_DIR = path.join(REPO_ROOT, "wechat-decrypt");
const WECHAT_PY = path.join(WECHAT_DIR, ".venv", "Scripts", "python.exe");
const WECHAT_HELPER = path.join(WECHAT_DIR, "agent_tournament_helper.py");
const EGA_HELPER = path.join(WECHAT_DIR, "agent_egaroucid_analysis.py");
const MAP_COLLAB_SYNC_SCRIPT = path.join(REPO_ROOT, "cloudflare-map-collab", "tools", "sync-map-collab.js");
const MAP_COLLAB_CONFIG = path.join(REPO_ROOT, "cloudflare-map-collab", "map-collab.config.json");
const DEFAULT_DATA_DIR = path.join(ROOT, "data");
const STATE_FILE = process.env.CHECKIN_STATE_FILE
  ? path.resolve(process.env.CHECKIN_STATE_FILE)
  : path.join(DEFAULT_DATA_DIR, "checkin-state.json");
const DATA_DIR = process.env.CHECKIN_DATA_DIR
  ? path.resolve(process.env.CHECKIN_DATA_DIR)
  : process.env.CHECKIN_STATE_FILE
    ? path.dirname(STATE_FILE)
    : DEFAULT_DATA_DIR;
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
const AUTOMATION_VERSION = "ftd-autopilot.13";
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
let broadcastCount = 0;
let egaAnalysisProc = null;
let egaAnalysisStartedAt = "";
let egaAnalysisLastOutput = "";
let egaAnalysisLastError = "";
let egaAnalysisStopping = false;
let egaAnalysisLastLevel = 22;
let automationRuntime = null;
const noOpCommandIds = new Map();

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
  const writtenNicks = commitCapturedChanges(beforePush.state, stateWithNicks, "map-collab-refresh-wechat-nicks");
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
    {
      cwd: WECHAT_DIR,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CHECKIN_FRONTEND_STATE_API: `http://${HOST}:${PORT}/api/state` },
    },
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
    const state = STATE_COMMANDS.migrateState(JSON.parse(raw));
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      throw new Error("state file root must be an object");
    }
    revision = Math.max(revision, Number(state.localSync && state.localSync.revision) || 0);
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

function normalizeMappingRowKey(row) {
  if (!row || typeof row !== "object") return "";
  return normalizeMergeKey(row.ftdName || row.displayName || row.name || row.ftdId);
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
  let written;
  if (validation.checkedCount > 0) {
    const proposed = { ...current, ftdPlayerAccountMapping: rebuiltMapping };
    const diff = STATE_COMMANDS.diffState(current, proposed);
    const committed = commitStateCommand({
      commandId: `oq-account-validation-${crypto.randomUUID()}`,
      type: "entities.mutate",
      actor: "script",
      payload: { mutations: diff.mutations },
    }, "oq-account-validation");
    written = { state: readStateFile().state, mtimeMs: committed.mtimeMs };
  } else {
    written = { state: current, mtimeMs: readStateFile().mtimeMs };
  }
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

function persistStateFile(next, source, event) {
  validateState(next);
  ensureDataDir();
  const tmp = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, STATE_FILE);
  const stat = fs.statSync(STATE_FILE);
  lastMtimeMs = stat.mtimeMs;
  revision = Math.max(revision, Number(next.localSync && next.localSync.revision) || 0);
  if (event) broadcast({ ...event, revision, mtimeMs: lastMtimeMs, source });
  return { state: next, mtimeMs: lastMtimeMs };
}

function commitStateCommand(command, source) {
  const commandId = String(command && command.commandId || "").trim();
  if (commandId && noOpCommandIds.has(commandId)) return noOpCommandIds.get(commandId);
  const current = readStateFile();
  if (!current.state) throw new STATE_COMMANDS.CommandError("invalid-state", "shared state does not exist");
  const previous = current.state;
  const applied = STATE_COMMANDS.applyCommand(previous, command);
  if (!applied.changed) {
    const result = {
      ok: true,
      changed: false,
      idempotent: Boolean(applied.idempotent),
      revision: applied.revision,
      mtimeMs: current.mtimeMs,
      changedEntities: applied.changedEntities || [],
    };
    if (commandId && !applied.idempotent) {
      noOpCommandIds.set(commandId, result);
      if (noOpCommandIds.size > 500) noOpCommandIds.delete(noOpCommandIds.keys().next().value);
    }
    return result;
  }
  const nowMs = Date.now();
  applied.state.savedAt = nowMs;
  applied.state.localSync = {
    ...applied.state.localSync,
    source: source || command.actor || "command",
    savedAt: nowMs,
  };
  const written = persistStateFile(applied.state, source || command.actor || "command", {
    type: "entities",
    commandId,
    changedEntities: applied.changedEntities,
  });
  const egaAutoStart = maybeStartEgaAnalysisForNewReady(previous, written.state);
  return {
    ok: true,
    changed: true,
    idempotent: false,
    revision: applied.revision,
    mtimeMs: written.mtimeMs,
    changedEntities: applied.changedEntities,
    egaAutoStart,
  };
}

// Builds one atomic command from a caller's captured before/after states.
// Preconditions always come from the captured state, never from commit-time state.
function commitCapturedRoundImport(capturedState, nextState, source) {
  const localRound = Math.trunc(Number(nextState && nextState.ftdRound && nextState.ftdRound.round));
  const capturedHelper = capturedState && capturedState.scoreHelper;
  const nextHelper = nextState && nextState.scoreHelper;
  const capturedRound = capturedHelper && Array.isArray(capturedHelper.rounds) ? capturedHelper.rounds[localRound - 1] : null;
  const nextRound = nextHelper && Array.isArray(nextHelper.rounds) ? nextHelper.rounds[localRound - 1] : null;
  if (!capturedRound || !nextRound || !capturedRound.entityId || capturedRound.entityId !== nextRound.entityId) {
    throw new STATE_COMMANDS.CommandError("invalid-command", "captured AP round import scope is invalid");
  }
  const roundPatch = STATE_COMMANDS.clone(nextRound);
  delete roundPatch.ftdPairings;
  delete roundPatch.pending;
  delete roundPatch.manualPending;
  delete roundPatch.completed;
  delete roundPatch.entityId;
  delete roundPatch.entityRevision;
  const commandId = `${source || "ftd-autopilot-import"}-${crypto.randomUUID()}`;
  const result = commitStateCommand({
    commandId,
    type: "round.import",
    actor: "automation",
    target: { kind: "round", id: capturedRound.entityId },
    expectedRevision: capturedRound.entityRevision,
    preconditions: [
      { target: { kind: "scoreHelperMetadata", id: capturedHelper.entityId }, expectedRevision: capturedHelper.entityRevision },
      { target: { kind: "domain", id: "domain:ftdRound" }, expectedRevision: capturedState.localSync.domains.ftdRound.entityRevision },
      ...(capturedRound.ftdPairings || []).map((row) => ({
        target: { kind: "scoreRow", id: row.entityId },
        expectedRevision: row.entityRevision,
      })),
    ],
    payload: {
      pairings: nextRound.ftdPairings,
      roundPatch,
      scoreHelperPatch: {
        version: nextHelper.version,
        preliminaryRoundCount: nextHelper.preliminaryRoundCount,
        roundCount: nextHelper.roundCount,
        roundCountSource: nextHelper.roundCountSource,
        autoRoundCountPlayerCount: nextHelper.autoRoundCountPlayerCount,
        updatedAt: nextHelper.updatedAt,
      },
      ftdRound: nextState.ftdRound,
    },
  }, source || "ftd-autopilot-import");
  return { state: readStateFile().state, mtimeMs: result.mtimeMs, commandResult: result };
}

function commitCapturedChanges(capturedState, nextState, source) {
  if (!capturedState || !nextState) {
    throw new STATE_COMMANDS.CommandError("invalid-command", "captured and next state are required");
  }
  if (source === "ftd-autopilot-import") return commitCapturedRoundImport(capturedState, nextState, source);
  const diff = STATE_COMMANDS.diffState(capturedState, nextState);
  const result = commitStateCommand({
    commandId: `${source || "internal"}-${crypto.randomUUID()}`,
    type: "entities.mutate",
    actor: String(source || "script").startsWith("ftd-autopilot") ? "automation" : "script",
    payload: { mutations: diff.mutations },
  }, source || "internal-command");
  return { state: readStateFile().state, mtimeMs: result.mtimeMs, commandResult: result };
}

function getAutomationRuntime() {
  if (automationRuntime) return automationRuntime;
  const bridge = new BridgeBroker({ extensionId: EXPECTED_EXTENSION_ID });
  const coordinator = new FtdAutopilotCoordinator({
    dataDir: DATA_DIR,
    readState: readStateFile,
    writeState: (state, source, capturedState) => commitCapturedChanges(capturedState, state, source),
    getRevision: () => revision,
    updateOq: updateRoundScoresFromOq,
    fetchOqDetail: fetchOqGameDetailForTranscript,
    bridge,
  });
  automationRuntime = { bridge, coordinator };
  return automationRuntime;
}

function broadcast(payload) {
  broadcastCount += 1;
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
      if (!exactObjectKeys(parsed, ["tournamentId", "localRound", "localStage", "ftdUrl"], [])) throw Object.assign(new Error("automation scope schema rejected"), { statusCode: 400 });
      const result = pathname.endsWith("/probe") ? await coordinator.readOnlyProbe(parsed) : await coordinator.start(parsed);
      sendJson(res, 200, { ok: true, ...result });
      return true;
    }
    if (pathname === "/api/automation/claim" && req.method === "POST") {
      const raw = await readBody(req);
      const parsed = raw.trim() ? JSON.parse(raw) : {};
      if (!exactObjectKeys(parsed, ["sessionId"])) throw Object.assign(new Error("automation claim schema rejected"), { statusCode: 400 });
      sendJson(res, 200, { ok: true, ...coordinator.claimControl(String(parsed.sessionId)) });
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
      broadcastCount,
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
      sendJson(res, Number(error && error.statusCode) || 400, {
        ok: false,
        code: String(error && error.code || "oq-validation-failed"),
        error: "Failed to validate OQ accounts",
        detail: String(error && error.message || error),
        authoritativeEntity: error && error.authoritativeEntity,
      });
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

  if (pathname === "/api/state/commands" && req.method === "POST") {
    try {
      const text = await readBody(req);
      const parsed = JSON.parse(text || "{}");
      const result = commitStateCommand(parsed, String(parsed.actor || "command"));
      sendJson(res, 200, result);
    } catch (error) {
      const status = Number(error && error.statusCode) || 400;
      sendJson(res, status, {
        ok: false,
        code: String(error && error.code || "command-rejected"),
        error: String(error && error.message || error),
        expectedRevision: error && error.expectedRevision,
        currentRevision: error && error.currentRevision,
        authoritativeEntity: error && error.authoritativeEntity,
      });
    }
    return true;
  }

  if (pathname === "/api/state" && req.method === "POST") {
    try {
      const text = await readBody(req);
      const parsed = JSON.parse(text || "{}");
      const operation = String(parsed.operation || "").trim();
      if (operation !== "import" && operation !== "reset") {
        throw new STATE_COMMANDS.CommandError(
          "legacy-post-restricted",
          "full-state POST is restricted to explicit import/reset; use /api/state/commands",
        );
      }
      const expectedRevision = Number(parsed.expectedRevision);
      const currentRead = readStateFile();
      const current = currentRead.state;
      if (!Number.isInteger(expectedRevision) || expectedRevision !== revision) {
        throw new STATE_COMMANDS.CommandError("state-conflict", "full-state replacement revision is stale", {
          expectedRevision,
          currentRevision: revision,
        });
      }
      const state = STATE_COMMANDS.migrateState(parsed.state);
      validateState(state);
      const semanticCurrent = { ...current, savedAt: 0, localSync: { ...current.localSync, savedAt: 0, source: "" } };
      const semanticNext = { ...state, savedAt: 0, localSync: { ...state.localSync, savedAt: 0, source: "" } };
      if (STATE_COMMANDS.equal(semanticCurrent, semanticNext)) {
        sendJson(res, 200, { ok: true, changed: false, revision, mtimeMs: currentRead.mtimeMs, state: current });
        return true;
      }
      const nextRevision = revision + 1;
      const nowMs = Date.now();
      state.savedAt = nowMs;
      state.localSync = {
        ...state.localSync,
        revision: nextRevision,
        commandIds: [],
        source: `legacy-${operation}`,
        savedAt: nowMs,
      };
      const written = persistStateFile(state, `legacy-${operation}`, {
        type: "snapshot-replaced",
        operation,
        changedEntities: [],
      });
      sendJson(res, 200, {
        ok: true,
        changed: true,
        revision,
        mtimeMs: written.mtimeMs,
        state: written.state,
      });
    } catch (error) {
      sendJson(res, Number(error && error.statusCode) || 400, {
        ok: false,
        code: String(error && error.code || "state-replacement-rejected"),
        error: String(error && error.message || error),
        expectedRevision: error && error.expectedRevision,
        currentRevision: error && error.currentRevision,
      });
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
  if (fs.existsSync(STATE_FILE)) readStateFile();
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
  updateRoundScoresFromOq,
  readStateFile,
  commitCapturedChanges,
  commitStateCommand,
  getAutomationRuntime,
  handleAutomationApi,
};
