"use strict";

const crypto = require("crypto");

const SYNC_KEYS = new Set(["entityId", "entityRevision"]);
const REMOVABLE_ENTITY_KINDS = new Set([
  "player",
  "mappingRow",
  "registrationRow",
  "scoreRow",
  "pending",
  "manualPending",
  "completedItem",
]);
const ROOT_DOMAIN_FIELDS = {
  tournament: ["competitionName", "nextPlayerId", "clubText", "relayText", "groupRules"],
  accountMapping: ["accountMapping"],
  wechatGroupNicks: ["wechatGroupNicks"],
  ftdRound: ["ftdRound"],
  egaAnalysis: ["egaAnalysis"],
};
const ROUND_IMPORT_SCORE_FIELDS = [
  "table",
  "black",
  "white",
  "blackAccount",
  "whiteAccount",
  "ftdStage",
  "ftdRound",
  "ftdTable",
  "isBye",
  "bye",
  "byePlayer",
  "byeReason",
];

class CommandError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CommandError";
    this.code = code;
    this.statusCode = code === "entity-conflict" || code === "state-conflict" ? 409 : 400;
    Object.assign(this, details);
  }
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function equal(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function clean(value) {
  return String(value == null ? "" : value).normalize("NFKC").replace(/\s+/g, " ").trim();
}

function identityKey(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex").slice(0, 20);
}

function stableId(prefix, identity) {
  const text = clean(identity);
  if (!text) throw new CommandError("identity-missing", `${prefix} entity has no deterministic identity`);
  return `${prefix}:${digest(text)}`;
}

function migratedEntityId(object, prefix, identity) {
  const existing = object && typeof object.entityId === "string" ? object.entityId.trim() : "";
  if (!existing) return stableId(prefix, identity);
  if (existing !== object.entityId || !existing.startsWith(`${prefix}:`)) {
    throw new CommandError("identity-collision", `invalid persisted ${prefix} entity identity ${object.entityId}`);
  }
  return existing;
}

function roundIdentity(round, index) {
  const stage = clean(round && round.stage).toLowerCase() || "preliminary";
  const number = Math.trunc(Number(round && round.round) || index + 1);
  return `${stage}:${number}`;
}

function scoreIdentity(roundId, row) {
  const table = clean(row && (row.ftdTable || row.table));
  const stage = clean(row && row.ftdStage).toLowerCase();
  const round = clean(row && row.ftdRound);
  const black = identityKey(row && row.black);
  const white = identityKey(row && row.white);
  if (!table || !black || !white) {
    throw new CommandError("identity-missing", `score row in ${roundId} lacks table/player identity`);
  }
  return `${roundId}|${stage}|${round}|${table}|${black}|${white}`;
}

function pendingIdentity(roundId, item) {
  const source = clean(item && item.sourceMessageKey);
  if (source) return `${roundId}|source:${source}`;
  const explicit = clean(item && (item.pendingId || item.id));
  if (explicit) return `${roundId}|id:${explicit}`;
  const table = clean(item && (item.pendingTable || item.dirtyTable || item.table));
  const kind = clean(item && (item.pendingKind || item.verdict || item.status));
  const sender = identityKey(item && (item.wechatSender || item.sender));
  if (!table || !kind) {
    throw new CommandError("identity-missing", `pending item in ${roundId} lacks a stable source/table identity`);
  }
  return `${roundId}|fallback:${table}|${kind}|${sender}`;
}

function mappingIdentity(row) {
  return clean(row && (row.ftdId || row.ftdName || row.displayName || row.name));
}

function registrationIdentity(row) {
  return clean(row && (row.rowId || row.playerId || row.id));
}

function ensureEntity(object, id) {
  if (!object || typeof object !== "object" || Array.isArray(object)) {
    throw new CommandError("invalid-entity", `entity ${id} must be an object`);
  }
  if (object.entityId && object.entityId !== id) {
    throw new CommandError("identity-collision", `entity identity changed from ${object.entityId} to ${id}`);
  }
  object.entityId = id;
  object.entityRevision = Math.max(0, Math.trunc(Number(object.entityRevision) || 0));
  return object;
}

function register(seen, id, identity) {
  const prior = seen.get(id);
  if (prior && prior !== identity) {
    throw new CommandError("identity-collision", `deterministic identity collision for ${id}`);
  }
  if (prior) throw new CommandError("identity-collision", `duplicate entity identity for ${id}`);
  seen.set(id, identity);
}

function inferLegacyResultSource(row) {
  if (!row || row.resultSource) return;
  const key = clean(row.sourceMessageKey).toLowerCase();
  const kind = clean(row.resultKind).toLowerCase();
  if (row.oqAutoAudit || key.startsWith("oq-auto:") || kind === "oq-auto") row.resultSource = "oq-auto";
  else if (row.ftdAutomationReceipt || row.ftdScoreReceipt) row.resultSource = "ftd-autopilot";
  else if (row.imagePath || key.startsWith("wechat:")) row.resultSource = "wechat-image";
  else if (["ready", "completed", "dirty"].includes(clean(row.status).toLowerCase())) row.resultSource = "legacy-unknown";
}

function migrateState(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new CommandError("invalid-state", "state must be an object");
  }
  const state = clone(input);
  const seen = new Map();
  const players = Array.isArray(state.players) ? state.players : [];
  players.forEach((row, index) => {
    const identity = clean(row && (row.id ?? row.playerId ?? row.displayName));
    const id = migratedEntityId(row, "player", identity || `legacy-index-${index}`);
    register(seen, id, identity || `legacy-index-${index}`);
    ensureEntity(row, id);
  });

  const mapping = state.ftdPlayerAccountMapping;
  if (mapping && typeof mapping === "object") {
    ensureEntity(mapping, "mapping:metadata");
    const rows = Array.isArray(mapping.players) ? mapping.players : [];
    rows.forEach((row) => {
      const identity = mappingIdentity(row);
      const id = migratedEntityId(row, "mapping", identity);
      register(seen, id, identityKey(identity));
      ensureEntity(row, id);
    });
  }

  const registration = state.ftdPlayerRegistration;
  if (registration && typeof registration === "object") {
    ensureEntity(registration, "registration:metadata");
    const rows = Array.isArray(registration.rows) ? registration.rows : [];
    rows.forEach((row) => {
      const identity = registrationIdentity(row);
      const id = migratedEntityId(row, "registration", identity);
      register(seen, id, identity);
      ensureEntity(row, id);
    });
  }

  const helper = state.scoreHelper;
  if (helper && typeof helper === "object") {
    ensureEntity(helper, "scoreHelper:metadata");
    const rounds = Array.isArray(helper.rounds) ? helper.rounds : [];
    rounds.forEach((round, index) => {
      const identity = roundIdentity(round, index);
      const roundId = migratedEntityId(round, "round", identity);
      register(seen, roundId, identity);
      ensureEntity(round, roundId);
      const buckets = [
        ["ftdPairings", "score"],
        ["pending", "pending"],
        ["manualPending", "manualPending"],
        ["completed", "completedItem"],
      ];
      for (const [field, prefix] of buckets) {
        const values = Array.isArray(round[field]) ? round[field] : [];
        values.forEach((row) => {
          const identityValue = field === "ftdPairings"
            ? scoreIdentity(roundId, row)
            : pendingIdentity(roundId, row);
          const id = migratedEntityId(row, prefix, identityValue);
          register(seen, id, identityValue);
          ensureEntity(row, id);
          if (field === "ftdPairings") inferLegacyResultSource(row);
        });
      }
    });
  }

  state.localSync = state.localSync && typeof state.localSync === "object" ? state.localSync : {};
  state.localSync.revision = Math.max(0, Math.trunc(Number(state.localSync.revision) || 0));
  state.localSync.commandIds = Array.isArray(state.localSync.commandIds)
    ? state.localSync.commandIds.filter((item) => item && typeof item.id === "string").slice(-500)
    : [];
  state.localSync.domains = state.localSync.domains && typeof state.localSync.domains === "object"
    ? state.localSync.domains
    : {};
  for (const id of Object.keys(ROOT_DOMAIN_FIELDS)) {
    const current = state.localSync.domains[id];
    state.localSync.domains[id] = {
      entityId: `domain:${id}`,
      entityRevision: Math.max(0, Math.trunc(Number(current && current.entityRevision) || 0)),
    };
  }
  return state;
}

