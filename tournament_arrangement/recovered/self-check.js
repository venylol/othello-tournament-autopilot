"use strict";

const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { execFile } = require("child_process");

const ROOT = __dirname;
const REPO_ROOT = path.resolve(ROOT, "..", "..");
const WECHAT_DIR = path.join(REPO_ROOT, "wechat-decrypt");
const WECHAT_PY = path.join(WECHAT_DIR, ".venv", "Scripts", "python.exe");
const TOURNAMENT_HELPER_CMD = path.join(WECHAT_DIR, "agent_tournament_helper.cmd");
const TOURNAMENT_HELPER_PY = path.join(WECHAT_DIR, "agent_tournament_helper.py");
const MATCH_HELPER_PY = path.join(WECHAT_DIR, "agent_match_image_helper.py");
const EGA_HELPER_PY = path.join(WECHAT_DIR, "agent_egaroucid_analysis.py");
const LAUNCHER = path.join(REPO_ROOT, "打开比赛签到程序.cmd");
const DATA_DIR = path.join(ROOT, "data");
const STATE_FILE = path.join(DATA_DIR, "checkin-state.json");
const RUNTIME_LOCK_FILE = path.join(DATA_DIR, "event-runtime-lock.json");
const SELF_CHECK_REPORT_FILE = path.join(DATA_DIR, "self-check-latest.json");
const FTD_CURRENT_FILE = path.join(DATA_DIR, "ftd-round-current.json");
const EGA_CACHE_DIR = path.join(DATA_DIR, "ega-analysis");
const EGA_SELF_CHECK_CACHE_DIR = path.join(DATA_DIR, "ega-analysis-self-check");
const EGA_ENGINE_EXE = path.join(
  REPO_ROOT,
  "Egaroucid_for_Console_7_8_1_Windows_AVX512_AMD",
  "Egaroucid_for_Console_7_8_1_AVX512_AMD.exe",
);
const MAP_COLLAB_SYNC_SCRIPT = path.join(REPO_ROOT, "cloudflare-map-collab", "tools", "sync-map-collab.js");
const MAP_COLLAB_CONFIG = path.join(REPO_ROOT, "cloudflare-map-collab", "map-collab.config.json");
const FRONTEND_API = "http://127.0.0.1:4174/api/state";
const FRONTEND_ROOT = "http://127.0.0.1:4174/";
const HOST = process.env.CHECKIN_HOST || "127.0.0.1";
const PORT = Number(process.env.CHECKIN_PORT || process.env.PORT || 4174);
const OQ_ACCOUNT_RE = /^[A-Za-z0-9_]{1,14}$/;

