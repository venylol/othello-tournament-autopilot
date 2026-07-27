#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DIVISION = "no-handicap";

function usage() {
  console.error("Usage: node tournament-metadata/scripts/export_no_handicap_month.js YYYY-MM");
  process.exit(2);
}

const month = process.argv[2];
if (!/^\d{4}-\d{2}$/.test(month || "")) usage();

const archiveDir = path.join(ROOT, DIVISION, month);
const metadataFile = path.join(archiveDir, "match-metadata.json");
const outputDir = path.join(ROOT, "exports", DIVISION, month);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function writeCsv(file, rows) {
  fs.writeFileSync(file, rows.map((row) => row.map(csvCell).join(",")).join("\n") + "\n", "utf8");
}

function normalizeAccount(account) {
  return String(account || "").trim().toLowerCase().replace(/_/g, "");
}

function initialBoard() {
  const board = Array.from({ length: 8 }, () => Array(8).fill(null));
  board[3][3] = "white";
  board[3][4] = "black";
  board[4][3] = "black";
  board[4][4] = "white";
  return board;
}

const DIRS = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1], [0, 1],
  [1, -1], [1, 0], [1, 1],
];

function inBoard(row, col) {
  return row >= 0 && row < 8 && col >= 0 && col < 8;
}

function opponent(color) {
  return color === "black" ? "white" : "black";
}

function moveToCoord(move) {
  const text = String(move || "").trim().toLowerCase();
  if (!/^[a-h][1-8]$/.test(text)) return null;
  return {
    row: Number(text[1]) - 1,
    col: text.charCodeAt(0) - "a".charCodeAt(0),
  };
}

function isPassMove(move) {
  return String(move || "").trim() === "-";
}

function playableTranscript(nodes) {
  return (nodes || [])
    .map((node) => node.move)
    .filter((move) => move && !isPassMove(move))
    .join(" ");
}

function flipsForMove(board, color, row, col) {
  if (!inBoard(row, col) || board[row][col]) return [];
  const other = opponent(color);
  const flips = [];
  for (const [dr, dc] of DIRS) {
    const line = [];
    let r = row + dr;
    let c = col + dc;
    while (inBoard(r, c) && board[r][c] === other) {
      line.push([r, c]);
      r += dr;
      c += dc;
    }
    if (line.length && inBoard(r, c) && board[r][c] === color) {
      flips.push(...line);
    }
  }
  return flips;
}

function hasLegalMove(board, color) {
  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      if (flipsForMove(board, color, row, col).length) return true;
    }
  }
  return false;
}

function applyMove(board, color, move) {
  const coord = moveToCoord(move);
  if (!coord) return false;
  const flips = flipsForMove(board, color, coord.row, coord.col);
  if (!flips.length) return false;
  board[coord.row][coord.col] = color;
  for (const [row, col] of flips) board[row][col] = color;
  return true;
}

function replayScore(nodes) {
  const board = initialBoard();
  let turn = "black";
  const illegal = [];

  for (const node of nodes || []) {
    if (isPassMove(node.move)) {
      turn = opponent(turn);
      continue;
    }
    const nodeColor = node.playerColor === "white" ? "white" : "black";
    if (turn !== nodeColor) {
      if (!hasLegalMove(board, turn)) {
        turn = opponent(turn);
      }
    }
    const ok = applyMove(board, nodeColor, node.move);
    if (!ok) {
      illegal.push({ ply: node.ply, move: node.move, color: nodeColor });
    }
    turn = opponent(nodeColor);
  }

  let blackBoard = 0;
  let whiteBoard = 0;
  let empty = 0;
  for (const row of board) {
    for (const cell of row) {
      if (cell === "black") blackBoard += 1;
      else if (cell === "white") whiteBoard += 1;
      else empty += 1;
    }
  }

  let blackScore = blackBoard;
  let whiteScore = whiteBoard;
  if (empty > 0 && blackBoard !== whiteBoard) {
    if (blackBoard > whiteBoard) blackScore += empty;
    else whiteScore += empty;
  }

  return { blackScore, whiteScore, blackBoard, whiteBoard, empty, illegal };
}

function playerByFtdSide(game, side) {
  return (game.players || []).find((player) => player.ftdSide === side) || null;
}

function scoreForFtdSide(game, side, score) {
  const ftd = side === "black" ? game.ftdBlack : game.ftdWhite;
  const account = normalizeAccount(ftd && ftd.account);
  if (!account) return "";
  if (normalizeAccount(game.black && game.black.account) === account) return score.blackScore;
  if (normalizeAccount(game.white && game.white.account) === account) return score.whiteScore;
  return "";
}

function actualScoreForColor(color, score) {
  return color === "black" ? score.blackScore : score.whiteScore;
}

function opponentColor(color) {
  return color === "black" ? "white" : "black";
}

function sideByColor(game, color) {
  return color === "black" ? game.black : game.white;
}

