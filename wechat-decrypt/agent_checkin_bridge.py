#!/usr/bin/env python3
"""Agent-facing WeChat check-in bridge.

This script is intentionally conservative:
- `refresh-map` reads the target group's cached member nickname map and writes it
  to a local JSON cache.
- `history` reads chat messages only through the cached map. It rewrites message
  senders to group nicknames before output. If any message sender cannot be
  mapped, it fails instead of guessing.

The normal history path never refreshes the member map implicitly. Refreshing is
an explicit startup/manual step run by the agent or by user request.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
from contextlib import closing
from datetime import datetime
from pathlib import Path
from typing import Any

import mcp_server


ROOT = Path(__file__).resolve().parent
CACHE_DIR = ROOT / "agent_cache"
DEFAULT_GROUP_TEMPLATE = "【{month}月无差别组】栢龙杯棋王赛"
MAP_SCHEMA_VERSION = 1


class BridgeError(RuntimeError):
    pass


def default_group_name(now: datetime | None = None) -> str:
    now = now or datetime.now()
    return DEFAULT_GROUP_TEMPLATE.format(month=now.month)


def normalize_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").replace("\ufeff", "")).strip()


def safe_filename(value: str) -> str:
    text = normalize_text(value) or "wechat-group"
    text = re.sub(r'[\\/:*?"<>|]+', "_", text)
    text = re.sub(r"\s+", "_", text)
    return text[:120] or "wechat-group"


def cache_path_for_group(group_name: str) -> Path:
    return CACHE_DIR / f"{safe_filename(group_name)}.member-map.json"


def contact_db_path() -> str:
    path = mcp_server._get_contact_db_path()
    if not path or not os.path.exists(path):
        raise BridgeError("无法找到已解密 contact.db；请先完成微信数据库解密/刷新。")
    return path


def group_display_name(row: sqlite3.Row) -> str:
    return normalize_text(row["remark"] or row["nick_name"] or row["username"])


def list_groups() -> list[dict[str, Any]]:
    db_path = contact_db_path()
    with closing(sqlite3.connect(db_path)) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT c.id, c.username, c.local_type, c.remark, c.nick_name
            FROM contact c
            WHERE c.username LIKE '%@chatroom%' OR c.local_type = 2
            ORDER BY c.id
            """
        ).fetchall()
    groups = []
    for row in rows:
        username = normalize_text(row["username"])
        if "@chatroom" not in username:
            continue
        groups.append(
            {
                "room_id": int(row["id"]),
                "username": username,
                "display_name": group_display_name(row),
                "remark": normalize_text(row["remark"]),
                "nick_name": normalize_text(row["nick_name"]),
            }
        )
    return groups


def resolve_group_strict(group_name: str) -> dict[str, Any]:
    query = normalize_text(group_name)
    if not query:
        raise BridgeError("群名不能为空。")

    groups = list_groups()
    if "@chatroom" in query:
        exact_user = [g for g in groups if g["username"] == query]
        if len(exact_user) == 1:
            return exact_user[0]
        raise BridgeError(f"找不到群 username: {query}")

    exact = [g for g in groups if g["display_name"] == query]
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        raise BridgeError(
            "群名精确匹配到多个会话，请改用 @chatroom username：\n"
            + "\n".join(f"- {g['display_name']} ({g['username']})" for g in exact)
        )

    fuzzy = [g for g in groups if query in g["display_name"]]
    if len(fuzzy) == 1:
        return fuzzy[0]
    if len(fuzzy) > 1:
        raise BridgeError(
            "群名模糊匹配到多个会话，不能静默选择。请指定更完整群名或 @chatroom username：\n"
            + "\n".join(f"- {g['display_name']} ({g['username']})" for g in fuzzy)
        )

    raise BridgeError(f"找不到群聊：{query}")


def read_varint(data: bytes, pos: int) -> tuple[int, int]:
    value = 0
    shift = 0
    start = pos
    while pos < len(data):
        b = data[pos]
        pos += 1
        value |= (b & 0x7F) << shift
        if not (b & 0x80):
            return value, pos
        shift += 7
        if shift > 63:
            break
    raise BridgeError(f"protobuf varint 解析失败，offset={start}")