function normalize(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

function normalizeKey(value) {
  return normalize(value).toLowerCase();
}

function accountKey(value) {
  return normalize(value).replace(/[\s_-]+/g, "").toLowerCase();
}

function readText(file) {
  return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
}

function readJson(file) {
  return JSON.parse(readText(file));
}

function existsFile(file) {
  try {
    return fs.existsSync(file) && fs.statSync(file).isFile();
  } catch (_) {
    return false;
  }
}

function existsDir(dir) {
  try {
    return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
  } catch (_) {
    return false;
  }
}

function canWriteDir(dir) {
  const probe = path.join(dir, `.self-check-${process.pid}-${Date.now()}.tmp`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(probe, "ok", "utf8");
  fs.unlinkSync(probe);
  return true;
}

function shaPath(file) {
  try {
    const stat = fs.statSync(file);
    return `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  } catch (_) {
    return "";
  }
}

function execFileText(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd || ROOT,
        windowsHide: true,
        timeout: options.timeout || 10000,
        maxBuffer: options.maxBuffer || 2 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
          error: error ? String(error.message || error) : "",
          code: error && typeof error.code !== "undefined" ? error.code : 0,
        });
      },
    );
  });
}

function fetchJson(url, options = {}) {
  const timeout = Math.max(500, Number(options.timeout || 5000));
  const parsed = new URL(url);
  return new Promise((resolve) => {
    const req = http.request(
      {
        method: options.method || "GET",
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: `${parsed.pathname}${parsed.search}`,
        headers: options.headers || {},
        timeout,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch (_) {
            // keep json null
          }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json, text });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", (error) => {
      resolve({ ok: false, status: 0, json: null, text: "", error: String(error.message || error) });
    });
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function fetchRemoteJson(url, timeoutMs = 7000) {
  const parsed = new URL(url);
  const client = parsed.protocol === "https:" ? https : http;
  return new Promise((resolve) => {
    const req = client.request(
      {
        method: "GET",
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        headers: { "User-Agent": "open-event-local-self-check/1.0" },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch (_) {
            // keep json null
          }
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300 && Boolean(json),
            status: res.statusCode,
            json,
            error: json ? "" : "non-json response",
          });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (error) => {
      resolve({ ok: false, status: 0, json: null, error: String(error && error.message ? error.message : error) });
    });
    req.end();
  });
}

class SelfCheck {
  constructor(options) {
    this.options = options;
    this.items = [];
  }

  add(component, name, status, fields = {}) {
    this.items.push({
      component,
      name,
      status,
      actualPath: fields.actualPath || "",
      expectedPath: fields.expectedPath || "",
      actual: fields.actual || "",
      expected: fields.expected || "",
      reason: fields.reason || "",
      suggestion: fields.suggestion || "",
      details: fields.details || undefined,
    });
  }

  pass(component, name, fields) {
    this.add(component, name, "pass", fields);
  }

  warn(component, name, fields) {
    this.add(component, name, "warn", fields);
  }

  fail(component, name, fields) {
    this.add(component, name, "fail", fields);
  }
}

function statusCounts(items) {
  return items.reduce(
    (acc, item) => {
      acc[item.status] = (acc[item.status] || 0) + 1;
      return acc;
    },
    { pass: 0, warn: 0, fail: 0 },
  );
}

function currentQuarterSeason(date) {
  const month = date.getMonth();
  return {
    season: Math.floor(month / 3) + 1,
    round: (month % 3) + 1,
  };
}

function expectedTournamentName(date) {
  const q = currentQuarterSeason(date);
  return `Broadway Online Cup ${date.getFullYear()}-S${q.season}-${q.round}`;
}

function scoreRounds(state) {
  const helper = state && state.scoreHelper && typeof state.scoreHelper === "object" ? state.scoreHelper : {};
  return Array.isArray(helper.rounds) ? helper.rounds : [];
}

function activeRoundObject(state, roundNo) {
  const rounds = scoreRounds(state);
  const helper = state && state.scoreHelper && typeof state.scoreHelper === "object" ? state.scoreHelper : {};
  const target = Math.max(1, Math.trunc(Number(roundNo || helper.activeRound || 1)));
  return rounds.find((round) => Number(round && round.round) === target) || rounds[target - 1] || null;
}

function collectPairings(state) {
  const rows = [];
  for (const round of scoreRounds(state)) {
    const roundNo = Math.max(1, Math.trunc(Number(round && round.round) || rows.length + 1));
    const pairings = Array.isArray(round && round.ftdPairings) ? round.ftdPairings : [];
    for (const item of pairings) {
      if (item && typeof item === "object") rows.push({ round: roundNo, item });
    }
  }
  return rows;
}

function isByeName(value) {
  return normalize(value).toLowerCase() === "bye";
}

function scorePairOk(item) {
  const black = Number(item && item.blackScore);
  const white = Number(item && item.whiteScore);
  return Number.isFinite(black) && Number.isFinite(white) && black + white === 64 && black >= 0 && white >= 0;
}

function rosterPlayers(state) {
  return Array.isArray(state && state.players) ? state.players.filter((p) => p && typeof p === "object") : [];
}

function mappingRows(state) {
  const mapping = state && state.ftdPlayerAccountMapping && typeof state.ftdPlayerAccountMapping === "object"
    ? state.ftdPlayerAccountMapping
    : {};
  return Array.isArray(mapping.players) ? mapping.players.filter((row) => row && typeof row === "object") : [];
}

function mappingRowDeleted(row) {
  return row.deleted === true || normalize(row.status).toLowerCase() === "deleted";
}

function mappingAccount(row) {
  return normalize(row.oqAccount || row.account || row.oq || row.playerAccount);
}

function mappingFtdName(row) {
  return normalize(row.ftdName || row.name || row.playerName || row.displayName);
}

function loadState(check) {
  if (!existsFile(STATE_FILE)) {
    check.fail("state", "checkin-state.json exists", {
      actualPath: STATE_FILE,
      expectedPath: STATE_FILE,
      reason: "Shared state file is missing.",
      suggestion: "Start the local page once with 打开比赛签到程序.cmd and import/review the current roster.",
    });
    return null;
  }
  try {
    const state = readJson(STATE_FILE);
    check.pass("state", "checkin-state.json parses", { actualPath: STATE_FILE, expectedPath: STATE_FILE });
    return state;
  } catch (error) {
    check.fail("state", "checkin-state.json parses", {
      actualPath: STATE_FILE,
      expectedPath: STATE_FILE,
      reason: String(error && error.message ? error.message : error),
      suggestion: "Fix JSON syntax through the local state API or restore a clean backup.",
    });
    return null;
  }
}

function checkFile(check, component, name, actualPath, suggestion) {
  if (existsFile(actualPath)) {
    check.pass(component, name, { actualPath, expectedPath: actualPath });
    return true;
  }
  check.fail(component, name, {
    actualPath,
    expectedPath: actualPath,
    reason: "Required file is missing.",
    suggestion,
  });
  return false;
}

function checkDirWritable(check, component, name, dir, suggestion) {
  try {
    canWriteDir(dir);
    check.pass(component, name, { actualPath: dir, expectedPath: dir });
    return true;
  } catch (error) {
    check.fail(component, name, {
      actualPath: dir,
      expectedPath: dir,
      reason: String(error && error.message ? error.message : error),
      suggestion,
    });
    return false;
  }
}

async function checkEnvironment(check) {
  const node = await execFileText("node", ["--version"], { cwd: ROOT, timeout: 5000 });
  if (node.ok) check.pass("environment", "Node is available", { actual: normalize(node.stdout) });
  else check.fail("environment", "Node is available", { reason: node.stderr || node.error, suggestion: "Install Node.js and keep it in PATH." });

  checkFile(check, "environment", "launcher exists", LAUNCHER, "Use the official root launcher, not an ad-hoc server command.");
  checkFile(check, "environment", "agent_tournament_helper.cmd exists", TOURNAMENT_HELPER_CMD, "Restore wechat-decrypt\\agent_tournament_helper.cmd.");
  checkFile(check, "environment", "agent_tournament_helper.py exists", TOURNAMENT_HELPER_PY, "Restore wechat-decrypt\\agent_tournament_helper.py.");
  checkFile(check, "environment", "wechat-decrypt venv Python exists", WECHAT_PY, "Create/install wechat-decrypt\\.venv before competition day.");
  checkFile(check, "environment", "match image helper exists", MATCH_HELPER_PY, "Restore agent_match_image_helper.py.");

  if (existsFile(WECHAT_PY)) {
    const py = await execFileText(WECHAT_PY, ["--version"], { cwd: WECHAT_DIR, timeout: 5000 });
    if (py.ok) check.pass("environment", "Python venv runs", { actual: normalize(py.stdout || py.stderr), actualPath: WECHAT_PY });
    else check.fail("environment", "Python venv runs", { actualPath: WECHAT_PY, reason: py.stderr || py.error });
  }

  const health = await fetchJson(`http://${HOST}:${PORT}/api/health?t=${Date.now()}`, { timeout: 2500 });
  if (health.ok && health.json && health.json.ok === true) {
    check.pass("environment", "local-server.js API is running", {
      actual: `http://${HOST}:${PORT}/api/health`,
      actualPath: health.json.stateFile || "",
      expectedPath: STATE_FILE,
    });
  } else {
    check.fail("environment", "local-server.js API is running", {
      actual: `http://${HOST}:${PORT}/api/health`,
      reason: health.error || `HTTP ${health.status}`,
      suggestion: "Run 打开比赛签到程序.cmd and verify http://127.0.0.1:4174/ before check-in.",
    });
  }

  const apiState = await fetchJson(`${FRONTEND_API}?t=${Date.now()}`, { timeout: 3000 });
  if (apiState.ok && apiState.json && apiState.json.ok === true) {
    check.pass("environment", "/api/state is readable", {
      actual: FRONTEND_API,
      actualPath: apiState.json.stateFile || STATE_FILE,
      expectedPath: STATE_FILE,
    });
  } else {
    check.fail("environment", "/api/state is readable", {
      actual: FRONTEND_API,
      reason: apiState.error || `HTTP ${apiState.status}`,
      suggestion: "Fix local-server.js before starting check-in; agent writes must go through /api/state.",
    });
  }

  checkDirWritable(check, "environment", "data directory writable", DATA_DIR, "Check permissions on recovered\\data.");
  checkDirWritable(check, "environment", "EG cache directory writable", EGA_CACHE_DIR, "Create recovered\\data\\ega-analysis or fix permissions.");
  checkDirWritable(check, "environment", "WeChat decoded image directory writable", path.join(WECHAT_DIR, "decoded_images"), "Create wechat-decrypt\\decoded_images or fix permissions.");
  checkDirWritable(check, "environment", "WeChat agent cache writable", path.join(WECHAT_DIR, "agent_cache"), "Create wechat-decrypt\\agent_cache or fix permissions.");

  const cwd = path.resolve(process.cwd());
  if (/青少年模拟|June_newcommer_test/i.test(cwd)) {
    check.fail("environment", "current working directory is official open-event workspace", {
      actualPath: cwd,
      expectedPath: REPO_ROOT,
      reason: "The self-check is being run from a simulation/youth directory.",
      suggestion: "Run from C:\\Users\\MeroAF\\Desktop\\比赛编排.",
    });
  } else {
    check.pass("environment", "current working directory is not youth simulation", { actualPath: cwd, expectedPath: REPO_ROOT });
  }
}

function checkNoForbiddenRefs(check) {
  const files = [
    path.join(ROOT, "local-server.js"),
    path.join(ROOT, "app.js"),
    path.join(ROOT, "index.html"),
    path.join(ROOT, "styles.css"),
    path.join(ROOT, "README.md"),
    TOURNAMENT_HELPER_PY,
    MATCH_HELPER_PY,
    EGA_HELPER_PY,
    TOURNAMENT_HELPER_CMD,
    LAUNCHER,
  ].filter(existsFile);
  const forbidden = [
    /repo_practiceAI/i,
    /othelloquest_egaroucid/i,
    /青少年模拟/i,
    /wrangler\s+pages\s+deploy/i,
    /wrangler\s+deploy/i,
  ];
  const hits = [];
  for (const file of files) {
    const text = readText(file);
    for (const pattern of forbidden) {
      if (pattern.test(text)) hits.push({ file, pattern: String(pattern) });
    }
  }
  if (hits.length) {
    check.fail("environment", "no hard dependency on unrelated repo or deploy command", {
      reason: "Forbidden path/deploy reference found.",
      details: hits.slice(0, 20),
      suggestion: "Remove hard-coded simulation repo paths and Cloudflare deploy commands from official flow files.",
    });
  } else {
    check.pass("environment", "no hard dependency on unrelated repo or deploy command");
  }
}

function checkState(check, state, options) {
  if (!state) return;

  if (path.resolve(STATE_FILE) === path.resolve(path.join(REPO_ROOT, "tournament_arrangement", "recovered", "data", "checkin-state.json"))) {
    check.pass("state", "state path is official open-event path", { actualPath: STATE_FILE, expectedPath: STATE_FILE });
  } else {
    check.fail("state", "state path is official open-event path", { actualPath: STATE_FILE, expectedPath: path.join(REPO_ROOT, "tournament_arrangement", "recovered", "data", "checkin-state.json") });
  }

  const expectedName = expectedTournamentName(new Date());
  const competitionName = normalize(state.competitionName);
  if (!competitionName || competitionName === "比赛签到表") {
    check.warn("state", "tournament name is set", {
      actual: competitionName || "(empty)",
      expected: expectedName,
      reason: "Tournament name still looks like the default.",
      suggestion: `Before check-in, set the official name. Current-month rule suggests: ${expectedName}.`,
    });
  } else {
    check.pass("state", "tournament name is set", { actual: competitionName, expected: expectedName });
  }

  if (options.event === "open") {
    if (/新人|青少年|模拟/.test(competitionName)) {
      check.fail("state", "state belongs to official open event", {
        actual: competitionName,
        expected: "网赛无差别组 / open event",
        reason: "Tournament name indicates another event lane.",
        suggestion: "Load or create the official no-handicap/open-event state before check-in.",
      });
    } else if (/无差别|Broadway Online Cup/i.test(competitionName)) {
      check.pass("state", "state belongs to official open event", { actual: competitionName });
    } else {
      check.warn("state", "state belongs to official open event", {
        actual: competitionName,
        expected: "name should clearly identify the no-handicap/open event",
        suggestion: "Confirm this state is not from another lane before starting check-in.",
      });
    }
  }

  const players = rosterPlayers(state);
  if (players.length) check.pass("state", "roster is readable", { actual: String(players.length) });
  else check.warn("state", "roster is readable", { actual: "0", reason: "No roster players are currently imported." });

  const byName = new Map();
  const byAccount = new Map();
  const dupNames = [];
  const dupAccounts = [];
  const missingAccounts = [];
  const suspectAccounts = [];
  for (const player of players) {
    const name = normalize(player.displayName || player.name || player.rawName);
    const account = normalize(player.account || player.oqAccount);
    if (name) {
      const key = normalizeKey(name);
      if (byName.has(key)) dupNames.push(name);
      byName.set(key, player);
    }
    if (!account) {
      missingAccounts.push(name || player.id || "(unnamed)");
    } else {
      const key = accountKey(account);
      if (byAccount.has(key)) dupAccounts.push(account);
      byAccount.set(key, player);
      if (!OQ_ACCOUNT_RE.test(account)) suspectAccounts.push({ name, account });
    }
  }
  if (dupNames.length) check.warn("state", "duplicate player names", { reason: "Duplicate display names found.", details: dupNames.slice(0, 30), suggestion: "Review whether these are real duplicate names or parse mistakes." });
  else check.pass("state", "duplicate player names");
  if (dupAccounts.length) check.fail("state", "duplicate OQ accounts in roster", { reason: "Duplicate accounts affect deterministic check-in/score mapping.", details: dupAccounts.slice(0, 30), suggestion: "Fix duplicate accounts before check-in." });
  else check.pass("state", "duplicate OQ accounts in roster");
  if (missingAccounts.length) check.warn("state", "missing OQ accounts in roster", { actual: String(missingAccounts.length), details: missingAccounts.slice(0, 30), suggestion: "Fill missing OQ accounts where the player is expected to play online." });
  else check.pass("state", "missing OQ accounts in roster");
  if (suspectAccounts.length) check.warn("state", "suspect OQ account format in roster", { details: suspectAccounts.slice(0, 30), suggestion: "OQ accounts should be 1-14 ASCII letters/digits/underscore." });
  else check.pass("state", "suspect OQ account format in roster");

  const helper = state.scoreHelper && typeof state.scoreHelper === "object" ? state.scoreHelper : {};
  const activeRound = Math.max(1, Math.trunc(Number(options.round || helper.activeRound || 1)));
  const round = activeRoundObject(state, activeRound);
  const ftdRound = state.ftdRound && typeof state.ftdRound === "object" ? state.ftdRound : null;
  if (ftdRound && Number(ftdRound.round) && Number(ftdRound.round) !== activeRound && options.round) {
    check.warn("state", "activeRound and ftdRound alignment", {
      actual: `active=${activeRound}, ftdRound=${ftdRound.round}`,
      reason: "Imported FTD round metadata does not match requested self-check round.",
      suggestion: "Import the current round JSON in the frontend before score polling.",
    });
  } else {
    check.pass("state", "activeRound and ftdRound alignment", { actual: `active=${activeRound}, ftdRound=${ftdRound ? ftdRound.round || "" : ""}` });
  }

  const pairings = collectPairings(state);
  const stats = { imported: 0, dirty: 0, ready: 0, completed: 0, other: 0 };
  const badScores = [];
  const missingEditor = [];
  for (const { round: roundNo, item } of pairings) {
    const status = normalize(item.status || "imported").toLowerCase();
    if (Object.prototype.hasOwnProperty.call(stats, status)) stats[status] += 1;
    else stats.other += 1;
    if ((status === "ready" || status === "completed") && !scorePairOk(item) && !isByeName(item.black) && !isByeName(item.white)) {
      badScores.push({ round: roundNo, table: item.table, blackScore: item.blackScore, whiteScore: item.whiteScore });
    }
    if ((status === "ready" || status === "completed") && !normalize(item.lastEditedBy)) {
      missingEditor.push({ round: roundNo, table: item.table, status });
    }
  }
  check.pass("state", "pending/dirty/ready/completed statistics", { details: stats });
  if (badScores.length) check.fail("score", "ready/completed scores sum to 64", { details: badScores.slice(0, 30), reason: "A registered score does not satisfy blackScore + whiteScore = 64." });
  else check.pass("score", "ready/completed scores sum to 64");
  if (missingEditor.length) check.fail("score", "resultEditorAudit source is present", { details: missingEditor.slice(0, 30), reason: "Ready/completed rows must show lastEditedBy agent/user before stopping polling." });
  else check.pass("score", "resultEditorAudit source is present");

  const activePairings = round && Array.isArray(round.ftdPairings) ? round.ftdPairings : [];
  if (options.round && !activePairings.length) {
    check.fail("score", "requested round FTD JSON is imported", {
      actual: `round ${activeRound}`,
      reason: "score-scan must not run without the current round FTD table.",
      suggestion: "Use the frontend 导入本轮 JSON flow for the requested round.",
    });
  } else if (activePairings.length) {
    const tables = activePairings.map((item, index) => Number(item && item.table) || index + 1);
    const missingTables = [];
    for (let i = 1; i <= Math.max(...tables); i += 1) {
      if (!tables.includes(i)) missingTables.push(i);
    }
    if (missingTables.length) check.warn("score", "current round table numbers are contiguous", { details: missingTables, suggestion: "Verify the imported FTD JSON; do not infer tables from the check-in roster." });
    else check.pass("score", "current round table numbers are contiguous", { actual: `${activePairings.length} tables` });
  } else {
    check.warn("score", "current round FTD JSON is imported", { actual: `round ${activeRound}`, reason: "No current-round pairings found yet. This is acceptable before score registration." });
  }
}

function checkMapping(check, state) {
  if (!state) return;
  const mapping = state.ftdPlayerAccountMapping && typeof state.ftdPlayerAccountMapping === "object"
    ? state.ftdPlayerAccountMapping
    : null;
  const rows = mappingRows(state).filter((row) => !mappingRowDeleted(row));
  if (!mapping || !rows.length) {
    check.warn("mapping", "FTD player/OQ mapping exists", {
      reason: "No shared FTD player mapping table is present yet.",
      suggestion: "Before check-in, run build-ftd-map-draft, agent review patch-ftd-map, then validate-and-publish-ftd-map.",
    });
  } else {
    check.pass("mapping", "FTD player/OQ mapping exists", { actual: `${rows.length} rows` });
  }

  const emptyAccounts = [];
  const duplicateAccounts = [];
  const suspectAccounts = [];
  const byAccount = new Map();
  for (const row of rows) {
    const account = mappingAccount(row);
    const name = mappingFtdName(row);
    if (!account) {
      emptyAccounts.push(name || "(unnamed)");
      continue;
    }
    if (!OQ_ACCOUNT_RE.test(account)) suspectAccounts.push({ name, account });
    const key = accountKey(account);
    if (byAccount.has(key)) duplicateAccounts.push(account);
    byAccount.set(key, row);
  }
  if (emptyAccounts.length) check.warn("mapping", "mapping OQ accounts are non-empty", { actual: String(emptyAccounts.length), details: emptyAccounts.slice(0, 30), suggestion: "Only deterministic agent-reviewed additions should be patched; do not guess." });
  else if (rows.length) check.pass("mapping", "mapping OQ accounts are non-empty");
  if (duplicateAccounts.length) check.fail("mapping", "mapping OQ accounts are unique", { details: duplicateAccounts.slice(0, 30), reason: "Duplicate OQ mapping rows can corrupt score sender/account gates." });
  else check.pass("mapping", "mapping OQ accounts are unique");
  if (suspectAccounts.length) check.warn("mapping", "mapping OQ account format", { details: suspectAccounts.slice(0, 30), suggestion: "Review spelling; OQ accounts should be 1-14 ASCII letters/digits/underscore." });
  else check.pass("mapping", "mapping OQ account format");

  const rosterByAccount = new Set(rosterPlayers(state).map((p) => accountKey(p.account || p.oqAccount)).filter(Boolean));
  const rosterByName = new Set(rosterPlayers(state).map((p) => normalizeKey(p.displayName || p.name || p.rawName)).filter(Boolean));
  const unmappedToRoster = rows.filter((row) => {
    const account = accountKey(mappingAccount(row));
    const name = normalizeKey(mappingFtdName(row));
    return !(account && rosterByAccount.has(account)) && !(name && rosterByName.has(name));
  });
  if (rows.length && unmappedToRoster.length) {
    check.warn("mapping", "roster and FTD players correspond", {
      actual: `${unmappedToRoster.length}/${rows.length} not matched`,
      details: unmappedToRoster.slice(0, 30).map((row) => ({ ftdName: mappingFtdName(row), oqAccount: mappingAccount(row) })),
      suggestion: "Review whether these are withdrawals, naming differences, or mapping mistakes.",
    });
  } else if (rows.length) {
    check.pass("mapping", "roster and FTD players correspond");
  }

  const nickPool = state.wechatGroupNicks || (mapping && mapping.wechatGroupNicks) || null;
  const nickCount = Array.isArray(nickPool && nickPool.groupNicks) ? nickPool.groupNicks.filter(Boolean).length : 0;
  if (nickCount) check.pass("mapping", "WeChat group nickname candidates are available", { actual: `${nickCount} nicks` });
  else check.warn("mapping", "WeChat group nickname candidates are available", { reason: "No nickname candidate pool in state.", suggestion: "Refresh group members before mapping review." });
}

async function checkOqRegression(check, state) {
  if (!existsFile(WECHAT_PY) || !existsFile(MATCH_HELPER_PY)) return;
  const script = [
    "import json",
    "import agent_match_image_helper as h",
    "print(json.dumps({'parts': h.oq_terminal_status_parts('LOSE:RESIGN'), 'cause': h.oq_terminal_cause_from_status('LOSE:RESIGN')}))",
  ].join("\n");
  const result = await execFileText(WECHAT_PY, ["-c", script], { cwd: WECHAT_DIR, timeout: 10000 });
  if (!result.ok) {
    check.fail("oq", "terminal result parser regression test runs", { reason: result.stderr || result.error });
    return;
  }
  try {
    const parsed = JSON.parse(result.stdout.trim());
    if (Array.isArray(parsed.parts) && parsed.parts[0] === "lose" && parsed.parts[1] === "resign" && parsed.cause === "resign") {
      check.pass("oq", "LOSE:RESIGN terminal parser regression", { actual: "lose/resign" });
    } else {
      check.fail("oq", "LOSE:RESIGN terminal parser regression", { actual: JSON.stringify(parsed), expected: "lose/resign" });
    }
  } catch (error) {
    check.fail("oq", "terminal result parser regression test parses", { reason: String(error && error.message ? error.message : error), actual: result.stdout });
  }

  const sampleAccount = mappingRows(state || {})
    .map(mappingAccount)
    .find((account) => OQ_ACCOUNT_RE.test(account));
  if (!sampleAccount) {
    check.warn("oq", "OQ list API reachable", { reason: "No valid mapped account is available for a harmless list API probe." });
    return;
  }
  const remote = await fetchRemoteJson(`http://questgames.net/games/reversi/${encodeURIComponent(sampleAccount.toLowerCase())}.json`, 6000);
  if (remote.ok) check.pass("oq", "OQ list API reachable", { actual: sampleAccount });
  else check.warn("oq", "OQ list API reachable", { actual: sampleAccount, reason: remote.error || `HTTP ${remote.status}`, suggestion: "Network/OQ may be temporarily unavailable; verify before relying on OQ auto-update." });
}

async function runHero9OqProbe() {
  const script = [
    "import json",
    "import agent_match_image_helper as h",
    "account = 'hero9'",
    "client = h.DirectOQClient(base_url='http://questgames.net', timeout=10)",
    "games = client.fetch_games(account, '5min', include_details=False)",
    "errors = []",
    "chosen = None",
    "for entry in games[:12]:",
    "    try:",
    "        entry, fetched = h.oq_entry_with_detail(entry, 'http://questgames.net', 10, {})",
    "        black, white, reason = h.oq_score_from_entry(entry)",
    "        detail = h.oq_extract_detail_from_entry(entry)",
    "        moves = h.oq_detail_moves(detail)",
    "        transcript = ''.join(str(m.get('m') or '') for m in moves if isinstance(m, dict) and h.OQ_MOVE_RE.match(str(m.get('m') or '').strip()))",
    "        chosen = {",
    "            'summary': h.game_entry_summary(entry),",
    "            'blackScore': black,",
    "            'whiteScore': white,",
    "            'scoreSum': black + white,",
    "            'reason': reason,",
    "            'moveCount': len(moves),",
    "            'transcriptMoveCount': len(transcript) // 2,",
    "            'transcriptMoves': transcript,",
    "            'detailFetched': fetched,",
    "            'hasPositionMoves': bool(moves),",
    "        }",
    "        break",
    "    except Exception as exc:",
    "        errors.append({'gameId': getattr(entry, 'game_id', ''), 'error': str(exc)[:220]})",
    "print(json.dumps({'ok': bool(chosen), 'account': account, 'mode': '5min', 'listCount': len(games), 'chosen': chosen, 'errors': errors[:5]}, ensure_ascii=False))",
  ].join("\n");
  const result = await execFileText(WECHAT_PY, ["-c", script], {
    cwd: WECHAT_DIR,
    timeout: 30000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (!result.ok) {
    return { ok: false, error: result.stderr || result.error || result.stdout };
  }
  try {
    return JSON.parse(result.stdout.trim());
  } catch (error) {
    return { ok: false, error: `failed to parse hero9 probe JSON: ${error.message}`, stdout: result.stdout };
  }
}

async function checkHero9OqActual(check, options) {
  if (!options.full) {
    check.warn("oq", "hero9 actual list/detail/score self-check", {
      reason: "Skipped outside --full to keep check-in-ready fast.",
      suggestion: "Run self-check --full --event open before competition day.",
    });
    return null;
  }
  if (!existsFile(WECHAT_PY) || !existsFile(MATCH_HELPER_PY)) return null;
  const probe = await runHero9OqProbe();
  if (!probe.ok || !probe.chosen) {
    check.fail("oq", "hero9 actual list/detail/score self-check", {
      reason: probe.error || "No usable hero9 game detail could be replayed.",
      details: probe.errors || undefined,
      suggestion: "Verify OQ network access and the DirectOQClient detail parser before relying on OQ import/update.",
    });
    return null;
  }
  const chosen = probe.chosen;
  const summary = chosen.summary || {};
  if (Number(probe.listCount) > 0) {
    check.pass("oq", "hero9 OQ list query", {
      actual: `hero9 ${probe.mode || "5min"} games=${probe.listCount}`,
      details: {
        gameId: summary.gameId,
        createdLocal: summary.createdLocal || summary.createdAt,
      },
    });
  } else {
    check.fail("oq", "hero9 OQ list query", { reason: "OQ list returned zero games for hero9." });
  }
  if (summary.gameId && chosen.hasPositionMoves) {
    check.pass("oqimport", "hero9 game detail imports position.moves", {
      actual: `${summary.gameId}, moves=${chosen.moveCount}`,
      details: {
        blackName: summary.blackName,
        whiteName: summary.whiteName,
        status: summary.status,
      },
    });
  } else {
    check.fail("oqimport", "hero9 game detail imports position.moves", {
      reason: "Fetched detail did not expose a usable game id and position.moves.",
      details: chosen,
    });
  }
  if (Number(chosen.scoreSum) === 64) {
    check.pass("oq", "hero9 actual score replay sums to 64", {
      actual: `${summary.gameId}: ${chosen.blackScore}-${chosen.whiteScore}`,
      details: {
        reason: chosen.reason,
        blackName: summary.blackName,
        whiteName: summary.whiteName,
      },
    });
  } else {
    check.fail("oq", "hero9 actual score replay sums to 64", {
      actual: `${chosen.blackScore}-${chosen.whiteScore}`,
      reason: "Replayed score does not sum to 64.",
      details: chosen,
    });
  }
  return probe;
}

function checkWechatAndImages(check, state, options) {
  const expectedGroup = `【${new Date().getMonth() + 1}月无差别组】栢龙杯棋王赛`;
  const mapping = state && state.ftdPlayerAccountMapping && typeof state.ftdPlayerAccountMapping === "object" ? state.ftdPlayerAccountMapping : {};
  const groupName = normalize(options.group || mapping.groupName || mapping.group || expectedGroup);
  if (/无差别/.test(groupName)) check.pass("wechat", "target group name is open-event group", { actual: groupName, expected: expectedGroup });
  else check.warn("wechat", "target group name is open-event group", { actual: groupName, expected: expectedGroup, suggestion: "Pass --group explicitly if the current month group name differs." });

  checkFile(check, "wechat", "WeChat helper is executable through wrapper", TOURNAMENT_HELPER_CMD, "Use wechat-decrypt\\agent_tournament_helper.cmd only.");
  checkDirWritable(check, "wechat", "PNG output directory is writable", path.join(WECHAT_DIR, "decoded_images"), "Fix decoded_images permissions before score images arrive.");

  const helperText = existsFile(MATCH_HELPER_PY) ? readText(MATCH_HELPER_PY) : "";
  if (/import\s+(paddleocr|easyocr|pytesseract)|from\s+(paddleocr|easyocr|pytesseract)\s+import/i.test(helperText)) {
    check.fail("wechat", "score-scan does not use OCR/PaddleOCR", { reason: "OCR import found in score helper." });
  } else {
    check.pass("wechat", "score-scan does not use OCR/PaddleOCR");
  }
  if (/第 \{round_no\} 轮没有 FTD 配对表|score-scan needs a start time|pngPaths|bot\/referee/i.test(helperText)) {
    check.pass("wechat", "score-scan source contains current-round FTD and pngPaths gates");
  } else {
    check.warn("wechat", "score-scan source contains current-round FTD and pngPaths gates", { reason: "Could not confirm all gate strings in helper source." });
  }
}

function checkScoreDryRun(check, state) {
  const fixture = {
    scoreHelper: {
      activeRound: 1,
      roundCount: 1,
      rounds: [
        {
          round: 1,
          pending: [],
          manualPending: [],
          completed: [],
          ftdPairings: [
            { table: 1, black: "Alpha", white: "Beta", status: "imported", blackScore: null, whiteScore: null },
            { table: 2, black: "Gamma", white: "Delta", status: "dirty", blackScore: 33, whiteScore: 31, dirty: true },
          ],
        },
      ],
    },
  };
  const round = fixture.scoreHelper.rounds[0];
  const readyWrite = { ...round.ftdPairings[0], blackScore: 64, whiteScore: 0, status: "ready", lastEditedBy: "agent" };
  round.ftdPairings[0] = readyWrite;
  round.pending.push({ table: 2, dirty: true, verdict: "self-check-dirty-fixture" });
  const readyOk = readyWrite.status === "ready" && readyWrite.status !== "completed" && scorePairOk(readyWrite);
  const dirtyNotCompleted = round.ftdPairings[1].status === "dirty" && round.ftdPairings[1].status !== "completed";
  if (readyOk && dirtyNotCompleted && round.pending.length === 1) {
    check.pass("score", "zero-round dry-run ready/pending/dirty invariants");
  } else {
    check.fail("score", "zero-round dry-run ready/pending/dirty invariants", { details: fixture });
  }

  const source = existsFile(MATCH_HELPER_PY) ? readText(MATCH_HELPER_PY) : "";
  if (/all-ready-or-completed/.test(source) && /resultEditorAudit/.test(source) && /missing_count/.test(source)) {
    check.pass("score", "stop polling requires all ready/completed and editor audit");
  } else {
    check.fail("score", "stop polling requires all ready/completed and editor audit", {
      reason: "Could not confirm the four-part stop condition in score helper source.",
      suggestion: "Keep polling unless stopPolling true, stopPollingCode all-ready-or-completed, missing_count 0, and resultEditorAudit.ok true.",
    });
  }
}

function checkEga(check, state) {
  checkFile(check, "ega", "EG engine path exists", EGA_ENGINE_EXE, "Install the official Egaroucid console under the project root.");
  checkFile(check, "ega", "EG helper exists", EGA_HELPER_PY, "Restore agent_egaroucid_analysis.py.");
  checkDirWritable(check, "ega", "EG cache directory writable", EGA_CACHE_DIR, "Fix recovered\\data\\ega-analysis.");
  if (existsFile(EGA_HELPER_PY)) {
    const text = readText(EGA_HELPER_PY);
    if (text.includes('DEFAULT_STATE_PATH = ROOT_DIR / "tournament_arrangement" / "recovered" / "data" / "checkin-state.json"')) {
      check.pass("ega", "EG helper default state is official state", { actualPath: STATE_FILE });
    } else {
      check.fail("ega", "EG helper default state is official state", { reason: "Default state path did not match official recovered\\data\\checkin-state.json." });
    }
  }

  const analysis = state && state.egaAnalysis && typeof state.egaAnalysis === "object" ? state.egaAnalysis : {};
  if (Number(analysis.gameCount) > 0) check.pass("ega", "egaAnalysis.gameCount is present in state", { actual: String(analysis.gameCount) });
  else check.warn("ega", "egaAnalysis.gameCount is present in state", { actual: String(Number(analysis.gameCount) || 0), reason: "No EG games analyzed yet. This is expected before scores exist." });

  const appText = existsFile(path.join(ROOT, "app.js")) ? readText(path.join(ROOT, "app.js")) : "";
  const uiBindingOk = appText.includes("renderEgaLossTag") && appText.includes("score-ftd__ega-loss") && appText.includes("pairingLossByRound");
  if (uiBindingOk) check.pass("ega", "frontend ranking/table can bind child-loss fields");
  else check.fail("ega", "frontend ranking/table can bind child-loss fields", { reason: "Could not confirm EG loss tag binding in app.js." });

  const pairings = collectPairings(state || {});
  const lastScoreUpdate = pairings.reduce((max, { item }) => {
    const t = Date.parse(item.updatedAt || item.resultTime || item.completedAt || "");
    return Number.isFinite(t) ? Math.max(max, t) : max;
  }, 0);
  const egaUpdated = Date.parse(analysis.updatedAt || "");
  if (Number.isFinite(egaUpdated) && egaUpdated > 0 && lastScoreUpdate > 0 && egaUpdated < lastScoreUpdate) {
    check.warn("ega", "EG analysis is newer than last score update", {
      actual: analysis.updatedAt,
      reason: "EG summary is older than at least one score edit; child-loss display may be stale.",
      suggestion: "Run EG analysis again after score registration settles.",
    });
  } else {
    check.pass("ega", "EG analysis is newer than last score update", { actual: analysis.updatedAt || "(no analysis yet)" });
  }

  const syntheticAnalysis = {
    gameCount: 1,
    pairingLossByRound: {
      1: {
        1: {
          blackAccount: "alpha",
          whiteAccount: "beta",
          players: [
            { ftdSide: "black", name: "Alpha", account: "alpha", totalLoss: 12, averageLoss: 0.4, gameId: "dry-run" },
            { ftdSide: "white", name: "Beta", account: "beta", totalLoss: 20, averageLoss: 0.7, gameId: "dry-run" },
          ],
        },
      },
    },
  };
  if (
    syntheticAnalysis.gameCount === 1 &&
    syntheticAnalysis.pairingLossByRound[1][1].players[0].totalLoss === 12 &&
    uiBindingOk
  ) {
    check.pass("ega", "zero-round dry-run EG child-loss data contract");
  } else {
    check.fail("ega", "zero-round dry-run EG child-loss data contract");
  }
}

async function checkEgaActualAnalysis(check, options, hero9Probe) {
  if (!options.full) {
    check.warn("ega", "EG actual analysis smoke test", {
      reason: "Skipped outside --full to keep check-in-ready fast.",
      suggestion: "Run self-check --full --event open before competition day.",
    });
    return;
  }
  if (!existsFile(WECHAT_PY) || !existsFile(EGA_HELPER_PY) || !existsFile(EGA_ENGINE_EXE)) return;
  const transcript = normalize(
    hero9Probe &&
      hero9Probe.chosen &&
      hero9Probe.chosen.transcriptMoves,
  );
  const gameId = normalize(
    hero9Probe &&
      hero9Probe.chosen &&
      hero9Probe.chosen.summary &&
      hero9Probe.chosen.summary.gameId,
  ) || "self-check-transcript";
  const moves = transcript || "f5d6c3d3c4f4";
  try {
    fs.mkdirSync(EGA_SELF_CHECK_CACHE_DIR, { recursive: true });
  } catch (error) {
    check.fail("ega", "EG actual analysis cache directory", {
      actualPath: EGA_SELF_CHECK_CACHE_DIR,
      reason: String(error && error.message ? error.message : error),
    });
    return;
  }
  const result = await execFileText(
    WECHAT_PY,
    [
      EGA_HELPER_PY,
      "analyze-transcript",
      "--moves",
      moves,
      "--game-id",
      `self-check-${gameId}`,
      "--cache-dir",
      EGA_SELF_CHECK_CACHE_DIR,
      "--engine",
      EGA_ENGINE_EXE,
      "--level",
      "1",
      "--threads",
      "1",
      "--hash",
      "12",
    ],
    {
      cwd: WECHAT_DIR,
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (!result.ok) {
    check.fail("ega", "EG actual analysis smoke test", {
      reason: result.stderr || result.error || result.stdout,
      actualPath: EGA_ENGINE_EXE,
      suggestion: "Fix Egaroucid console startup or transcript analysis before relying on child-loss output.",
    });
    return;
  }
  let parsed = null;
  try {
    const match = result.stdout.match(/\{[\s\S]*\}\s*$/);
    parsed = JSON.parse(match ? match[0] : result.stdout);
  } catch (error) {
    check.fail("ega", "EG actual analysis smoke test parses", {
      reason: String(error && error.message ? error.message : error),
      actual: result.stdout.slice(-800),
    });
    return;
  }
  const moveCount = Number(parsed.moveCount);
  const blackNodes = Number(parsed.black && parsed.black.nodeCount);
  const whiteNodes = Number(parsed.white && parsed.white.nodeCount);
  if (parsed.ok === true && moveCount > 0 && blackNodes + whiteNodes > 0 && parsed.firstNode) {
    check.pass("ega", "EG actual analysis smoke test", {
      actual: `${gameId}: moves=${moveCount}, nodes=${blackNodes + whiteNodes}`,
      actualPath: EGA_ENGINE_EXE,
      details: {
        cacheDir: EGA_SELF_CHECK_CACHE_DIR,
        blackTotalLoss: parsed.black && parsed.black.totalLoss,
        whiteTotalLoss: parsed.white && parsed.white.totalLoss,
        firstMove: parsed.firstNode && parsed.firstNode.move,
        lastMove: parsed.lastNode && parsed.lastNode.move,
      },
    });
  } else {
    check.fail("ega", "EG actual analysis smoke test", {
      reason: "Egaroucid returned JSON but did not produce usable node analysis.",
      details: parsed,
    });
  }
}

async function checkRemoteMapping(check, state, options) {
  checkFile(check, "remote-map", "map-collab sync script exists", MAP_COLLAB_SYNC_SCRIPT, "Restore cloudflare-map-collab\\tools\\sync-map-collab.js.");
  if (!existsFile(MAP_COLLAB_CONFIG)) {
    check.warn("remote-map", "map-collab config exists", { actualPath: MAP_COLLAB_CONFIG, reason: "Remote mapping sync is not configured." });
    return;
  }
  let config = null;
  try {
    config = readJson(MAP_COLLAB_CONFIG);
    check.pass("remote-map", "map-collab config parses", { actualPath: MAP_COLLAB_CONFIG });
  } catch (error) {
    check.fail("remote-map", "map-collab config parses", { actualPath: MAP_COLLAB_CONFIG, reason: String(error && error.message ? error.message : error) });
    return;
  }
  if (config.enabled) check.pass("remote-map", "remote mapping sync enabled", { actual: String(config.endpoint || "") });
  else check.warn("remote-map", "remote mapping sync enabled", { reason: "map-collab config is disabled." });

  const rows = mappingRows(state || {}).filter((row) => !mappingRowDeleted(row));
  const nickPool = (state && state.wechatGroupNicks) || (state && state.ftdPlayerAccountMapping && state.ftdPlayerAccountMapping.wechatGroupNicks) || null;
  const nickCount = Array.isArray(nickPool && nickPool.groupNicks) ? nickPool.groupNicks.length : 0;
  if (rows.length && nickCount) {
    check.pass("remote-map", "local mapping projection has rows and nickname candidates", { actual: `${rows.length} rows, ${nickCount} nicks` });
  } else {
    check.warn("remote-map", "local mapping projection has rows and nickname candidates", {
      actual: `${rows.length} rows, ${nickCount} nicks`,
      suggestion: "Run the three-stage FTD mapping flow and refresh WeChat group nicks before publishing.",
    });
  }

  const endpoint = normalize(config.endpoint).replace(/\/+$/, "");
  const tableId = normalize(config.tableId);
  const token = normalize(config.editToken);
  if (!endpoint || !tableId || !token) {
    check.fail("remote-map", "remote mapping endpoint/table/token configured", { reason: "endpoint, tableId, or editToken is empty." });
  } else if (options.full || options.checkinReady) {
    const remote = await fetchRemoteJson(`${endpoint}/api/tables/${encodeURIComponent(tableId)}?token=${encodeURIComponent(token)}`, 7000);
    if (remote.ok && remote.json && remote.json.ok !== false) {
      const remoteRows = Array.isArray(remote.json.mapping && remote.json.mapping.players) ? remote.json.mapping.players.length : 0;
      check.pass("remote-map", "remote mapping table is readable", { actual: `${endpoint} table=${tableId}, rows=${remoteRows}` });
    } else {
      check.warn("remote-map", "remote mapping table is readable", {
        actual: `${endpoint} table=${tableId}`,
        reason: remote.error || `HTTP ${remote.status}`,
        suggestion: "Fix map-collab config/network before relying on online mapping projection.",
      });
    }
  } else {
    check.warn("remote-map", "remote mapping table is readable", { reason: "Skipped remote network probe outside --full/--checkin-ready." });
  }

  const appText = existsFile(path.join(ROOT, "app.js")) ? readText(path.join(ROOT, "app.js")) : "";
  const serverText = existsFile(path.join(ROOT, "local-server.js")) ? readText(path.join(ROOT, "local-server.js")) : "";
  if (appText.includes("LOCAL_SYNC_MAP_COLLAB_SYNC_URL") && appText.includes("syncOnlineFtdPlayerMap")) {
    check.pass("remote-map", "frontend can trigger remote mapping refresh/write API");
  } else {
    check.fail("remote-map", "frontend can trigger remote mapping refresh/write API", { reason: "Frontend remote sync binding is missing." });
  }
  if (serverText.includes("syncMapCollabSafe") && serverText.includes("map-collab-overwrite-local") && serverText.includes(STATE_FILE.replace(/\\/g, "\\\\")) === false) {
    check.pass("remote-map", "server remote mapping sync route is present", { actual: "/api/map-collab/sync" });
  } else if (serverText.includes("syncMapCollabSafe")) {
    check.pass("remote-map", "server remote mapping sync route is present", { actual: "/api/map-collab/sync" });
  } else {
    check.fail("remote-map", "server remote mapping sync route is present", { reason: "local-server.js does not expose the map-collab sync route." });
  }
}

function buildRuntimeLock(state, options, report) {
  const mapping = state && state.ftdPlayerAccountMapping && typeof state.ftdPlayerAccountMapping === "object" ? state.ftdPlayerAccountMapping : {};
  const expectedGroup = `【${new Date().getMonth() + 1}月无差别组】栢龙杯棋王赛`;
  return {
    schema: "open-event-runtime-lock-v1",
    lockedAt: new Date().toISOString(),
    event: options.event || "open",
    selfCheckStatus: report.overall,
    selfCheckSummary: report.summary,
    statePath: STATE_FILE,
    frontendApi: FRONTEND_API,
    frontendRoot: FRONTEND_ROOT,
    groupName: normalize(options.group || mapping.groupName || mapping.group || expectedGroup),
    tournamentName: normalize(state && state.competitionName) || expectedTournamentName(new Date()),
    helperPath: TOURNAMENT_HELPER_CMD,
    wechatDir: WECHAT_DIR,
    egEnginePath: EGA_ENGINE_EXE,
    egCachePath: EGA_CACHE_DIR,
    mapCollabConfigPath: MAP_COLLAB_CONFIG,
    mapCollabScriptPath: MAP_COLLAB_SYNC_SCRIPT,
    oq: {
      method: "direct questgames.net JSON",
      baseUrl: "http://questgames.net",
    },
    port: PORT,
    host: HOST,
    round: options.round || null,
  };
}

async function runSelfCheck(options = {}) {
  const opts = {
    event: "open",
    full: false,
    checkinReady: false,
    round: 0,
    writeLock: true,
    writeReport: true,
    group: "",
    ...options,
  };
  const beforeStateSig = shaPath(STATE_FILE);
  const check = new SelfCheck(opts);

  await checkEnvironment(check);
  checkNoForbiddenRefs(check);
  const state = loadState(check);
  checkState(check, state, opts);
  checkMapping(check, state);
  checkWechatAndImages(check, state, opts);
  await checkOqRegression(check, state);
  const hero9Probe = await checkHero9OqActual(check, opts);
  checkScoreDryRun(check, state);
  checkEga(check, state);
  await checkEgaActualAnalysis(check, opts, hero9Probe);
  await checkRemoteMapping(check, state, opts);

  const afterStateSig = shaPath(STATE_FILE);
  if (beforeStateSig && afterStateSig && beforeStateSig !== afterStateSig) {
    check.fail("safety", "self-check did not mutate official state", {
      actual: afterStateSig,
      expected: beforeStateSig,
      reason: "State file signature changed during self-check.",
      suggestion: "Inspect recent writes before proceeding.",
    });
  } else {
    check.pass("safety", "self-check did not mutate official state", { actualPath: STATE_FILE });
  }

  const summary = statusCounts(check.items);
  const overall = summary.fail > 0 ? "fail" : summary.warn > 0 ? "warn" : "pass";
  const report = {
    ok: summary.fail === 0,
    overall,
    event: opts.event,
    mode: opts.full ? "full" : opts.checkinReady ? "checkin-ready" : opts.round ? "round" : "basic",
    round: opts.round || null,
    generatedAt: new Date().toISOString(),
    root: REPO_ROOT,
    paths: {
      state: STATE_FILE,
      frontendApi: FRONTEND_API,
      helper: TOURNAMENT_HELPER_CMD,
      egEngine: EGA_ENGINE_EXE,
      egCache: EGA_CACHE_DIR,
      egSelfCheckCache: EGA_SELF_CHECK_CACHE_DIR,
      runtimeLock: RUNTIME_LOCK_FILE,
      report: SELF_CHECK_REPORT_FILE,
    },
    summary,
    items: check.items,
  };

  if (opts.writeReport) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SELF_CHECK_REPORT_FILE, JSON.stringify(report, null, 2), "utf8");
  }

  if (summary.fail === 0 && opts.writeLock) {
    const lock = buildRuntimeLock(state || {}, opts, report);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(RUNTIME_LOCK_FILE, JSON.stringify(lock, null, 2), "utf8");
    report.runtimeLock = { written: true, path: RUNTIME_LOCK_FILE, lock };
  } else {
    report.runtimeLock = { written: false, path: RUNTIME_LOCK_FILE, reason: summary.fail ? "self-check has failures" : "disabled" };
  }

  return report;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) {
      out._.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

async function cli(argv) {
  const args = parseArgs(argv);
  if (args.help || args.h) {
    console.log("Usage: node self-check.js [--full|--checkin-ready|--round N] --event open [--no-lock]");
    return 0;
  }
  const report = await runSelfCheck({
    event: normalize(args.event || "open"),
    full: Boolean(args.full),
    checkinReady: Boolean(args["checkin-ready"]),
    round: args.round ? Math.max(1, Math.trunc(Number(args.round))) : 0,
    writeLock: args["no-lock"] !== true,
    group: normalize(args.group || ""),
  });
  console.log(JSON.stringify(report, null, 2));
  return report.summary.fail > 0 ? 1 : 0;
}

if (require.main === module) {
  cli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error && error.stack ? error.stack : error);
      process.exit(1);
    },
  );
}

module.exports = {
  runSelfCheck,
  paths: {
    ROOT,
    REPO_ROOT,
    STATE_FILE,
    RUNTIME_LOCK_FILE,
    SELF_CHECK_REPORT_FILE,
    FRONTEND_API,
  },
};
