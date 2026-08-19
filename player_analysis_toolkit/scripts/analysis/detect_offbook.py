#!/usr/bin/env python3
"""Assign deterministic off-book labels from audited Level22 game outputs."""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any


TOOLKIT_ROOT = Path(__file__).resolve().parents[2]
SRC_ROOT = TOOLKIT_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from player_analysis_toolkit.analysis_core import (  # noqa: E402
    account_key,
    load_engine_games,
    read_json,
    write_json,
)


SCHEMA = "player-offbook-algorithm-records-v1"
ALGORITHM_LABEL = "first-log-time-or-abs6-with-post-fast-v5"
MIN_PLY = 5
BASE_TIME_LIMIT_SECONDS = 300.0
BASE_TIME_THRESHOLD_MS = 5500.0
BASE_FAST_THRESHOLD_MS = 2000.0
POST_FAST_LOOKAHEAD_TARGET_MOVES = 4
POST_FAST_REJECT_STREAK = 3
ABSOLUTE_EVALUATION_THRESHOLD = 6.0


def finite_number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be numeric")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{label} must be finite")
    return result


def time_threshold_ms(time_limit_ms: Any) -> float:
    limit_ms = finite_number(time_limit_ms, "timeLimitMs")
    if limit_ms <= 0:
        raise ValueError("timeLimitMs must be positive")
    limit_seconds = limit_ms / 1000.0
    return BASE_TIME_THRESHOLD_MS * (
        math.log1p(limit_seconds) / math.log1p(BASE_TIME_LIMIT_SECONDS)
    )


def fast_threshold_ms(time_limit_ms: Any) -> float:
    limit_ms = finite_number(time_limit_ms, "timeLimitMs")
    if limit_ms <= 0:
        raise ValueError("timeLimitMs must be positive")
    limit_seconds = limit_ms / 1000.0
    return BASE_FAST_THRESHOLD_MS * (
        math.log1p(limit_seconds) / math.log1p(BASE_TIME_LIMIT_SECONDS)
    )


def target_color_from_game(game: dict[str, Any], account: str) -> str:
    target = account_key(account)
    matches = [
        color for color in ("black", "white")
        if account_key((game.get(color) or {}).get("account")) == target
    ]
    if len(matches) == 1:
        return matches[0]
    node_colors = {
        str(node.get("playerColor") or "").lower()
        for node in game.get("nodes", [])
        if account_key(node.get("playerAccount")) == target
    }
    if len(node_colors) == 1 and next(iter(node_colors)) in {"black", "white"}:
        return next(iter(node_colors))
    raise ValueError(f"game {game.get('gameId')!r} does not map account {account!r} to exactly one color")