def iter_protobuf_fields(data: bytes):
    pos = 0
    n = len(data)
    while pos < n:
        tag, pos = read_varint(data, pos)
        field_no = tag >> 3
        wire_type = tag & 0x07
        if field_no <= 0:
            raise BridgeError(f"protobuf 字段号异常: {field_no}")

        if wire_type == 0:
            value, pos = read_varint(data, pos)
            yield field_no, wire_type, value
        elif wire_type == 1:
            if pos + 8 > n:
                raise BridgeError("protobuf fixed64 越界")
            yield field_no, wire_type, data[pos : pos + 8]
            pos += 8
        elif wire_type == 2:
            length, pos = read_varint(data, pos)
            if length < 0 or pos + length > n:
                raise BridgeError("protobuf length-delimited 越界")
            yield field_no, wire_type, data[pos : pos + length]
            pos += length
        elif wire_type == 5:
            if pos + 4 > n:
                raise BridgeError("protobuf fixed32 越界")
            yield field_no, wire_type, data[pos : pos + 4]
            pos += 4
        else:
            raise BridgeError(f"不支持的 protobuf wire type: {wire_type}")


def decode_utf8(value: Any) -> str:
    if not isinstance(value, (bytes, bytearray)):
        return ""
    try:
        return bytes(value).decode("utf-8").strip()
    except UnicodeDecodeError:
        return ""


def looks_like_wechat_username(value: str) -> bool:
    s = normalize_text(value)
    if not s:
        return False
    if "@chatroom" in s:
        return True
    if s.startswith(("wxid_", "gh_")):
        return True
    return bool(re.fullmatch(r"[A-Za-z0-9_.\-]{5,64}", s))


def parse_member_records_from_ext_buffer(ext_buffer: bytes) -> list[dict[str, str]]:
    """Parse chat_room.ext_buffer as repeated member records.

    Observed record shape:
      top-level field 1 => submessage
      submessage field 1 => member username
      submessage field 2 => group nickname

    The parser accepts only this explicit record shape.
    """
    records = []
    for field_no, wire_type, value in iter_protobuf_fields(ext_buffer or b""):
        if field_no != 1 or wire_type != 2 or not isinstance(value, bytes):
            continue

        username = ""
        group_nick = ""
        try:
            for sub_no, sub_wire, sub_val in iter_protobuf_fields(value):
                if sub_wire != 2:
                    continue
                text = decode_utf8(sub_val)
                if sub_no == 1:
                    username = text
                elif sub_no == 2:
                    group_nick = text
        except BridgeError:
            continue

        username = normalize_text(username)
        group_nick = normalize_text(group_nick)
        if not looks_like_wechat_username(username) or not group_nick:
            continue
        records.append({"username": username, "group_nick": group_nick})

    return records


