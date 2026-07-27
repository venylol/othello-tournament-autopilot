#!/usr/bin/env python3
"""Agent-facing match image and score helper.

This helper reads local decrypted WeChat databases and cached local image files
only; it does not automate WeChat.

Typical use:
  agent_match_image_helper.cmd scan --group 35025014579@chatroom \
    --start "2026-06-06 20:00" --end "2026-06-06 20:30"
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import closing
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import agent_checkin_bridge
import mcp_server
from decode_image import decrypt_dat_file, extract_md5_from_packed_info, is_v2_format


ROOT = Path(__file__).resolve().parent
DEFAULT_STATE_PATH = ROOT.parent / "tournament_arrangement" / "recovered" / "data" / "checkin-state.json"
DEFAULT_IMAGE_DIR = ROOT / "agent_cache" / "match_images"
DEFAULT_FTD_PLAYER_MAP_DIR = ROOT / "agent_cache" / "ftd_player_maps"
DEFAULT_HARD_FLOW_OUTPUT_DIR = ROOT.parent / "subagent_outputs" / "ftd_player_maps"
DEFAULT_WATCH_STATE = ROOT / "agent_cache" / "match_image_seen.json"
DEFAULT_SCORE_SCAN_SEEN_STATE = ROOT / "agent_cache" / "score_scan_seen.json"
DEFAULT_FRONTEND_STATE_PATH = ROOT.parent / "tournament_arrangement" / "recovered" / "data" / "checkin-state.json"
MAP_COLLAB_SYNC_SCRIPT = ROOT.parent / "cloudflare-map-collab" / "tools" / "sync-map-collab.js"
MAP_COLLAB_CONFIG = ROOT.parent / "cloudflare-map-collab" / "map-collab.config.json"
ROSTER_MATCHER = ROOT / "agent_roster_matcher.js"
FRONTEND_STATE_API = os.environ.get("CHECKIN_FRONTEND_STATE_API", "http://127.0.0.1:4174/api/state").strip() or "http://127.0.0.1:4174/api/state"
CHINA_TZ = timezone(timedelta(hours=8))
SCORE_SCAN_CACHE_DELAY_SECONDS = 60
BLOCKING_SCORE_CHECKS = [
    "the two visible screenshot OQ IDs cannot both be matched to the same current-round FTD table",
    "a visible screenshot OQ ID is clearly outside the uniquely matched table's two expected accounts",
    "message sender is only auxiliary; if it conflicts with the screenshot-account-matched table, do not override the screenshot account gate",
    "manual inspection shows a true loser-side upload",
    "candidate OQ board/result image has no usable result after manual inspection, including required rotation attempts",
]
SCORE_SCAN_REALTIME_UPDATE_POLICY = (
    "Realtime update policy: in every score-scan polling window, any newly found "
    "agent/referee pending update or manually confirmed ready result must be written "
    "during that same polling window; do not batch or merge updates across later "
    "polling windows, so the referee can see abnormalities and intervene immediately."
)
SCORE_SCAN_STOP_POLLING_POLICY = (
    "Stop polling the current score window if a bot/referee message for the next round "
    "pairing table or round transition is already visible; the current round polling "
    "must not continue after the next round pairing table appears."
)
ABNORMAL_PENDING_POLICY = (
    "After opening pngPaths and manually inspecting screenshots, write clear results as ready. "
    "If a screenshot is abnormal, unreadable, loser-side, sender/table ambiguous, or account-mismatched, "
    "record or update a compact frontend pending item with push-pending-score/push-batch-scores in the same "
    "polling window. Pending is jointly handled by the agent and referee; continue polling unless the user stops you "
    "or local sync/write fails. Ignore pairing charts, ranking tables, and other images with no board/result score information; "
    "do not write pending for those images."
)
SCORE_SCAN_AGENT_NEXT_STEPS = [
    "Run score-scan once for this polling window, then open every path in pngPaths together before judging.",
    "Manually compare each screenshot's visible OQ IDs with pairingAccountIndex; sender/table matching is only auxiliary.",
    "For this same polling window, write all manually judged ready and pending items together with push-batch-scores when there is more than one item.",
    "Use push-ready-score or push-pending-score only for a single correction or emergency update; legacy push-score is fallback only.",
]
SCORE_REVIEW_REMINDER = (
    "判读规则：不使用 OCR。score-scan 只下载/转换图片、选择可解码的最高分辨率候选、"
    "输出 PNG/预览路径、发图人和当前轮配对表匹配信息；Codex 必须先一次性打开本窗口全部 PNG，再逐张人工判读。"
    "每张图会附带 pairingAccountIndex，即本轮每桌双方 OQ ID。"
    "截图里双方 OQ ID 是否能唯一匹配当前轮某一桌双方 OQ ID 是写 ready 的必要条件；"
    "sender/发图者映射只作为辅助定位，不能替代截图双方 OQ ID 校验。"
    "如果截图账号和预期 OQ 号只是大小写、下划线、空格、轻微视觉识别差异或很相似，不要阻塞；"
    "只有截图双方 OQ ID 无法唯一定位同一桌，或明显不属于该桌两人时才作为异常。"
    "写入前必须逐项检查 blockingScoreChecks；命中任一项时不要写 ready，"
    "改用 push-pending-score 记录到前端 pending，并继续轮询，除非用户明确中断或本地同步写入失败。"
    "若 sender 映射和截图 OQ ID 唯一匹配的桌不同，以截图双方 OQ ID 的匹配为必要 gate，记录 sender 矛盾原因。"
    "如果是匹配图、排名图或其他完全看不出局面/结果比分信息的图片，直接忽略，不写 pending。"
    "如果是账号不符 pending，先用 accountMismatchText 写最短摘要：图上不符一方的 OQ ID、群昵称/注册 OQ ID、姓名。"
    "如果候选 OQ 结果图本身不清、缺少关键账号/比分、疑似败方截图或其他异常，也写精简 pending item 后继续轮询。"
    "agent 写入比分时只写黄色待确认 ready；绿色 completed 只能由前端回车或完成按钮确认。"
    "读 OQ 结果图时先判断是否超时/失联/认输/弃权；结果明确时败方 0 子、胜方 64。"
    "否则正常胜利/差 N 子不能只靠差值计算；必须从图片找上方对手显示子数，"
    "对手分=该显示子数，我方分=64-对手分；不要把下方自己方显示子数作为正常完局计分来源。"
    "真实登记不能用群bot/裁判总表作为比分来源或容错；玩家截图仍不清就停止询问。平局 32-32。"
    "FTD 黑白只是桌号内两人的占位，不代表 OQ 实际颜色；按图片中的账号/姓名匹配两名选手后再套用上述计分规则。"
    f"{SCORE_SCAN_REALTIME_UPDATE_POLICY}"
    f"{SCORE_SCAN_STOP_POLLING_POLICY}"
)
SCORE_SCAN_FLOW_HINTS = [
    ("score-check", r"核对|确认.*比分|比分.*确认|检查.*比分|比分.*检查"),
    ("round-transition", r"下一轮|下轮|新一轮|第\s*[一二三四五六七八九0-9]+\s*轮|开启.*轮|开始.*轮"),
    ("score-stage", r"比分|成绩|结果|截图"),
]
NEXT_ROUND_PAIRING_HINT_RE = re.compile(
    r"(下一轮|下轮|新一轮|第\s*[一二三四五六七八九0-9]+\s*轮)"
    r".{0,80}"
    r"(配对|对阵|编排|桌号|台号|桌次|配桌|pairing|table|黑|白)",
    flags=re.IGNORECASE,
)


class HelperError(RuntimeError):
    pass


def print_json(payload: Any) -> None:
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    try:
        print(text)
    except UnicodeEncodeError:
        encoding = getattr(sys.stdout, "encoding", None) or "utf-8"
        safe_text = text.encode(encoding, errors="replace").decode(encoding, errors="replace")
        print(safe_text)


def console_safe_text(value: Any) -> str:
    text = str(value or "")
    replacements = {
        "\u2022": "*",
        "\u25cf": "*",
        "\u25cb": "O",
        "\u25a1": "[]",
        "\u25a0": "[]",
        "\u00b7": ".",
        "\u2191": "^",
        "\u2190": "<",
        "\u2192": ">",
        "\u3000": " ",
    }
    return "".join(replacements.get(ch, ch) for ch in text)


def normalize(value: Any) -> str:
    return re.sub(
        r"[\s\u3000\[\]()（）【】{}<>《》,，。:：;；\"“”'‘’\-_\/\\|]+",
        "",
        str(value or "").lower(),
    )


HAN_MONTHS = {
    "正": 1,
    "一": 1,
    "二": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
    "十": 10,
    "十一": 11,
    "十二": 12,
}


def normalize_relay_line(value: Any) -> str:
    return re.sub(r"[\s\u00a0\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f\u3000\u3164\ufeff]+", " ", str(value or "")).strip()


def detect_relay_months(relay_text: str) -> list[int]:
    head = "\n".join(str(relay_text or "").splitlines()[:16])
    months: list[int] = []
    for match in re.finditer(r"(?<!\d)(0?[1-9]|1[0-2])\s*月", head):
        months.append(int(match.group(1)))
    han_pattern = "|".join(sorted((re.escape(key) for key in HAN_MONTHS), key=len, reverse=True))
    for match in re.finditer(rf"({han_pattern})\s*月", head):
        month = HAN_MONTHS.get(match.group(1))
        if month:
            months.append(month)
    seen: set[int] = set()
    unique: list[int] = []
    for month in months:
        if month in seen:
            continue
        seen.add(month)
        unique.append(month)
    return unique


def detect_registration_relay_competition_name(relay_text: str) -> tuple[str, str]:
    for raw_line in str(relay_text or "").splitlines()[:24]:
        line = normalize_relay_line(raw_line)
        if "比赛报名接龙" not in line and "比赛报名接龍" not in line:
            continue
        name = normalize_relay_line(
            re.sub(r"#\s*接[龙龍]\s*", "", line)
            .replace("比赛报名接龙", "")
            .replace("比赛报名接龍", "")
        )
        name = name.strip(" -_—：:，,。")
        return name, line
    return "", ""


def relay_account_token(value: Any) -> str:
    token = normalize_relay_line(value).strip("[]()（）【】{}<>《》,，。:：;；\"“”'‘’?？")
    if not re.fullmatch(r"[A-Za-z0-9_]{1,14}", token):
        return ""
    return token


def clean_registration_relay_record(value: Any) -> str:
    text = normalize_relay_line(value)
    if not text:
        return ""
    text = re.sub(r"^[#\d]+[\.、．\)\）]\s*", "", text).strip()
    text = re.sub(r"[‐‑‒–—―﹘﹣－]", "-", text)
    text = text.replace("+", " ")
    text = re.sub(r"[#:：]", " ", text)
    text = re.sub(r"([\u4e00-\u9fff])[,，]\s*([A-Za-z0-9_])", r"\1 \2", text)
    text = re.sub(r"[|｜丨/／]", " ", text)
    text = re.sub(r"↓|×", " ", text)
    text = re.sub(r"\b(?:id|club)\b", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"(?:昵称|姓名|账号|俱乐部|平台|组别)", " ", text)
    text = normalize_relay_line(text)
    return text.strip(" \t\r\n,，。;；:：")


def split_chinese_and_account_if_possible(value: Any) -> tuple[str, str]:
    text = normalize_relay_line(value)
    match = re.match(r"^([\u4e00-\u9fff]{1,10})([A-Za-z0-9_][A-Za-z0-9_-]{1,13})$", text)
    if not match:
        return "", ""
    account = relay_account_token(match.group(2))
    return (match.group(1), account) if account else ("", "")


def relay_name_tokens(value: Any) -> list[str]:
    return [
        item.casefold()
        for item in re.findall(r"[A-Za-z]+", str(value or ""))
        if item
    ]


def relay_token_set_key(value: Any) -> str:
    tokens = relay_name_tokens(value)
    if len(tokens) < 2:
        return ""
    return "|".join(sorted(set(tokens)))


def parse_registration_relay_record(content: str) -> tuple[str, str]:
    text = clean_registration_relay_record(content)
    if not text:
        return "", ""
    bracket_match = re.match(r"^(.+?)[\[\(（【]\s*([A-Za-z0-9_]{1,14})\s*[\]\)）】]\??\s*$", text)
    if bracket_match:
        name = normalize_relay_line(bracket_match.group(1)).strip("-_/ ")
        account = relay_account_token(bracket_match.group(2))
        return (name, account) if name and account else ("", "")
    if " " not in text:
        dash_idx = text.rfind("-")
        if 0 < dash_idx < len(text) - 1:
            name = normalize_relay_line(text[:dash_idx]).strip("-_/ ")
            account = relay_account_token(text[dash_idx + 1 :])
            if name and account:
                return name, account
        name, account = split_chinese_and_account_if_possible(text)
        if name and account:
            return name, account
    token_match = re.match(r"^(.+?)(?:[\s\u3000_\-/]+)([A-Za-z0-9_]{1,14})\??\s*$", text)
    if token_match:
        name = normalize_relay_line(token_match.group(1)).strip("-_/ ")
        account = relay_account_token(token_match.group(2))
        if name and account:
            return name, account
    return "", ""


def parse_registration_relay_entries(relay_text: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    entries: list[dict[str, Any]] = []
    ignored: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for raw_line in str(relay_text or "").splitlines():
        line = normalize_relay_line(raw_line)
        if not line:
            continue
        numbered = re.match(r"^\s*(\d+)[\.、．\)\）]\s*(.+?)\s*$", line)
        if not numbered:
            continue
        relay_index = int(numbered.group(1))
        content = numbered.group(2).strip()
        segments = re.split(r"\s*(?:&|＆|;|；)\s*", content)
        parsed_any = False
        for segment in segments:
            name, account = parse_registration_relay_record(segment)
            if not name or not account:
                continue
            key = (normalize_name_key(name), account.casefold())
            if key in seen:
                continue
            seen.add(key)
            entries.append(
                {
                    "index": relay_index,
                    "name": name,
                    "account": account,
                    "rawLine": line,
                }
            )
            parsed_any = True
        if not parsed_any:
            ignored.append({"index": relay_index, "line": line, "reason": "no deterministic name/account split"})
    return entries, ignored


def registration_relay_reference_from_state(state: dict[str, Any], require_current_month: bool = False) -> dict[str, Any]:
    relay_text = str(state.get("relayText") or "")
    checked_at = current_iso_timestamp()
    current_month = datetime.now().astimezone().month
    months = detect_relay_months(relay_text)
    competition_name, title_line = detect_registration_relay_competition_name(relay_text)
    state_competition_name = normalize_relay_line(state.get("competitionName") or "")
    effective_competition_name = competition_name or state_competition_name
    month_matched = current_month in months
    if require_current_month:
        if not relay_text.strip():
            raise HelperError("current frontend state has no relayText; import the current-month signup relay before building the FTD/OQ map")
        if not months:
            raise HelperError("signup relay month could not be detected; title should include this month in digits or Chinese numerals")
        if not month_matched:
            raise HelperError(f"signup relay month mismatch: current month={current_month}, detected={months}")
    entries, ignored = parse_registration_relay_entries(relay_text if month_matched or not require_current_month else "")
    account_index: dict[str, dict[str, Any]] = {}
    token_set_index: dict[str, list[dict[str, Any]]] = {}
    for entry in entries:
        key = normalize_name_key(entry.get("name") or "")
        if key and key not in account_index:
            account_index[key] = entry
        token_key = relay_token_set_key(entry.get("name") or "")
        if token_key:
            token_set_index.setdefault(token_key, []).append(entry)
    return {
        "version": 1,
        "source": "frontend-state relayText",
        "checkedAt": checked_at,
        "currentMonth": current_month,
        "detectedMonths": months,
        "monthMatched": month_matched,
        "titleLine": title_line,
        "competitionName": effective_competition_name,
        "mappingTitle": f"{effective_competition_name} 映射表" if effective_competition_name else "",
        "entryCount": len(entries),
        "ignoredCount": len(ignored),
        "entries": entries[:300],
        "ignored": ignored[:120],
        "rawText": relay_text,
        "accountIndex": account_index,
        "tokenSetIndex": token_set_index,
    }


def public_registration_relay_reference(reference: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(reference, dict):
        return None
    return {
        key: value
        for key, value in reference.items()
        if key not in {"accountIndex", "tokenSetIndex"}
    }


def registration_relay_hint_for_ftd_name(reference: dict[str, Any] | None, ftd_name: str) -> dict[str, Any] | None:
    if not isinstance(reference, dict) or not reference.get("monthMatched"):
        return None
    key = normalize_name_key(ftd_name)
    account_index = reference.get("accountIndex") if isinstance(reference.get("accountIndex"), dict) else {}
    exact = account_index.get(key)
    if isinstance(exact, dict):
        return {"status": "matched", "entry": exact, "reason": "relay-name-exact"}
    ftd_tokens = set(relay_name_tokens(ftd_name))
    if len(ftd_tokens) < 2:
        return None
    entries = reference.get("entries") if isinstance(reference.get("entries"), list) else []
    candidates = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        entry_tokens = set(relay_name_tokens(entry.get("name") or ""))
        if len(entry_tokens) >= 2 and (entry_tokens.issubset(ftd_tokens) or ftd_tokens.issubset(entry_tokens)):
            candidates.append(entry)
    unique: dict[str, dict[str, Any]] = {}
    for item in candidates:
        unique_key = f"{normalize_name_key(item.get('name') or '')}:{str(item.get('account') or '').casefold()}"
        unique[unique_key] = item
    candidates = list(unique.values())
    if len(candidates) == 1:
        return {"status": "matched", "entry": candidates[0], "reason": "relay-token-subset"}
    if candidates:
        return {"status": "ambiguous", "candidates": candidates}
    return None


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8").lstrip("\ufeff"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def read_frontend_state(state_path: Path, direct_file: bool) -> dict[str, Any]:
    if direct_file:
        state = read_json(state_path)
        if not isinstance(state, dict):
            raise HelperError(f"Invalid frontend state: {state_path}")
        return state
    try:
        with urllib.request.urlopen(f"{FRONTEND_STATE_API}?t={int(time.time() * 1000)}", timeout=3) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (OSError, urllib.error.URLError, json.JSONDecodeError) as exc:
        raise HelperError(
            "local sync API is unavailable; start node local-server.js or pass --direct-file explicitly"
        ) from exc
    if not payload.get("ok"):
        raise HelperError(f"local sync API read failed: {payload}")
    state = payload.get("state")
    if not isinstance(state, dict):
        raise HelperError("local sync API returned no state object")
    return state


def write_frontend_state(state_path: Path, state: dict[str, Any], direct_file: bool) -> str:
    if direct_file:
        write_json(state_path, state)
        return str(state_path)
    body = json.dumps({"source": "agent-score-helper", "state": state}, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        FRONTEND_STATE_API,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (OSError, urllib.error.URLError, json.JSONDecodeError) as exc:
        raise HelperError("local sync API write failed; score item was not written") from exc
    if not payload.get("ok"):
        raise HelperError(f"local sync API write failed: {payload}")
    return FRONTEND_STATE_API


def mark_oq_round_score_update_request(round_no: int, source: str) -> None:
    marker_url = re.sub(r"/api/state/?$", "/api/oq-games/update-round-scores/mark-request", FRONTEND_STATE_API)
    request = urllib.request.Request(
        marker_url,
        data=json.dumps({"round": round_no, "source": source}, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=0.75):
            pass
    except Exception:
        pass


def map_collab_sync(action: str, state_path: Path | None = None) -> dict[str, Any]:
    if not MAP_COLLAB_SYNC_SCRIPT.exists() or not MAP_COLLAB_CONFIG.exists():
        return {"ok": True, "skipped": True, "reason": "map collab sync config/script not found"}
    cmd = ["node", str(MAP_COLLAB_SYNC_SCRIPT), action, "--config", str(MAP_COLLAB_CONFIG)]
    if state_path:
        cmd.extend(["--state", str(state_path)])
    started = time.perf_counter()
    try:
        completed = subprocess.run(
            cmd,
            cwd=str(ROOT.parent),
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "action": action, "error": str(exc)}
    stdout = (completed.stdout or "").strip()
    stderr = (completed.stderr or "").strip()
    try:
        parsed = json.loads(stdout) if stdout else {}
    except json.JSONDecodeError:
        parsed = {"rawStdout": stdout}
    if not isinstance(parsed, dict):
        parsed = {"rawStdout": stdout}
    parsed.update(
        {
            "ok": completed.returncode == 0 and parsed.get("ok") is not False,
            "action": action,
            "exitCode": completed.returncode,
            "stderr": stderr,
            "elapsedMs": round((time.perf_counter() - started) * 1000, 1),
        }
    )
    if completed.returncode != 0 and not parsed.get("error"):
        parsed["error"] = stderr or stdout or f"sync helper exited {completed.returncode}"
    return parsed


def load_players(state_path: Path) -> list[dict[str, Any]]:
    if not state_path.exists():
        return []
    state = read_json(state_path)
    return players_from_state(state, state_path)


def players_from_state(state: dict[str, Any], state_path: Path | None = None) -> list[dict[str, Any]]:
    players = state.get("players", [])
    if not isinstance(players, list):
        label = str(state_path) if state_path else "frontend state"
        raise HelperError(f"Invalid state players list: {label}")
    return [p for p in players if isinstance(p, dict)]


def players_from_ftd_round(round_item: dict[str, Any], round_no: int) -> list[dict[str, Any]]:
    pairings = round_item.get("ftdPairings") if isinstance(round_item.get("ftdPairings"), list) else []
    players: list[dict[str, Any]] = []
    seen: set[str] = set()
    for pairing in pairings:
        if not isinstance(pairing, dict):
            continue
        table = pairing.get("table")
        for side in ("black", "white"):
            name = str(pairing.get(side) or "").strip()
            if not name or name.upper() == "BYE":
                continue
            key = normalize(name)
            if not key or key in seen:
                continue
            seen.add(key)
            players.append(
                {
                    "displayName": name,
                    "account": "",
                    "group": f"第 {round_no} 轮配对表",
                    "checkedIn": True,
                    "pairingTable": table,
                    "pairingSide": side,
                }
            )
    return players


def validate_knockout_round_pairings(round_item: dict[str, Any]) -> None:
    stage = str(round_item.get("stage") or "preliminary").strip()
    pairings = round_item.get("ftdPairings") if isinstance(round_item.get("ftdPairings"), list) else []
    if stage == "semifinal" and len(pairings) != 2:
        raise HelperError("半决赛配对不完整：请先在前端导入包含 2 台配对的 FTD SF JSON")
    if stage == "finals":
        stages = {str(item.get("ftdStage") or "").strip().upper() for item in pairings if isinstance(item, dict)}
        if len(pairings) != 2 or "F" not in stages or "3/4" not in stages:
            raise HelperError("决赛阶段配对不完整：请先在前端分别导入 FTD 的 F 与 3/4 JSON")


def ftd_player_account_mapping_rows(state: dict[str, Any]) -> dict[str, dict[str, Any]]:
    mapping = state.get("ftdPlayerAccountMapping") if isinstance(state, dict) else None
    if not isinstance(mapping, dict):
        return {}
    if mapping.get("cleared") is True:
        return {}
    rows = mapping.get("players")
    if not isinstance(rows, list):
        return {}
    by_key: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        if row.get("deleted") is True or str(row.get("status") or "").strip() == "deleted":
            continue
        name = str(row.get("ftdName") or row.get("displayName") or row.get("name") or "").strip()
        key = normalize_name_key(name)
        if not key:
            continue
        oq_check = row.get("oqCheck") if isinstance(row.get("oqCheck"), dict) else {}
        account = str(row.get("account") or "").strip()
        group_nick = str(row.get("groupNick") or row.get("group_nick") or "").strip()
        has_required = bool(name and account and group_nick)
        oq_ok = has_required and oq_check.get("status") == "ok" and mapping_oq_check_matches_account(row)
        oq_invalid = has_required and oq_check.get("status") == "invalid" and mapping_oq_check_matches_account(row)
        by_key[key] = {
            "ftdName": name,
            "account": account,
            "groupNick": group_nick,
            "mappingState": "complete" if oq_ok else ("invalid" if oq_invalid else "incomplete"),
            "source": str(row.get("source") or "ftdPlayerAccountMapping").strip(),
            "editAudit": row.get("editAudit") if isinstance(row.get("editAudit"), dict) else {},
        }
    return by_key


def ftd_mapping_hint(mapping_rows: dict[str, dict[str, Any]], ftd_name: str) -> dict[str, Any] | None:
    key = normalize_name_key(ftd_name)
    if not key:
        return None
    return mapping_rows.get(key)


def refresh_member_map_for_score_scan(group_name: str) -> dict[str, Any]:
    payload = agent_checkin_bridge.build_member_map(group_name)
    path = agent_checkin_bridge.write_member_map(payload)
    return {
        "ok": True,
        "action": "refresh-map",
        "cache_path": str(path),
        "group_name": payload.get("group_name"),
        "room_username": payload.get("room_username"),
        "member_count": payload.get("member_count"),
        "mapped_count": payload.get("mapped_count"),
        "missing_from_ext_count": payload.get("missing_from_ext_count"),
        "extra_in_ext_count": payload.get("extra_in_ext_count"),
        "refreshed_at": payload.get("refreshed_at"),
    }


def wechat_group_nicks_from_member_map(member_map_payload: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(member_map_payload, dict):
        return {"ok": False, "groupNicks": []}
    seen: set[str] = set()
    group_nicks: list[str] = []
    existing_nicks = member_map_payload.get("groupNicks")
    if isinstance(existing_nicks, list):
        for raw_nick in existing_nicks:
            nick = str(raw_nick or "").strip()
            if not nick or nick in seen:
                continue
            seen.add(nick)
            group_nicks.append(nick)
    members = member_map_payload.get("members")
    if isinstance(members, list):
        for member in members:
            if not isinstance(member, dict):
                continue
            nick = str(member.get("group_nick") or member.get("groupNick") or "").strip()
            if not nick or nick in seen:
                continue
            seen.add(nick)
            group_nicks.append(nick)
    group_nicks.sort(key=lambda value: value.lower())
    return {
        "ok": True,
        "groupName": str(member_map_payload.get("group_name") or member_map_payload.get("groupName") or ""),
        "roomUsername": str(member_map_payload.get("room_username") or member_map_payload.get("roomUsername") or ""),
        "refreshedAt": str(member_map_payload.get("refreshed_at") or member_map_payload.get("refreshedAt") or ""),
        "memberCount": int(member_map_payload.get("member_count") or member_map_payload.get("memberCount") or len(group_nicks) or 0),
        "mappedCount": int(member_map_payload.get("mapped_count") or member_map_payload.get("mappedCount") or len(group_nicks) or 0),
        "groupNicks": group_nicks,
    }


def existing_wechat_group_nicks(state: dict[str, Any], mapping: dict[str, Any] | None = None) -> dict[str, Any] | None:
    for candidate in (
        state.get("wechatGroupNicks") if isinstance(state, dict) else None,
        mapping.get("wechatGroupNicks") if isinstance(mapping, dict) else None,
    ):
        if not isinstance(candidate, dict):
            continue
        group_nicks = candidate.get("groupNicks")
        if isinstance(group_nicks, list) and any(str(nick).strip() for nick in group_nicks):
            return {**candidate, "groupNicks": [str(nick).strip() for nick in group_nicks if str(nick).strip()]}
    return None


def attach_wechat_group_nicks_to_mapping_state(
    state: dict[str, Any],
    member_map_payload: dict[str, Any] | None,
) -> dict[str, Any]:
    nick_pool = wechat_group_nicks_from_member_map(member_map_payload)
    if not nick_pool.get("groupNicks"):
        raise HelperError("WeChat member map has no group nicknames; refresh-map did not produce a publishable nickname table")
    state["wechatGroupNicks"] = nick_pool
    mapping = state.get("ftdPlayerAccountMapping")
    if isinstance(mapping, dict):
        mapping["wechatGroupNicks"] = nick_pool
    return nick_pool


def ensure_wechat_group_nicks_for_publish(state: dict[str, Any], group_name: str) -> dict[str, Any]:
    mapping = state.get("ftdPlayerAccountMapping") if isinstance(state.get("ftdPlayerAccountMapping"), dict) else {}
    existing = existing_wechat_group_nicks(state, mapping)
    if existing:
        state["wechatGroupNicks"] = existing
        if isinstance(mapping, dict):
            mapping["wechatGroupNicks"] = existing
        return existing
    member_map_payload = agent_checkin_bridge.load_member_map(group_name)
    return attach_wechat_group_nicks_to_mapping_state(state, member_map_payload)


def pairing_player_key(display_name: Any, account: Any = "") -> str:
    account_key = normalize_name_key(account)
    if account_key:
        return f"account:{account_key}"
    return f"name:{normalize_name_key(display_name)}"


def member_map_text_fields(member: dict[str, Any]) -> str:
    return " ".join(
        str(member.get(key) or "")
        for key in ("group_nick", "contact_display", "contact_remark", "contact_nick_name", "alias")
        if str(member.get(key) or "").strip()
    )


def account_token_from_group_nick(group_nick: str, matched_name: str, ftd_name: str) -> str:
    text = str(group_nick or "").strip()
    if not text:
        return ""
    tokens = re.findall(r"[A-Za-z0-9_][A-Za-z0-9_.-]*", text)
    if tokens:
        name_keys = {
            normalize_name_key(matched_name),
            normalize_name_key(ftd_name),
        }
        name_token_count = len(re.findall(r"[A-Za-z]+", str(ftd_name or matched_name)))
        has_han = bool(re.search(r"[\u4e00-\u9fff]", text))
        first_token_is_full_name = bool(tokens and normalize_name_key(tokens[0]) in name_keys and len(tokens) > 1)
        if has_han or first_token_is_full_name or len(tokens) > max(1, name_token_count):
            for token in reversed(tokens):
                cleaned = token.strip(" .")
                if len(cleaned) >= 2 and re.search(r"[A-Za-z0-9]", cleaned):
                    if not has_han and normalize_name_key(cleaned) in name_keys:
                        continue
                    return cleaned
    name_keys = [
        normalize_name_key(matched_name),
        normalize_name_key(ftd_name),
    ]
    compact = normalize_name_key(text)
    for key in [k for k in name_keys if k]:
        if compact.startswith(key):
            tail = compact[len(key):]
            if tail and re.search(r"[a-z0-9]", tail):
                return tail
    return ""


def member_map_account_hint(member_map_payload: dict[str, Any] | None, matched_name: str, ftd_name: str) -> dict[str, Any] | None:
    if not isinstance(member_map_payload, dict):
        return None
    members = member_map_payload.get("members")
    if not isinstance(members, list):
        return None
    target_keys = {normalize_name_key(matched_name), normalize_name_key(ftd_name)}
    target_keys = {key for key in target_keys if key}
    if not target_keys:
        return None
    hits = []
    for member in members:
        if not isinstance(member, dict):
            continue
        group_nick = str(member.get("group_nick") or "")
        hay = normalize_name_key(member_map_text_fields(member))
        if any(key and key in hay for key in target_keys):
            account = account_token_from_group_nick(group_nick, matched_name, ftd_name)
            if account:
                hits.append(
                    {
                        "account": account,
                        "group_nick": member.get("group_nick") or "",
                        "contact_display": member.get("contact_display") or "",
                        "contact_remark": member.get("contact_remark") or "",
                        "contact_nick_name": member.get("contact_nick_name") or "",
                        "alias": member.get("alias") or "",
                        "username": member.get("username") or "",
                    }
                )
    unique_by_account = {}
    for hit in hits:
        key = normalize_name_key(hit.get("account"))
        if key and key not in unique_by_account:
            unique_by_account[key] = hit
    unique = list(unique_by_account.values())
    if len(unique) == 1:
        return {"status": "matched", **unique[0]}
    if unique:
        return {"status": "ambiguous", "candidates": unique}
    return None


def member_map_group_nick_hint(member_map_payload: dict[str, Any] | None, matched_name: str, ftd_name: str) -> dict[str, Any] | None:
    if not isinstance(member_map_payload, dict):
        return None
    members = member_map_payload.get("members")
    if not isinstance(members, list):
        return None
    target_keys = {normalize_name_key(matched_name), normalize_name_key(ftd_name)}
    target_keys = {key for key in target_keys if key}
    if not target_keys:
        return None
    hits = []
    for member in members:
        if not isinstance(member, dict):
            continue
        group_nick = str(member.get("group_nick") or "").strip()
        if not group_nick:
            continue
        hay = normalize_name_key(member_map_text_fields(member))
        if any(key and key in hay for key in target_keys):
            hits.append(
                {
                    "group_nick": group_nick,
                    "contact_display": member.get("contact_display") or "",
                    "contact_remark": member.get("contact_remark") or "",
                    "contact_nick_name": member.get("contact_nick_name") or "",
                    "alias": member.get("alias") or "",
                    "username": member.get("username") or "",
                }
            )
    unique_by_nick = {}
    for hit in hits:
        key = normalize_name_key(hit.get("group_nick"))
        if key and key not in unique_by_nick:
            unique_by_nick[key] = hit
    unique = list(unique_by_nick.values())
    if len(unique) == 1:
        return {"status": "matched", **unique[0]}
    if unique:
        return {"status": "ambiguous", "candidates": unique}
    return None


def current_iso_timestamp() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def sync_checked_in_account_mapping(args: argparse.Namespace) -> dict[str, Any]:
    state_path = Path(args.frontend_state)
    state = read_frontend_state(state_path, bool(args.direct_file))
    players = players_from_state(state, state_path)
    checked_players = [p for p in players if p.get("checkedIn") is True]
    map_refresh = refresh_member_map_for_score_scan(args.group)
    member_map_payload = agent_checkin_bridge.load_member_map(args.group)
    mapped_at = current_iso_timestamp()
    account_index: dict[str, dict[str, Any]] = {}
    applied: list[dict[str, Any]] = []
    kept_existing: list[dict[str, Any]] = []
    unresolved: list[dict[str, Any]] = []
    conflicts: list[dict[str, Any]] = []

    for player in checked_players:
        display_name = str(player.get("displayName") or "").strip()
        if not display_name:
            continue
        existing_account = str(player.get("account") or "").strip()
        hint = member_map_account_hint(member_map_payload, display_name, display_name)
        row = {
            "playerId": player.get("id"),
            "displayName": display_name,
            "account": existing_account,
            "source": "existing-account" if existing_account else "",
            "mappedAt": mapped_at,
        }
        if existing_account:
            if hint and hint.get("status") == "matched":
                hinted_account = str(hint.get("account") or "").strip()
                if hinted_account and normalize(hinted_account) != normalize(existing_account):
                    conflicts.append(
                        {
                            "playerId": player.get("id"),
                            "displayName": display_name,
                            "existingAccount": existing_account,
                            "memberMapAccount": hinted_account,
                            "groupNick": hint.get("group_nick") or "",
                            "reason": "existing account differs from current group nickname account hint",
                        }
                    )
                    row["source"] = "existing-account-conflict"
                    row["memberMapAccount"] = hinted_account
                elif hinted_account:
                    row["source"] = "existing-account-verified"
                    row["groupNick"] = hint.get("group_nick") or ""
            kept_existing.append(row)
        elif hint and hint.get("status") == "matched":
            account = str(hint.get("account") or "").strip()
            if account:
                player["account"] = account
                player["platform"] = str(player.get("platform") or "oq").strip() or "oq"
                row.update(
                    {
                        "account": account,
                        "source": "member-map-group-nick-account",
                        "groupNick": hint.get("group_nick") or "",
                    }
                )
                applied.append(row)
        elif hint and hint.get("status") == "ambiguous":
            unresolved.append(
                {
                    "playerId": player.get("id"),
                    "displayName": display_name,
                    "status": "ambiguous",
                    "candidates": hint.get("candidates") or [],
                    "reason": "multiple possible OQ account tokens in member map",
                }
            )
        else:
            unresolved.append(
                {
                    "playerId": player.get("id"),
                    "displayName": display_name,
                    "status": "unmatched",
                    "reason": "no deterministic group nickname account hint",
                }
            )

        key = normalize_name_key(display_name)
        account = str(row.get("account") or player.get("account") or "").strip()
        if key and account:
            account_index[key] = {
                "displayName": display_name,
                "account": account,
                "playerId": player.get("id"),
                "source": row.get("source") or "checked-in-roster",
                "mappedAt": mapped_at,
            }

    mapping = {
        "version": 1,
        "scope": "checked-in-roster",
        "group": args.group,
        "mappedAt": mapped_at,
        "updatedAt": int(time.time() * 1000),
        "checkedInCount": len(checked_players),
        "indexedCount": len(account_index),
        "appliedCount": len(applied),
        "existingCount": len(kept_existing),
        "unresolvedCount": len(unresolved),
        "conflictCount": len(conflicts),
        "accountIndex": account_index,
        "applied": applied[:200],
        "existing": kept_existing[:200],
        "unresolved": unresolved[:200],
        "conflicts": conflicts[:200],
        "mapRefresh": map_refresh,
    }
    state["accountMapping"] = mapping
    state["savedAt"] = int(time.time() * 1000)
    written_to = ""
    if not args.dry_run:
        written_to = write_frontend_state(state_path, state, bool(args.direct_file))
    return {
        "ok": True,
        "action": "sync-checkedin-accounts",
        "dryRun": bool(args.dry_run),
        "state": written_to,
        "mapping": {
            key: value
            for key, value in mapping.items()
            if key not in {"accountIndex", "applied", "existing", "unresolved", "conflicts"}
        },
        "applied": applied,
        "keptExisting": kept_existing,
        "unresolved": unresolved,
        "conflicts": conflicts,
    }


def cmd_sync_checkedin_accounts(args: argparse.Namespace) -> int:
    print_json(sync_checked_in_account_mapping(args))
    return 0


def load_ftd_player_export(path: Path) -> dict[str, Any]:
    payload = read_json(path)
    if not isinstance(payload, dict):
        raise HelperError(f"Invalid FTD player JSON: {path}")
    players = payload.get("players")
    if not isinstance(players, list):
        raise HelperError(f"FTD player JSON has no players[]: {path}")
    return payload


def ftd_export_player_name(player: dict[str, Any]) -> str:
    for key in ("name", "displayName", "playerName", "fullName"):
        value = str(player.get(key) or "").strip()
        if value:
            return value
    surname = str(player.get("surname") or player.get("lastName") or player.get("last_name") or "").strip()
    given = str(player.get("givenName") or player.get("firstName") or player.get("first_name") or "").strip()
    return " ".join(part for part in (surname, given) if part).strip()


def default_ftd_player_map_output(ftd_path: Path, target_id: str) -> Path:
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    event = re.sub(r'[\\/:*?"<>|\s]+', "_", target_id or ftd_path.stem or "ftd").strip("_")
    return DEFAULT_FTD_PLAYER_MAP_DIR / f"ftd-player-oq-map-{event}-{stamp}.json"


def default_hard_flow_ftd_player_map_output(ftd_path: Path) -> Path:
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    event = re.sub(r'[\\/:*?"<>|\s]+', "_", ftd_path.stem or "ftd").strip("_")
    return DEFAULT_HARD_FLOW_OUTPUT_DIR / f"ftd-player-oq-map-{event}-{stamp}.json"


def compact_ftd_mapping_pending_text(row: dict[str, Any]) -> str:
    ftd_name = str(row.get("ftdName") or "").strip()
    group_nicks: list[str] = []
    group_nick = str(row.get("groupNick") or row.get("group_nick") or "").strip()
    if group_nick:
        group_nicks.append(group_nick)
    candidates = row.get("candidates") if isinstance(row.get("candidates"), list) else []
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        value = str(candidate.get("group_nick") or candidate.get("groupNick") or "").strip()
        if value and value not in group_nicks:
            group_nicks.append(value)
    return f"群昵称：{' / '.join(group_nicks)}；FTD姓名：{ftd_name}"


OQ_MODE_ENDPOINTS = {
    "1min": "reversi1",
    "5min": "reversi",
    "xot": "reversix",
}


class DirectOQGameEntry:
    def __init__(self, payload: dict[str, Any], detail: dict[str, Any] | None = None) -> None:
        players = payload.get("players") if isinstance(payload.get("players"), list) else []
        black = players[0] if len(players) > 0 and isinstance(players[0], dict) else {}
        white = players[1] if len(players) > 1 and isinstance(players[1], dict) else {}
        self.game_id = str(payload.get("id") or "")
        self.created_at = str(payload.get("created") or payload.get("createdAt") or "")
        self.black_name = str(black.get("id") or black.get("name") or "")
        self.white_name = str(white.get("id") or white.get("name") or "")
        self.black_score = payload.get("blackScore")
        self.white_score = payload.get("whiteScore")
        self.user_name = ""
        self.opponent_name = ""
        self.user_score = None
        self.opponent_score = None
        self.result = str(payload.get("result") or "")
        self.status = str(payload.get("finalStatus") or payload.get("status") or "")
        self.length = payload.get("length")
        self.comment = ""
        metadata: dict[str, Any] = {"summary": payload}
        if isinstance(detail, dict):
            metadata["detail"] = detail
            if not self.created_at:
                self.created_at = str(detail.get("created") or detail.get("createdAt") or "")
            if not self.status:
                self.status = str(detail.get("finalStatus") or detail.get("status") or "")
        self.raw_metadata_json = json.dumps(metadata, ensure_ascii=False, sort_keys=True)


class DirectOQClient:
    def __init__(self, base_url: str = "http://questgames.net", timeout: int = 20) -> None:
        self.base_url = str(base_url or "http://questgames.net").rstrip("/")
        self.timeout = max(1, int(timeout or 20))

    def _get_json(self, path: str) -> Any:
        url = f"{self.base_url}{path}"
        request = urllib.request.Request(
            url,
            headers={"User-Agent": "onlicheck-local-oq-client/0.1"},
            method="GET",
        )
        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            return json.loads(response.read().decode("utf-8"))

    def fetch_games(self, account: str, mode: str, include_details: bool = False) -> list[DirectOQGameEntry]:
        account_text = str(account or "").strip().lower()
        endpoint = OQ_MODE_ENDPOINTS.get(str(mode or "5min"), OQ_MODE_ENDPOINTS["5min"])
        payload = self._get_json(f"/games/{endpoint}/{urllib.parse.quote(account_text)}.json")
        games = payload.get("games") if isinstance(payload, dict) else payload
        if not isinstance(games, list):
            return []
        entries: list[DirectOQGameEntry] = []
        for game in games:
            if not isinstance(game, dict):
                continue
            detail = None
            if include_details and str(game.get("id") or "").strip():
                detail = self.fetch_game_detail(str(game.get("id")))
            entries.append(DirectOQGameEntry(game, detail))
        return entries

    def fetch_game_detail(self, game_id: str) -> dict[str, Any]:
        game_text = str(game_id or "").strip()
        if not game_text:
            raise HelperError("OQ game id is empty")
        payload = self._get_json(f"/game/{urllib.parse.quote(game_text)}.json")
        if not isinstance(payload, dict) or payload.get("error"):
            raise HelperError(str(payload.get("error") if isinstance(payload, dict) else "OQ game detail not found"))
        return payload


def load_oq_client_class() -> Any:
    return DirectOQClient


def parse_local_time_optional(value: str) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace(" ", "T"))
    except ValueError as exc:
        raise HelperError(f"invalid local time: {value}") from exc


def oq_entry_created_local(created_at: str | None) -> datetime | None:
    if not created_at:
        return None
    try:
        return datetime.fromisoformat(str(created_at).replace("Z", "+00:00")).astimezone(CHINA_TZ).replace(tzinfo=None)
    except ValueError:
        return None


OQ_ACCOUNT_RE = re.compile(r"^[A-Za-z0-9_]{1,14}$")
OQ_VALIDATION_MODE_ORDER = ["5min", "1min", "xot"]


def validate_oq_account_format(account: str) -> str:
    account_text = str(account or "").strip()
    if not account_text:
        return "OQ account is empty"
    if not OQ_ACCOUNT_RE.match(account_text):
        return "OQ account must be 1-14 ASCII letters, digits, or underscores"
    return ""


def invalid_oq_account_result(account: str, started: float, error: str) -> dict[str, Any]:
    return {
        "account": str(account or "").strip(),
        "ok": False,
        "status": "invalid",
        "mode": "",
        "elapsedMs": round((time.perf_counter() - started) * 1000, 1),
        "totalGames": 0,
        "windowGames": 0,
        "error": error,
    }


def oq_validation_modes(primary_mode: str) -> list[str]:
    primary = str(primary_mode or "5min").strip() or "5min"
    modes = [primary]
    for mode in OQ_VALIDATION_MODE_ORDER:
        if mode not in modes:
            modes.append(mode)
    return modes


def validate_one_oq_account(
    account: str,
    mode: str,
    start: datetime | None,
    end: datetime | None,
    base_url: str,
    timeout: int,
) -> dict[str, Any]:
    started = time.perf_counter()
    account_text = str(account or "").strip()
    format_error = validate_oq_account_format(account_text)
    if format_error:
        return invalid_oq_account_result(account_text, started, format_error)
    errors: list[str] = []
    try:
        OQClient = load_oq_client_class()
    except Exception as exc:  # noqa: BLE001
        return invalid_oq_account_result(account_text, started, str(exc))

    for candidate_mode in oq_validation_modes(mode):
        try:
            entries = OQClient(base_url=base_url, timeout=timeout).fetch_games(
                account_text,
                candidate_mode,
                include_details=False,
            )
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{candidate_mode}: {exc}")
            continue
        if not entries:
            errors.append(f"{candidate_mode}: no game history")
            continue
        window_games = 0
        if start and end:
            for entry in entries:
                created = oq_entry_created_local(getattr(entry, "created_at", None))
                if created and start <= created <= end:
                    window_games += 1
        return {
            "account": account_text,
            "ok": True,
            "status": "ok",
            "mode": candidate_mode,
            "primaryMode": mode,
            "fallbackUsed": candidate_mode != mode,
            "elapsedMs": round((time.perf_counter() - started) * 1000, 1),
            "totalGames": len(entries),
            "windowGames": window_games,
            "error": "",
        }
    return invalid_oq_account_result(account_text, started, "; ".join(errors) or "OQ account has no game history")


def validate_oq_accounts(
    accounts: list[str],
    mode: str = "5min",
    start: datetime | None = None,
    end: datetime | None = None,
    concurrency: int = 8,
    base_url: str = "http://questgames.net",
    timeout: int = 20,
    skip: bool = False,
) -> dict[str, Any]:
    cleaned: list[str] = []
    seen: set[str] = set()
    for account in accounts:
        text = str(account or "").strip()
        key = text.casefold()
        if not text or key in seen:
            continue
        cleaned.append(text)
        seen.add(key)
    started = time.perf_counter()
    results: list[dict[str, Any]] = []
    if skip:
        return {
            "ok": True,
            "mode": mode,
            "baseUrl": base_url,
            "concurrency": max(1, int(concurrency or 8)),
            "checkedAt": "",
            "wallMs": 0,
            "checkedCount": 0,
            "okCount": 0,
            "invalidCount": 0,
            "window": {"fromLocal": "", "toLocal": ""},
            "results": [],
            "byAccount": {},
            "skipped": True,
        }
    if cleaned:
        with ThreadPoolExecutor(max_workers=max(1, int(concurrency or 8))) as executor:
            futures = {
                executor.submit(validate_one_oq_account, account, mode, start, end, base_url, timeout): account
                for account in cleaned
            }
            for future in as_completed(futures):
                results.append(future.result())
    results.sort(key=lambda item: str(item.get("account") or "").casefold())
    return {
        "ok": True,
        "mode": mode,
        "baseUrl": base_url,
        "concurrency": max(1, int(concurrency or 8)),
        "checkedAt": current_iso_timestamp(),
        "wallMs": round((time.perf_counter() - started) * 1000, 1),
        "checkedCount": len(results),
        "okCount": sum(1 for item in results if item.get("ok") is True),
        "invalidCount": sum(1 for item in results if item.get("ok") is not True),
        "window": {
            "fromLocal": start.isoformat(sep=" ") if start else "",
            "toLocal": end.isoformat(sep=" ") if end else "",
        },
        "results": results,
        "byAccount": {str(item.get("account") or "").casefold(): item for item in results},
    }


def oq_check_from_result(result: dict[str, Any], checked_at: str) -> dict[str, Any]:
    ok = result.get("ok") is True
    return {
        "account": str(result.get("account") or "").strip(),
        "status": "ok" if ok else "invalid",
        "checkedAt": checked_at,
        "mode": str(result.get("mode") or ""),
        "primaryMode": str(result.get("primaryMode") or ""),
        "fallbackUsed": bool(result.get("fallbackUsed")),
        "elapsedMs": result.get("elapsedMs", 0),
        "totalGames": result.get("totalGames", 0),
        "windowGames": result.get("windowGames", 0),
        "error": "" if ok else str(result.get("error") or "OQ account validation failed"),
    }


def parse_local_time_required(value: str, label: str) -> datetime:
    parsed = parse_local_time_optional(value)
    if parsed is None:
        raise HelperError(f"{label} is required")
    return parsed


def cache_safe_local_end(now: datetime | None = None, delay_seconds: int = SCORE_SCAN_CACHE_DELAY_SECONDS) -> datetime:
    current = now or datetime.now(CHINA_TZ)
    if current.tzinfo is not None:
        current = current.astimezone(CHINA_TZ).replace(tzinfo=None)
    return current - timedelta(seconds=max(0, int(delay_seconds or 0)))


def apply_cache_delay_to_scan_range(
    start_text: str,
    end_text: str,
    end_source: str,
    now: datetime | None = None,
    delay_seconds: int = SCORE_SCAN_CACHE_DELAY_SECONDS,
) -> tuple[str, str, str, dict[str, Any]]:
    start_dt = parse_local_time_required(start_text, "--start")
    end_dt = parse_local_time_required(end_text, "--end")
    safe_end = cache_safe_local_end(now, delay_seconds)
    requested_duration = end_dt - start_dt if end_dt > start_dt else timedelta(minutes=1)
    meta: dict[str, Any] = {
        "enabled": True,
        "delaySeconds": max(0, int(delay_seconds or 0)),
        "safeEndLocal": safe_end.isoformat(sep=" ", timespec="seconds"),
        "requestedStart": start_dt.isoformat(sep=" ", timespec="seconds"),
        "requestedEnd": end_dt.isoformat(sep=" ", timespec="seconds"),
        "adjusted": False,
        "policy": "score polling does not scan the newest 60 seconds of chat history so local image cache has time to arrive",
    }
    if end_dt <= safe_end:
        return start_text, end_text, end_source, meta

    adjusted_end = safe_end
    adjusted_start = adjusted_end - requested_duration
    if adjusted_start >= adjusted_end:
        adjusted_start = adjusted_end - timedelta(minutes=1)

    adjusted_start_text = adjusted_start.isoformat(sep=" ", timespec="seconds")
    adjusted_end_text = adjusted_end.isoformat(sep=" ", timespec="seconds")
    meta.update(
        {
            "adjusted": True,
            "startLocal": adjusted_start_text,
            "endLocal": adjusted_end_text,
        }
    )
    return adjusted_start_text, adjusted_end_text, f"{end_source}-cache-delay-60s", meta


def resolve_score_scan_timing(args: argparse.Namespace, target_round: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    frontend_start_text = str(target_round.get("roundStartAt") or "").strip()
    explicit_round_start = str(getattr(args, "round_start", "") or "").strip()
    explicit_scan_start = str(getattr(args, "start", "") or "").strip()
    selected_start = explicit_scan_start
    source = "argument-start"
    should_write_frontend = False
    frontend_already_set = bool(frontend_start_text)

    if frontend_already_set:
        if not selected_start:
            selected_start = frontend_start_text
            source = "frontend-roundStartAt"
        else:
            source = "argument-start-front-end-preserved"
    elif explicit_round_start:
        selected_start = explicit_round_start
        source = "argument-round-start"
        should_write_frontend = True
    elif explicit_scan_start:
        selected_start = explicit_scan_start
        source = "argument-start"
        should_write_frontend = True
    else:
        raise HelperError(
            "score-scan needs a start time: set the round time in the frontend and click apply, "
            "or pass --start/--round-start once so the helper can sync it to the frontend"
        )

    start_dt = parse_local_time_required(selected_start, "--start")
    selected_start = start_dt.isoformat(sep=" ", timespec="seconds")
    if should_write_frontend:
        target_round["roundStartAt"] = selected_start
        target_round["roundStartSource"] = "agent-score-scan"
    elif frontend_already_set:
        target_round["roundStartAt"] = frontend_start_text
        target_round["roundStartSource"] = str(target_round.get("roundStartSource") or "frontend")

    end_text = str(getattr(args, "end", "") or "").strip()
    if end_text:
        end_source = "explicit"
    else:
        end_text = (start_dt + timedelta(minutes=40)).strftime("%Y-%m-%d %H:%M:%S")
        end_source = "start-plus-40-minutes-default"

    timing = {
        "start": selected_start,
        "end": end_text,
        "endSource": end_source,
        "startSource": source,
        "frontendRoundStartAt": str(target_round.get("roundStartAt") or ""),
        "frontendRoundStartSource": str(target_round.get("roundStartSource") or ""),
        "frontendAlreadySet": frontend_already_set,
        "syncedAgentStartToFrontend": should_write_frontend,
        "instruction": (
            "Frontend roundStartAt is already set; agents should use it and do not need score-anchor/manual time search."
            if frontend_already_set
            else "Agent-provided start time was saved to frontend roundStartAt for this round."
        ),
    }
    return timing, should_write_frontend


def oq_game_local_created(entry: Any) -> datetime | None:
    return oq_entry_created_local(getattr(entry, "created_at", None))


def game_entry_summary(entry: Any) -> dict[str, Any]:
    return {
        "gameId": str(getattr(entry, "game_id", "") or ""),
        "createdAt": str(getattr(entry, "created_at", "") or ""),
        "createdLocal": (
            oq_game_local_created(entry).isoformat(sep=" ") if oq_game_local_created(entry) else ""
        ),
        "blackName": str(getattr(entry, "black_name", "") or ""),
        "whiteName": str(getattr(entry, "white_name", "") or ""),
        "blackScore": getattr(entry, "black_score", None),
        "whiteScore": getattr(entry, "white_score", None),
        "userName": str(getattr(entry, "user_name", "") or ""),
        "opponentName": str(getattr(entry, "opponent_name", "") or ""),
        "userScore": getattr(entry, "user_score", None),
        "opponentScore": getattr(entry, "opponent_score", None),
        "result": str(getattr(entry, "result", "") or ""),
        "status": str(getattr(entry, "status", "") or ""),
        "length": getattr(entry, "length", None),
        "comment": str(getattr(entry, "comment", "") or ""),
    }


def compact_oq_candidate_text(summary: dict[str, Any]) -> str:
    if not isinstance(summary, dict):
        return "候选对局"
    created = str(summary.get("createdLocal") or summary.get("createdAt") or "").strip()
    time_text = created[11:16] if len(created) >= 16 else created
    black_name = str(summary.get("blackName") or "").strip()
    white_name = str(summary.get("whiteName") or "").strip()
    black_score = summary.get("blackScore")
    white_score = summary.get("whiteScore")
    score_text = ""
    try:
        if black_score is not None and white_score is not None:
            score_text = f"{int(black_score)}-{int(white_score)}"
    except (TypeError, ValueError):
        score_text = ""
    winner = ""
    try:
        if black_score is not None and white_score is not None:
            b = int(black_score)
            w = int(white_score)
            if b > w:
                winner = f"{black_name}胜" if black_name else "黑方胜"
            elif w > b:
                winner = f"{white_name}胜" if white_name else "白方胜"
            else:
                winner = "平局"
    except (TypeError, ValueError):
        winner = ""
    parts = [part for part in (time_text, score_text, winner) if part]
    if parts:
        return " ".join(parts)
    game_id = str(summary.get("gameId") or "").strip()
    return f"候选对局 {game_id}" if game_id else "候选对局"


def compact_oq_pending_text(
    table_info: dict[str, Any],
    candidates: list[dict[str, Any]],
    user_locked: bool = False,
) -> str:
    table = table_info.get("table")
    pairing = table_info.get("pairing") if isinstance(table_info.get("pairing"), dict) else {}
    black = str(pairing.get("black") or table_info.get("blackFtdName") or "").strip()
    white = str(pairing.get("white") or table_info.get("whiteFtdName") or "").strip()
    black_account = str(table_info.get("blackAccount") or "").strip()
    white_account = str(table_info.get("whiteAccount") or "").strip()
    candidate_texts = [
        compact_oq_candidate_text(item.get("summary") if isinstance(item, dict) else {})
        for item in candidates[:3]
    ]
    if not candidate_texts:
        candidate_part = "未找到可直接采用的 OQ 对局"
    elif len(candidates) == 1:
        candidate_part = f"候选1局：{candidate_texts[0]}"
    else:
        candidate_part = f"候选{len(candidates)}局：" + "；".join(candidate_texts)
    lock_text = "；该桌已有用户编辑，未覆盖" if user_locked else ""
    return (
        f"第{table}台 {black}({black_account or '无账号'}) vs "
        f"{white}({white_account or '无账号'})；{candidate_part}{lock_text}"
    )


def oq_candidate_detail_summaries(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for item in candidates[:8]:
        if not isinstance(item, dict):
            continue
        detail = item.get("pendingDetail")
        if isinstance(detail, dict):
            out.append(detail)
        else:
            summary = item.get("summary") if isinstance(item.get("summary"), dict) else {}
            if summary:
                out.append(summary)
    return out


def oq_account_key(value: Any) -> str:
    return normalize_name_key(value)


def oq_score_from_normal_scores(black_raw: Any, white_raw: Any) -> tuple[int, int]:
    black = int_score(black_raw)
    white = int_score(white_raw)
    if black is None or white is None:
        raise HelperError("OQ game has no usable numeric score")
    if black == white:
        if black != 32:
            raise HelperError(f"OQ draw score is not 32-32: {black}-{white}")
        return 32, 32
    if black < white:
        return black, 64 - black
    return 64 - white, white


OQ_MOVE_RE = re.compile(r"^[a-h][1-8]$", re.IGNORECASE)
OQ_COORD_SCAN_RE = re.compile(r"[a-h][1-8]", re.IGNORECASE)
OQ_BLACK = "black"
OQ_WHITE = "white"
OQ_DIRECTIONS = (
    (-1, -1),
    (-1, 0),
    (-1, 1),
    (0, -1),
    (0, 1),
    (1, -1),
    (1, 0),
    (1, 1),
)


def oq_opponent_color(color: str) -> str:
    return OQ_WHITE if color == OQ_BLACK else OQ_BLACK


def oq_initial_board() -> dict[tuple[int, int], str]:
    return {
        oq_coord_to_square("d4"): OQ_WHITE,
        oq_coord_to_square("e5"): OQ_WHITE,
        oq_coord_to_square("d5"): OQ_BLACK,
        oq_coord_to_square("e4"): OQ_BLACK,
    }


def oq_coord_to_square(coord: str) -> tuple[int, int]:
    text = str(coord or "").strip().lower()
    if not OQ_MOVE_RE.match(text):
        raise HelperError(f"bad OQ move coordinate: {coord}")
    return int(text[1]) - 1, ord(text[0]) - ord("a")


def oq_legal_flips(
    board: dict[tuple[int, int], str],
    square: tuple[int, int],
    color: str,
) -> list[tuple[int, int]]:
    if square in board:
        return []
    opponent = oq_opponent_color(color)
    out: list[tuple[int, int]] = []
    row, col = square
    for dr, dc in OQ_DIRECTIONS:
        r = row + dr
        c = col + dc
        captured: list[tuple[int, int]] = []
        while 0 <= r < 8 and 0 <= c < 8:
            value = board.get((r, c))
            if value == opponent:
                captured.append((r, c))
            elif value == color:
                if captured:
                    out.extend(captured)
                break
            else:
                break
            r += dr
            c += dc
    return out


def oq_legal_moves(board: dict[tuple[int, int], str], color: str) -> set[tuple[int, int]]:
    return {
        (row, col)
        for row in range(8)
        for col in range(8)
        if oq_legal_flips(board, (row, col), color)
    }


def oq_apply_move(
    board: dict[tuple[int, int], str],
    color: str,
    coord: str,
    move_index: int,
) -> str:
    square = oq_coord_to_square(coord)
    flips = oq_legal_flips(board, square, color)
    if not flips:
        raise HelperError(f"illegal OQ move at ply {move_index}: {coord}")
    board[square] = color
    for item in flips:
        board[item] = color
    return oq_opponent_color(color)


def oq_extract_detail_from_entry(entry: Any) -> dict[str, Any]:
    for attr in ("detail", "raw_detail", "game_detail"):
        value = getattr(entry, attr, None)
        if isinstance(value, dict):
            return value
    raw_metadata = getattr(entry, "raw_metadata_json", None)
    if isinstance(raw_metadata, str) and raw_metadata.strip():
        try:
            parsed = json.loads(raw_metadata)
        except json.JSONDecodeError as exc:
            raise HelperError(f"OQ detail metadata is not valid JSON: {exc}") from exc
        if isinstance(parsed, dict):
            detail = parsed.get("detail")
            if isinstance(detail, dict):
                return detail
            summary = parsed.get("summary")
            if isinstance(summary, dict) and isinstance(summary.get("position"), dict):
                return summary
    if isinstance(entry, dict):
        detail = entry.get("detail")
        if isinstance(detail, dict):
            return detail
        if isinstance(entry.get("position"), dict):
            return entry
    raise HelperError("OQ game detail with position.moves is required for automatic SCORE scoring")


def oq_detail_start_coords(detail: dict[str, Any]) -> list[str]:
    raw = ((detail.get("position") or {}).get("startPos") or "")
    if not isinstance(raw, str):
        return []
    return [match.group(0).lower() for match in OQ_COORD_SCAN_RE.finditer(raw)]


def oq_detail_moves(detail: dict[str, Any]) -> list[Any]:
    moves = ((detail.get("position") or {}).get("moves") or [])
    if not isinstance(moves, list):
        raise HelperError("OQ detail position.moves is not a list")
    return moves


def oq_replay_detail_final_scores(detail: dict[str, Any]) -> tuple[int, int, dict[str, Any]]:
    board = oq_initial_board()
    color = OQ_BLACK
    played = 0
    explicit_passes = 0
    start_coords = oq_detail_start_coords(detail)
    for coord in start_coords:
        played += 1
        color = oq_apply_move(board, color, coord, played)

    for index, move in enumerate(oq_detail_moves(detail), start=1):
        if not isinstance(move, dict):
            continue
        raw_move = move.get("m")
        if isinstance(raw_move, str) and OQ_MOVE_RE.match(raw_move.strip()):
            played += 1
            color = oq_apply_move(board, color, raw_move.strip().lower(), played)
            continue
        if str(raw_move or "").strip() == "-":
            if oq_legal_moves(board, color):
                raise HelperError(f"OQ explicit pass at move {index} while {color} has legal moves")
            explicit_passes += 1
            color = oq_opponent_color(color)

    black_discs = sum(1 for value in board.values() if value == OQ_BLACK)
    white_discs = sum(1 for value in board.values() if value == OQ_WHITE)
    empty = 64 - black_discs - white_discs
    if black_discs > white_discs:
        black_score = black_discs + empty
        white_score = white_discs
    elif white_discs > black_discs:
        black_score = black_discs
        white_score = white_discs + empty
    else:
        if empty % 2:
            raise HelperError(f"OQ replay ended tied with odd empty count: {black_discs}-{white_discs}, empty {empty}")
        black_score = black_discs + empty // 2
        white_score = white_discs + empty // 2
    validate_score_pair(black_score, white_score)
    return black_score, white_score, {
        "blackDiscs": black_discs,
        "whiteDiscs": white_discs,
        "empty": empty,
        "playedMoves": played,
        "explicitPasses": explicit_passes,
        "startPosMoveCount": len(start_coords),
    }


def oq_terminal_status_parts(value: Any) -> tuple[str, str]:
    text = str(value or "").strip()
    match = re.match(r"^(WIN|LOSE)\s*:\s*([A-Z_]+)", text, flags=re.IGNORECASE)
    if not match:
        return "", ""
    return match.group(1).lower(), match.group(2).lower()


def oq_terminal_cause_from_status(value: Any) -> str:
    _, cause = oq_terminal_status_parts(value)
    if cause in {"resign", "timeup", "timeout", "disconnect", "disconnected"}:
        return "timeout" if cause == "timeup" else cause
    return ""


def oq_replay_terminal_loser_color(detail: dict[str, Any]) -> tuple[str, str, dict[str, Any]]:
    board = oq_initial_board()
    color = OQ_BLACK
    played = 0
    explicit_passes = 0
    start_coords = oq_detail_start_coords(detail)
    for coord in start_coords:
        played += 1
        color = oq_apply_move(board, color, coord, played)

    for index, move in enumerate(oq_detail_moves(detail), start=1):
        if not isinstance(move, dict):
            continue
        terminal_result, terminal_cause = oq_terminal_status_parts(move.get("s"))
        if terminal_cause in {"resign", "timeup", "timeout", "disconnect", "disconnected"}:
            cause = "timeout" if terminal_cause == "timeup" else terminal_cause
            if terminal_result == "lose":
                loser_color = color
            elif terminal_result == "win":
                loser_color = oq_opponent_color(color)
            else:
                raise HelperError(f"OQ terminal status has no WIN/LOSE result: {move.get('s')}")
            return loser_color, cause, {
                "moveIndex": index,
                "status": str(move.get("s") or ""),
                "sideToMove": color,
                "playedMoves": played,
                "explicitPasses": explicit_passes,
                "startPosMoveCount": len(start_coords),
            }

        raw_move = move.get("m")
        if isinstance(raw_move, str) and OQ_MOVE_RE.match(raw_move.strip()):
            played += 1
            color = oq_apply_move(board, color, raw_move.strip().lower(), played)
            continue
        if str(raw_move or "").strip() == "-":
            if oq_legal_moves(board, color):
                raise HelperError(f"OQ explicit pass at move {index} while {color} has legal moves")
            explicit_passes += 1
            color = oq_opponent_color(color)

    raise HelperError("OQ terminal resign/timeout/disconnect status not found in position.moves")


def oq_score_from_entry(entry: Any) -> tuple[int, int, str]:
    status = str(getattr(entry, "status", "") or "").lower()
    detail = oq_extract_detail_from_entry(entry)
    terminal_cause = status if status in {"resign", "timeout", "disconnect", "disconnected"} else ""
    if not terminal_cause:
        terminal_cause = oq_terminal_cause_from_status(status)
    if not terminal_cause:
        terminal_match = re.search(
            r"\bterminal_status\s*=\s*(WIN|LOSE)\s*:\s*([A-Z_]+)",
            str(getattr(entry, "comment", "") or ""),
            flags=re.IGNORECASE,
        )
        if terminal_match:
            terminal_cause = oq_terminal_cause_from_status(f"{terminal_match.group(1)}:{terminal_match.group(2)}")
    if terminal_cause in {"resign", "timeout", "disconnect", "disconnected"}:
        loser_color, cause, replay = oq_replay_terminal_loser_color(detail)
        if loser_color == OQ_BLACK:
            return 0, 64, f"{cause}: black lost by replayed OQ terminal status {replay['status']} at move {replay['moveIndex']}"
        return 64, 0, f"{cause}: white lost by replayed OQ terminal status {replay['status']} at move {replay['moveIndex']}"

    black_score, white_score, replay = oq_replay_detail_final_scores(detail)
    reason = (
        "normal score: replayed OQ position.moves and awarded empty squares to winner "
        f"(board {replay['blackDiscs']}-{replay['whiteDiscs']}, empty {replay['empty']})"
    )
    return black_score, white_score, reason


def oq_score_kind_from_reason(reason: Any) -> str:
    text = str(reason or "").lower()
    if "disconnect" in text or "disconnected" in text:
        return "disconnect"
    if "timeout" in text or "timeup" in text:
        return "timeout"
    if "resign" in text:
        return "resign"
    if "normal score" in text:
        return "normal"
    return "unknown"


def oq_stored_game_detail(entry: Any) -> dict[str, Any]:
    try:
        detail = oq_extract_detail_from_entry(entry)
    except Exception:  # noqa: BLE001
        return {}
    return detail if isinstance(detail, dict) else {}


def oq_account_scores_from_entry(entry: Any) -> tuple[dict[str, int], str]:
    black_score, white_score, reason = oq_score_from_entry(entry)
    black_key = oq_account_key(getattr(entry, "black_name", ""))
    white_key = oq_account_key(getattr(entry, "white_name", ""))
    if not black_key or not white_key:
        raise HelperError("OQ game has no usable black/white account names")
    if black_key == white_key:
        raise HelperError("OQ game black/white account names collapse to the same key")
    return {black_key: black_score, white_key: white_score}, f"{reason}; mapped by OQ account to FTD players"


def oq_scores_for_ftd_pairing(entry: Any, table_info: dict[str, Any]) -> tuple[int, int, str, dict[str, int]]:
    account_scores, reason = oq_account_scores_from_entry(entry)
    ftd_black_key = oq_account_key(table_info.get("blackAccount"))
    ftd_white_key = oq_account_key(table_info.get("whiteAccount"))
    if not ftd_black_key or not ftd_white_key:
        raise HelperError("FTD pairing has no usable OQ accounts")
    if ftd_black_key not in account_scores or ftd_white_key not in account_scores:
        raise HelperError("OQ account scores do not match both FTD pairing accounts")
    black_score = account_scores[ftd_black_key]
    white_score = account_scores[ftd_white_key]
    validate_score_pair(black_score, white_score)
    return black_score, white_score, reason, account_scores


def build_oq_pending_candidate_detail(
    candidate: dict[str, Any],
    table_info: dict[str, Any],
    base_url: str,
    timeout: int,
    detail_cache: dict[str, dict[str, Any]],
) -> tuple[dict[str, Any], bool, str]:
    entry = candidate.get("entry")
    fetched_detail = False
    error = ""
    try:
        if oq_entry_requires_detail_for_score(entry):
            entry, fetched_detail = oq_entry_with_detail(entry, base_url, timeout, detail_cache)
            candidate["entry"] = entry
        black_score, white_score, score_reason, account_scores = oq_scores_for_ftd_pairing(entry, table_info)
        summary = game_entry_summary(entry)
        result_time = summary.get("createdLocal") or summary.get("createdAt") or ""
        detail = {
            "candidateKey": oq_candidate_key(entry),
            "gameId": summary.get("gameId") or "",
            "createdAt": summary.get("createdAt") or "",
            "createdLocal": result_time,
            "blackAccount": str(getattr(entry, "black_name", "") or summary.get("blackName") or ""),
            "whiteAccount": str(getattr(entry, "white_name", "") or summary.get("whiteName") or ""),
            "ftdBlackAccount": table_info.get("blackAccount") or "",
            "ftdWhiteAccount": table_info.get("whiteAccount") or "",
            "blackScore": black_score,
            "whiteScore": white_score,
            "resultTime": result_time,
            "resultSortKey": score_result_sort_key(result_time),
            "resultKind": "oq-auto",
            "endingKind": oq_score_kind_from_reason(score_reason),
            "scoreReason": score_reason,
            "seenFromAccounts": candidate.get("seenFromAccounts") or [],
            "accountScores": account_scores,
            "gameDetail": oq_stored_game_detail(entry),
        }
    except Exception as exc:  # noqa: BLE001
        summary = candidate.get("summary") if isinstance(candidate.get("summary"), dict) else {}
        detail = {
            "candidateKey": oq_candidate_key(entry),
            "gameId": summary.get("gameId") or str(getattr(entry, "game_id", "") or ""),
            "createdAt": summary.get("createdAt") or str(getattr(entry, "created_at", "") or ""),
            "createdLocal": summary.get("createdLocal") or "",
            "blackAccount": summary.get("blackName") or str(getattr(entry, "black_name", "") or ""),
            "whiteAccount": summary.get("whiteName") or str(getattr(entry, "white_name", "") or ""),
            "ftdBlackAccount": table_info.get("blackAccount") or "",
            "ftdWhiteAccount": table_info.get("whiteAccount") or "",
            "seenFromAccounts": candidate.get("seenFromAccounts") or [],
            "gameDetail": oq_stored_game_detail(entry),
            "error": str(exc),
        }
        error = str(exc)
    return detail, fetched_detail, error


def ftd_pairing_user_edited_fields(pairing: dict[str, Any]) -> set[str]:
    fields = pairing.get("userEditedFields") if isinstance(pairing.get("userEditedFields"), dict) else {}
    return {str(key) for key, value in fields.items() if value}


def ftd_pairing_has_user_score_lock(pairing: dict[str, Any]) -> bool:
    if not isinstance(pairing, dict):
        return False
    locked = ftd_pairing_user_edited_fields(pairing)
    protected = {
        "status",
        "reporter",
        "opponent",
        "blackScore",
        "whiteScore",
        "resultText",
        "reason",
        "imagePath",
        "sourceMessageKey",
        "resultKind",
        "completedAt",
        "userPending",
    }
    if locked & protected:
        return True
    if str(pairing.get("lastEditedBy") or "") != "user":
        return False
    status = str(pairing.get("status") or "imported")
    if status in {"ready", "completed", "dirty"}:
        return True
    if str(pairing.get("sourceMessageKey") or "").strip():
        return True
    if str(pairing.get("resultText") or "").strip():
        return True
    if str(pairing.get("reason") or "").strip():
        return True
    black_score = int_score(pairing.get("blackScore"))
    white_score = int_score(pairing.get("whiteScore"))
    if black_score is not None and white_score is not None and black_score + white_score == 64:
        return True
    return False


def score_result_time_text(value: Any) -> str:
    return normalize_text_like(value)


def score_result_sort_key(value: Any) -> int:
    text = score_result_time_text(value)
    if not text:
        return 0
    try:
        numeric = float(text)
    except (TypeError, ValueError):
        numeric = None
    if numeric is not None:
        if numeric <= 0:
            return 0
        return int(numeric if numeric > 10_000_000_000 else numeric * 1000)
    parsed = parse_local_time_optional(text)
    if parsed is not None:
        return int(parsed.timestamp() * 1000)
    return 0


def local_time_text_from_epoch_ms(value: Any) -> str:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return ""
    if numeric <= 0:
        return ""
    seconds = numeric / 1000 if numeric > 10_000_000_000 else numeric
    return datetime.fromtimestamp(seconds, CHINA_TZ).replace(tzinfo=None).isoformat(sep=" ", timespec="seconds")


def source_message_key_time_text(value: Any) -> str:
    text = normalize_text_like(value)
    if not text:
        return ""
    first = text.split(":", 1)[0].strip()
    if not re.fullmatch(r"\d+(?:\.\d+)?", first):
        return ""
    return local_time_text_from_epoch_ms(first)


CHINESE_ROUND_DIGITS = {
    0: "零",
    1: "一",
    2: "二",
    3: "三",
    4: "四",
    5: "五",
    6: "六",
    7: "七",
    8: "八",
    9: "九",
    10: "十",
}


def chinese_round_number(value: int) -> str:
    if value in CHINESE_ROUND_DIGITS:
        return CHINESE_ROUND_DIGITS[value]
    if 10 < value < 20:
        return "十" + CHINESE_ROUND_DIGITS[value % 10]
    if 20 <= value < 100:
        tens = value // 10
        ones = value % 10
        return CHINESE_ROUND_DIGITS[tens] + "十" + (CHINESE_ROUND_DIGITS[ones] if ones else "")
    return str(value)


def message_day_from_epoch_ms(value: Any) -> str:
    text = local_time_text_from_epoch_ms(value)
    return text[:10] if len(text) >= 10 else ""


def normalize_anchor_date(value: Any) -> str:
    text = normalize_text_like(value)
    if not text:
        return ""
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        return text
    parsed = parse_local_time_optional(text)
    if parsed is None:
        return ""
    return parsed.strftime("%Y-%m-%d")


def infer_score_anchor_date(state: dict[str, Any], round_item: dict[str, Any]) -> tuple[str, str]:
    for value, source in (
        (round_item.get("roundStartAt"), "scoreHelper.round.roundStartAt"),
        (round_item.get("importedAt"), "scoreHelper.round.importedAt"),
        (state.get("savedAt"), "state.savedAt"),
    ):
        if value in (None, ""):
            continue
        if isinstance(value, (int, float)):
            day = message_day_from_epoch_ms(value)
        else:
            day = normalize_anchor_date(value)
        if day:
            return day, source
    return datetime.now(CHINA_TZ).strftime("%Y-%m-%d"), "today"


def ftd_round_max_table(round_item: dict[str, Any]) -> int:
    pairings = round_item.get("ftdPairings") if isinstance(round_item.get("ftdPairings"), list) else []
    max_table = 0
    for pairing in pairings:
        if not isinstance(pairing, dict):
            continue
        table = normalize_text_like(pairing.get("table"))
        match = re.search(r"\d+", table)
        if not match:
            continue
        max_table = max(max_table, int(match.group(0)))
    return max_table


def score_anchor_keywords(round_no: int, max_table: int, keyword_limit: int = 20) -> list[dict[str, Any]]:
    round_keywords: list[dict[str, Any]] = [
        {"kind": "round", "keyword": f"第{round_no}轮"},
        {"kind": "round", "keyword": f"第 {round_no} 轮"},
        {"kind": "round", "keyword": f"第{chinese_round_number(round_no)}轮"},
        {"kind": "round", "keyword": f"第 {chinese_round_number(round_no)} 轮"},
    ]
    password_keywords: list[dict[str, Any]] = []
    round_prefix = f"{round_no:02d}"
    for table in range(1, max(0, max_table) + 1):
        password_keywords.append({"kind": "password", "table": table, "keyword": f"{round_prefix}{table:02d}"})
    seen = set()
    out: list[dict[str, Any]] = []
    limit = max(0, int(keyword_limit or 0))
    for item in [*round_keywords, *password_keywords]:
        key = str(item.get("keyword") or "")
        if not key or key in seen:
            continue
        if limit and len(out) >= limit:
            break
        seen.add(key)
        out.append(item)
    return out


def semifinal_anchor_keywords(semi_round_no: int, keyword_limit: int = 10) -> list[dict[str, Any]]:
    keywords: list[dict[str, Any]] = [
        {"kind": "round", "stage": "semifinal", "keyword": "半决赛"},
        {"kind": "round", "stage": "semifinal", "keyword": "半决"},
        {"kind": "round", "stage": "semifinal", "keyword": "半决赛配对"},
        {"kind": "round", "stage": "semifinal", "keyword": "半决赛对阵"},
        {"kind": "password", "stage": "semifinal", "table": 1, "keyword": f"{semi_round_no:02d}01"},
        {"kind": "password", "stage": "semifinal", "table": 2, "keyword": f"{semi_round_no:02d}02"},
    ]
    seen = set()
    out: list[dict[str, Any]] = []
    limit = max(0, int(keyword_limit or 0))
    for item in keywords:
        key = str(item.get("keyword") or "")
        if not key or key in seen:
            continue
        if limit and len(out) >= limit:
            break
        seen.add(key)
        out.append(item)
    return out


def finals_anchor_keywords(keyword_limit: int = 10) -> list[dict[str, Any]]:
    keywords: list[dict[str, Any]] = [
        {"kind": "round", "stage": "finals", "keyword": "决赛"},
        {"kind": "round", "stage": "finals", "keyword": "3/4决赛"},
        {"kind": "round", "stage": "finals", "keyword": "三四名决赛"},
        {"kind": "round", "stage": "finals", "keyword": "季军赛"},
    ]
    limit = max(1, int(keyword_limit or 10))
    return keywords[:limit]


def max_imported_ftd_round(score_helper: dict[str, Any]) -> int:
    rounds = score_helper.get("rounds") if isinstance(score_helper.get("rounds"), list) else []
    max_round = 0
    for index, item in enumerate(rounds, start=1):
        if not isinstance(item, dict):
            continue
        pairings = item.get("ftdPairings") if isinstance(item.get("ftdPairings"), list) else []
        if not pairings:
            continue
        try:
            round_no = int(item.get("round") or index)
        except (TypeError, ValueError):
            round_no = index
        max_round = max(max_round, round_no)
    return max_round


def score_helper_round_item(score_helper: dict[str, Any], round_no: int) -> dict[str, Any] | None:
    rounds = score_helper.get("rounds") if isinstance(score_helper.get("rounds"), list) else []
    if 1 <= round_no <= len(rounds) and isinstance(rounds[round_no - 1], dict):
        return rounds[round_no - 1]
    return None


def next_score_stage_keywords(
    score_helper: dict[str, Any],
    current_round: int,
    current_max_table: int,
    keyword_limit: int = 10,
) -> dict[str, Any]:
    max_imported_round = max_imported_ftd_round(score_helper)
    try:
        prelim_round_count = int(
            score_helper.get("preliminaryRoundCount")
            or max(0, int(score_helper.get("roundCount") or 0) - 2)
        )
    except (TypeError, ValueError):
        prelim_round_count = 0
    current_item = score_helper_round_item(score_helper, int(current_round)) or {}
    current_stage = str(current_item.get("stage") or "preliminary").strip()
    if current_stage == "semifinal":
        return {
            "stage": "finals",
            "round": int(current_round) + 1,
            "currentRound": current_round,
            "prelimRoundCount": prelim_round_count,
            "maxTable": 2,
            "keywords": finals_anchor_keywords(keyword_limit),
            "keywordPolicy": "semifinal polling uses final and third-place boundary keywords; both games share one local finals stage",
        }
    if current_stage == "finals":
        return {
            "stage": "complete",
            "round": int(current_round),
            "currentRound": current_round,
            "prelimRoundCount": prelim_round_count,
            "maxTable": 2,
            "keywords": [],
            "keywordPolicy": "the combined final/third-place stage is the last score-helper stage",
        }
    is_last_prelim = bool(prelim_round_count and int(current_round) == prelim_round_count)
    if is_last_prelim:
        semi_round = max(1, max_imported_round) + 1
        return {
            "stage": "semifinal",
            "round": semi_round,
            "currentRound": current_round,
            "maxImportedRound": max_imported_round,
            "prelimRoundCount": prelim_round_count,
            "maxTable": 2,
            "keywords": semifinal_anchor_keywords(semi_round, keyword_limit),
            "keywordPolicy": "last preliminary round uses semifinal boundary keywords only: 半决赛 plus passwords 0n01/0n02 where n is max imported preliminary round + 1; final keywords are intentionally not generated",
        }
    next_round = int(current_round) + 1
    next_round_item = score_helper_round_item(score_helper, next_round)
    next_max_table = ftd_round_max_table(next_round_item) if isinstance(next_round_item, dict) else 0
    max_table = next_max_table or max(1, int(current_max_table or 1))
    return {
        "stage": "preliminary",
        "round": next_round,
        "currentRound": current_round,
        "maxImportedRound": max_imported_round,
        "prelimRoundCount": prelim_round_count,
        "maxTable": max_table,
        "keywords": score_anchor_keywords(next_round, max_table, keyword_limit),
        "keywordPolicy": "preliminary score polling uses next preliminary round keywords and zero-padded round/table passwords; semifinal/final keywords are not used before the last preliminary round",
    }


def content_matches_keyword(content: str, keyword: str) -> bool:
    if not keyword:
        return False
    if keyword in content:
        return True
    compact_content = normalize(content)
    compact_keyword = normalize(keyword)
    return bool(compact_keyword and compact_keyword in compact_content)


def score_anchor_match_message(message: dict[str, Any], keywords: list[dict[str, Any]]) -> dict[str, Any] | None:
    content = str(message.get("content") or "")
    matched = []
    for item in keywords:
        keyword = str(item.get("keyword") or "")
        if content_matches_keyword(content, keyword):
            matched.append(dict(item))
    if not matched:
        return None
    return {
        "time": message.get("time") or local_time_text_from_epoch_ms(int(message.get("timestamp") or 0) * 1000),
        "timestamp": int(message.get("timestamp") or 0),
        "localId": message.get("local_id"),
        "matchedKeywords": matched,
        "content": console_safe_text(content),
    }


def score_anchor_round_item(state: dict[str, Any], round_no: int) -> dict[str, Any]:
    helper = state.get("scoreHelper") if isinstance(state.get("scoreHelper"), dict) else {}
    rounds = helper.get("rounds") if isinstance(helper.get("rounds"), list) else []
    if round_no < 1 or round_no > len(rounds) or not isinstance(rounds[round_no - 1], dict):
        raise HelperError(f"第 {round_no} 轮没有本地 scoreHelper 轮次数据")
    round_item = rounds[round_no - 1]
    pairings = round_item.get("ftdPairings") if isinstance(round_item.get("ftdPairings"), list) else []
    if not pairings:
        raise HelperError(f"第 {round_no} 轮没有 FTD 配对表；无法按桌号密码生成 anchor 关键词")
    return round_item


def score_anchor_search_text_messages(
    group_name: str,
    start: str,
    end: str,
    keywords: list[dict[str, Any]],
    page_size: int,
    max_pages: int,
) -> tuple[list[dict[str, Any]], int, dict[str, Any]]:
    """Search text messages without sender mapping for keyword/time anchor search."""
    mapping_payload = agent_checkin_bridge.load_member_map(group_name)
    username = mapping_payload["room_username"]
    ctx = mcp_server._resolve_chat_context(username)
    if not ctx or not ctx.get("message_tables"):
        raise HelperError(f"Cannot find message tables for {username}")
    start_ts, end_ts = parse_time_range(start, end)
    batch_size = max(1, int(page_size or 1000))

    matches = []
    scanned = 0
    failures = []
    names = mcp_server.get_contact_names()
    for table_ctx in mcp_server._iter_table_contexts(ctx):
        try:
            with closing(sqlite3.connect(table_ctx["db_path"])) as conn:
                fetch_offset = 0
                page_count = 0
                while True:
                    if max_pages and page_count >= max_pages:
                        break
                    rows = mcp_server._query_messages(
                        conn,
                        table_ctx["table_name"],
                        start_ts=start_ts,
                        end_ts=end_ts,
                        limit=mcp_server._history_query_batch_size(batch_size),
                        offset=fetch_offset,
                        oldest_first=True,
                        type_filter=[1],
                    )
                    if not rows:
                        break
                    fetch_offset += len(rows)
                    page_count += 1
                    for row in rows:
                        local_id, local_type, create_time, real_sender_id, content, ct = row
                        decoded = mcp_server._decompress_content(content, ct)
                        if decoded is None:
                            decoded = ""
                        _sender_from_content, text = mcp_server._format_message_text(
                            local_id,
                            local_type,
                            decoded,
                            True,
                            ctx["username"],
                            ctx["display_name"],
                            names,
                            create_time=create_time,
                        )
                        scanned += 1
                        matched = score_anchor_match_message(
                            {
                                "local_id": int(local_id),
                                "timestamp": int(create_time or 0),
                                "time": datetime.fromtimestamp(create_time).strftime("%Y-%m-%d %H:%M:%S"),
                                "content": text,
                            },
                            keywords,
                        )
                        if matched is not None:
                            matches.append(matched)
                    if len(rows) < mcp_server._history_query_batch_size(batch_size):
                        break
        except Exception as exc:  # noqa: BLE001
            failures.append(f"{table_ctx['db_path']}: {exc}")
    if failures:
        raise HelperError("Failed reading score-anchor text messages:\n" + "\n".join(failures))
    matches.sort(key=lambda item: (int(item.get("timestamp") or 0), int(item.get("localId") or 0)))
    metadata = {
        "schema_version": 1,
        "export_kind": "score_anchor_text_search",
        "group_name": mapping_payload.get("group_name") or group_name,
        "room_username": username,
        "range": {"start": start, "end": end},
        "pageSize": batch_size,
        "maxPages": int(max_pages or 0),
        "sender_policy": "sender intentionally not read or mapped; score-anchor only needs message time and content",
    }
    return matches, scanned, metadata


def keyword_group_matches(matches: list[dict[str, Any]], limit: int = 10) -> list[dict[str, Any]]:
    out = []
    for item in matches:
        if not isinstance(item, dict):
            continue
        out.append(item)
        if len(out) >= max(1, int(limit or 10)):
            break
    return out


def first_anchor_time(matches: list[dict[str, Any]]) -> datetime | None:
    if not matches:
        return None
    for item in sorted(matches, key=lambda value: (int(value.get("timestamp") or 0), int(value.get("localId") or 0))):
        timestamp = int(item.get("timestamp") or 0)
        if timestamp > 0:
            return datetime.fromtimestamp(timestamp, CHINA_TZ).replace(tzinfo=None)
        parsed = parse_local_time_optional(str(item.get("time") or ""))
        if parsed is not None:
            return parsed
    return None


def infer_oq_time_window_from_keywords(
    group_name: str,
    state: dict[str, Any],
    score_helper: dict[str, Any],
    round_item: dict[str, Any],
    round_no: int,
    fallback_start: datetime,
    fallback_minutes: int,
    search_start: str,
    search_end: str,
    page_size: int,
    max_pages: int,
) -> dict[str, Any]:
    current_max_table = ftd_round_max_table(round_item)
    current_keywords = score_anchor_keywords(round_no, current_max_table, 10)
    next_stage = next_score_stage_keywords(score_helper, round_no, current_max_table, 10)
    current_matches, current_scanned, current_metadata = score_anchor_search_text_messages(
        group_name,
        search_start,
        search_end,
        current_keywords,
        page_size,
        max_pages,
    )
    next_matches, next_scanned, next_metadata = score_anchor_search_text_messages(
        group_name,
        search_start,
        search_end,
        next_stage["keywords"],
        page_size,
        max_pages,
    )
    current_limited = keyword_group_matches(current_matches, 10)
    next_limited = keyword_group_matches(next_matches, 10)
    inferred_start = first_anchor_time(current_limited) or fallback_start
    inferred_end = first_anchor_time(next_limited)
    source = "keyword-boundary" if current_limited and inferred_end else "keyword-start-fallback-duration"
    if inferred_end is None or inferred_end <= inferred_start:
        inferred_end = inferred_start + timedelta(minutes=max(1, int(fallback_minutes or 40)))
        if not current_limited:
            source = "fallback-start-duration"
    return {
        "start": inferred_start,
        "end": inferred_end,
        "source": source,
        "fallbackMinutes": max(1, int(fallback_minutes or 40)),
        "searchRange": {"start": search_start, "end": search_end},
        "currentRound": round_no,
        "currentKeywords": current_keywords,
        "currentKeywordMatchCount": len(current_matches),
        "currentKeywordMatches": current_limited,
        "currentKeywordScanned": current_scanned,
        "currentKeywordSearchMetadata": current_metadata,
        "nextStage": {key: value for key, value in next_stage.items() if key != "keywords"},
        "nextStageKeywords": next_stage["keywords"],
        "nextStageKeywordMatchCount": len(next_matches),
        "nextStageKeywordMatches": next_limited,
        "nextStageKeywordScanned": next_scanned,
        "nextStageKeywordSearchMetadata": next_metadata,
        "policy": "OQ auto lookup uses at most 10 current-round keyword hits and 10 next-stage keyword hits to infer the game window; if no next-stage time exists, it falls back to start + oq-window-minutes. Last preliminary round uses semifinal boundary keywords only and never final keywords.",
    }


def cmd_score_anchor(args: argparse.Namespace) -> int:
    state = read_frontend_state(Path(args.frontend_state), args.direct_file)
    round_no = int(args.round)
    round_item = score_anchor_round_item(state, round_no)
    max_table = int(args.max_table or ftd_round_max_table(round_item))
    if max_table <= 0:
        raise HelperError(f"第 {round_no} 轮 FTD 配对表没有可用桌号")
    if args.date:
        target_date = normalize_anchor_date(args.date)
        date_source = "--date"
        if not target_date:
            raise HelperError(f"invalid --date: {args.date}")
    else:
        target_date, date_source = infer_score_anchor_date(state, round_item)
    start = args.start or f"{target_date} 00:00:00"
    end = args.end or f"{target_date} 23:59:59"
    keywords = score_anchor_keywords(round_no, max_table, int(args.keyword_limit or 0))
    matches, fetched, search_metadata = score_anchor_search_text_messages(
        args.group,
        start,
        end,
        keywords,
        int(args.page_size or 1000),
        int(args.max_pages or 0),
    )
    payload = {
        "ok": True,
        "action": "score-anchor",
        "round": round_no,
        "date": target_date,
        "dateSource": date_source,
        "range": {"start": start, "end": end},
        "maxTable": max_table,
        "keywordPolicy": "round keywords plus password keywords only; table passwords are zero-padded round+table, e.g. 0203 or 0504, not bare table numbers",
        "keywordLimit": int(args.keyword_limit or 0),
        "keywordLimitPolicy": "default total keyword limit is 20; round keywords are kept first, then password keywords from low table numbers upward; 0 means no limit",
        "keywords": keywords,
        "messageCountScanned": fetched,
        "searchMetadata": search_metadata,
        "matchCount": len(matches),
        "senderPolicy": "sender intentionally omitted and not required; score-anchor only searches message time and content",
        "agentInstruction": "Read all matched messages and choose the score-scan --start timestamp yourself; this command does not decide or write state.",
        "matches": matches,
    }
    console_payload = {
        key: value
        for key, value in payload.items()
        if key not in {"keywords"}
    }
    console_payload["keywordCount"] = len(keywords)
    if args.output:
        write_output(payload, args.output, quiet=True)
        console_payload["output"] = args.output
        print_json(console_payload)
    else:
        print_json(console_payload)
    return 0


def infer_score_result_time(item: dict[str, Any], fallback_epoch_ms: Any = None) -> str:
    explicit = (
        score_result_time_text(item.get("resultTime"))
        or score_result_time_text(item.get("sourceTime"))
        or score_result_time_text(item.get("time"))
    )
    if explicit:
        return explicit
    from_key = source_message_key_time_text(item.get("sourceMessageKey"))
    if from_key:
        return from_key
    return local_time_text_from_epoch_ms(fallback_epoch_ms)


def round_has_user_pending_for_table(round_item: dict[str, Any], table: Any) -> bool:
    table_key = normalize_text_like(table)
    if not table_key:
        return False
    pending = round_item.get("pending") if isinstance(round_item.get("pending"), list) else []
    for item in pending:
        if not isinstance(item, dict):
            continue
        if str(item.get("pendingKind") or "").strip() != "user-pending":
            continue
        if normalize_text_like(item.get("pendingTable") or item.get("table")) == table_key:
            return True
    return False


def current_round_pairing_accounts(
    target_round: dict[str, Any],
    pairing_context_by_key: dict[str, dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    account_index = pairing_account_index(target_round, pairing_context_by_key)
    out: dict[str, dict[str, Any]] = {}
    pairings = target_round.get("ftdPairings") if isinstance(target_round.get("ftdPairings"), list) else []
    by_table = {normalize_text_like(item.get("table")): item for item in pairings if isinstance(item, dict)}
    for item in account_index:
        if not item.get("fullyMapped"):
            continue
        table_key = normalize_text_like(item.get("table"))
        pairing = by_table.get(table_key)
        if not pairing:
            continue
        out[table_key] = {
            **item,
            "pairing": pairing,
            "blackAccountKey": oq_account_key(item.get("blackAccount")),
            "whiteAccountKey": oq_account_key(item.get("whiteAccount")),
            "accountSetKey": "|".join(sorted([oq_account_key(item.get("blackAccount")), oq_account_key(item.get("whiteAccount"))])),
        }
    return out


def fetch_oq_games_for_accounts(
    accounts: list[str],
    mode: str,
    base_url: str,
    timeout: int,
    concurrency: int,
) -> dict[str, Any]:
    cleaned: list[str] = []
    seen: set[str] = set()
    for account in accounts:
        text = str(account or "").strip()
        key = oq_account_key(text)
        if not text or key in seen:
            continue
        cleaned.append(text)
        seen.add(key)
    started = time.perf_counter()
    results: dict[str, list[Any]] = {}
    errors: dict[str, str] = {}

    def fetch_one(account: str) -> tuple[str, list[Any], str]:
        try:
            OQClient = load_oq_client_class()
            games = OQClient(base_url=base_url, timeout=timeout).fetch_games(account, mode, include_details=False)
            return account, games, ""
        except Exception as exc:  # noqa: BLE001
            return account, [], str(exc)

    if cleaned:
        with ThreadPoolExecutor(max_workers=max(1, int(concurrency or 8))) as executor:
            futures = {executor.submit(fetch_one, account): account for account in cleaned}
            for future in as_completed(futures):
                account, games, error = future.result()
                results[oq_account_key(account)] = games
                if error:
                    errors[account] = error
    return {
        "accounts": cleaned,
        "gamesByAccount": results,
        "errors": errors,
        "wallMs": round((time.perf_counter() - started) * 1000, 1),
    }


def oq_entry_with_detail(
    entry: Any,
    base_url: str,
    timeout: int,
    detail_cache: dict[str, dict[str, Any]] | None = None,
) -> tuple[Any, bool]:
    try:
        oq_extract_detail_from_entry(entry)
        return entry, False
    except HelperError:
        pass
    game_id = str(getattr(entry, "game_id", "") or "").strip()
    if not game_id:
        return entry, False
    cache = detail_cache if isinstance(detail_cache, dict) else {}
    if game_id in cache:
        detail = cache[game_id]
        fetched = False
    else:
        OQClient = load_oq_client_class()
        detail = OQClient(base_url=base_url, timeout=timeout).fetch_game_detail(game_id)
        cache[game_id] = detail
        fetched = True
    try:
        raw_metadata = json.loads(str(getattr(entry, "raw_metadata_json", "") or "{}"))
    except json.JSONDecodeError:
        raw_metadata = {}
    if not isinstance(raw_metadata, dict):
        raw_metadata = {}
    raw_metadata["detail"] = detail
    try:
        setattr(entry, "raw_metadata_json", json.dumps(raw_metadata, ensure_ascii=False, sort_keys=True))
    except Exception:  # noqa: BLE001
        pass
    return entry, fetched


def oq_entry_requires_detail_for_score(entry: Any) -> bool:
    return True


def oq_candidate_key(entry: Any) -> str:
    game_id = str(getattr(entry, "game_id", "") or "").strip()
    if game_id:
        return f"id:{game_id}"
    created = str(getattr(entry, "created_at", "") or "")
    black = oq_account_key(getattr(entry, "black_name", ""))
    white = oq_account_key(getattr(entry, "white_name", ""))
    black_score = getattr(entry, "black_score", None)
    white_score = getattr(entry, "white_score", None)
    return f"fallback:{created}:{black}:{white}:{black_score}:{white_score}:{getattr(entry, 'status', '')}"


def collect_table_oq_candidates(
    table_info: dict[str, Any],
    games_by_account: dict[str, list[Any]],
    start: datetime,
    end: datetime,
) -> list[dict[str, Any]]:
    expected = {table_info.get("blackAccountKey"), table_info.get("whiteAccountKey")}
    expected.discard("")
    candidates: dict[str, dict[str, Any]] = {}
    for account_key in expected:
        for entry in games_by_account.get(account_key, []):
            created = oq_game_local_created(entry)
            if not created or created < start or created > end:
                continue
            black_key = oq_account_key(getattr(entry, "black_name", ""))
            white_key = oq_account_key(getattr(entry, "white_name", ""))
            if {black_key, white_key} != expected:
                continue
            key = oq_candidate_key(entry)
            item = candidates.setdefault(
                key,
                {
                    "entry": entry,
                    "seenFromAccounts": set(),
                },
            )
            item["seenFromAccounts"].add(account_key)
    out = []
    for item in candidates.values():
        entry = item["entry"]
        out.append(
            {
                "entry": entry,
                "seenFromAccounts": sorted(item["seenFromAccounts"]),
                "summary": game_entry_summary(entry),
            }
        )
    out.sort(key=lambda item: str(item["summary"].get("createdAt") or ""))
    return out


def current_pairing_oq_game_keys(pairing: dict[str, Any]) -> set[str]:
    keys: set[str] = set()
    if not isinstance(pairing, dict):
        return keys
    source_key = normalize_text_like(pairing.get("sourceMessageKey"))
    if source_key.startswith("oq-auto:"):
        keys.add(source_key.replace("oq-auto:", "", 1))
    audit = pairing.get("oqAutoAudit") if isinstance(pairing.get("oqAutoAudit"), dict) else {}
    game = audit.get("game") if isinstance(audit.get("game"), dict) else {}
    game_id = normalize_text_like(game.get("gameId"))
    if game_id:
        keys.add(f"id:{game_id}")
        keys.add(game_id)
    availability_audit = pairing.get("oqGameAvailableAudit") if isinstance(pairing.get("oqGameAvailableAudit"), dict) else {}
    availability_game = availability_audit.get("game") if isinstance(availability_audit.get("game"), dict) else {}
    availability_game_id = normalize_text_like(availability_game.get("gameId"))
    if availability_game_id:
        keys.add(f"id:{availability_game_id}")
        keys.add(availability_game_id)
    availability_key = normalize_text_like(availability_audit.get("candidateKey"))
    if availability_key:
        keys.add(availability_key)
    return keys


def filter_existing_pairing_oq_candidates(
    pairing: dict[str, Any],
    candidates: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    existing_keys = current_pairing_oq_game_keys(pairing)
    if not existing_keys:
        return candidates
    filtered: list[dict[str, Any]] = []
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        entry = candidate.get("entry")
        summary = candidate.get("summary") if isinstance(candidate.get("summary"), dict) else {}
        keys = {oq_candidate_key(entry)}
        game_id = normalize_text_like(summary.get("gameId") or getattr(entry, "game_id", ""))
        if game_id:
            keys.add(f"id:{game_id}")
            keys.add(game_id)
        if keys & existing_keys:
            continue
        filtered.append(candidate)
    return filtered


def oq_candidate_has_exact_table_accounts(candidate: dict[str, Any], table_info: dict[str, Any]) -> bool:
    if not isinstance(candidate, dict):
        return False
    entry = candidate.get("entry")
    expected = {table_info.get("blackAccountKey"), table_info.get("whiteAccountKey")}
    expected.discard("")
    if len(expected) != 2:
        return False
    actual = {
        oq_account_key(getattr(entry, "black_name", "")),
        oq_account_key(getattr(entry, "white_name", "")),
    }
    actual.discard("")
    return actual == expected


def should_create_oq_pending(candidates: list[dict[str, Any]], table_info: dict[str, Any]) -> bool:
    if len(candidates) < 2:
        return False
    return all(oq_candidate_has_exact_table_accounts(candidate, table_info) for candidate in candidates)


def oq_score_mismatch_candidates(
    candidates: list[dict[str, Any]],
    table_info: dict[str, Any],
) -> list[dict[str, Any]]:
    pairing = table_info.get("pairing") if isinstance(table_info.get("pairing"), dict) else {}
    current_black = pairing.get("blackScore")
    current_white = pairing.get("whiteScore")
    try:
        current_black_int = int(current_black)
        current_white_int = int(current_white)
    except (TypeError, ValueError):
        return []
    out: list[dict[str, Any]] = []
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        entry = candidate.get("entry")
        try:
            black_score, white_score, score_reason, _account_scores = oq_scores_for_ftd_pairing(entry, table_info)
        except Exception:
            continue
        if black_score == current_black_int and white_score == current_white_int:
            continue
        item = dict(candidate)
        summary = item.get("summary") if isinstance(item.get("summary"), dict) else game_entry_summary(entry)
        item["scoreMismatch"] = {
            "currentBlackScore": current_black_int,
            "currentWhiteScore": current_white_int,
            "oqBlackScore": black_score,
            "oqWhiteScore": white_score,
            "scoreReason": score_reason,
            "gameId": summary.get("gameId") or str(getattr(entry, "game_id", "") or ""),
            "createdLocal": summary.get("createdLocal") or "",
        }
        out.append(item)
    return out


def make_oq_pending_item(
    round_no: int,
    table_info: dict[str, Any],
    reason: str,
    candidates: list[dict[str, Any]],
    user_locked: bool,
) -> dict[str, Any]:
    table = table_info.get("table")
    pairing = table_info.get("pairing") if isinstance(table_info.get("pairing"), dict) else {}
    summaries = oq_candidate_detail_summaries(candidates)
    detail = {
        "table": table,
        "black": pairing.get("black") or table_info.get("blackFtdName") or "",
        "white": pairing.get("white") or table_info.get("whiteFtdName") or "",
        "blackAccount": table_info.get("blackAccount") or "",
        "whiteAccount": table_info.get("whiteAccount") or "",
        "userEdited": bool(user_locked),
        "candidateCount": len(candidates),
        "candidates": summaries,
    }
    lock_text = "；该桌已有用户编辑，OQ 自动查询未覆盖" if user_locked else ""
    account_text = compact_oq_pending_text(table_info, candidates, user_locked)
    return normalize_score_item_for_frontend(
        {
            "id": f"oq-auto-pending-r{round_no}-t{table}-{int(time.time() * 1000)}",
            "round": round_no,
            "sender": f"OQ自动查询 第{table}台",
            "wechatSender": f"OQ自动查询 第{table}台",
            "opponent": "",
            "verdict": "oq-auto-pending",
            "resultText": f"OQ自动查询 pending：第 {table} 台 {reason}{lock_text}",
            "reason": reason,
            "accountMismatchText": account_text,
            "oqPendingDetail": detail,
            "sourceMessageKey": f"oq-auto-r{round_no}-t{table}",
            "pendingKind": "oq-auto-multiple-games" if len(candidates) >= 2 else "oq-auto-abnormality",
            "pendingTable": table,
            "table": table,
            "reviewAction": "核对是否采用该 OQ 对局；确认后处理 pending。",
            "lastEditedBy": "script",
            "lastEditedAt": int(time.time() * 1000),
        },
        round_no,
    )


def pairing_ready_snapshot(pairing: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": pairing.get("status") or "",
        "blackScore": pairing.get("blackScore"),
        "whiteScore": pairing.get("whiteScore"),
        "resultText": pairing.get("resultText") or "",
        "reason": pairing.get("reason") or "",
        "sourceMessageKey": pairing.get("sourceMessageKey") or "",
        "lastEditedBy": pairing.get("lastEditedBy") or "",
        "oqAutoAudit": pairing.get("oqAutoAudit") if isinstance(pairing.get("oqAutoAudit"), dict) else None,
    }


def upsert_oq_followup_pending(
    target_round: dict[str, Any],
    round_no: int,
    table_info: dict[str, Any],
    candidates: list[dict[str, Any]],
    reason: str,
) -> dict[str, Any]:
    table = normalize_text_like(table_info.get("table"))
    pending = target_round.get("pending") if isinstance(target_round.get("pending"), list) else []
    target_round["pending"] = pending
    existing_index = -1
    for index, item in enumerate(pending):
        if not isinstance(item, dict):
            continue
        if normalize_text_like(item.get("pendingTable") or item.get("table")) != table:
            continue
        if str(item.get("pendingKind") or "").strip() in {"oq-auto-followup", "user-pending"}:
            existing_index = index
            break

    pairing = table_info.get("pairing") if isinstance(table_info.get("pairing"), dict) else {}
    followup = {
        "detectedAt": current_iso_timestamp(),
        "reason": reason,
        "readySnapshot": pairing_ready_snapshot(pairing),
        "candidates": oq_candidate_detail_summaries(candidates),
    }
    account_text = compact_oq_pending_text(table_info, candidates, False)
    if existing_index >= 0:
        item = pending[existing_index]
        existing = item.get("oqFollowup") if isinstance(item.get("oqFollowup"), dict) else {}
        history = existing.get("history") if isinstance(existing.get("history"), list) else []
        item["oqFollowupDetected"] = True
        item["oqFollowupAt"] = followup["detectedAt"]
        item["oqFollowupReason"] = reason
        item["oqFollowupCandidates"] = followup["candidates"]
        item["accountMismatchText"] = account_text
        item["oqFollowup"] = {
            **existing,
            **followup,
            "history": (history + [followup])[-6:],
        }
        base_action = str(item.get("reviewAction") or "").strip()
        append = "OQ 自动查询发现后续对局；核对是否改用后续 OQ 对局；确认后处理 pending。"
        if append not in base_action:
            item["reviewAction"] = f"{base_action}；{append}" if base_action else append
        item["lastEditedBy"] = item.get("lastEditedBy") or "script"
        return {
            "table": table_info.get("table"),
            "updatedExistingPending": True,
            "pendingKind": item.get("pendingKind") or "",
            "reason": reason,
            "candidates": followup["candidates"],
        }

    item = make_oq_pending_item(round_no, table_info, reason, candidates, False)
    item["pendingKind"] = "oq-auto-followup"
    item["verdict"] = "oq-auto-followup"
    item["sourceMessageKey"] = f"oq-followup-r{round_no}-t{table}"
    item["resultText"] = f"OQ后续对局 pending：第 {table} 台"
    item["accountMismatchText"] = account_text
    item["oqFollowupDetected"] = True
    item["oqFollowupAt"] = followup["detectedAt"]
    item["oqFollowupReason"] = reason
    item["oqFollowupCandidates"] = followup["candidates"]
    item["oqFollowup"] = {**followup, "history": [followup]}
    pending.insert(0, item)
    return {
        "table": table_info.get("table"),
        "updatedExistingPending": False,
        "pendingKind": "oq-auto-followup",
        "reason": reason,
        "candidates": followup["candidates"],
    }


def upsert_oq_score_mismatch_pending(
    target_round: dict[str, Any],
    round_no: int,
    table_info: dict[str, Any],
    candidates: list[dict[str, Any]],
    reason: str,
) -> dict[str, Any]:
    result = upsert_oq_followup_pending(target_round, round_no, table_info, candidates, reason)
    table = normalize_text_like(table_info.get("table"))
    pending = target_round.get("pending") if isinstance(target_round.get("pending"), list) else []
    for item in pending:
        if not isinstance(item, dict):
            continue
        if normalize_text_like(item.get("pendingTable") or item.get("table")) != table:
            continue
        if str(item.get("pendingKind") or "").strip() not in {"oq-auto-followup", "user-pending"}:
            continue
        item["pendingKind"] = "oq-auto-score-mismatch"
        item["verdict"] = "oq-auto-score-mismatch"
        item["sourceMessageKey"] = f"oq-score-mismatch-r{round_no}-t{table}"
        item["resultText"] = f"OQ比分不一致 pending：第 {table} 台"
        item["reviewAction"] = "OQ 棋谱回放比分与当前 agent/用户登记不一致；请核对是否改分或保留原登记。"
        item["oqScoreMismatch"] = [c.get("scoreMismatch") for c in candidates if isinstance(c.get("scoreMismatch"), dict)]
        break
    return {**result, "pendingKind": "oq-auto-score-mismatch", "scoreMismatch": True}


def mark_oq_game_available_for_pairing(
    pairing: dict[str, Any],
    table_info: dict[str, Any],
    candidates: list[dict[str, Any]],
    editor: str,
) -> dict[str, Any] | None:
    if not isinstance(pairing, dict):
        return None
    current_black = int_score(pairing.get("blackScore"))
    current_white = int_score(pairing.get("whiteScore"))
    if current_black is None or current_white is None:
        return None
    matching: list[dict[str, Any]] = []
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        entry = candidate.get("entry")
        try:
            black_score, white_score, score_reason, account_scores = oq_scores_for_ftd_pairing(entry, table_info)
        except Exception:
            continue
        if black_score != current_black or white_score != current_white:
            continue
        summary = candidate.get("summary") if isinstance(candidate.get("summary"), dict) else game_entry_summary(entry)
        matching.append(
            {
                "candidate": candidate,
                "summary": summary,
                "scoreReason": score_reason,
                "accountScores": account_scores,
            }
        )
    if not matching:
        return None
    selected = matching[0]
    edited_at = int(time.time() * 1000)
    summary = selected["summary"]
    pairing["oqGameAvailable"] = True
    pairing["oqGameAvailableAt"] = edited_at
    pairing["oqGameAvailableAudit"] = {
        "by": "script",
        "at": current_iso_timestamp(),
        "verifiedExistingEditor": editor,
        "game": summary,
        "candidateKey": oq_candidate_key(selected["candidate"].get("entry")),
        "accountScores": selected["accountScores"],
        "ftdBlackAccount": table_info.get("blackAccount") or "",
        "ftdWhiteAccount": table_info.get("whiteAccount") or "",
        "seenFromAccounts": selected["candidate"].get("seenFromAccounts") or [],
        "scoreRule": selected["scoreReason"],
        "verifiedBlackScore": current_black,
        "verifiedWhiteScore": current_white,
        "matchingCandidateCount": len(matching),
    }
    return {
        "table": table_info.get("table"),
        "status": pairing.get("status") or "",
        "editor": editor,
        "source": "oq-game-available",
        "game": summary,
        "blackScore": current_black,
        "whiteScore": current_white,
        "matchingCandidateCount": len(matching),
    }


def apply_oq_candidate_to_pairing(
    target_round: dict[str, Any],
    table_info: dict[str, Any],
    candidate: dict[str, Any],
    round_no: int,
) -> dict[str, Any]:
    pairing = table_info.get("pairing")
    if not isinstance(pairing, dict):
        raise HelperError("missing FTD pairing")
    if pairing.get("status") in {"ready", "completed"}:
        return {
            "skipped": True,
            "reason": f"already {pairing.get('status')}",
            "table": table_info.get("table"),
        }
    if pairing.get("status") == "dirty" or pairing.get("dirty") is True:
        return {"skipped": True, "reason": "dirty row", "table": table_info.get("table")}
    if ftd_pairing_has_user_score_lock(pairing):
        return {"skipped": True, "reason": "user-edited", "table": table_info.get("table")}
    entry = candidate["entry"]
    black_score, white_score, score_reason, account_scores = oq_scores_for_ftd_pairing(entry, table_info)
    edited_at = int(time.time() * 1000)
    result_time = game_entry_summary(entry).get("createdLocal") or game_entry_summary(entry).get("createdAt") or ""
    result_sort_key = score_result_sort_key(result_time)
    pairing["status"] = "ready"
    pairing["reporter"] = "OQ自动查询"
    pairing["opponent"] = ""
    pairing["blackScore"] = black_score
    pairing["whiteScore"] = white_score
    pairing["resultText"] = (
        f"OQ自动查询：{game_entry_summary(entry).get('createdLocal')} "
        f"{table_info.get('blackAccount')} vs {table_info.get('whiteAccount')} "
        f"=> {black_score}-{white_score}"
    )
    pairing["reason"] = score_reason
    pairing["sourceMessageKey"] = f"oq-auto:{oq_candidate_key(entry)}"
    pairing["sourceLocalId"] = ""
    pairing["imagePath"] = ""
    pairing["resultKind"] = "oq-auto"
    pairing["resultTime"] = result_time
    pairing["resultSortKey"] = result_sort_key
    pairing["updatedAt"] = edited_at
    pairing["completedAt"] = None
    pairing["lastEditedBy"] = "script"
    pairing["lastEditedAt"] = edited_at
    pairing["oqAutoAudit"] = {
        "by": "script",
        "at": current_iso_timestamp(),
        "mode": str(getattr(entry, "mode", "") or ""),
        "game": game_entry_summary(entry),
        "accountScores": account_scores,
        "ftdBlackAccount": table_info.get("blackAccount") or "",
        "ftdWhiteAccount": table_info.get("whiteAccount") or "",
        "seenFromAccounts": candidate.get("seenFromAccounts") or [],
        "scoreRule": score_reason,
        "userEditedFieldsChecked": sorted(ftd_pairing_user_edited_fields(pairing)),
    }
    removed_pending = remove_matching_pending_items(target_round, {f"table:{normalize_text_like(table_info.get('table'))}"})
    return {
        "table": table_info.get("table"),
        "black": pairing.get("black"),
        "white": pairing.get("white"),
        "blackScore": black_score,
        "whiteScore": white_score,
        "status": "ready",
        "source": "oq-auto",
        "resultTime": result_time,
        "resultSortKey": result_sort_key,
        "scoreReason": score_reason,
        "game": game_entry_summary(entry),
        "clearedPendingCount": len(removed_pending),
    }


def update_round_oq_scores(
    state: dict[str, Any],
    round_no: int,
    round_count: int,
    round_start: datetime,
    window_minutes: int,
    mode: str,
    concurrency: int,
    base_url: str,
    timeout: int,
    direct_file: bool,
    dry_run: bool,
    round_end: datetime | None = None,
    window_source: str = "",
) -> dict[str, Any]:
    state.setdefault("version", 2)
    state["step"] = "score-helper"
    helper = ensure_frontend_score_helper(state, max(round_no, int(round_count or 0)))
    helper["activeRound"] = round_no
    target_round = helper["rounds"][round_no - 1]
    validate_knockout_round_pairings(target_round)
    if not str(target_round.get("roundStartAt") or "").strip():
        target_round["roundStartAt"] = round_start.isoformat(sep=" ")
        target_round["roundStartSource"] = "oq-script"
    else:
        target_round["roundStartAt"] = str(target_round.get("roundStartAt") or "").strip()
        target_round["roundStartSource"] = str(target_round.get("roundStartSource") or "frontend")
    roster_players = players_from_state(state)
    raw_pairing_players = players_from_ftd_round(target_round, round_no)
    if not raw_pairing_players:
        raise HelperError(f"第 {round_no} 轮没有 FTD 配对表；不能从 OQ 自动更新比分")
    mapping_rows = ftd_player_account_mapping_rows(state)
    pairing_players, pairing_mapping_issues, pairing_context_by_key = enrich_ftd_pairing_players(
        target_round,
        roster_players,
        round_no,
        {},
        mapping_rows,
    )
    del pairing_players
    table_infos = current_round_pairing_accounts(target_round, pairing_context_by_key)
    accounts = []
    skipped: list[dict[str, Any]] = []
    for table_info in table_infos.values():
        accounts.extend([str(table_info.get("blackAccount") or ""), str(table_info.get("whiteAccount") or "")])
    fetch_result = fetch_oq_games_for_accounts(accounts, mode, base_url, timeout, concurrency)
    games_by_account = fetch_result["gamesByAccount"]
    window_end = round_end or (round_start + timedelta(minutes=max(1, int(window_minutes or 40))))
    applied: list[dict[str, Any]] = []
    pending: list[dict[str, Any]] = []
    game_available: list[dict[str, Any]] = []
    detail_fetch_started = time.perf_counter()
    detail_fetch_count = 0
    detail_cache_hit_count = 0
    detail_fetch_errors: list[dict[str, Any]] = []
    detail_cache: dict[str, dict[str, Any]] = {}

    def prepare_pending_candidates(
        table_info: dict[str, Any],
        candidates: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        nonlocal detail_fetch_count, detail_cache_hit_count
        prepared: list[dict[str, Any]] = []
        for candidate in candidates[:8]:
            if not isinstance(candidate, dict):
                continue
            item = dict(candidate)
            detail, fetched_detail, detail_error = build_oq_pending_candidate_detail(
                item,
                table_info,
                base_url,
                timeout,
                detail_cache,
            )
            item["pendingDetail"] = detail
            if fetched_detail:
                detail_fetch_count += 1
            elif detail.get("gameId"):
                detail_cache_hit_count += 1
            if detail_error:
                detail_fetch_errors.append({"table": table_info.get("table"), "error": detail_error})
            prepared.append(item)
        return prepared

    for table_key, table_info in table_infos.items():
        pairing = table_info.get("pairing") if isinstance(table_info.get("pairing"), dict) else {}
        candidates = collect_table_oq_candidates(table_info, games_by_account, round_start, window_end)
        new_candidates = filter_existing_pairing_oq_candidates(pairing, candidates)
        has_user_pending = round_has_user_pending_for_table(target_round, table_info.get("table"))
        if has_user_pending:
            if should_create_oq_pending(new_candidates, table_info):
                new_candidates = prepare_pending_candidates(table_info, new_candidates)
                followup = upsert_oq_followup_pending(
                    target_round,
                    round_no,
                    table_info,
                    new_candidates,
                    "该桌已有用户 pending，OQ 自动查询发现同双方账号对局；未覆盖用户原因或比分",
                )
                pending.append(followup)
            skipped.append({"table": table_info.get("table"), "reason": "user-pending"})
            continue
        if pairing.get("status") in {"ready", "completed"}:
            editor = normalize_text_like(pairing.get("lastEditedBy"))
            manual_editor = editor in {"agent", "user"}
            if manual_editor and new_candidates:
                prepared_candidates = prepare_pending_candidates(table_info, new_candidates)
                mismatch_candidates = oq_score_mismatch_candidates(prepared_candidates, table_info)
                if mismatch_candidates:
                    followup = upsert_oq_score_mismatch_pending(
                        target_round,
                        round_no,
                        table_info,
                        mismatch_candidates,
                        f"该桌已由 {editor} 登记，但 OQ 棋谱回放比分与当前登记不一致",
                    )
                    pending.append(followup)
                elif should_create_oq_pending(prepared_candidates, table_info):
                    followup_reason = (
                        f"该桌已由 {editor} 登记，OQ 又发现多局同双方账号对局；"
                        "当前比分未覆盖，请核对是否有重赛或误登记"
                    )
                    followup = upsert_oq_followup_pending(
                        target_round,
                        round_no,
                        table_info,
                        prepared_candidates,
                        followup_reason,
                    )
                    pending.append(followup)
                else:
                    availability = mark_oq_game_available_for_pairing(
                        pairing,
                        table_info,
                        prepared_candidates,
                        editor,
                    )
                    if availability:
                        game_available.append(availability)
            skipped.append({"table": table_info.get("table"), "reason": f"already {pairing.get('status')}"})
            continue
        if pairing.get("status") == "dirty" or pairing.get("dirty") is True:
            if should_create_oq_pending(new_candidates, table_info):
                new_candidates = prepare_pending_candidates(table_info, new_candidates)
                followup = upsert_oq_followup_pending(
                    target_round,
                    round_no,
                    table_info,
                    new_candidates,
                    "该桌是旧 dirty 状态，OQ 自动查询发现同双方账号对局；未覆盖比分",
                )
                pending.append(followup)
            skipped.append({"table": table_info.get("table"), "reason": "dirty row"})
            continue
        user_locked = ftd_pairing_has_user_score_lock(pairing)
        if user_locked:
            if should_create_oq_pending(new_candidates, table_info):
                new_candidates = prepare_pending_candidates(table_info, new_candidates)
                followup = upsert_oq_followup_pending(
                    target_round,
                    round_no,
                    table_info,
                    new_candidates,
                    "该桌已有用户编辑锁，OQ 自动查询发现同双方账号对局；未覆盖用户编辑",
                )
                pending.append(followup)
            skipped.append({"table": table_info.get("table"), "reason": "user-edited"})
            continue
        if not candidates:
            skipped.append({"table": table_info.get("table"), "reason": "no matching OQ game"})
            continue
        if should_create_oq_pending(candidates, table_info):
            candidates = prepare_pending_candidates(table_info, candidates)
            item = make_oq_pending_item(round_no, table_info, "同一时间窗口内命中多局完全相同双方账号", candidates, False)
            push_pending_item_to_round(target_round, item, round_no, item.get("wechatSender") or "OQ自动查询")
            pending.append({"table": table_info.get("table"), "reason": "multiple matching OQ games", "candidates": [c.get("summary") for c in candidates]})
            continue
        try:
            if oq_entry_requires_detail_for_score(candidates[0]["entry"]):
                try:
                    candidates[0]["entry"], fetched_detail = oq_entry_with_detail(
                        candidates[0]["entry"],
                        base_url,
                        timeout,
                        detail_cache,
                    )
                    if fetched_detail:
                        detail_fetch_count += 1
                    else:
                        detail_cache_hit_count += 1
                except Exception as exc:  # noqa: BLE001
                    detail_fetch_errors.append({"table": table_info.get("table"), "error": str(exc)})
            result = apply_oq_candidate_to_pairing(target_round, table_info, candidates[0], round_no)
        except Exception as exc:  # noqa: BLE001
            item = make_oq_pending_item(round_no, table_info, f"OQ 对局命中但无法安全计算比分：{exc}", candidates, False)
            push_pending_item_to_round(target_round, item, round_no, item.get("wechatSender") or "OQ自动查询")
            pending.append({"table": table_info.get("table"), "reason": str(exc), "candidates": [c.get("summary") for c in candidates]})
            continue
        if result.get("skipped"):
            skipped.append(result)
        else:
            applied.append(result)

    if (applied or pending or game_available) and not dry_run:
        helper["updatedAt"] = int(time.time() * 1000)
        state["savedAt"] = int(time.time() * 1000)
    return {
        "ok": True,
        "action": "update-round-oq-scores",
        "dryRun": bool(dry_run),
        "round": round_no,
        "mode": mode,
        "window": {
            "startLocal": round_start.isoformat(sep=" "),
            "endLocal": window_end.isoformat(sep=" "),
            "minutes": max(1, int((window_end - round_start).total_seconds() // 60) or int(window_minutes or 40)),
            "source": window_source or ("explicit-end" if round_end else "start-plus-duration"),
        },
        "roundStartAt": target_round.get("roundStartAt") or "",
        "roundStartSource": target_round.get("roundStartSource") or "",
        "queryPolicy": "query both OQ accounts for each current FTD table, dedupe by game id/fallback key, auto-ready only on exactly one full account match",
        "scorePolicy": "normal OQ scores require game detail replay from position.moves, then award empty squares to the board leader; SCORE:n alone is never used for automatic ready writes. resign/timeout/disconnect writes loser 0 and winner 64 only when loser side is clear",
        "userEditPolicy": "rows with userEditedFields or lastEditedBy=user are never overwritten by OQ auto update",
        "queriedAccountCount": len(fetch_result.get("accounts") or []),
        "queryErrors": fetch_result.get("errors") or {},
        "queryWallMs": fetch_result.get("wallMs"),
        "detailFetchCount": detail_fetch_count,
        "detailCacheHitCount": detail_cache_hit_count,
        "detailCacheSize": len(detail_cache),
        "detailFetchErrors": detail_fetch_errors,
        "detailFetchWallMs": round((time.perf_counter() - detail_fetch_started) * 1000, 1),
        "mappedTableCount": len(table_infos),
        "mappingIssueCount": len(pairing_mapping_issues),
        "mappingIssues": pairing_mapping_issues[:80],
        "appliedCount": len(applied),
        "gameAvailableCount": len(game_available),
        "pendingCount": len(pending),
        "skippedCount": len(skipped),
        "applied": applied,
        "gameAvailable": game_available,
        "pending": pending,
        "skipped": skipped,
        **score_write_followup(target_round),
    }


def cmd_update_round_oq_scores(args: argparse.Namespace) -> int:
    state_path = Path(args.frontend_state)
    state = read_frontend_state(state_path, bool(args.direct_file))
    round_no = max(1, min(9, int(args.round)))
    round_start = parse_local_time_required(args.round_start, "--round-start")
    mark_oq_round_score_update_request(round_no, "agent-update-round-oq-scores")
    result = update_round_oq_scores(
        state,
        round_no,
        int(args.round_count or 0),
        round_start,
        int(args.window_minutes or 40),
        args.oq_mode,
        int(args.oq_concurrency or 8),
        args.oq_base_url,
        int(args.oq_timeout or 20),
        bool(args.direct_file),
        bool(args.dry_run),
    )
    if not args.dry_run and (result["appliedCount"] or result["pendingCount"] or result["gameAvailableCount"]):
        result["state"] = write_frontend_state(state_path, state, bool(args.direct_file))
    else:
        result["state"] = ""
    print_json(result)
    return 0


def mapping_row_deleted(row: dict[str, Any]) -> bool:
    return row.get("deleted") is True or str(row.get("status") or "").strip() == "deleted"


def mapping_oq_check_matches_account(row: dict[str, Any]) -> bool:
    oq_check = row.get("oqCheck") if isinstance(row.get("oqCheck"), dict) else {}
    checked = str(oq_check.get("account") or row.get("oqCheckAccount") or "").strip()
    if not checked:
        return True
    return checked.casefold() == str(row.get("account") or "").strip().casefold()


def mapping_row_has_required_fields(row: dict[str, Any]) -> bool:
    return bool(
        str(row.get("ftdName") or "").strip()
        and str(row.get("account") or "").strip()
        and str(row.get("groupNick") or row.get("group_nick") or "").strip()
    )


def mapping_row_invalid(row: dict[str, Any]) -> bool:
    if mapping_row_deleted(row) or not mapping_row_has_required_fields(row):
        return False
    oq_check = row.get("oqCheck") if isinstance(row.get("oqCheck"), dict) else {}
    return mapping_oq_check_matches_account(row) and oq_check.get("status") == "invalid"


def mapping_row_complete(row: dict[str, Any]) -> bool:
    if mapping_row_deleted(row) or mapping_row_invalid(row) or not mapping_row_has_required_fields(row):
        return False
    oq_check = row.get("oqCheck") if isinstance(row.get("oqCheck"), dict) else {}
    return mapping_oq_check_matches_account(row) and oq_check.get("status") == "ok"


def sanitize_mapping_row_for_shared_state(row: dict[str, Any]) -> dict[str, Any]:
    next_row = {
        "index": row.get("index", 0),
        "ftdId": row.get("ftdId", ""),
        "ftdName": str(row.get("ftdName") or row.get("displayName") or row.get("name") or "").strip(),
        "account": str(row.get("account") or "").strip(),
        "groupNick": str(row.get("groupNick") or row.get("group_nick") or "").strip(),
        "source": str(row.get("source") or "").strip(),
        "deleted": row.get("deleted") is True or str(row.get("status") or "").strip() == "deleted",
    }
    for key in ("surname", "givenName", "ftdNick", "ftdUsername"):
        value = row.get(key)
        if value not in (None, ""):
            next_row[key] = value
    oq_check = row.get("oqCheck") if isinstance(row.get("oqCheck"), dict) else None
    if oq_check:
        next_row["oqCheck"] = {
            "account": str(oq_check.get("account") or "").strip(),
            "status": str(oq_check.get("status") or "").strip(),
            "checkedAt": str(oq_check.get("checkedAt") or "").strip(),
            "elapsedMs": oq_check.get("elapsedMs", 0),
            "totalGames": oq_check.get("totalGames", 0),
            "windowGames": oq_check.get("windowGames", 0),
            "error": str(oq_check.get("error") or "").strip(),
        }
    edit_audit = row.get("editAudit") if isinstance(row.get("editAudit"), dict) else None
    if edit_audit:
        next_row["editAudit"] = edit_audit
    return next_row


def sanitize_mapping_rows_for_shared_state(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [sanitize_mapping_row_for_shared_state(row) for row in rows if isinstance(row, dict)]


def apply_oq_validation_to_mapping_rows(
    rows: list[dict[str, Any]],
    validation: dict[str, Any],
    audit_action: str,
) -> list[dict[str, Any]]:
    if validation.get("skipped"):
        return rows
    checked_at = str(validation.get("checkedAt") or current_iso_timestamp())
    by_account = validation.get("byAccount") if isinstance(validation.get("byAccount"), dict) else {}
    next_rows: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        next_row = {**row}
        account = str(next_row.get("account") or "").strip()
        if account:
            result = by_account.get(account.casefold())
            if isinstance(result, dict):
                next_row["oqCheck"] = oq_check_from_result(result, checked_at)
        if str(next_row.get("status") or "").strip() == "deleted":
            next_row["deleted"] = True
        next_row.pop("status", None)
        next_row["editAudit"] = {"by": "agent", "action": audit_action, "at": checked_at}
        next_rows.append(next_row)
    return next_rows


def rebuild_mapping_lists_from_rows(rows: list[dict[str, Any]], mapped_at: str) -> dict[str, Any]:
    matched: list[dict[str, Any]] = []
    ambiguous: list[dict[str, Any]] = []
    unmatched: list[dict[str, Any]] = []
    invalid: list[dict[str, Any]] = []
    account_index: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        if mapping_row_deleted(row):
            if str(row.get("status") or "").strip() == "deleted":
                row["deleted"] = True
            row.pop("status", None)
            continue
        row.pop("status", None)
        if mapping_row_invalid(row):
            invalid.append(row)
        elif mapping_row_complete(row):
            matched.append(row)
        else:
            unmatched.append(row)
        key = normalize_name_key(row.get("ftdName") or "")
        account = str(row.get("account") or "").strip()
        group_nick = str(row.get("groupNick") or row.get("group_nick") or "").strip()
        oq_check = row.get("oqCheck") if isinstance(row.get("oqCheck"), dict) else {}
        if key and account and group_nick and oq_check.get("status") == "ok" and mapping_oq_check_matches_account(row):
            account_index[key] = {
                "ftdName": row.get("ftdName") or "",
                "account": account,
                "groupNick": group_nick,
                "ftdId": row.get("ftdId", ""),
                "source": row.get("source") or "",
                "mappedAt": mapped_at,
            }
    return {
        "matched": matched,
        "ambiguous": ambiguous,
        "unmatched": unmatched,
        "invalid": invalid,
        "accountIndex": account_index,
    }


def build_ftd_player_account_mapping(args: argparse.Namespace) -> dict[str, Any]:
    ftd_path = Path(args.ftd_players)
    ftd_payload = load_ftd_player_export(ftd_path)
    refresh = None
    if not args.no_refresh_map:
        refresh = refresh_member_map_for_score_scan(args.group)
    member_map_payload = agent_checkin_bridge.load_member_map(args.group)
    source_state = read_frontend_state(Path(args.frontend_state), bool(args.direct_file))
    relay_reference = registration_relay_reference_from_state(
        source_state,
        require_current_month=bool(getattr(args, "require_current_relay_month", False)),
    )
    mapped_at = current_iso_timestamp()

    rows: list[dict[str, Any]] = []
    matched: list[dict[str, Any]] = []
    ambiguous: list[dict[str, Any]] = []
    unmatched: list[dict[str, Any]] = []
    account_index: dict[str, dict[str, Any]] = {}

    for index, raw_player in enumerate(ftd_payload.get("players") or [], start=1):
        if not isinstance(raw_player, dict):
            continue
        ftd_name = ftd_export_player_name(raw_player)
        if not ftd_name or normalize_name_key(ftd_name) == "bye":
            continue
        row = {
            "index": index,
            "ftdId": raw_player.get("id", ""),
            "ftdName": ftd_name,
            "surname": raw_player.get("surname", ""),
            "givenName": raw_player.get("givenName", ""),
            "ftdNick": raw_player.get("nick", ""),
            "ftdUsername": raw_player.get("username", ""),
            "account": "",
            "groupNick": "",
            "source": "agent",
            "editAudit": {"by": "agent", "action": "自动映射", "at": mapped_at},
        }
        relay_hint = registration_relay_hint_for_ftd_name(relay_reference, ftd_name)
        account_hint = member_map_account_hint(member_map_payload, ftd_name, ftd_name)
        nick_hint = member_map_group_nick_hint(member_map_payload, ftd_name, ftd_name)
        if relay_hint and relay_hint.get("status") == "matched":
            relay_entry = relay_hint.get("entry") if isinstance(relay_hint.get("entry"), dict) else {}
            account = str(relay_entry.get("account") or "").strip()
            group_nick = ""
            if nick_hint and nick_hint.get("status") == "matched":
                group_nick = str(nick_hint.get("group_nick") or "").strip()
            elif account_hint and account_hint.get("status") == "matched":
                group_nick = str(account_hint.get("group_nick") or "").strip()
            account_hint_account = str((account_hint or {}).get("account") or "").strip()
            row.update(
                {
                    "account": account,
                    "groupNick": group_nick,
                    "source": "registration-relay",
                    "editAudit": {"by": "agent", "action": "报名接龙自动映射", "at": mapped_at},
                    "contactDisplay": (nick_hint or account_hint or {}).get("contact_display") or "",
                    "contactRemark": (nick_hint or account_hint or {}).get("contact_remark") or "",
                    "contactNickName": (nick_hint or account_hint or {}).get("contact_nick_name") or "",
                    "alias": (nick_hint or account_hint or {}).get("alias") or "",
                    "wechatUsername": (nick_hint or account_hint or {}).get("username") or "",
                }
            )
            if account_hint_account and normalize_name_key(account_hint_account) != normalize_name_key(account):
                row["debugIssue"] = "registration relay account overrides conflicting group nickname account"
                row["debugCandidates"] = [
                    {
                        "source": "registration-relay",
                        "name": relay_entry.get("name") or "",
                        "account": account,
                        "rawLine": relay_entry.get("rawLine") or "",
                    },
                    {
                        "source": "wechat-group-nick",
                        "account": account_hint_account,
                        "group_nick": (account_hint or {}).get("group_nick") or "",
                    },
                ]
            if group_nick:
                matched.append(row)
            else:
                row["debugIssue"] = row.get("debugIssue") or "registration relay account matched but group nickname was not deterministic"
                unmatched.append(row)
            key = normalize_name_key(ftd_name)
            if key and account and group_nick:
                account_index[key] = {
                    "ftdName": ftd_name,
                    "account": account,
                    "groupNick": row["groupNick"],
                    "ftdId": row["ftdId"],
                    "source": row["source"],
                    "mappedAt": mapped_at,
                }
        elif relay_hint and relay_hint.get("status") == "ambiguous":
            row.update(
                {
                    "debugCandidates": relay_hint.get("candidates") or [],
                    "debugIssue": "multiple possible registration relay account rows for this FTD name",
                }
            )
            ambiguous.append(row)
        elif account_hint and account_hint.get("status") == "matched":
            account = str(account_hint.get("account") or "").strip()
            group_nick = ""
            if nick_hint and nick_hint.get("status") == "matched":
                group_nick = str(nick_hint.get("group_nick") or "").strip()
            else:
                group_nick = str(account_hint.get("group_nick") or "").strip()
            row.update(
                {
                    "account": account,
                    "groupNick": group_nick,
                    "contactDisplay": (nick_hint or account_hint).get("contact_display") or "",
                    "contactRemark": (nick_hint or account_hint).get("contact_remark") or "",
                    "contactNickName": (nick_hint or account_hint).get("contact_nick_name") or "",
                    "alias": (nick_hint or account_hint).get("alias") or "",
                    "wechatUsername": (nick_hint or account_hint).get("username") or "",
                }
            )
            if group_nick:
                matched.append(row)
            else:
                row["debugIssue"] = "OQ account matched but group nickname was not deterministic"
                unmatched.append(row)
            key = normalize_name_key(ftd_name)
            if key and account and group_nick:
                account_index[key] = {
                    "ftdName": ftd_name,
                    "account": account,
                    "groupNick": row["groupNick"],
                    "ftdId": row["ftdId"],
                    "source": row["source"],
                    "mappedAt": mapped_at,
                }
        elif account_hint and account_hint.get("status") == "ambiguous":
            row.update(
                {
                    "debugCandidates": account_hint.get("candidates") or [],
                    "debugIssue": "multiple possible OQ account tokens in group nickname map",
                }
            )
            ambiguous.append(row)
        elif nick_hint and nick_hint.get("status") == "ambiguous":
            row.update(
                {
                    "debugCandidates": nick_hint.get("candidates") or [],
                    "debugIssue": "multiple possible group nicknames for this FTD name",
                }
            )
            ambiguous.append(row)
        else:
            row["debugIssue"] = "no deterministic group nickname account hint"
            unmatched.append(row)
        rows.append(row)

    account_validation = validate_oq_accounts(
        [str(row.get("account") or "").strip() for row in rows],
        mode=args.oq_mode,
        concurrency=args.oq_concurrency,
        base_url=args.oq_base_url,
        timeout=args.oq_timeout,
        skip=bool(getattr(args, "skip_oq_validation", False)),
    )
    rows = apply_oq_validation_to_mapping_rows(rows, account_validation, "自动映射并校验OQ账号")
    audit_rows = rows
    rows = sanitize_mapping_rows_for_shared_state(rows)
    rebuilt = rebuild_mapping_lists_from_rows(rows, mapped_at)
    matched = rebuilt["matched"]
    ambiguous = rebuilt["ambiguous"]
    unmatched = rebuilt["unmatched"]
    invalid = rebuilt["invalid"]
    account_index = rebuilt["accountIndex"]

    target = ftd_payload.get("target") if isinstance(ftd_payload.get("target"), dict) else {}
    result = {
        "ok": True,
        "type": "ftd-player-oq-account-map",
        "version": 1,
        "source": "agent_tournament_helper map-ftd-players",
        "group": args.group,
        "groupName": member_map_payload.get("group_name"),
        "roomUsername": member_map_payload.get("room_username"),
        "mappedAt": mapped_at,
        "sourceFile": str(ftd_path),
        "ftdExportedAt": ftd_payload.get("exportedAt", ""),
        "ftdPageUrl": ftd_payload.get("pageUrl", ""),
        "target": target,
        "registrationRelay": public_registration_relay_reference(relay_reference),
        "playerCount": len(rows),
        "matchedCount": len(matched),
        "invalidAccountCount": len(invalid),
        "ambiguousCount": len(ambiguous),
        "unmatchedCount": len(unmatched),
        "indexedCount": len(account_index),
        "accountIndex": account_index,
        "players": rows,
        "matched": matched,
        "invalidAccounts": invalid,
        "ambiguous": ambiguous,
        "unmatched": unmatched,
        "oqValidation": account_validation,
        "agentReviewStatus": "required",
        "agentReviewedAt": "",
        "memberMap": {
            "refreshed": not args.no_refresh_map,
            "refresh": refresh,
            "refreshedAt": member_map_payload.get("refreshed_at"),
            "memberCount": member_map_payload.get("member_count"),
            "mappedCount": member_map_payload.get("mapped_count"),
        },
    }
    output_path = Path(args.output) if args.output else default_ftd_player_map_output(ftd_path, str(target.get("id") or ""))
    write_json(output_path, {**result, "auditRows": audit_rows})
    result["output"] = str(output_path)

    if args.write_frontend:
        state_path = Path(args.frontend_state)
        state = read_frontend_state(state_path, bool(args.direct_file))
        state["ftdPlayerAccountMapping"] = {
            key: value
            for key, value in result.items()
            if key not in {"players", "matched", "invalidAccounts", "ambiguous", "unmatched"}
        }
        state["ftdPlayerAccountMapping"]["players"] = rows[:300]
        state["ftdPlayerAccountMapping"]["invalidAccounts"] = invalid[:120]
        state["ftdPlayerAccountMapping"]["unmatched"] = unmatched[:120]
        state["ftdPlayerAccountMapping"]["ambiguous"] = ambiguous[:120]
        nick_pool = attach_wechat_group_nicks_to_mapping_state(state, member_map_payload)
        result["wechatGroupNickCount"] = len(nick_pool.get("groupNicks") or [])
        state["savedAt"] = int(time.time() * 1000)
        result["frontendStateWrittenTo"] = write_frontend_state(state_path, state, bool(args.direct_file))

    return result


def cmd_map_ftd_players(args: argparse.Namespace) -> int:
    result = build_ftd_player_account_mapping(args)
    cloud_sync = {
        "ok": True,
        "skipped": True,
        "reason": "map-ftd-players is a local/debug command; use validate-and-publish-ftd-map for online publish",
    }
    print_json(
        {
            "ok": True,
            "type": result.get("type"),
            "groupName": result.get("groupName"),
            "mappedAt": result.get("mappedAt"),
            "sourceFile": result.get("sourceFile"),
            "output": result.get("output"),
            "frontendStateWrittenTo": result.get("frontendStateWrittenTo", ""),
            "playerCount": result.get("playerCount"),
            "matchedCount": result.get("matchedCount"),
            "invalidAccountCount": result.get("invalidAccountCount"),
            "ambiguousCount": result.get("ambiguousCount"),
            "unmatchedCount": result.get("unmatchedCount"),
            "indexedCount": result.get("indexedCount"),
            "oqValidation": {
                "checkedAt": (result.get("oqValidation") or {}).get("checkedAt"),
                "checkedCount": (result.get("oqValidation") or {}).get("checkedCount"),
                "okCount": (result.get("oqValidation") or {}).get("okCount"),
                "invalidCount": (result.get("oqValidation") or {}).get("invalidCount"),
                "wallMs": (result.get("oqValidation") or {}).get("wallMs"),
            },
            "ambiguous": result.get("ambiguous", [])[:20],
            "unmatched": result.get("unmatched", [])[:40],
            "invalidAccounts": result.get("invalidAccounts", [])[:40],
            "memberMap": result.get("memberMap"),
            "cloudSync": cloud_sync,
        }
    )
    return 0


def mapping_gate_summary(mapping: dict[str, Any] | None) -> dict[str, Any]:
    mapping = mapping if isinstance(mapping, dict) else {}
    rows = mapping.get("players") if isinstance(mapping.get("players"), list) else []
    oq_validation = mapping.get("oqValidation") if isinstance(mapping.get("oqValidation"), dict) else {}
    relay = mapping.get("registrationRelay") if isinstance(mapping.get("registrationRelay"), dict) else {}
    return {
        "playerCount": int(mapping.get("playerCount") or len(rows) or 0),
        "matchedCount": int(mapping.get("matchedCount") or 0),
        "invalidAccountCount": int(mapping.get("invalidAccountCount") or 0),
        "ambiguousCount": int(mapping.get("ambiguousCount") or 0),
        "unmatchedCount": int(mapping.get("unmatchedCount") or 0),
        "indexedCount": int(mapping.get("indexedCount") or 0),
        "accountFilledCount": sum(1 for row in rows if isinstance(row, dict) and str(row.get("account") or "").strip()),
        "groupNickFilledCount": sum(1 for row in rows if isinstance(row, dict) and str(row.get("groupNick") or row.get("group_nick") or "").strip()),
        "oqValidationCheckedAt": str(oq_validation.get("checkedAt") or ""),
        "oqValidationCheckedCount": int(oq_validation.get("checkedCount") or 0),
        "registrationRelayMonthMatched": bool(relay.get("monthMatched")) if relay else False,
        "registrationRelayEntryCount": int(relay.get("entryCount") or 0) if relay else 0,
    }


GROUP_NICK_REVIEW_HINT = (
    "Agent review hint: WeChat group nicknames usually place the player's name on the left "
    "and the OQ account on the right, separated by a special character such as a space, hyphen, "
    "underscore, slash, or similar punctuation. During agent review, read the nickname text and "
    "split name/account by this convention when it is clear; do not guess when multiple readings remain possible."
)


def agent_review_packet_from_state(state: dict[str, Any], mapping: dict[str, Any]) -> dict[str, Any]:
    rows = mapping.get("players") if isinstance(mapping.get("players"), list) else []
    players = players_from_state(state)
    wechat_nicks = (
        mapping.get("wechatGroupNicks", {}).get("groupNicks")
        if isinstance(mapping.get("wechatGroupNicks"), dict)
        else None
    )
    if not isinstance(wechat_nicks, list):
        wechat_nicks = (
            state.get("wechatGroupNicks", {}).get("groupNicks")
            if isinstance(state.get("wechatGroupNicks"), dict)
            else []
        )
    review_rows = []
    incomplete_rows = []
    for row in rows:
        if not isinstance(row, dict) or mapping_row_deleted(row):
            continue
        item = {
            "ftdName": str(row.get("ftdName") or "").strip(),
            "account": str(row.get("account") or "").strip(),
            "groupNick": str(row.get("groupNick") or row.get("group_nick") or "").strip(),
        }
        review_rows.append(item)
        if not item["account"] or not item["groupNick"]:
            incomplete_rows.append(item)
    roster_rows = [
        {
            "name": str(player.get("displayName") or player.get("name") or "").strip(),
            "account": str(player.get("account") or "").strip(),
        }
        for player in players
        if isinstance(player, dict)
    ]
    registration_relay = mapping.get("registrationRelay") if isinstance(mapping.get("registrationRelay"), dict) else {}
    return {
        "policy": "Agent must review this packet once after script draft build; fill only deterministic additions, then run one OQ validation and publish.",
        "groupNickRule": GROUP_NICK_REVIEW_HINT,
        "registrationRelayPolicy": "If a registration relay row and a WeChat group nickname row both match the same player name but disagree on OQ account, use the registration relay account. The group nickname remains a nickname/source hint only.",
        "registrationRelay": {
            "monthMatched": bool(registration_relay.get("monthMatched")) if registration_relay else False,
            "currentMonth": registration_relay.get("currentMonth") if registration_relay else "",
            "detectedMonths": registration_relay.get("detectedMonths") if registration_relay else [],
            "entryCount": registration_relay.get("entryCount") if registration_relay else 0,
            "ignoredCount": registration_relay.get("ignoredCount") if registration_relay else 0,
            "entries": registration_relay.get("entries", [])[:160] if isinstance(registration_relay.get("entries"), list) else [],
            "ignored": registration_relay.get("ignored", [])[:40] if isinstance(registration_relay.get("ignored"), list) else [],
        },
        "mappingRows": review_rows,
        "incompleteRows": incomplete_rows,
        "rosterRows": roster_rows,
        "wechatGroupNicks": [str(nick) for nick in wechat_nicks if str(nick).strip()],
    }


def assert_mapping_ready_for_publish(mapping: dict[str, Any] | None, stage: str) -> dict[str, Any]:
    summary = mapping_gate_summary(mapping)
    player_count = summary["playerCount"]
    classified_count = summary["matchedCount"] + summary["invalidAccountCount"] + summary["ambiguousCount"] + summary["unmatchedCount"]
    failures: list[str] = []
    if player_count <= 0:
        failures.append("playerCount is zero")
    if summary["accountFilledCount"] <= 0:
        failures.append("all mapping accounts are empty")
    if summary["matchedCount"] <= 0:
        failures.append("matchedCount is zero")
    if classified_count != player_count:
        failures.append(f"classified rows {classified_count} != playerCount {player_count}")
    if not summary["oqValidationCheckedAt"]:
        failures.append("oqValidation.checkedAt is missing")
    if summary["oqValidationCheckedCount"] != summary["accountFilledCount"]:
        failures.append(
            f"oqValidation checked {summary['oqValidationCheckedCount']} accounts, "
            f"but {summary['accountFilledCount']} rows have accounts"
        )
    if failures:
        raise HelperError(f"FTD mapping publish gate failed at {stage}: {'; '.join(failures)}")
    return summary


def cmd_build_and_publish_ftd_map(args: argparse.Namespace) -> int:
    raise HelperError(
        "build-and-publish-ftd-map is disabled to prevent skipping agent review; "
        "use build-ftd-map-draft, patch-ftd-map --no-changes-reviewed or --patch-file, "
        "then validate-and-publish-ftd-map"
    )


def cmd_build_ftd_map_draft(args: argparse.Namespace) -> int:
    if not str(args.ftd_players or "").strip():
        raise HelperError("--ftd-players is required; an imported empty frontend table is not enough")
    if args.no_refresh_map:
        raise HelperError("build-ftd-map-draft must refresh the WeChat member map; do not pass --no-refresh-map")
    if not args.write_frontend:
        raise HelperError("build-ftd-map-draft must write through the local frontend API; do not disable --write-frontend")
    if not str(args.output or "").strip():
        args.output = str(default_hard_flow_ftd_player_map_output(Path(args.ftd_players)))
    args.skip_oq_validation = True

    state_path = Path(args.frontend_state)
    before_state = read_frontend_state(state_path, bool(args.direct_file))
    before_saved_at = before_state.get("savedAt")

    result = build_ftd_player_account_mapping(args)

    after_state = read_frontend_state(state_path, bool(args.direct_file))
    if after_state.get("savedAt") == before_saved_at:
        raise HelperError("local frontend state did not change after initial mapping build")
    local_mapping = after_state.get("ftdPlayerAccountMapping") if isinstance(after_state.get("ftdPlayerAccountMapping"), dict) else {}
    agent_review_packet = agent_review_packet_from_state(after_state, local_mapping)
    local_summary = mapping_gate_summary(local_mapping)

    print_json(
        {
            "ok": True,
            "type": "build-ftd-map-draft",
            "sourceFile": result.get("sourceFile"),
            "output": result.get("output"),
            "frontendStateWrittenTo": result.get("frontendStateWrittenTo", ""),
            "localSummary": local_summary,
            "agentReviewPacket": agent_review_packet,
            "nextRequiredStep": "Agent must review agentReviewPacket, then run patch-ftd-map with deterministic edits or --no-changes-reviewed.",
            "invalidAccounts": local_mapping.get("invalidAccounts", [])[:40],
            "unmatched": local_mapping.get("unmatched", [])[:40],
            "ambiguous": local_mapping.get("ambiguous", [])[:20],
        }
    )
    return 0


def mapping_rows_from_frontend_state(state: dict[str, Any]) -> list[dict[str, Any]]:
    mapping = state.get("ftdPlayerAccountMapping") if isinstance(state, dict) else None
    if not isinstance(mapping, dict):
        return []
    rows = mapping.get("players")
    if not isinstance(rows, list):
        return []
    return [row for row in rows if isinstance(row, dict)]


def apply_agent_review_patch_to_mapping(mapping: dict[str, Any], patch_rows: list[dict[str, Any]], reviewed_at: str) -> dict[str, Any]:
    rows = mapping.get("players") if isinstance(mapping.get("players"), list) else []
    by_key = {normalize_name_key(row.get("ftdName") or ""): row for row in rows if isinstance(row, dict)}
    applied: list[dict[str, Any]] = []
    for patch in patch_rows:
        if not isinstance(patch, dict):
            continue
        ftd_name = str(patch.get("ftdName") or patch.get("name") or "").strip()
        key = normalize_name_key(ftd_name)
        if not key or key not in by_key:
            raise HelperError(f"patch row does not match any FTD mapping row: {ftd_name}")
        row = by_key[key]
        next_account = str(patch.get("account") if "account" in patch else row.get("account") or "").strip()
        next_group_nick = str(patch.get("groupNick") if "groupNick" in patch else patch.get("group_nick") if "group_nick" in patch else row.get("groupNick") or "").strip()
        if "account" in patch and next_account != str(row.get("account") or "").strip():
            row["account"] = next_account
            row["oqCheck"] = None
        if ("groupNick" in patch or "group_nick" in patch) and next_group_nick != str(row.get("groupNick") or row.get("group_nick") or "").strip():
            row["groupNick"] = next_group_nick
        row["source"] = "agent-review"
        row["editAudit"] = {"by": "agent", "action": "agent-review-map-patch", "at": reviewed_at}
        applied.append({"ftdName": row.get("ftdName") or ftd_name, "account": row.get("account") or "", "groupNick": row.get("groupNick") or ""})
    rebuilt = rebuild_mapping_lists_from_rows(sanitize_mapping_rows_for_shared_state(rows), reviewed_at)
    return {
        **mapping,
        "mappedAt": reviewed_at,
        "updatedAt": int(time.time() * 1000),
        "players": sanitize_mapping_rows_for_shared_state(rows)[:300],
        "matched": rebuilt["matched"][:120],
        "invalidAccounts": rebuilt["invalid"][:120],
        "ambiguous": rebuilt["ambiguous"][:120],
        "unmatched": rebuilt["unmatched"][:120],
        "accountIndex": rebuilt["accountIndex"],
        "matchedCount": len(rebuilt["matched"]),
        "invalidAccountCount": len(rebuilt["invalid"]),
        "ambiguousCount": len(rebuilt["ambiguous"]),
        "unmatchedCount": len(rebuilt["unmatched"]),
        "indexedCount": len(rebuilt["accountIndex"]),
        "agentReviewStatus": "completed",
        "agentReviewedAt": reviewed_at,
        "agentReviewApplied": applied,
    }


def cmd_patch_ftd_map(args: argparse.Namespace) -> int:
    state_path = Path(args.frontend_state)
    state = read_frontend_state(state_path, bool(args.direct_file))
    mapping = state.get("ftdPlayerAccountMapping") if isinstance(state.get("ftdPlayerAccountMapping"), dict) else None
    if not mapping or not isinstance(mapping.get("players"), list) or not mapping.get("players"):
        raise HelperError("frontend state has no ftdPlayerAccountMapping.players rows")
    reviewed_at = current_iso_timestamp()
    patch_rows: list[dict[str, Any]] = []
    if args.patch_file:
        payload = read_json(Path(args.patch_file))
        if isinstance(payload, dict) and isinstance(payload.get("rows"), list):
            patch_rows = payload["rows"]
        elif isinstance(payload, list):
            patch_rows = payload
        else:
            raise HelperError("patch file must be a JSON array or an object with rows[]")
    elif args.patch_json:
        payload = json.loads(args.patch_json)
        if isinstance(payload, dict) and isinstance(payload.get("rows"), list):
            patch_rows = payload["rows"]
        elif isinstance(payload, list):
            patch_rows = payload
        else:
            raise HelperError("patch JSON must be a JSON array or an object with rows[]")
    elif not args.no_changes_reviewed:
        raise HelperError("agent review must provide --patch-file/--patch-json or --no-changes-reviewed")
    next_mapping = apply_agent_review_patch_to_mapping(mapping, patch_rows, reviewed_at)
    if args.no_changes_reviewed and not patch_rows:
        next_mapping["agentReviewApplied"] = []
    state["ftdPlayerAccountMapping"] = next_mapping
    state["savedAt"] = int(time.time() * 1000)
    written_to = write_frontend_state(state_path, state, bool(args.direct_file))
    print_json(
        {
            "ok": True,
            "type": "patch-ftd-map",
            "frontendStateWrittenTo": written_to,
            "agentReviewStatus": next_mapping.get("agentReviewStatus"),
            "agentReviewedAt": next_mapping.get("agentReviewedAt"),
            "appliedCount": len(next_mapping.get("agentReviewApplied") or []),
            "summary": mapping_gate_summary(next_mapping),
            "nextRequiredStep": "Run validate-and-publish-ftd-map. It will perform the single allowed OQ validation pass and publish online.",
        }
    )
    return 0


def cmd_validate_oq_accounts(args: argparse.Namespace) -> int:
    start = parse_local_time_optional(args.from_time)
    end = parse_local_time_optional(args.to_time)
    state = read_frontend_state(Path(args.frontend_state), bool(args.direct_file))
    mapping = state.get("ftdPlayerAccountMapping") if isinstance(state.get("ftdPlayerAccountMapping"), dict) else None
    rows = mapping_rows_from_frontend_state(state)
    if not mapping or not rows:
        raise HelperError("frontend state has no ftdPlayerAccountMapping.players rows")
    validation = validate_oq_accounts(
        [str(row.get("account") or "").strip() for row in rows],
        mode=args.oq_mode,
        start=start,
        end=end,
        concurrency=args.oq_concurrency,
        base_url=args.oq_base_url,
        timeout=args.oq_timeout,
    )
    mapped_at = current_iso_timestamp()
    next_rows = apply_oq_validation_to_mapping_rows(rows, validation, "手动校验OQ账号")
    rebuilt = rebuild_mapping_lists_from_rows(next_rows, mapped_at)
    state["ftdPlayerAccountMapping"] = {
        **mapping,
        "mappedAt": mapped_at,
        "updatedAt": int(time.time() * 1000),
        "players": next_rows[:300],
        "matched": rebuilt["matched"][:120],
        "invalidAccounts": rebuilt["invalid"][:120],
        "ambiguous": rebuilt["ambiguous"][:120],
        "unmatched": rebuilt["unmatched"][:120],
        "accountIndex": rebuilt["accountIndex"],
        "matchedCount": len(rebuilt["matched"]),
        "invalidAccountCount": len(rebuilt["invalid"]),
        "ambiguousCount": len(rebuilt["ambiguous"]),
        "unmatchedCount": len(rebuilt["unmatched"]),
        "indexedCount": len(rebuilt["accountIndex"]),
        "oqValidation": validation,
    }
    state["savedAt"] = int(time.time() * 1000)
    written_to = write_frontend_state(Path(args.frontend_state), state, bool(args.direct_file))
    print_json(
        {
            "ok": True,
            "type": "oq-account-validation",
            "frontendStateWrittenTo": written_to,
            "checkedAt": validation.get("checkedAt"),
            "checkedCount": validation.get("checkedCount"),
            "okCount": validation.get("okCount"),
            "invalidCount": validation.get("invalidCount"),
            "wallMs": validation.get("wallMs"),
            "invalidAccounts": rebuilt["invalid"][:40],
            "results": validation.get("results", []),
        }
    )
    return 0


def validate_oq_mapping_in_state(state: dict[str, Any], args: argparse.Namespace, audit_action: str) -> dict[str, Any]:
    mapping = state.get("ftdPlayerAccountMapping") if isinstance(state.get("ftdPlayerAccountMapping"), dict) else None
    rows = mapping_rows_from_frontend_state(state)
    if not mapping or not rows:
        raise HelperError("frontend state has no ftdPlayerAccountMapping.players rows")
    validation = validate_oq_accounts(
        [str(row.get("account") or "").strip() for row in rows],
        mode=args.oq_mode,
        concurrency=args.oq_concurrency,
        base_url=args.oq_base_url,
        timeout=args.oq_timeout,
    )
    mapped_at = current_iso_timestamp()
    next_rows = sanitize_mapping_rows_for_shared_state(apply_oq_validation_to_mapping_rows(rows, validation, audit_action))
    rebuilt = rebuild_mapping_lists_from_rows(next_rows, mapped_at)
    state["ftdPlayerAccountMapping"] = {
        **mapping,
        "mappedAt": mapped_at,
        "updatedAt": int(time.time() * 1000),
        "players": next_rows[:300],
        "matched": rebuilt["matched"][:120],
        "invalidAccounts": rebuilt["invalid"][:120],
        "ambiguous": rebuilt["ambiguous"][:120],
        "unmatched": rebuilt["unmatched"][:120],
        "accountIndex": rebuilt["accountIndex"],
        "matchedCount": len(rebuilt["matched"]),
        "invalidAccountCount": len(rebuilt["invalid"]),
        "ambiguousCount": len(rebuilt["ambiguous"]),
        "unmatchedCount": len(rebuilt["unmatched"]),
        "indexedCount": len(rebuilt["accountIndex"]),
        "oqValidation": validation,
    }
    return {"validation": validation, "rebuilt": rebuilt, "mapping": state["ftdPlayerAccountMapping"]}


def cmd_validate_and_publish_ftd_map(args: argparse.Namespace) -> int:
    state_path = Path(args.frontend_state)
    state = read_frontend_state(state_path, bool(args.direct_file))
    mapping = state.get("ftdPlayerAccountMapping") if isinstance(state.get("ftdPlayerAccountMapping"), dict) else None
    if not mapping:
        raise HelperError("frontend state has no ftdPlayerAccountMapping")
    if str(mapping.get("agentReviewStatus") or "") != "completed":
        raise HelperError("agent review has not been completed; run patch-ftd-map first")
    nick_pool = ensure_wechat_group_nicks_for_publish(state, args.group)
    validated = validate_oq_mapping_in_state(state, args, "agent-review-oq-validation")
    attach_wechat_group_nicks_to_mapping_state(state, {"members": [], **nick_pool})
    state["savedAt"] = int(time.time() * 1000)
    written_to = write_frontend_state(state_path, state, bool(args.direct_file))
    local_mapping = state.get("ftdPlayerAccountMapping") if isinstance(state.get("ftdPlayerAccountMapping"), dict) else {}
    local_summary = assert_mapping_ready_for_publish(local_mapping, "local-state")
    cloud_sync = map_collab_sync("publish-current", state_path)
    remote_summary = {
        "playerCount": int(cloud_sync.get("playerCount") or 0),
        "matchedCount": int(cloud_sync.get("matchedCount") or 0),
        "invalidAccountCount": int(cloud_sync.get("invalidAccountCount") or 0),
        "ambiguousCount": int(cloud_sync.get("ambiguousCount") or 0),
        "unmatchedCount": int(cloud_sync.get("unmatchedCount") or 0),
    }
    for key in ("playerCount", "matchedCount", "invalidAccountCount", "ambiguousCount", "unmatchedCount"):
        if remote_summary[key] != local_summary[key]:
            raise HelperError(
                f"remote publish verification failed: {key} local={local_summary[key]} remote={remote_summary[key]}"
            )
    print_json(
        {
            "ok": True,
            "type": "validate-and-publish-ftd-map",
            "frontendStateWrittenTo": written_to,
            "localSummary": local_summary,
            "wechatGroupNickCount": len(nick_pool.get("groupNicks") or []),
            "oqValidation": {
                "checkedAt": validated["validation"].get("checkedAt"),
                "checkedCount": validated["validation"].get("checkedCount"),
                "okCount": validated["validation"].get("okCount"),
                "invalidCount": validated["validation"].get("invalidCount"),
                "wallMs": validated["validation"].get("wallMs"),
            },
            "remote": {
                "id": cloud_sync.get("id"),
                "revision": cloud_sync.get("revision"),
                **remote_summary,
                "groupNickCandidateCount": cloud_sync.get("groupNickCandidateCount"),
            },
            "invalidAccounts": local_mapping.get("invalidAccounts", [])[:40],
            "unmatched": local_mapping.get("unmatched", [])[:40],
        }
    )
    return 0


def roster_hint_for_ftd_name(roster_players: list[dict[str, Any]], ftd_name: str) -> dict[str, Any]:
    raw_key = normalize(ftd_name)
    if not raw_key:
        return {"status": "unmatched", "matchedDisplayName": "", "matchedAccount": "", "matchReasons": []}

    def as_candidate(player: dict[str, Any], reasons: list[str]) -> dict[str, Any]:
        return {
            "player": player,
            "reasons": reasons,
        }

    candidates: list[dict[str, Any]] = []
    for player in roster_players:
        if not isinstance(player, dict):
            continue
        display = str(player.get("displayName") or "")
        account = str(player.get("account") or "")
        reasons = []
        if account and normalize(account) == raw_key:
            reasons.append("account-exact")
        if display and normalize(display) == raw_key:
            reasons.append("name-exact")
        if reasons:
            candidates.append(as_candidate(player, reasons))

    account_exact = [item for item in candidates if "account-exact" in item["reasons"]]
    name_exact = [item for item in candidates if "name-exact" in item["reasons"]]
    effective = account_exact if len(account_exact) == 1 else name_exact if len(name_exact) == 1 else candidates

    if len(effective) == 1:
        player = effective[0]["player"]
        return {
            "status": "matched",
            "matchedDisplayName": player.get("displayName") or "",
            "matchedAccount": player.get("account") or "",
            "matchReasons": effective[0]["reasons"],
            "candidateDisplayNames": [item["player"].get("displayName") or "" for item in candidates],
            "source": "ftd-exact",
        }
    if candidates:
        return {
            "status": "ambiguous",
            "matchedDisplayName": "",
            "matchedAccount": "",
            "matchReasons": [],
            "candidateDisplayNames": [item["player"].get("displayName") or "" for item in candidates],
            "candidates": [
                {
                    "displayName": item["player"].get("displayName") or "",
                    "account": item["player"].get("account") or "",
                    "reasons": item["reasons"],
                }
                for item in candidates
            ],
            "source": "ftd-exact",
        }

    fallback = shared_roster_match_hints(roster_players, [ftd_name], prefer_checked=False).get(ftd_name)
    if isinstance(fallback, dict) and fallback.get("status") == "matched":
        fallback = {**fallback, "source": fallback.get("source") or "ftd-fallback"}
        return fallback
    return fallback if isinstance(fallback, dict) else {
        "status": "unmatched",
        "matchedDisplayName": "",
        "matchedAccount": "",
        "matchReasons": [],
        "source": "ftd-exact",
    }


def enrich_ftd_pairing_players(
    round_item: dict[str, Any],
    roster_players: list[dict[str, Any]],
    round_no: int,
    member_map_payload: dict[str, Any] | None = None,
    ftd_mapping_rows: dict[str, dict[str, Any]] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, dict[str, Any]]]:
    pairings = round_item.get("ftdPairings") if isinstance(round_item.get("ftdPairings"), list) else []
    issues: list[dict[str, Any]] = []
    enriched_by_pairing_side: dict[tuple[int, str], dict[str, Any]] = {}
    mapping_rows = ftd_mapping_rows if isinstance(ftd_mapping_rows, dict) else {}

    for pairing_index, pairing in enumerate(pairings):
        if not isinstance(pairing, dict):
            continue
        table = pairing.get("table")
        for side in ("black", "white"):
            raw_name = str(pairing.get(side) or "").strip()
            if not raw_name or raw_name.upper() == "BYE":
                continue
            hint = roster_hint_for_ftd_name(roster_players, raw_name)
            status = hint.get("status") or "unmatched"
            matched_name = str(hint.get("matchedDisplayName") or "")
            matched_account = str(hint.get("matchedAccount") or "")
            map_hint = ftd_mapping_hint(mapping_rows, raw_name)
            if map_hint is not None:
                mapped_account = str(map_hint.get("account") or "").strip()
                if mapped_account:
                    matched_account = mapped_account
                    matched_name = matched_name or str(map_hint.get("ftdName") or raw_name)
                    if status != "matched":
                        status = "matched"
                    hint = {
                        **hint,
                        "status": "matched",
                        "matchedDisplayName": matched_name or str(map_hint.get("ftdName") or raw_name),
                        "matchedAccount": matched_account,
                        "matchReasons": list(hint.get("matchReasons") or []) + ["ftdPlayerAccountMapping"],
                        "source": "ftd-player-account-mapping",
                        "ftdPlayerAccountMapping": map_hint,
                    }
                else:
                    status = "matched"
                    matched_name = matched_name or str(map_hint.get("ftdName") or raw_name)
                    matched_account = ""
                    hint = {
                        **hint,
                        "status": "matched",
                        "matchedDisplayName": matched_name,
                        "matchedAccount": "",
                        "matchReasons": list(hint.get("matchReasons") or []) + ["ftdPlayerAccountMapping-empty-account"],
                        "source": "ftd-player-account-mapping-empty",
                        "ftdPlayerAccountMapping": map_hint,
                    }
            if status != "matched":
                issues.append(
                    {
                        "table": table,
                        "side": side,
                        "ftdName": raw_name,
                        "status": status,
                        "candidateDisplayNames": hint.get("candidateDisplayNames") or [],
                        "candidates": hint.get("candidates") or [],
                        "reason": "FTD player could not be uniquely mapped to local roster/OQ account",
                    }
                )
                continue
            if not matched_account:
                member_hint = member_map_account_hint(member_map_payload, matched_name, raw_name)
                if map_hint is not None:
                    issues.append(
                        {
                            "table": table,
                            "side": side,
                            "ftdName": raw_name,
                            "matchedDisplayName": matched_name,
                            "status": "missing-account",
                            "reason": "FTD Player/OQ mapping row exists but has an empty OQ account",
                            "mappingState": map_hint.get("mappingState") or "",
                            "mappingSource": map_hint.get("source") or "",
                        }
                    )
                    continue
                if member_hint and member_hint.get("status") == "matched":
                    matched_account = str(member_hint.get("account") or "")
                    hint = {
                        **hint,
                        "matchedAccount": matched_account,
                        "matchReasons": list(hint.get("matchReasons") or []) + ["member-map-group-nick-account"],
                        "source": "ftd-exact+member-map",
                        "memberMapAccountHint": member_hint,
                    }
                elif member_hint and member_hint.get("status") == "ambiguous":
                    issues.append(
                        {
                            "table": table,
                            "side": side,
                            "ftdName": raw_name,
                            "matchedDisplayName": matched_name,
                            "status": "member-map-account-ambiguous",
                            "candidates": member_hint.get("candidates") or [],
                            "reason": "Group nickname map had multiple possible OQ account tokens",
                        }
                    )
                    continue
            if not matched_account:
                issues.append(
                    {
                        "table": table,
                        "side": side,
                        "ftdName": raw_name,
                        "matchedDisplayName": matched_name,
                        "status": "missing-account",
                        "reason": "FTD player matched roster name but has no OQ account in local roster",
                    }
                )
                continue
            enriched_by_pairing_side[(pairing_index, side)] = {
                "displayName": matched_name,
                "account": matched_account,
                "groupNick": str((map_hint or {}).get("groupNick") or (map_hint or {}).get("group_nick") or ""),
                "ftdName": raw_name,
                "group": f"第 {round_no} 轮配对表",
                "checkedIn": True,
                "pairingTable": table,
                "pairingSide": side,
                "matchReasons": hint.get("matchReasons") or [],
                "matchSource": hint.get("source") or "all-roster",
                "memberMapAccountHint": hint.get("memberMapAccountHint") or {},
                "ftdPlayerAccountMapping": hint.get("ftdPlayerAccountMapping") or {},
                "black": pairing.get("black"),
                "white": pairing.get("white"),
            }

    enriched_players: list[dict[str, Any]] = []
    pairing_context_by_key: dict[str, dict[str, Any]] = {}
    seen_keys: set[str] = set()
    for pairing_index, pairing in enumerate(pairings):
        if not isinstance(pairing, dict):
            continue
        black = enriched_by_pairing_side.get((pairing_index, "black"))
        white = enriched_by_pairing_side.get((pairing_index, "white"))
        for side, player, opponent in (("black", black, white), ("white", white, black)):
            if not player:
                continue
            if opponent:
                player["opponentDisplayName"] = opponent.get("displayName") or ""
                player["opponentAccount"] = opponent.get("account") or ""
                player["opponentFtdName"] = opponent.get("ftdName") or ""
            key = pairing_player_key(player.get("displayName"), player.get("account"))
            if key in seen_keys:
                issues.append(
                    {
                        "table": player.get("pairingTable"),
                        "side": side,
                        "ftdName": player.get("ftdName"),
                        "matchedDisplayName": player.get("displayName"),
                        "matchedAccount": player.get("account"),
                        "status": "duplicate-player",
                        "reason": "Same local player/account appears more than once in current FTD round",
                    }
                )
                continue
            seen_keys.add(key)
            enriched_players.append(player)
            context = {
                "table": player.get("pairingTable"),
                "side": player.get("pairingSide"),
                "reporterName": player.get("displayName") or "",
                "reporterAccount": player.get("account") or "",
                "reporterFtdName": player.get("ftdName") or "",
                "opponentName": player.get("opponentDisplayName") or "",
                "opponentAccount": player.get("opponentAccount") or "",
                "opponentFtdName": player.get("opponentFtdName") or "",
                "black": player.get("black"),
                "white": player.get("white"),
                "matchReasons": player.get("matchReasons") or [],
                "accountCheckPolicy": (
                    "When manually reading the screenshot, tolerate minor visual mistakes and similar IDs; "
                    "before writing, check blockingScoreChecks and report if any applies."
                ),
                "memberMapAccountHint": player.get("memberMapAccountHint") or {},
                "ftdPlayerAccountMapping": player.get("ftdPlayerAccountMapping") or {},
            }
            pairing_context_by_key[key] = context
            name_key = pairing_player_key(player.get("displayName"), "")
            pairing_context_by_key.setdefault(name_key, context)
    return enriched_players, issues, pairing_context_by_key


def pairing_account_index(
    round_item: dict[str, Any],
    pairing_context_by_key: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    pairings = round_item.get("ftdPairings") if isinstance(round_item.get("ftdPairings"), list) else []
    contexts = [item for item in pairing_context_by_key.values() if isinstance(item, dict)]
    index: list[dict[str, Any]] = []
    seen_tables: set[str] = set()
    for pairing in pairings:
        if not isinstance(pairing, dict):
            continue
        table = pairing.get("table")
        table_key = normalize_text_like(table)
        if table_key in seen_tables:
            continue
        seen_tables.add(table_key)
        sides: dict[str, dict[str, Any]] = {}
        for context in contexts:
            if normalize_text_like(context.get("table")) != table_key:
                continue
            side = str(context.get("side") or "")
            if side in {"black", "white"} and side not in sides:
                sides[side] = context
        black = sides.get("black") or {}
        white = sides.get("white") or {}
        black_account = str(black.get("reporterAccount") or "")
        white_account = str(white.get("reporterAccount") or "")
        accounts = [account for account in (black_account, white_account) if account]
        index.append(
            {
                "table": table,
                "blackFtdName": str(pairing.get("black") or ""),
                "whiteFtdName": str(pairing.get("white") or ""),
                "blackDisplayName": str(black.get("reporterName") or ""),
                "whiteDisplayName": str(white.get("reporterName") or ""),
                "blackAccount": black_account,
                "whiteAccount": white_account,
                "accounts": accounts,
                "accountKey": "|".join(sorted(normalize_name_key(account) for account in accounts if account)),
                "fullyMapped": bool(black_account and white_account),
            }
        )
    return index


def shared_roster_match_hints(
    players: list[dict[str, Any]],
    senders: list[str],
    prefer_checked: bool = True,
) -> dict[str, dict[str, Any]]:
    unique_senders = sorted({str(sender or "") for sender in senders if str(sender or "")})
    if not unique_senders:
        return {}
    payload = {
        "players": players,
        "senders": unique_senders,
        "preferChecked": bool(prefer_checked),
    }
    try:
        completed = subprocess.run(
            ["node", str(ROSTER_MATCHER)],
            cwd=str(ROOT),
            input=json.dumps(payload, ensure_ascii=False),
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise HelperError(f"shared roster matcher failed: {exc}") from exc
    if completed.returncode != 0:
        raise HelperError(
            "shared roster matcher failed:\n"
            + (completed.stderr or completed.stdout or "").strip()
        )
    try:
        result = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise HelperError(f"shared roster matcher returned invalid JSON: {completed.stdout[:500]}") from exc
    matches = result.get("matches", {}) if isinstance(result, dict) else {}
    return {str(key): value for key, value in matches.items() if isinstance(value, dict)}


def prefer_roster_sender(item: dict[str, Any], hint: dict[str, Any] | None) -> dict[str, Any]:
    source_sender = str(item.get("sender") or "")
    hint = hint if isinstance(hint, dict) else {}
    if source_sender and not str(item.get("wechatSender") or "").strip():
        item["wechatSender"] = source_sender
    if hint.get("status") == "matched" and hint.get("source") in {"checked-in-roster", "round-pairing-index"}:
        item["wechatSender"] = source_sender
        item["sender"] = hint.get("matchedDisplayName") or source_sender
        item["senderAccount"] = hint.get("matchedAccount") or ""
        item["playerHint"] = {
            **hint,
            "wechatSender": source_sender,
        }
        return item

    item["playerHint"] = {
        **hint,
        "wechatSender": source_sender,
    }
    return item


def load_group_map(group_name: str) -> dict[str, Any]:
    payload = agent_checkin_bridge.load_member_map(group_name)
    members = agent_checkin_bridge.member_map_by_username(payload)
    return {"payload": payload, "members": members}


def resolve_group_username(group_name: str) -> str:
    payload = load_group_map(group_name)["payload"]
    return payload["room_username"]


def parse_time_range(start: str, end: str) -> tuple[int | None, int | None]:
    try:
        return mcp_server._parse_time_range(start, end)
    except ValueError as exc:
        raise HelperError(str(exc)) from exc


def resolve_sender_username(real_sender_id: Any, sender_from_content: str, id_to_username: dict[int, str]) -> str:
    return agent_checkin_bridge.resolve_sender_username(
        real_sender_id,
        sender_from_content,
        True,
        id_to_username,
    )


def image_messages(
    group_name: str,
    start: str,
    end: str,
    limit: int,
    offset: int,
    oldest_first: bool,
    strict_map: bool,
) -> dict[str, Any]:
    group = load_group_map(group_name)
    mapping_payload = group["payload"]
    nick_by_username = group["members"]
    username = mapping_payload["room_username"]

    ctx = mcp_server._resolve_chat_context(username)
    if not ctx or not ctx.get("message_tables"):
        raise HelperError(f"Cannot find message tables for {username}")

    start_ts, end_ts = parse_time_range(start, end)
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
                        type_filter=[3],
                    )
                    if not rows:
                        break
                    fetch_offset += len(rows)

                    for row in rows:
                        local_id, local_type, create_time, real_sender_id, content, ct = row
                        decoded = mcp_server._decompress_content(content, ct)
                        if decoded is None:
                            decoded = ""
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
                        sender_username = resolve_sender_username(real_sender_id, sender_from_content, id_to_username)
                        if not sender_username:
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
                                    "local_id": int(local_id),
                                    "timestamp": int(create_time or 0),
                                    "sender_username": sender_username,
                                    "original_sender": original_label,
                                    "content": text,
                                }
                            )
                            if strict_map:
                                continue
                            sender = original_label or sender_username
                            source_contact_display = ""
                            source_group_nick = ""
                        else:
                            sender = mapped["group_nick"]
                            source_contact_display = mapped.get("contact_display", "")
                            source_group_nick = mapped["group_nick"]

                        entries.append(
                            (
                                int(create_time or 0),
                                {
                                    "local_id": int(local_id),
                                    "timestamp": int(create_time or 0),
                                    "time": datetime.fromtimestamp(create_time).strftime("%Y-%m-%d %H:%M:%S"),
                                    "sender": sender,
                                    "sender_username": sender_username,
                                    "source_contact_display": source_contact_display,
                                    "source_group_nick": source_group_nick,
                                    "content": text,
                                    "type": mcp_server.format_msg_type(local_type),
                                },
                            )
                        )
                        if len(entries) - before >= candidate_limit:
                            break

                    if len(rows) < mcp_server._history_query_batch_size(candidate_limit):
                        break
        except Exception as exc:  # noqa: BLE001
            failures.append(f"{table_ctx['db_path']}: {exc}")

    if failures:
        raise HelperError("Failed reading image messages:\n" + "\n".join(failures))
    if strict_map and unmapped:
        raise HelperError(
            "Unmapped image senders exist; refusing ambiguous output:\n"
            + json.dumps(unmapped[:30], ensure_ascii=False, indent=2)
        )

    ordered = sorted(entries, key=lambda item: item[0], reverse=not oldest_first)
    paged = ordered[offset : offset + limit]
    paged.sort(key=lambda item: item[0])

    return {
        "schema_version": 1,
        "export_kind": "agent_match_images",
        "group_name": mapping_payload["group_name"],
        "room_username": mapping_payload["room_username"],
        "map_refreshed_at": mapping_payload.get("refreshed_at"),
        "range": {"start": start, "end": end},
        "limit": limit,
        "offset": offset,
        "oldest_first": oldest_first,
        "unmapped": unmapped,
        "messages": [item for _, item in paged],
    }


def score_scan_flow_hint_matches(text: str) -> list[str]:
    matches = []
    for label, pattern in SCORE_SCAN_FLOW_HINTS:
        if re.search(pattern, str(text or ""), flags=re.IGNORECASE):
            matches.append(label)
    return matches


def is_next_round_pairing_hint(text: Any) -> bool:
    return bool(NEXT_ROUND_PAIRING_HINT_RE.search(str(text or "")))


def next_round_password_stop_hint(
    flow_hints: dict[str, Any],
    current_round: int,
    max_table: int,
    keyword_limit: int = 20,
    score_helper: dict[str, Any] | None = None,
) -> dict[str, Any]:
    helper = score_helper if isinstance(score_helper, dict) else {}
    next_stage = next_score_stage_keywords(helper, int(current_round), int(max_table or 1), int(keyword_limit or 20))
    next_round = int(next_stage.get("round") or (int(current_round) + 1))
    keywords = next_stage.get("keywords") if isinstance(next_stage.get("keywords"), list) else []
    round_keywords = [item for item in keywords if item.get("kind") == "round"]
    password_keywords = [item for item in keywords if item.get("kind") == "password"]
    messages = flow_hints.get("messages") if isinstance(flow_hints, dict) else []
    round_matches = []
    password_matches = []
    if isinstance(messages, list):
        for message in messages:
            if not isinstance(message, dict):
                continue
            content = str(message.get("content") or "")
            matched_round = [
                item for item in round_keywords if content_matches_keyword(content, str(item.get("keyword") or ""))
            ]
            matched_password = [
                item for item in password_keywords if content_matches_keyword(content, str(item.get("keyword") or ""))
            ]
            if matched_round:
                round_matches.append(
                    {
                        "time": message.get("time"),
                        "localId": message.get("local_id"),
                        "matchedKeywords": matched_round,
                        "content": console_safe_text(content),
                    }
                )
            if matched_password:
                password_matches.append(
                    {
                        "time": message.get("time"),
                        "localId": message.get("local_id"),
                        "matchedKeywords": matched_password,
                        "content": console_safe_text(content),
                    }
                )
    trigger = bool(round_matches and password_matches)
    return {
        "trigger": trigger,
        "code": "next-round-password-visible" if trigger else "",
        "currentRound": current_round,
        "nextRound": next_round,
        "nextStage": {key: value for key, value in next_stage.items() if key != "keywords"},
        "maxTable": max_table,
        "keywordLimit": int(keyword_limit or 0),
        "keywordPolicy": str(next_stage.get("keywordPolicy") or "advisory stop hint requires both next-stage text and password text"),
        "roundKeywordMatches": round_matches,
        "passwordKeywordMatches": password_matches,
        "reason": (
            "current score-scan window already contains next-stage text and password text; ask whether to stop polling the current round"
            if trigger
            else ""
        ),
    }


def score_scan_stop_polling_decision(
    flow_hints: dict[str, Any],
    next_round_password_hint: dict[str, Any] | None = None,
) -> dict[str, Any]:
    messages = flow_hints.get("messages") if isinstance(flow_hints, dict) else []
    stop_messages = []
    if isinstance(messages, list):
        for item in messages:
            if not isinstance(item, dict):
                continue
            matches = item.get("matches") if isinstance(item.get("matches"), list) else []
            if "round-transition" not in matches:
                continue
            if not is_next_round_pairing_hint(item.get("content")):
                continue
            stop_messages.append(item)
    password_hint = next_round_password_hint if isinstance(next_round_password_hint, dict) else {}
    if password_hint.get("trigger"):
        return {
            "stopPolling": True,
            "stopPollingCode": password_hint.get("code") or "next-round-password-visible",
            "stopPollingReason": password_hint.get("reason") or "next-round password messages are visible",
            "stopPollingMessages": stop_messages,
            "nextRoundPasswordStopHint": password_hint,
        }
    return {
        "stopPolling": bool(stop_messages),
        "stopPollingCode": "next-round-transition-visible" if stop_messages else "",
        "stopPollingReason": (
            "next-round pairing/round-transition message is visible; stop polling the current score window"
            if stop_messages
            else ""
        ),
        "stopPollingMessages": stop_messages,
        "nextRoundPasswordStopHint": password_hint,
    }


def score_scan_flow_hints(group_name: str, start: str, end: str, limit: int) -> dict[str, Any]:
    """Report text messages that may affect score polling flow.

    These hints are advisory only. The script never stops score pushing
    because of them; the agent/user decides whether to continue the current
    polling sequence.
    """
    group = load_group_map(group_name)
    mapping_payload = group["payload"]
    nick_by_username = group["members"]
    username = mapping_payload["room_username"]

    ctx = mcp_server._resolve_chat_context(username)
    if not ctx or not ctx.get("message_tables"):
        return {"messages": [], "errors": [f"Cannot find message tables for {username}"]}

    try:
        start_ts, end_ts = parse_time_range(start, end)
    except HelperError as exc:
        return {"messages": [], "errors": [str(exc)]}

    entries = []
    errors = []
    candidate_limit = max(1, int(limit or 1000))
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
                        oldest_first=True,
                        type_filter=[1],
                    )
                    if not rows:
                        break
                    fetch_offset += len(rows)

                    for row in rows:
                        local_id, local_type, create_time, real_sender_id, content, ct = row
                        decoded = mcp_server._decompress_content(content, ct)
                        if decoded is None:
                            decoded = ""
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
                        matches = score_scan_flow_hint_matches(text)
                        if not matches:
                            continue
                        stop_polling_trigger = is_next_round_pairing_hint(text)

                        sender_username = resolve_sender_username(real_sender_id, sender_from_content, id_to_username)
                        mapped = nick_by_username.get(sender_username)
                        if mapped:
                            sender = mapped["group_nick"]
                        else:
                            sender = mcp_server._resolve_sender_label(
                                real_sender_id,
                                sender_from_content,
                                True,
                                ctx["username"],
                                ctx["display_name"],
                                names,
                                id_to_username,
                            )

                        entries.append(
                            (
                                int(create_time or 0),
                                {
                                    "local_id": int(local_id),
                                    "timestamp": int(create_time or 0),
                                    "time": datetime.fromtimestamp(create_time).strftime("%Y-%m-%d %H:%M:%S"),
                                    "sender": sender,
                                    "sender_username": sender_username,
                                    "content": text,
                                    "matches": matches,
                                    "advisoryOnly": not stop_polling_trigger,
                                    "stopPollingTrigger": stop_polling_trigger,
                                },
                            )
                        )
                        if len(entries) - before >= candidate_limit:
                            break

                    if len(rows) < mcp_server._history_query_batch_size(candidate_limit):
                        break
        except Exception as exc:  # noqa: BLE001 - flow hints must not block scoring
            errors.append(f"{table_ctx['db_path']}: {exc}")

    ordered = [item for _, item in sorted(entries, key=lambda pair: pair[0])]
    return {"messages": ordered, "errors": errors}


def unique_target_path(base_dir: Path, message: dict[str, Any], decoded_path: Path) -> Path:
    suffix = decoded_path.suffix or ".img"
    stamp = datetime.fromtimestamp(message["timestamp"]).strftime("%Y%m%d_%H%M%S")
    sender = re.sub(r'[\\/:*?"<>|\s]+', "_", message.get("sender") or "sender")[:50].strip("_")
    name = f"{stamp}_local{message['local_id']}_{sender}{suffix}"
    return base_dir / name


def get_image_md5_precise(username: str, local_id: int, create_time: int) -> str:
    path = mcp_server._cache.get("message/message_resource.db")
    if not path:
        return ""
    with closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True)) as conn:
        chat_row = conn.execute(
            "SELECT rowid FROM ChatName2Id WHERE user_name = ?",
            (username,),
        ).fetchone()
        if not chat_row:
            return ""
        row = conn.execute(
            "SELECT packed_info FROM MessageResourceInfo "
            "WHERE chat_id = ? AND message_local_id = ? "
            "AND message_create_time = ? "
            "AND (message_local_type = 3 OR message_local_type % 4294967296 = 3) "
            "ORDER BY message_id DESC LIMIT 1",
            (chat_row[0], local_id, create_time),
        ).fetchone()
        if not row or not row[0]:
            return ""
        return extract_md5_from_packed_info(row[0]) or ""


def select_dat_file(dat_files: list[str], file_md5: str) -> str:
    if not dat_files:
        return ""
    selected = dat_files[0]
    for item in dat_files:
        if os.path.basename(item) == f"{file_md5}.dat":
            return item
    for item in dat_files:
        if os.path.basename(item) == f"{file_md5}_W.dat":
            return item
    for item in dat_files:
        if item.endswith("_h.dat"):
            selected = item
            break
    return selected


def dat_file_priority(dat_path: str, file_md5: str) -> int:
    name = os.path.basename(dat_path)
    if name == f"{file_md5}.dat":
        return 0
    if name == f"{file_md5}_W.dat":
        return 1
    if name.endswith("_h.dat"):
        return 2
    if name.endswith("_t.dat"):
        return 4
    return 3


def image_source_kind(dat_path: str, file_md5: str) -> str:
    name = os.path.basename(dat_path)
    parts = Path(dat_path).parts
    if "Bubble" in parts or name == f"{file_md5}_b.dat":
        return "bubble-cache"
    if name.endswith("_t.dat"):
        return "thumbnail"
    if name.endswith("_h.dat"):
        return "high-res-candidate"
    return "primary"


def bubble_dat_files(file_md5: str) -> list[str]:
    base = Path(getattr(mcp_server, "WECHAT_BASE_DIR", "") or "")
    if not base.exists():
        return []
    cache_dir = base / "cache"
    if not cache_dir.exists():
        return []
    return [str(path) for path in cache_dir.rglob(f"{file_md5}_b.dat")]


def ordered_image_dat_candidates(username: str, file_md5: str) -> list[str]:
    candidates = list(mcp_server._image_resolver.find_dat_files(username, file_md5))
    candidates.extend(bubble_dat_files(file_md5))
    seen: set[str] = set()
    unique = []
    for item in candidates:
        normalized = os.path.normcase(os.path.abspath(item))
        if normalized in seen:
            continue
        seen.add(normalized)
        unique.append(item)
    kind_order = {"high-res-candidate": 0, "primary": 1, "bubble-cache": 2, "thumbnail": 3}
    return sorted(
        unique,
        key=lambda path: (
            image_source_kind(path, file_md5) == "thumbnail",
            -(os.path.getsize(path) if os.path.exists(path) else 0),
            kind_order.get(image_source_kind(path, file_md5), 2),
            dat_file_priority(path, file_md5),
        ),
    )


def decode_precise_image(username: str, local_id: int, create_time: int) -> dict[str, Any]:
    file_md5 = get_image_md5_precise(username, local_id, create_time)
    if not file_md5:
        return {"success": False, "error": "cannot find image MD5 for exact local_id/create_time"}

    dat_files = ordered_image_dat_candidates(username, file_md5)
    if not dat_files:
        return {"success": False, "error": "cannot find image .dat file", "md5": file_md5}
    attempts = []
    if any(is_v2_format(item) for item in dat_files) and not mcp_server._image_aes_key:
        return {"success": False, "error": "V2 image needs AES key", "md5": file_md5, "candidates": dat_files}

    out_dir = Path(mcp_server.DECODED_IMAGE_DIR)
    out_dir.mkdir(parents=True, exist_ok=True)
    decoded_candidates = []
    for index, selected in enumerate(dat_files):
        kind = image_source_kind(selected, file_md5)
        if is_v2_format(selected) and not mcp_server._image_aes_key:
            attempts.append({"source": selected, "sourceKind": kind, "ok": False, "error": "V2 image needs AES key"})
            continue
        tmp_path = out_dir / f"{file_md5}_{kind}_{index}.tmp"
        result_path, fmt = decrypt_dat_file(
            selected,
            str(tmp_path),
            mcp_server._image_aes_key,
            mcp_server._image_xor_key,
        )
        if not result_path:
            attempts.append({"source": selected, "sourceKind": kind, "ok": False, "error": "decode failed"})
            continue
        final_path = out_dir / f"{file_md5}_{kind}_{index}.{fmt}"
        if final_path.exists():
            final_path.unlink()
        Path(result_path).replace(final_path)
        width = 0
        height = 0
        try:
            from PIL import Image

            with Image.open(final_path) as im:
                width, height = im.size
        except Exception:
            pass
        decoded_candidates.append(
            {
                "path": str(final_path),
                "format": fmt,
                "source": selected,
                "sourceKind": kind,
                "size": final_path.stat().st_size,
                "resolution": {"width": width, "height": height},
                "pixelArea": int(width) * int(height),
            }
        )
        attempts.append({"source": selected, "sourceKind": kind, "ok": True, "format": fmt, "resolution": {"width": width, "height": height}})
    if decoded_candidates:
        kind_order = {"high-res-candidate": 0, "primary": 1, "bubble-cache": 2, "thumbnail": 3}
        best = sorted(
            decoded_candidates,
            key=lambda item: (
                -int(item.get("pixelArea") or 0),
                -int(item.get("size") or 0),
                kind_order.get(str(item.get("sourceKind") or ""), 2),
            ),
        )[0]
        return {
            "success": True,
            "path": best["path"],
            "format": best.get("format"),
            "md5": file_md5,
            "source": best.get("source", ""),
            "sourceKind": best.get("sourceKind", ""),
            "size": best.get("size", 0),
            "resolution": best.get("resolution") or {},
            "pixelArea": best.get("pixelArea", 0),
            "decodedCandidates": decoded_candidates,
            "decodeAttempts": attempts,
            "originalDecodeError": next(
                (
                    attempt.get("error")
                    for attempt in attempts
                    if attempt.get("sourceKind") == "primary" and not attempt.get("ok")
                ),
                "",
            ),
        }
    return {
        "success": False,
        "error": "decode failed for all image candidates",
        "md5": file_md5,
        "candidates": dat_files,
        "decodeAttempts": attempts,
    }


def make_preview_if_possible(target: Path, fmt: str) -> dict[str, Any]:
    browser_formats = {"jpg", "jpeg", "png", "gif", "webp"}
    fmt = (fmt or "").lower()
    if fmt in browser_formats:
        return {"previewAvailable": True, "previewPath": str(target), "previewFormat": fmt}
    if fmt != "hevc":
        return {"previewAvailable": False, "previewPath": "", "previewError": f"unsupported format: {fmt}"}

    try:
        import av  # type: ignore
    except ImportError:
        return {
            "previewAvailable": False,
            "previewPath": "",
            "previewError": "HEVC/wxgf preview needs PyAV/ffmpeg; raw .hevc was saved",
        }

    try:
        data = target.read_bytes()
        hevc_start = data.find(b"\x00\x00\x00\x01\x40\x01")
        if hevc_start < 0:
            hevc_start = data.find(b"\x00\x00\x00\x01\x42\x01")
        if hevc_start < 0:
            return {"previewAvailable": False, "previewPath": "", "previewError": "HEVC stream start not found"}

        h265_path = target.with_suffix(target.suffix + ".h265")
        jpg_path = target.with_suffix(".jpg")
        h265_path.write_bytes(data[hevc_start:])
        try:
            container = av.open(str(h265_path), format="hevc")
            for frame in container.decode(video=0):
                frame.to_image().save(str(jpg_path), "JPEG", quality=90)
                container.close()
                return {"previewAvailable": True, "previewPath": str(jpg_path), "previewFormat": "jpg"}
            container.close()
        finally:
            if h265_path.exists():
                h265_path.unlink()
    except Exception as exc:  # noqa: BLE001
        return {"previewAvailable": False, "previewPath": "", "previewError": f"HEVC preview failed: {exc}"}
    return {"previewAvailable": False, "previewPath": "", "previewError": "HEVC decoder produced no frame"}


def ensure_png_preview(image_info: dict[str, Any]) -> dict[str, Any]:
    preview_path = image_info.get("previewPath") or image_info.get("path") or ""
    if not preview_path:
        return image_info
    source = Path(preview_path)
    if not source.exists():
        image_info["previewPngAvailable"] = False
        image_info["previewPngError"] = f"preview path not found: {source}"
        return image_info
    if source.suffix.lower() == ".png":
        image_info["previewPngAvailable"] = True
        image_info["previewPngPath"] = str(source)
        return image_info

    png_path = source.with_suffix(".png")
    if png_path.exists():
        image_info["previewPngAvailable"] = True
        image_info["previewPngPath"] = str(png_path)
        return image_info

    try:
        from PIL import Image

        with Image.open(source) as im:
            if im.mode not in ("RGB", "RGBA"):
                im = im.convert("RGB")
            im.save(png_path, "PNG")
        image_info["previewPngAvailable"] = True
        image_info["previewPngPath"] = str(png_path)
    except Exception as exc:  # noqa: BLE001
        image_info["previewPngAvailable"] = False
        image_info["previewPngError"] = f"PNG conversion failed: {exc}"
    return image_info


def attach_image_resolution(image_info: dict[str, Any]) -> dict[str, Any]:
    path = image_info.get("previewPngPath") or image_info.get("previewPath") or image_info.get("path") or ""
    if not path:
        return image_info
    try:
        from PIL import Image

        with Image.open(path) as im:
            image_info["resolution"] = {"width": im.width, "height": im.height}
    except Exception as exc:  # noqa: BLE001
        image_info["resolutionError"] = str(exc)
    return image_info


def summarize_player_hint(hint: dict[str, Any]) -> str:
    status = hint.get("status") or ""
    if status == "matched":
        name = hint.get("matchedDisplayName") or ""
        account = hint.get("matchedAccount") or ""
        suffix = f" / {account}" if account else ""
        return f"matched: {name}{suffix}"
    candidates = hint.get("candidateDisplayNames") or []
    if candidates:
        return f"{status}: " + ", ".join(str(x) for x in candidates if x)
    return status or "unknown"


def manual_score_review_hint(item: dict[str, Any]) -> dict[str, Any]:
    hint = item.get("playerHint") if isinstance(item.get("playerHint"), dict) else {}
    image = item.get("image") if isinstance(item.get("image"), dict) else {}
    pairing_context = item.get("pairingContext") if isinstance(item.get("pairingContext"), dict) else {}
    pairing_account_index = item.get("pairingAccountIndex") if isinstance(item.get("pairingAccountIndex"), list) else []
    return {
        "requiresManualReview": True,
        "matchedDisplayName": hint.get("matchedDisplayName") or "",
        "matchedAccount": hint.get("matchedAccount") or "",
        "opponentDisplayName": pairing_context.get("opponentName") or "",
        "opponentAccount": pairing_context.get("opponentAccount") or "",
        "pairingAccountIndex": pairing_account_index,
        "candidateDisplayNames": hint.get("candidateDisplayNames") or [],
        "imageSourceKind": image.get("sourceKind") or "",
        "imageResolution": image.get("resolution") or {},
        "accountCheckPolicy": pairing_context.get("accountCheckPolicy") or (
            "Tolerate minor visual mistakes and similar IDs; before writing, check blockingScoreChecks."
        ),
        "blockingScoreChecks": BLOCKING_SCORE_CHECKS,
        "note": (
            "OCR is disabled. Open the PNG or preview image and judge the screenshot manually. "
            "The required gate is screenshot-account matching: compare the two visible screenshot OQ IDs "
            "against pairingAccountIndex and identify the unique current-round table whose two accounts both match. "
            "Sender mapping is auxiliary only; it can help locate a candidate table but cannot replace the screenshot OQ ID match. "
            "If sender mapping conflicts with the table uniquely identified by screenshot OQ IDs, keep the screenshot-account gate as authoritative and record the sender conflict reason. "
            "Ignore minor case/spacing/underscore/visual-recognition differences when the ID is clearly similar; "
            "stop if any blockingScoreChecks item applies. "
            "For normal completed games, do not calculate scores from the margin alone; read the upper opponent displayed count, "
            "then compute the sender/self score as 64 minus that opponent count. "
            "Do not use the lower sender/self-side displayed stone count as the scoring source for normal completed games. "
            "Do not use later bot/referee result tables as real score sources or fallback. "
            "Agent score writes should set FTD rows to ready/yellow; completed/green is for frontend confirmation. "
            "Ignore FTD black/white color for score direction."
        ),
    }


def attach_agent_image_fields(item: dict[str, Any]) -> dict[str, Any]:
    source_role = item.get("sourceRole") or message_ready_source_role(item)
    item["sourceRole"] = source_role
    item["allowedReadySource"] = source_role != "referee-summary"
    if source_role == "referee-summary":
        item.pop("pngPath", None)
        item.pop("previewPath", None)
        item["image"] = {}
        item["readySourcePolicy"] = "referee-summary images are for cross-check only; do not write ready from this image"
        item["scoreInference"] = {
            "status": "referee-summary",
            "loserStoneCount": None,
            "reason": "referee-summary image is not a ready score source and is not included in agent image review",
        }
        item["manualScoreReview"] = {
            "required": False,
            "sourceRole": "referee-summary",
            "policy": item["readySourcePolicy"],
        }
        item["loserStoneCount"] = None
        item["verdict"] = "referee-summary"
        item["agentText"] = (
            f"[{item.get('time', '')}] referee-summary image from {item.get('sender', '')}; "
            "no image path is output and agent review is not required."
        )
        return item

    image = item.get("image") if isinstance(item.get("image"), dict) else {}
    pairing_context = item.get("pairingContext") if isinstance(item.get("pairingContext"), dict) else {}
    png_path = image.get("previewPngPath") or ""
    preview_path = image.get("previewPath") or image.get("path") or ""

    item["pngPath"] = png_path
    item["previewPath"] = preview_path
    item["scoreInference"] = {
        "status": "manual-image-review",
        "loserStoneCount": None,
        "reason": "OCR is disabled; open the image path and judge this screenshot manually",
    }
    item["manualScoreReview"] = manual_score_review_hint(item)
    item["loserStoneCount"] = None
    item["verdict"] = "manual-image-review"

    lines = [
        f"[{item.get('time', '')}] 图片",
        f"发图人: {item.get('sender', '')}",
        "判读方式: 不使用 OCR；打开图片人工识别，再按当前轮配对表登记",
        "自动提示: manual-image-review；脚本只输出图片路径和匹配信息",
        f"名单映射: {summarize_player_hint(item.get('playerHint') or {})}",
        f"本桌: {pairing_context.get('table') or '(未知)'}",
        f"发图者: {pairing_context.get('reporterName') or item.get('sender', '')} / {pairing_context.get('reporterAccount') or item.get('senderAccount', '') or '(无OQ)'}",
        f"对手: {pairing_context.get('opponentName') or '(未知)'} / {pairing_context.get('opponentAccount') or '(无OQ)'}",
        "账号核对: 截图ID与上述两人OQ号明显不同时才报异常；很相似的轻微识别误差可忽略",
        f"图片来源: {image.get('sourceKind') or '(未知)'}",
        f"图片分辨率: {image.get('resolution') or '(未知)'}",
        f"PNG路径: {png_path or '(未生成PNG)'}",
        f"预览路径: {preview_path or '(无)'}",
    ]
    item["agentText"] = "\n".join(lines)
    return item


def attach_agent_text_fields(item: dict[str, Any]) -> dict[str, Any]:
    item["kind"] = "text"
    item["agentText"] = f"[{item.get('time', '')}] {item.get('sender', '')}: {item.get('content', '')}"
    return item


def decode_and_copy(message: dict[str, Any], output_dir: Path, force: bool) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    username = message.get("room_username", "")
    result = decode_precise_image(username, int(message["local_id"]), int(message.get("timestamp") or 0))
    if not result.get("success"):
        return {
            "downloaded": False,
            "error": result.get("error", "decode failed"),
            "md5": result.get("md5", ""),
            "decodeAttempts": result.get("decodeAttempts") or [],
            "candidates": result.get("candidates") or [],
        }

    decoded_path = Path(result["path"])
    target = unique_target_path(output_dir, message, decoded_path)
    if target.exists() and not force:
        preview = make_preview_if_possible(target, str(result.get("format") or target.suffix.lstrip(".")))
        image_info = {
            "downloaded": True,
            "path": str(target),
            "sourceDecodedPath": str(decoded_path),
            "source": result.get("source", ""),
            "sourceKind": result.get("sourceKind", ""),
            "format": result.get("format"),
            "size": target.stat().st_size,
            "md5": result.get("md5", ""),
            "alreadyExisted": True,
            "decodeAttempts": result.get("decodeAttempts") or [],
            "decodedCandidates": result.get("decodedCandidates") or [],
            "pixelArea": result.get("pixelArea") or 0,
            "originalDecodeError": result.get("originalDecodeError") or "",
            **preview,
        }
        return attach_image_resolution(ensure_png_preview(image_info))

    shutil.copy2(decoded_path, target)
    preview = make_preview_if_possible(target, str(result.get("format") or target.suffix.lstrip(".")))
    image_info = {
        "downloaded": True,
        "path": str(target),
        "sourceDecodedPath": str(decoded_path),
        "source": result.get("source", ""),
        "sourceKind": result.get("sourceKind", ""),
        "format": result.get("format"),
        "size": target.stat().st_size,
        "md5": result.get("md5", ""),
        "alreadyExisted": False,
        "decodeAttempts": result.get("decodeAttempts") or [],
        "decodedCandidates": result.get("decodedCandidates") or [],
        "pixelArea": result.get("pixelArea") or 0,
        "originalDecodeError": result.get("originalDecodeError") or "",
        **preview,
    }
    return attach_image_resolution(ensure_png_preview(image_info))


def annotate_and_download(
    payload: dict[str, Any],
    players: list[dict[str, Any]],
    output_dir: Path,
    download: bool,
    force: bool,
    match_source: str = "checked-in-roster",
    pairing_context_by_key: dict[str, dict[str, Any]] | None = None,
    pairing_account_index: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    room_username = payload["room_username"]
    messages = []
    sender_hints = shared_roster_match_hints(
        players,
        [message.get("sender", "") for message in payload.get("messages", [])],
        prefer_checked=True,
    )
    if match_source == "round-pairing-index":
        for hint in sender_hints.values():
            if isinstance(hint, dict) and hint.get("status") == "matched":
                hint["source"] = "round-pairing-index"
    for message in payload["messages"]:
        item = dict(message)
        item["room_username"] = room_username
        item["kind"] = "image"
        item = prefer_roster_sender(item, sender_hints.get(str(item.get("sender") or "")))
        context_lookup = pairing_context_by_key or {}
        item["pairingContext"] = (
            context_lookup.get(pairing_player_key(item.get("sender"), item.get("senderAccount")))
            or context_lookup.get(pairing_player_key(item.get("sender"), ""))
            or {}
        )
        item["pairingAccountIndex"] = pairing_account_index or []
        item["sourceRole"] = message_ready_source_role(item)
        item["allowedReadySource"] = item["sourceRole"] != "referee-summary"
        if download and item["sourceRole"] != "referee-summary":
            item["image"] = decode_and_copy(item, output_dir, force)
        attach_agent_image_fields(item)
        messages.append(item)
    payload = dict(payload)
    payload["download_dir"] = str(output_dir) if download else ""
    payload["messages"] = messages
    payload["downloaded_count"] = sum(1 for m in messages if m.get("image", {}).get("downloaded"))
    payload["matched_count"] = sum(1 for m in messages if m.get("playerHint", {}).get("status") == "matched")
    payload["ambiguous_count"] = sum(1 for m in messages if m.get("playerHint", {}).get("status") == "ambiguous")
    payload["unmatched_count"] = sum(1 for m in messages if m.get("playerHint", {}).get("status") == "unmatched")
    payload["player_match_source"] = match_source
    payload["agentReminder"] = SCORE_REVIEW_REMINDER
    payload["agentText"] = SCORE_REVIEW_REMINDER + "\n\n" + "\n\n".join(
        m.get("agentText", "") for m in messages if m.get("agentText")
    )
    return payload


def cmd_chat_history(args: argparse.Namespace) -> int:
    cloud_pull = map_collab_sync("pull-to-local", Path(args.state))
    messages: list[dict[str, Any]] = []
    text_payload: dict[str, Any] | None = None
    image_payload: dict[str, Any] | None = None

    if not args.no_text:
        text_payload = agent_checkin_bridge.export_history(
            args.group,
            args.start,
            args.end,
            args.limit + args.offset,
            0,
            True,
            args.msg_type,
        )
        for message in text_payload.get("messages", []):
            messages.append(attach_agent_text_fields(dict(message)))

    if not args.no_images:
        players = load_players(Path(args.state))
        image_payload = image_messages(
            args.group,
            args.start,
            args.end,
            args.limit + args.offset,
            0,
            True,
            not args.allow_unmapped,
        )
        image_payload = annotate_and_download(
            image_payload,
            players,
            Path(args.download_dir),
            not args.no_download,
            args.force,
        )
        messages.extend(dict(message) for message in image_payload.get("messages", []))

    messages.sort(key=lambda item: (int(item.get("timestamp") or 0), int(item.get("local_id") or 0)))
    paged = messages[args.offset : args.offset + args.limit]
    payload = {
        "schema_version": 1,
        "export_kind": "agent_tournament_chat_history",
        "group_name": (text_payload or image_payload or {}).get("group_name", args.group),
        "room_username": (text_payload or image_payload or {}).get("room_username", ""),
        "range": {"start": args.start, "end": args.end},
        "limit": args.limit,
        "offset": args.offset,
        "sender_policy": "sender has been rewritten to group_nick via cached member map",
        "image_policy": "image messages are downloaded, converted to PNG when needed, and no OCR is run",
        "score_review_reminder": SCORE_REVIEW_REMINDER,
        "message_count": len(paged),
        "text_count": sum(1 for item in paged if item.get("kind") == "text"),
        "image_count": sum(1 for item in paged if item.get("kind") == "image"),
        "downloaded_count": sum(1 for item in paged if item.get("image", {}).get("downloaded")),
        "messages": paged,
        "agentText": SCORE_REVIEW_REMINDER + "\n\n" + "\n\n".join(
            item.get("agentText", "") for item in paged if item.get("agentText")
        ),
    }
    cloud_push_nicks = map_collab_sync("push-nicks", Path(args.state))
    payload["cloudSync"] = {
        "pullMappingBeforeHistory": cloud_pull,
        "pushGroupNicksAfterHistory": cloud_push_nicks,
    }
    write_output(payload, args.output)
    return 0


def write_output(payload: dict[str, Any], output: str, quiet: bool = False) -> None:
    if not output:
        print_json(payload)
        return
    path = Path(output)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if quiet:
        return
    summary = {"ok": True, "output": str(path), "message_count": len(payload.get("messages", []))}
    for key in ("image_count", "refereeSummaryImageCount", "ready_count", "pushed_count", "duplicate_count", "rejected_count", "review_count", "flow_hint_count"):
        if key in payload:
            summary[key] = payload[key]
    for key in ("realtimeUpdatePolicy", "stopPollingPolicy", "stopPolling", "stopPollingCode", "stopPollingReason"):
        if key in payload:
            summary[key] = payload[key]
    if isinstance(payload.get("agentSummary"), dict):
        summary["agentSummary"] = payload["agentSummary"]
    print_json(summary)


def compact_console_image_item(item: dict[str, Any], index: int) -> dict[str, Any]:
    hint = item.get("playerHint") if isinstance(item.get("playerHint"), dict) else {}
    image = item.get("image") if isinstance(item.get("image"), dict) else {}
    pairing_context = item.get("pairingContext") if isinstance(item.get("pairingContext"), dict) else {}
    source_role = item.get("sourceRole") or "player-screenshot"
    include_image_path = source_role != "referee-summary" and item.get("allowedReadySource") is not False
    return {
        "index": index,
        "time": item.get("time"),
        "sender": item.get("sender"),
        "sourceMessageKey": item.get("sourceMessageKey") or message_key(item),
        "alreadySeenInPreviousWindow": bool(item.get("alreadySeenInPreviousWindow")),
        "alreadyWritten": bool(item.get("alreadyWritten")),
        "sourceRole": source_role,
        "allowedReadySource": item.get("allowedReadySource") is not False,
        "readySourcePolicy": item.get("readySourcePolicy") or "",
        "senderAccount": item.get("senderAccount") or pairing_context.get("reporterAccount") or "",
        "table": pairing_context.get("table"),
        "reporterName": pairing_context.get("reporterName") or "",
        "reporterAccount": pairing_context.get("reporterAccount") or "",
        "opponentName": pairing_context.get("opponentName") or "",
        "opponentAccount": pairing_context.get("opponentAccount") or "",
        "matchedDisplayName": hint.get("matchedDisplayName") or "",
        "matchSource": hint.get("source") or "",
        "imageSourceKind": image.get("sourceKind") or "",
        "imagePath": (item.get("pngPath") or item.get("previewPath") or "") if include_image_path else "",
        "previewPath": (item.get("previewPath") or "") if include_image_path else "",
        "resolution": image.get("resolution") or {},
        "accountCheckPolicy": pairing_context.get("accountCheckPolicy") or "",
        "accountMatchPolicy": (
            "Screenshot-account match is required: the two visible OQ IDs must uniquely match both accounts "
            "of one current-round table in pairingAccountIndex. Sender mapping is auxiliary only."
        ),
        "blockingScoreChecks": BLOCKING_SCORE_CHECKS,
    }


def collect_score_scan_png_paths(*buckets: Any) -> list[str]:
    paths: list[str] = []
    seen: set[str] = set()

    def add_path(value: Any) -> None:
        path = str(value or "").strip()
        if not path or path in seen:
            return
        seen.add(path)
        paths.append(path)

    def visit(value: Any) -> None:
        if isinstance(value, dict):
            if (
                value.get("sourceRole") == "referee-summary"
                or value.get("allowedReadySource") is False
                or value.get("alreadyWritten")
            ):
                return
            add_path(value.get("pngPath"))
            image = value.get("image")
            if isinstance(image, dict):
                add_path(image.get("previewPngPath") or image.get("pngPath"))
            return
        if isinstance(value, list):
            for item in value:
                visit(item)

    for bucket in buckets:
        visit(bucket)
    return paths


def omitted_score_scan_image_item(message: dict[str, Any], pairing: dict[str, Any], reason: str) -> dict[str, Any]:
    return {
        "time": message.get("time"),
        "sender": message.get("sender"),
        "wechatSender": message.get("wechatSender"),
        "table": pairing.get("table"),
        "status": pairing.get("status"),
        "reason": reason,
        "sourceMessageKey": message.get("sourceMessageKey") or message_key(message),
    }


def score_scan_message_table_key(message: dict[str, Any]) -> str:
    context = message.get("pairingContext") if isinstance(message.get("pairingContext"), dict) else {}
    table = normalize_text_like(context.get("table"))
    if table:
        return table
    hint = message.get("playerHint") if isinstance(message.get("playerHint"), dict) else {}
    table = normalize_text_like(hint.get("pairingTable") or message.get("table"))
    return table


def filter_score_scan_review_after_oq_update(
    messages: list[dict[str, Any]],
    target_round: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    pairings = target_round.get("ftdPairings") if isinstance(target_round.get("ftdPairings"), list) else []
    by_table = {
        normalize_text_like(item.get("table")): item
        for item in pairings
        if isinstance(item, dict)
    }
    review: list[dict[str, Any]] = []
    omitted: list[dict[str, Any]] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        if message.get("sourceRole") == "referee-summary":
            continue
        table_key = score_scan_message_table_key(message)
        pairing = by_table.get(table_key) if table_key else None
        if pairing and pairing.get("status") in {"ready", "completed"}:
            omitted.append(
                omitted_score_scan_image_item(
                    message,
                    pairing,
                    "sender/table already ready or completed after OQ auto update",
                )
            )
            continue
        if pairing and ftd_pairing_has_user_score_lock(pairing):
            omitted.append(
                omitted_score_scan_image_item(
                    message,
                    pairing,
                    "table has user-edited score fields; agent/OQ auto write is locked",
                )
            )
            continue
        review.append(message)
    return review, omitted


def print_score_scan_console_summary(report: dict[str, Any]) -> None:
    items = [
        compact_console_image_item(item, index + 1)
        for index, item in enumerate(report.get("review", []))
        if isinstance(item, dict)
    ]
    console = {
        "ok": True,
        "output": report.get("output") or "",
        "round": report.get("round"),
        "range": report.get("range"),
        "scoreScanTiming": report.get("scoreScanTiming", {}),
        "cacheDelay": report.get("cacheDelay", {}),
        "image_count": report.get("image_count", 0),
        "refereeSummaryImageCount": report.get("refereeSummaryImageCount", 0),
        "review_count": report.get("review_count", 0),
        "pngPaths": report.get("pngPaths")
        or collect_score_scan_png_paths(report.get("review", []), report.get("rejected", [])),
        "oqAutoUpdate": report.get("oqAutoUpdate") or {},
        "oqOmittedImageCount": report.get("oqOmittedImageCount", 0),
        "oqOmittedImages": report.get("oqOmittedImages", []),
        "alreadySeenCount": report.get("alreadySeenCount", 0),
        "alreadyWrittenCount": report.get("alreadyWrittenCount", 0),
        "agentImageOpenPolicy": (
            "Open all pngPaths for this score-scan window together first, then inspect them manually. "
            "Do not open images one by one as they are discovered."
        ),
        "agentNextSteps": SCORE_SCAN_AGENT_NEXT_STEPS,
        "abnormalPendingPolicy": ABNORMAL_PENDING_POLICY,
        "flow_hint_count": report.get("flow_hint_count", 0),
        "unresolvedMappingCount": report.get("unresolvedMappingCount", 0),
        "unresolvedMapping": report.get("unresolvedMapping", []),
        "rawUnresolvedMappingCount": report.get("rawUnresolvedMappingCount", report.get("unresolvedMappingCount", 0)),
        "blockingUnresolvedMappingCount": report.get("blockingUnresolvedMappingCount", 0),
        "blockingUnresolvedMapping": report.get("blockingUnresolvedMapping", []),
        "advisoryUnresolvedMappingCount": report.get("advisoryUnresolvedMappingCount", 0),
        "advisoryUnresolvedMapping": report.get("advisoryUnresolvedMapping", []),
        "suppressedAdvisoryUnresolvedMappingCount": report.get("suppressedAdvisoryUnresolvedMappingCount", 0),
        "unresolvedMappingPolicy": report.get("unresolvedMappingPolicy", ""),
        "accountMatchPolicy": report.get("accountMatchPolicy", ""),
        "realtimeUpdatePolicy": report.get("realtimeUpdatePolicy", SCORE_SCAN_REALTIME_UPDATE_POLICY),
        "stopPollingPolicy": report.get("stopPollingPolicy", SCORE_SCAN_STOP_POLLING_POLICY),
        "stopPolling": report.get("stopPolling", False),
        "stopPollingCode": report.get("stopPollingCode", ""),
        "stopPollingReason": report.get("stopPollingReason", ""),
        "stopPollingMessages": report.get("stopPollingMessages", []),
        "pairingAccountIndex": report.get("pairingAccountIndex", []),
        "blockingScoreChecks": report.get("blockingScoreChecks") or BLOCKING_SCORE_CHECKS,
        "agentSummary": report.get("agentSummary"),
        "imageItems": items,
    }
    print_json(console)


def cmd_status(args: argparse.Namespace) -> int:
    group = load_group_map(args.group)["payload"]
    players = load_players(Path(args.state))
    print_json(
        {
            "ok": True,
            "group_name": group["group_name"],
            "room_username": group["room_username"],
            "map_refreshed_at": group.get("refreshed_at"),
            "member_count": group.get("member_count"),
            "mapped_count": group.get("mapped_count"),
            "state": str(Path(args.state)),
            "player_count": len(players),
            "default_download_dir": str(DEFAULT_IMAGE_DIR),
            "score_image_review": "manual-image-only; OCR disabled",
            "blockingScoreChecks": BLOCKING_SCORE_CHECKS,
        }
    )
    return 0


def cmd_members(args: argparse.Namespace) -> int:
    group = load_group_map(args.group)["payload"]
    q = normalize(args.query)
    members = group.get("members", [])
    if q:
        members = [
            item for item in members
            if q in normalize(item.get("group_nick")) or q in normalize(item.get("contact_display")) or q in normalize(item.get("username"))
        ]
    print_json({"ok": True, "group_name": group["group_name"], "members": members[: args.limit], "count": len(members)})
    return 0


def cmd_scan(args: argparse.Namespace) -> int:
    players = load_players(Path(args.state))
    payload = image_messages(
        args.group,
        args.start,
        args.end,
        args.limit,
        args.offset,
        args.oldest_first,
        not args.allow_unmapped,
    )
    payload = annotate_and_download(
        payload,
        players,
        Path(args.download_dir),
        not args.no_download,
        args.force,
    )
    write_output(payload, args.output)
    return 0


def load_seen(path: Path) -> set[str]:
    if not path.exists():
        return set()
    try:
        data = read_json(path)
    except Exception:
        return set()
    return set(str(x) for x in data.get("seen", []) if x)


def save_seen(path: Path, seen: set[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"seen": sorted(seen)}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def load_score_scan_seen_state(path: Path) -> tuple[set[str], set[str]]:
    if not path.exists():
        return set(), set()
    try:
        data = read_json(path)
    except Exception:
        return set(), set()
    return (
        set(str(x) for x in data.get("seen", []) if x),
        set(str(x) for x in data.get("mappingAdvisorySeen", []) if x),
    )


def save_score_scan_seen_state(path: Path, seen: set[str], mapping_advisory_seen: set[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "seen": sorted(seen),
                "mappingAdvisorySeen": sorted(mapping_advisory_seen),
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def message_key(message: dict[str, Any]) -> str:
    explicit = str(message.get("sourceMessageKey") or "")
    if explicit:
        return explicit
    return f"{message.get('timestamp')}:{message.get('local_id')}:{message.get('sender_username')}"


def message_ready_source_role(message: dict[str, Any]) -> str:
    sender = normalize_text_like(
        message.get("wechatSender")
        or message.get("sender")
        or message.get("sender_nickname")
        or message.get("sender_username")
    ).lower()
    content = normalize_text_like(message.get("content") or message.get("agentText")).lower()
    referee_sender_terms = ("群bot", "群 bot", "bot", "裁判", "referee")
    referee_content_terms = ("总表", "成绩表", "比分表", "结果表", "核对表", "referee summary")
    if any(term in sender for term in referee_sender_terms) or any(term in content for term in referee_content_terms):
        return "referee-summary"
    if (
        "群bot" in sender
        or "bot" in sender
        or "裁判" in sender
        or "referee" in sender
        or "总表" in content
        or "成绩表" in content
        or "比分表" in content
    ):
        return "referee-summary"
    return "player-screenshot"


def annotate_score_scan_message_state(
    message: dict[str, Any],
    seen_before: set[str],
    written_keys: set[str],
) -> dict[str, Any]:
    key = message_key(message)
    image_path = normalize_text_like(message.get("pngPath") or message.get("previewPath"))
    already_written = bool(
        (key and f"sourceMessageKey:{key}" in written_keys)
        or (image_path and f"imagePath:{image_path}" in written_keys)
    )
    source_role = message_ready_source_role(message)
    message["sourceMessageKey"] = key
    message["alreadySeenInPreviousWindow"] = key in seen_before
    message["alreadyWritten"] = already_written
    message["sourceRole"] = source_role
    message["allowedReadySource"] = source_role != "referee-summary"
    if source_role == "referee-summary":
        message["readySourcePolicy"] = "referee-summary images are for cross-check only; do not write ready from this image"
    return message


def cmd_watch(args: argparse.Namespace) -> int:
    seen_path = Path(args.seen_state)
    seen = load_seen(seen_path)
    end_ts, _ = parse_time_range(args.end, "") if args.end else (None, None)
    output_dir = Path(args.download_dir)

    while True:
        requested_end = args.end or datetime.now(CHINA_TZ).replace(tzinfo=None).strftime("%Y-%m-%d %H:%M:%S")
        scan_start, now_end, end_source, cache_delay = apply_cache_delay_to_scan_range(
            args.start,
            requested_end,
            "explicit" if args.end else "current-time",
        )
        players = load_players(Path(args.state))
        payload = image_messages(
            args.group,
            scan_start,
            now_end,
            args.limit,
            0,
            True,
            not args.allow_unmapped,
        )
        new_messages = [m for m in payload["messages"] if message_key(m) not in seen]
        payload["messages"] = new_messages
        payload = annotate_and_download(
            payload,
            players,
            output_dir,
            True,
            args.force,
        )
        for item in new_messages:
            seen.add(message_key(item))
        save_seen(seen_path, seen)
        print_json(
            {
                "ok": True,
                "checked_at": datetime.now(CHINA_TZ).isoformat(timespec="seconds"),
                **payload,
                "range": {"start": scan_start, "end": now_end, "endSource": end_source},
                "cacheDelay": cache_delay,
            }
        )
        sys.stdout.flush()

        if args.once:
            break
        if end_ts is not None and int(time.time()) >= end_ts:
            break
        time.sleep(args.interval)
    return 0


def score_item_keys(item: dict[str, Any]) -> set[str]:
    keys = set()
    for field in ("sourceMessageKey", "imagePath"):
        value = normalize_text_like(item.get(field))
        if value:
            keys.add(f"{field}:{value}")
    return keys


def pending_item_match_keys(item: dict[str, Any]) -> set[str]:
    keys = set(score_item_keys(item))
    for field in ("table", "dirtyTable", "pendingTable"):
        value = normalize_text_like(item.get(field))
        if value:
            keys.add(f"table:{value}")
    return keys


def remove_matching_pending_items(round_item: dict[str, Any], match_keys: set[str]) -> list[dict[str, Any]]:
    if not match_keys:
        return []
    removed: list[dict[str, Any]] = []
    pending = round_item.get("pending") if isinstance(round_item.get("pending"), list) else []
    next_pending = []
    for item in pending:
        if isinstance(item, dict) and item.get("resolvedByReferee") is True:
            next_pending.append(item)
            continue
        if isinstance(item, dict) and pending_item_match_keys(item) & match_keys:
            removed.append(item)
        else:
            next_pending.append(item)
    round_item["pending"] = next_pending
    return removed


def ready_cleanup_match_keys(item: dict[str, Any], table: Any) -> set[str]:
    keys = set(score_item_keys(item))
    table_value = normalize_text_like(table)
    if table_value:
        keys.add(f"table:{table_value}")
    return keys


def normalize_text_like(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def mapping_issue_key(issue: dict[str, Any]) -> str:
    return "|".join(
        normalize_text_like(issue.get(key))
        for key in ("status", "table", "side", "ftdName", "matchedDisplayName")
    )


def split_mapping_issues(
    issues: list[dict[str, Any]],
    advisory_seen: set[str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], int, set[str]]:
    blocking_statuses = {"member-map-account-ambiguous", "duplicate-player"}
    blocking: list[dict[str, Any]] = []
    advisory_new: list[dict[str, Any]] = []
    next_seen = set(advisory_seen)
    suppressed = 0
    for raw in issues:
        if not isinstance(raw, dict):
            continue
        issue = dict(raw)
        status = normalize_text_like(issue.get("status"))
        key = mapping_issue_key(issue)
        issue["issueKey"] = key
        if status in blocking_statuses:
            issue["severity"] = "blocking-account"
            issue["blocksReadyAccountGate"] = True
            blocking.append(issue)
            continue
        issue["severity"] = "advisory-roster-gap"
        issue["blocksReadyAccountGate"] = False
        issue["repeatPolicy"] = "shown once per score-scan seen-state unless it becomes blocking"
        if key and key in advisory_seen:
            suppressed += 1
            continue
        advisory_new.append(issue)
        if key:
            next_seen.add(key)
    return blocking, advisory_new, suppressed, next_seen


AGENT_OMITTED_SCORE_FIELDS = {"sourceTime", "imagePath", "reason"}


def strip_agent_omitted_score_fields(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: strip_agent_omitted_score_fields(item)
            for key, item in value.items()
            if key not in AGENT_OMITTED_SCORE_FIELDS
        }
    if isinstance(value, list):
        return [strip_agent_omitted_score_fields(item) for item in value]
    return value


def print_agent_write_json(payload: dict[str, Any]) -> None:
    print_json(strip_agent_omitted_score_fields(payload))


def sender_group_nickname(item: dict[str, Any], *, allow_sender_fallback: bool = False) -> str:
    for key in ("wechatSender", "senderGroupNickname", "groupNickname", "senderNickname", "wechatNickname"):
        value = normalize_text_like(item.get(key))
        if value:
            return value
    hint = item.get("playerHint") if isinstance(item.get("playerHint"), dict) else {}
    value = normalize_text_like(hint.get("wechatSender"))
    if value:
        return value
    if allow_sender_fallback:
        return normalize_text_like(item.get("sender"))
    return ""


def existing_score_item_keys(helper: dict[str, Any]) -> set[str]:
    keys = set()
    for round_item in helper.get("rounds", []):
        if not isinstance(round_item, dict):
            continue
        for bucket in ("pending", "manualPending", "completed"):
            for item in round_item.get(bucket, []) if isinstance(round_item.get(bucket), list) else []:
                if isinstance(item, dict):
                    keys.update(score_item_keys(item))
        for item in round_item.get("ftdPairings", []) if isinstance(round_item.get("ftdPairings"), list) else []:
            if isinstance(item, dict):
                keys.update(score_item_keys(item))
    return keys


def normalize_name_key(value: Any) -> str:
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "", str(value or "").lower())


def find_ftd_pairing_for_sender(round_item: dict[str, Any], sender: str) -> tuple[int, dict[str, Any] | None]:
    sender_key = normalize_name_key(sender)
    if not sender_key:
        return -1, None
    pairings = round_item.get("ftdPairings") if isinstance(round_item.get("ftdPairings"), list) else []
    matches: list[tuple[int, dict[str, Any]]] = []
    for index, item in enumerate(pairings):
        if not isinstance(item, dict):
            continue
        black_key = normalize_name_key(item.get("black"))
        white_key = normalize_name_key(item.get("white"))
        if sender_key and sender_key in {black_key, white_key}:
            matches.append((index, item))
    if len(matches) == 1:
        return matches[0]
    return -1, None


def find_ftd_pairing_by_table(round_item: dict[str, Any], table: Any) -> tuple[int, dict[str, Any] | None]:
    table_key = normalize_text_like(table)
    if not table_key:
        return -1, None
    pairings = round_item.get("ftdPairings") if isinstance(round_item.get("ftdPairings"), list) else []
    matches: list[tuple[int, dict[str, Any]]] = []
    for index, item in enumerate(pairings):
        if isinstance(item, dict) and normalize_text_like(item.get("table")) == table_key:
            matches.append((index, item))
    if len(matches) == 1:
        return matches[0]
    return -1, None


def ftd_side_for_sender(pairing: dict[str, Any], sender: str) -> str:
    sender_key = normalize_name_key(sender)
    if not sender_key:
        return ""
    if sender_key == normalize_name_key(pairing.get("black")):
        return "black"
    if sender_key == normalize_name_key(pairing.get("white")):
        return "white"
    return ""


def int_score(value: Any) -> int | None:
    try:
        score = int(value)
    except (TypeError, ValueError):
        return None
    if score < 0 or score > 64:
        raise HelperError("score must be between 0 and 64")
    return score


def validate_score_pair(first: int, second: int) -> None:
    if first + second != 64:
        raise HelperError("score pair must sum to 64")


def scores_from_sender_win(pairing: dict[str, Any], sender: str, inference: dict[str, Any]) -> tuple[int, int, str]:
    sender_key = normalize_name_key(sender)
    black_key = normalize_name_key(pairing.get("black"))
    white_key = normalize_name_key(pairing.get("white"))
    if sender_key not in {black_key, white_key}:
        raise HelperError("sender is not in the FTD pairing")
    status = str(inference.get("status") or "")
    if status == "draw":
        winner_score = 32
        loser_score = 32
    elif status == "winner-by-forfeit":
        winner_score = 64
        loser_score = 0
    else:
        loser_score = int(inference.get("loserStoneCount"))
        winner_score = 64 - loser_score
    if sender_key == black_key:
        return winner_score, loser_score, str(pairing.get("white") or "")
    return loser_score, winner_score, str(pairing.get("black") or "")


def scores_from_ready_message(
    pairing: dict[str, Any],
    message: dict[str, Any],
    inference: dict[str, Any],
    reporter_side: str = "",
) -> tuple[int, int, str]:
    black_score = int_score(message.get("blackScore"))
    white_score = int_score(message.get("whiteScore"))
    if black_score is not None and white_score is not None:
        validate_score_pair(black_score, white_score)
        return black_score, white_score, str(message.get("opponent") or "")

    sender = str(message.get("sender") or "")
    side = reporter_side if reporter_side in {"black", "white"} else ftd_side_for_sender(pairing, sender)
    sender_score = int_score(message.get("senderScore"))
    opponent_score = int_score(message.get("opponentScore"))
    if sender_score is not None and opponent_score is not None:
        validate_score_pair(sender_score, opponent_score)
        if not side:
            raise HelperError("sender score needs --reporter-side or a sender matching the FTD table")
        opponent = str(pairing.get("white" if side == "black" else "black") or "")
        if side == "black":
            return sender_score, opponent_score, opponent
        return opponent_score, sender_score, opponent

    if reporter_side:
        status = str(inference.get("status") or "")
        if status == "draw":
            sender_score = 32
            opponent_score = 32
        elif status == "winner-by-forfeit":
            sender_score = 64
            opponent_score = 0
        else:
            loser_score = int_score(inference.get("loserStoneCount"))
            if loser_score is None:
                raise HelperError("ready score needs loserStoneCount or explicit scores")
            sender_score = 64 - loser_score
            opponent_score = loser_score
        opponent = str(pairing.get("white" if reporter_side == "black" else "black") or "")
        if reporter_side == "black":
            return sender_score, opponent_score, opponent
        return opponent_score, sender_score, opponent

    return scores_from_sender_win(pairing, sender, inference)


def apply_score_to_ftd_pairing(
    round_item: dict[str, Any],
    message: dict[str, Any],
    table: Any = "",
    reporter_side: str = "",
    force_update: bool = False,
) -> dict[str, Any] | None:
    inference = message.get("scoreInference") if isinstance(message.get("scoreInference"), dict) else {}
    sender = str(message.get("sender") or "")
    if table:
        index, pairing = find_ftd_pairing_by_table(round_item, table)
    else:
        index, pairing = find_ftd_pairing_for_sender(round_item, sender)
    if pairing is None:
        return None
    existing_source_key = normalize_text_like(pairing.get("sourceMessageKey"))
    incoming_source_key = message_key(message)
    if (
        normalize_text_like(pairing.get("lastEditedBy")) == "user"
        and normalize_text_like(pairing.get("resultKind")) == "absence"
    ):
        return {
            "duplicate": True,
            "reason": f"FTD table {pairing.get('table')} is user-marked absence; agent ready write skipped",
            "table": pairing.get("table"),
            "black": pairing.get("black"),
            "white": pairing.get("white"),
            "sender": sender,
            "sourceMessageKey": incoming_source_key,
            "existingSourceMessageKey": existing_source_key,
            "protectedByUserAbsence": True,
        }
    can_update_ready = (
        pairing.get("status") == "ready"
        and (force_update or (existing_source_key and existing_source_key == incoming_source_key))
    )
    if pairing.get("status") == "completed" or (
        pairing.get("status") == "ready" and not can_update_ready
    ):
        return {
            "duplicate": True,
            "reason": f"FTD table {pairing.get('table')} already has status {pairing.get('status')}",
            "table": pairing.get("table"),
            "black": pairing.get("black"),
            "white": pairing.get("white"),
            "sender": sender,
            "sourceMessageKey": incoming_source_key,
            "existingSourceMessageKey": existing_source_key,
        }
    reporter_side = reporter_side if reporter_side in {"black", "white"} else ""
    black_score, white_score, opponent = scores_from_ready_message(pairing, message, inference, reporter_side)
    edited_at = int(time.time() * 1000)
    result_time = infer_score_result_time(message, edited_at)
    result_sort_key = score_result_sort_key(message.get("resultSortKey") or result_time) or edited_at
    pairing["status"] = "ready"
    pairing["reporter"] = sender
    pairing["opponent"] = str(message.get("opponent") or opponent)
    pairing["blackScore"] = black_score
    pairing["whiteScore"] = white_score
    pairing["resultText"] = str(message.get("resultText") or f"{sender} {inference.get('status') or ''}: {black_score}-{white_score}")
    pairing.pop("reason", None)
    pairing.pop("imagePath", None)
    pairing["sourceMessageKey"] = incoming_source_key
    pairing["sourceLocalId"] = str(message.get("local_id") or "")
    pairing["resultTime"] = result_time
    pairing["resultSortKey"] = result_sort_key
    pairing["updatedAt"] = edited_at
    pairing["lastEditedBy"] = "agent"
    pairing["lastEditedAt"] = edited_at
    return {
        "table": pairing.get("table"),
        "black": pairing.get("black"),
        "white": pairing.get("white"),
        "blackScore": black_score,
        "whiteScore": white_score,
        "status": "ready",
        "updatedExistingReady": bool(can_update_ready),
        "forceUpdate": bool(force_update),
        "resultText": pairing.get("resultText"),
        "resultTime": pairing.get("resultTime"),
        "resultSortKey": pairing.get("resultSortKey"),
        "sender": sender,
        "opponent": opponent,
        "sourceMessageKey": pairing["sourceMessageKey"],
        "lastEditedBy": pairing["lastEditedBy"],
        "lastEditedAt": pairing["lastEditedAt"],
    }


def score_scan_compact_item(item: dict[str, Any], reason: str = "") -> dict[str, Any]:
    hint = item.get("playerHint") if isinstance(item.get("playerHint"), dict) else {}
    image = item.get("image") if isinstance(item.get("image"), dict) else {}
    inference = item.get("scoreInference") if isinstance(item.get("scoreInference"), dict) else {}
    pairing_context = item.get("pairingContext") if isinstance(item.get("pairingContext"), dict) else {}
    source_role = item.get("sourceRole") or "player-screenshot"
    include_image_path = source_role != "referee-summary" and item.get("allowedReadySource") is not False
    return {
        "time": item.get("time"),
        "sender": item.get("sender"),
        "sourceMessageKey": item.get("sourceMessageKey") or message_key(item),
        "alreadySeenInPreviousWindow": bool(item.get("alreadySeenInPreviousWindow")),
        "alreadyWritten": bool(item.get("alreadyWritten")),
        "sourceRole": source_role,
        "allowedReadySource": item.get("allowedReadySource") is not False,
        "senderAccount": item.get("senderAccount") or "",
        "wechatSender": sender_group_nickname(item, allow_sender_fallback=True),
        "table": pairing_context.get("table"),
        "reporterName": pairing_context.get("reporterName") or "",
        "reporterAccount": pairing_context.get("reporterAccount") or "",
        "reporterFtdName": pairing_context.get("reporterFtdName") or "",
        "opponentName": pairing_context.get("opponentName") or "",
        "opponentAccount": pairing_context.get("opponentAccount") or "",
        "opponentFtdName": pairing_context.get("opponentFtdName") or "",
        "matchedDisplayName": hint.get("matchedDisplayName") or "",
        "matchSource": hint.get("source") or "",
        "status": inference.get("status") or "",
        "loserStoneCount": inference.get("loserStoneCount"),
        "inferenceReason": inference.get("reason") or "",
        "reviewReason": reason or item.get("scoreScanReviewReason") or "",
        "imageSourceKind": image.get("sourceKind") or "",
        "imagePath": (item.get("pngPath") or item.get("previewPath") or "") if include_image_path else "",
        "previewPath": (item.get("previewPath") or "") if include_image_path else "",
        "resolution": image.get("resolution") or {},
        "accountCheckPolicy": pairing_context.get("accountCheckPolicy") or "",
    }


def score_scan_ready_summary(item: dict[str, Any], ftd_result: dict[str, Any]) -> dict[str, Any]:
    compact = score_scan_compact_item(item)
    return {
        "table": ftd_result.get("table"),
        "black": ftd_result.get("black"),
        "white": ftd_result.get("white"),
        "blackScore": ftd_result.get("blackScore"),
        "whiteScore": ftd_result.get("whiteScore"),
        "status": ftd_result.get("status") or ("dry-run-ready" if ftd_result.get("dryRun") else "ready"),
        "sender": ftd_result.get("sender") or item.get("sender"),
        "opponent": ftd_result.get("opponent") or "",
        "resultText": ftd_result.get("resultText") or "",
        "reason": ftd_result.get("reason") or compact.get("inferenceReason") or "",
        "sourceMessageKey": ftd_result.get("sourceMessageKey"),
        "imagePath": ftd_result.get("imagePath") or compact.get("imagePath"),
    }


def unique_pairing_contexts(pairing_context_by_key: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[tuple[str, str, str]] = set()
    contexts = []
    for item in pairing_context_by_key.values():
        if not isinstance(item, dict):
            continue
        key = (
            str(item.get("table") or ""),
            str(item.get("side") or ""),
            str(item.get("reporterAccount") or item.get("reporterName") or ""),
        )
        if key in seen:
            continue
        seen.add(key)
        contexts.append(item)
    return sorted(
        contexts,
        key=lambda item: (str(item.get("table") or ""), str(item.get("side") or ""), str(item.get("reporterName") or "")),
    )


def ftd_round_completion(round_item: dict[str, Any]) -> dict[str, Any]:
    pairings = round_item.get("ftdPairings") if isinstance(round_item.get("ftdPairings"), list) else []
    active = [
        item
        for item in pairings
        if isinstance(item, dict)
        and str(item.get("black") or "").upper() != "BYE"
        and str(item.get("white") or "").upper() != "BYE"
    ]
    ready = [item for item in active if item.get("status") == "ready"]
    completed = [item for item in active if item.get("status") == "completed"]
    result_sources = []
    unclear_result_sources = []
    for item in active:
        if item.get("status") not in {"ready", "completed"}:
            continue
        editor = normalize_text_like(item.get("lastEditedBy"))
        source_item = {
            "table": item.get("table"),
            "black": item.get("black"),
            "white": item.get("white"),
            "status": item.get("status"),
            "lastEditedBy": editor,
            "lastEditedAt": item.get("lastEditedAt"),
            "resultKind": item.get("resultKind") or "",
            "sourceMessageKey": item.get("sourceMessageKey") or "",
        }
        result_sources.append(source_item)
        if not ftd_result_has_known_editor(item):
            unclear_result_sources.append(source_item)
    missing = [
        {
            "table": item.get("table"),
            "black": item.get("black"),
            "white": item.get("white"),
            "status": item.get("status") or "imported",
        }
        for item in active
        if item.get("status") not in {"ready", "completed"}
    ]
    return {
        "pairing_count": len(pairings),
        "active_count": len(active),
        "ready_count": len(ready),
        "completed_count": len(completed),
        "missing_count": len(missing),
        "all_pairings_have_results": bool(active) and not missing,
        "all_results_have_known_editor": bool(active) and not missing and not unclear_result_sources,
        "resultSources": result_sources,
        "unclearResultSources": unclear_result_sources,
        "missing": missing,
    }


def ftd_result_has_known_editor(item: dict[str, Any]) -> bool:
    editor = normalize_text_like(item.get("lastEditedBy"))
    if editor in {"agent", "user", "automation"}:
        return True
    if editor != "script":
        return False
    result_kind = normalize_text_like(item.get("resultKind"))
    source_key = normalize_text_like(item.get("sourceMessageKey"))
    return result_kind == "oq-auto" or source_key.startswith("oq-auto:")


def resolved_pending_summary(round_item: dict[str, Any]) -> list[dict[str, Any]]:
    pending = round_item.get("pending") if isinstance(round_item.get("pending"), list) else []
    resolved = []
    for item in pending:
        if not isinstance(item, dict) or item.get("resolvedByReferee") is not True:
            continue
        resolved.append(
            {
                "id": item.get("id") or "",
                "table": item.get("pendingTable") or item.get("table") or item.get("dirtyTable") or "",
                "sender": item.get("sender") or "",
                "wechatSender": item.get("wechatSender") or "",
                "reason": item.get("reason") or "",
                "resolvedAt": item.get("resolvedAt"),
                "resolvedNote": item.get("resolvedNote") or "",
            }
        )
    return resolved


def active_pending_summary(round_item: dict[str, Any]) -> list[dict[str, Any]]:
    pending = round_item.get("pending") if isinstance(round_item.get("pending"), list) else []
    active = []
    for item in pending:
        if not isinstance(item, dict) or item.get("resolvedByReferee") is True:
            continue
        active.append(
            {
                "id": item.get("id") or "",
                "table": item.get("pendingTable") or item.get("table") or item.get("dirtyTable") or "",
                "sender": item.get("sender") or "",
                "wechatSender": item.get("wechatSender") or "",
                "verdict": item.get("verdict") or item.get("status") or "",
                "sourceMessageKey": item.get("sourceMessageKey") or "",
            }
        )
    return active


def score_write_followup(round_item: dict[str, Any]) -> dict[str, Any]:
    completion = ftd_round_completion(round_item)
    resolved = resolved_pending_summary(round_item)
    active_pending = active_pending_summary(round_item)
    missing_tables = {
        normalize_text_like(item.get("table"))
        for item in completion.get("missing", [])
        if isinstance(item, dict) and normalize_text_like(item.get("table"))
    }
    pending_tables = {
        normalize_text_like(item.get("table"))
        for item in [*active_pending, *resolved]
        if isinstance(item, dict) and normalize_text_like(item.get("table"))
    }
    pending_covers_missing = bool(missing_tables) and missing_tables.issubset(pending_tables)
    all_have_results = bool(completion.get("active_count")) and bool(completion.get("all_pairings_have_results"))
    all_known_editors = bool(completion.get("all_results_have_known_editor"))
    should_stop = all_have_results and all_known_editors
    if pending_covers_missing and active_pending:
        stop_code = "has-pending-but-round-can-stop"
        stop_reason = "remaining imported/dirty tables are only tracked in pending; verify missing before stopping"
    elif pending_covers_missing and resolved:
        stop_code = "referee-resolved-pending"
        stop_reason = "remaining imported/dirty tables only have referee-resolved pending; verify missing before stopping"
    elif all_have_results and not all_known_editors:
        stop_code = "all-ready-or-completed-editor-unknown"
        stop_reason = "all active FTD pairings are ready/completed, but some result editors are unknown; keep polling/checking"
    elif should_stop:
        stop_code = "all-ready-or-completed"
        stop_reason = "all active current-round FTD pairings are ready or completed and every result editor is known"
    else:
        stop_code = ""
        stop_reason = ""
    return {
        "roundCompletion": completion,
        "stopPolling": should_stop,
        "stopPollingCode": stop_code,
        "stopPollingReason": stop_reason,
        "stopPollingRequiresMissingCheck": bool(stop_code in {"has-pending-but-round-can-stop", "referee-resolved-pending"}),
        "pendingCoversMissing": pending_covers_missing,
        "resultEditorAudit": {
            "ok": all_known_editors,
            "knownCount": len(completion.get("resultSources", [])) - len(completion.get("unclearResultSources", [])),
            "unclearCount": len(completion.get("unclearResultSources", [])),
            "unclear": completion.get("unclearResultSources", []),
        },
        "activePendingCount": len(active_pending),
        "activePending": active_pending,
        "agentScope": "agent and referee jointly maintain pending; agent maintains yellow ready only; referee/frontend may change ready to completed",
        "resolvedPendingCount": len(resolved),
        "resolvedPending": resolved,
    }


def score_item_from_image_message(message: dict[str, Any], round_no: int) -> dict[str, Any]:
    inference = message.get("scoreInference") if isinstance(message.get("scoreInference"), dict) else {}
    source_key = message_key(message)
    return normalize_score_item_for_frontend(
        {
            "round": round_no,
            "sourceTime": message.get("time") or "",
            "sender": message.get("sender") or "",
            "wechatSender": sender_group_nickname(message, allow_sender_fallback=True),
            "senderAccount": message.get("senderAccount") or "",
            "loserStoneCount": inference.get("loserStoneCount"),
            "verdict": inference.get("status") or message.get("verdict") or "",
            "reason": inference.get("reason") or "",
            "imagePath": message.get("pngPath") or message.get("previewPath") or "",
            "sourceMessageKey": source_key,
            "sourceLocalId": str(message.get("local_id") or ""),
        },
        round_no,
    )


def cmd_score_scan(args: argparse.Namespace) -> int:
    state_path = Path(args.frontend_state)
    state = read_frontend_state(state_path, bool(args.direct_file))
    state.setdefault("version", 2)
    state["step"] = "score-helper"

    round_no = max(1, min(9, int(args.round)))
    helper = ensure_frontend_score_helper(state, max(round_no, int(args.round_count or 0)))
    helper["activeRound"] = round_no
    target_round = helper["rounds"][round_no - 1]
    validate_knockout_round_pairings(target_round)
    score_scan_timing, timing_wrote_frontend = resolve_score_scan_timing(args, target_round)
    args.start = score_scan_timing["start"]
    args.end = score_scan_timing["end"]
    args.endSource = score_scan_timing["endSource"]
    helper["updatedAt"] = int(time.time() * 1000)
    state["savedAt"] = int(time.time() * 1000)
    timing_written_to = ""
    if timing_wrote_frontend:
        timing_written_to = write_frontend_state(state_path, state, bool(args.direct_file))
        state = read_frontend_state(state_path, bool(args.direct_file))
        state.setdefault("version", 2)
        state["step"] = "score-helper"
        helper = ensure_frontend_score_helper(state, max(round_no, int(args.round_count or 0)))
        helper["activeRound"] = round_no
        target_round = helper["rounds"][round_no - 1]
    args.start, args.end, args.endSource, cache_delay = apply_cache_delay_to_scan_range(
        args.start,
        args.end,
        args.endSource,
    )
    score_scan_timing["effectiveStart"] = args.start
    score_scan_timing["effectiveEnd"] = args.end
    score_scan_timing["effectiveEndSource"] = args.endSource
    score_scan_timing["stateWrittenTo"] = timing_written_to
    seen_keys = existing_score_item_keys(helper)
    seen_state_path = Path(args.seen_state)
    score_scan_seen_before, mapping_advisory_seen_before = load_score_scan_seen_state(seen_state_path)

    roster_players = players_from_state(state, state_path)
    raw_pairing_players = players_from_ftd_round(target_round, round_no)
    if not raw_pairing_players:
        raise HelperError(
            f"第 {round_no} 轮没有 FTD 配对表；score-scan 不能使用签到表兜底匹配比分发图人"
        )
    mapping_rows = ftd_player_account_mapping_rows(state)
    map_refresh = refresh_member_map_for_score_scan(args.group)
    member_map_payload = agent_checkin_bridge.load_member_map(args.group)
    pairing_players, pairing_mapping_issues, pairing_context_by_key = enrich_ftd_pairing_players(
        target_round,
        roster_players,
        round_no,
        member_map_payload,
        mapping_rows,
    )
    (
        blocking_mapping_issues,
        advisory_mapping_issues,
        suppressed_mapping_issue_count,
        mapping_advisory_seen_next,
    ) = split_mapping_issues(pairing_mapping_issues, mapping_advisory_seen_before)
    visible_mapping_issues = blocking_mapping_issues + advisory_mapping_issues
    account_index = pairing_account_index(target_round, pairing_context_by_key)
    oq_auto_update: dict[str, Any] = {}
    oq_time_window: dict[str, Any] = {}
    if not args.dry_run:
        mark_oq_round_score_update_request(round_no, "agent-score-scan")
        round_start_text = str(args.round_start or args.start or "").strip()
        try:
            fallback_round_start = parse_local_time_required(round_start_text, "--round-start/--start")
            target_date, date_source = infer_score_anchor_date(state, target_round)
            keyword_search_start = f"{target_date} 00:00:00"
            keyword_search_end = f"{target_date} 23:59:59"
            try:
                oq_time_window = infer_oq_time_window_from_keywords(
                    args.group,
                    state,
                    helper,
                    target_round,
                    round_no,
                    fallback_round_start,
                    int(args.oq_window_minutes or 40),
                    keyword_search_start,
                    keyword_search_end,
                    1000,
                    0,
                )
                oq_time_window["date"] = target_date
                oq_time_window["dateSource"] = date_source
                oq_round_start = oq_time_window["start"]
                oq_round_end = oq_time_window["end"]
            except Exception as exc:  # noqa: BLE001
                oq_round_start = fallback_round_start
                oq_round_end = fallback_round_start + timedelta(minutes=max(1, int(args.oq_window_minutes or 40)))
                oq_time_window = {
                    "start": oq_round_start,
                    "end": oq_round_end,
                    "source": "fallback-start-duration-after-keyword-error",
                    "error": str(exc),
                    "fallbackMinutes": max(1, int(args.oq_window_minutes or 40)),
                    "policy": "keyword boundary inference failed; OQ auto lookup fell back to --round-start/--start plus oq-window-minutes",
                }
            oq_auto_update = update_round_oq_scores(
                state,
                round_no,
                int(args.round_count or 0),
                oq_round_start,
                int(args.oq_window_minutes or 40),
                args.oq_mode,
                int(args.oq_concurrency or 8),
                args.oq_base_url,
                int(args.oq_timeout or 20),
                bool(args.direct_file),
                False,
                oq_round_end,
                str(oq_time_window.get("source") or ""),
            )
            if oq_auto_update.get("appliedCount") or oq_auto_update.get("pendingCount"):
                helper["updatedAt"] = int(time.time() * 1000)
                state["savedAt"] = int(time.time() * 1000)
                write_frontend_state(state_path, state, bool(args.direct_file))
                state = read_frontend_state(state_path, bool(args.direct_file))
                helper = ensure_frontend_score_helper(state, max(round_no, int(args.round_count or 0)))
                helper["activeRound"] = round_no
                target_round = helper["rounds"][round_no - 1]
                roster_players = players_from_state(state, state_path)
                mapping_rows = ftd_player_account_mapping_rows(state)
                pairing_players, pairing_mapping_issues, pairing_context_by_key = enrich_ftd_pairing_players(
                    target_round,
                    roster_players,
                    round_no,
                    member_map_payload,
                    mapping_rows,
                )
                account_index = pairing_account_index(target_round, pairing_context_by_key)
                effective_pairing_players = pairing_players if pairing_players else raw_pairing_players
        except Exception as exc:  # noqa: BLE001
            oq_auto_update = {
                "ok": False,
                "error": str(exc),
                "policy": "score-scan continues with PNG review if OQ auto update fails",
            }
    effective_pairing_players = pairing_players if pairing_players else raw_pairing_players
    payload = image_messages(
        args.group,
        args.start,
        args.end,
        args.limit,
        args.offset,
        True,
        not args.allow_unmapped,
    )
    payload = annotate_and_download(
        payload,
        effective_pairing_players,
        Path(args.download_dir),
        True,
        args.force,
        match_source="round-pairing-index",
        pairing_context_by_key=pairing_context_by_key,
        pairing_account_index=account_index,
    )
    current_window_message_keys: set[str] = set()
    for message in payload.get("messages", []):
        if not isinstance(message, dict):
            continue
        annotate_score_scan_message_state(message, score_scan_seen_before, seen_keys)
        current_window_message_keys.add(message_key(message))
    flow_hints = score_scan_flow_hints(args.group, args.start, args.end, args.limit)
    next_round_password_hint = next_round_password_stop_hint(
        flow_hints,
        round_no,
        max(1, ftd_round_max_table(target_round)),
        int(args.keyword_limit or 0),
        helper,
    )
    stop_polling = score_scan_stop_polling_decision(flow_hints, next_round_password_hint)

    applied = []
    pushed = []
    duplicates = []
    rejected = []
    review = []
    review_summaries = []
    review_messages, oq_omitted_images = filter_score_scan_review_after_oq_update(
        [message for message in payload.get("messages", []) if isinstance(message, dict)],
        target_round,
    )
    for message in review_messages:
        reason = "agent-review-required; open image path and judge manually with current-round pairing match"
        review.append({**message, "scoreScanReviewReason": reason})
        review_summaries.append(score_scan_compact_item(message, reason))

    written_to = ""
    if applied and not args.dry_run:
        helper["updatedAt"] = int(time.time() * 1000)
        state["savedAt"] = int(time.time() * 1000)
        written_to = write_frontend_state(state_path, state, bool(args.direct_file))
    if current_window_message_keys or mapping_advisory_seen_next != mapping_advisory_seen_before:
        save_score_scan_seen_state(
            seen_state_path,
            score_scan_seen_before | current_window_message_keys,
            mapping_advisory_seen_next,
        )
    write_followup = score_write_followup(target_round)
    completion = write_followup["roundCompletion"]
    completion_stop = {
        "stopPolling": write_followup.get("stopPolling", False),
        "stopPollingCode": write_followup.get("stopPollingCode", ""),
        "stopPollingReason": write_followup.get("stopPollingReason", ""),
        "stopPollingMessages": [],
    }
    effective_stop_polling = stop_polling if stop_polling.get("stopPolling") else completion_stop
    duplicate_summaries = [
        {
            "table": item.get("table"),
            "black": item.get("black"),
            "white": item.get("white"),
            "sender": item.get("sender"),
            "reason": item.get("reason") or "duplicate",
            "sourceMessageKey": item.get("sourceMessageKey"),
        }
        for item in duplicates
        if isinstance(item, dict)
    ]
    png_paths = collect_score_scan_png_paths(review, rejected)

    report = {
        "ok": True,
        "action": "score-scan",
        "dryRun": bool(args.dry_run),
        "autoApplyKeywords": False,
        "readyWriteMode": "disabled-manual-image-review",
        "manualReviewRequired": bool(review or rejected),
        "state": written_to,
        "round": round_no,
        "range": {"start": args.start, "end": args.end, "endSource": args.endSource},
        "scoreScanTiming": score_scan_timing,
        "cacheDelay": cache_delay,
        "blockingScoreChecks": BLOCKING_SCORE_CHECKS,
        "pngPaths": png_paths,
        "agentImageOpenPolicy": (
            "Open all pngPaths for this score-scan window together first, then inspect them manually. "
            "Images already registered by OQ auto update are omitted from pngPaths and do not need agent review."
        ),
        "agentNextSteps": SCORE_SCAN_AGENT_NEXT_STEPS,
        "abnormalPendingPolicy": ABNORMAL_PENDING_POLICY,
        "image_count": len(payload.get("messages", [])),
        "refereeSummaryImageCount": sum(1 for item in payload.get("messages", []) if isinstance(item, dict) and item.get("sourceRole") == "referee-summary"),
        "player_match_source": payload.get("player_match_source"),
        "map_refresh": map_refresh,
        "oqAutoUpdate": oq_auto_update,
        "oqTimeWindow": {
            **{key: value for key, value in oq_time_window.items() if key not in {"start", "end"}},
            "startLocal": (
                oq_time_window["start"].isoformat(sep=" ")
                if isinstance(oq_time_window.get("start"), datetime)
                else str(oq_time_window.get("start") or "")
            ),
            "endLocal": (
                oq_time_window["end"].isoformat(sep=" ")
                if isinstance(oq_time_window.get("end"), datetime)
                else str(oq_time_window.get("end") or "")
            ),
        },
        "oqOmittedImageCount": len(oq_omitted_images),
        "oqOmittedImages": oq_omitted_images,
        "seenState": str(seen_state_path),
        "alreadySeenCount": sum(1 for item in payload.get("messages", []) if isinstance(item, dict) and item.get("alreadySeenInPreviousWindow")),
        "alreadyWrittenCount": sum(1 for item in payload.get("messages", []) if isinstance(item, dict) and item.get("alreadyWritten")),
        "pairing_index_player_count": len(pairing_players),
        "raw_pairing_player_count": len(raw_pairing_players),
        "ftdPlayerAccountMapping": {
            "loaded": bool(mapping_rows),
            "rowCount": len(mapping_rows),
            "policy": "score-scan reads latest frontend state and uses ftdPlayerAccountMapping as the first OQ-account source for current-round FTD names",
        },
        "unresolvedMappingCount": len(visible_mapping_issues),
        "unresolvedMapping": visible_mapping_issues,
        "rawUnresolvedMappingCount": len(pairing_mapping_issues),
        "blockingUnresolvedMappingCount": len(blocking_mapping_issues),
        "blockingUnresolvedMapping": blocking_mapping_issues,
        "advisoryUnresolvedMappingCount": len(advisory_mapping_issues),
        "advisoryUnresolvedMapping": advisory_mapping_issues,
        "suppressedAdvisoryUnresolvedMappingCount": suppressed_mapping_issue_count,
        "unresolvedMappingPolicy": (
            "blockingUnresolvedMapping can block ready account checks; advisoryUnresolvedMapping "
            "means the local roster lacks account data but screenshot account matching may still be enough. "
            "Advisory roster-gap issues are shown once per seen-state file."
        ),
        "pairingIndex": unique_pairing_contexts(pairing_context_by_key),
        "pairingAccountIndex": account_index,
        "accountMatchPolicy": (
            "Before writing ready, the two visible screenshot OQ IDs must uniquely match both accounts "
            "of one current-round table in pairingAccountIndex. Sender mapping is auxiliary only; "
            "it cannot replace the screenshot OQ ID gate."
        ),
        "realtimeUpdatePolicy": SCORE_SCAN_REALTIME_UPDATE_POLICY,
        "stopPollingPolicy": SCORE_SCAN_STOP_POLLING_POLICY,
        "stopPolling": effective_stop_polling["stopPolling"],
        "stopPollingCode": effective_stop_polling.get("stopPollingCode", ""),
        "stopPollingReason": effective_stop_polling["stopPollingReason"],
        "stopPollingMessages": effective_stop_polling["stopPollingMessages"],
        "scoreWriteFollowup": write_followup,
        "nextRoundPasswordStopHint": stop_polling.get("nextRoundPasswordStopHint") or {},
        "applied_count": len(applied),
        "ready_count": len(applied),
        "pushed_count": len(pushed),
        "duplicate_count": len(duplicates),
        "rejected_count": len(rejected),
        "review_count": len(review),
        "flow_hint_count": len(flow_hints.get("messages", [])),
        "ftd_completion": completion,
        "flow_hints": flow_hints,
        "applied": applied,
        "readyCandidates": [],
        "needsReview": review_summaries,
        "duplicateSummary": duplicate_summaries,
        "agentSummary": {
            "readyWritten": len(applied),
            "readyCandidates": 0,
            "duplicates": len(duplicate_summaries),
            "needsReview": len(review_summaries),
            "rejected": len(rejected),
            "message": (
                f"第 {round_no} 轮 {args.start}-{args.end}({args.endSource}): "
                f"需人工打开图片 {len(review_summaries)} 张；已 OQ 自动登记的图片不列路径；"
                f"自动写入 {len(applied)} 项；重复 {len(duplicate_summaries)} 项；异常 {len(rejected)} 项。"
            ),
            "realtimeUpdatePolicy": SCORE_SCAN_REALTIME_UPDATE_POLICY,
            "stopPolling": effective_stop_polling["stopPolling"],
            "stopPollingCode": effective_stop_polling.get("stopPollingCode", ""),
            "stopPollingReason": effective_stop_polling["stopPollingReason"],
            "nextRoundPasswordStopHint": stop_polling.get("nextRoundPasswordStopHint") or {},
        },
        "pushed": pushed,
        "duplicates": duplicates,
        "rejected": [
            {
                "time": item.get("time"),
                "sender": item.get("sender"),
                "wechatSender": item.get("wechatSender"),
                "sourceMessageKey": item.get("sourceMessageKey"),
                "alreadySeenInPreviousWindow": item.get("alreadySeenInPreviousWindow"),
                "alreadyWritten": item.get("alreadyWritten"),
                "sourceRole": item.get("sourceRole"),
                "allowedReadySource": item.get("allowedReadySource"),
                "readySourcePolicy": item.get("readySourcePolicy"),
                "pngPath": item.get("pngPath"),
                "previewPath": item.get("previewPath"),
                "image": item.get("image"),
                "playerHint": item.get("playerHint"),
                "pairingContext": item.get("pairingContext"),
                "manualScoreReview": item.get("manualScoreReview"),
                "scoreInference": item.get("scoreInference"),
                "pairingAccountIndex": item.get("pairingAccountIndex"),
            }
            for item in rejected
        ],
        "review": [
            {
                "time": item.get("time"),
                "sender": item.get("sender"),
                "wechatSender": item.get("wechatSender"),
                "sourceMessageKey": item.get("sourceMessageKey"),
                "alreadySeenInPreviousWindow": item.get("alreadySeenInPreviousWindow"),
                "alreadyWritten": item.get("alreadyWritten"),
                "sourceRole": item.get("sourceRole"),
                "allowedReadySource": item.get("allowedReadySource"),
                "readySourcePolicy": item.get("readySourcePolicy"),
                "pngPath": item.get("pngPath"),
                "previewPath": item.get("previewPath"),
                "image": item.get("image"),
                "playerHint": item.get("playerHint"),
                "pairingContext": item.get("pairingContext"),
                "manualScoreReview": item.get("manualScoreReview"),
                "scoreScanReviewReason": item.get("scoreScanReviewReason"),
                "scoreInference": item.get("scoreInference"),
                "pairingAccountIndex": item.get("pairingAccountIndex"),
            }
            for item in review
        ],
        "agentReminder": SCORE_REVIEW_REMINDER,
    }
    if args.output:
        write_output(report, args.output, quiet=True)
        report["output"] = args.output
    print_score_scan_console_summary(report)
    return 0


def ensure_frontend_score_helper(state: dict[str, Any], round_count: int) -> dict[str, Any]:
    helper = state.get("scoreHelper")
    if not isinstance(helper, dict):
        helper = {}
    existing_rounds = helper.get("rounds") if isinstance(helper.get("rounds"), list) else []
    current_count = int(helper.get("roundCount") or 0)
    source = str(helper.get("roundCountSource") or "")
    if source == "manual" and current_count >= 1:
        requested_count = int(round_count or 0)
        if requested_count > current_count:
            raise HelperError(
                f"requested round count {requested_count} exceeds explicit frontend roundCount {current_count}; "
                "update the frontend round setting first instead of overriding it from a helper argument"
            )
        count = current_count
    else:
        count = max(1, min(9, int(round_count or current_count or len(existing_rounds) or 1)))
    rounds = []
    for i in range(count):
        src = existing_rounds[i] if i < len(existing_rounds) and isinstance(existing_rounds[i], dict) else {}
        rounds.append(
            {
                "round": i + 1,
                "stage": str(src.get("stage") or "preliminary"),
                "roundStartAt": str(src.get("roundStartAt") or ""),
                "roundStartSource": str(src.get("roundStartSource") or ""),
                "pending": src.get("pending") if isinstance(src.get("pending"), list) else [],
                "manualPending": src.get("manualPending") if isinstance(src.get("manualPending"), list) else [],
                "completed": src.get("completed") if isinstance(src.get("completed"), list) else [],
                "ftdPairings": src.get("ftdPairings") if isinstance(src.get("ftdPairings"), list) else [],
            }
        )
    helper = {
        "version": 2,
        "preliminaryRoundCount": max(
            1,
            min(
                7,
                int(helper.get("preliminaryRoundCount") or max(1, count - 2)),
            ),
        ),
        "roundCount": count,
        "roundCountSource": str(helper.get("roundCountSource") or ""),
        "autoRoundCountPlayerCount": helper.get("autoRoundCountPlayerCount"),
        "activeRound": max(1, min(count, int(helper.get("activeRound") or 1))),
        "rounds": rounds,
        "updatedAt": int(time.time() * 1000),
    }
    state["scoreHelper"] = helper
    return helper


def normalize_score_item_for_frontend(item: dict[str, Any], round_no: int) -> dict[str, Any]:
    edited_at = int(time.time() * 1000)
    result_time = infer_score_result_time(item, edited_at)
    loser_count = item.get("loserStoneCount")
    if loser_count is None:
        loser_count = item.get("loser_stone_count")
    if loser_count is None and item.get("isDraw"):
        loser_count = 32
    if loser_count is None:
        loser_count = item.get("opponentScore")
    out = {
        "id": str(item.get("id") or f"agent-score-{int(time.time() * 1000)}-{os.urandom(3).hex()}"),
        "round": round_no,
        "sourceTime": score_result_time_text(item.get("sourceTime") or item.get("time") or ""),
        "resultTime": result_time,
        "resultSortKey": score_result_sort_key(item.get("resultSortKey") or result_time) or edited_at,
        "sender": str(item.get("sender") or ""),
        "wechatSender": sender_group_nickname(item, allow_sender_fallback=False),
        "senderAccount": str(item.get("senderAccount") or ""),
        "opponent": str(item.get("opponent") or ""),
        "loserStoneCount": loser_count,
        "verdict": str(item.get("verdict") or item.get("status") or ""),
        "senderScore": item.get("senderScore"),
        "opponentScore": item.get("opponentScore"),
        "resultText": str(item.get("resultText") or ""),
        "accountMismatchText": str(item.get("accountMismatchText") or ""),
        "sourceMessageKey": str(item.get("sourceMessageKey") or ""),
        "sourceLocalId": str(item.get("sourceLocalId") or item.get("local_id") or ""),
        "confidence": str(item.get("confidence") or ""),
        "lastEditedBy": str(item.get("lastEditedBy") or "agent"),
        "lastEditedAt": item.get("lastEditedAt") or edited_at,
    }
    for key in ("pendingKind", "pendingTable", "table", "reviewAction"):
        if item.get(key) not in (None, ""):
            out[key] = str(item.get(key))
    if isinstance(item.get("oqPendingDetail"), dict):
        out["oqPendingDetail"] = item["oqPendingDetail"]
    for key in ("loserStoneCount", "senderScore", "opponentScore"):
        try:
            out[key] = max(0, int(out[key]))
        except (TypeError, ValueError):
            out[key] = None
    return out


def normalize_pending_score_item(item: dict[str, Any], round_no: int, wechat_sender: str = "") -> dict[str, Any]:
    if not isinstance(item, dict):
        raise HelperError("pending score item must be a JSON object")
    if wechat_sender and not str(item.get("wechatSender") or "").strip():
        item = {**item, "wechatSender": wechat_sender}
    group_nickname = sender_group_nickname(item, allow_sender_fallback=False)
    if not group_nickname:
        raise HelperError(
            "pending score item needs the image sender group nickname: "
            "pass --wechat-sender or include wechatSender in item JSON"
        )
    item = {**item, "wechatSender": group_nickname}
    if not str(item.get("sender") or "").strip():
        item["sender"] = group_nickname
    return normalize_score_item_for_frontend(item, round_no)


def push_pending_item_to_round(
    target_round: dict[str, Any],
    item: dict[str, Any],
    round_no: int,
    wechat_sender: str = "",
) -> dict[str, Any]:
    pending_item = normalize_pending_score_item(item, round_no, wechat_sender)
    match_keys = pending_item_match_keys(pending_item)
    removed = remove_matching_pending_items(target_round, match_keys)
    target_round["pending"].insert(0, pending_item)
    return {
        "pending": pending_item,
        "dedupedPendingCount": len(removed),
        "dedupedPending": removed,
    }


def push_ready_item_to_round(
    target_round: dict[str, Any],
    item: dict[str, Any],
    round_no: int,
    table: Any = "",
    reporter_side: str = "",
    force_update: bool = False,
) -> dict[str, Any]:
    if not isinstance(item, dict):
        raise HelperError("score item must be a JSON object")
    table = table or item.get("table") or item.get("dirtyTable") or ""
    reporter_side = str(reporter_side or item.get("reporterSide") or "").lower()
    if reporter_side and reporter_side not in {"black", "white"}:
        raise HelperError("--reporter-side must be black or white")

    message = score_item_to_ready_message(item, round_no)
    result = apply_score_to_ftd_pairing(
        target_round,
        message,
        table=table,
        reporter_side=reporter_side,
        force_update=force_update,
    )
    if result is None:
        raise HelperError("could not uniquely match an FTD pairing; pass --table or a sender matching exactly one table")
    removed_pending: list[dict[str, Any]] = []
    if not result.get("duplicate"):
        cleanup_keys = ready_cleanup_match_keys(message, table)
        removed_pending = remove_matching_pending_items(target_round, cleanup_keys)
    return {
        "ready": result,
        "clearedPendingCount": len(removed_pending),
        "clearedPending": removed_pending,
    }


def cmd_rotate_image(args: argparse.Namespace) -> int:
    source = Path(args.image_path)
    if not source.exists():
        raise HelperError(f"image not found: {source}")
    degrees = int(args.degrees)
    if degrees not in {90, 180, 270, -90, -180, -270}:
        raise HelperError("--degrees must be one of 90, 180, 270, -90, -180, -270")
    normalized = degrees % 360
    output = Path(args.output) if args.output else source.with_name(f"{source.stem}_rot{normalized}.png")
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        from PIL import Image, ImageOps
    except Exception as exc:  # noqa: BLE001
        raise HelperError(f"Pillow is required to rotate images: {exc}") from exc

    with Image.open(source) as im:
        original_size = im.size
        im = ImageOps.exif_transpose(im)
        rotated = im.rotate(-degrees, expand=True)
        if rotated.mode not in {"RGB", "RGBA"}:
            rotated = rotated.convert("RGB")
        rotated.save(output, format="PNG")
        rotated_size = rotated.size
    print_json(
        {
            "ok": True,
            "imagePath": str(source),
            "rotatedPath": str(output),
            "degrees": degrees,
            "originalResolution": {"width": original_size[0], "height": original_size[1]},
            "rotatedResolution": {"width": rotated_size[0], "height": rotated_size[1]},
            "instruction": "Open rotatedPath manually; do not use OCR.",
        }
    )
    return 0


def cmd_push_score(args: argparse.Namespace) -> int:
    state_path = Path(args.frontend_state)
    state = read_frontend_state(state_path, bool(args.direct_file))
    state.setdefault("version", 2)
    state["step"] = "score-helper"
    round_no = max(1, min(9, int(args.round)))
    helper = ensure_frontend_score_helper(state, max(round_no, int(args.round_count or 0)))
    helper["activeRound"] = round_no
    target_round = helper["rounds"][round_no - 1]

    if args.item_json:
        item = json.loads(args.item_json)
    elif args.item_file:
        item = read_json(Path(args.item_file))
    else:
        item = {
            "sourceTime": args.source_time,
            "sender": args.sender,
            "opponent": args.opponent,
            "loserStoneCount": args.loser_stone_count,
            "verdict": args.verdict,
            "senderScore": args.sender_score,
            "opponentScore": args.opponent_score,
            "resultText": args.result_text,
            "reason": args.reason,
            "imagePath": args.image_path,
            "confidence": args.confidence,
        }
    if not isinstance(item, dict):
        raise HelperError("score item must be a JSON object")
    score_item = normalize_score_item_for_frontend(item, round_no)
    target_round["pending"].append(score_item)
    state["savedAt"] = int(time.time() * 1000)
    written_to = write_frontend_state(state_path, state, bool(args.direct_file))
    print_agent_write_json({"ok": True, "state": written_to, "round": round_no, "pushed": score_item})
    return 0


def cmd_push_pending_score(args: argparse.Namespace) -> int:
    state_path = Path(args.frontend_state)
    state = read_frontend_state(state_path, bool(args.direct_file))
    state.setdefault("version", 2)
    state["step"] = "score-helper"
    round_no = max(1, min(9, int(args.round)))
    helper = ensure_frontend_score_helper(state, max(round_no, int(args.round_count or 0)))
    helper["activeRound"] = round_no
    target_round = helper["rounds"][round_no - 1]

    if args.item_json:
        item = json.loads(args.item_json)
    elif args.item_file:
        item = read_json(Path(args.item_file))
    else:
        account_mismatch_text = args.account_mismatch_text
        if not account_mismatch_text and str(args.verdict or "").strip() == "account-mismatch":
            account_mismatch_text = args.reason
        item = {
            "sourceTime": args.source_time,
            "sender": args.sender,
            "wechatSender": args.wechat_sender,
            "opponent": args.opponent,
            "verdict": args.verdict or "pending-review",
            "resultText": args.result_text or (f"table {args.table} pending" if args.table else "agent pending"),
            "accountMismatchText": account_mismatch_text,
            "reason": args.reason,
            "imagePath": args.image_path,
            "sourceMessageKey": args.source_message_key,
            "confidence": args.confidence,
            "pendingKind": args.pending_kind,
            "pendingTable": args.table,
            "table": args.table,
            "reviewAction": args.review_action,
        }
    result = push_pending_item_to_round(target_round, item, round_no, args.wechat_sender)
    helper["updatedAt"] = int(time.time() * 1000)
    state["savedAt"] = int(time.time() * 1000)
    written_to = write_frontend_state(state_path, state, bool(args.direct_file))
    print_agent_write_json(
        {
            "ok": True,
            "state": written_to,
            "round": round_no,
            "pending": result["pending"],
            "dedupedPendingCount": result["dedupedPendingCount"],
            "wechatSenderRequired": True,
            **score_write_followup(target_round),
        }
    )
    return 0


def score_item_to_ready_message(item: dict[str, Any], round_no: int) -> dict[str, Any]:
    score_item = normalize_score_item_for_frontend(item, round_no)
    status = score_item.get("verdict") or item.get("status") or ""
    loser_count = score_item.get("loserStoneCount")
    inference: dict[str, Any] = {
        "status": status,
        "reason": score_item.get("reason") or "",
    }
    if loser_count is not None:
        inference["loserStoneCount"] = loser_count
    return {
        **score_item,
        "scoreInference": inference,
        "blackScore": item.get("blackScore"),
        "whiteScore": item.get("whiteScore"),
        "sourceTime": score_item.get("sourceTime") or "",
        "resultTime": score_item.get("resultTime") or "",
        "resultSortKey": score_item.get("resultSortKey") or 0,
        "pngPath": item.get("pngPath") or score_item.get("imagePath") or "",
        "previewPath": item.get("previewPath") or "",
    }


def cmd_push_ready_score(args: argparse.Namespace) -> int:
    state_path = Path(args.frontend_state)
    state = read_frontend_state(state_path, bool(args.direct_file))
    state.setdefault("version", 2)
    state["step"] = "score-helper"
    round_no = max(1, min(9, int(args.round)))
    helper = ensure_frontend_score_helper(state, max(round_no, int(args.round_count or 0)))
    helper["activeRound"] = round_no
    target_round = helper["rounds"][round_no - 1]

    if args.item_json:
        item = json.loads(args.item_json)
    elif args.item_file:
        item = read_json(Path(args.item_file))
    else:
        item = {
            "sourceTime": args.source_time,
            "sender": args.sender,
            "opponent": args.opponent,
            "loserStoneCount": args.loser_stone_count,
            "verdict": args.verdict,
            "senderScore": args.sender_score,
            "opponentScore": args.opponent_score,
            "blackScore": args.black_score,
            "whiteScore": args.white_score,
            "resultText": args.result_text,
            "reason": args.reason,
            "imagePath": args.image_path,
            "sourceMessageKey": args.source_message_key,
            "confidence": args.confidence,
        }
    result = push_ready_item_to_round(
        target_round,
        item,
        round_no,
        table=args.table,
        reporter_side=args.reporter_side,
        force_update=bool(args.force_update),
    )
    if result["ready"].get("duplicate"):
        print_agent_write_json(
            {
                "ok": True,
                "state": "",
                "round": round_no,
                "duplicate": result["ready"],
                **score_write_followup(target_round),
            }
        )
        return 0

    helper["updatedAt"] = int(time.time() * 1000)
    state["savedAt"] = int(time.time() * 1000)
    written_to = write_frontend_state(state_path, state, bool(args.direct_file))
    followup = score_write_followup(target_round)
    print_agent_write_json(
        {
            "ok": True,
            "state": written_to,
            "round": round_no,
            "ready": result["ready"],
            "clearedPendingCount": result["clearedPendingCount"],
            "clearedPending": result["clearedPending"],
            **followup,
        }
    )
    return 0


def batch_items_from_args(args: argparse.Namespace) -> dict[str, Any]:
    if args.batch_json:
        payload = json.loads(args.batch_json)
    elif args.batch_file:
        payload = read_json(Path(args.batch_file))
    else:
        raise HelperError("batch score command needs --batch-file or --batch-json")
    if isinstance(payload, list):
        payload = {"ready": payload, "pending": []}
    if not isinstance(payload, dict):
        raise HelperError("batch score payload must be a JSON object or an array of ready items")
    ready = payload.get("ready") if isinstance(payload.get("ready"), list) else []
    pending = payload.get("pending") if isinstance(payload.get("pending"), list) else []
    return {"ready": ready, "pending": pending}


def cmd_push_batch_scores(args: argparse.Namespace) -> int:
    state_path = Path(args.frontend_state)
    state = read_frontend_state(state_path, bool(args.direct_file))
    state.setdefault("version", 2)
    state["step"] = "score-helper"
    round_no = max(1, min(9, int(args.round)))
    batch = batch_items_from_args(args)
    helper = ensure_frontend_score_helper(state, max(round_no, int(args.round_count or 0)))
    helper["activeRound"] = round_no
    target_round = helper["rounds"][round_no - 1]

    ready_results = []
    pending_results = []
    duplicates = []
    for raw_item in batch["pending"]:
        result = push_pending_item_to_round(target_round, raw_item, round_no)
        pending_results.append(result)
    for raw_item in batch["ready"]:
        if not isinstance(raw_item, dict):
            raise HelperError("each batch ready item must be a JSON object")
        result = push_ready_item_to_round(
            target_round,
            raw_item,
            round_no,
            table=raw_item.get("table") or raw_item.get("dirtyTable") or "",
            reporter_side=raw_item.get("reporterSide") or "",
            force_update=bool(args.force_update or raw_item.get("forceUpdate")),
        )
        if result["ready"].get("duplicate"):
            duplicates.append(result["ready"])
        else:
            ready_results.append(result)

    helper["updatedAt"] = int(time.time() * 1000)
    state["savedAt"] = int(time.time() * 1000)
    written_to = write_frontend_state(state_path, state, bool(args.direct_file))
    followup = score_write_followup(target_round)
    print_agent_write_json(
        {
            "ok": True,
            "state": written_to,
            "round": round_no,
            "readyCount": len(ready_results),
            "pendingCount": len(pending_results),
            "pendingWrittenCount": len(pending_results),
            "duplicateCount": len(duplicates),
            "ready": ready_results,
            "pending": pending_results,
            "duplicates": duplicates,
            "wechatSenderRequiredForPending": True,
            **followup,
        }
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Agent match image helper")
    parser.add_argument("--group", default=agent_checkin_bridge.default_group_name(), help="Group name or @chatroom username")
    parser.add_argument("--state", default=str(DEFAULT_STATE_PATH), help="Check-in state JSON used as roster source")
    sub = parser.add_subparsers(dest="command", required=True)

    p_status = sub.add_parser("status", help="Show group map and roster status")
    p_status.set_defaults(func=cmd_status)

    p_members = sub.add_parser("members", help="List cached group member information")
    p_members.add_argument("--query", default="", help="Filter by group nick/contact/username")
    p_members.add_argument("--limit", type=int, default=50)
    p_members.set_defaults(func=cmd_members)

    p_chat = sub.add_parser("chat-history", help="Export text plus image messages; images are downloaded and converted to PNG when needed")
    p_chat.add_argument("--start", required=True)
    p_chat.add_argument("--end", required=True)
    p_chat.add_argument("--limit", type=int, default=1000)
    p_chat.add_argument("--offset", type=int, default=0)
    p_chat.add_argument("--msg-type", action="append", help="Text-side message types, default text; image handling is separate")
    p_chat.add_argument("--download-dir", default=str(DEFAULT_IMAGE_DIR))
    p_chat.add_argument("--output", default="", help="Optional output JSON path")
    p_chat.add_argument("--no-text", action="store_true")
    p_chat.add_argument("--no-images", action="store_true")
    p_chat.add_argument("--no-download", action="store_true")
    p_chat.add_argument("--force", action="store_true")
    p_chat.add_argument("--allow-unmapped", action="store_true")
    p_chat.set_defaults(func=cmd_chat_history)

    p_scan = sub.add_parser("scan", help="Scan image messages in a time window and download them")
    p_scan.add_argument("--start", required=True)
    p_scan.add_argument("--end", required=True)
    p_scan.add_argument("--limit", type=int, default=500)
    p_scan.add_argument("--offset", type=int, default=0)
    p_scan.add_argument("--oldest-first", action="store_true", default=True)
    p_scan.add_argument("--download-dir", default=str(DEFAULT_IMAGE_DIR))
    p_scan.add_argument("--output", default="", help="Optional output JSON path")
    p_scan.add_argument("--no-download", action="store_true")
    p_scan.add_argument("--force", action="store_true", help="Overwrite copied image files")
    p_scan.add_argument("--allow-unmapped", action="store_true", help="Do not fail when an image sender is missing from the member map")
    p_scan.set_defaults(func=cmd_scan)

    p_watch = sub.add_parser("watch", help="Poll for new image messages and download them")
    p_watch.add_argument("--start", required=True)
    p_watch.add_argument("--end", default="")
    p_watch.add_argument("--interval", type=int, default=30)
    p_watch.add_argument("--limit", type=int, default=1000)
    p_watch.add_argument("--download-dir", default=str(DEFAULT_IMAGE_DIR))
    p_watch.add_argument("--seen-state", default=str(DEFAULT_WATCH_STATE))
    p_watch.add_argument("--once", action="store_true", help="Run one polling pass and exit")
    p_watch.add_argument("--force", action="store_true")
    p_watch.add_argument("--allow-unmapped", action="store_true")
    p_watch.set_defaults(func=cmd_watch)

    p_score_anchor = sub.add_parser("score-anchor", help="Search same-day round/password text messages to help choose score-scan start time")
    p_score_anchor.add_argument("--frontend-state", default=str(DEFAULT_FRONTEND_STATE_PATH))
    p_score_anchor.add_argument("--round", type=int, required=True)
    p_score_anchor.add_argument("--date", default="", help="Competition date, e.g. 2026-06-06; inferred from roundStartAt/state when omitted")
    p_score_anchor.add_argument("--start", default="", help="Override search start time")
    p_score_anchor.add_argument("--end", default="", help="Override search end time")
    p_score_anchor.add_argument("--max-table", type=int, default=0, help="Override FTD max table count")
    p_score_anchor.add_argument("--keyword-limit", type=int, default=20, help="Maximum total round/password keywords; 0 disables the limit")
    p_score_anchor.add_argument("--page-size", type=int, default=1000)
    p_score_anchor.add_argument("--max-pages", type=int, default=0, help="Safety cap; 0 means all pages in range")
    p_score_anchor.add_argument("--output", default="", help="Optional full JSON output path")
    p_score_anchor.add_argument("--direct-file", action="store_true", help="Read shared JSON directly instead of the local sync API")
    p_score_anchor.set_defaults(func=cmd_score_anchor)

    p_score_scan = sub.add_parser("score-scan", help="Scan match-time image messages and produce a manual image-review report")
    p_score_scan.add_argument("--frontend-state", default=str(DEFAULT_FRONTEND_STATE_PATH))
    p_score_scan.add_argument("--round", type=int, required=True)
    p_score_scan.add_argument("--round-count", type=int, default=0)
    p_score_scan.add_argument("--start", default="", help="Optional scan start; when omitted, uses this round's frontend roundStartAt")
    p_score_scan.add_argument("--end", default="", help="Optional scan end; defaults to --start plus 40 minutes when omitted")
    p_score_scan.add_argument("--round-start", default="", help="Optional Beijing local round start for OQ auto score lookup; defaults to --start")
    p_score_scan.add_argument("--oq-window-minutes", type=int, default=40)
    p_score_scan.add_argument("--oq-mode", default="5min", choices=["1min", "5min", "xot"], help="OQ mode used before PNG review")
    p_score_scan.add_argument("--oq-concurrency", type=int, default=8)
    p_score_scan.add_argument("--oq-timeout", type=int, default=20)
    p_score_scan.add_argument("--oq-base-url", default="http://questgames.net")
    p_score_scan.add_argument("--limit", type=int, default=1000)
    p_score_scan.add_argument("--offset", type=int, default=0)
    p_score_scan.add_argument("--keyword-limit", type=int, default=20, help="Maximum total keywords for next-round password stop detection; 0 disables the limit")
    p_score_scan.add_argument("--download-dir", default=str(DEFAULT_IMAGE_DIR))
    p_score_scan.add_argument("--output", default="", help="Optional score-scan report JSON path")
    p_score_scan.add_argument("--seen-state", default=str(DEFAULT_SCORE_SCAN_SEEN_STATE), help="Score-scan seen-state JSON for cross-window duplicate marking")
    p_score_scan.add_argument("--force", action="store_true")
    p_score_scan.add_argument("--allow-unmapped", action="store_true")
    p_score_scan.add_argument("--dry-run", action="store_true", help="Do not write recognized items to the frontend")
    p_score_scan.add_argument("--direct-file", action="store_true", help="Write shared JSON directly instead of the local sync API")
    p_score_scan.set_defaults(func=cmd_score_scan)

    p_sync_accounts = sub.add_parser("sync-checkedin-accounts", help="Refresh group nickname map and write deterministic checked-in OQ account mapping to frontend state")
    p_sync_accounts.add_argument("--frontend-state", default=str(DEFAULT_FRONTEND_STATE_PATH))
    p_sync_accounts.add_argument("--dry-run", action="store_true")
    p_sync_accounts.add_argument("--direct-file", action="store_true", help="Write shared JSON directly instead of the local sync API")
    p_sync_accounts.set_defaults(func=cmd_sync_checkedin_accounts)

    p_map_ftd_players = sub.add_parser("map-ftd-players", help="Map an exported FTD player table to OQ accounts from the group nickname map")
    p_map_ftd_players.add_argument("--ftd-players", required=True, help="Path to ftd-players-*.json downloaded from the FTD player export button")
    p_map_ftd_players.add_argument("--output", default="", help="Optional output JSON path; default writes under agent_cache\\ftd_player_maps")
    p_map_ftd_players.add_argument("--frontend-state", default=str(DEFAULT_FRONTEND_STATE_PATH))
    p_map_ftd_players.add_argument("--write-frontend", action="store_true", help="Also write ftdPlayerAccountMapping into the shared frontend state")
    p_map_ftd_players.add_argument("--no-refresh-map", action="store_true", help="Use the existing cached group nickname map instead of refreshing first")
    p_map_ftd_players.add_argument("--direct-file", action="store_true", help="Write shared JSON directly instead of the local sync API")
    p_map_ftd_players.add_argument("--oq-mode", default="5min", choices=["1min", "5min", "xot"], help="OQ mode used for account validation")
    p_map_ftd_players.add_argument("--oq-concurrency", type=int, default=8, help="Concurrent OQ account validation requests")
    p_map_ftd_players.add_argument("--oq-timeout", type=int, default=20, help="Per-account OQ request timeout seconds")
    p_map_ftd_players.add_argument("--oq-base-url", default="http://questgames.net", help="OQ API base URL")
    p_map_ftd_players.set_defaults(func=cmd_map_ftd_players)

    p_build_draft = sub.add_parser(
        "build-ftd-map-draft",
        help="Hard-gated draft flow: refresh WeChat nicks, build FTD/OQ map, write local state, and output agent review material",
    )
    p_build_draft.add_argument("--ftd-players", required=True, help="Path to ftd-players-*.json downloaded from the FTD player export button")
    p_build_draft.add_argument("--output", default="", help="Optional audit JSON path; default writes under subagent_outputs\\ftd_player_maps")
    p_build_draft.add_argument("--frontend-state", default=str(DEFAULT_FRONTEND_STATE_PATH))
    p_build_draft.add_argument("--write-frontend", action="store_true", default=True, help="Required; write ftdPlayerAccountMapping through the local frontend API")
    p_build_draft.add_argument("--no-refresh-map", action="store_true", help="Forbidden in this hard-gated draft flow")
    p_build_draft.add_argument("--direct-file", action="store_true", help="Write shared JSON directly instead of the local sync API")
    p_build_draft.add_argument(
        "--allow-relay-month-mismatch",
        action="store_false",
        dest="require_current_relay_month",
        default=True,
        help="Debug only: do not fail when frontend relayText is missing or not from the current month",
    )
    p_build_draft.add_argument("--oq-mode", default="5min", choices=["1min", "5min", "xot"], help="OQ mode used for account validation")
    p_build_draft.add_argument("--oq-concurrency", type=int, default=8, help="Concurrent OQ account validation requests")
    p_build_draft.add_argument("--oq-timeout", type=int, default=20, help="Per-account OQ request timeout seconds")
    p_build_draft.add_argument("--oq-base-url", default="http://questgames.net", help="OQ API base URL")
    p_build_draft.set_defaults(func=cmd_build_ftd_map_draft)

    p_patch_map = sub.add_parser("patch-ftd-map", help="Write agent-reviewed deterministic name/OQ/group-nick additions to the local FTD map")
    p_patch_map.add_argument("--frontend-state", default=str(DEFAULT_FRONTEND_STATE_PATH))
    p_patch_map.add_argument("--patch-file", default="", help="JSON array/object rows with ftdName, account, and/or groupNick")
    p_patch_map.add_argument("--patch-json", default="", help="Inline JSON array/object rows with ftdName, account, and/or groupNick")
    p_patch_map.add_argument("--no-changes-reviewed", action="store_true", help="Mark agent review complete when the agent found no deterministic additions")
    p_patch_map.add_argument("--direct-file", action="store_true", help="Write shared JSON directly instead of the local sync API")
    p_patch_map.set_defaults(func=cmd_patch_ftd_map)

    p_validate_publish = sub.add_parser("validate-and-publish-ftd-map", help="After agent review, run one OQ validation pass, write local state, publish online, and verify remote stats")
    p_validate_publish.add_argument("--frontend-state", default=str(DEFAULT_FRONTEND_STATE_PATH))
    p_validate_publish.add_argument("--direct-file", action="store_true", help="Read/write shared JSON directly instead of the local sync API")
    p_validate_publish.add_argument("--oq-mode", default="5min", choices=["1min", "5min", "xot"], help="OQ mode used for account validation")
    p_validate_publish.add_argument("--oq-concurrency", type=int, default=8, help="Concurrent OQ account validation requests")
    p_validate_publish.add_argument("--oq-timeout", type=int, default=20, help="Per-account OQ request timeout seconds")
    p_validate_publish.add_argument("--oq-base-url", default="http://questgames.net", help="OQ API base URL")
    p_validate_publish.set_defaults(func=cmd_validate_and_publish_ftd_map)

    p_build_publish = sub.add_parser(
        "build-and-publish-ftd-map",
        help="Disabled legacy alias; use build-ftd-map-draft, patch-ftd-map, then validate-and-publish-ftd-map",
    )
    p_build_publish.add_argument("--ftd-players", required=True, help="Path to ftd-players-*.json downloaded from the FTD player export button")
    p_build_publish.add_argument("--output", default="", help="Optional output JSON path; default writes under agent_cache\\ftd_player_maps")
    p_build_publish.add_argument("--frontend-state", default=str(DEFAULT_FRONTEND_STATE_PATH))
    p_build_publish.add_argument("--write-frontend", action="store_true", default=True, help="Required; write ftdPlayerAccountMapping through the local frontend API")
    p_build_publish.add_argument("--no-refresh-map", action="store_true", help="Forbidden in this hard-gated flow")
    p_build_publish.add_argument("--direct-file", action="store_true", help="Write shared JSON directly instead of the local sync API")
    p_build_publish.add_argument("--oq-mode", default="5min", choices=["1min", "5min", "xot"], help="OQ mode used for account validation")
    p_build_publish.add_argument("--oq-concurrency", type=int, default=8, help="Concurrent OQ account validation requests")
    p_build_publish.add_argument("--oq-timeout", type=int, default=20, help="Per-account OQ request timeout seconds")
    p_build_publish.add_argument("--oq-base-url", default="http://questgames.net", help="OQ API base URL")
    p_build_publish.set_defaults(func=cmd_build_and_publish_ftd_map)

    p_validate_oq = sub.add_parser("validate-oq-accounts", help="Validate current frontend FTD mapping OQ accounts and write results back")
    p_validate_oq.add_argument("--frontend-state", default=str(DEFAULT_FRONTEND_STATE_PATH))
    p_validate_oq.add_argument("--direct-file", action="store_true", help="Write shared JSON directly instead of the local sync API")
    p_validate_oq.add_argument("--oq-mode", default="5min", choices=["1min", "5min", "xot"], help="OQ mode used for account validation")
    p_validate_oq.add_argument("--oq-concurrency", type=int, default=8, help="Concurrent OQ account validation requests")
    p_validate_oq.add_argument("--oq-timeout", type=int, default=20, help="Per-account OQ request timeout seconds")
    p_validate_oq.add_argument("--oq-base-url", default="http://questgames.net", help="OQ API base URL")
    p_validate_oq.add_argument("--from-time", default="", help="Optional Beijing local window start, e.g. 2026-06-06 20:01")
    p_validate_oq.add_argument("--to-time", default="", help="Optional Beijing local window end, e.g. 2026-06-06 21:36")
    p_validate_oq.set_defaults(func=cmd_validate_oq_accounts)

    p_update_oq_scores = sub.add_parser("update-round-oq-scores", help="Query OQ games and write safe current-round FTD scores as ready")
    p_update_oq_scores.add_argument("--frontend-state", default=str(DEFAULT_FRONTEND_STATE_PATH))
    p_update_oq_scores.add_argument("--round", type=int, required=True)
    p_update_oq_scores.add_argument("--round-count", type=int, default=0)
    p_update_oq_scores.add_argument("--round-start", required=True, help="Beijing local round start, e.g. 2026-06-08 20:00")
    p_update_oq_scores.add_argument("--window-minutes", type=int, default=40)
    p_update_oq_scores.add_argument("--direct-file", action="store_true", help="Write shared JSON directly instead of the local sync API")
    p_update_oq_scores.add_argument("--dry-run", action="store_true")
    p_update_oq_scores.add_argument("--oq-mode", default="5min", choices=["1min", "5min", "xot"], help="OQ mode used for score lookup")
    p_update_oq_scores.add_argument("--oq-concurrency", type=int, default=8, help="Concurrent OQ game lookup requests")
    p_update_oq_scores.add_argument("--oq-timeout", type=int, default=20, help="Per-account OQ request timeout seconds")
    p_update_oq_scores.add_argument("--oq-base-url", default="http://questgames.net", help="OQ API base URL")
    p_update_oq_scores.set_defaults(func=cmd_update_round_oq_scores)

    p_push = sub.add_parser("push-score", help="Append one recognized score item to the local frontend shared JSON")
    p_push.add_argument("--frontend-state", default=str(DEFAULT_FRONTEND_STATE_PATH))
    p_push.add_argument("--round", type=int, required=True)
    p_push.add_argument("--round-count", type=int, default=0)
    p_push.add_argument("--item-json", default="")
    p_push.add_argument("--item-file", default="")
    p_push.add_argument("--source-time", default="", help=argparse.SUPPRESS)
    p_push.add_argument("--sender", default="")
    p_push.add_argument("--opponent", default="")
    p_push.add_argument("--loser-stone-count", type=int, default=None)
    p_push.add_argument("--verdict", default="", help="agent verdict/status, e.g. board, draw, reject-you-lose, not-board")
    p_push.add_argument("--sender-score", type=int, default=None)
    p_push.add_argument("--opponent-score", type=int, default=None)
    p_push.add_argument("--result-text", default="")
    p_push.add_argument("--reason", default="", help=argparse.SUPPRESS)
    p_push.add_argument("--image-path", default="", help=argparse.SUPPRESS)
    p_push.add_argument("--confidence", default="")
    p_push.add_argument("--direct-file", action="store_true", help="Write shared JSON directly instead of the local sync API")
    p_push.set_defaults(func=cmd_push_score)

    p_pending = sub.add_parser("push-pending-score", help="Record one abnormal score item in the frontend pending queue without stopping polling")
    p_pending.add_argument("--frontend-state", default=str(DEFAULT_FRONTEND_STATE_PATH))
    p_pending.add_argument("--round", type=int, required=True)
    p_pending.add_argument("--round-count", type=int, default=0)
    p_pending.add_argument("--table", default="", help="FTD table number related to this pending item")
    p_pending.add_argument("--item-json", default="")
    p_pending.add_argument("--item-file", default="")
    p_pending.add_argument("--source-time", default="", help=argparse.SUPPRESS)
    p_pending.add_argument("--sender", default="")
    p_pending.add_argument("--wechat-sender", required=True, help="Required group nickname of the member who sent the score image")
    p_pending.add_argument("--opponent", default="")
    p_pending.add_argument("--verdict", default="pending-review", help="pending status, e.g. account-mismatch, unreadable, loser-side, unmapped-sender")
    p_pending.add_argument("--pending-kind", default="agent-abnormality")
    p_pending.add_argument("--review-action", default="review in frontend; agent may clear this after a later valid image")
    p_pending.add_argument("--result-text", default="")
    p_pending.add_argument("--account-mismatch-text", default="", help="Compact account-mismatch summary: visible OQ ID, registered OQ ID, and player name")
    p_pending.add_argument("--reason", required=False, default="", help=argparse.SUPPRESS)
    p_pending.add_argument("--image-path", default="", help=argparse.SUPPRESS)
    p_pending.add_argument("--source-message-key", default="")
    p_pending.add_argument("--confidence", default="")
    p_pending.add_argument("--direct-file", action="store_true", help="Write shared JSON directly instead of the local sync API")
    p_pending.set_defaults(func=cmd_push_pending_score)

    p_ready = sub.add_parser("push-ready-score", help="Write one manually reviewed score directly to an FTD pairing as status=ready")
    p_ready.add_argument("--frontend-state", default=str(DEFAULT_FRONTEND_STATE_PATH))
    p_ready.add_argument("--round", type=int, required=True)
    p_ready.add_argument("--round-count", type=int, default=0)
    p_ready.add_argument("--table", default="", help="FTD table number to update; preferred for real score registration")
    p_ready.add_argument("--reporter-side", choices=["black", "white"], default="", help="Reporter side in the FTD pairing when sender name cannot match the table")
    p_ready.add_argument("--item-json", default="")
    p_ready.add_argument("--item-file", default="")
    p_ready.add_argument("--source-time", default="", help=argparse.SUPPRESS)
    p_ready.add_argument("--sender", default="")
    p_ready.add_argument("--opponent", default="")
    p_ready.add_argument("--loser-stone-count", type=int, default=None)
    p_ready.add_argument("--verdict", default="", help="Optional only for inferred ready scores, e.g. draw or winner-by-forfeit; omit for exact black/white scores")
    p_ready.add_argument("--sender-score", type=int, default=None)
    p_ready.add_argument("--opponent-score", type=int, default=None)
    p_ready.add_argument("--black-score", type=int, default=None)
    p_ready.add_argument("--white-score", type=int, default=None)
    p_ready.add_argument("--result-text", default="")
    p_ready.add_argument("--reason", default="", help=argparse.SUPPRESS)
    p_ready.add_argument("--image-path", default="", help=argparse.SUPPRESS)
    p_ready.add_argument("--source-message-key", default="")
    p_ready.add_argument("--confidence", default="")
    p_ready.add_argument("--force-update", action="store_true", help="Overwrite an existing yellow ready row for this table")
    p_ready.add_argument("--direct-file", action="store_true", help="Write shared JSON directly instead of the local sync API")
    p_ready.set_defaults(func=cmd_push_ready_score)

    p_batch = sub.add_parser("push-batch-scores", help="Write manually reviewed ready and pending score items in one state update")
    p_batch.add_argument("--frontend-state", default=str(DEFAULT_FRONTEND_STATE_PATH))
    p_batch.add_argument("--round", type=int, required=True)
    p_batch.add_argument("--round-count", type=int, default=0)
    p_batch.add_argument("--batch-json", default="")
    p_batch.add_argument("--batch-file", default="")
    p_batch.add_argument("--force-update", action="store_true", help="Overwrite existing yellow ready rows for batch ready items")
    p_batch.add_argument("--direct-file", action="store_true", help="Write shared JSON directly instead of the local sync API")
    p_batch.set_defaults(func=cmd_push_batch_scores)

    p_rotate = sub.add_parser("rotate-image", help="Create a rotated PNG for manual inspection; no OCR")
    p_rotate.add_argument("--image-path", required=True, help="Source image path")
    p_rotate.add_argument("--degrees", type=int, default=90, help="Clockwise rotation: 90, 180, 270, or negative values")
    p_rotate.add_argument("--output", default="", help="Optional output PNG path")
    p_rotate.set_defaults(func=cmd_rotate_image)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except HelperError as exc:
        print_json({"ok": False, "error": str(exc)})
        return 2
    except Exception as exc:  # noqa: BLE001
        print_json({"ok": False, "error": f"Unexpected error: {exc}"})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

