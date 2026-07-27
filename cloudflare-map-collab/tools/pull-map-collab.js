#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = parseArgs(process.argv.slice(2));
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const statePath = path.resolve(args.state || path.join(repoRoot, "tournament_arrangement", "recovered", "data", "checkin-state.json"));
const urlArg = String(args.url || "");
const tokenArg = String(args.token || "");
const tableIdArg = String(args.id || "");
const endpointArg = String(args.endpoint || "").replace(/\/+$/, "");
const output = args.output ? path.resolve(args.output) : "";
const writeState = Boolean(args["write-state"]);
const directFile = Boolean(args["direct-file"]);
const localApi = String(args["local-api"] || "http://127.0.0.1:4174/api/state").replace(/\/+$/, "");

const parsed = parseRemote(urlArg, endpointArg, tableIdArg, tokenArg);
if (!parsed.endpoint || !parsed.id || !parsed.token) {
  fail("Missing remote details. Use --url <edit-or-view-link>, or --endpoint + --id + --token.");
}

const response = await fetch(`${parsed.endpoint}/api/tables/${encodeURIComponent(parsed.id)}?token=${encodeURIComponent(parsed.token)}`);
const json = await response.json().catch(() => null);
if (!response.ok || !json || json.ok !== true) {
  fail(`Pull failed: ${response.status} ${JSON.stringify(json)}`);
}

const pulledMapping = sanitizeMappingForSync(json.mapping);

if (output) {
  fs.writeFileSync(output, JSON.stringify(pulledMapping, null, 2), "utf8");
}

if (writeState) {
  if (directFile) {
    writeStateFile(statePath, pulledMapping);
  } else {
    await writeStateViaLocalApi(localApi, pulledMapping);
  }
}

console.log(JSON.stringify({
  ok: true,
  id: json.id,
  revision: json.revision,
  mode: json.mode,
  playerCount: pulledMapping.playerCount,
  matchedCount: pulledMapping.matchedCount,
  invalidAccountCount: pulledMapping.invalidAccountCount,
  unmatchedCount: pulledMapping.unmatchedCount,
  output: output || "",
  stateWritten: writeState ? (directFile ? statePath : localApi) : "",
}, null, 2));

function parseArgs(items) {
  const out = {};
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = items[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function parseRemote(urlText, endpoint, id, token) {
  if (!urlText) return { endpoint, id, token };
  const url = new URL(urlText);
  const match = url.pathname.match(/^\/m\/([^/]+)/);
  return {
    endpoint: `${url.protocol}//${url.host}`,
    id: match ? decodeURIComponent(match[1]) : id,
    token: url.searchParams.get("token") || token,
  };
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
  return { ...mapping, players };
}

async function writeStateViaLocalApi(localApi, mapping) {
  const currentResponse = await fetch(localApi);
  const current = await currentResponse.json().catch(() => null);
  if (!currentResponse.ok || !current || current.ok !== true || !current.state) {
    throw new Error(`Local sync API unavailable: HTTP ${currentResponse.status}`);
  }
  const nextState = {
    ...current.state,
    ftdPlayerAccountMapping: mapping,
    savedAt: Date.now(),
    localSync: {
      ...(current.state.localSync || {}),
      source: "map-collab-pull",
      baseRevision: current.revision,
      savedAt: Date.now(),
    },
  };
  const saveResponse = await fetch(localApi, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      baseRevision: current.revision,
      state: nextState,
      source: "map-collab-pull",
    }),
  });
  const saved = await saveResponse.json().catch(() => null);
  if (!saveResponse.ok || !saved || saved.ok !== true) {
    throw new Error(`Local sync write failed: HTTP ${saveResponse.status} ${JSON.stringify(saved)}`);
  }
}

function writeStateFile(statePath, mapping) {
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.ftdPlayerAccountMapping = mapping;
  state.savedAt = Date.now();
  state.localSync = {
    ...(state.localSync || {}),
    source: "map-collab-pull",
    savedAt: Date.now(),
  };
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