function entityIndex(state) {
  const index = new Map();
  const add = (kind, object, parent = null, field = null, position = -1) => {
    if (!object || !object.entityId) return;
    if (index.has(object.entityId)) throw new CommandError("identity-collision", `duplicate entityId ${object.entityId}`);
    index.set(object.entityId, { kind, object, parent, field, position });
  };
  (state.players || []).forEach((row, i) => add("player", row, state, "players", i));
  const mapping = state.ftdPlayerAccountMapping;
  if (mapping) {
    add("mappingMetadata", mapping, state, "ftdPlayerAccountMapping");
    (mapping.players || []).forEach((row, i) => add("mappingRow", row, mapping, "players", i));
  }
  const registration = state.ftdPlayerRegistration;
  if (registration) {
    add("registrationMetadata", registration, state, "ftdPlayerRegistration");
    (registration.rows || []).forEach((row, i) => add("registrationRow", row, registration, "rows", i));
  }
  const helper = state.scoreHelper;
  if (helper) {
    add("scoreHelperMetadata", helper, state, "scoreHelper");
    (helper.rounds || []).forEach((round) => {
      add("round", round, helper, "rounds", helper.rounds.indexOf(round));
      for (const [field, kind] of [["ftdPairings", "scoreRow"], ["pending", "pending"], ["manualPending", "manualPending"], ["completed", "completedItem"]]) {
        (round[field] || []).forEach((row, i) => add(kind, row, round, field, i));
      }
    });
  }
  return index;
}

