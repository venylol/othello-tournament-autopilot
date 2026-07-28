"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const FTD_ROUND = require("./ftd-round-shared.js");
const FTD_TRANSCRIPT = require("./ftd-transcript-shared.js");

const TERMINAL_PHASES = new Set(["done", "stopped", "failed"]);
const ACTIVE_PHASES = new Set([
  "armed", "preflight", "reading-ftd", "importing-round", "polling-oq",
  "writing-scores", "verifying-scores", "preparing-transcripts",
  "writing-transcripts", "verifying-transcripts", "generating-image",
  "downloading-image", "paused", "stopping",
]);
const BRIDGE_ACTIONS = new Set([
  "probe", "readRound", "writeScore", "writeTranscript", "readbackRound",
  "renderPairingsImage", "renderVerifiedRoundImage",
]);
const EXPECTED_EXTENSION_ID = "kbojmgkjbgokbbhlpkapiobfjnpacnme";
const EXPECTED_BRIDGE_VERSION = "0.3.4";
const FINISHED_ROUND_TEST_TOURNAMENT_ID = "593";
const FINISHED_ROUND_TEST_STARTS_AT = Date.parse("2026-07-27T23:40:00+08:00");
const FINISHED_ROUND_TEST_EXPIRES_AT = Date.parse("2026-07-28T23:59:59+08:00");

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function oqResultSource(row) {
  const deterministicLegacyOq = row && !row.resultSource && row.oqAutoAudit && String(row.sourceMessageKey || "").startsWith("oq-auto:");
  return String(row && row.resultSource || (deterministicLegacyOq ? "oq-auto" : "legacy-unknown"));
}

function isVerifiedOqReadyRow(row) {
  return Boolean(
    row &&
    row.status === "ready" &&
    oqResultSource(row) === "oq-auto" &&
    row.oqAutoAudit &&
    FTD_TRANSCRIPT.extractOqGameId(row) &&
    FTD_ROUND.hasScore(row)
  );
}

function text(value, max = 1000) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
}

function accountKey(value) {
  return text(value).toLowerCase().replace(/[\s\u3000\[\]()（）【】{}<>《》,，。:：;；"“”'‘’\-_\/\\|]+/g, "");
}

function ftdAccountForPlayer(state, name, playerId) {
  const mapping = state && state.ftdPlayerAccountMapping && typeof state.ftdPlayerAccountMapping === "object"
    ? state.ftdPlayerAccountMapping
    : {};
  const rows = [];
  if (mapping.accountIndex && typeof mapping.accountIndex === "object") {
    Object.entries(mapping.accountIndex).forEach(([lookupKey, value]) => {
      const row = value && typeof value === "object" ? value : { account: value };
      rows.push({ ...row, lookupKey });
    });
  }
  if (Array.isArray(mapping.players)) rows.push(...mapping.players.filter((row) => row && row.deleted !== true));
  const targetId = text(playerId);
  const targetKey = accountKey(name);
  const matches = new Set();
  rows.forEach((row) => {
    const account = text(row && row.account, 120);
    if (!account) return;
    const idMatch = targetId && [row.ftdId, row.id, row.playerId].some((value) => text(value) === targetId);
    const nameMatch = targetKey && [row.lookupKey, row.ftdName, row.displayName, row.name, row.wofName].some((value) => accountKey(value) === targetKey);
    if (idMatch || nameMatch) matches.add(account);
  });
  return matches.size === 1 ? [...matches][0] : "";
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function randomId(prefix) {
  return `${prefix}-${crypto.randomBytes(18).toString("base64url")}`;
}

function localDateTimeValue(timestamp) {
  const date = new Date(timestamp);
  const part = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}`;
}

function validScorePair(black, white) {
  return Number.isInteger(black) && Number.isInteger(white) && black >= 0 && black <= 64 && white >= 0 && white <= 64 && black + white === 64;
}

function exactObjectKeys(value, allowed, required = allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const allow = new Set(allowed);
  return Object.keys(value).every((key) => allow.has(key)) && required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function safeJournalValue(value) {
  if (Array.isArray(value)) return value.map(safeJournalValue);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const name = String(rawKey).toLowerCase();
    if (name.includes("token") || name === "sid" || name.includes("cookie") || name.includes("authorization") || name === "dataurl") continue;
    out[rawKey] = safeJournalValue(rawValue);
  }
  return out;
}

function makeCoordinatorError(code, message, extra) {
  const error = new Error(message);
  error.code = code;
  if (extra) error.extra = extra;
  return error;
}

class BridgeBroker {
  constructor(options = {}) {
    this.now = options.now || Date.now;
    this.extensionId = options.extensionId || EXPECTED_EXTENSION_ID;
    this.bridgeVersion = options.bridgeVersion || EXPECTED_BRIDGE_VERSION;
    this.bridge = null;
    this.queue = [];
    this.waitingPoll = null;
    this.pending = new Map();
    this.onRegister = null;
    this.commandTrace = null;
  }

  register(payload, origin) {
    const allowed = ["bridgeId", "tabId", "pageUrl", "extensionId", "bridgeVersion"];
    if (!exactObjectKeys(payload, allowed)) throw makeCoordinatorError("bridge-register-schema", "bridge register schema rejected");
    if (origin !== `chrome-extension://${this.extensionId}` || payload.extensionId !== this.extensionId) throw makeCoordinatorError("bridge-origin", "Chrome extension origin rejected");
    if (payload.bridgeVersion !== this.bridgeVersion) throw makeCoordinatorError("bridge-version", `Chrome bridge version ${this.bridgeVersion} required`);
    if (!/^[A-Za-z0-9_-]{12,160}$/.test(String(payload.bridgeId || ""))) throw makeCoordinatorError("bridge-id", "bridgeId rejected");
    if (!Number.isInteger(Number(payload.tabId)) || Number(payload.tabId) < 0) throw makeCoordinatorError("bridge-tab-id", "tabId rejected");
    if (!/^https:\/\/(?:www\.)?flipthedisc\.com\//.test(String(payload.pageUrl || ""))) throw makeCoordinatorError("bridge-url", "FTD page URL rejected");
    this.bridge = {
      bridgeId: payload.bridgeId,
      tabId: Number(payload.tabId),
      pageUrl: String(payload.pageUrl),
      extensionId: payload.extensionId,
      bridgeVersion: payload.bridgeVersion,
      registeredAt: this.now(),
      lastSeenAt: this.now(),
      liveProof: null,
    };
    if (typeof this.onRegister === "function") this.onRegister(this.status());
    return this.status();
  }

  status() {
    const bridge = this.bridge;
    const connected = Boolean(bridge && this.now() - bridge.lastSeenAt < 40000);
    return {
      connected,
      extensionId: this.extensionId,
      bridgeVersion: bridge ? bridge.bridgeVersion : "",
      pageUrl: bridge ? bridge.pageUrl : "",
      tabId: bridge ? bridge.tabId : null,
      registeredAt: bridge ? bridge.registeredAt : 0,
      lastSeenAt: bridge ? bridge.lastSeenAt : 0,
      liveProof: bridge && bridge.liveProof ? deepClone(bridge.liveProof) : null,
      commandTrace: this.commandTrace ? deepClone(this.commandTrace) : null,
    };
  }

  assertBridge(bridgeId, origin) {
    if (origin !== `chrome-extension://${this.extensionId}`) throw makeCoordinatorError("bridge-origin", "Chrome extension origin rejected");
    if (!this.bridge || bridgeId !== this.bridge.bridgeId) throw makeCoordinatorError("bridge-not-registered", "bridge is not registered");
    this.bridge.lastSeenAt = this.now();
  }

  heartbeat(bridgeId, origin) {
    this.assertBridge(bridgeId, origin);
    return this.status();
  }

  next(bridgeId, origin, timeoutMs) {
    this.assertBridge(bridgeId, origin);
    const queued = this.queue.shift();
    if (queued) {
      this.markTrace(queued.requestId, "server-delivered");
      return Promise.resolve(queued);
    }
    if (this.waitingPoll) {
      clearTimeout(this.waitingPoll.timer);
      this.waitingPoll.resolve({ requestId: "", command: null });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.waitingPoll && this.waitingPoll.resolve === resolve) this.waitingPoll = null;
        resolve({ requestId: "", command: null });
      }, Math.max(1000, Math.min(30000, Number(timeoutMs) || 25000)));
      this.waitingPoll = { resolve, timer };
    });
  }

  enqueue(item) {
    if (this.waitingPoll) {
      const waiting = this.waitingPoll;
      this.waitingPoll = null;
      clearTimeout(waiting.timer);
      this.markTrace(item.requestId, "server-delivered");
      waiting.resolve(item);
      return;
    }
    this.queue.push(item);
  }

  validateCommand(command) {
    if (!command || !BRIDGE_ACTIONS.has(command.action)) throw makeCoordinatorError("bridge-command-action", "bridge command action rejected");
    for (const field of ["sessionId", "commandId", "tournamentId", "localStage", "actualFtdRound", "targetTable", "gameId", "pairingFingerprint", "player0Id", "player1Id"]) {
      if (!Object.prototype.hasOwnProperty.call(command, field)) throw makeCoordinatorError("bridge-command-schema", `bridge command missing ${field}`);
    }
    return command;
  }

  send(command, timeoutMs = 30000) {
    this.validateCommand(command);
    if (!this.status().connected) return Promise.reject(makeCoordinatorError("bridge-disconnected", "Chrome FTD bridge is disconnected"));
    const requestId = command.commandId;
    if (this.pending.has(requestId)) return Promise.reject(makeCoordinatorError("duplicate-command-id", "duplicate bridge command ID"));
    const item = { requestId, command: deepClone(command) };
    this.commandTrace = { requestId, action: command.action, stage: "server-queued", updatedAt: this.now() };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.queue = this.queue.filter((queued) => queued.requestId !== requestId);
        const stage = this.commandTrace && this.commandTrace.requestId === requestId ? this.commandTrace.stage : "unknown";
        reject(makeCoordinatorError("bridge-timeout", `bridge command ${command.action} timed out after ${stage}`));
      }, Math.max(2000, Math.min(180000, Number(timeoutMs) || 30000)));
      this.pending.set(requestId, { resolve, reject, timer, action: command.action });
      this.enqueue(item);
    });
  }

  respond(payload, origin) {
    const allowed = ["bridgeId", "requestId", "ok", "result", "error"];
    if (!exactObjectKeys(payload, allowed, ["bridgeId", "requestId", "ok"])) throw makeCoordinatorError("bridge-response-schema", "bridge response schema rejected");
    if (payload.ok === true && (!payload.result || typeof payload.result !== "object" || Array.isArray(payload.result) || Object.prototype.hasOwnProperty.call(payload, "error"))) {
      throw makeCoordinatorError("bridge-response-schema", "successful bridge response rejected");
    }
    if (payload.ok !== true && (!payload.error || typeof payload.error !== "object" || Array.isArray(payload.error) || Object.prototype.hasOwnProperty.call(payload, "result"))) {
      throw makeCoordinatorError("bridge-response-schema", "failed bridge response rejected");
    }
    this.assertBridge(payload.bridgeId, origin);
    this.markTrace(payload.requestId, "server-response-received");
    const pending = this.pending.get(payload.requestId);
    if (!pending) return { accepted: false, stale: true };
    this.pending.delete(payload.requestId);
    clearTimeout(pending.timer);
    if (payload.ok === true && payload.result && typeof payload.result === "object" && !Array.isArray(payload.result)) {
      pending.resolve(payload.result);
    } else {
      const code = text(payload.error && payload.error.code, 100) || "bridge-command-failed";
      const message = text(payload.error && payload.error.message, 500) || "bridge command failed";
      pending.reject(makeCoordinatorError(code, message, payload.error && payload.error.extra));
    }
    return { accepted: true, stale: false };
  }

  markTrace(requestId, stage) {
    if (!this.commandTrace || this.commandTrace.requestId !== requestId) return false;
    this.commandTrace.stage = stage;
    this.commandTrace.updatedAt = this.now();
    return true;
  }

  trace(payload, origin) {
    if (!exactObjectKeys(payload, ["bridgeId", "requestId", "stage"])) throw makeCoordinatorError("bridge-trace-schema", "bridge trace schema rejected");
    this.assertBridge(String(payload.bridgeId), origin);
    const allowed = new Set(["worker-received", "relay-received", "page-started", "page-response", "worker-response"]);
    const stage = String(payload.stage || "");
    if (!allowed.has(stage)) throw makeCoordinatorError("bridge-trace-stage", "bridge trace stage rejected");
    return { accepted: this.markTrace(String(payload.requestId), stage) };
  }

  setLiveProof(proof) {
    if (!this.bridge) throw makeCoordinatorError("bridge-disconnected", "Chrome FTD bridge is disconnected");
    this.bridge.liveProof = deepClone(proof);
    return this.status();
  }
}

