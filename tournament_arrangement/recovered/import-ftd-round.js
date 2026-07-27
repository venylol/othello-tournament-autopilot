#!/usr/bin/env node
"use strict";

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const ROOT = __dirname;
const DOWNLOADS_DIR = path.join(os.homedir(), "Downloads");
const DATA_DIR = path.join(ROOT, "data");
const FTD_CURRENT_FILE = path.join(DATA_DIR, "ftd-round-current.json");
const STATE_API = process.env.CHECKIN_STATE_API || "http://127.0.0.1:4174/api/state";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function writeJsonAtomic(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

function findLatestDownload() {
  const files = fs
    .readdirSync(DOWNLOADS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^ftd-round-.*\.json$/i.test(entry.name))
    .map((entry) => {
      const file = path.join(DOWNLOADS_DIR, entry.name);
      const stat = fs.statSync(file);
      return { file, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!files.length) {
    throw new Error(`No ftd-round-*.json files found in ${DOWNLOADS_DIR}`);
  }
  return files[0].file;
}

function normalizeName(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeFtdPayload(raw) {
  const payload = raw && typeof raw === "object" && raw.ftdRound ? raw.ftdRound : raw;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("FTD payload root must be an object");
  }
  const round = Math.trunc(Number(payload.round));
  if (!Number.isFinite(round) || round < 1 || round > 9) {
    throw new Error("FTD round must be between 1 and 9");
  }
  const sourcePairings = Array.isArray(payload.pairings)
    ? payload.pairings
    : Array.isArray(payload.blankPairings)
      ? payload.blankPairings
      : [];
  if (!sourcePairings.length) {
    throw new Error("FTD payload has no pairings");
  }
  const ftdPairings = sourcePairings.map((item, index) => {
    const tableRaw = Number(item && item.table);
    const black = normalizeName(item && item.black);
    const white = normalizeName(item && item.white);
    if (!black || !white) {
      throw new Error(`pairings[${index}] missing black or white`);
    }
    return {
      table: Number.isFinite(tableRaw) && tableRaw > 0 ? Math.trunc(tableRaw) : index + 1,
      black,
      white,
    };
  });
  return {
    source: normalizeName(payload.source || "ftd-download-import"),
    url: String(payload.url || ""),
    title: String(payload.title || ""),
    exportedAt: String(payload.exportedAt || ""),
    importedAt: new Date().toISOString(),
    competitionName: normalizeName(payload.competitionName || ""),
    round,
    ftdPairings,
  };
}

function httpJson(method, targetUrl, body) {
  const url = new URL(targetUrl);
  const text = body == null ? "" : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port || 80,
        path: `${url.pathname}${url.search}`,
        headers: {
          Accept: "application/json",
          ...(text
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(text),
              }
            : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch (error) {
            reject(new Error(`Invalid JSON from ${targetUrl}: ${raw.slice(0, 300)}`));
            return;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 500)}`));
            return;
          }
          resolve(parsed);
        });
      },
    );
    req.on("error", reject);
    if (text) req.write(text);
    req.end();
  });
}

function ensureScoreHelper(state, roundCount) {
  const existing =
    state.scoreHelper && typeof state.scoreHelper === "object" ? state.scoreHelper : {};
  const existingRounds = Array.isArray(existing.rounds) ? existing.rounds : [];
  const count = Math.max(
    1,
    Math.min(9, Math.trunc(Number(roundCount || existing.roundCount || existingRounds.length || 5))),
  );
  const rounds = [];
  for (let i = 0; i < count; i += 1) {
    const src = existingRounds[i] && typeof existingRounds[i] === "object" ? existingRounds[i] : {};
    rounds.push({
      round: i + 1,
      pending: Array.isArray(src.pending) ? src.pending : [],
      manualPending: Array.isArray(src.manualPending) ? src.manualPending : [],
      completed: Array.isArray(src.completed) ? src.completed : [],
      ftdPairings: Array.isArray(src.ftdPairings) ? src.ftdPairings : [],
    });
  }
  state.scoreHelper = {
    version: 1,
    roundCount: count,
    roundCountSource:
      existing.roundCountSource === "manual" || existing.roundCountSource === "auto"
        ? existing.roundCountSource
        : "default",
    autoRoundCountPlayerCount: Number.isFinite(Number(existing.autoRoundCountPlayerCount))
      ? Math.max(0, Math.trunc(Number(existing.autoRoundCountPlayerCount)))
      : null,
    activeRound: Math.max(1, Math.min(count, Math.trunc(Number(existing.activeRound || 1)))),
    rounds,
    updatedAt: Date.now(),
  };
  return state.scoreHelper;
}

function preliminaryRoundCountForPlayerCount(playerCount) {
  const count = Math.max(0, Math.trunc(Number(playerCount) || 0));
  if (count >= 64) return 7;
  if (count >= 32) return 6;
  return 5;
}

function countFtdPairingPlayers(pairings) {
  const names = new Set();
  const add = (value) => {
    const name = normalizeName(value);
    if (!name || name.toLowerCase() === "bye") return;
    names.add(name.toLowerCase());
  };
  for (const item of Array.isArray(pairings) ? pairings : []) {
    add(item && item.black);
    add(item && item.white);
  }
  return names.size;
}

async function main() {
  const explicitFile = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "";
  const file = explicitFile ? path.resolve(explicitFile) : findLatestDownload();
  const ftd = normalizeFtdPayload(readJson(file));

  const current = await httpJson("GET", STATE_API);
  if (!current || current.ok !== true || !current.state) {
    throw new Error(`Local state API did not return a usable state: ${JSON.stringify(current)}`);
  }
  const state = current.state;
  state.step = "score-helper";
  const existingHelper =
    state.scoreHelper && typeof state.scoreHelper === "object" ? state.scoreHelper : {};
  const isManualRoundCount = existingHelper.roundCountSource === "manual";
  const autoPlayerCount = ftd.round === 1 ? countFtdPairingPlayers(ftd.ftdPairings) : null;
  const autoRoundCount =
    ftd.round === 1 && !isManualRoundCount
      ? preliminaryRoundCountForPlayerCount(autoPlayerCount)
      : null;
  const targetRoundCount = Math.max(
    ftd.round,
    autoRoundCount || 0,
    autoRoundCount == null ? Number(existingHelper.roundCount) || 0 : 0,
    autoRoundCount == null && Array.isArray(existingHelper.rounds)
      ? existingHelper.rounds.length
      : 0,
  );
  const helper = ensureScoreHelper(state, targetRoundCount);
  if (autoRoundCount != null) {
    helper.roundCountSource = "auto";
    helper.autoRoundCountPlayerCount = autoPlayerCount;
  }
  helper.activeRound = ftd.round;
  helper.rounds[ftd.round - 1].ftdPairings = ftd.ftdPairings;
  helper.updatedAt = Date.now();
  state.savedAt = Date.now();
  state.ftdRound = {
    sourceFile: file,
    currentFile: FTD_CURRENT_FILE,
    source: ftd.source,
    url: ftd.url,
    title: ftd.title,
    exportedAt: ftd.exportedAt,
    importedAt: ftd.importedAt,
    competitionName: ftd.competitionName,
    round: ftd.round,
    pairingCount: ftd.ftdPairings.length,
    note:
      autoRoundCount == null
        ? "Scores intentionally discarded; only table, black, and white are imported."
        : `Scores intentionally discarded; auto round count ${autoRoundCount} from ${autoPlayerCount} players.`,
  };

  writeJsonAtomic(FTD_CURRENT_FILE, {
    ...ftd,
    pairings: ftd.ftdPairings,
    blankPairings: ftd.ftdPairings.map((item) => ({
      table: item.table,
      black: item.black,
      white: item.white,
      blackScore: null,
      whiteScore: null,
    })),
  });

  const written = await httpJson("POST", STATE_API, {
    source: "agent-ftd-round-import",
    state,
  });
  if (!written || written.ok !== true) {
    throw new Error(`Failed to write state: ${JSON.stringify(written)}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        sourceFile: file,
        round: ftd.round,
        pairingCount: ftd.ftdPairings.length,
        activeRound: written.state.scoreHelper.activeRound,
        currentFile: FTD_CURRENT_FILE,
        scoresImported: false,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