def detect_game(game: dict[str, Any], account: str, time_limit_ms: Any) -> dict[str, Any]:
    game_id = str(game.get("gameId") or "")
    limit_ms = finite_number(time_limit_ms, f"game {game_id!r} timeLimitMs")
    threshold_ms = time_threshold_ms(limit_ms)
    quick_threshold_ms = fast_threshold_ms(limit_ms)
    nodes = game.get("nodes") if isinstance(game.get("nodes"), list) else []
    target_nodes: list[dict[str, Any]] = []
    target_color = target_color_from_game(game, account)

    for node in nodes:
        if account_key(node.get("playerAccount")) != account_key(account):
            continue
        ply_value = node.get("ply")
        if isinstance(ply_value, bool) or not isinstance(ply_value, (int, float)) or not float(ply_value).is_integer():
            raise ValueError(f"game {game_id!r} has an invalid target-player ply")
        ply = int(ply_value)
        thinking_time = finite_number(node.get("thinkingTimeMs"), f"game {game_id!r} ply {ply} thinkingTimeMs")
        if thinking_time < 0:
            raise ValueError(f"game {game_id!r} ply {ply} thinkingTimeMs must be nonnegative")
        best_eval = finite_number(node.get("bestEval"), f"game {game_id!r} ply {ply} bestEval")
        color = str(node.get("playerColor") or "").lower()
        if color not in {"black", "white"}:
            raise ValueError(f"game {game_id!r} ply {ply} has an invalid playerColor")
        if color != target_color:
            raise ValueError(f"game {game_id!r} target account changes color")
        target_nodes.append({
            "ply": ply,
            "move": node.get("move"),
            "thinkingTimeMs": thinking_time,
            "bestEval": best_eval,
            "targetDecisionNumber": len(target_nodes) + 1,
        })

    evaluation_cutoff = next((
        node for node in target_nodes
        if node["ply"] >= MIN_PLY
        and abs(node["bestEval"]) > ABSOLUTE_EVALUATION_THRESHOLD
    ), None)
    cutoff_ply = evaluation_cutoff["ply"] if evaluation_cutoff is not None else None

    time_candidates: list[dict[str, Any]] = []
    for node in target_nodes:
        ply = node["ply"]
        eligible = (
            ply >= MIN_PLY
            and (cutoff_ply is None or ply < cutoff_ply)
        )
        if eligible:
            if node["thinkingTimeMs"] > threshold_ms:
                time_candidates.append({
                    **node,
                    "anchorSource": (
                        "time_rule_before_evaluation_cutoff"
                        if cutoff_ply is not None
                        else "time_rule_without_evaluation_cutoff"
                    ),
                    "timeThresholdMs": threshold_ms,
                })
        if cutoff_ply is not None and ply >= cutoff_ply:
            break

    def post_fast_check(candidate: dict[str, Any]) -> dict[str, Any]:
        start = int(candidate["targetDecisionNumber"])
        following = target_nodes[start:start + POST_FAST_LOOKAHEAD_TARGET_MOVES]
        longest_streak = 0
        current_streak = 0
        moves: list[dict[str, Any]] = []
        for node in following:
            is_quick = node["thinkingTimeMs"] <= quick_threshold_ms
            current_streak = current_streak + 1 if is_quick else 0
            longest_streak = max(longest_streak, current_streak)
            moves.append({
                "ply": node["ply"],
                "targetDecisionNumber": node["targetDecisionNumber"],
                "thinkingTimeMs": node["thinkingTimeMs"],
                "isQuick": is_quick,
            })
        if len(following) < POST_FAST_REJECT_STREAK:
            status = "insufficient"
            accepted = True
        elif longest_streak >= POST_FAST_REJECT_STREAK:
            status = "rejected"
            accepted = False
        else:
            status = "passed"
            accepted = True
        return {
            "status": status,
            "accepted": accepted,
            "quickThresholdMs": quick_threshold_ms,
            "lookaheadTargetMoveLimit": POST_FAST_LOOKAHEAD_TARGET_MOVES,
            "rejectConsecutiveQuickMoves": POST_FAST_REJECT_STREAK,
            "observedTargetMoveCount": len(following),
            "longestConsecutiveQuickMoves": longest_streak,
            "moves": moves,
        }

    candidate_checks: list[dict[str, Any]] = []
    anchor: dict[str, Any] | None = None
    for candidate in time_candidates:
        check = post_fast_check(candidate)
        candidate_checks.append({
            "ply": candidate["ply"],
            "targetDecisionNumber": candidate["targetDecisionNumber"],
            "anchorSource": candidate["anchorSource"],
            "thinkingTimeMs": candidate["thinkingTimeMs"],
            "bestEval": candidate["bestEval"],
            "postFastCheck": check,
        })
        if check["accepted"]:
            anchor = {**candidate, "postFastCheck": check}
            break
    if anchor is None and evaluation_cutoff is not None:
        candidate = {**evaluation_cutoff, "anchorSource": "absolute_evaluation_cutoff"}
        check = post_fast_check(candidate)
        candidate_checks.append({
            "ply": candidate["ply"],
            "targetDecisionNumber": candidate["targetDecisionNumber"],
            "anchorSource": candidate["anchorSource"],
            "thinkingTimeMs": candidate["thinkingTimeMs"],
            "bestEval": candidate["bestEval"],
            "postFastCheck": check,
        })
        if check["accepted"]:
            anchor = {**candidate, "postFastCheck": check}

    return {
        "gameId": game_id,
        "targetColor": target_color,
        "judgment": "offbook" if anchor is not None else "no_offbook",
        "algorithmLabel": "offbook" if anchor is not None else "no_offbook",
        "labelSource": ALGORITHM_LABEL,
        "timeLimitMs": limit_ms,
        "timeThresholdMs": threshold_ms,
        "fastThresholdMs": quick_threshold_ms,
        "targetMoveCount": len(target_nodes),
        "offBookPly": anchor["ply"] if anchor is not None else None,
        "postOffBookStartsAtPly": anchor["ply"] if anchor is not None else None,
        "targetDecisionNumber": anchor["targetDecisionNumber"] if anchor is not None else None,
        "move": anchor["move"] if anchor is not None else None,
        "thinkingTimeMs": anchor["thinkingTimeMs"] if anchor is not None else None,
        "bestEval": anchor["bestEval"] if anchor is not None else None,
        "anchorSource": anchor["anchorSource"] if anchor is not None else None,
        "postFastCheck": anchor["postFastCheck"] if anchor is not None else None,
        "algorithmEvidence": {
            "noAnchorReason": (
                "target_player_has_no_placement"
                if not target_nodes
                else (
                    "no_time_threshold_or_abs6_match_from_ply_5"
                    if not time_candidates and evaluation_cutoff is None
                    else ("all_candidates_rejected_by_post_fast_check" if anchor is None else None)
                )
            ),
            "time": ({
                "timeThresholdMs": anchor["timeThresholdMs"],
            } if anchor is not None and anchor["anchorSource"].startswith("time_rule") else None),
            "postFastPolicy": {
                "baseFastThresholdMsAt300Seconds": BASE_FAST_THRESHOLD_MS,
                "quickComparison": "thinkingTimeMs <= dynamic quick threshold",
                "lookaheadTargetMoveLimit": POST_FAST_LOOKAHEAD_TARGET_MOVES,
                "rejectConsecutiveQuickMoves": POST_FAST_REJECT_STREAK,
                "insufficientFollowingMovesAcceptsCandidate": True,
            },
            "candidateChecks": candidate_checks,
            "rejectedCandidates": [
                item for item in candidate_checks
                if item["postFastCheck"]["status"] == "rejected"
            ],
            "evaluationCutoff": ({
                "ply": evaluation_cutoff["ply"],
                "bestEval": evaluation_cutoff["bestEval"],
                "absoluteBestEval": abs(evaluation_cutoff["bestEval"]),
                "comparison": ">",
                "threshold": ABSOLUTE_EVALUATION_THRESHOLD,
            } if evaluation_cutoff is not None else None),
        },
    }


