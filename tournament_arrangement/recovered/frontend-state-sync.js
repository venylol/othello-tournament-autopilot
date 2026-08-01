(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TournamentStateSync = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const ROOT_DOMAINS = {
    tournament: ["competitionName", "nextPlayerId", "clubText", "relayText", "groupRules"],
    accountMapping: ["accountMapping"],
    wechatGroupNicks: ["wechatGroupNicks"],
    ftdRound: ["ftdRound"],
    egaAnalysis: ["egaAnalysis"],
  };
  const REMOVABLE_ENTITY_KINDS = new Set([
    "player",
    "mappingRow",
    "registrationRow",
    "scoreRow",
    "pending",
    "manualPending",
    "completedItem",
  ]);

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

  function newId(kind) {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return `${kind}:client:${crypto.randomUUID()}`;
    return `${kind}:client:${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function ensureClientIds(state) {
    const ensure = (item, kind) => {
      if (!item || typeof item !== "object") return;
      if (!item.entityId) item.entityId = newId(kind);
      if (!Number.isInteger(Number(item.entityRevision))) item.entityRevision = 0;
    };
    (state.players || []).forEach((item) => ensure(item, "player"));
    const mapping = state.ftdPlayerAccountMapping;
    if (mapping) {
      ensure(mapping, "mapping");
      (mapping.players || []).forEach((item) => ensure(item, "mapping"));
    }
    const registration = state.ftdPlayerRegistration;
    if (registration) {
      ensure(registration, "registration");
      (registration.rows || []).forEach((item) => ensure(item, "registration"));
    }
    const helper = state.scoreHelper;
    if (helper) {
      ensure(helper, "scoreHelper");
      (helper.rounds || []).forEach((round) => {
        ensure(round, "round");
        (round.ftdPairings || []).forEach((item) => ensure(item, "score"));
        (round.pending || []).forEach((item) => ensure(item, "pending"));
        (round.manualPending || []).forEach((item) => ensure(item, "manualPending"));
        (round.completed || []).forEach((item) => ensure(item, "completedItem"));
      });
    }
    return state;
  }

  function indexEntities(state) {
    const index = new Map();
    const add = (kind, object, parent, field, position) => {
      if (object && object.entityId) index.set(object.entityId, { kind, object, parent, field, position });
    };
    (state.players || []).forEach((row, i) => add("player", row, state, "players", i));
    const mapping = state.ftdPlayerAccountMapping;
    if (mapping) {
      add("mappingMetadata", mapping, state, "ftdPlayerAccountMapping", -1);
      (mapping.players || []).forEach((row, i) => add("mappingRow", row, mapping, "players", i));
    }
    const registration = state.ftdPlayerRegistration;
    if (registration) {
      add("registrationMetadata", registration, state, "ftdPlayerRegistration", -1);
      (registration.rows || []).forEach((row, i) => add("registrationRow", row, registration, "rows", i));
    }
    const helper = state.scoreHelper;
    if (helper) {
      add("scoreHelperMetadata", helper, state, "scoreHelper", -1);
      (helper.rounds || []).forEach((round, roundIndex) => {
        add("round", round, helper, "rounds", roundIndex);
        for (const [field, kind] of [["ftdPairings", "scoreRow"], ["pending", "pending"], ["manualPending", "manualPending"], ["completed", "completedItem"]]) {
          (round[field] || []).forEach((row, i) => add(kind, row, round, field, i));
        }
      });
    }
    return index;
  }

  function projection(value, kind) {
    const next = { ...value };
    delete next.entityId;
    delete next.entityRevision;
    if (kind === "mappingMetadata") delete next.players;
    else if (kind === "registrationMetadata") delete next.rows;
    else if (kind === "scoreHelperMetadata") {
      delete next.rounds;
      delete next.activeRound;
    } else if (kind === "round") {
      delete next.ftdPairings;
      delete next.pending;
      delete next.manualPending;
      delete next.completed;
    }
    return next;
  }

  function buildMutations(baseState, workingState) {
    const base = clone(baseState);
    const working = ensureClientIds(workingState);
    const mutations = [];
    for (const [domain, fields] of Object.entries(ROOT_DOMAINS)) {
      const set = {};
      for (const field of fields) if (!equal(base[field], working[field])) set[field] = clone(working[field]);
      if (Object.keys(set).length) mutations.push({
        op: "patchDomain",
        target: { kind: "domain", id: `domain:${domain}` },
        expectedRevision: Number(base.localSync && base.localSync.domains && base.localSync.domains[domain] && base.localSync.domains[domain].entityRevision) || 0,
        set,
      });
    }
    const before = indexEntities(base);
    const after = indexEntities(working);
    const clearedRegistrationId = (() => {
      const oldRegistration = base.ftdPlayerRegistration;
      const newRegistration = working.ftdPlayerRegistration;
      if (
        !oldRegistration ||
        !newRegistration ||
        oldRegistration.entityId !== newRegistration.entityId ||
        !Array.isArray(oldRegistration.rows) ||
        oldRegistration.rows.length === 0 ||
        !Array.isArray(newRegistration.rows) ||
        newRegistration.rows.length !== 0
      ) return "";
      const oldValue = projection(oldRegistration, "registrationMetadata");
      const newValue = projection(newRegistration, "registrationMetadata");
      mutations.push({
        op: "clearChildren",
        collection: "rows",
        target: { kind: "registrationMetadata", id: oldRegistration.entityId },
        expectedRevision: oldRegistration.entityRevision,
        set: newValue,
        unset: Object.keys(oldValue).filter((key) => !Object.prototype.hasOwnProperty.call(newValue, key)),
      });
      return oldRegistration.entityId;
    })();
    for (const [id, entry] of before) {
      const current = after.get(id);
      if (!current) {
        if (clearedRegistrationId && entry.kind === "registrationRow" && entry.parent && entry.parent.entityId === clearedRegistrationId) continue;
        const parentId = entry.parent && entry.parent.entityId;
        const parentStillExists = !parentId || after.has(parentId);
        if (REMOVABLE_ENTITY_KINDS.has(entry.kind) && parentStillExists) {
          mutations.push({ op: "remove", target: { kind: entry.kind, id }, expectedRevision: entry.object.entityRevision });
        }
        continue;
      }
      if (clearedRegistrationId && entry.kind === "registrationMetadata" && id === clearedRegistrationId) continue;
      const oldValue = projection(entry.object, entry.kind);
      const newValue = projection(current.object, entry.kind);
      if (!equal(oldValue, newValue)) mutations.push({
        op: "patch",
        target: { kind: entry.kind, id },
        expectedRevision: entry.object.entityRevision,
        set: newValue,
        unset: Object.keys(oldValue).filter((key) => !Object.prototype.hasOwnProperty.call(newValue, key)),
      });
    }
    for (const [id, entry] of after) {
      if (before.has(id)) continue;
      let collection = "";
      let parentId = "";
      if (entry.kind === "player") collection = "players";
      else if (entry.kind === "mappingRow") collection = "mappingRows";
      else if (entry.kind === "registrationRow") collection = "registrationRows";
      else if (["scoreRow", "pending", "manualPending", "completedItem"].includes(entry.kind)) {
        collection = { scoreRow: "scoreRows", pending: "pending", manualPending: "manualPending", completedItem: "completedItems" }[entry.kind];
        parentId = entry.parent.entityId;
      } else continue;
      mutations.push({
        op: "add",
        collection,
        parentId,
        ...(entry.parent && entry.parent.entityId ? { expectedParentRevision: entry.parent.entityRevision } : {}),
        value: clone(entry.object),
      });
    }
    return mutations;
  }

  function applyChangedEntities(state, changedEntities, options) {
    const blockedId = options && options.blockedEntityId;
    const conflicts = [];
    const applied = [];
    for (const change of Array.isArray(changedEntities) ? changedEntities : []) {
      if (!change || !change.id) continue;
      if (change.kind === "domain") {
        Object.assign(state, clone(change.entity || {}));
        const domainName = String(change.id).replace(/^domain:/, "");
        if (state.localSync && state.localSync.domains && state.localSync.domains[domainName]) {
          state.localSync.domains[domainName].entityRevision = Number(change.revision) || 0;
        }
        applied.push(change.id);
        continue;
      }
      const index = indexEntities(state);
      const entry = index.get(change.id);
      if (blockedId && blockedId === change.id) {
        conflicts.push(change);
        continue;
      }
      if (change.removed) {
        if (entry && Array.isArray(entry.parent && entry.parent[entry.field])) entry.parent[entry.field].splice(entry.position, 1);
        applied.push(change.id);
        continue;
      }
      if (!entry && change.entity) {
        const value = clone(change.entity);
        if (change.collection === "players") state.players.push(value);
        else if (change.collection === "mappingRows" && state.ftdPlayerAccountMapping) state.ftdPlayerAccountMapping.players.push(value);
        else if (change.collection === "registrationRows" && state.ftdPlayerRegistration) state.ftdPlayerRegistration.rows.push(value);
        else if (change.collection === "rounds" && state.scoreHelper) state.scoreHelper.rounds.push(value);
        else if (change.parentId) {
          const parentEntry = index.get(change.parentId);
          const field = { scoreRows: "ftdPairings", pending: "pending", manualPending: "manualPending", completedItems: "completed" }[change.collection];
          if (parentEntry && field) {
            if (!Array.isArray(parentEntry.object[field])) parentEntry.object[field] = [];
            parentEntry.object[field].push(value);
          }
        }
        applied.push(change.id);
        continue;
      }
      if (!entry || !change.entity) continue;
      const value = clone(change.entity);
      if (["mappingMetadata", "registrationMetadata", "scoreHelperMetadata", "round"].includes(entry.kind)) {
        const merged = { ...entry.object, ...value };
        if (entry.kind === "mappingMetadata") merged.players = entry.object.players;
        else if (entry.kind === "registrationMetadata") {
          merged.rows = Array.isArray(change.clearedCollections) && change.clearedCollections.includes("rows")
            ? []
            : entry.object.rows;
        }
        else if (entry.kind === "scoreHelperMetadata") {
          merged.rounds = entry.object.rounds;
          merged.activeRound = entry.object.activeRound;
        } else if (entry.kind === "round") {
          merged.ftdPairings = entry.object.ftdPairings;
          merged.pending = entry.object.pending;
          merged.manualPending = entry.object.manualPending;
          merged.completed = entry.object.completed;
        }
        if (Array.isArray(entry.parent && entry.parent[entry.field])) entry.parent[entry.field][entry.position] = merged;
        else entry.parent[entry.field] = merged;
      } else if (Array.isArray(entry.parent && entry.parent[entry.field])) entry.parent[entry.field][entry.position] = value;
      else entry.parent[entry.field] = value;
      applied.push(change.id);
    }
    if (state.scoreHelper && Array.isArray(state.scoreHelper.rounds)) {
      state.scoreHelper.rounds.sort((left, right) => Number(left && left.round) - Number(right && right.round));
    }
    return { state, applied, conflicts };
  }

  function rebaseRegistrationMetadataConflict(baseState, workingState, authoritative) {
    if (!authoritative || authoritative.kind !== "registrationMetadata" || !authoritative.entity) return null;
    const local = workingState && workingState.ftdPlayerRegistration;
    const remote = authoritative.entity;
    if (!local || !baseState || !baseState.ftdPlayerRegistration) return null;
    if (String(local.entityId || "") !== String(authoritative.id || "")) return null;
    const localResolver = String(local.resolverBatchId || "");
    const remoteResolver = String(remote.resolverBatchId || "");
    const localBatch = String(local.pendingBatch && local.pendingBatch.batchId || "");
    const remoteBatch = String(remote.pendingBatch && remote.pendingBatch.batchId || "");
    if (localResolver && remoteResolver && localResolver !== remoteResolver) return null;
    if (localBatch && remoteBatch && localBatch !== remoteBatch) return null;
    applyChangedEntities(baseState, [{
      kind: authoritative.kind,
      id: authoritative.id,
      revision: authoritative.revision,
      entity: authoritative.entity,
    }]);
    return buildMutations(baseState, workingState);
  }

  return {
    applyChangedEntities,
    buildMutations,
    clone,
    ensureClientIds,
    equal,
    indexEntities,
    rebaseRegistrationMetadataConflict,
  };
});
