#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const STATE_COMMANDS = require(path.join(repoRoot, "tournament_arrangement", "recovered", "state-commands.js"));
const defaultStatePath = path.join(repoRoot, "tournament_arrangement", "recovered", "data", "checkin-state.json");
const defaultConfigPath = path.join(repoRoot, "cloudflare-map-collab", "map-collab.config.json");
const args = parseArgs(process.argv.slice(2));
const action = args._[0] || "";
const config = loadConfig(args.config || defaultConfigPath);
const statePath = path.resolve(args.state || defaultStatePath);
const localApi = String(args["local-api"] || "http://127.0.0.1:4174/api/state").replace(/\/+$/, "");

if (!config.enabled && !args.force) {
  console.log(JSON.stringify({ ok: true, skipped: true, reason: "map collab sync disabled" }, null, 2));
  process.exit(0);
}

if (!action) fail("Missing action: publish-current, pull-to-local, or push-nicks");

if (action === "publish-current") {
  const state = readStateFile(statePath);
  const mapping = mappingWithNicks(state);
  const existing = await getRemote(false);
  if (existing.ok) {
    const updated = await putRemote(existing.revision, mapping, "local-publish-current");
    printSummary(updated, "updated");
  } else if (existing.status === 404) {
    const created = await createRemote(mapping);
    printSummary(created, "created");
  } else {
    fail(`Remote read failed: ${JSON.stringify(existing)}`);
  }
} else if (action === "pull-to-local") {
  const remote = await getRemote(true);
  if (!remote.ok) fail(`Remote pull failed: ${JSON.stringify(remote)}`);
  await writeStateViaLocalApi(mappingWithRemoteMeta(remote));
  printSummary(remote, "pulled");
} else if (action === "push-nicks") {
  const state = readStateFile(statePath);
  const remote = await getRemote(true);
  if (!remote.ok) fail(`Remote read failed: ${JSON.stringify(remote)}`);
  const wechatGroupNicks = state.wechatGroupNicks || null;
  assertHasWechatGroupNicks(wechatGroupNicks, "push-nicks");
  const mapping = {
    ...remote.mapping,
    wechatGroupNicks,
    registrationRelay: state.ftdPlayerAccountMapping?.registrationRelay || remote.mapping?.registrationRelay || null,
  };
  const updated = await putRemote(remote.revision, mapping, "local-push-nicks");
  printSummary(updated, "nicks-pushed");
} else {
  fail(`Unknown action: ${action}`);
}

function mappingWithRemoteMeta(remote) {
  const mapping = remote && remote.mapping && typeof remote.mapping === "object"
    ? remote.mapping
    : {};
  return {
    ...mapping,
    remoteSync: {
      endpoint: String(config.endpoint || "").replace(/\/+$/, ""),
      tableId: remote.id || config.tableId,
      revision: Number(remote.revision) || 0,
      pulledAt: new Date().toISOString(),
    },
  };
}

function parseArgs(items) {
  const out = { _: [] };
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item.startsWith("--")) {
      out._.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = items[i + 1];
    if (!next || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function loadConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    return {
      enabled: false,
      endpoint: "",
      tableId: "",
      editToken: "",
      title: "",
    };
  }
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function remoteBase() {
  const endpoint = String(config.endpoint || "").replace(/\/+$/, "");
  if (!endpoint || !config.tableId) fail("Cloud map config requires endpoint and tableId");
  return `${endpoint}/api/tables/${encodeURIComponent(config.tableId)}`;
}

function remoteToken(requireEdit) {
  const token = config.editToken;
  if (!token) fail("Cloud map config requires editToken");
  return token;
}

async function getRemote(requireToken) {
  const token = remoteToken(false);
  const res = await fetch(`${remoteBase()}?token=${encodeURIComponent(token)}`);
  const json = await res.json().catch(() => null);
  if (!json) return { ok: false, status: res.status, error: "non-json response" };
  return { ...json, status: res.status };
}

async function createRemote(mapping) {
  const endpoint = String(config.endpoint || "").replace(/\/+$/, "");
  const res = await fetch(`${endpoint}/api/tables`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: config.tableId,
      title: titleForMapping(mapping),
      mapping,
    }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.ok !== true) fail(`Remote create failed: HTTP ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function putRemote(revision, mapping, actionName) {
  const token = remoteToken(true);
  const res = await fetch(`${remoteBase()}?token=${encodeURIComponent(token)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      revision,
      title: titleForMapping(mapping),
      mapping,
      action: actionName,
    }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.ok !== true) fail(`Remote update failed: HTTP ${res.status} ${JSON.stringify(json)}`);
  return json;
}

function readStateFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function mappingWithNicks(state) {
  const mapping = state.ftdPlayerAccountMapping;
  if (!mapping || !Array.isArray(mapping.players) || !mapping.players.length) {
    fail(`No ftdPlayerAccountMapping found in ${statePath}`);
  }
  const wechatGroupNicks = state.wechatGroupNicks || mapping.wechatGroupNicks || null;
  assertHasWechatGroupNicks(wechatGroupNicks, "publish-current");
  return sanitizeMappingForSync({
    ...mapping,
    wechatGroupNicks,
  });
}

function titleForMapping(mapping) {
  const relayTitle = String(mapping?.registrationRelay?.mappingTitle || "").replace(/\s+/g, " ").trim();
  if (relayTitle) return relayTitle;
  const relayName = String(mapping?.registrationRelay?.competitionName || "").replace(/\s+/g, " ").trim();
  if (relayName) return `${relayName} 映射表`;
  const configTitle = String(config.title || "").replace(/\s+/g, " ").trim();
  if (configTitle) return configTitle;
  return `${mapping.groupName || mapping.group || "FTD/OQ"} 映射表`;
}

function assertHasWechatGroupNicks(wechatGroupNicks, actionName) {
  const count = Array.isArray(wechatGroupNicks?.groupNicks)
    ? wechatGroupNicks.groupNicks.filter((nick) => String(nick || "").trim()).length
    : 0;
  if (count <= 0) {
    fail(`${actionName} requires a non-empty wechatGroupNicks.groupNicks list; refresh the WeChat nickname map before syncing`);
  }
}

function sanitizeMappingForSync(mapping) {
  if (!mapping || typeof mapping !== "object") return mapping;
  const players = Array.isArray(mapping.players)
    ? mapping.players
      .map((row) => {
        if (!row || typeof row !== "object") return null;
        const clean = { ...row };
        if (String(row.status || "").trim() === "deleted") clean.deleted = true;
        delete clean.status;
        return clean;
      })
      .filter(Boolean)
    : [];
  return { ...mapping, players, registrationRelay: sanitizeRegistrationRelay(mapping.registrationRelay) };
}

function sanitizeRegistrationRelay(raw) {
  if (!raw || typeof raw !== "object") return null;
  const entries = Array.isArray(raw.entries)
    ? raw.entries
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        return {
          index: Number.isFinite(Number(item.index)) ? Math.trunc(Number(item.index)) : "",
          name: String(item.name || "").replace(/\s+/g, " ").trim(),
          account: String(item.account || "").replace(/\s+/g, " ").trim(),
          rawLine: String(item.rawLine || "").replace(/\s+/g, " ").trim(),
        };
      })
      .filter((item) => item && item.name && item.account)
      .slice(0, 300)
    : [];
  const ignored = Array.isArray(raw.ignored)
    ? raw.ignored
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        return {
          index: Number.isFinite(Number(item.index)) ? Math.trunc(Number(item.index)) : "",
          line: String(item.line || "").replace(/\s+/g, " ").trim(),
          reason: String(item.reason || "").replace(/\s+/g, " ").trim(),
        };
      })
      .filter((item) => item && item.line)
      .slice(0, 120)
    : [];
  return {
    version: 1,
    source: String(raw.source || "frontend-state relayText").replace(/\s+/g, " ").trim(),
    checkedAt: String(raw.checkedAt || ""),
    currentMonth: Number.isFinite(Number(raw.currentMonth)) ? Math.trunc(Number(raw.currentMonth)) : "",
    detectedMonths: Array.isArray(raw.detectedMonths)
      ? raw.detectedMonths.map((value) => Math.trunc(Number(value))).filter((value) => value >= 1 && value <= 12)
      : [],
    monthMatched: raw.monthMatched === true,
    titleLine: String(raw.titleLine || ""),
    competitionName: String(raw.competitionName || "").replace(/\s+/g, " ").trim(),
    mappingTitle: String(raw.mappingTitle || "").replace(/\s+/g, " ").trim(),
    entryCount: entries.length,
    ignoredCount: ignored.length,
    entries,
    ignored,
    rawText: String(raw.rawText || ""),
  };
}