function entityPayload(kind, object) {
  if (!["mappingMetadata", "registrationMetadata", "scoreHelperMetadata", "round"].includes(kind)) {
    return clone(object);
  }
  return {
    ...ownedProjection(object, kind),
    entityId: object.entityId,
    entityRevision: object.entityRevision,
  };
}

function publicEntity(entry) {
  return entry ? {
    kind: entry.kind,
    id: entry.object.entityId,
    revision: entry.object.entityRevision,
    entity: entityPayload(entry.kind, entry.object),
  } : null;
}

function conflict(entry, expected) {
  throw new CommandError("entity-conflict", `entity ${entry.object.entityId} changed`, {
    expectedRevision: expected,
    currentRevision: entry.object.entityRevision,
    authoritativeEntity: publicEntity(entry),
  });
}

function assertExpected(entry, expected) {
  if (!Number.isInteger(Number(expected)) || Number(expected) !== Number(entry.object.entityRevision)) {
    conflict(entry, expected);
  }
}

function sanitizedReplacement(value, current) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CommandError("invalid-command", "replacement entity must be an object");
  }
  const next = clone(value);
  next.entityId = current.entityId;
  next.entityRevision = current.entityRevision;
  return next;
}

function applyMutation(state, mutation, changed) {
  if (!mutation || typeof mutation !== "object") throw new CommandError("invalid-command", "mutation must be an object");
  const index = entityIndex(state);
  const targetId = clean(mutation.target && mutation.target.id);
  const entry = index.get(targetId);
  if (!entry) throw new CommandError("entity-not-found", `entity ${targetId || "(missing)"} was not found`);
  if (mutation.target.kind && mutation.target.kind !== entry.kind) {
    throw new CommandError("entity-kind-mismatch", `entity ${targetId} is ${entry.kind}, not ${mutation.target.kind}`);
  }
  assertExpected(entry, mutation.expectedRevision);
  let next;
  if (mutation.op === "patch") {
    const set = mutation.set && typeof mutation.set === "object" && !Array.isArray(mutation.set) ? mutation.set : {};
    if (Object.keys(set).some((key) => SYNC_KEYS.has(key))) throw new CommandError("invalid-command", "sync identity fields are immutable");
    next = { ...entry.object, ...clone(set) };
    for (const key of Array.isArray(mutation.unset) ? mutation.unset : []) {
      if (!SYNC_KEYS.has(key)) delete next[key];
    }
  } else if (mutation.op === "replace") {
    next = sanitizedReplacement(mutation.value, entry.object);
  } else if (mutation.op === "remove") {
    if (!entry.parent || !Array.isArray(entry.parent[entry.field])) throw new CommandError("invalid-command", "entity cannot be removed");
    entry.parent[entry.field].splice(entry.position, 1);
    changed.push({ kind: entry.kind, id: targetId, revision: entry.object.entityRevision + 1, removed: true });
    return;
  } else {
    throw new CommandError("invalid-command", `unsupported mutation op ${mutation.op}`);
  }
  if (entry.kind === "pending" && entry.object.resolutionStatus === "resolved" && next.resolutionStatus !== "resolved") {
    throw new CommandError("resolved-pending-terminal", `resolved pending ${targetId} cannot be reopened`);
  }
  if (equal(entry.object, next)) return;
  next.entityRevision = entry.object.entityRevision + 1;
  if (Array.isArray(entry.parent && entry.parent[entry.field])) entry.parent[entry.field][entry.position] = next;
  else entry.parent[entry.field] = next;
  changed.push({ kind: entry.kind, id: targetId, revision: next.entityRevision, entity: entityPayload(entry.kind, next) });
}

