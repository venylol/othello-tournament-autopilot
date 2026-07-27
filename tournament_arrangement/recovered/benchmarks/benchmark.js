"use strict";

const fs = require("fs");
const path = require("path");

const parser = require("../app.js");

const ROOT = path.resolve(__dirname, "..");
const SAMPLE_DIR = path.resolve(ROOT, "..", "historical_sample");
const OUTPUT_DIR = path.resolve(__dirname, "output");
const FIXTURE_DIR = path.resolve(__dirname, "fixtures");

const RAW_JSON = path.join(OUTPUT_DIR, "baseline.raw.json");
const RAW_MD = path.join(OUTPUT_DIR, "baseline.raw.md");
const EXPECTED_JSON = path.join(FIXTURE_DIR, "expected.clean.json");
const REPORT_JSON = path.join(OUTPUT_DIR, "compare.report.json");
const REPORT_MD = path.join(OUTPUT_DIR, "compare.report.md");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readUtf8(file) {
  return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
}

function listSampleFiles() {
  return fs
    .readdirSync(SAMPLE_DIR, { withFileTypes: true })
    .filter((x) => x.isFile() && /\.txt$/i.test(x.name))
    .map((x) => path.join(SAMPLE_DIR, x.name))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b), "en"));
}

function splitCases(filePath) {
  const text = readUtf8(filePath).replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const starts = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#接[龙龍]/.test(line)) {
      starts.push(i);
      continue;
    }
    if (/^\s*全部名单/.test(line)) {
      starts.push(i);
      continue;
    }
    if (looksLikeStandaloneCaseTitle(lines, i)) starts.push(i);
  }

  if (starts.length === 0 && text.trim()) starts.push(0);

  const stem = path.basename(filePath, path.extname(filePath));
  return starts.map((start, index) => {
    const end = index + 1 < starts.length ? starts[index + 1] : lines.length;
    const chunkLines = lines.slice(start, end);
    const title = inferTitle(chunkLines);
    return {
      id: `${stem}__${String(index + 1).padStart(2, "0")}`,
      file: path.basename(filePath),
      index: index + 1,
      startLine: start + 1,
      endLine: end,
      title,
      text: chunkLines.join("\n").trimEnd(),
    };
  });
}

function looksLikeStandaloneCaseTitle(lines, index) {
  const line = String(lines[index] || "").trim();
  if (!/^[【\[]/.test(line)) return false;
  if (!/(青少年组|新人组|无差别组|特殊赛).*比赛报名接龙/.test(line)) {
    return false;
  }

  for (let i = index - 1; i >= 0 && i >= index - 3; i--) {
    const prev = String(lines[i] || "").trim();
    if (!prev) continue;
    if (/^#接[龙龍]/.test(prev)) return false;
    break;
  }

  return true;
}

function inferTitle(lines) {
  for (const raw of lines) {
    const line = String(raw || "").trim();
    if (!line) continue;
    if (/^全部名单/.test(line)) return line;
    if (/^#接[龙龍]/.test(line)) {
      const rest = line.replace(/^#接[龙龍]\s*/, "").trim();
      if (rest) return rest;
      continue;
    }
    if (/^【|^\[/.test(line) || /比赛报名接龙/.test(line)) return line;
  }
  return "";
}

function extractNumberedEntries(text) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const entries = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const m = raw.match(/^\s*(\d+)\s*[.．、)]\s*(.*)$/);
    if (m) {
      current = {
        number: Number(m[1]),
        startLineOffset: i + 1,
        text: m[2].trim(),
        lines: [raw],
      };
      entries.push(current);
      continue;
    }

    if (!current) continue;
    const trimmed = raw.trim();
    if (!trimmed) {
      current = null;
      continue;
    }
    if (/^#接[龙龍]/.test(trimmed)) {
      current = null;
      continue;
    }
    if (/^(截止|签到|点名|比赛|接龙|格式|如：|注：|附：|当前)/.test(trimmed)) {
      current = null;
      continue;
    }
    if (/^[\w@.+\-[\]()（）\u3000 ]{2,}$/.test(trimmed)) {
      current.text = `${current.text} ${trimmed}`.trim();
      current.lines.push(raw);
    }
  }

  if (entries.length) return entries;

  let inLongTermList = false;
  let seq = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (/^全部名单/.test(trimmed)) {
      inLongTermList = true;
      continue;
    }
    if (!inLongTermList) continue;
    if (/^[-—–]+$/.test(trimmed)) continue;
    entries.push({
      number: ++seq,
      startLineOffset: i + 1,
      text: trimmed,
      lines: [raw],
    });
  }

  return entries;
}