async function writeStateViaLocalApi(mapping) {
  const currentResponse = await fetch(localApi);
  const current = await currentResponse.json().catch(() => null);
  if (!currentResponse.ok || !current || current.ok !== true || !current.state) {
    throw new Error(`Local sync API unavailable: HTTP ${currentResponse.status}`);
  }
  const nextState = {
    ...current.state,
    ftdPlayerAccountMapping: sanitizeMappingForSync(mapping),
    savedAt: Date.now(),
    localSync: {
      ...(current.state.localSync || {}),
      source: "map-collab-overwrite-local",
      baseRevision: current.revision,
      savedAt: Date.now(),
    },
  };
  const diff = STATE_COMMANDS.diffState(current.state, nextState);
  const saveResponse = await fetch(`${localApi}/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      commandId: `map-collab-pull-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      type: "entities.mutate",
      actor: "script",
      payload: { mutations: diff.mutations },
    }),
  });
  const saved = await saveResponse.json().catch(() => null);
  if (!saveResponse.ok || !saved || saved.ok !== true) {
    throw new Error(`Local sync write failed: HTTP ${saveResponse.status} ${JSON.stringify(saved)}`);
  }
  const verifyResponse = await fetch(localApi);
  const verified = await verifyResponse.json().catch(() => null);
  const savedMapping = verified && verified.state && verified.state.ftdPlayerAccountMapping;
  const expectedRemote = mapping && mapping.remoteSync;
  const savedRemote = savedMapping && savedMapping.remoteSync;
  if (
    expectedRemote &&
    Number(expectedRemote.revision) &&
    (!savedRemote ||
      String(savedRemote.tableId || "") !== String(expectedRemote.tableId || "") ||
      Number(savedRemote.revision) !== Number(expectedRemote.revision))
  ) {
    throw new Error(
      `Local sync write verification failed: expected remote ${expectedRemote.tableId}@${expectedRemote.revision}, ` +
        `got ${savedRemote ? `${savedRemote.tableId}@${savedRemote.revision}` : "missing remoteSync"}`,
    );
  }
}

function printSummary(data, actionName) {
  const mapping = data.mapping || {};
  console.log(JSON.stringify({
    ok: true,
    action: actionName,
    id: data.id || config.tableId,
    revision: data.revision,
    remoteSync: mapping.remoteSync || (data.id || data.revision ? {
      tableId: data.id || config.tableId,
      revision: data.revision,
    } : undefined),
    playerCount: mapping.playerCount,
    matchedCount: mapping.matchedCount,
    invalidAccountCount: mapping.invalidAccountCount,
    ambiguousCount: mapping.ambiguousCount,
    unmatchedCount: mapping.unmatchedCount,
    groupNickCandidateCount: Array.isArray(mapping.wechatGroupNicks?.groupNicks) ? mapping.wechatGroupNicks.groupNicks.length : 0,
    registrationRelayEntryCount: Array.isArray(mapping.registrationRelay?.entries) ? mapping.registrationRelay.entries.length : 0,
    links: data.links || undefined,
  }, null, 2));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