class FtdAutopilotCoordinator {
  constructor(options) {
    if (!options || !options.dataDir || typeof options.readState !== "function" || typeof options.writeState !== "function" || !options.bridge) {
      throw new Error("FtdAutopilotCoordinator dependencies are incomplete");
    }
    this.dataDir = options.dataDir;
    this.sessionsDir = path.join(this.dataDir, "automation-sessions");
    this.readState = options.readState;
    this.writeState = options.writeState;
    this.getRevision = options.getRevision || (() => 0);
    this.updateOq = options.updateOq;
    this.fetchOqDetail = options.fetchOqDetail;
    this.bridge = options.bridge;
    this.persistFiles = options.persistFiles !== false;
    this.memoryJournal = [];
    this.now = options.now || Date.now;
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;
    this.timer = null;
    this.running = false;
    this.session = null;
    this.bridge.onRegister = () => this.onBridgeConnected();
    if (this.persistFiles) this.loadRecoverableSession();
  }

  ensureSessionDir() {
    fs.mkdirSync(this.sessionsDir, { recursive: true });
  }

  sessionFile(sessionId) {
    return path.join(this.sessionsDir, `${sessionId}.json`);
  }

  journalFile(sessionId) {
    return path.join(this.sessionsDir, `${sessionId}.jsonl`);
  }

