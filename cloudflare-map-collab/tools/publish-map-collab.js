#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = parseArgs(process.argv.slice(2));
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const statePath = path.resolve(args.state || path.join(repoRoot, "tournament_arrangement", "recovered", "data", "checkin-state.json"));
const endpoint = String(args.endpoint || "").replace(/\/+$/, "");
const id = args.id || "";
const title = args.title || "";

if (!endpoint) {
  fail("Missing --endpoint, for example --endpoint https://onlicheck-map.pages.dev");
}

const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const mapping = state.ftdPlayerAccountMapping;
if (!mapping || !Array.isArray(mapping.players) || !mapping.players.length) {
  fail(`No ftdPlayerAccountMapping found in ${statePath}`);
}
const mappingWithNicks = {
  ...mapping,
  wechatGroupNicks: state.wechatGroupNicks || mapping.wechatGroupNicks || null,
};
const sanitizedMapping = sanitizeMappingForSync(mappingWithNicks);

const body = {
  id: id || deriveId(sanitizedMapping),
  title: title || `${sanitizedMapping.groupName || sanitizedMapping.group || "FTD/OQ"} 映射表`,
  mapping: sanitizedMapping,
};

const response = await fetch(`${endpoint}/api/tables`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const json = await response.json().catch(() => null);
if (!response.ok || !json || json.ok !== true) {
  fail(`Publish failed: ${response.status} ${JSON.stringify(json)}`);
}

console.log(JSON.stringify({
  ok: true,
  id: json.id,
  revision: json.revision,
  editLink: json.links.edit,
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

function deriveId(mapping) {
  const targetId = mapping.target && mapping.target.id ? String(mapping.target.id) : "";
  const pageMatch = String(mapping.ftdPageUrl || "").match(/\/live\/(\d+)/);
  const tournament = targetId || (pageMatch && pageMatch[1]) || "map";
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `${tournament}-${date}`;
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

function fail(message) {
  console.error(message);
  process.exit(1);
}