function loadGame(match) {
  if (!match.gameFile) return null;
  const file = path.resolve(ROOT, "..", match.gameFile);
  return readJson(file);
}

if (!fs.existsSync(metadataFile)) {
  console.error(`Missing metadata file: ${metadataFile}`);
  process.exit(1);
}

const metadata = readJson(metadataFile);
fs.mkdirSync(outputDir, { recursive: true });
const divisionLabel = metadata.division === DIVISION ? "\u65e0\u5dee\u522b\u7ec4" : (metadata.divisionLabel || metadata.division || DIVISION);

const csvRows = [[
  "month",
  "division",
  "tournamentName",
  "round",
  "table",
  "status",
  "ftdBlackName",
  "ftdBlackOq",
  "ftdBlackScore",
  "ftdBlackTotalLoss",
  "ftdBlackAverageLoss",
  "ftdWhiteName",
  "ftdWhiteOq",
  "ftdWhiteScore",
  "ftdWhiteTotalLoss",
  "ftdWhiteAverageLoss",
  "actualBlackName",
  "actualBlackOq",
  "actualBlackScore",
  "actualWhiteName",
  "actualWhiteOq",
  "actualWhiteScore",
  "moveCount",
  "nodeCount",
  "transcript",
]];

const txt = [];
txt.push(`${metadata.canonical && metadata.canonical.tournamentName ? metadata.canonical.tournamentName : month}`);
txt.push(`Division: ${divisionLabel}`);
txt.push(`Month: ${month}`);
txt.push(`Generated at: ${new Date().toISOString()}`);
txt.push(`Matches: ${metadata.expectedPairingCount}; analyzed: ${metadata.analyzedGameCount}; absences: ${metadata.absenceCount}`);
txt.push("");

const playerStats = new Map();

function addPlayerGame(player, game, match, score, transcript) {
  if (!player || !player.account) return;
  const key = normalizeAccount(player.account) || `${player.name}:${player.color}`;
  if (!playerStats.has(key)) {
    playerStats.set(key, {
      key,
      name: player.name || "",
      account: player.account || "",
      gameCount: 0,
      totalLoss: 0,
      games: [],
    });
  }
  const entry = playerStats.get(key);
  const playerColor = player.color === "white" ? "white" : "black";
  const otherColor = opponentColor(playerColor);
  const playerSide = sideByColor(game, playerColor) || {};
  const opponentSide = sideByColor(game, otherColor) || {};
  const playerScore = actualScoreForColor(playerColor, score);
  const opponentScore = actualScoreForColor(otherColor, score);
  const totalLoss = Number(player.totalLoss);
  entry.gameCount += 1;
  if (Number.isFinite(totalLoss)) entry.totalLoss += totalLoss;
  entry.games.push({
    round: match.round,
    table: match.table,
    playerName: playerSide.name || player.name || "",
    playerAccount: playerSide.account || player.account || "",
    opponentName: opponentSide.name || "",
    opponentAccount: opponentSide.account || "",
    playerColor,
    playerScore,
    opponentScore,
    totalLoss: Number.isFinite(totalLoss) ? totalLoss : "",
    averageLoss: player.averageLoss ?? "",
    transcript,
  });
}