function applyDomainMutation(state, mutation, changed) {
  const domainId = clean(mutation.target && mutation.target.id).replace(/^domain:/, "");
  const allowed = ROOT_DOMAIN_FIELDS[domainId];
  if (!allowed) throw new CommandError("entity-not-found", `domain ${domainId} was not found`);
  const meta = state.localSync.domains[domainId];
  assertExpected({ object: meta }, mutation.expectedRevision);
  const set = mutation.set && typeof mutation.set === "object" && !Array.isArray(mutation.set) ? mutation.set : {};
  if (Object.keys(set).some((key) => !allowed.includes(key))) {
    throw new CommandError("invalid-command", `domain ${domainId} received fields it does not own`);
  }
  let semanticChange = false;
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(set, key) && !equal(state[key], set[key])) {
      state[key] = clone(set[key]);
      semanticChange = true;
    }
  }
  if (!semanticChange) return;
  meta.entityRevision += 1;
  changed.push({
    kind: "domain",
    id: meta.entityId,
    revision: meta.entityRevision,
    entity: Object.fromEntries(allowed.map((key) => [key, clone(state[key])])),
  });
}

function findRoundById(state, roundId) {
  return (state.scoreHelper && Array.isArray(state.scoreHelper.rounds) ? state.scoreHelper.rounds : [])
    .find((round) => round.entityId === roundId);
}

function applyAdd(state, mutation, changed) {
  const collection = clean(mutation.collection);
  let parent;
  let field;
  let kind;
  if (collection === "players") { parent = state; field = "players"; kind = "player"; }
  else if (collection === "mappingRows") { parent = state.ftdPlayerAccountMapping; field = "players"; kind = "mappingRow"; }
  else if (collection === "registrationRows") { parent = state.ftdPlayerRegistration; field = "rows"; kind = "registrationRow"; }
  else {
    const round = findRoundById(state, clean(mutation.parentId));
    if (!round) throw new CommandError("entity-not-found", `round ${mutation.parentId} was not found`);
    const map = { scoreRows: ["ftdPairings", "scoreRow"], pending: ["pending", "pending"], manualPending: ["manualPending", "manualPending"], completedItems: ["completed", "completedItem"] };
    if (!map[collection]) throw new CommandError("invalid-command", `unsupported collection ${collection}`);
    [field, kind] = map[collection];
    parent = round;
  }
  if (!parent) throw new CommandError("entity-not-found", `collection ${collection} is unavailable`);
  if (mutation.expectedParentRevision != null) {
    if (!parent.entityId) throw new CommandError("invalid-command", `collection ${collection} has no revisioned parent`);
    assertExpected({ object: parent }, mutation.expectedParentRevision);
  }
  if (!Array.isArray(parent[field])) parent[field] = [];
  const value = clone(mutation.value);
  if (!value || typeof value !== "object" || !value.entityId) throw new CommandError("invalid-command", "new entity requires a deterministic entityId");
  if (entityIndex(state).has(value.entityId)) throw new CommandError("entity-conflict", `entity ${value.entityId} already exists`);
  value.entityRevision = 0;
  parent[field].push(value);
  changed.push({ kind, id: value.entityId, revision: 0, entity: clone(value), collection, parentId: clean(mutation.parentId) });
}