function normalizePlayer(p) {
  return {
    displayName: String(p.displayName || ""),
    account: String(p.account || ""),
    club: String(p.club || ""),
    group: String(p.group || ""),
    platform: String(p.platform || ""),
    isNew: Boolean(p.isNew),
  };
}

function summarizeReport(report) {
  const ignoredReasons = {};
  const rawReasons = report && report.ignoredReasons;
  if (rawReasons && typeof rawReasons.forEach === "function") {
    rawReasons.forEach((value, key) => {
      ignoredReasons[key] = value;
    });
  } else if (rawReasons && typeof rawReasons === "object") {
    Object.assign(ignoredReasons, rawReasons);
  }

  return {
    totalLines: Number(report && report.totalLines) || 0,
    kept: Number(report && report.kept) || 0,
    ignored: Number(report && report.ignored) || 0,
    ignoredReasons,
    ignoredItems: Array.isArray(report && report.ignoredItems)
      ? report.ignoredItems.map((x) => ({
          reason: String(x.reason || ""),
          line: String(x.line || ""),
          groupHint: String(x.groupHint || ""),
          source: String(x.source || ""),
        }))
      : [],
  };
}

function runCase(testCase) {
  const result = parser.parseImportTextsDetailed("", testCase.text);
  const players = Array.isArray(result.players)
    ? result.players.map(normalizePlayer)
    : [];

  return {
    ...testCase,
    sourceEntries: extractNumberedEntries(testCase.text),
    actual: {
      players,
      report: summarizeReport(result.report || {}),
    },
  };
}

function generateRaw() {
  ensureDir(OUTPUT_DIR);
  const files = listSampleFiles();
  const cases = files.flatMap(splitCases).map(runCase);
  const payload = {
    generatedAt: new Date().toISOString(),
    parser: "app.js::parseImportTextsDetailed",
    sampleDir: path.relative(ROOT, SAMPLE_DIR).replace(/\\/g, "/"),
    caseCount: cases.length,
    playerCount: cases.reduce((sum, c) => sum + c.actual.players.length, 0),
    cases,
  };

  fs.writeFileSync(RAW_JSON, JSON.stringify(payload, null, 2) + "\n", "utf8");
  fs.writeFileSync(RAW_MD, renderRawMarkdown(payload), "utf8");
  console.log(`Wrote ${path.relative(ROOT, RAW_JSON)}`);
  console.log(`Wrote ${path.relative(ROOT, RAW_MD)}`);
  console.log(`Cases: ${payload.caseCount}; parsed players: ${payload.playerCount}`);
}

