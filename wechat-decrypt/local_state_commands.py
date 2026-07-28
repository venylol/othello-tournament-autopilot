"""Entity-command client for the local tournament state server."""

from __future__ import annotations

import copy
import json
import time
import urllib.error
import urllib.request
import uuid
from typing import Any


ROOT_DOMAINS = {
    "tournament": ("competitionName", "nextPlayerId", "clubText", "relayText", "groupRules"),
    "accountMapping": ("accountMapping",),
    "wechatGroupNicks": ("wechatGroupNicks",),
    "ftdRound": ("ftdRound",),
    "egaAnalysis": ("egaAnalysis",),
}


class StateCommandConflict(RuntimeError):
    def __init__(self, payload: dict[str, Any]):
        super().__init__(str(payload.get("error") or "state entity changed"))
        self.payload = payload


def _same(left: Any, right: Any) -> bool:
    return json.dumps(left, ensure_ascii=False, sort_keys=True, separators=(",", ":")) == json.dumps(
        right, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )


def _projection(value: dict[str, Any], kind: str) -> dict[str, Any]:
    result = copy.deepcopy(value)
    result.pop("entityId", None)
    result.pop("entityRevision", None)
    if kind == "mappingMetadata":
        result.pop("players", None)
    elif kind == "registrationMetadata":
        result.pop("rows", None)
    elif kind == "scoreHelperMetadata":
        result.pop("rounds", None)
        result.pop("activeRound", None)
    elif kind == "round":
        for field in ("ftdPairings", "pending", "manualPending", "completed"):
            result.pop(field, None)
    return result


def _index(state: dict[str, Any]) -> dict[str, tuple[str, dict[str, Any], dict[str, Any] | None]]:
    result: dict[str, tuple[str, dict[str, Any], dict[str, Any] | None]] = {}

    def add(kind: str, item: Any, parent: dict[str, Any] | None = None) -> None:
        if not isinstance(item, dict) or not item.get("entityId"):
            return
        result[str(item["entityId"])] = (kind, item, parent)

    for row in state.get("players") or []:
        add("player", row, state)
    mapping = state.get("ftdPlayerAccountMapping")
    if isinstance(mapping, dict):
        add("mappingMetadata", mapping, state)
        for row in mapping.get("players") or []:
            add("mappingRow", row, mapping)
    registration = state.get("ftdPlayerRegistration")
    if isinstance(registration, dict):
        add("registrationMetadata", registration, state)
        for row in registration.get("rows") or []:
            add("registrationRow", row, registration)
    helper = state.get("scoreHelper")
    if isinstance(helper, dict):
        add("scoreHelperMetadata", helper, state)
        for round_state in helper.get("rounds") or []:
            add("round", round_state, helper)
            for field, kind in (
                ("ftdPairings", "scoreRow"),
                ("pending", "pending"),
                ("manualPending", "manualPending"),
                ("completed", "completedItem"),
            ):
                for row in round_state.get(field) or []:
                    add(kind, row, round_state)
    return result


def build_mutations(base: dict[str, Any], working: dict[str, Any]) -> list[dict[str, Any]]:
    mutations: list[dict[str, Any]] = []
    domains = ((base.get("localSync") or {}).get("domains") or {})
    for domain, fields in ROOT_DOMAINS.items():
        changed = {field: copy.deepcopy(working.get(field)) for field in fields if not _same(base.get(field), working.get(field))}
        if changed:
            mutations.append({
                "op": "patchDomain",
                "target": {"kind": "domain", "id": f"domain:{domain}"},
                "expectedRevision": int((domains.get(domain) or {}).get("entityRevision") or 0),
                "set": changed,
            })

    before = _index(base)
    after = _index(working)
    for entity_id, (kind, old, _parent) in before.items():
        current = after.get(entity_id)
        if current is None:
            mutations.append({"op": "remove", "target": {"kind": kind, "id": entity_id}, "expectedRevision": int(old.get("entityRevision") or 0)})
            continue
        new_value = current[1]
        old_projection = _projection(old, kind)
        new_projection = _projection(new_value, kind)
        if not _same(old_projection, new_projection):
            mutations.append({
                "op": "patch",
                "target": {"kind": kind, "id": entity_id},
                "expectedRevision": int(old.get("entityRevision") or 0),
                "set": new_projection,
                "unset": [key for key in old_projection if key not in new_projection],
            })

    for entity_id, (kind, value, parent) in after.items():
        if entity_id in before:
            continue
        collection = ""
        parent_id = ""
        if kind == "player":
            collection = "players"
        elif kind == "mappingRow":
            collection = "mappingRows"
        elif kind == "registrationRow":
            collection = "registrationRows"
        elif kind in {"scoreRow", "pending", "manualPending", "completedItem"}:
            collection = {
                "scoreRow": "scoreRows",
                "pending": "pending",
                "manualPending": "manualPending",
                "completedItem": "completedItems",
            }[kind]
            parent_id = str((parent or {}).get("entityId") or "")
        else:
            continue
        if not value.get("entityId"):
            value["entityId"] = f"{kind}:client:{uuid.uuid4()}"
        mutation = {"op": "add", "collection": collection, "parentId": parent_id, "value": copy.deepcopy(value)}
        if isinstance(parent, dict) and parent.get("entityId"):
            mutation["expectedParentRevision"] = int(parent.get("entityRevision") or 0)
        mutations.append(mutation)
    return mutations


def command_url(state_api: str) -> str:
    return state_api.rstrip("/") + "/commands"


def submit_diff(
    state_api: str,
    base: dict[str, Any],
    working: dict[str, Any],
    *,
    actor: str,
    source: str,
    timeout: float = 8,
) -> dict[str, Any]:
    mutations = build_mutations(base, working)
    if not mutations:
        return {"ok": True, "changed": False, "revision": int((base.get("localSync") or {}).get("revision") or 0), "changedEntities": []}
    body = json.dumps({
        "commandId": f"{source}-{int(time.time() * 1000)}-{uuid.uuid4().hex}",
        "type": "entities.mutate",
        "actor": actor,
        "payload": {"mutations": mutations},
    }, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(command_url(state_api), data=body, headers={"Content-Type": "application/json; charset=utf-8"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            payload = json.loads(exc.read().decode("utf-8"))
        except Exception:
            payload = {"error": f"HTTP {exc.code}"}
        if exc.code == 409:
            raise StateCommandConflict(payload) from exc
        raise RuntimeError(str(payload.get("error") or f"HTTP {exc.code}")) from exc
    if payload.get("ok") is not True:
        raise RuntimeError(str(payload.get("error") or "state command failed"))
    return payload
