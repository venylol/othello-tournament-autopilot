#!/usr/bin/env python3
"""Unified agent helper for tournament-day WeChat workflows."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import agent_checkin_bridge
import agent_match_image_helper


ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parent
SELF_CHECK_SCRIPT = REPO_ROOT / "tournament_arrangement" / "recovered" / "self-check.js"
RESOLVE_FTD_PLAYERS_SCRIPT = ROOT / "resolve_ftd_players.js"


def print_usage() -> None:
    print(
        """Agent Tournament Helper

Common commands:
  agent_tournament_helper.cmd status
  agent_tournament_helper.cmd self-check --full --event open
  agent_tournament_helper.cmd self-check --checkin-ready --event open
  agent_tournament_helper.cmd self-check --round 1 --event open
  agent_tournament_helper.cmd refresh-map
  agent_tournament_helper.cmd history --start "2026-06-06 20:00" --end "2026-06-06 20:30" --output agent_cache\\history.json
  agent_tournament_helper.cmd images --start "2026-06-06 20:00" --end "2026-06-06 20:30"
  agent_tournament_helper.cmd score-anchor --round 2 --date 2026-06-06
  agent_tournament_helper.cmd score-scan --round 1 --start "2026-06-06 20:00" --end "2026-06-06 20:30"
  agent_tournament_helper.cmd build-ftd-map-draft --ftd-players "%USERPROFILE%\\Downloads\\ftd-players-576.json"
  agent_tournament_helper.cmd patch-ftd-map --no-changes-reviewed
  agent_tournament_helper.cmd validate-and-publish-ftd-map
  agent_tournament_helper.cmd resolve-ftd-players
  agent_tournament_helper.cmd resolve-ftd-players --names-reviewed
  agent_tournament_helper.cmd map-ftd-players --ftd-players "%USERPROFILE%\\Downloads\\ftd-players-576.json" --write-frontend
  agent_tournament_helper.cmd validate-oq-accounts
  agent_tournament_helper.cmd update-round-oq-scores --round 1 --round-start "2026-06-06 20:00"
  agent_tournament_helper.cmd watch-images --start "2026-06-06 20:00"
  agent_tournament_helper.cmd rotate-image --image-path "agent_cache\\match_images\\sideways.png" --degrees 90
  agent_tournament_helper.cmd push-batch-scores --round 1 --batch-file agent_cache\\score_batch_r1_20260606_2023_2025.json

Single-item fallback commands:
  agent_tournament_helper.cmd push-pending-score --round 1 --table 3 --wechat-sender "A group nick" --verdict account-mismatch
  agent_tournament_helper.cmd push-ready-score --round 1 --table 3 --black-score 38 --white-score 26 --sender "A"
  agent_tournament_helper.cmd push-score --round 1 --round-count 5 --sender "A" --loser-stone-count 32 --verdict draw

Global options:
  --group GROUP_OR_CHATROOM
  --state PATH_TO_CHECKIN_STATE

Aliases:
  history        text + image history; images download and PNG conversion are enabled by default
  score-anchor   search same-day round/password text messages to help the agent choose score-scan start time
  score-scan     image paths + current-round pairing hints for manual score review; no OCR and no auto-write
                 normal flow: open every pngPaths item together, then write the same polling window with push-batch-scores
  build-ftd-map-draft hard-gated draft FTD/OQ map flow; refresh nicks, build local state, and output agent review material
  patch-ftd-map write deterministic additions found during agent review, or mark no deterministic additions
  validate-and-publish-ftd-map run one OQ validation pass, write local state, publish online, and verify remote stats
  resolve-ftd-players first prints the mandatory full-name Agent review packet without querying;
                      rerun with --names-reviewed only after manually checking every roster name,
                      then query the FTD Player library and write matches through /api/state
  update-round-oq-scores query OQ games and safely write unique current-round matches as ready
  rotate-image   create a rotated PNG for manual inspection; no OCR
  push-pending-score record an abnormal item in frontend pending without stopping polling
  push-ready-score write one manually reviewed result to the FTD table as yellow ready
  push-batch-scores write manually reviewed ready and pending items in one state update
  push-score      legacy fallback only; prefer push-batch-scores or push-ready-score for FTD rows
  images         scan image messages once
  watch-images   poll image messages
  checkin-history text-only legacy check-in history
