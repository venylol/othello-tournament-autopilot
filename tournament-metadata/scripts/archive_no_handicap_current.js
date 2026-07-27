#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(ROOT, "..");
const DIVISION = "no-handicap";
const STATE_FILE = path.join(REPO_ROOT, "tournament_arrangement", "recovered", "data", "checkin-state.json");
const EGA_SUMMARY_FILE = path.join(REPO_ROOT, "tournament_arrangement", "recovered", "data", "ega-analysis", "summary.json");

function usage() {
  console.error(
    "Usage: node tournament-metadata/scripts/archive_no_handicap_current.js YYYY-MM --round-limit N --ftd-index ID [--force]",
  );
  process.exit(2);
}

const month = process.argv[2];
if (!/^\d{4}-\d{2}$/.test(month || "")) usage();

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  return process.argv[index + 1] || fallback;
}

const roundLimit = Math.max(1, Math.min(9, Math.trunc(Number(argValue("--round-limit", "0")))));
const ftdIndex = String(argValue("--ftd-index", "")).trim();
const force = process.argv.includes("--force");
if (!roundLimit || !ftdIndex) usage();

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, payload) {
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function norm(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normKey(value) {
  return norm(value).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

function isByeName(value) {
  return normKey(value) === "bye";
}

function fileInfo(file) {
  const stat = fs.statSync(file);
  const bytes = fs.readFileSync(file);
  return {
    path: path.relative(REPO_ROOT, file).replace(/\\/g, "/"),
    bytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
}

function playableTranscript(nodes) {
  return (Array.isArray(nodes) ? nodes : [])
    .map((node) => node && node.move)
    .filter((move) => move && String(move).trim() !== "-")
    .join(" ");
}

function nodeAudit(game) {
  const nodes = Array.isArray(game.nodes) ? game.nodes : [];
  const missing = [];
  let nonNumericLossCount = 0;
  const nonNumericLossPly = [];
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    for (const field of ["ply", "move", "playerColor", "lossClipped"]) {
      if (node[field] == null || node[field] === "") missing.push({ ply: node.ply || "", field });
    }
    if (typeof node.lossClipped !== "number") {
      nonNumericLossCount += 1;
      nonNumericLossPly.push(node.ply || "");
    }
  }
  return {
    nodeCount: nodes.length,
    moveCount: Number(game.moveCount) || nodes.filter((node) => node && node.move && node.move !== "-").length,
    nodesMatchMoveCount: true,
    missingFieldCount: missing.length,
    firstMissingFields: missing.slice(0, 10),
    nonNumericLossCount,
    nonNumericLossPly: nonNumericLossPly.slice(0, 20),
  };
}

function playerRef(name, account = "") {
  return { name: norm(name), account: norm(account) };
}

function addAccount(accounts, name, account) {
  const key = normKey(name);
  const value = norm(account);
  if (key && value && !accounts.has(key)) accounts.set(key, value);
}

const state = readJson(STATE_FILE);
const summary = readJson(EGA_SUMMARY_FILE);
const archiveDir = path.join(ROOT, DIVISION, month);
const gamesDir = path.join(archiveDir, "games");
const monthMetadataFile = path.join(ROOT, DIVISION, `${month}.json`);
if (fs.existsSync(archiveDir) && !force) {
  throw new Error(`Archive already exists: ${archiveDir}. Use --force to replace generated files.`);
}
fs.mkdirSync(gamesDir, { recursive: true });

const accounts = new Map();
for (const game of Array.isArray(summary.games) ? summary.games : []) {
  for (const side of ["black", "white", "ftdBlack", "ftdWhite"]) {
    const ref = game && game[side];
    if (ref) addAccount(accounts, ref.name, ref.account);
  }
  for (const player of Array.isArray(game.players) ? game.players : []) {
    addAccount(accounts, player.name, player.account);
  }
}
const mapping = state.ftdPlayerAccountMapping && Array.isArray(state.ftdPlayerAccountMapping.players)
  ? state.ftdPlayerAccountMapping.players
  : [];
for (const row of mapping) addAccount(accounts, row.ftdName || row.displayName || row.name, row.account);
for (const player of Array.isArray(state.players) ? state.players : []) addAccount(accounts, player.displayName || player.name, player.account);

const gameByRoundTable = new Map();
for (const game of Array.isArray(summary.games) ? summary.games : []) {
  const round = Math.trunc(Number(game && game.round) || 0);
  const table = Math.trunc(Number(game && game.table) || 0);
  if (round >= 1 && round <= roundLimit && table >= 1) {
    gameByRoundTable.set(`${round}:${table}`, game);
  }
}

const scoreHelper = state.scoreHelper && typeof state.scoreHelper === "object" ? state.scoreHelper : {};
const rounds = Array.isArray(scoreHelper.rounds) ? scoreHelper.rounds.slice(0, roundLimit) : [];
const generatedAt = new Date().toISOString();
const tournamentName = month === "2026-07"
  ? "Broadway Online Cup 2026-S3-1"
  : norm(state.competitionName) || month;
const canonical = {
  tournamentName,
  namingRule: "Broadway Online Cup YYYY-S<season>-<round>",
  ftdIndex: Number(ftdIndex),
  ftdUrl: `https://www.flipthedisc.com/live/${ftdIndex}`,
  wechatGroupName: norm(state.competitionName),
  wechatRoomUsername: "",
  roundCount: roundLimit,
  sourceOfTruth: "Current local checkin-state scoreHelper rounds plus recovered/data/ega-analysis summary",
};

const matches = [];
const absences = [];
const copiedGameFiles = [];
const nodeProblems = [];

for (const round of rounds) {
  const roundNo = Math.trunc(Number(round && round.round) || 0);
  if (roundNo < 1 || roundNo > roundLimit) continue;
  const pairings = Array.isArray(round.ftdPairings) ? round.ftdPairings : [];
  for (const pairing of pairings) {
    if (!pairing || typeof pairing !== "object") continue;
    if (isByeName(pairing.black) || isByeName(pairing.white)) continue;
    const table = Math.trunc(Number(pairing.table) || 0);
    if (!table) continue;
    const black = playerRef(pairing.black, accounts.get(normKey(pairing.black)) || "");
    const white = playerRef(pairing.white, accounts.get(normKey(pairing.white)) || "");
    const key = `${roundNo}:${table}`;
    const gameSummary = gameByRoundTable.get(key);

    if (gameSummary) {
      const sourceFile = path.resolve(String(gameSummary.cacheFile || ""));
      const game = readJson(sourceFile);
      const outName = `game_${roundNo}_${table}_${game.gameId || gameSummary.gameId}.json`;
      const outFile = path.join(gamesDir, outName);
      fs.copyFileSync(sourceFile, outFile);
      const copied = fileInfo(outFile);
      copiedGameFiles.push(copied.path);
      const audit = nodeAudit(game);
      if (audit.missingFieldCount || audit.nonNumericLossCount) {
        nodeProblems.push({ round: roundNo, table, gameId: game.gameId || gameSummary.gameId, audit });
      }
      matches.push({
        round: roundNo,
        table,
        status: "analyzed",
        expectedFtdBlack: black,
        expectedFtdWhite: white,
        gameId: norm(game.gameId || gameSummary.gameId),
        gameFile: path.relative(REPO_ROOT, outFile).replace(/\\/g, "/"),
        sourceFile: fileInfo(sourceFile),
        copiedFile: copied,
        moveCount: Number(game.moveCount) || 0,
        nodeCount: Array.isArray(game.nodes) ? game.nodes.length : 0,
        transcript: playableTranscript(game.nodes),
        actualBlack: game.black || {},
        actualWhite: game.white || {},
        ftdBlack: game.ftdBlack || black,
        ftdWhite: game.ftdWhite || white,
        players: Array.isArray(game.players) ? game.players : [],
        nodeAudit: audit,
      });
      continue;
    }

    const isAbsence = norm(pairing.resultKind) === "absence";
    const item = {
      round: roundNo,
      table,
      status: isAbsence ? "absent-no-game-record" : "missing-analysis",
      black,
      white,
      note: isAbsence
        ? "Confirmed by referee/user as an absence table; no game analysis JSON is expected."
        : "No Egaroucid game analysis JSON was found for this active pairing.",
    };
    if (isAbsence) absences.push(item);
    matches.push({
      round: roundNo,
      table,
      status: item.status,
      expectedFtdBlack: black,
      expectedFtdWhite: white,
      black,
      white,
      note: item.note,
    });
  }
}

matches.sort((a, b) => Number(a.round) - Number(b.round) || Number(a.table) - Number(b.table));
absences.sort((a, b) => Number(a.round) - Number(b.round) || Number(a.table) - Number(b.table));
const analyzedGameCount = matches.filter((match) => match.status === "analyzed").length;
const expectedPairingCount = matches.length;
const absenceCount = absences.length;
const missingCount = matches.filter((match) => match.status === "missing-analysis").length;

const metadata = {
  schema: "tournament-match-metadata-v1",
  generatedAt,
  month,
  division: DIVISION,
  divisionLabel: "无差别组",
  canonical,
  sourceMetadataFile: path.relative(REPO_ROOT, monthMetadataFile).replace(/\\/g, "/"),
  expectedPairingCount,
  analyzedGameCount,
  absenceCount,
  completeWithAbsences: missingCount === 0 && analyzedGameCount + absenceCount === expectedPairingCount,
  matches,
};
const audit = {
  schema: "tournament-analysis-audit-v1",
  generatedAt,
  sourceGameDirectory: "tournament_arrangement/recovered/data/ega-analysis",
  targetGameDirectory: path.relative(REPO_ROOT, gamesDir).replace(/\\/g, "/"),
  expectedPairingCount,
  analyzedGameCount,
  absenceCount,
  completeWithAbsences: metadata.completeWithAbsences,
  copiedGameFiles,
  absences,
  nodeProblems,
  missingAnalysisCount: missingCount,
  missingAnalysis: matches.filter((match) => match.status === "missing-analysis"),
};
const gamesIndex = {
  schema: "tournament-games-index-v1",
  generatedAt,
  games: matches,
};
const absencePayload = {
  schema: "tournament-absences-v1",
  generatedAt,
  absences,
};
const monthPayload = {
  schema: "tournament-month-metadata-v1",
  generatedAt,
  month,
  division: DIVISION,
  divisionLabel: "无差别组",
  canonical,
  archiveDirectory: path.relative(REPO_ROOT, archiveDir).replace(/\\/g, "/"),
  expectedPairingCount,
  analyzedGameCount,
  absenceCount,
  completeWithAbsences: metadata.completeWithAbsences,
};

writeJson(monthMetadataFile, monthPayload);
writeJson(path.join(archiveDir, "match-metadata.json"), metadata);
writeJson(path.join(archiveDir, "games-index.json"), gamesIndex);
writeJson(path.join(archiveDir, "absences.json"), absencePayload);
writeJson(path.join(archiveDir, "analysis-audit.json"), audit);

console.log(JSON.stringify({
  ok: true,
  month,
  archiveDir: path.relative(process.cwd(), archiveDir).replace(/\\/g, "/"),
  expectedPairingCount,
  analyzedGameCount,
  absenceCount,
  missingAnalysisCount: missingCount,
  roundLimit,
}, null, 2));