for (const match of metadata.matches || []) {
  if (match.status !== "analyzed") {
    const black = match.black || match.expectedFtdBlack || {};
    const white = match.white || match.expectedFtdWhite || {};
    csvRows.push([
      month,
      metadata.division || DIVISION,
      metadata.canonical && metadata.canonical.tournamentName,
      match.round,
      match.table,
      match.status,
      black.name,
      black.account,
      "",
      "",
      "",
      white.name,
      white.account,
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
    ]);
    txt.push(`Round ${match.round} Table ${match.table} - ${match.status}`);
    txt.push(`  FTD black: ${black.name || ""} (${black.account || ""})`);
    txt.push(`  FTD white: ${white.name || ""} (${white.account || ""})`);
    txt.push(`  Note: ${match.note || ""}`);
    txt.push("");
    continue;
  }

  const game = loadGame(match);
  const score = replayScore(game.nodes || []);
  const blackPlayer = playerByFtdSide(game, "black") || {};
  const whitePlayer = playerByFtdSide(game, "white") || {};
  const transcript = playableTranscript(game.nodes || []);
  const ftdBlackScore = scoreForFtdSide(game, "black", score);
  const ftdWhiteScore = scoreForFtdSide(game, "white", score);
  for (const player of game.players || []) {
    addPlayerGame(player, game, match, score, transcript);
  }

  csvRows.push([
    month,
    metadata.division || DIVISION,
    metadata.canonical && metadata.canonical.tournamentName,
    match.round,
    match.table,
    match.status,
    match.expectedFtdBlack && match.expectedFtdBlack.name,
    (game.ftdBlack && game.ftdBlack.account) || (match.expectedFtdBlack && match.expectedFtdBlack.account),
    ftdBlackScore,
    blackPlayer.totalLoss,
    blackPlayer.averageLoss,
    match.expectedFtdWhite && match.expectedFtdWhite.name,
    (game.ftdWhite && game.ftdWhite.account) || (match.expectedFtdWhite && match.expectedFtdWhite.account),
    ftdWhiteScore,
    whitePlayer.totalLoss,
    whitePlayer.averageLoss,
    game.black && game.black.name,
    game.black && game.black.account,
    actualScoreForColor("black", score),
    game.white && game.white.name,
    game.white && game.white.account,
    actualScoreForColor("white", score),
    game.moveCount,
    Array.isArray(game.nodes) ? game.nodes.length : "",
    transcript,
  ]);

  txt.push(`Round ${match.round} Table ${match.table}`);
  txt.push(`  FTD black: ${match.expectedFtdBlack.name} (${(game.ftdBlack && game.ftdBlack.account) || match.expectedFtdBlack.account || ""}) score=${ftdBlackScore} totalLoss=${blackPlayer.totalLoss ?? ""} avgLoss=${blackPlayer.averageLoss ?? ""}`);
  txt.push(`  FTD white: ${match.expectedFtdWhite.name} (${(game.ftdWhite && game.ftdWhite.account) || match.expectedFtdWhite.account || ""}) score=${ftdWhiteScore} totalLoss=${whitePlayer.totalLoss ?? ""} avgLoss=${whitePlayer.averageLoss ?? ""}`);
  txt.push(`  Actual black: ${game.black.name} (${game.black.account}) score=${score.blackScore}`);
  txt.push(`  Actual white: ${game.white.name} (${game.white.account}) score=${score.whiteScore}`);
  txt.push(`  Transcript: ${transcript}`);
  if (score.illegal.length) {
    txt.push(`  Replay warnings: ${JSON.stringify(score.illegal)}`);
  }
  txt.push("");
}

const leaderboard = Array.from(playerStats.values())
  .filter((player) => player.gameCount > 0)
  .map((player) => ({
    ...player,
    averageGameLoss: Number((player.totalLoss / player.gameCount).toFixed(3)),
  }))
  .sort((a, b) => a.averageGameLoss - b.averageGameLoss || b.gameCount - a.gameCount || a.name.localeCompare(b.name))
  .slice(0, 10);

csvRows.push([]);
csvRows.push(["Top 10 lowest average game loss"]);
csvRows.push(["rank", "playerName", "oqAccount", "gameCount", "totalLoss", "averageGameLoss"]);
for (const [index, player] of leaderboard.entries()) {
  csvRows.push([index + 1, player.name, player.account, player.gameCount, player.totalLoss, player.averageGameLoss]);
}
csvRows.push([]);
csvRows.push(["Top 10 player games"]);
csvRows.push([
  "rank",
  "playerName",
  "oqAccount",
  "round",
  "table",
  "opponentName",
  "opponentOq",
  "playerColor",
  "playerScore",
  "opponentScore",
  "gameTotalLoss",
  "gameAverageLoss",
  "transcript",
]);
for (const [index, player] of leaderboard.entries()) {
  const games = player.games
    .slice()
    .sort((a, b) => a.round - b.round || a.table - b.table);
  for (const game of games) {
    csvRows.push([
      index + 1,
      player.name,
      player.account,
      game.round,
      game.table,
      game.opponentName,
      game.opponentAccount,
      game.playerColor,
      game.playerScore,
      game.opponentScore,
      game.totalLoss,
      game.averageLoss,
      game.transcript,
    ]);
  }
}

txt.push("Top 10 lowest average game loss");
txt.push("");
for (const [index, player] of leaderboard.entries()) {
  txt.push(`${index + 1}. ${player.name} (${player.account}) games=${player.gameCount} totalLoss=${player.totalLoss} averageGameLoss=${player.averageGameLoss}`);
  const games = player.games
    .slice()
    .sort((a, b) => a.round - b.round || a.table - b.table);
  for (const game of games) {
    txt.push(`  Round ${game.round} Table ${game.table}: vs ${game.opponentName} (${game.opponentAccount}) color=${game.playerColor} score=${game.playerScore}-${game.opponentScore} totalLoss=${game.totalLoss} avgLoss=${game.averageLoss}`);
    txt.push(`    Transcript: ${game.transcript}`);
    txt.push("");
  }
}

const csvFile = path.join(outputDir, `no-handicap-${month}-summary.csv`);
const txtFile = path.join(outputDir, `no-handicap-${month}-report.txt`);
writeCsv(csvFile, csvRows);
fs.writeFileSync(txtFile, txt.join("\n"), "utf8");

console.log(JSON.stringify({
  month,
  csv: path.relative(process.cwd(), csvFile).replace(/\\/g, "/"),
  txt: path.relative(process.cwd(), txtFile).replace(/\\/g, "/"),
  matchRows: (metadata.matches || []).length,
  topPlayers: leaderboard.length,
}, null, 2));