function applyOqResolution(state, command, changed) {
  const payload = command.payload && typeof command.payload === "object" ? command.payload : {};
  const index = entityIndex(state);
  const score = index.get(clean(command.target && command.target.id));
  if (!score || score.kind !== "scoreRow") throw new CommandError("entity-not-found", "OQ target score row was not found");
  assertExpected(score, command.expectedRevision);
  const preconditions = Array.isArray(command.preconditions) ? command.preconditions : [];
  const pendingEntries = preconditions.map((item) => {
    const entry = index.get(clean(item && item.target && item.target.id));
    if (!entry || entry.kind !== "pending") throw new CommandError("entity-not-found", `OQ pending ${item && item.target && item.target.id} was not found`);
    assertExpected(entry, item.expectedRevision);
    return entry;
  });
  if (!pendingEntries.length) throw new CommandError("invalid-command", "OQ resolution requires pending preconditions");
  const table = clean(score.object.table);
  const requiredPendingIds = new Set((score.parent.pending || []).filter((item) => {
    if (!item || item.resolutionStatus === "resolved" || item.resolvedByReferee === true) return false;
    if (clean(item.pendingTable || item.table) !== table) return false;
    const pendingKind = clean(item.pendingKind);
    const verdict = clean(item.verdict);
    const sourceKey = clean(item.sourceMessageKey);
    return item.resultSource === "oq-auto" || pendingKind.startsWith("oq-auto") || verdict.startsWith("oq-auto") || sourceKey.startsWith("oq-auto:");
  }).map((item) => item.entityId));
  const suppliedPendingIds = new Set(pendingEntries.map((entry) => entry.object.entityId));
  if (requiredPendingIds.size !== suppliedPendingIds.size || [...requiredPendingIds].some((id) => !suppliedPendingIds.has(id))) {
    throw new CommandError("entity-conflict", "OQ pending candidates changed", {
      currentRevision: score.object.entityRevision,
      authoritativeEntity: publicEntity(score),
      authoritativePending: [...requiredPendingIds].map((id) => publicEntity(index.get(id))),
    });
  }
  const sourceKey = clean(payload.sourceKey);
  if (!sourceKey) throw new CommandError("invalid-command", "OQ resolution requires sourceKey");
  const blackScore = Math.trunc(Number(payload.blackScore));
  const whiteScore = Math.trunc(Number(payload.whiteScore));
  if (blackScore < 0 || whiteScore < 0 || blackScore + whiteScore !== 64) throw new CommandError("invalid-command", "OQ scores must total 64");
  const editedAt = Number(payload.editedAt) || Date.now();
  const selected = {
    ...score.object,
    status: "ready",
    dirty: false,
    blackScore,
    whiteScore,
    sourceMessageKey: sourceKey.startsWith("oq-auto:") ? sourceKey : `oq-auto:${sourceKey}`,
    resultKind: "oq-auto",
    resultSource: "oq-auto",
    resultTime: clean(payload.resultTime),
    resultSortKey: Number(payload.resultSortKey) || editedAt,
    lastEditedBy: clean(command.actor) || "user",
    lastEditedAt: editedAt,
    updatedAt: editedAt,
    completedAt: null,
    oqAutoAudit: clone(payload.audit || {}),
    entityRevision: score.object.entityRevision + 1,
  };
  score.parent[score.field][score.position] = selected;
  changed.push({ kind: "scoreRow", id: selected.entityId, revision: selected.entityRevision, entity: clone(selected) });
  for (const entry of pendingEntries) {
    const next = {
      ...entry.object,
      resolutionStatus: "resolved",
      resolvedByReferee: true,
      resolvedAt: editedAt,
      resolvedByCommandId: command.commandId,
      selectedSourceKey: selected.sourceMessageKey,
      lastEditedBy: clean(command.actor) || "user",
      lastEditedAt: editedAt,
      entityRevision: entry.object.entityRevision + 1,
    };
    entry.parent[entry.field][entry.position] = next;
    changed.push({ kind: "pending", id: next.entityId, revision: next.entityRevision, entity: clone(next) });
  }
}

