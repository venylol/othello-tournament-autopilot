#!/usr/bin/env python3
"""Assign deterministic off-book labels from audited Level22 game outputs."""

from __future__ import annotations

import argparse
import json
import math
import statistics
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
ALGORITHM_LABEL = "first-long-think-absolute-evaluation-cutoff-v1"
MIN_PLY = 5
MAX_PLY = 38
TIME_MULTIPLIER = 1.75
ABSOLUTE_EVALUATION_THRESHOLD = 6.0


def finite_number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be numeric")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{label} must be finite")
    return result


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


def detect_game(game: dict[str, Any], account: str) -> dict[str, Any]:
    game_id = str(game.get("gameId") or "")
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
        if MIN_PLY <= node["ply"] <= MAX_PLY
        and abs(node["bestEval"]) > ABSOLUTE_EVALUATION_THRESHOLD
    ), None)
    cutoff_ply = evaluation_cutoff["ply"] if evaluation_cutoff is not None else None

    history: list[float] = []
    time_anchor: dict[str, Any] | None = None
    for node in target_nodes:
        ply = node["ply"]
        eligible = (
            MIN_PLY <= ply <= MAX_PLY
            and (cutoff_ply is None or ply < cutoff_ply)
            and bool(history)
        )
        if eligible:
            prior_median = float(statistics.median(history))
            threshold = TIME_MULTIPLIER * prior_median
            if node["thinkingTimeMs"] > threshold:
                time_anchor = {
                    **node,
                    "anchorSource": (
                        "time_rule_before_evaluation_cutoff"
                        if cutoff_ply is not None
                        else "time_rule_without_evaluation_cutoff"
                    ),
                    "priorTimeMedianMs": prior_median,
                    "timeThresholdMs": threshold,
                    "priorObservationCount": len(history),
                    "timeRatio": None if prior_median == 0 else node["thinkingTimeMs"] / prior_median,
                }
                break
        history.append(node["thinkingTimeMs"])
        if cutoff_ply is not None and ply >= cutoff_ply:
            break

    if time_anchor is not None:
        anchor = time_anchor
    elif evaluation_cutoff is not None:
        anchor = {**evaluation_cutoff, "anchorSource": "absolute_evaluation_cutoff"}
    else:
        anchor = None

    return {
        "gameId": game_id,
        "targetColor": target_color,
        "judgment": "offbook" if anchor is not None else "no_offbook",
        "algorithmLabel": "offbook" if anchor is not None else "no_offbook",
        "labelSource": ALGORITHM_LABEL,
        "targetMoveCount": len(target_nodes),
        "offBookPly": anchor["ply"] if anchor is not None else None,
        "postOffBookStartsAtPly": anchor["ply"] if anchor is not None else None,
        "targetDecisionNumber": anchor["targetDecisionNumber"] if anchor is not None else None,
        "move": anchor["move"] if anchor is not None else None,
        "thinkingTimeMs": anchor["thinkingTimeMs"] if anchor is not None else None,
        "bestEval": anchor["bestEval"] if anchor is not None else None,
        "anchorSource": anchor["anchorSource"] if anchor is not None else None,
        "algorithmEvidence": {
            "noAnchorReason": (
                "target_player_has_no_placement"
                if not target_nodes
                else ("no_rule_matched_within_ply_5_38" if anchor is None else None)
            ),
            "time": ({
                "priorTimeMedianMs": time_anchor["priorTimeMedianMs"],
                "timeThresholdMs": time_anchor["timeThresholdMs"],
                "timeRatio": time_anchor["timeRatio"],
                "priorObservationCount": time_anchor["priorObservationCount"],
            } if time_anchor is not None else None),
            "evaluationCutoff": ({
                "ply": evaluation_cutoff["ply"],
                "bestEval": evaluation_cutoff["bestEval"],
                "absoluteBestEval": abs(evaluation_cutoff["bestEval"]),
                "comparison": ">",
                "threshold": ABSOLUTE_EVALUATION_THRESHOLD,
            } if evaluation_cutoff is not None else None),
        },
    }


def detect_all(engine_directory: Path, account: str) -> dict[str, Any]:
    audit_path = engine_directory / "audit.json"
    if not audit_path.is_file() or read_json(audit_path).get("ok") is not True:
        raise ValueError(f"Level22 audit is missing or unsuccessful: {audit_path}")
    games = load_engine_games(engine_directory)
    game_ids = [game["gameId"] for game in games]
    if any(not game_id for game_id in game_ids) or len(set(game_ids)) != len(game_ids):
        raise ValueError("Level22 games require unique non-empty game IDs")
    records = [detect_game(game, account) for game in games]
    records.sort(key=lambda row: row["gameId"])
    return {
        "schema": SCHEMA,
        "account": account,
        "mode": "target",
        "labeledBy": "algorithm",
        "algorithm": {
            "label": ALGORITHM_LABEL,
            "clipMinPlyInclusive": MIN_PLY,
            "capMaxPlyInclusive": MAX_PLY,
            "timeComparison": "thinkingTimeMs > 1.75 * median(all prior same-player placement times)",
            "evaluationComparison": "abs(bestEval) > 6.0",
            "evaluationThresholdIsStrict": True,
            "evaluationUsesLoss": False,
            "timeSearchEnd": "strictly before evaluation cutoff, or through cap when cutoff is absent",
            "anchorSelection": "earlier time anchor; otherwise evaluation cutoff; otherwise no_offbook",
        },
        "recordCount": len(records),
        "offBookRecordCount": sum(row["algorithmLabel"] == "offbook" for row in records),
        "noOffBookRecordCount": sum(row["algorithmLabel"] == "no_offbook" for row in records),
        "records": records,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine-directory", type=Path, required=True)
    parser.add_argument("--account", required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    output = args.output.resolve()
    if output.exists():
        raise FileExistsError(f"output already exists: {output}")
    value = detect_all(args.engine_directory.resolve(), args.account)
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