  persist(event, details = {}) {
    if (!this.session) return;
    this.session.updatedAt = this.now();
    const journal = {
      at: new Date(this.now()).toISOString(),
      seq: (this.session.journalSeq = Number(this.session.journalSeq || 0) + 1),
      sessionId: this.session.sessionId,
      phase: this.session.phase,
      event,
      details: safeJournalValue(details),
    };
    if (!this.persistFiles) {
      this.memoryJournal.push(journal);
      return;
    }
    this.ensureSessionDir();
    const file = this.sessionFile(this.session.sessionId);
    const tmp = `${file}.${process.pid}.${this.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.session, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, file);
    fs.appendFileSync(this.journalFile(this.session.sessionId), `${JSON.stringify(journal)}\n`, "utf8");
  }

  loadRecoverableSession() {
    try {
      this.ensureSessionDir();
      const candidates = fs.readdirSync(this.sessionsDir)
        .filter((name) => /^[A-Za-z0-9_-]+\.json$/.test(name))
        .map((name) => {
          const file = path.join(this.sessionsDir, name);
          return { file, mtime: fs.statSync(file).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
      for (const candidate of candidates) {
        const parsed = JSON.parse(fs.readFileSync(candidate.file, "utf8").replace(/^\uFEFF/, ""));
        if (parsed && ACTIVE_PHASES.has(parsed.phase)) {
          this.session = parsed;
          this.ensureSessionImages();
          const interrupted = this.session.inFlight && typeof this.session.inFlight === "object"
            ? deepClone(this.session.inFlight)
            : null;
          this.session.recovering = true;
          this.session.inFlight = null;
          this.restoreInterruptedWrite(interrupted);
          this.persist("server-restart-recovery", { verifiedScoreReceiptCount: this.receiptCount("ftdScoreReceipt"), verifiedTranscriptReceiptCount: this.receiptCount("ftdTranscriptReceipt") });
          this.schedule(1500);
          break;
        }
      }
    } catch (_) {
      this.session = null;
    }
  }

  receiptCount(field) {
    const state = this.readState().state;
    const round = this.scopeRound(state, false);
    return round && Array.isArray(round.ftdPairings) ? round.ftdPairings.filter((row) => row && row[field] && row[field].sessionId === this.session.sessionId).length : 0;
  }

  restoreInterruptedWrite(interrupted) {
    if (!this.session || !interrupted || !["writeScore", "writeTranscript"].includes(interrupted.action)) return false;
    const tableKey = Object.keys(this.session.tables || {}).find((key) => {
      const table = this.session.tables[key];
      return Number(interrupted.targetTable) === Number(table && table.ftdTable || key.split(":")[1]) &&
        text(interrupted.gameId) === text(table && table.gameId || key.split(":").slice(2).join(":"));
    });
    const tableState = tableKey ? this.session.tables[tableKey] : null;
    if (!tableState) return false;
    if (interrupted.action === "writeScore") {
      tableState.uncertainScore = {
        commandId: interrupted.commandId,
        blackScore: interrupted.blackScore,
        whiteScore: interrupted.whiteScore,
        at: interrupted.startedAt,
        recoveredAfterRestart: true,
      };
    } else {
      tableState.uncertainTranscript = {
        commandId: interrupted.commandId,
        oqGameId: interrupted.oqGameId,
        transcriptHash: interrupted.transcriptHash,
        at: interrupted.startedAt,
        recoveredAfterRestart: true,
      };
    }
    return true;
  }

  status() {
    return {
      ok: true,
      bridge: this.bridge.status(),
      session: this.session ? this.publicSession(this.session) : null,
    };
  }

  publicSession(session) {
    const copy = deepClone(session);
    delete copy.tokenHash;
    return copy;
  }

  ensureSessionImages() {
    if (!this.session) return null;
    if (!this.session.images || typeof this.session.images !== "object") this.session.images = {};
    if (this.session.image && !this.session.images.final) this.session.images.final = this.session.image;
    for (const kind of ["pairing", "halfway", "final"]) {
      if (!this.session.images[kind] || typeof this.session.images[kind] !== "object") {
        this.session.images[kind] = { requestIssued: false, receipt: null };
      }
    }
    return this.session.images;
  }

  uncertainImageDownload() {
    const images = this.ensureSessionImages();
    if (!images) return null;
    return Object.entries(images).find(([, item]) => item && item.requestIssued && !item.receipt) || null;
  }

  parseScope(state, request = {}) {
    if (!state || typeof state !== "object") throw makeCoordinatorError("state-missing", "本地共享状态不存在");
    const helper = state.scoreHelper && typeof state.scoreHelper === "object" ? state.scoreHelper : null;
    if (!helper || !Array.isArray(helper.rounds)) throw makeCoordinatorError("score-helper-missing", "比分辅助状态不存在");
    const localRound = Math.trunc(Number(request.localRound || helper.activeRound));
    const round = helper.rounds[localRound - 1];
    const localStage = text(round && round.stage);
    if (!round || !["preliminary", "semifinal", "finals"].includes(localStage)) throw makeCoordinatorError("scope-invalid", "当前选中轮次/阶段无效");
    const ftdUrl = text(request.ftdUrl || (state.ui && state.ui.ftdUrl), 500);
    const match = ftdUrl.match(/^https:\/\/(?:www\.)?flipthedisc\.com\/live\/(\d+)(?:[/?#]|$)/i);
    if (!match) throw makeCoordinatorError("ftd-url-invalid", "请填写 https://flipthedisc.com/live/{id} 链接");
    const tournamentId = match[1];
    const roundStartAt = text(round.roundStartAt, 80);
    if (!roundStartAt || !Number.isFinite(Date.parse(roundStartAt.replace(" ", "T")))) throw makeCoordinatorError("round-start-missing", "当前轮开始时间尚未设置并应用");
    if (!text(round.roundStartSource)) throw makeCoordinatorError("round-start-not-applied", "当前轮开始时间尚未应用到共享状态");
    if (request.tournamentId && String(request.tournamentId) !== tournamentId) throw makeCoordinatorError("scope-request-mismatch", "请求赛事与当前 FTD 链接不一致");
    if (request.localRound && Number(request.localRound) !== localRound) throw makeCoordinatorError("scope-request-mismatch", "请求轮次与当前选中轮不一致");
    if (request.localStage && request.localStage !== localStage) throw makeCoordinatorError("scope-request-mismatch", "请求阶段与当前选中阶段不一致");
    return { tournamentId, ftdUrl, localRound, localStage, roundStartAt, roundStartSource: text(round.roundStartSource), roundCount: Number(helper.roundCount) || helper.rounds.length };
  }

  ensureRoundStartForStart(request = {}) {
    const current = this.readState().state;
    const helper = current && current.scoreHelper && typeof current.scoreHelper === "object" ? current.scoreHelper : null;
    const localRound = Math.trunc(Number(request.localRound || (helper && helper.activeRound)));
    const round = helper && Array.isArray(helper.rounds) ? helper.rounds[localRound - 1] : null;
    if (!round) throw makeCoordinatorError("scope-invalid", "当前选中轮次不存在");
    const existing = text(round.roundStartAt, 80);
    const validExisting = Boolean(existing && Number.isFinite(Date.parse(existing.replace(" ", "T"))));
    if (validExisting && text(round.roundStartSource)) return { defaulted: false, roundStartAt: existing, roundStartSource: text(round.roundStartSource) };
    const next = deepClone(current);
    const nextRound = next.scoreHelper.rounds[localRound - 1];
    const startedAt = validExisting ? existing : localDateTimeValue(this.now());
    nextRound.roundStartAt = startedAt;
    nextRound.roundStartSource = validExisting ? "ftd-autopilot-existing" : "ftd-autopilot-start";
    next.scoreHelper.updatedAt = this.now();
    next.savedAt = this.now();
    this.writeState(next, validExisting ? "ftd-autopilot-start-source" : "ftd-autopilot-start-time", current);
    return { defaulted: !validExisting, roundStartAt: startedAt, roundStartSource: nextRound.roundStartSource };
  }

  baseCommand(scope, action, fields = {}) {
    return {
      action,
      sessionId: fields.sessionId || (this.session && this.session.sessionId) || randomId("readonly"),
      commandId: fields.commandId || randomId(action),
      tournamentId: scope.tournamentId,
      localRound: scope.localRound,
      localStage: scope.localStage,
      actualFtdRound: fields.actualFtdRound == null ? "discover" : fields.actualFtdRound,
      targetTable: fields.targetTable == null ? 0 : fields.targetTable,
      gameId: fields.gameId || "",
      pairingFingerprint: fields.pairingFingerprint || "",
      player0Id: fields.player0Id || "",
      player1Id: fields.player1Id || "",
    };
  }

  finishedRoundWriteTestAuthorized(scope = this.session && this.session.scope) {
    const now = this.now();
    return Boolean(scope && String(scope.tournamentId) === FINISHED_ROUND_TEST_TOURNAMENT_ID &&
      now >= FINISHED_ROUND_TEST_STARTS_AT && now <= FINISHED_ROUND_TEST_EXPIRES_AT);
  }

  finishedRoundWriteTestReceipt(scope = this.session && this.session.scope) {
    if (!this.finishedRoundWriteTestAuthorized(scope)) return null;
    return {
      tournamentId: FINISHED_ROUND_TEST_TOURNAMENT_ID,
      allRounds: true,
      explicitlyAuthorizedBy: "user",
      startsAt: FINISHED_ROUND_TEST_STARTS_AT,
      expiresAt: FINISHED_ROUND_TEST_EXPIRES_AT,
    };
  }

  async readOnlyProbe(request = {}) {
    const scope = this.parseScope(this.readState().state, request);
    const bridgeStatus = this.bridge.status();
    if (!bridgeStatus.connected) throw makeCoordinatorError("bridge-disconnected", "Chrome FTD bridge 未连接；请保持已登录 FTD 标签页打开");
    const pageMatch = bridgeStatus.pageUrl.match(/^https:\/\/(?:www\.)?flipthedisc\.com\/live\/(\d+)/i);
    if (!pageMatch || pageMatch[1] !== scope.tournamentId) throw makeCoordinatorError("wrong-ftd-tab", "已连接的 FTD 标签页不是当前赛事");
    const command = this.baseCommand(scope, "probe");
    const result = await this.bridge.send(command, 35000);
    const ok = result.loggedIn === true && result.tdAccess === true && result.transport === "dedicated-second-socket" && result.dedicatedSocketConnected === true && result.existingPageSocketConnected === true && result.coexistenceObserved === true && String(result.pageTournamentId) === scope.tournamentId;
    if (!ok) throw makeCoordinatorError("readonly-proof-failed", "FTD 只读探测未证明 TD 权限和双 socket 共存", safeJournalValue(result));
    const definitions = FTD_ROUND.resolveStageDefinitions(result.discovery, scope.localStage, scope.localRound);
    const proof = {
      ok: true,
      tournamentId: scope.tournamentId,
      localRound: scope.localRound,
      localStage: scope.localStage,
      verifiedAt: this.now(),
      transport: result.transport,
      coexistenceObserved: true,
      tdAccess: true,
      definitions,
      discovery: result.discovery,
    };
    this.bridge.setLiveProof(proof);
    return proof;
  }

  async start(request = {}) {
    if (this.session && !TERMINAL_PHASES.has(this.session.phase)) throw makeCoordinatorError("session-active", "已有 AP 会话正在运行");
    const startTiming = this.ensureRoundStartForStart(request);
    const scope = this.parseScope(this.readState().state, request);
    scope.roundStartDefaulted = startTiming.defaulted;
    let proof = this.bridge.status().liveProof;
    if (!proof || proof.tournamentId !== scope.tournamentId || proof.localRound !== scope.localRound || proof.localStage !== scope.localStage || this.now() - Number(proof.verifiedAt || 0) > 30 * 60 * 1000) {
      proof = await this.readOnlyProbe(scope);
    }
    const token = crypto.randomBytes(32).toString("base64url");
    const sessionId = randomId("autopilot");
    this.session = {
      schema: "ftd-round-autopilot-session-v1",
      sessionId,
      tokenHash: sha256(token),
      tokenExpiresAt: this.now() + 8 * 60 * 60 * 1000,
      phase: "armed",
      scope: { ...scope, definitions: proof.definitions },
      readOnlyProof: { verifiedAt: proof.verifiedAt, transport: proof.transport, coexistenceObserved: proof.coexistenceObserved, tdAccess: proof.tdAccess },
      writeAllowed: true,
      stopRequested: false,
      userPaused: false,
      pauseReason: null,
      snapshots: [],
      tables: {},
      retries: { oq: 0 },
      images: {
        pairing: { requestIssued: false, receipt: null },
        halfway: { requestIssued: false, receipt: null },
        final: { requestIssued: false, receipt: null },
      },
      createdAt: this.now(),
      updatedAt: this.now(),
      journalSeq: 0,
      inFlight: null,
      finishedRoundWriteTestAuthorization: this.finishedRoundWriteTestReceipt(scope),
    };
    this.persist("session-created", { scope: this.session.scope, readOnlyProof: this.session.readOnlyProof, startTiming });
    this.schedule(0);
    return { ok: true, sessionId, token, tokenExpiresAt: this.session.tokenExpiresAt, session: this.publicSession(this.session) };
  }

  verifyControl(sessionId, token) {
    if (!this.session || this.session.sessionId !== sessionId) throw makeCoordinatorError("session-not-found", "AP 会话不存在");
    if (this.now() > Number(this.session.tokenExpiresAt)) throw makeCoordinatorError("session-token-expired", "AP 控制 token 已过期");
    const expected = Buffer.from(this.session.tokenHash, "hex");
    const actual = Buffer.from(sha256(token), "hex");
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) throw makeCoordinatorError("session-token-invalid", "AP 控制 token 无效");
  }

  claimControl(sessionId) {
    if (!this.session || this.session.sessionId !== sessionId || TERMINAL_PHASES.has(this.session.phase)) {
      throw makeCoordinatorError("session-not-found", "没有可接管的活动 AP 会话");
    }
    const token = crypto.randomBytes(32).toString("base64url");
    this.session.tokenHash = sha256(token);
    this.session.tokenExpiresAt = this.now() + 8 * 60 * 60 * 1000;
    this.persist("session-control-claimed", { sessionId: this.session.sessionId });
    return {
      sessionId: this.session.sessionId,
      token,
      tokenExpiresAt: this.session.tokenExpiresAt,
      session: this.publicSession(this.session),
    };
  }

  pause(sessionId, token) {
    this.verifyControl(sessionId, token);
    if (TERMINAL_PHASES.has(this.session.phase)) return this.publicSession(this.session);
    this.session.userPaused = true;
    this.session.phase = "paused";
    this.session.pauseReason = { code: "user-paused", message: "裁判暂停了 AP" };
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.persist("session-paused", this.session.pauseReason);
    return this.publicSession(this.session);
  }

  resume(sessionId, token) {
    this.verifyControl(sessionId, token);
    if (this.session.phase !== "paused") throw makeCoordinatorError("session-not-paused", "会话当前不是暂停状态");
    const uncertainImage = this.uncertainImageDownload();
    if (uncertainImage) throw makeCoordinatorError("download-not-retryable", `${uncertainImage[0]} PNG 下载请求已失败或不确定；为防止重复下载，请紧急停止并重新启动新会话`);
    this.session.userPaused = false;
    this.session.finishedRoundWriteTestAuthorization = this.finishedRoundWriteTestReceipt(this.session.scope);
    this.session.pauseReason = null;
    this.session.phase = "polling-oq";
    this.persist("session-resumed", {});
    this.schedule(0);
    return this.publicSession(this.session);
  }

  emergencyStop(sessionId, token) {
    this.verifyControl(sessionId, token);
    if (TERMINAL_PHASES.has(this.session.phase)) return this.publicSession(this.session);
    this.session.stopRequested = true;
    this.session.writeAllowed = false;
    this.session.phase = this.session.inFlight ? "stopping" : "stopped";
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.persist("emergency-stop-requested", { inFlight: this.session.inFlight });
    if (!this.session.inFlight) this.persist("session-stopped", {});
    return this.publicSession(this.session);
  }

  onBridgeConnected() {
    if (!this.session || TERMINAL_PHASES.has(this.session.phase) || this.session.userPaused || this.session.stopRequested) return;
    void this.readOnlyProbe(this.session.scope).then(() => {
      if (!this.session || this.session.stopRequested || this.session.userPaused) return;
      if (this.session.phase === "paused" && this.session.pauseReason && this.session.pauseReason.code === "bridge-disconnected") {
        this.session.phase = "polling-oq";
        this.session.pauseReason = null;
      }
      this.persist("bridge-reconnected-readonly-proof", {});
      this.schedule(300);
    }).catch((error) => {
      if (!this.session || this.session.stopRequested) return;
      this.session.phase = "paused";
      this.session.pauseReason = { code: "readonly-proof-failed", message: text(error && error.message, 500) };
      this.persist("bridge-reconnect-proof-failed", this.session.pauseReason);
    });
  }

  schedule(delayMs) {
    if (!this.session || TERMINAL_PHASES.has(this.session.phase) || this.session.userPaused || this.session.stopRequested) return;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => { this.timer = null; void this.run(); }, Math.max(0, Number(delayMs) || 0));
  }

  async run() {
    if (this.running || !this.session || TERMINAL_PHASES.has(this.session.phase) || this.session.userPaused) return;
    this.running = true;
    try {
      if (this.session.stopRequested) return;
      if (!this.session.snapshots.length) await this.readAndImportRound();
      if (this.session.phase === "paused") return;
      if (this.session.stopRequested) return;
      await this.pollOqAndProcessTables();
    } catch (error) {
      await this.handleRunError(error);
    } finally {
      this.running = false;
      if (this.session && this.session.stopRequested) {
        this.session.inFlight = null;
        this.session.phase = "stopped";
        this.persist("session-stopped", {});
      }
    }
  }

  async bridgeCommand(command, timeoutMs) {
    if (!this.session.writeAllowed && ["writeScore", "writeTranscript", "renderPairingsImage", "renderVerifiedRoundImage"].includes(command.action)) throw makeCoordinatorError("writes-disabled", "外部写入已禁用");
    this.session.inFlight = {
      action: command.action,
      commandId: command.commandId,
      actualFtdRound: command.actualFtdRound,
      targetTable: command.targetTable,
      gameId: command.gameId,
      pairingFingerprint: command.pairingFingerprint,
      startedAt: this.now(),
      ...(command.action === "writeScore" ? { blackScore: command.blackScore, whiteScore: command.whiteScore } : {}),
      ...(command.action === "writeTranscript" ? { oqGameId: command.oqGameId, transcriptHash: sha256(command.transcript) } : {}),
    };
    this.persist("command-dispatched", { commandId: command.commandId, action: command.action, pairingFingerprint: command.pairingFingerprint, actualFtdRound: command.actualFtdRound, targetTable: command.targetTable });
    try {
      const result = await this.bridge.send(command, timeoutMs);
      this.persist("command-received", { commandId: command.commandId, action: command.action, result });
      return result;
    } finally {
      this.session.inFlight = null;
      this.persist("command-settled", { commandId: command.commandId, action: command.action });
    }
  }

  async readAndImportRound() {
    this.session.phase = "reading-ftd";
    this.persist("phase", { phase: this.session.phase });
    const snapshots = [];
    for (const definition of this.session.scope.definitions) {
      const command = this.baseCommand(this.session.scope, "readRound", { sessionId: this.session.sessionId, actualFtdRound: definition.actualFtdRound });
      const snapshot = await this.bridgeCommand(command, 35000);
      FTD_ROUND.assertBridgeRound(snapshot, this.session.scope.tournamentId, definition);
      if (snapshot.finished === true && !this.finishedRoundWriteTestAuthorized(this.session.scope)) throw makeCoordinatorError("ftd-round-finished", `FTD ${definition.ftdStage || definition.actualFtdRound} 已结束`);
      if (snapshot.started !== true) throw makeCoordinatorError("ftd-round-not-started", `FTD ${definition.ftdStage || definition.actualFtdRound} 尚未发布/开始`);
      snapshots.push(snapshot);
    }
    this.session.phase = "importing-round";
    this.persist("phase", { phase: this.session.phase });
    const imported = this.importRoundSnapshots(snapshots);
    const importedState = imported.state;
    const pairings = imported.pairings;
    this.session.snapshots = snapshots;
    for (const row of pairings) {
      if (!FTD_ROUND.isByeName(row.black) && !FTD_ROUND.isByeName(row.white)) {
        this.session.tables[this.tableKey(row)] = { phase: "polling-oq", ftdTable: Number(row.ftdTable), gameId: text(row.gameId), scoreCommandId: "", transcriptCommandId: "", uncertainScore: null, uncertainTranscript: null, retry: { transcript: 0 }, lastError: null };
      }
    }
    this.session.phase = "polling-oq";
    this.persist("round-imported", { pairingCount: pairings.length, fingerprints: pairings.map((row) => row.pairingFingerprint) });
    await this.downloadPairingsImage(importedState, pairings);
  }

  importRoundSnapshots(snapshots) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = this.readState().state;
      this.assertScopeStillLocked(current);
      const importedAt = this.now();
      const merged = FTD_ROUND.mergeBridgeRoundsIntoScoreHelper(current.scoreHelper, snapshots, this.session.scope, {
        importedAt,
        allowInactiveLockedRound: this.finishedRoundWriteTestAuthorized(this.session.scope),
      });
      const next = deepClone(current);
      next.scoreHelper = merged.scoreHelper;
      next.ftdRound = {
        source: "chrome-ftd-bridge",
        url: this.session.scope.ftdUrl,
        importedAt: new Date(importedAt).toISOString(),
        round: this.session.scope.localRound,
        stage: this.session.scope.localStage,
        pairingCount: merged.pairings.length,
        note: "Direct authenticated Chrome bridge import; Downloads were not scanned.",
      };
      next.step = "score-helper";
      next.savedAt = importedAt;
      try {
        const written = this.writeState(next, "ftd-autopilot-import", current);
        const writtenState = written && written.state ? written.state : next;
        const writtenRound = this.scopeRound(writtenState);
        return { state: writtenState, pairings: writtenRound.ftdPairings || [] };
      } catch (error) {
        if (attempt === 0 && error && error.code === "entity-conflict") {
          this.persist("round-import-conflict-retry", { code: error.code, message: text(error.message, 500) });
          continue;
        }
        throw error;
      }
    }
    throw makeCoordinatorError("entity-conflict", "本轮配对导入并发冲突");
  }

  assertScopeStillLocked(state) {
    const scope = this.parseScope(state, this.session && this.session.scope || {});
    for (const key of ["tournamentId", "localRound", "localStage", "roundStartAt"]) {
      if (String(scope[key]) !== String(this.session.scope[key])) throw makeCoordinatorError("scope-changed", `锁定会话期间 ${key} 已变化`);
    }
    return scope;
  }

  scopeRound(state, strict = true) {
    try {
      const helper = state && state.scoreHelper;
      const round = helper && Array.isArray(helper.rounds) ? helper.rounds[this.session.scope.localRound - 1] : null;
      if (!round || text(round.stage) !== this.session.scope.localStage) throw new Error("round missing");
      return round;
    } catch (error) {
      if (strict) throw makeCoordinatorError("scope-changed", "锁定的本地轮次不存在或已变化");
      return null;
    }
  }

  tableKey(row) {
    return `${Number(row.ftdRound)}:${Number(row.ftdTable)}:${text(row.gameId)}`;
  }

  pendingMatchesTable(item, row) {
    if (!item || item.resolvedByReferee === true || item.resolutionStatus === "resolved") return false;
    const table = Number(item.pendingTable || item.table || item.dirtyTable);
    return Number.isInteger(table) && table === Number(row.table);
  }

  rowHasBlockingPending(round, row, ignoreAutomation = false) {
    const pending = Array.isArray(round.pending) ? round.pending : [];
    const manual = Array.isArray(round.manualPending) ? round.manualPending : [];
    return pending.concat(manual).some((item) => {
      if (!this.pendingMatchesTable(item, row)) return false;
      if (ignoreAutomation && text(item.pendingKind).startsWith("automation-")) return false;
      return true;
    });
  }

  async pollOqAndProcessTables() {
    let state = this.readState().state;
    this.assertScopeStillLocked(state);
    const pollSeconds = Math.max(5, Math.trunc(Number(state.ui && state.ui.oqPollSeconds) || 60));
    this.session.phase = "polling-oq";
    this.persist("oq-poll-start", { round: this.session.scope.localRound, roundStartAt: this.session.scope.roundStartAt });
    let oqResult;
    try {
      oqResult = await this.updateOq({
        round: this.session.scope.localRound,
        roundCount: this.session.scope.roundCount,
        roundStart: this.session.scope.roundStartAt,
        source: "ftd-autopilot",
        mode: "5min",
        concurrency: 8,
      });
      this.session.retries.oq = 0;
      this.persist("oq-poll-finished", oqResult);
    } catch (error) {
      this.session.retries.oq = Math.min(6, Number(this.session.retries.oq || 0) + 1);
      const delay = Math.min(300000, pollSeconds * 1000 * Math.pow(2, this.session.retries.oq - 1));
      this.persist("oq-poll-error", { code: text(error.code, 100), message: text(error.message, 500), retry: this.session.retries.oq, delay });
      this.schedule(delay);
      return;
    }
    state = this.readState().state;
    this.assertScopeStillLocked(state);
    await this.reflectOqBlockingItems(oqResult, state);
    state = this.readState().state;
    const round = this.scopeRound(state);
    for (const originalRow of round.ftdPairings || []) {
      if (this.session.stopRequested || this.session.userPaused) return;
      if (FTD_ROUND.isByeName(originalRow.black) || FTD_ROUND.isByeName(originalRow.white)) continue;
      await this.processTable(originalRow);
      if (await this.tryDownloadHalfwayScoreImage()) return;
    }
    if (await this.tryFinalize()) return;
    this.session.phase = "polling-oq";
    this.persist("poll-cycle-complete", { nextPollSeconds: pollSeconds });
    this.schedule(pollSeconds * 1000);
  }

  async reflectOqBlockingItems(result, state) {
    const skipped = Array.isArray(result && result.skipped) ? result.skipped : [];
    const mappingIssues = Array.isArray(result && result.mappingIssues) ? result.mappingIssues : [];
    const queryErrors = result && result.queryErrors && typeof result.queryErrors === "object" ? result.queryErrors : {};
    const round = this.scopeRound(state);
    const next = deepClone(state);
    const nextRound = this.scopeRound(next);
    let changed = false;
    for (const row of round.ftdPairings || []) {
      if (FTD_ROUND.isByeName(row.black) || FTD_ROUND.isByeName(row.white) || row.ftdScoreReceipt) continue;
      const skip = skipped.find((item) => Number(item && item.table) === Number(row.table));
      const mapping = mappingIssues.find((item) => Number(item && (item.table || item.ftdTable)) === Number(row.table));
      let code = "";
      let message = "";
      if (mapping) { code = "mapping-missing"; message = "当前桌 OQ 映射不完整"; }
      else if (skip && skip.reason === "no matching OQ game") { code = "zero-oq-candidates"; message = "当前时间窗没有双方账号完全匹配的 OQ 对局"; }
      else if (Object.keys(queryErrors).length) { code = "oq-query-error"; message = "OQ 对局列表查询失败"; }
      if (code) changed = this.upsertAutomationPending(nextRound, row, code, message) || changed;
    }
    if (changed) {
      next.savedAt = this.now();
      this.writeState(next, "ftd-autopilot-pending", state);
    }
  }

  upsertAutomationPending(round, row, code, message) {
    if (!Array.isArray(round.pending)) round.pending = [];
    const sourceMessageKey = `ftd-autopilot:${this.session.sessionId}:table:${row.table}:${code}`;
    const existing = round.pending.find((item) => item && item.sourceMessageKey === sourceMessageKey);
    const value = {
      id: sourceMessageKey,
      round: this.session.scope.localRound,
      sender: `AP 第${row.table}台`,
      wechatSender: "AP（不读取微信）",
      verdict: code,
      resultText: message,
      reason: message,
      sourceMessageKey,
      pendingKind: `automation-${code}`,
      pendingTable: String(row.table),
      table: String(row.table),
      reviewAction: "裁判可修正映射/本地状态；条件解除后 AP 会自动继续该桌。",
      lastEditedBy: "automation",
      lastEditedAt: this.now(),
    };
    if (existing) {
      Object.assign(existing, value);
      return true;
    }
    round.pending.unshift(value);
    return true;
  }

  clearAutomationPending(round, row) {
    if (!Array.isArray(round.pending)) return false;
    const before = round.pending.length;
    round.pending = round.pending.filter((item) => !(this.pendingMatchesTable(item, row) && text(item.pendingKind).startsWith("automation-")));
    return round.pending.length !== before;
  }

  findCurrentRow(template) {
    const state = this.readState().state;
    this.assertScopeStillLocked(state);
    const round = this.scopeRound(state);
    const row = (round.ftdPairings || []).find((item) => item && item.pairingFingerprint === template.pairingFingerprint && item.gameId === template.gameId);
    if (!row) throw makeCoordinatorError("pairing-changed", `第 ${template.table} 台本地配对已变化`);
    return { state, round, row };
  }

  rowGameId(row) {
    return FTD_TRANSCRIPT.extractOqGameId(row);
  }

  commandForRow(action, row, extra = {}) {
    const command = {
      ...this.baseCommand(this.session.scope, action, {
        sessionId: this.session.sessionId,
        commandId: extra.commandId || randomId(action),
        actualFtdRound: Number(row.ftdRound),
        targetTable: Number(row.ftdTable),
        gameId: text(row.gameId),
        pairingFingerprint: text(row.pairingFingerprint),
        player0Id: text(row.player0Id),
        player1Id: text(row.player1Id),
      }),
      ...extra.fields,
    };
    if (action === "writeScore" || action === "writeTranscript") {
      command.allowFinishedRoundWrite = this.finishedRoundWriteTestAuthorized(this.session.scope);
    }
    return command;
  }

  async processTable(template) {
    let current = this.findCurrentRow(template);
    let row = current.row;
    const tableState = this.session.tables[this.tableKey(row)] || (this.session.tables[this.tableKey(row)] = { phase: "polling-oq", retry: { transcript: 0 } });
    if (row.ftdScoreReceipt && row.ftdScoreReceipt.sessionId === this.session.sessionId) {
      if (row.status !== "completed" || row.lastEditedBy !== "automation") await this.markScoreCompleted(row, row.ftdScoreReceipt);
      await this.ensureTranscript(row, tableState);
      return;
    }
    if (row.dirty === true || row.status === "dirty") {
      tableState.phase = "paused";
      tableState.lastError = { code: "dirty-row", message: "本地行是 dirty" };
      this.persist("table-paused", { table: row.table, ...tableState.lastError });
      return;
    }
    const isAbsence = row.resultKind === "absence" && row.status === "completed" && row.lastEditedBy === "user" && FTD_ROUND.hasScore(row);
    const resultSource = oqResultSource(row);
    const isOqReady = isVerifiedOqReadyRow(row);
    if (!isAbsence && !isOqReady) {
      if (["ready", "completed"].includes(row.status) && resultSource !== "oq-auto") {
        tableState.phase = "paused";
        tableState.lastError = { code: "manual-local-result", message: "本地存在非 OQ 直连来源结果，自动化不会把它作为外部写分来源" };
      }
      return;
    }
    if (this.rowHasBlockingPending(current.round, row, true)) {
      tableState.phase = "paused";
      tableState.lastError = { code: "blocking-pending", message: "本桌存在未解决 pending" };
      return;
    }
    const next = deepClone(current.state);
    const nextRound = this.scopeRound(next);
    const nextRow = nextRound.ftdPairings.find((item) => item.pairingFingerprint === row.pairingFingerprint);
    this.clearAutomationPending(nextRound, nextRow);
    next.savedAt = this.now();
    this.writeState(next, "ftd-autopilot-clear-waiting", current.state);
    current = this.findCurrentRow(template);
    row = current.row;
    const blackScore = Number(row.blackScore);
    const whiteScore = Number(row.whiteScore);
    if (!validScorePair(blackScore, whiteScore)) throw makeCoordinatorError("invalid-local-score", `第 ${row.table} 台本地比分无效`);
    if (tableState.uncertainScore) {
      const recovered = await this.recoverUncertainScore(row, tableState, blackScore, whiteScore);
      if (!recovered) return;
      current = this.findCurrentRow(template);
      row = current.row;
      if (row.ftdScoreReceipt) { await this.ensureTranscript(row, tableState); return; }
    }
    this.session.phase = "writing-scores";
    tableState.phase = "writing-score";
    const commandId = randomId("writeScore");
    tableState.scoreCommandId = commandId;
    const command = this.commandForRow("writeScore", row, {
      commandId,
      fields: {
        blackScore,
        whiteScore,
        localStatus: row.status,
        localDirty: false,
        localPending: false,
        localManualLocked: false,
        localRevision: Math.max(0, Math.trunc(Number(this.getRevision()) || 0)),
      },
    });
    try {
      const receipt = await this.bridgeCommand(command, 45000);
      this.validateScoreReceipt(receipt, row, blackScore, whiteScore, commandId);
      await this.markScoreCompleted(row, receipt);
      tableState.phase = "score-verified";
      tableState.uncertainScore = null;
      this.persist("score-verified", { table: row.table, oqGameId: this.rowGameId(row), receipt });
      if (this.session.stopRequested || this.session.userPaused) return;
      const refreshed = this.findCurrentRow(row).row;
      await this.ensureTranscript(refreshed, tableState, isAbsence);
    } catch (error) {
      if (error.code === "bridge-timeout") {
        tableState.uncertainScore = { commandId, blackScore, whiteScore, at: this.now() };
        this.persist("score-command-uncertain", { table: row.table, commandId, blackScore, whiteScore });
        return;
      }
      await this.pauseTableWithPending(row, tableState, error.code || "ftd-score-error", error.message);
    }
  }

  validateScoreReceipt(receipt, row, blackScore, whiteScore, commandId) {
    if (!receipt || receipt.kind !== "ftd-score-receipt-v1" || receipt.sessionId !== this.session.sessionId || receipt.commandId !== commandId || receipt.pairingFingerprint !== row.pairingFingerprint || receipt.gameId !== row.gameId) throw makeCoordinatorError("invalid-score-receipt", "FTD 比分回执与锁定配对不一致");
    if (Number(receipt.readbackScore && receipt.readbackScore.blackScore) !== blackScore || Number(receipt.readbackScore && receipt.readbackScore.whiteScore) !== whiteScore) throw makeCoordinatorError("invalid-score-readback", "FTD 比分回读与预期不一致");
  }

  async markScoreCompleted(template, receipt) {
    const current = this.findCurrentRow(template);
    const next = deepClone(current.state);
    const round = this.scopeRound(next);
    const row = round.ftdPairings.find((item) => item.pairingFingerprint === template.pairingFingerprint);
    if (Number(row.blackScore) !== Number(receipt.readbackScore.blackScore) || Number(row.whiteScore) !== Number(receipt.readbackScore.whiteScore)) throw makeCoordinatorError("local-score-changed", "FTD 回读后本地比分已变化，未自动完成");
    const verifiedAtMs = Date.parse(receipt.verifiedAt) || this.now();
    row.status = "completed";
    row.completedAt = verifiedAtMs;
    row.updatedAt = verifiedAtMs;
    row.lastEditedBy = "automation";
    row.lastEditedAt = verifiedAtMs;
    row.ftdScoreReceipt = deepClone(receipt);
    this.clearAutomationPending(round, row);
    next.scoreHelper.updatedAt = verifiedAtMs;
    next.savedAt = verifiedAtMs;
    this.writeState(next, "ftd-autopilot-score-verified", current.state);
  }

  async recoverUncertainScore(row, tableState, blackScore, whiteScore) {
    this.session.phase = "verifying-scores";
    const command = this.commandForRow("readbackRound", row);
    const snapshot = await this.bridgeCommand(command, 35000);
    const live = (snapshot.pairings || []).find((item) => item.pairingFingerprint === row.pairingFingerprint);
    if (!live) { await this.pauseTableWithPending(row, tableState, "pairing-changed", "不确定写入恢复时 FTD 配对已变化"); return false; }
    if (live.blackScore === blackScore && live.whiteScore === whiteScore) {
      const receipt = {
        kind: "ftd-score-receipt-v1",
        sessionId: this.session.sessionId,
        commandId: tableState.uncertainScore.commandId,
        tournamentId: this.session.scope.tournamentId,
        actualFtdRound: Number(row.ftdRound),
        ftdTable: Number(row.ftdTable),
        gameId: row.gameId,
        pairingFingerprint: row.pairingFingerprint,
        expectedScore: { blackScore, whiteScore },
        beforeScore: { blackScore: null, whiteScore: null },
        readbackScore: { blackScore, whiteScore },
        alreadyCorrect: true,
        recoveredByReadFirst: true,
        readbackAttempts: 1,
        verifiedAt: new Date(this.now()).toISOString(),
      };
      await this.markScoreCompleted(row, receipt);
      tableState.uncertainScore = null;
      return true;
    }
    if (live.blackScore === null) {
      tableState.uncertainScore = null;
      this.persist("uncertain-score-readback-empty", { table: row.table });
      return true;
    }
    await this.pauseTableWithPending(row, tableState, "ftd-score-conflict", "不确定写入恢复时 FTD 已出现不同比分");
    return false;
  }

  async ensureTranscript(template, tableState, knownAbsence = false) {
    if (this.session.stopRequested || this.session.userPaused) return;
    let current = this.findCurrentRow(template);
    let row = current.row;
    if (row.ftdTranscriptReceipt && row.ftdTranscriptReceipt.sessionId === this.session.sessionId) {
      tableState.phase = "complete";
      return;
    }
    const absence = knownAbsence || (row.resultKind === "absence" && row.lastEditedBy === "automation" && !this.rowGameId(row));
    if (absence) {
      const next = deepClone(current.state);
      const nextRound = this.scopeRound(next);
      const nextRow = nextRound.ftdPairings.find((item) => item.pairingFingerprint === row.pairingFingerprint);
      nextRow.transcriptNotApplicable = { reason: "referee-confirmed-absence", confirmedBy: "automation", refereeSource: "user", confirmedAt: this.now(), sessionId: this.session.sessionId };
      next.savedAt = this.now();
      this.writeState(next, "ftd-autopilot-transcript-na", current.state);
      tableState.phase = "complete";
      this.persist("transcript-not-applicable", { table: row.table, reason: "referee-confirmed-absence" });
      return;
    }
    const oqGameId = this.rowGameId(row);
    if (!oqGameId) {
      await this.pauseTableWithPending(row, tableState, "missing-oq-game-id", "已验证比分缺少当前 OQ game ID，无法导入棋谱");
      return;
    }
    this.session.phase = "preparing-transcripts";
    let extracted;
    try {
      const detail = await this.fetchOqDetail(oqGameId, { timeoutMs: 12000 });
      extracted = FTD_TRANSCRIPT.extractTranscriptFromOqDetail(detail);
      if (!extracted.ok) throw makeCoordinatorError(extracted.code, extracted.reason);
      tableState.retry.transcript = 0;
    } catch (error) {
      tableState.retry.transcript = Number(tableState.retry.transcript || 0) + 1;
      if (tableState.retry.transcript < 4) {
        tableState.phase = "transcript-retry";
        tableState.lastError = { code: error.code || "oq-detail-fetch-failed", message: text(error.message, 500) };
        this.persist("transcript-detail-retry", { table: row.table, retry: tableState.retry.transcript, error: tableState.lastError });
        return;
      }
      await this.pauseTableWithPending(row, tableState, error.code || "oq-detail-fetch-failed", `棋谱明细持续失败：${error.message}`);
      return;
    }
    if (tableState.uncertainTranscript) {
      const recovered = await this.recoverUncertainTranscript(row, tableState, extracted.transcript, oqGameId);
      if (!recovered) return;
      current = this.findCurrentRow(template);
      row = current.row;
      if (row.ftdTranscriptReceipt) { tableState.phase = "complete"; return; }
    }
    this.session.phase = "writing-transcripts";
    tableState.phase = "writing-transcript";
    const commandId = randomId("writeTranscript");
    tableState.transcriptCommandId = commandId;
    const command = this.commandForRow("writeTranscript", row, {
      commandId,
      fields: {
        transcript: extracted.transcript,
        oqGameId,
        localStatus: "completed",
        localDirty: false,
        localPending: false,
        localManualLocked: false,
        localRevision: Math.max(0, Math.trunc(Number(this.getRevision()) || 0)),
      },
    });
    try {
      const receipt = await this.bridgeCommand(command, 50000);
      this.validateTranscriptReceipt(receipt, row, extracted.transcript, oqGameId, commandId);
      await this.markTranscriptVerified(row, receipt, oqGameId);
      tableState.phase = "complete";
      tableState.uncertainTranscript = null;
      this.persist("transcript-verified", { table: row.table, oqGameId, transcriptHash: receipt.transcriptHash });
    } catch (error) {
      if (error.code === "bridge-timeout") {
        tableState.uncertainTranscript = { commandId, oqGameId, transcriptHash: sha256(extracted.transcript), at: this.now() };
        this.persist("transcript-command-uncertain", { table: row.table, commandId, oqGameId, transcriptHash: sha256(extracted.transcript) });
        return;
      }
      await this.pauseTableWithPending(row, tableState, error.code || "ftd-transcript-error", error.message);
    }
  }

  validateTranscriptReceipt(receipt, row, transcript, oqGameId, commandId) {
    if (!receipt || receipt.kind !== "ftd-transcript-receipt-v1" || receipt.sessionId !== this.session.sessionId || receipt.commandId !== commandId || receipt.pairingFingerprint !== row.pairingFingerprint || receipt.gameId !== row.gameId || receipt.oqGameId !== oqGameId || receipt.transcriptHash !== sha256(transcript) || receipt.readbackTranscriptHash !== sha256(transcript)) throw makeCoordinatorError("invalid-transcript-receipt", "FTD 棋谱回执与当前 OQ 对局/配对不一致");
  }

  async markTranscriptVerified(template, receipt, oqGameId) {
    const current = this.findCurrentRow(template);
    const next = deepClone(current.state);
    const round = this.scopeRound(next);
    const row = round.ftdPairings.find((item) => item.pairingFingerprint === template.pairingFingerprint);
    const verifiedAtMs = Date.parse(receipt.verifiedAt) || this.now();
    row.ftdTranscriptReceipt = deepClone(receipt);
    row.ftdTranscriptImport = { status: "imported", oqGameId, confirmedAt: verifiedAtMs, confirmedBy: "automation" };
    row.lastEditedBy = "automation";
    row.lastEditedAt = verifiedAtMs;
    row.updatedAt = verifiedAtMs;
    this.clearAutomationPending(round, row);
    next.scoreHelper.updatedAt = verifiedAtMs;
    next.savedAt = verifiedAtMs;
    this.writeState(next, "ftd-autopilot-transcript-verified", current.state);
  }

  async recoverUncertainTranscript(row, tableState, transcript, oqGameId) {
    this.session.phase = "verifying-transcripts";
    const snapshot = await this.bridgeCommand(this.commandForRow("readbackRound", row), 35000);
    const live = (snapshot.pairings || []).find((item) => item.pairingFingerprint === row.pairingFingerprint);
    if (!live) { await this.pauseTableWithPending(row, tableState, "pairing-changed", "不确定棋谱写入恢复时 FTD 配对已变化"); return false; }
    if (live.transcript === transcript) {
      const receipt = {
        kind: "ftd-transcript-receipt-v1",
        sessionId: this.session.sessionId,
        commandId: tableState.uncertainTranscript.commandId,
        tournamentId: this.session.scope.tournamentId,
        actualFtdRound: Number(row.ftdRound),
        ftdTable: Number(row.ftdTable),
        gameId: row.gameId,
        oqGameId,
        pairingFingerprint: row.pairingFingerprint,
        transcriptHash: sha256(transcript),
        beforeTranscriptHash: "",
        readbackTranscriptHash: sha256(transcript),
        alreadyCorrect: true,
        recoveredByReadFirst: true,
        readbackAttempts: 1,
        verifiedAt: new Date(this.now()).toISOString(),
      };
      await this.markTranscriptVerified(row, receipt, oqGameId);
      tableState.uncertainTranscript = null;
      return true;
    }
    if (!live.transcript) {
      tableState.uncertainTranscript = null;
      return true;
    }
    await this.pauseTableWithPending(row, tableState, "ftd-transcript-conflict", "不确定棋谱写入恢复时 FTD 已出现不同棋谱");
    return false;
  }

  async pauseTableWithPending(template, tableState, code, message) {
    const current = this.findCurrentRow(template);
    const next = deepClone(current.state);
    const round = this.scopeRound(next);
    const row = round.ftdPairings.find((item) => item.pairingFingerprint === template.pairingFingerprint);
    this.upsertAutomationPending(round, row, code, text(message, 500));
    next.savedAt = this.now();
    this.writeState(next, "ftd-autopilot-table-paused", current.state);
    tableState.phase = "paused";
    tableState.lastError = { code, message: text(message, 500), at: this.now() };
    this.persist("table-paused", { table: row.table, ...tableState.lastError });
  }

  pairingImageRows(state, pairings) {
    return [...pairings]
      .sort((a, b) => Number(a.table) - Number(b.table))
      .map((row) => ({
        label: this.imageRowLabel(row),
        black: text(row.black, 240),
        white: text(row.white, 240),
        blackAccount: ftdAccountForPlayer(state, row.black, row.player0Id),
        whiteAccount: ftdAccountForPlayer(state, row.white, row.player1Id),
        password: `${String(this.session.scope.localRound).padStart(2, "0")}${String(row.table).padStart(2, "0")}`,
      }));
  }

  async downloadImage(kind, action, snapshot, filename, source) {
    const images = this.ensureSessionImages();
    const image = images[kind];
    if (image.receipt) return true;
    if (image.requestIssued) {
      this.session.phase = "paused";
      this.session.pauseReason = { code: "download-uncertain", message: `${kind} PNG 下载请求没有成功回执` };
      this.persist("download-blocked", { kind, ...this.session.pauseReason });
      return false;
    }
    this.session.phase = "generating-image";
    Object.assign(image, { requestIssued: true, commandId: randomId("renderImage"), filename, receipt: null, requestedAt: this.now() });
    this.persist("image-request-armed", { kind, commandId: image.commandId, filename, source, rows: snapshot });
    const command = {
      ...this.baseCommand(this.session.scope, action, {
        sessionId: this.session.sessionId,
        commandId: image.commandId,
        actualFtdRound: this.session.scope.definitions[0].actualFtdRound,
      }),
      snapshot,
      filename,
    };
    this.session.phase = "downloading-image";
    try {
      const result = await this.bridgeCommand(command, 150000);
      const receipt = result && result.downloadReceipt;
      if (!receipt || receipt.state !== "complete" || !Number.isInteger(Number(receipt.downloadId)) || !text(receipt.filename)) {
        throw makeCoordinatorError("download-not-complete", "Chrome 没有确认 PNG 下载完成");
      }
      image.receipt = deepClone({ ...receipt, pngSha256: result.pngSha256, rowCount: result.rowCount, renderedAt: result.renderedAt });
      this.persist("image-download-verified", { kind, ...image.receipt });
      return true;
    } catch (error) {
      this.session.phase = "paused";
      this.session.pauseReason = { code: error.code || "download-failed", message: text(error.message, 500) };
      this.persist("image-download-failed", { kind, ...this.session.pauseReason });
      return false;
    }
  }

  async downloadPairingsImage(state, pairings) {
    const ok = await this.downloadImage(
      "pairing",
      "renderPairingsImage",
      this.pairingImageRows(state, pairings),
      this.pairingImageFilename(),
      "locked-ftd-pairings",
    );
    if (ok) this.session.phase = "polling-oq";
    return ok;
  }

  async readScoreImageRows(round, writtenRows, { verifyTranscripts = false, conflictPrefix = "比分图" } = {}) {
    const snapshots = [];
    for (const definition of this.session.scope.definitions) {
      const command = this.baseCommand(this.session.scope, "readbackRound", { sessionId: this.session.sessionId, actualFtdRound: definition.actualFtdRound });
      const snapshot = await this.bridgeCommand(command, 35000);
      FTD_ROUND.assertBridgeRound(snapshot, this.session.scope.tournamentId, definition);
      snapshots.push(snapshot);
    }
    const writtenByFingerprint = new Map(writtenRows.map((row) => [row.pairingFingerprint, row]));
    return [...(round.ftdPairings || [])].sort((a, b) => Number(a.table) - Number(b.table)).map((row) => {
      const snapshot = snapshots.find((item) => Number(item.actualFtdRound) === Number(row.ftdRound));
      const live = snapshot && snapshot.pairings.find((item) => item.pairingFingerprint === row.pairingFingerprint);
      if (!live) throw makeCoordinatorError("score-image-pairing-conflict", `${conflictPrefix}第 ${row.table} 台配对回读不一致`);
      const written = writtenByFingerprint.get(row.pairingFingerprint);
      if (written && (live.blackScore !== Number(written.blackScore) || live.whiteScore !== Number(written.whiteScore))) {
        throw makeCoordinatorError("score-image-readback-conflict", `${conflictPrefix}第 ${row.table} 台比分回读不一致`);
      }
      if (written && verifyTranscripts && written.ftdTranscriptReceipt && sha256(live.transcript) !== written.ftdTranscriptReceipt.readbackTranscriptHash) {
        throw makeCoordinatorError("score-image-transcript-conflict", `${conflictPrefix}第 ${row.table} 台棋谱回读不一致`);
      }
      return {
        pairingFingerprint: row.pairingFingerprint,
        label: this.imageRowLabel(row),
        black: row.black,
        white: row.white,
        blackScore: written ? live.blackScore : null,
        whiteScore: written ? live.whiteScore : null,
        ftdBlackScore: Number.isInteger(live.blackScore) ? live.blackScore : null,
        verified: Boolean(written),
      };
    });
  }

  async tryDownloadHalfwayScoreImage() {
    const images = this.ensureSessionImages();
    if (images.halfway.receipt) return false;
    const state = this.readState().state;
    this.assertScopeStillLocked(state);
    const round = this.scopeRound(state);
    const active = (round.ftdPairings || []).filter((row) => !FTD_ROUND.isByeName(row.black) && !FTD_ROUND.isByeName(row.white));
    if (!active.length) return false;
    const completed = active.filter((row) => row.status === "completed" && row.ftdScoreReceipt && row.ftdScoreReceipt.sessionId === this.session.sessionId);
    const threshold = Math.ceil(active.length / 2);
    if (completed.length < threshold) return false;
    const rows = await this.readScoreImageRows(round, completed, { conflictPrefix: "半程比分图" });
    const ok = await this.downloadImage("halfway", "renderVerifiedRoundImage", rows, this.halfwayImageFilename(), "halfway-ftd-readback");
    if (ok) {
      this.session.phase = "polling-oq";
      this.persist("halfway-image-complete", { completedCount: completed.length, activeCount: active.length, threshold });
      return false;
    }
    return true;
  }

  async tryFinalize() {
    const state = this.readState().state;
    this.assertScopeStillLocked(state);
    const round = this.scopeRound(state);
    const active = (round.ftdPairings || []).filter((row) => !FTD_ROUND.isByeName(row.black) && !FTD_ROUND.isByeName(row.white));
    if (!active.length) return false;
    for (const row of active) {
      if (!row.ftdScoreReceipt || row.ftdScoreReceipt.sessionId !== this.session.sessionId || row.status !== "completed") return false;
      const transcriptDone = row.ftdTranscriptReceipt && row.ftdTranscriptReceipt.sessionId === this.session.sessionId;
      const transcriptNa = row.transcriptNotApplicable && row.transcriptNotApplicable.sessionId === this.session.sessionId && text(row.transcriptNotApplicable.reason);
      if (!transcriptDone && !transcriptNa) return false;
      if (row.dirty === true || this.rowHasBlockingPending(round, row, false)) return false;
    }
    this.session.phase = "verifying-transcripts";
    this.persist("final-readback-start", { tableCount: active.length });
    const imageRows = await this.readScoreImageRows(round, active, { verifyTranscripts: true, conflictPrefix: "最终比分图" });
    const ok = await this.downloadImage("final", "renderVerifiedRoundImage", imageRows, this.verifiedImageFilename(), "final-ftd-readback");
    if (!ok) return true;
    return this.finishDone();
  }

  imageRowLabel(row) {
    if (this.session.scope.localStage === "finals") return row.ftdStage === "F" ? "Final" : "3rd Place";
    return `#${row.table}`;
  }