function applyRoundImport(state, command, changed) {
  const payload = command.payload && typeof command.payload === "object" ? command.payload : {};
  const index = entityIndex(state);
  const roundEntry = index.get(clean(command.target && command.target.id));
  if (!roundEntry || roundEntry.kind !== "round") throw new CommandError("entity-not-found", "round import target was not found");
  assertExpected(roundEntry, command.expectedRevision);
  const scorePreconditionIds = new Set();
  for (const precondition of Array.isArray(command.preconditions) ? command.preconditions : []) {
    const targetId = clean(precondition && precondition.target && precondition.target.id);
    if (targetId === "scoreHelper:metadata") {
      const helperEntry = index.get(targetId);
      if (!helperEntry) throw new CommandError("entity-not-found", "score helper metadata was not found");
      assertExpected(helperEntry, precondition.expectedRevision);
    } else if (targetId === "domain:ftdRound") {
      assertExpected({ object: state.localSync.domains.ftdRound }, precondition.expectedRevision);
    } else if (index.has(targetId) && index.get(targetId).kind === "scoreRow" && index.get(targetId).parent === roundEntry.object) {
      const scoreEntry = index.get(targetId);
      assertExpected(scoreEntry, precondition.expectedRevision);
      scorePreconditionIds.add(targetId);
    } else {
      throw new CommandError("invalid-command", `unsupported round import precondition ${targetId}`);
    }
  }
  const pairings = Array.isArray(payload.pairings) ? clone(payload.pairings) : null;
  if (!pairings || !pairings.length) throw new CommandError("invalid-command", "round import requires pairings");
  const roundId = roundEntry.object.entityId;
  const previousRows = Array.isArray(roundEntry.object.ftdPairings) ? roundEntry.object.ftdPairings : [];
  const currentScoreIds = new Set(previousRows.map((row) => row.entityId));
  if (currentScoreIds.size !== scorePreconditionIds.size || [...currentScoreIds].some((id) => !scorePreconditionIds.has(id))) {
    throw new CommandError("entity-conflict", "round score rows changed", {
      currentRevision: roundEntry.object.entityRevision,
      authoritativeEntity: publicEntity(roundEntry),
      authoritativeScoreRows: previousRows.map((row) => publicEntity(index.get(row.entityId))),
    });
  }
  const previousById = new Map(previousRows.map((row) => [row.entityId, row]));
  const imported = pairings.map((row) => {
    const id = stableId("score", scoreIdentity(roundId, row));
    const previous = previousById.get(id);
    if (!previous) return ensureEntity({ ...row, entityId: id, entityRevision: 0 }, id);
    const next = clone(previous);
    for (const field of ROUND_IMPORT_SCORE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(row, field)) next[field] = clone(row[field]);
    }
    return next;
  });
  const ids = new Set(imported.map((row) => row.entityId));
  if (ids.size !== imported.length) throw new CommandError("identity-collision", "round import contains duplicate pairing identities");
  const scoreChanges = [];
  for (let index = 0; index < imported.length; index += 1) {
    const row = imported[index];
    const previous = previousById.get(row.entityId);
    if (!previous) {
      scoreChanges.push({
        kind: "scoreRow",
        collection: "scoreRows",
        parentId: roundId,
        id: row.entityId,
        revision: 0,
        entity: clone(row),
      });
    } else if (!equal(previous, row)) {
      row.entityRevision = previous.entityRevision + 1;
      scoreChanges.push({
        kind: "scoreRow",
        collection: "scoreRows",
        parentId: roundId,
        id: row.entityId,
        revision: row.entityRevision,
        entity: clone(row),
      });
    }
  }
  const removedRows = previousRows.filter((row) => !ids.has(row.entityId));
  const roundPatch = payload.roundPatch && typeof payload.roundPatch === "object" ? clone(payload.roundPatch) : {};
  delete roundPatch.entityId;
  delete roundPatch.entityRevision;
  delete roundPatch.ftdPairings;
  delete roundPatch.pending;
  delete roundPatch.manualPending;
  delete roundPatch.completed;
  const nextRound = {
    ...roundEntry.object,
    ...roundPatch,
    ftdPairings: imported,
    entityId: roundId,
    entityRevision: roundEntry.object.entityRevision,
  };
  if (!equal(roundEntry.object, nextRound)) {
    nextRound.entityRevision += 1;
    roundEntry.parent.rounds[roundEntry.position] = nextRound;
    for (const row of removedRows) changed.push({
      kind: "scoreRow",
      collection: "scoreRows",
      parentId: roundId,
      id: row.entityId,
      revision: row.entityRevision + 1,
      removed: true,
    });
    changed.push(...scoreChanges);
    changed.push({ kind: "round", id: roundId, revision: nextRound.entityRevision, entity: entityPayload("round", nextRound) });
  }

  if (payload.scoreHelperPatch && typeof payload.scoreHelperPatch === "object") {
    const helper = state.scoreHelper;
    const owned = clone(payload.scoreHelperPatch);
    delete owned.activeRound;
    delete owned.rounds;
    const nextHelper = { ...helper, ...owned };
    if (!equal(ownedProjection(helper, "scoreHelperMetadata"), ownedProjection(nextHelper, "scoreHelperMetadata"))) {
      nextHelper.entityRevision = helper.entityRevision + 1;
      state.scoreHelper = nextHelper;
      changed.push({ kind: "scoreHelperMetadata", id: nextHelper.entityId, revision: nextHelper.entityRevision, entity: entityPayload("scoreHelperMetadata", nextHelper) });
    }
  }
  if (Object.prototype.hasOwnProperty.call(payload, "ftdRound")) {
    if (!equal(state.ftdRound, payload.ftdRound)) {
      state.ftdRound = clone(payload.ftdRound);
      state.localSync.domains.ftdRound.entityRevision += 1;
      changed.push({ kind: "domain", id: "domain:ftdRound", revision: state.localSync.domains.ftdRound.entityRevision, entity: { ftdRound: clone(state.ftdRound) } });
    }
  }
}

