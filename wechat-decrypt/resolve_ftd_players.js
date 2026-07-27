"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DEFAULT_API = "http://127.0.0.1:4174/api/state";
const SOCKET_URL = "wss://flipthedisc.com/socket.io/?EIO=4&transport=websocket";
const NAME_OVERRIDE_FILE = path.join(__dirname, "ftd_player_name_overrides.json");

const MATCHED_STATUSES = new Set([
  "matched-single",
  "matched-highest-rating",
  "matched-random-tie",
]);
const LOCKED_STATUSES = new Set([
  "referee-manual",
  "referee-new",
  "excluded",
  "console-batch-pending",
  "ftd-written",
  "ftd-write-failed",
]);

const SURNAME_PREFIXES = [
  "ouyang", "sima", "shangguan", "zhuge", "huangfu", "situ", "murong",
  "ai", "an", "ao", "bai", "bao", "bei", "bi", "bian", "bo", "bu",
  "cai", "cao", "cen", "chai", "chang", "che", "chen", "cheng", "chi", "chong", "chu", "cui",
  "dai", "dan", "dang", "deng", "di", "ding", "dong", "dou", "du", "duan",
  "fan", "fang", "fei", "feng", "fu", "gao", "ge", "geng", "gong", "gu", "guan", "guo",
  "han", "hao", "he", "heng", "hong", "hou", "hu", "hua", "huan", "huang", "hui", "huo",
  "ji", "jia", "jiang", "jiao", "jie", "jin", "jing", "ju", "kan", "kang", "ke", "kong", "kuang",
  "lai", "lan", "lang", "lao", "lei", "leng", "li", "lian", "liang", "liao", "lin", "ling", "liu", "long", "lou", "lu", "luan", "luo", "lv",
  "ma", "mai", "man", "mao", "mei", "meng", "mi", "miao", "min", "ming", "mo", "mou", "mu",
  "na", "nan", "ni", "nian", "nie", "ning", "niu", "nong", "pan", "pang", "pei", "peng", "pi", "ping", "pu",
  "qi", "qian", "qiang", "qiao", "qin", "qiu", "qu", "quan", "ran", "rao", "ren", "rong", "ruan",
  "sang", "sha", "shan", "shang", "shao", "she", "shen", "sheng", "shi", "shu", "shui", "song", "su", "sun",
  "tan", "tang", "tao", "teng", "tian", "tong", "tu", "wan", "wang", "wei", "wen", "weng", "wu",
  "xi", "xia", "xiang", "xiao", "xie", "xin", "xing", "xiong", "xu", "xuan", "xue",
  "yan", "yang", "yao", "ye", "yi", "yin", "ying", "you", "yu", "yuan", "yue", "yun",
  "zang", "zeng", "zha", "zhai", "zhan", "zhang", "zhao", "zhen", "zheng", "zhi", "zhong", "zhou", "zhu", "zhuang", "zi", "zou", "zu", "zuo",
].sort((a, b) => b.length - a.length || a.localeCompare(b));