function renderRawMarkdown(payload) {
  const out = [];
  out.push("# Baseline Raw Parse Output");
  out.push("");
  out.push(`Generated: ${payload.generatedAt}`);
  out.push(`Cases: ${payload.caseCount}`);
  out.push(`Parsed players: ${payload.playerCount}`);
  out.push("");

  for (const c of payload.cases) {
    out.push(`## ${c.id}`);
    out.push("");
    out.push(`- File: ${c.file}`);
    out.push(`- Lines: ${c.startLine}-${c.endLine}`);
    out.push(`- Title: ${c.title || "(untitled)"}`);
    out.push(`- Source numbered entries: ${c.sourceEntries.length}`);
    out.push(`- Parsed players: ${c.actual.players.length}`);
    out.push("");
    out.push("### Parsed Players");
    out.push("");
    out.push("| # | displayName | account | club | group | platform | isNew |");
    out.push("|---:|---|---|---|---|---|---|");
    c.actual.players.forEach((p, idx) => {
      out.push(
        `| ${idx + 1} | ${md(p.displayName)} | ${md(p.account)} | ${md(
          p.club,
        )} | ${md(p.group)} | ${md(p.platform)} | ${p.isNew} |`,
      );
    });
    out.push("");
    out.push("### Source Numbered Lines");
    out.push("");
    out.push("| source # | text |");
    out.push("|---:|---|");
    c.sourceEntries.forEach((e) => {
      out.push(`| ${e.number} | ${md(e.text)} |`);
    });
    if (c.actual.report.ignoredItems.length) {
      out.push("");
      out.push("### Ignored Items");
      out.push("");
      out.push("| reason | line |");
      out.push("|---|---|");
      c.actual.report.ignoredItems.forEach((item) => {
        out.push(`| ${md(item.reason)} | ${md(item.line)} |`);
      });
    }
    out.push("");
  }

  return out.join("\n") + "\n";
}