  verifiedImageFilename() {
    const id = this.session.scope.tournamentId;
    if (this.session.scope.localStage === "semifinal") return `ftd-${id}-semifinal-scores-verified.png`;
    if (this.session.scope.localStage === "finals") return `ftd-${id}-finals-scores-verified.png`;
    return `ftd-${id}-round-${String(this.session.scope.localRound).padStart(2, "0")}-scores-verified.png`;
  }

  halfwayImageFilename() {
    const id = this.session.scope.tournamentId;
    if (this.session.scope.localStage === "semifinal") return `ftd-${id}-semifinal-scores-halfway-verified.png`;
    if (this.session.scope.localStage === "finals") return `ftd-${id}-finals-scores-halfway-verified.png`;
    return `ftd-${id}-round-${String(this.session.scope.localRound).padStart(2, "0")}-scores-halfway-verified.png`;
  }

  pairingImageFilename() {
    const id = this.session.scope.tournamentId;
    if (this.session.scope.localStage === "semifinal") return `ftd-${id}-semifinal-pairings.png`;
    if (this.session.scope.localStage === "finals") return `ftd-${id}-finals-pairings.png`;
    return `ftd-${id}-round-${String(this.session.scope.localRound).padStart(2, "0")}-pairings.png`;
  }

  finishDone() {
    this.session.phase = "done";
    this.session.writeAllowed = false;
    this.session.completedAt = this.now();
    this.session.pauseReason = null;
    this.persist("session-done", { images: this.session.images, criteria: "pairings, halfway scores, and final verified scores all have complete Chrome download receipts" });
    return true;
  }