"""
    )


def parse_globals(argv: list[str]) -> tuple[list[str], list[str], str]:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--group", default="")
    parser.add_argument("--state", default="")
    parser.add_argument("-h", "--help", action="store_true")
    known, rest = parser.parse_known_args(argv)
    if known.help or not rest:
        print_usage()
        return [], [], ""

    command = rest[0]
    tail = rest[1:]
    common = []
    if known.group:
        common.extend(["--group", known.group])
    if known.state:
        common.extend(["--state", known.state])
    return common, tail, command


def call_checkin(common: list[str], tail: list[str], command: str) -> int:
    checkin_common = []
    state_path = agent_match_image_helper.DEFAULT_FRONTEND_STATE_PATH
    index = 0
    while index < len(common):
        key = common[index]
        value = common[index + 1] if index + 1 < len(common) else ""
        if key == "--group":
            checkin_common.extend([key, value])
        elif key == "--state" and value:
            state_path = Path(value)
        index += 2
    cloud_pull = {}
    if command == "history":
        cloud_pull = agent_match_image_helper.map_collab_sync(
            "pull-to-local",
            state_path,
        )
        remote_sync = cloud_pull.get("remoteSync") if isinstance(cloud_pull.get("remoteSync"), dict) else {}
        if (
            cloud_pull.get("ok") is not True
            or cloud_pull.get("skipped") is True
            or not int(remote_sync.get("revision") or 0)
        ):
            print(
                json.dumps(
                    {
                        "ok": False,
                        "type": "map-collab-sync-before-checkin-history",
                        "error": "pull-to-local failed or did not report a remote revision; refusing to continue with possibly stale mapping state",
                        "cloudSync": cloud_pull,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 2
    rc = agent_checkin_bridge.main(checkin_common + [command] + tail)
    if command == "history":
        cloud_push = agent_match_image_helper.map_collab_sync(
            "push-nicks",
            state_path,
        )
        print(
            json.dumps(
                {
                    "ok": rc == 0,
                    "type": "map-collab-sync-around-checkin-history",
                    "cloudSync": {
                        "pullMappingBeforeHistory": cloud_pull,
                        "pushGroupNicksAfterHistory": cloud_push,
                    },
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    return rc


def call_match(common: list[str], tail: list[str], command: str) -> int:
    return agent_match_image_helper.main(common + [command] + tail)


def call_self_check(common: list[str], tail: list[str]) -> int:
    if not SELF_CHECK_SCRIPT.exists():
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "self-check script not found",
                    "path": str(SELF_CHECK_SCRIPT),
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 1
    group_args = []
    for index in range(0, len(common), 2):
        if common[index] == "--group" and index + 1 < len(common):
            group_args.extend(common[index : index + 2])
    completed = subprocess.run(
        ["node", str(SELF_CHECK_SCRIPT), *group_args, *tail],
        cwd=str(SELF_CHECK_SCRIPT.parent),
        text=True,
    )
    return int(completed.returncode or 0)


def call_resolve_ftd_players(tail: list[str]) -> int:
    if not RESOLVE_FTD_PLAYERS_SCRIPT.exists():
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "resolve-ftd-players implementation not found",
                    "path": str(RESOLVE_FTD_PLAYERS_SCRIPT),
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 1
    completed = subprocess.run(
        ["node", str(RESOLVE_FTD_PLAYERS_SCRIPT), *tail],
        cwd=str(ROOT),
        text=True,
        encoding="utf-8",
    )
    return int(completed.returncode or 0)


def main(argv: list[str] | None = None) -> int:
    common, tail, command = parse_globals(list(argv if argv is not None else sys.argv[1:]))
    if not command:
        return 0

    checkin_commands = {
        "refresh-map": "refresh-map",
        "list-groups": "list-groups",
        "checkin-status": "status",
        "checkin-history": "history",
    }
    match_commands = {
        "status": "status",
        "members": "members",
        "history": "chat-history",
        "chat-history": "chat-history",
        "images": "scan",
        "scan-images": "scan",
        "build-ftd-map-draft": "build-ftd-map-draft",
        "patch-ftd-map": "patch-ftd-map",
        "validate-and-publish-ftd-map": "validate-and-publish-ftd-map",
        "build-and-publish-ftd-map": "build-and-publish-ftd-map",
        "map-ftd-players": "map-ftd-players",
        "validate-oq-accounts": "validate-oq-accounts",
        "update-round-oq-scores": "update-round-oq-scores",
        "sync-checkedin-accounts": "sync-checkedin-accounts",
        "score-anchor": "score-anchor",
        "anchor": "score-anchor",
        "score-scan": "score-scan",
        "rotate-image": "rotate-image",
        "watch-images": "watch",
        "push-pending-score": "push-pending-score",
        "push-ready-score": "push-ready-score",
        "push-batch-scores": "push-batch-scores",
        "push-score": "push-score",
    }

    if command in checkin_commands:
        return call_checkin(common, tail, checkin_commands[command])
    if command == "self-check":
        return call_self_check(common, tail)
    if command == "resolve-ftd-players":
        return call_resolve_ftd_players(tail)
    if command in match_commands:
        return call_match(common, tail, match_commands[command])

    print(f"Unknown command: {command}")
    print_usage()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
