from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

from analysis_core import (
    account_key,
    aggregate_loss_games,
    book_lookup,
    build_personal_book,
    bundle_games,
    game_players,
    load_engine_games,
    mean,
    read_json,
    replay_game,
    rounded,
    target_engine_games,
    target_side,
    write_json,
)


def file_sha256(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_new_json(path: str | Path, value: Any) -> None:
    target = Path(path)
    if target.exists():
        raise FileExistsError(f"output already exists; choose a new path: {target}")
    write_json(target, value)


def packet_game(
    detail: dict[str, Any],
    details: list[dict[str, Any]],
    account: str,
    mode: str,
    excluded_from_book: set[str],
    max_ply: int,
) -> dict[str, Any]:
    game_id = str(detail.get("id") or "")
    color = target_side(detail, account)
    if color is None:
        raise ValueError(f"game {game_id!r} does not contain target account {account!r}")
    players = game_players(detail)
    target = account_key(account)
    records = replay_game(detail, max_ply=max_ply)
    lookup: dict[tuple[int, str], int] = {}
    book: dict[str, Any] | None = None
    if mode == "target":
        book = build_personal_book(
            details,
            account,
            color,
            excluded_from_book | {game_id},
            max_ply,
        )
        lookup = book_lookup(book)

    target_decision = 0
    plies: list[dict[str, Any]] = []
    for record in records:
        is_target = account_key(record["playerAccount"]) == target
        decision_number = None
        if is_target:
            target_decision += 1
            decision_number = target_decision
        item: dict[str, Any] = {
            "ply": int(record["ply"]),
            "sourceMoveIndex": int(record["sourceMoveIndex"]),
            "move": record["move"],
            "playerColor": record["playerColor"],
            "playerAccount": record["playerAccount"],
            "isTargetMove": is_target,
            "targetDecisionNumber": decision_number,
            "thinkingTimeMs": record.get("thinkingTimeMs"),
            "eligibleForManualOffBookMark": is_target,
        }
        if mode == "target":
            ply = int(record["ply"])
            parent_count = lookup.get((ply - 1, str(record["parentKey"])), 0)
            result_count = lookup.get((ply, str(record["childKey"])), 0)
            item["frequencyBook"] = {
                "available": True,
                "parentNode": [record["parentKey"], parent_count, ply - 1],
                "resultNode": [record["childKey"], result_count, ply],
                "parentChildRatio": rounded(result_count / parent_count) if parent_count else None,
            }
        plies.append(item)

    opponent_index = 1 if color == "black" else 0
    game: dict[str, Any] = {
        "gameId": game_id,
        "created": detail.get("created"),
        "targetColor": color,
        "opponentAccount": players[opponent_index].get("id"),
        "actualMoveCount": len(records),
        "targetMoveCount": target_decision,
        "eligibleOffBookPlies": [item["ply"] for item in plies if item["isTargetMove"]],
        "plies": plies,
    }
    if book is not None:
        game["frequencyBookPolicy"] = {
            "available": True,
            "color": color,
            "sameColorLeaveOneOut": True,
            "sourceGameCount": book["sourceGameCount"],
            "sourceGameIds": book["sourceGameIds"],
            "globallyExcludedGameIds": sorted(excluded_from_book),
        }
    else:
        game["frequencyBookPolicy"] = {
            "available": False,
            "reason": "reference player packets are reviewed from raw per-ply thinking time only",
        }
    return game


def build_review_packet(
    bundle: dict[str, Any],
    account: str,
    mode: str,
    game_ids: set[str] | None = None,
    excluded_from_book: set[str] | None = None,
    max_ply: int = 60,
) -> dict[str, Any]:
    if mode not in {"target", "reference"}:
        raise ValueError("mode must be target or reference")
    if max_ply < 1:
        raise ValueError("max_ply must be at least 1")
    if mode == "reference" and excluded_from_book:
        raise ValueError("reference mode has no Frequency Book, so book exclusions are not applicable")
    details = bundle_games(bundle)
    all_ids = {str(detail.get("id") or "") for detail in details}
    selected_ids = set(game_ids or [])
    if selected_ids:
        missing = sorted(selected_ids - all_ids)
        if missing:
            raise ValueError(f"game IDs not found in bundle: {missing}")
    selected = [
        detail for detail in details
        if target_side(detail, account) is not None
        and (not selected_ids or str(detail.get("id") or "") in selected_ids)
    ]
    selected_target_ids = {str(detail.get("id") or "") for detail in selected}
    wrong_account = sorted(selected_ids - selected_target_ids)
    if wrong_account:
        raise ValueError(f"game IDs do not contain target account {account!r}: {wrong_account}")
    if not selected:
        raise ValueError(f"no bundle games contain target account {account!r}")
    excluded = set(excluded_from_book or [])
    games = [
        packet_game(detail, details, account, mode, excluded, max_ply)
        for detail in sorted(selected, key=lambda item: (str(item.get("created") or ""), str(item.get("id") or "")))
    ]
    return {
        "schema": "player-offbook-agent-review-packet-v1",
        "account": account,
        "mode": mode,
        "gameCount": len(games),
        "maxPlyInclusive": max_ply,
        "thinkingTimePolicy": (
            "thinkingTimeMs is the original OQ position.moves[*].t value without transformation; "
            "manual review must treat per-ply thinking time and within-game continuity as the primary evidence"
        ),
        "manualReviewPolicy": {
            "agentJudgmentRequired": True,
            "automaticOffBookMarking": False,
            "thinkingTimeIsPrimaryEvidence": True,
            "reviewTimeContinuityBeforeAndAfterCandidate": True,
            "fixedTimeThresholdProhibited": True,
            "frequencyBookIsWeakReferenceOnly": True,
            "frequencyBookMissAloneCannotSetAnchor": True,
            "engineLossIsSupportingContextOnly": True,
            "noConfidentTimeTransitionMeansNoOffBook": True,
            "agentNoteRequired": True,
            "oneDecisionRequiredPerGame": True,
            "offBookPlyMustBeTargetMove": True,
            "postOffBookIncludesMarkedMove": True,
        },
        "marksInputExample": {
            "schema": "player-offbook-agent-marks-input-v1",
            "account": account,
            "mode": mode,
            "reviewedBy": "agent",
            "marks": [
                {
                    "gameId": "replace-with-game-id",
                    "judgment": "offbook",
                    "offBookPly": "replace-with-target-player-ply",
                    "agentNote": "manual judgment note",
                },
                {
                    "gameId": "replace-with-another-game-id",
                    "judgment": "no_offbook",
                    "offBookPly": None,
                    "agentNote": "manual judgment note",
                },
            ],
        },
        "games": games,
    }


def validate_manual_marks(packet: dict[str, Any], marks_input: dict[str, Any]) -> dict[str, Any]:
    if packet.get("schema") != "player-offbook-agent-review-packet-v1":
        raise ValueError("packet has an unsupported schema")
    if marks_input.get("schema") != "player-offbook-agent-marks-input-v1":
        raise ValueError("marks input has an unsupported schema")
    if account_key(packet.get("account")) != account_key(marks_input.get("account")):
        raise ValueError("packet and marks input accounts do not match")
    if packet.get("mode") != marks_input.get("mode"):
        raise ValueError("packet and marks input modes do not match")
    if account_key(marks_input.get("reviewedBy")) != "agent":
        raise ValueError("reviewedBy must be agent; automatic or unreviewed marks are not accepted")
    raw_marks = marks_input.get("marks")
    if not isinstance(raw_marks, list):
        raise ValueError("marks input must contain a marks array")
    games = {str(game.get("gameId") or ""): game for game in packet.get("games", []) if isinstance(game, dict)}
    marks_by_id: dict[str, dict[str, Any]] = {}
    for raw in raw_marks:
        if not isinstance(raw, dict):
            raise ValueError("every manual mark must be an object")
        game_id = str(raw.get("gameId") or "")
        if game_id not in games:
            raise ValueError(f"manual mark refers to a game outside the packet: {game_id!r}")
        if game_id in marks_by_id:
            raise ValueError(f"game {game_id!r} has more than one manual mark")
        marks_by_id[game_id] = raw
    missing = sorted(set(games) - set(marks_by_id))
    if missing:
        raise ValueError(f"every packet game requires an Agent decision; missing: {missing}")

    records: list[dict[str, Any]] = []
    for game_id, game in games.items():
        mark = marks_by_id[game_id]
        judgment = str(mark.get("judgment") or "").strip()
        if judgment not in {"offbook", "no_offbook"}:
            raise ValueError(f"game {game_id!r} judgment must be offbook or no_offbook")
        offbook_ply = mark.get("offBookPly")
        selected_ply: dict[str, Any] | None = None
        if judgment == "offbook":
            if isinstance(offbook_ply, bool) or not isinstance(offbook_ply, int):
                raise ValueError(f"game {game_id!r} offbook judgment requires an integer offBookPly")
            selected_ply = next((item for item in game["plies"] if item["ply"] == offbook_ply), None)
            if selected_ply is None:
                raise ValueError(f"game {game_id!r} has no actual move at ply {offbook_ply}")
            if not selected_ply["isTargetMove"]:
                raise ValueError(f"game {game_id!r} ply {offbook_ply} belongs to the opponent")
            if selected_ply["playerColor"] != game["targetColor"]:
                raise ValueError(
                    f"game {game_id!r} ply {offbook_ply} color {selected_ply['playerColor']} "
                    f"does not match target color {game['targetColor']}"
                )
        elif offbook_ply is not None:
            raise ValueError(f"game {game_id!r} no_offbook judgment requires null offBookPly")
        agent_note = str(mark.get("agentNote") or "").strip()
        if not agent_note:
            raise ValueError(f"game {game_id!r} requires a non-empty agentNote")
        record = {
            "gameId": game_id,
            "targetColor": game["targetColor"],
            "judgment": judgment,
            "offBookPly": offbook_ply,
            "postOffBookStartsAtPly": offbook_ply,
            "targetDecisionNumber": selected_ply.get("targetDecisionNumber") if selected_ply else None,
            "move": selected_ply.get("move") if selected_ply else None,
            "thinkingTimeMs": selected_ply.get("thinkingTimeMs") if selected_ply else None,
            "frequencyBook": selected_ply.get("frequencyBook") if selected_ply else None,
            "agentNote": agent_note,
        }
        records.append(record)
    return {
        "schema": "player-offbook-manual-records-v1",
        "account": packet["account"],
        "mode": packet["mode"],
        "reviewedBy": "agent",
        "sourcePacketSha256": marks_input.get("sourcePacketSha256"),
        "manualReviewPolicy": packet["manualReviewPolicy"],
        "recordCount": len(records),
        "offBookRecordCount": sum(record["judgment"] == "offbook" for record in records),
        "noOffBookRecordCount": sum(record["judgment"] == "no_offbook" for record in records),
        "records": records,
    }


def raw_time_game_summary(game: dict[str, Any]) -> dict[str, Any]:
    values = [float(node["thinkingTimeMs"]) for node in game["nodes"] if node.get("thinkingTimeMs") is not None]
    return {
        "gameId": game["gameId"],
        "round": game.get("round"),
        "color": game.get("color"),
        "moveCount": len(values),
        "totalTimeMs": rounded(sum(values), 3),
        "meanTimeMs": rounded(mean(values), 3),
        "minimumTimeMs": rounded(min(values), 3) if values else None,
        "maximumTimeMs": rounded(max(values), 3) if values else None,
    }


def aggregate_raw_time(games: list[dict[str, Any]]) -> dict[str, Any]:
    per_game = [raw_time_game_summary(game) for game in games]
    values = [float(node["thinkingTimeMs"]) for game in games for node in game["nodes"] if node.get("thinkingTimeMs") is not None]
    game_means = [float(item["meanTimeMs"]) for item in per_game if item["meanTimeMs"] is not None]
    return {
        "gameCount": len(games),
        "moveCount": len(values),
        "gameWeightedMeanTimeMs": rounded(mean(game_means), 3),
        "moveWeightedMeanTimeMs": rounded(mean(values), 3),
        "totalTimeMs": rounded(sum(values), 3),
        "games": per_game,
    }


def segment_member(member: dict[str, Any], expected_mode: str) -> dict[str, Any]:
    marks_path = Path(member["marks"]).resolve()
    engine_directory = Path(member["engineDirectory"]).resolve()
    account = str(member["account"])
    marks = read_json(marks_path)
    if marks.get("schema") != "player-offbook-manual-records-v1":
        raise ValueError(f"unsupported manual records schema in {marks_path}")
    if marks.get("mode") != expected_mode:
        raise ValueError(f"manual records in {marks_path} must use mode {expected_mode!r}")
    if account_key(marks.get("reviewedBy")) != "agent":
        raise ValueError(f"manual records in {marks_path} were not recorded as Agent-reviewed")
    if account_key(marks.get("account")) != account_key(account):
        raise ValueError(f"manual records account does not match configured account {account!r}")
    records = {str(item.get("gameId") or ""): item for item in marks.get("records", []) if isinstance(item, dict)}
    engine_games = target_engine_games(load_engine_games(engine_directory), account)
    by_id = {game["gameId"]: game for game in engine_games}
    missing = sorted(set(records) - set(by_id))
    if missing:
        raise ValueError(f"manual-record games missing from EG JSON for {account!r}: {missing}")
    full_games = [by_id[game_id] for game_id in records]
    post_games: list[dict[str, Any]] = []
    for game_id, record in records.items():
        if record.get("judgment") != "offbook":
            continue
        start = int(record["offBookPly"])
        source = by_id[game_id]
        nodes = [node for node in source["nodes"] if int(node.get("ply") or 0) >= start]
        if not nodes:
            raise ValueError(f"game {game_id!r} has no target EG nodes at or after offBookPly {start}")
        post_games.append({**source, "nodes": nodes, "offBookPly": start})
    return {
        "name": str(member.get("name") or account),
        "account": account,
        "marks": str(marks_path),
        "engineDirectory": str(engine_directory),
        "recordCount": len(records),
        "offBookGameCount": len(post_games),
        "noOffBookGameCount": sum(item.get("judgment") == "no_offbook" for item in records.values()),
        "fullGames": full_games,
        "postGames": post_games,
    }


def public_segment(member_segments: list[dict[str, Any]]) -> dict[str, Any]:
    full_games = [game for member in member_segments for game in member["fullGames"]]
    post_games = [game for member in member_segments for game in member["postGames"]]
    return {
        "memberCount": len(member_segments),
        "members": [
            {
                key: member[key]
                for key in ("name", "account", "marks", "engineDirectory", "recordCount", "offBookGameCount", "noOffBookGameCount")
            }
            for member in member_segments
        ],
        "fullGame": {
            "loss": aggregate_loss_games(full_games),
            "time": aggregate_raw_time(full_games),
        },
        "postOffBookInclusive": {
            "loss": aggregate_loss_games(post_games),
            "time": aggregate_raw_time(post_games),
        },
    }


def group_members(config: dict[str, Any], label: str) -> list[dict[str, Any]]:
    raw = config.get("members")
    members = raw if isinstance(raw, list) else [config]
    if not members or any(not isinstance(member, dict) for member in members):
        raise ValueError(f"{label} must contain a member object or members array")
    return members


def difference(left: dict[str, Any], right: dict[str, Any], field: str) -> float | None:
    left_value = left.get(field)
    right_value = right.get(field)
    if left_value is None or right_value is None:
        return None
    return rounded(float(left_value) - float(right_value), 6)


def offbook_stats(config: dict[str, Any]) -> dict[str, Any]:
    target_config = config.get("target")
    if not isinstance(target_config, dict):
        raise ValueError("stats config requires a target object")
    target_segments = [segment_member(member, "target") for member in group_members(target_config, "target")]
    target = public_segment(target_segments)
    references: dict[str, Any] = {}
    comparisons: dict[str, Any] = {}
    raw_references = config.get("references", [])
    if not isinstance(raw_references, list):
        raise ValueError("stats config references must be an array")
    for index, group in enumerate(raw_references):
        if not isinstance(group, dict):
            raise ValueError("every reference group must be an object")
        name = str(group.get("name") or f"reference-{index + 1}")
        segments = [segment_member(member, "reference") for member in group_members(group, name)]
        reference = public_segment(segments)
        references[name] = reference
        target_loss = target["postOffBookInclusive"]["loss"]
        reference_loss = reference["postOffBookInclusive"]["loss"]
        target_time = target["postOffBookInclusive"]["time"]
        reference_time = reference["postOffBookInclusive"]["time"]
        comparisons[name] = {
            "targetMinusReferencePostOffBookGameWeightedMeanLoss": difference(target_loss, reference_loss, "gameWeightedMeanLoss"),
            "targetMinusReferencePostOffBookMoveWeightedMeanLoss": difference(target_loss, reference_loss, "moveWeightedMeanLoss"),
            "targetMinusReferencePostOffBookGameWeightedMeanTimeMs": difference(target_time, reference_time, "gameWeightedMeanTimeMs"),
            "targetMinusReferencePostOffBookMoveWeightedMeanTimeMs": difference(target_time, reference_time, "moveWeightedMeanTimeMs"),
        }
    return {
        "schema": "player-offbook-segment-stats-v1",
        "segmentPolicy": "post-off-book begins at and includes the Agent-marked target-player move",
        "manualMarkPolicy": "all segment boundaries come from validated Agent manual records; no boundary is inferred by this script",
        "target": target,
        "references": references,
        "comparisons": comparisons,
    }


def command_packet(args: argparse.Namespace) -> dict[str, Any]:
    bundle_path = Path(args.bundle).resolve()
    value = build_review_packet(
        read_json(bundle_path),
        args.account,
        args.mode,
        set(args.game_id or []),
        set(args.exclude_from_book_game_id or []),
        args.max_ply,
    )
    value["sourceBundle"] = str(bundle_path)
    value["sourceBundleSha256"] = file_sha256(bundle_path)
    write_new_json(args.output, value)
    return {key: value[key] for key in ("schema", "account", "mode", "gameCount", "sourceBundle")}


def command_record(args: argparse.Namespace) -> dict[str, Any]:
    packet_path = Path(args.packet).resolve()
    marks_path = Path(args.marks).resolve()
    packet = read_json(packet_path)
    marks = read_json(marks_path)
    expected_hash = marks.get("sourcePacketSha256")
    actual_hash = file_sha256(packet_path)
    if expected_hash and expected_hash != actual_hash:
        raise ValueError("marks input sourcePacketSha256 does not match the review packet")
    value = validate_manual_marks(packet, marks)
    value["sourcePacket"] = str(packet_path)
    value["sourcePacketSha256"] = actual_hash
    value["sourceMarksInput"] = str(marks_path)
    value["sourceMarksInputSha256"] = file_sha256(marks_path)
    write_new_json(args.output, value)
    return {
        key: value[key]
        for key in ("schema", "account", "mode", "recordCount", "offBookRecordCount", "noOffBookRecordCount")
    }


def command_stats(args: argparse.Namespace) -> dict[str, Any]:
    config_path = Path(args.config).resolve()
    value = offbook_stats(read_json(config_path))
    value["sourceConfig"] = str(config_path)
    value["sourceConfigSha256"] = file_sha256(config_path)
    write_new_json(args.output, value)
    return {
        "schema": value["schema"],
        "targetPostOffBookGameCount": value["target"]["postOffBookInclusive"]["loss"]["gameCount"],
        "referenceGroups": list(value["references"]),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Agent-manual off-book review and post-off-book statistics")
    sub = parser.add_subparsers(dest="command", required=True)

    packet = sub.add_parser("offbook-packet", help="build a per-ply packet without marking off-book positions")
    packet.add_argument("--bundle", required=True)
    packet.add_argument("--account", required=True)
    packet.add_argument("--mode", choices=("target", "reference"), required=True)
    packet.add_argument("--game-id", action="append", default=[])
    packet.add_argument("--exclude-from-book-game-id", action="append", default=[])
    packet.add_argument("--max-ply", type=int, default=60)
    packet.add_argument("--output", required=True)
    packet.set_defaults(handler=command_packet)

    record = sub.add_parser("offbook-record", help="validate and record Agent manual off-book decisions")
    record.add_argument("--packet", required=True)
    record.add_argument("--marks", required=True)
    record.add_argument("--output", required=True)
    record.set_defaults(handler=command_record)

    stats = sub.add_parser("offbook-stats", help="calculate full-game and inclusive post-off-book statistics")
    stats.add_argument("--config", required=True)
    stats.add_argument("--output", required=True)
    stats.set_defaults(handler=command_stats)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    result = args.handler(args)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