  async handleRunError(error) {
    if (!this.session) return;
    const code = text(error && error.code, 100) || "autopilot-error";
    const message = text(error && error.message, 500) || "AP 失败";
    if (code === "bridge-disconnected" || code === "bridge-timeout") {
      this.session.phase = "paused";
      this.session.pauseReason = { code: "bridge-disconnected", message };
      this.persist("session-paused-bridge", this.session.pauseReason);
      return;
    }
    if (["scope-changed", "ftd-round-finished", "ftd-round-not-started", "readonly-proof-failed"].includes(code)) {
      this.session.phase = "paused";
      this.session.pauseReason = { code, message };
      this.persist("session-paused", this.session.pauseReason);
      return;
    }
    this.session.phase = "failed";
    this.session.writeAllowed = false;
    this.session.failure = { code, message, at: this.now() };
    this.persist("session-failed", this.session.failure);
  }
}

module.exports = {
  EXPECTED_EXTENSION_ID,
  EXPECTED_BRIDGE_VERSION,
  TERMINAL_PHASES,
  ACTIVE_PHASES,
  BridgeBroker,
  FtdAutopilotCoordinator,
  validScorePair,
  safeJournalValue,
  sha256,
  localDateTimeValue,
  oqResultSource,
  isVerifiedOqReadyRow,
};