function commandLogEntry(state, commandId) {
  return (state.localSync.commandIds || []).find((item) => item.id === commandId) || null;
}

function hydrateLoggedEntity(state, summary, index) {
  if (summary.removed) return clone(summary);
  if (summary.kind === "domain") {
    const domainId = clean(summary.id).replace(/^domain:/, "");
    const fields = ROOT_DOMAIN_FIELDS[domainId];
    if (!fields) return clone(summary);
    return {
      ...clone(summary),
      revision: state.localSync.domains[domainId].entityRevision,
      entity: Object.fromEntries(fields.map((field) => [field, clone(state[field])])),
    };
  }
  const entry = index.get(summary.id);
  if (!entry) return clone(summary);
  const hydrated = { ...clone(summary), ...publicEntity(entry) };
  const collectionByKind = {
    player: "players",
    mappingRow: "mappingRows",
    registrationRow: "registrationRows",
    scoreRow: "scoreRows",
    pending: "pending",
    manualPending: "manualPending",
    completedItem: "completedItems",
  };
  if (collectionByKind[entry.kind]) hydrated.collection = summary.collection || collectionByKind[entry.kind];
  if (entry.parent && entry.parent.entityId) hydrated.parentId = summary.parentId || entry.parent.entityId;
  return hydrated;
}

function applyCommand(inputState, envelope) {
  const state = migrateState(inputState);
  const command = clone(envelope || {});
  const commandId = clean(command.commandId);
  if (!commandId) throw new CommandError("invalid-command", "commandId is required");
  const prior = commandLogEntry(state, commandId);
  if (prior) {
    const index = entityIndex(state);
    return {
      state,
      changed: false,
      idempotent: true,
      revision: state.localSync.revision,
      changedEntities: (prior.changedEntities || []).map((item) => hydrateLoggedEntity(state, item, index)),
    };
  }
  const changedEntities = [];
  if (command.type === "entities.mutate") {
    const mutations = Array.isArray(command.payload && command.payload.mutations) ? command.payload.mutations : [];
    for (const mutation of mutations) {
      if (mutation.op === "patchDomain") applyDomainMutation(state, mutation, changedEntities);
      else if (mutation.op === "add") applyAdd(state, mutation, changedEntities);
      else applyMutation(state, mutation, changedEntities);
    }
  } else if (command.type === "oq.resolveCandidate") {
    applyOqResolution(state, command, changedEntities);
  } else if (command.type === "round.import") {
    applyRoundImport(state, command, changedEntities);
  } else {
    throw new CommandError("unsupported-command", `unsupported command type ${command.type}`);
  }
  if (!changedEntities.length) return { state, changed: false, idempotent: false, revision: state.localSync.revision, changedEntities: [] };
  state.localSync.revision += 1;
  state.localSync.commandIds = [...(state.localSync.commandIds || []), {
    id: commandId,
    revision: state.localSync.revision,
    changedEntities: changedEntities.map(({ kind, id, revision, removed, collection, parentId }) => ({
      kind,
      id,
      revision,
      removed: Boolean(removed),
      ...(collection ? { collection } : {}),
      ...(parentId ? { parentId } : {}),
    })),
  }].slice(-500);
  return { state, changed: true, idempotent: false, revision: state.localSync.revision, changedEntities };
}