def detect_all(engine_directory: Path, bundle_path: Path, account: str) -> dict[str, Any]:
    audit_path = engine_directory / "audit.json"
    if not audit_path.is_file() or read_json(audit_path).get("ok") is not True:
        raise ValueError(f"Level22 audit is missing or unsuccessful: {audit_path}")
    games = load_engine_games(engine_directory)
    game_ids = [game["gameId"] for game in games]
    if any(not game_id for game_id in game_ids) or len(set(game_ids)) != len(game_ids):
        raise ValueError("Level22 games require unique non-empty game IDs")
    bundle = read_json(bundle_path)
    details = bundle.get("details") if isinstance(bundle.get("details"), list) else []
    time_limits: dict[str, Any] = {}
    for detail in details:
        if not isinstance(detail, dict):
            continue
        game_id = str(detail.get("id") or "")
        if not game_id or game_id in time_limits:
            raise ValueError("source bundle requires unique non-empty game IDs")
        time_limits[game_id] = detail.get("tcb")
    missing_time_limits = sorted(set(game_ids) - set(time_limits))
    if missing_time_limits:
        raise ValueError(f"source bundle is missing Level22 game IDs: {missing_time_limits}")
    records = [detect_game(game, account, time_limits[game["gameId"]]) for game in games]
    records.sort(key=lambda row: row["gameId"])
    return {
        "schema": SCHEMA,
        "account": account,
        "mode": "target",
        "labeledBy": "algorithm",
        "algorithm": {
            "label": ALGORITHM_LABEL,
            "clipMinPlyInclusive": MIN_PLY,
            "capMaxPlyInclusive": None,
            "timeComparison": (
                "first target-player placement with thinkingTimeMs greater than "
                "5500 * ln(1 + timeLimitSeconds) / ln(301)"
            ),
            "baseTimeLimitSeconds": BASE_TIME_LIMIT_SECONDS,
            "baseTimeThresholdMs": BASE_TIME_THRESHOLD_MS,
            "baseFastThresholdMs": BASE_FAST_THRESHOLD_MS,
            "postFastLookaheadTargetMoves": POST_FAST_LOOKAHEAD_TARGET_MOVES,
            "postFastRejectConsecutiveQuickMoves": POST_FAST_REJECT_STREAK,
            "evaluationComparison": "first target-player placement with abs(bestEval) > 6.0",
            "evaluationThresholdIsStrict": True,
            "evaluationUsesLoss": False,
            "timeSearchEnd": "strictly before the first abs(bestEval) > 6.0 node, or through game end when absent",
            "anchorSelection": (
                "first time candidate passing post-fast validation before evaluation cutoff; "
                "otherwise evaluation cutoff if it passes; otherwise no_offbook"
            ),
        },
        "recordCount": len(records),
        "offBookRecordCount": sum(row["algorithmLabel"] == "offbook" for row in records),
        "noOffBookRecordCount": sum(row["algorithmLabel"] == "no_offbook" for row in records),
        "records": records,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine-directory", type=Path, required=True)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--account", required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    output = args.output.resolve()
    if output.exists():
        raise FileExistsError(f"output already exists: {output}")
    value = detect_all(args.engine_directory.resolve(), args.bundle.resolve(), args.account)
    write_json(output, value)
    print(json.dumps({
        "schema": value["schema"],
        "recordCount": value["recordCount"],
        "offBookRecordCount": value["offBookRecordCount"],
        "noOffBookRecordCount": value["noOffBookRecordCount"],
        "output": str(output),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