function md(value) {
  return String(value || "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, "<br>");
}

function makeExpectedFromRaw() {
  ensureDir(FIXTURE_DIR);
  const raw = JSON.parse(readUtf8(RAW_JSON));
  const expected = {
    generatedFrom: "benchmarks/output/baseline.raw.json",
    reviewedAt: new Date().toISOString(),
    reviewStatus:
      "Seeded from raw parser output. Edit expectedPlayers on each case after review.",
    cases: raw.cases.map((c) => ({
      id: c.id,
      file: c.file,
      title: c.title,
      sourceLines: `${c.startLine}-${c.endLine}`,
      expectedPlayers: c.actual.players,
      reviewNotes: [],
    })),
  };
  fs.writeFileSync(EXPECTED_JSON, JSON.stringify(expected, null, 2) + "\n", "utf8");
  console.log(`Wrote ${path.relative(ROOT, EXPECTED_JSON)}`);
}

function compare() {
  ensureDir(OUTPUT_DIR);
  const raw = JSON.parse(readUtf8(RAW_JSON));
  const expected = JSON.parse(readUtf8(EXPECTED_JSON));
  const expectedById = new Map(expected.cases.map((c) => [c.id, c]));
  const reports = [];

  for (const c of raw.cases) {
    const exp = expectedById.get(c.id);
    if (!exp) {
      reports.push({ id: c.id, status: "missing-expected" });
      continue;
    }
    const actualPlayers = c.actual.players;
    const expectedPlayers = Array.isArray(exp.expectedPlayers)
      ? exp.expectedPlayers
      : [];
    const diffs = diffPlayers(expectedPlayers, actualPlayers);
    reports.push({
      id: c.id,
      status: diffs.length ? "fail" : "pass",
      expectedCount: expectedPlayers.length,
      actualCount: actualPlayers.length,
      diffs,
      reviewNotes: exp.reviewNotes || [],
    });
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    total: reports.length,
    pass: reports.filter((r) => r.status === "pass").length,
    fail: reports.filter((r) => r.status !== "pass").length,
    reports,
  };
  fs.writeFileSync(REPORT_JSON, JSON.stringify(summary, null, 2) + "\n", "utf8");
  fs.writeFileSync(REPORT_MD, renderCompareMarkdown(summary), "utf8");
  console.log(`Wrote ${path.relative(ROOT, REPORT_JSON)}`);
  console.log(`Wrote ${path.relative(ROOT, REPORT_MD)}`);
  console.log(`Pass: ${summary.pass}/${summary.total}`);
  if (summary.fail) process.exitCode = 1;
}

function diffPlayers(expected, actual) {
  const diffs = [];
  const expectedMap = countByKey(expected);
  const actualMap = countByKey(actual);
  const keys = new Set([...expectedMap.keys(), ...actualMap.keys()]);
  for (const key of [...keys].sort()) {
    const eCount = expectedMap.get(key) || 0;
    const aCount = actualMap.get(key) || 0;
    if (eCount === aCount) continue;
    if (eCount > aCount) {
      diffs.push({
        type: "missing-actual",
        expectedCount: eCount,
        actualCount: aCount,
        expected: parseRecordKey(key),
      });
    } else {
      diffs.push({
        type: "extra-actual",
        expectedCount: eCount,
        actualCount: aCount,
        actual: parseRecordKey(key),
      });
    }
  }
  return diffs;
}

function compareCanonicalPlayer(a, b) {
  const ak = canonicalPlayerKey(a);
  const bk = canonicalPlayerKey(b);
  return ak < bk ? -1 : ak > bk ? 1 : 0;
}

function canonicalPlayerKey(p) {
  return [
    p && p.group,
    p && p.platform,
    p && p.displayName,
    p && p.account,
    p && p.club,
    p && p.isNew ? "1" : "0",
  ]
    .map((x) => String(x ?? "").toLowerCase())
    .join("\u0001");
}

function canonicalRecordKey(p) {
  return [
    p && p.displayName,
    p && p.account,
    p && p.club,
    p && p.group,
    p && p.platform,
    p && p.isNew ? "1" : "0",
  ]
    .map((x) => String(x ?? ""))
    .join("\u001f");
}

function countByKey(list) {
  const map = new Map();
  for (const item of list || []) {
    const key = canonicalRecordKey(item);
    map.set(key, (map.get(key) || 0) + 1);
  }
  return map;
}

function parseRecordKey(key) {
  const [displayName, account, club, group, platform, isNew] = String(
    key || "",
  ).split("\u001f");
  return {
    displayName,
    account,
    club,
    group,
    platform,
    isNew: isNew === "1",
  };
}

function renderCompareMarkdown(summary) {
  const out = [];
  out.push("# Benchmark Compare Report");
  out.push("");
  out.push(`Generated: ${summary.generatedAt}`);
  out.push(`Pass: ${summary.pass}/${summary.total}`);
  out.push("");
  for (const r of summary.reports) {
    if (r.status === "pass") continue;
    out.push(`## ${r.id}`);
    out.push("");
    out.push(`Status: ${r.status}`);
    out.push(`Expected: ${r.expectedCount}; Actual: ${r.actualCount}`);
    if (r.reviewNotes && r.reviewNotes.length) {
      out.push("");
      out.push("Review notes:");
      r.reviewNotes.forEach((note) => out.push(`- ${note}`));
    }
    out.push("");
    out.push("| type | expectedCount | actualCount | record |");
    out.push("|---|---:|---:|---|");
    r.diffs.slice(0, 80).forEach((d) => {
      const rec = d.expected || d.actual || {};
      out.push(
        `| ${md(d.type)} | ${d.expectedCount ?? ""} | ${d.actualCount ?? ""} | ${md(
          JSON.stringify(rec),
        )} |`,
      );
    });
    if (r.diffs.length > 80)
      out.push(`| ... |  |  | ${r.diffs.length - 80} more |`);
    out.push("");
  }
  return out.join("\n") + "\n";
}

const cmd = process.argv[2] || "generate";
if (cmd === "generate") {
  generateRaw();
} else if (cmd === "seed-expected") {
  makeExpectedFromRaw();
} else if (cmd === "clean-expected") {
  makeCleanExpectedFromRaw();
} else if (cmd === "compare") {
  compare();
} else {
  console.error(
    "Usage: node benchmarks/benchmark.js [generate|seed-expected|clean-expected|compare]",
  );
  process.exit(2);
}

function makeCleanExpectedFromRaw() {
  ensureDir(FIXTURE_DIR);
  const raw = JSON.parse(readUtf8(RAW_JSON));
  const cleaned = {
    generatedFrom: "benchmarks/output/baseline.raw.json",
    reviewedAt: new Date().toISOString(),
    reviewStatus: "Manually reviewed baseline with targeted corrections.",
    cases: raw.cases.map((c) => ({
      id: c.id,
      file: c.file,
      title: c.title,
      sourceLines: `${c.startLine}-${c.endLine}`,
      expectedPlayers: buildCleanExpectedPlayers(c),
      reviewNotes: buildReviewNotes(c),
    })),
  };
  fs.writeFileSync(EXPECTED_JSON, JSON.stringify(cleaned, null, 2) + "\n", "utf8");
  console.log(`Wrote ${path.relative(ROOT, EXPECTED_JSON)}`);
}

function buildReviewNotes(c) {
  const notes = [];
  if (c.file === "Longterm_player.txt") {
    notes.push("Rebuilt from source list; '--' rows excluded.");
    return notes;
  }
  if (
    c.id === "New_comer_group__01" ||
    c.id === "New_comer_group__13"
  ) {
    notes.push("Merged emoji nickname with its account.");
    notes.push("Dropped header noise.");
  }
  if (c.id === "New_comer_group__02" || c.id === "New_comer_group__03") {
    notes.push("Split compact name/account/club rows.");
    notes.push("Dropped header noise.");
    if (c.id === "New_comer_group__03") {
      notes.push("Removed referee row: 深红 Eklos HTN.");
    }
  }
  if (
    c.id === "New_comer_group__05" ||
    c.id === "New_comer_group__09" ||
    c.id === "New_comer_group__10" ||
    c.id === "New_comer_group__11" ||
    c.id === "New_comer_group__12" ||
    c.id === "New_comer_group__15"
  ) {
    notes.push("Removed decoration / sponsor / placeholder rows.");
  }
  return notes;
}

function buildCleanExpectedPlayers(c) {
  if (c.file === "Longterm_player.txt") {
    return buildLongtermExpectedPlayers(c);
  }

  const players = c.actual.players.map((p) => ({ ...p }));

  removeByDisplay(players, /^(当前擂主|赛后抽奖|本次赞助|请接龙|接个龙先|👇|⬇️|↓)/);

  if (c.id === "New_comer_group__01" || c.id === "New_comer_group__13") {
    removeByDisplay(players, /^🌈晴天小🐷$/);
    removeByDisplay(players, /^zz068627$/);
    players.push(
      makePlayerRecord({
        displayName: "🌈晴天小🐷",
        account: "zz068627",
        group: "新人赛",
        platform: "oq",
      }),
    );
  }

  if (c.id === "New_comer_group__02") {
    replaceFirstMatch(
      players,
      (p) => p.displayName === "浅红 lightred" && p.account === "RedSKIN",
      makePlayerRecord({
        displayName: "浅红",
        account: "lightred",
        club: "RedSKIN",
        group: "新人赛",
        platform: "oq",
      }),
    );
    replaceFirstMatch(
      players,
      (p) => p.displayName === "🍂shierqi",
      makePlayerRecord({
        displayName: "🍂",
        account: "shierqi",
        group: "新人赛",
        platform: "oq",
      }),
    );
    replaceFirstMatch(
      players,
      (p) => p.displayName === "残月W_six断藤斋",
      makePlayerRecord({
        displayName: "残月",
        account: "W_six",
        club: "断藤斋",
        group: "新人赛",
        platform: "oq",
      }),
    );
  }

  if (c.id === "New_comer_group__03") {
    removeByDisplay(players, /^深红$/);
    replaceFirstMatch(
      players,
      (p) => p.displayName === "残月WSix断藤斋",
      makePlayerRecord({
        displayName: "残月",
        account: "WSix",
        club: "断藤斋",
        group: "新人赛",
        platform: "oq",
      }),
    );
  }

  if (c.id === "New_comer_group__05") {
    replaceFirstMatch(
      players,
      (p) => p.displayName === "破棋 灵灵",
      makePlayerRecord({
        displayName: "破棋",
        account: "灵灵",
        group: "新人赛",
        platform: "oq",
      }),
    );
    replaceFirstMatch(
      players,
      (p) => p.displayName === "棒棒糖 谷谷",
      makePlayerRecord({
        displayName: "棒棒糖",
        account: "谷谷",
        group: "新人赛",
        platform: "oq",
      }),
    );
    replaceFirstMatch(
      players,
      (p) => p.displayName === "准一 16岁",
      makePlayerRecord({
        displayName: "准一",
        account: "16岁",
        group: "新人赛",
        platform: "oq",
      }),
    );
  }

  if (c.id === "New_comer_group__11") {
    removeByDisplay(players, /^本次赞助 芒芴$/);
    replaceFirstMatch(
      players,
      (p) => p.displayName === "陈建时18526067378" && p.account === "ah024022",
      makePlayerRecord({
        displayName: "陈建时",
        account: "18526067378",
        club: "ah024022",
        group: "新人赛",
        platform: "oq",
      }),
    );
  }

  if (c.id === "New_comer_group__09") {
    removeByDisplay(players, /^赛后抽奖 2025亚锦赛纪念折扇$/);
  }

  if (c.id === "New_comer_group__10") {
    removeByDisplay(players, /^赛后抽奖 2025亚锦赛纪念T恤$/);
    removeByDisplay(players, /^👇$/);
  }

  if (c.id === "New_comer_group__11") {
    removeByDisplay(players, /^本次赞助 芒芴$/);
  }

  if (c.id === "New_comer_group__12") {
    removeByDisplay(players, /^👇$/);
  }

  if (c.id === "New_comer_group__14") {
    replaceFirstMatch(
      players,
      (p) => p.displayName === "AYANO" && p.account === "HOHNER",
      makePlayerRecord({
        displayName: "AYANO HOHNER",
        account: "ayanolain",
        group: "新人赛",
        platform: "oq",
      }),
    );
  }

  if (c.id === "Junior_group__15") {
    replaceFirstMatch(
      players,
      (p) => String(p.displayName || "").startsWith(".陈书则"),
      makePlayerRecord({
        displayName: "陈书则",
        account: "chenshuze",
        group: "青少年组",
        platform: "oq",
      }),
    );
    replaceFirstMatch(
      players,
      (p) => p.displayName === "韩炜，Henry513" || p.displayName === "韩炜,Henry513",
      makePlayerRecord({
        displayName: "韩炜",
        account: "Henry513",
        group: "青少年组",
        platform: "oq",
      }),
    );
  }

  if (c.id === "Junior_group__11") {
    removeByDisplay(players, /^⬇️$/);
  }

  return players.sort(compareCanonicalPlayer);
}

function buildLongtermExpectedPlayers(c) {
  const players = [];
  const seen = new Set();
  for (const entry of c.sourceEntries) {
    const line = String(entry.text || "").trim();
    if (!line || /--/.test(line)) continue;
    const name = parser.normalizeWhitespace(line.replace(/\s*--\s*$/, ""));
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    players.push(
      makePlayerRecord({
        displayName: name,
        account: "",
        club: "",
        group: "长期名单",
        platform: "oq",
      }),
    );
  }
  return players.sort(compareCanonicalPlayer);
}

function makePlayerRecord(fields) {
  return {
    displayName: String(fields.displayName || ""),
    account: String(fields.account || ""),
    club: String(fields.club || ""),
    group: String(fields.group || ""),
    platform: String(fields.platform || ""),
    isNew: Boolean(fields.isNew),
  };
}

function removeByDisplay(players, pattern) {
  for (let i = players.length - 1; i >= 0; i--) {
    if (pattern.test(String(players[i].displayName || ""))) {
      players.splice(i, 1);
    }
  }
}

function replaceFirstMatch(players, predicate, replacement) {
  const idx = players.findIndex(predicate);
  if (idx >= 0) {
    players.splice(idx, 1, replacement);
    return true;
  }
  return false;
}