def load_room_member_rows(room_id: int) -> dict[str, dict[str, Any]]:
    db_path = contact_db_path()
    with closing(sqlite3.connect(db_path)) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT cm.room_id, cm.member_id, c.username, c.local_type, c.alias,
                   c.remark, c.nick_name, c.quan_pin, c.remark_quan_pin
            FROM chatroom_member cm
            JOIN contact c ON c.id = cm.member_id
            WHERE cm.room_id = ?
            """,
            (room_id,),
        ).fetchall()

    out = {}
    for row in rows:
        username = normalize_text(row["username"])
        if not username:
            continue
        contact_display = normalize_text(
            row["remark"] or row["nick_name"] or row["alias"] or username
        )
        out[username] = {
            "member_id": int(row["member_id"]),
            "username": username,
            "contact_display": contact_display,
            "contact_remark": normalize_text(row["remark"]),
            "contact_nick_name": normalize_text(row["nick_name"]),
            "alias": normalize_text(row["alias"]),
            "local_type": int(row["local_type"] or 0),
        }
    return out


def load_room_ext_buffer(room_id: int) -> bytes:
    db_path = contact_db_path()
    with closing(sqlite3.connect(db_path)) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT ext_buffer FROM chat_room WHERE id = ?",
            (room_id,),
        ).fetchone()
    if not row or not row["ext_buffer"]:
        raise BridgeError(f"群 room_id={room_id} 没有 chat_room.ext_buffer，无法提取群昵称映射。")
    return row["ext_buffer"]


def build_member_map(group_name: str) -> dict[str, Any]:
    group = resolve_group_strict(group_name)
    member_rows = load_room_member_rows(group["room_id"])
    records = parse_member_records_from_ext_buffer(load_room_ext_buffer(group["room_id"]))

    by_username: dict[str, dict[str, Any]] = {}
    conflicts = []
    for rec in records:
        username = rec["username"]
        group_nick = rec["group_nick"]
        existing = by_username.get(username)
        if existing and existing["group_nick"] != group_nick:
            conflicts.append(
                {
                    "username": username,
                    "values": sorted({existing["group_nick"], group_nick}),
                }
            )
            continue

        contact = member_rows.get(username, {})
        by_username[username] = {
            "username": username,
            "group_nick": group_nick,
            "contact_display": contact.get("contact_display", ""),
            "contact_remark": contact.get("contact_remark", ""),
            "contact_nick_name": contact.get("contact_nick_name", ""),
            "alias": contact.get("alias", ""),
            "member_id": contact.get("member_id"),
            "in_chatroom_member_table": username in member_rows,
        }

    if conflicts:
        raise BridgeError(
            "群昵称映射存在冲突，拒绝生成缓存：\n"
            + json.dumps(conflicts[:20], ensure_ascii=False, indent=2)
        )

    member_count = len(member_rows)
    mapped_count = len(by_username)
    if mapped_count == 0:
        raise BridgeError("未从 chat_room.ext_buffer 解析到任何群昵称映射。")
    if member_count and mapped_count < max(1, int(member_count * 0.5)):
        raise BridgeError(
            f"群昵称映射数量异常：成员表 {member_count} 人，映射 {mapped_count} 人。"
        )

    missing_from_ext = sorted(set(member_rows) - set(by_username))
    extra_in_ext = sorted(set(by_username) - set(member_rows))

    payload = {
        "schema_version": MAP_SCHEMA_VERSION,
        "group_query": group_name,
        "group_name": group["display_name"],
        "room_username": group["username"],
        "room_id": group["room_id"],
        "refreshed_at": datetime.now().isoformat(timespec="seconds"),
        "member_count": member_count,
        "mapped_count": mapped_count,
        "missing_from_ext_count": len(missing_from_ext),
        "extra_in_ext_count": len(extra_in_ext),
        "missing_from_ext": missing_from_ext[:100],
        "extra_in_ext": extra_in_ext[:100],
        "members": sorted(by_username.values(), key=lambda x: x["group_nick"].lower()),
    }
    return payload


def write_member_map(payload: dict[str, Any]) -> Path:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = cache_path_for_group(payload["group_name"])
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)
    return path


def load_member_map(group_name: str) -> dict[str, Any]:
    # Resolve first so aliases/current month names converge to the same cache file.
    group = resolve_group_strict(group_name)
    path = cache_path_for_group(group["display_name"])
    if not path.exists():
        raise BridgeError(
            f"映射缓存不存在：{path}\n"
            f"请先显式运行 refresh-map；history 不会自动刷新映射。"
        )
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("schema_version") != MAP_SCHEMA_VERSION:
        raise BridgeError("映射缓存 schema_version 不匹配，请重新 refresh-map。")
    if payload.get("room_username") != group["username"]:
        raise BridgeError("映射缓存所属群与当前解析群不一致，请重新 refresh-map。")
    return payload


def member_map_by_username(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        normalize_text(item.get("username")): item
        for item in payload.get("members", [])
        if normalize_text(item.get("username"))
    }


def resolve_sender_username(real_sender_id: Any, sender_from_content: str, is_group: bool, id_to_username: dict[int, str]) -> str:
    if not is_group:
        return ""
    try:
        rid = int(real_sender_id)
    except (TypeError, ValueError):
        rid = 0
    if rid:
        username = normalize_text(id_to_username.get(rid, ""))
        if username:
            return username
    return normalize_text(sender_from_content)


def parse_msg_types(values: list[str] | None):
    if not values:
        return ["text"]
    out = []
    for value in values:
        for part in str(value).split(","):
            part = part.strip()
            if part:
                out.append(part)
    return out or ["text"]


def export_history(group_name: str, start_time: str, end_time: str, limit: int, offset: int, oldest_first: bool, msg_types: list[str] | None) -> dict[str, Any]:
    mapping_payload = load_member_map(group_name)
    nick_by_username = member_map_by_username(mapping_payload)

    ctx = mcp_server._resolve_chat_context(mapping_payload["room_username"])
    if not ctx or not ctx.get("message_tables"):
        raise BridgeError(f"找不到群消息表：{mapping_payload['group_name']}")

    start_ts, end_ts = mcp_server._parse_time_range(start_time, end_time)
    type_filter, type_err = mcp_server._resolve_msg_types(parse_msg_types(msg_types))
    if type_err:
        raise BridgeError(type_err)
    mcp_server._validate_pagination(limit, offset, limit_max=None)

    entries = []
    unmapped = []
    failures = []
    candidate_limit = limit + offset
    names = mcp_server.get_contact_names()

    for table_ctx in mcp_server._iter_table_contexts(ctx):
        try:
            with closing(sqlite3.connect(table_ctx["db_path"])) as conn:
                id_to_username = mcp_server._load_name2id_maps(conn)
                fetch_offset = 0
                before = len(entries)
                while len(entries) - before < candidate_limit:
                    rows = mcp_server._query_messages(
                        conn,
                        table_ctx["table_name"],
                        start_ts=start_ts,
                        end_ts=end_ts,
                        limit=mcp_server._history_query_batch_size(candidate_limit),
                        offset=fetch_offset,
                        oldest_first=oldest_first,
                        type_filter=type_filter,
                    )
                    if not rows:
                        break
                    fetch_offset += len(rows)

                    for row in rows:
                        local_id, local_type, create_time, real_sender_id, content, ct = row
                        decoded = mcp_server._decompress_content(content, ct)
                        if decoded is None:
                            decoded = "(无法解压)"
                        sender_from_content, text = mcp_server._format_message_text(
                            local_id,
                            local_type,
                            decoded,
                            True,
                            ctx["username"],
                            ctx["display_name"],
                            names,
                            create_time=create_time,
                        )
                        sender_username = resolve_sender_username(
                            real_sender_id,
                            sender_from_content,
                            True,
                            id_to_username,
                        )
                        if not sender_username:
                            # System/unattributed messages are not useful for check-in.
                            continue

                        mapped = nick_by_username.get(sender_username)
                        if not mapped:
                            original_label = mcp_server._resolve_sender_label(
                                real_sender_id,
                                sender_from_content,
                                True,
                                ctx["username"],
                                ctx["display_name"],
                                names,
                                id_to_username,
                            )
                            unmapped.append(
                                {
                                    "local_id": local_id,
                                    "timestamp": int(create_time or 0),
                                    "sender_username": sender_username,
                                    "original_sender": original_label,
                                    "content": text,
                                }
                            )
                            continue

                        entries.append(
                            (
                                int(create_time or 0),
                                {
                                    "local_id": int(local_id),
                                    "timestamp": int(create_time or 0),
                                    "time": datetime.fromtimestamp(create_time).strftime("%Y-%m-%d %H:%M:%S"),
                                    "sender": mapped["group_nick"],
                                    "content": text,
                                    "sender_username": sender_username,
                                    "source_contact_display": mapped.get("contact_display", ""),
                                    "source_group_nick": mapped["group_nick"],
                                    "type": mcp_server.format_msg_type(local_type),
                                },
                            )
                        )
                        if len(entries) - before >= candidate_limit:
                            break

                    if len(rows) < mcp_server._history_query_batch_size(candidate_limit):
                        break
        except Exception as exc:  # noqa: BLE001 - convert to explicit report
            failures.append(f"{table_ctx['db_path']}: {exc}")

    if failures:
        raise BridgeError("读取聊天记录失败：\n" + "\n".join(failures))
    if unmapped:
        raise BridgeError(
            "存在未映射发言者，拒绝把聊天记录交给 agent 做签到：\n"
            + json.dumps(unmapped[:30], ensure_ascii=False, indent=2)
        )

    ordered = sorted(entries, key=lambda item: item[0], reverse=not oldest_first)
    paged = ordered[offset : offset + limit]
    paged.sort(key=lambda item: item[0])

    return {
        "schema_version": 1,
        "export_kind": "agent_checkin_history",
        "group_name": mapping_payload["group_name"],
        "room_username": mapping_payload["room_username"],
        "map_refreshed_at": mapping_payload.get("refreshed_at"),
        "range": {"start": start_time, "end": end_time},
        "limit": limit,
        "offset": offset,
        "oldest_first": oldest_first,
        "sender_policy": "sender has been rewritten to group_nick via cached member map",
        "messages": [item for _, item in paged],
    }


def print_json(payload: Any) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def cmd_refresh_map(args: argparse.Namespace) -> int:
    payload = build_member_map(args.group)
    path = write_member_map(payload)
    print_json(
        {
            "ok": True,
            "action": "refresh-map",
            "cache_path": str(path),
            "group_name": payload["group_name"],
            "room_username": payload["room_username"],
            "member_count": payload["member_count"],
            "mapped_count": payload["mapped_count"],
            "missing_from_ext_count": payload["missing_from_ext_count"],
            "extra_in_ext_count": payload["extra_in_ext_count"],
            "refreshed_at": payload["refreshed_at"],
        }
    )
    return 0


def cmd_history(args: argparse.Namespace) -> int:
    payload = export_history(
        args.group,
        args.start,
        args.end,
        args.limit,
        args.offset,
        args.oldest_first,
        args.msg_type,
    )
    if args.output:
        out = Path(args.output)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print_json({"ok": True, "output": str(out), "message_count": len(payload["messages"])})
    else:
        print_json(payload)
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    group = resolve_group_strict(args.group)
    path = cache_path_for_group(group["display_name"])
    payload = {
        "ok": True,
        "group_name": group["display_name"],
        "room_username": group["username"],
        "cache_path": str(path),
        "cache_exists": path.exists(),
    }
    if path.exists():
        data = json.loads(path.read_text(encoding="utf-8"))
        payload.update(
            {
                "map_refreshed_at": data.get("refreshed_at"),
                "member_count": data.get("member_count"),
                "mapped_count": data.get("mapped_count"),
            }
        )
    print_json(payload)
    return 0


def cmd_list_groups(args: argparse.Namespace) -> int:
    groups = list_groups()
    if args.query:
        q = normalize_text(args.query)
        groups = [g for g in groups if q in g["display_name"] or q in g["username"]]
    print_json({"ok": True, "groups": groups})
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Agent WeChat check-in bridge")
    parser.add_argument(
        "--group",
        default=default_group_name(),
        help=f"群名或 @chatroom username。默认：{default_group_name()}",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_refresh = sub.add_parser("refresh-map", help="显式刷新并缓存群成员群昵称映射")
    p_refresh.set_defaults(func=cmd_refresh_map)

    p_status = sub.add_parser("status", help="查看目标群和映射缓存状态")
    p_status.set_defaults(func=cmd_status)

    p_groups = sub.add_parser("list-groups", help="列出/搜索群聊")
    p_groups.add_argument("--query", default="", help="按群名或 username 过滤")
    p_groups.set_defaults(func=cmd_list_groups)

    p_history = sub.add_parser("history", help="使用缓存映射导出 agent 可读聊天记录")
    p_history.add_argument("--start", required=True, help="起始时间")
    p_history.add_argument("--end", required=True, help="结束时间")
    p_history.add_argument("--limit", type=int, default=500)
    p_history.add_argument("--offset", type=int, default=0)
    p_history.add_argument("--oldest-first", action="store_true", default=True)
    p_history.add_argument("--msg-type", action="append", help="消息类型，默认 text；可重复或逗号分隔")
    p_history.add_argument("--output", default="", help="可选输出 JSON 文件")
    p_history.set_defaults(func=cmd_history)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except BridgeError as exc:
        print_json({"ok": False, "error": str(exc)})
        return 2
    except Exception as exc:  # noqa: BLE001
        print_json({"ok": False, "error": f"未预期错误：{exc}"})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