const PINYIN_SYLLABLES = new Set((
  "a ai an ang ao ba bai ban bang bao bei ben beng bi bian biao bie bin bing bo bu " +
  "ca cai can cang cao ce cen ceng cha chai chan chang chao che chen cheng chi chong chou chu chua chuai chuan chuang chui chun chuo ci cong cou cu cuan cui cun cuo " +
  "da dai dan dang dao de dei deng di dia dian diao die ding diu dong dou du duan dui dun duo " +
  "e ei en eng er fa fan fang fei fen feng fo fou fu " +
  "ga gai gan gang gao ge gei gen geng gong gou gu gua guai guan guang gui gun guo " +
  "ha hai han hang hao he hei hen heng hong hou hu hua huai huan huang hui hun huo " +
  "ji jia jian jiang jiao jie jin jing jiong jiu ju juan jue jun " +
  "ka kai kan kang kao ke ken keng kong kou ku kua kuai kuan kuang kui kun kuo " +
  "la lai lan lang lao le lei leng li lia lian liang liao lie lin ling liu long lou lu luan lue lun luo lv lve " +
  "ma mai man mang mao me mei men meng mi mian miao mie min ming miu mo mou mu " +
  "na nai nan nang nao ne nei nen neng ni nian niang niao nie nin ning niu nong nou nu nuan nue nuo nv nve " +
  "o ou pa pai pan pang pao pei pen peng pi pian piao pie pin ping po pou pu " +
  "qi qia qian qiang qiao qie qin qing qiong qiu qu quan que qun " +
  "ran rang rao re ren reng ri rong rou ru rua ruan rui run ruo " +
  "sa sai san sang sao se sen seng sha shai shan shang shao she shen sheng shi shou shu shua shuai shuan shuang shui shun shuo si song sou su suan sui sun suo " +
  "ta tai tan tang tao te teng ti tian tiao tie ting tong tou tu tuan tui tun tuo " +
  "wa wai wan wang wei wen weng wo wu " +
  "xi xia xian xiang xiao xie xin xing xiong xiu xu xuan xue xun " +
  "ya yan yang yao ye yi yin ying yo yong you yu yuan yue yun " +
  "za zai zan zang zao ze zei zen zeng zha zhai zhan zhang zhao zhe zhen zheng zhi zhong zhou zhu zhua zhuai zhuan zhuang zhui zhun zhuo zi zong zou zu zuan zui zun zuo"
).split(/\s+/));

function clean(value) {
  return String(value == null ? "" : value).replace(/[\s\u3000]+/g, " ").trim();
}

function nameKey(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9\u00c0-\u024f]+/g, "");
}

function titlePart(value) {
  const raw = clean(value).toLowerCase();
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "";
}

function formatName(parts) {
  if (!Array.isArray(parts) || parts.length < 2) return "";
  const surname = titlePart(parts[0]);
  const given = parts.slice(1).map(titlePart).join("");
  return surname && given ? `${surname} ${given}` : "";
}

let cachedNameOverrides = null;