function stripSync(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const next = { ...value };
  delete next.entityId;
  delete next.entityRevision;
  return next;
}

function ownedProjection(value, kind) {
  const next = stripSync(value);
  if (kind === "mappingMetadata") delete next.players;
  else if (kind === "registrationMetadata") delete next.rows;
  else if (kind === "scoreHelperMetadata") delete next.rounds;
  if (kind === "scoreHelperMetadata") delete next.activeRound;
  else if (kind === "round") {
    delete next.ftdPairings;
    delete next.pending;
    delete next.manualPending;
    delete next.completed;
  }
  return next;
}

function diffEntity(base, next, mutations, kind) {
  const before = ownedProjection(base, kind);
  const after = ownedProjection(next, kind);
  if (equal(before, after)) return;
  mutations.push({ op: "patch", target: { kind, id: base.entityId }, expectedRevision: base.entityRevision, set: after, unset: Object.keys(before).filter((key) => !Object.prototype.hasOwnProperty.call(after, key)) });
}

function diffState(baseInput, nextInput) {
  const base = migrateState(baseInput);
  const next = migrateState(nextInput);
  const mutations = [];
  const baseIndex = entityIndex(base);
  const nextIndex = entityIndex(next);
  for (const [domainId, fields] of Object.entries(ROOT_DOMAIN_FIELDS)) {
    const set = {};
    let changed = false;
    for (const field of fields) {
      if (!equal(base[field], next[field])) {
        set[field] = clone(next[field]);
        changed = true;
      }
    }
    if (changed) mutations.push({
      op: "patchDomain",
      target: { kind: "domain", id: `domain:${domainId}` },
      expectedRevision: base.localSync.domains[domainId].entityRevision,
      set,
    });
  }
  for (const [id, baseEntry] of baseIndex) {
    const nextEntry = nextIndex.get(id);
    if (!nextEntry) {
      const parentId = baseEntry.parent && baseEntry.parent.entityId;
      const parentStillExists = !parentId || nextIndex.has(parentId);
      if (REMOVABLE_ENTITY_KINDS.has(baseEntry.kind) && parentStillExists) {
        mutations.push({ op: "remove", target: { kind: baseEntry.kind, id }, expectedRevision: baseEntry.object.entityRevision });
      }
    }
    else diffEntity(baseEntry.object, nextEntry.object, mutations, baseEntry.kind);
  }
  for (const [id, nextEntry] of nextIndex) {
    if (baseIndex.has(id)) continue;
    let collection = "";
    let parentId = "";
    if (nextEntry.kind === "player") collection = "players";
    else if (nextEntry.kind === "mappingRow") collection = "mappingRows";
    else if (nextEntry.kind === "registrationRow") collection = "registrationRows";
    else if (["scoreRow", "pending", "manualPending", "completedItem"].includes(nextEntry.kind)) {
      collection = { scoreRow: "scoreRows", pending: "pending", manualPending: "manualPending", completedItem: "completedItems" }[nextEntry.kind];
      parentId = nextEntry.parent.entityId;
    } else continue;
    mutations.push({ op: "add", collection, parentId, expectedParentRevision: nextEntry.parent && nextEntry.parent.entityRevision, value: nextEntry.object });
  }
  return { base, next, mutations };
}

module.exports = {
  CommandError,
  ROOT_DOMAIN_FIELDS,
  applyCommand,
  clone,
  diffState,
  entityIndex,
  equal,
  migrateState,
  publicEntity,
  stableId,
};