function loadNameOverrides(filePath = NAME_OVERRIDE_FILE) {
  if (filePath === NAME_OVERRIDE_FILE && cachedNameOverrides) return cachedNameOverrides;
  if (!fs.existsSync(filePath)) {
    if (filePath === NAME_OVERRIDE_FILE) {
      cachedNameOverrides = [];
      return cachedNameOverrides;
    }
    throw new Error(`FTD Player 姓名覆盖表不存在：${filePath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const entries = Array.isArray(parsed && parsed.entries) ? parsed.entries : [];
  const seen = new Set();
  const safe = entries.map((entry, index) => {
    const account = clean(entry && entry.account).toLowerCase();
    const rosterName = clean(entry && entry.rosterName);
    const tokens = clean(entry && entry.normalizedName).split(" ").filter(Boolean);
    const normalizedName = formatName(tokens);
    if ((!account && !rosterName) || !normalizedName) {
      throw new Error(`FTD Player 姓名覆盖表第 ${index + 1} 项无效`);
    }
    const identity = account ? `account:${account}` : `roster:${nameKey(rosterName)}`;
    if (seen.has(identity)) throw new Error(`FTD Player 姓名覆盖表存在重复项：${identity}`);
    seen.add(identity);
    return { account, rosterName, normalizedName };
  });
  if (filePath === NAME_OVERRIDE_FILE) cachedNameOverrides = safe;
  return safe;
}

function findNameOverride(player, overrides = loadNameOverrides()) {
  const entries = Array.isArray(overrides) ? overrides : [];
  const account = clean(player && player.account).toLowerCase();
  if (account) {
    const byAccount = entries.find((entry) => entry.account === account);
    if (byAccount) return byAccount;
  }
  const rosterName = nameKey(player && (player.displayName || player.name));
  return rosterName
    ? entries.find((entry) => entry.rosterName && nameKey(entry.rosterName) === rosterName) || null
    : null;
}

function splitExplicitName(value) {
  const normalized = clean(value)
    .replace(/[＿_／/\\|－—–-]+/g, " ")
    .replace(/[·•]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized || /[^A-Za-zÀ-ɏ' .-]/u.test(normalized)) return null;
  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens.length >= 2) return { normalizedName: formatName(tokens), method: "explicit-separator" };
  return { compact: tokens[0] || "" };
}

function splitCaseBoundary(value) {
  const raw = clean(value);
  const tokens = raw.split(/(?<=[a-zà-ɏ])(?=[A-ZÀ-Þ])/u).filter(Boolean);
  if (tokens.length === 2) return formatName(tokens);
  return "";
}

function splitCompactPinyin(value) {
  const raw = clean(value).toLowerCase().replace(/[^a-z]/g, "");
  if (!raw) return "";
  function canSegmentGivenName(given) {
    const memo = new Map();
    function visit(offset, parts) {
      const memoKey = `${offset}:${parts}`;
      if (memo.has(memoKey)) return memo.get(memoKey);
      if (offset === given.length) return parts >= 1 && parts <= 3;
      if (parts >= 3) return false;
      for (let end = offset + 1; end <= given.length; end += 1) {
        if (PINYIN_SYLLABLES.has(given.slice(offset, end)) && visit(end, parts + 1)) {
          memo.set(memoKey, true);
          return true;
        }
      }
      memo.set(memoKey, false);
      return false;
    }
    return visit(0, 0);
  }
  const viable = SURNAME_PREFIXES.filter((surname) => {
    if (!raw.startsWith(surname)) return false;
    const given = raw.slice(surname.length);
    return given.length >= 2 && canSegmentGivenName(given);
  });
  if (viable.length !== 1) return "";
  return formatName([viable[0], raw.slice(viable[0].length)]);
}

function candidatePlayerName(candidate) {
  return clean(`${candidate && candidate.surname || ""} ${candidate && candidate.name || ""}`);
}

function historyHints(state, player) {
  const mapping = state && state.ftdPlayerAccountMapping;
  const rows = mapping && Array.isArray(mapping.players) ? mapping.players : [];
  const playerName = nameKey(player && (player.displayName || player.name));
  const account = clean(player && player.account).toLowerCase();
  const matches = rows.filter((row) => {
    if (!row || typeof row !== "object" || row.deleted === true) return false;
    const rowAccount = clean(row.account).toLowerCase();
    const names = [row.ftdName, row.displayName, row.name, row.wofName].map(nameKey).filter(Boolean);
    return Boolean((account && rowAccount === account) || (playerName && names.includes(playerName)));
  });
  const names = Array.from(new Set(matches.map((row) => clean(row.ftdName || row.displayName || row.name)).filter(Boolean)));
  return names.length === 1 ? names[0] : "";
}

function normalizePlayerName(player, state, overrides) {
  const override = findNameOverride(player, overrides === undefined ? loadNameOverrides() : overrides);
  if (override) {
    return {
      ok: true,
      normalizedName: override.normalizedName,
      method: override.account ? "account" : "roster-name",
      source: "manual-name-override-table",
    };
  }
  const fields = [
    ["ftdName", player && player.ftdName],
    ["pinyinName", player && player.pinyinName],
    ["pinyin", player && player.pinyin],
    ["romanizedName", player && player.romanizedName],
    ["englishName", player && player.englishName],
    ["historicalName", player && player.historicalName],
  ];
  const hint = historyHints(state, player);
  if (hint) fields.unshift(["historical-ftd-map", hint]);
  fields.push(["displayName", player && (player.displayName || player.name)]);

  for (const [source, rawValue] of fields) {
    const raw = clean(rawValue);
    if (!raw) continue;
    const explicit = splitExplicitName(raw);
    if (!explicit) continue;
    if (explicit.normalizedName) {
      return { ok: true, normalizedName: explicit.normalizedName, method: explicit.method, source };
    }
    const caseName = splitCaseBoundary(explicit.compact);
    if (caseName) return { ok: true, normalizedName: caseName, method: "case-boundary", source };
    const compactName = splitCompactPinyin(explicit.compact);
    if (compactName) return { ok: true, normalizedName: compactName, method: "surname-prefix", source };
  }
  return {
    ok: false,
    normalizedName: "",
    method: "unresolved",
    source: "",
    error: "无法把姓名安全整理为 Surname Givenname",
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function dedupePackets(packets) {
  const seenPackets = new Set();
  const seenIds = new Set();
  const candidates = [];
  for (const packet of Array.isArray(packets) ? packets : []) {
    if (!Array.isArray(packet)) continue;
    const packetKey = stableJson(packet);
    if (seenPackets.has(packetKey)) continue;
    seenPackets.add(packetKey);
    for (const candidate of packet) {
      if (!candidate || typeof candidate !== "object") continue;
      const id = candidate.id == null ? "" : String(candidate.id);
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      candidates.push(candidate);
    }
  }
  return { candidates, packetCount: seenPackets.size };
}

function exactNameCandidates(candidates, normalizedName) {
  const expected = nameKey(normalizedName);
  return (Array.isArray(candidates) ? candidates : []).filter((candidate) => {
    const forward = nameKey(`${candidate.surname || ""} ${candidate.name || ""}`);
    const reverse = nameKey(`${candidate.name || ""} ${candidate.surname || ""}`);
    return forward === expected || reverse === expected;
  });
}

function slimPlayer(candidate) {
  const rating = candidate && candidate.rating != null && candidate.rating !== "" ? Number(candidate.rating) : null;
  return {
    id: Number(candidate.id),
    wof_id: candidate.wof_id == null || candidate.wof_id === "" ? null : Number(candidate.wof_id),
    name: clean(candidate.name),
    surname: clean(candidate.surname),
    rating: Number.isFinite(rating) ? rating : null,
    country_code: clean(candidate.country_code).toUpperCase(),
  };
}

function chooseCandidate(candidates, randomFn = Math.random) {
  const list = (Array.isArray(candidates) ? candidates : []).map(slimPlayer).filter((item) => Number.isFinite(item.id));
  if (!list.length) return { status: "unmatched", selectionRule: "no-result", selectedPlayer: null, tiedPlayerIds: [] };
  if (list.length === 1) {
    return { status: "matched-single", selectionRule: "single-result", selectedPlayer: list[0], tiedPlayerIds: [] };
  }
  const numeric = list.filter((item) => Number.isFinite(item.rating));
  const pool = numeric.length
    ? numeric.filter((item) => item.rating === Math.max(...numeric.map((entry) => entry.rating)))
    : list;
  if (pool.length === 1) {
    return {
      status: "matched-highest-rating",
      selectionRule: "highest-numeric-rating",
      selectedPlayer: pool[0],
      tiedPlayerIds: [],
    };
  }
  const index = Math.min(pool.length - 1, Math.floor(Math.max(0, Math.min(0.999999999, Number(randomFn()) || 0)) * pool.length));
  return {
    status: "matched-random-tie",
    selectionRule: numeric.length ? "random-highest-rating-tie" : "random-all-null-rating-tie",
    selectedPlayer: pool[index],
    tiedPlayerIds: pool.map((item) => item.id),
  };
}

function rowIdForPlayer(player) {
  const id = Number(player && player.id);
  return Number.isFinite(id) && id > 0 ? `roster:${Math.trunc(id)}` : "";
}

function rosterSignature(player) {
  return [clean(player && (player.displayName || player.name)).toLowerCase(), clean(player && player.account).toLowerCase(), clean(player && player.group).toLowerCase()].join("|");
}

function syncRows(registration, players) {
  const currentRows = registration && Array.isArray(registration.rows) ? registration.rows : [];
  const byId = new Map(currentRows.map((row) => [clean(row.rowId), row]));
  return (Array.isArray(players) ? players : []).map((player) => {
    const rowId = rowIdForPlayer(player);
    const existing = byId.get(rowId);
    const signature = rosterSignature(player);
    if (existing && LOCKED_STATUSES.has(clean(existing.status))) {
      return {
        ...existing,
        rosterName: clean(player.displayName || player.name),
        rosterAccount: clean(player.account),
        rosterGroup: clean(player.group),
        rosterSignature: signature,
      };
    }
    if (existing && existing.rosterSignature === signature) return { ...existing };
    return {
      rowId,
      playerId: Math.trunc(Number(player.id)),
      rosterName: clean(player.displayName || player.name),
      rosterAccount: clean(player.account),
      rosterGroup: clean(player.group),
      rosterSignature: signature,
      normalizedName: "",
      nameSource: "",
      status: "pending",
      resolutionStatus: "",
      selectionRule: "",
      selectedPlayer: null,
      tiedPlayerIds: [],
      candidateCount: 0,
      resolverBatchId: "",
      resolvedAt: "",
      newPlayer: null,
      categories: [],
      family: "",
      errorCode: "",
      errorMessage: "",
      console: {},
    };
  });
}

class FtdSocketQuery {
  constructor(url = SOCKET_URL) {
    this.url = url;
    this.socket = null;
    this.openPromise = null;
    this.pending = null;
  }

  async connect() {
    if (this.openPromise) return this.openPromise;
    this.openPromise = new Promise((resolve, reject) => {
      let ready = false;
      const socket = new WebSocket(this.url);
      this.socket = socket;
      const timer = setTimeout(() => finish(new Error("FTD Socket.IO 连接超时")), 10000);
      const finish = (error) => {
        if (ready) return;
        ready = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve();
      };
      socket.addEventListener("open", () => {});
      socket.addEventListener("error", () => finish(new Error("FTD Socket.IO 连接失败")));
      socket.addEventListener("close", () => {
        if (!ready) finish(new Error("FTD Socket.IO 在握手前关闭"));
        if (this.pending) this.pending.reject(new Error("FTD Socket.IO 在查询中关闭"));
      });
      socket.addEventListener("message", (event) => {
        const message = String(event.data || "");
        if (message.startsWith("0")) {
          socket.send("40");
          return;
        }
        if (message === "2") {
          socket.send("3");
          return;
        }
        if (message.startsWith("40")) {
          finish(null);
          return;
        }
        if (!message.startsWith("42") || !this.pending) return;
        let packet;
        try { packet = JSON.parse(message.slice(2)); } catch (_) { return; }
        if (!Array.isArray(packet) || packet[0] !== "wof-players-list") return;
        const payload = packet[1];
        if (payload === null) {
          this.pending.reject(new Error("FTD 返回 wof-players-list: null；已拒绝把查询错误当成无结果"));
          return;
        }
        if (!Array.isArray(payload)) {
          this.pending.reject(new Error("FTD wof-players-list 响应格式异常"));
          return;
        }
        this.pending.packets.push(payload);
        clearTimeout(this.pending.quietTimer);
        this.pending.quietTimer = setTimeout(() => this.pending && this.pending.resolve(), 300);
      });
    });
    return this.openPromise;
  }

  async query(normalizedName) {
    await this.connect();
    if (this.pending) throw new Error("FTD 查询必须串行执行");
    return new Promise((resolve, reject) => {
      const pending = {
        packets: [],
        quietTimer: null,
        timeout: null,
        resolve: () => finish(null),
        reject: (error) => finish(error),
      };
      const finish = (error) => {
        if (this.pending !== pending) return;
        clearTimeout(pending.timeout);
        clearTimeout(pending.quietTimer);
        this.pending = null;
        if (error) reject(error); else resolve(dedupePackets(pending.packets));
      };
      pending.timeout = setTimeout(() => finish(new Error(`FTD Player 查询超时：${normalizedName}`)), 10000);
      this.pending = pending;
      this.socket.send(`42${JSON.stringify(["get-wof-players", normalizedName, 0])}`);
    });
  }

  close() {
    try { if (this.socket) this.socket.close(); } catch (_) {}
  }
}

function parseArgs(argv) {
  const options = { api: DEFAULT_API, fixture: "", seed: "", namesReviewed: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--api") options.api = argv[++index] || "";
    else if (arg === "--fixture") options.fixture = argv[++index] || "";
    else if (arg === "--seed") options.seed = argv[++index] || "";
    else if (arg === "--names-reviewed") options.namesReviewed = true;
    else if (arg === "-h" || arg === "--help") options.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

function buildNameReviewPacket(state, revision) {
  if (!state || !Array.isArray(state.players)) throw new Error("共享状态缺少 players[]");
  const rows = syncRows(state.ftdPlayerRegistration || {}, state.players).map((row) => {
    const player = state.players.find((item) => rowIdForPlayer(item) === row.rowId);
    const parsed = normalizePlayerName(player, state);
    return {
      rowId: row.rowId,
      playerId: row.playerId,
      rosterName: row.rosterName,
      rosterAccount: row.rosterAccount,
      rosterGroup: row.rosterGroup,
      proposedNormalizedName: parsed.ok ? parsed.normalizedName : "",
      normalizationSource: parsed.ok ? `${parsed.source}:${parsed.method}` : "",
      reviewStatus: parsed.ok ? "needs-agent-manual-name-review" : "name-parse-unresolved",
      detail: parsed.ok
        ? "Agent 必须把原始姓名与现有名单、历史字段及已知信息逐行核对，不能只接受脚本拆分结果"
        : parsed.error,
    };
  });
  return {
    ok: false,
    type: "ftd-player-name-review-required",
    queryStarted: false,
    stateWritten: false,
    revision,
    total: rows.length,
    instruction: "FTD 查询前的 Agent 人工姓名核对是强制步骤。请逐行查阅全部名单，确认姓名已按当前已知信息正常录入，并确认拟整理姓名无误；不要静默猜测。完成后再加 --names-reviewed 运行。",
    nextCommand: ".\\wechat-decrypt\\agent_tournament_helper.cmd resolve-ftd-players --names-reviewed",
    rows,
  };
}

function seededRandom(seedText) {
  if (!seedText) return Math.random;
  let value = crypto.createHash("sha256").update(String(seedText), "utf8").digest().readUInt32LE(0);
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

function fixtureQuery(fixture) {
  return async (normalizedName) => {
    const key = clean(normalizedName).toLowerCase();
    const packets = fixture && Object.prototype.hasOwnProperty.call(fixture, key) ? fixture[key] : [];
    if (!Array.isArray(packets)) throw new Error(`测试夹具格式错误：${normalizedName}`);
    const normalizedPackets = packets.length && Array.isArray(packets[0]) ? packets : [packets];
    return dedupePackets(normalizedPackets);
  };
}

async function resolveState(state, revision, queryFn, randomFn, nowIso, batchId) {
  if (!state || !Array.isArray(state.players)) throw new Error("共享状态缺少 players[]");
  const registration = state.ftdPlayerRegistration && typeof state.ftdPlayerRegistration === "object"
    ? state.ftdPlayerRegistration
    : {};
  if (registration.pendingBatch && registration.pendingBatch.status === "pending") {
    throw new Error("存在待确认的 Console 批次；请先回到前端按 Shift+Enter 处理结果");
  }
  const rows = syncRows(registration, state.players);
  const summary = {
    total: rows.length,
    matched: 0,
    single: 0,
    highestRating: 0,
    randomTie: 0,
    unmatched: 0,
    nameParseUnresolved: 0,
    preservedRefereeRows: 0,
  };
  const review = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (LOCKED_STATUSES.has(row.status)) {
      summary.preservedRefereeRows += 1;
      continue;
    }
    const player = state.players.find((item) => rowIdForPlayer(item) === row.rowId);
    const parsed = normalizePlayerName(player, state);
    row.resolverBatchId = batchId;
    row.resolvedAt = nowIso;
    row.errorCode = "";
    row.errorMessage = "";
    if (!parsed.ok) {
      row.normalizedName = "";
      row.nameSource = "";
      row.status = "name-parse-unresolved";
      row.resolutionStatus = "";
      row.selectionRule = "name-parse-unresolved";
      row.selectedPlayer = null;
      row.tiedPlayerIds = [];
      row.candidateCount = 0;
      row.errorCode = "name-parse-unresolved";
      row.errorMessage = parsed.error;
      summary.nameParseUnresolved += 1;
      review.push({ rowId: row.rowId, playerId: row.playerId, rosterName: row.rosterName, status: row.status, detail: parsed.error });
      continue;
    }
    row.normalizedName = parsed.normalizedName;
    row.nameSource = `${parsed.source}:${parsed.method}`;
    const response = await queryFn(parsed.normalizedName);
    const exact = exactNameCandidates(response.candidates, parsed.normalizedName);
    const selected = chooseCandidate(exact, randomFn);
    row.status = selected.status;
    row.resolutionStatus = MATCHED_STATUSES.has(selected.status) ? selected.status : "";
    row.selectionRule = selected.selectionRule;
    row.selectedPlayer = selected.selectedPlayer;
    row.tiedPlayerIds = selected.tiedPlayerIds;
    row.candidateCount = exact.length;
    if (MATCHED_STATUSES.has(selected.status)) {
      summary.matched += 1;
      if (selected.status === "matched-single") summary.single += 1;
      else if (selected.status === "matched-highest-rating") summary.highestRating += 1;
      else summary.randomTie += 1;
    } else {
      summary.unmatched += 1;
      review.push({ rowId: row.rowId, playerId: row.playerId, rosterName: row.rosterName, normalizedName: row.normalizedName, status: row.status, detail: "FTD 查询无精确姓名结果；未自动标记新人" });
    }
  }
  const nextRegistration = {
    type: "ftd-player-registration",
    schemaVersion: 1,
    updatedAt: nowIso,
    resolverBatchId: batchId,
    resolvedAt: nowIso,
    sourceRevision: revision,
    rows,
    pendingBatch: null,
    consumedBatchIds: Array.isArray(registration.consumedBatchIds) ? registration.consumedBatchIds : [],
  };
  return { registration: nextRegistration, summary, review };
}

async function getState(api) {
  let response;
  try { response = await fetch(`${api}?t=${Date.now()}`, { headers: { Accept: "application/json" } }); }
  catch (error) { throw new Error(`本地同步 API 不可用：${error.message}`); }
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.ok !== true || !payload.state) {
    throw new Error(`本地同步 API 读取失败：HTTP ${response.status}`);
  }
  return payload;
}

async function postState(api, state, revision, registration) {
  const response = await fetch(api, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", Accept: "application/json" },
    body: JSON.stringify({
      source: "agent-resolve-ftd-players",
      baseRevision: revision,
      state: { ...state, ftdPlayerRegistration: registration, savedAt: Date.now() },
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.ok !== true) {
    const detail = payload && (payload.detail || payload.error);
    throw new Error(`本地同步 API 写入失败：${detail || `HTTP ${response.status}`}`);
  }
  const written = payload.state && payload.state.ftdPlayerRegistration;
  if (!written || written.resolverBatchId !== registration.resolverBatchId) {
    throw new Error("本地同步 API 返回状态未包含本次 FTD Player 核对批次");
  }
  return payload;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log("Usage: agent_tournament_helper.cmd resolve-ftd-players [--names-reviewed] [--api http://127.0.0.1:4174/api/state]");
    console.log("先不带 --names-reviewed 生成完整姓名人工核对清单；Agent 逐行核对后才可加该参数查询并写回。");
    return 0;
  }
  const current = await getState(options.api);
  if (!options.namesReviewed) {
    console.log(JSON.stringify(buildNameReviewPacket(current.state, current.revision), null, 2));
    return 2;
  }
  const nowIso = new Date().toISOString();
  const batchId = `resolve-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  let socket = null;
  let queryFn;
  if (options.fixture) {
    const fixture = JSON.parse(fs.readFileSync(options.fixture, "utf8"));
    queryFn = fixtureQuery(fixture);
  } else {
    socket = new FtdSocketQuery();
    queryFn = (name) => socket.query(name);
  }
  try {
    const resolved = await resolveState(current.state, current.revision, queryFn, seededRandom(options.seed), nowIso, batchId);
    const written = await postState(options.api, current.state, current.revision, resolved.registration);
    console.log(JSON.stringify({
      ok: true,
      type: "ftd-player-resolution-summary",
      resolverBatchId: batchId,
      sourceRevision: current.revision,
      writtenRevision: written.revision,
      summary: resolved.summary,
      refereeReview: resolved.review,
    }, null, 2));
    return 0;
  } finally {
    if (socket) socket.close();
  }
}

module.exports = {
  clean,
  nameKey,
  normalizePlayerName,
  loadNameOverrides,
  findNameOverride,
  dedupePackets,
  exactNameCandidates,
  chooseCandidate,
  syncRows,
  resolveState,
  fixtureQuery,
  buildNameReviewPacket,
  FtdSocketQuery,
};

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => {
      console.error(JSON.stringify({ ok: false, type: "ftd-player-resolution-error", error: clean(error && error.message) || String(error) }, null, 2));
      process.exitCode = 1;
    },
  );
}
