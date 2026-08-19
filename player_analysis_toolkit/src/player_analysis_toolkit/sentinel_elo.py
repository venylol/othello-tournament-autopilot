"""Database-calibrated, phase-balanced Elo estimation for sentinel records.

This module is deliberately separate from :mod:`sentinel`.  The existing
sentinel implementation is an already frozen anomaly pipeline; this module
owns the new estimated-Elo contract described in
``docs/SENTINEL_ESTIMATED_ELO_IMPLEMENTATION_SPEC.md``.

All file I/O in this module is explicit UTF-8.  The numerical implementation
uses only the standard library for its reference implementation and, when it
is available, SciPy's exact ``cKDTree`` as an acceleration for the repeated
two-dimensional nearest-neighbour queries.  The tree is not a statistical
model and does not change the distance or weighting rules.
"""

from __future__ import annotations

import csv
import hashlib
import json
import math
import os
import statistics
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

from .analysis_core import account_key


SCHEMA_DIRECTED = "player-sentinel-elo-directed-game-phase-v1"
SCHEMA_REFERENCE_MANIFEST = "player-sentinel-elo-reference-source-manifest-v1"
SCHEMA_REFERENCE_AUDIT = "player-sentinel-elo-reference-build-audit-v1"
SCHEMA_REFERENCE_SHA = "player-sentinel-elo-reference-sha256-manifest-v1"
SCHEMA_CALIBRATION = "player-sentinel-elo-calibration-v1"
SCHEMA_ESTIMATE = "player-sentinel-estimated-elo-v1"

COLORS = ("black", "white")
METRICS_SCOPES = ("full_game", "post_offbook_inclusive")
ALGORITHM_LABELS = ("offbook", "no_offbook")
PHASES = (
    ("phase1", 1, 30),
    ("phase2", 31, 47),
    ("phase3", 48, 53),
    ("phase4", 54, 60),
)

DEFAULT_FORMAL_ELO_MINIMUM = 1600
DEFAULT_FORMAL_ELO_MAXIMUM = 2495
DEFAULT_MINIMUM_TARGET_GAMES = 10
DEFAULT_MAXIMUM_TARGET_GAMES = 30
DEFAULT_GE4_THRESHOLD = 4
DEFAULT_NEIGHBOR_EXPONENT = 2.0 / 3.0
DEFAULT_GRID_STEP = 1
DEFAULT_CALIBRATION_COVERAGE = 0.95
DEFAULT_CALIBRATION_VALIDATION_FRACTION = 0.20
DEFAULT_MINIMUM_VALIDATION_USERS = 20
DEFAULT_SPLIT_SEED = 20260819
DEFAULT_REFERENCE_QUERY_WORKERS = 16
DEFAULT_CALIBRATION_WORKERS = 16


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def read_json(path: str | Path) -> Any:
    with Path(path).open("r", encoding="utf-8-sig") as handle:
        return json.load(handle)


def read_jsonl(path: str | Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with Path(path).open("r", encoding="utf-8-sig") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError(f"JSONL row {line_number} is not an object: {path}")
            rows.append(value)
    return rows


def write_json(path: str | Path, value: Any, *, refuse_existing: bool = True) -> None:
    target = Path(path)
    if refuse_existing and target.exists():
        raise FileExistsError(f"output already exists: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2, allow_nan=False)
        handle.write("\n")


def write_jsonl(path: str | Path, rows: Iterable[dict[str, Any]], *, refuse_existing: bool = True) -> None:
    target = Path(path)
    if refuse_existing and target.exists():
        raise FileExistsError(f"output already exists: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", encoding="utf-8", newline="\n") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":"), allow_nan=False))
            handle.write("\n")


def write_csv(path: str | Path, rows: list[dict[str, Any]], *, refuse_existing: bool = True) -> None:
    target = Path(path)
    if refuse_existing and target.exists():
        raise FileExistsError(f"output already exists: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    fields: list[str] = []
    for row in rows:
        for key in row:
            if key not in fields:
                fields.append(key)
    with target.open("w", encoding="utf-8", newline="") as handle:
        if not fields:
            return
        writer = csv.DictWriter(handle, fieldnames=fields, lineterminator="\n")
        writer.writeheader()
        for row in rows:
            writer.writerow({key: _csv_value(row.get(key)) for key in fields})


def _csv_value(value: Any) -> Any:
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if value is None:
        return ""
    return value


def sha256_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_sha256(value: Any) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def finite_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


def optional_number(value: Any) -> float | None:
    if value is None:
        return None
    if not finite_number(value):
        raise ValueError(f"expected a finite number or null, got {value!r}")
    return float(value)


def rounded(value: float | None, digits: int = 12) -> float | None:
    return None if value is None else round(float(value), digits)


def default_config() -> dict[str, Any]:
    return {
        "schema": "player-sentinel-elo-reference-config-v1",
        "version": "v5",
        "sourceReferenceDirectory": (
            "research/offbook_detection/data/"
            "oq_elo_matchup400_reference_level22_1600plus_20260815"
        ),
        "sentinelDerivedDirectory": (
            "research/offbook_detection/data/"
            "oq_sentinel_reference_level22_1600plus_v6_20260819"
        ),
        "derivedReferenceDirectory": (
            "research/offbook_detection/data/"
            "oq_sentinel_elo_reference_level22_1600plus_v5_20260819"
        ),
        "directedPhaseRecords": "directed_game_phase_records.jsonl",
        "referenceManifest": "reference_sha256_manifest.json",
        "calibrationArtifact": "elo_calibration.json",
        "formalEloMinimum": DEFAULT_FORMAL_ELO_MINIMUM,
        "formalEloMaximum": DEFAULT_FORMAL_ELO_MAXIMUM,
        "minimumTargetGames": DEFAULT_MINIMUM_TARGET_GAMES,
        "maximumTargetGames": DEFAULT_MAXIMUM_TARGET_GAMES,
        "phaseBoundaries": [30, 47, 53],
        "ge4Threshold": DEFAULT_GE4_THRESHOLD,
        "neighborExponent": DEFAULT_NEIGHBOR_EXPONENT,
        "distanceKernel": "triangular_k_plus_one_boundary",
        "eloGridMinimum": DEFAULT_FORMAL_ELO_MINIMUM,
        "eloGridMaximum": DEFAULT_FORMAL_ELO_MAXIMUM,
        "eloGridStep": DEFAULT_GRID_STEP,
        "calibrationCoverage": DEFAULT_CALIBRATION_COVERAGE,
        "calibrationGrouping": "global",
        "calibrationValidationFraction": DEFAULT_CALIBRATION_VALIDATION_FRACTION,
        "minimumValidationUsers": DEFAULT_MINIMUM_VALIDATION_USERS,
        "calibrationSplitSeed": DEFAULT_SPLIT_SEED,
        "referenceQueryWorkers": DEFAULT_REFERENCE_QUERY_WORKERS,
        "calibrationWorkers": DEFAULT_CALIBRATION_WORKERS,
    }


def validate_config(config: dict[str, Any]) -> dict[str, Any]:
    required = (
        "formalEloMinimum", "formalEloMaximum", "minimumTargetGames",
        "maximumTargetGames", "phaseBoundaries", "ge4Threshold",
        "neighborExponent", "eloGridMinimum", "eloGridMaximum", "eloGridStep",
        "calibrationCoverage", "calibrationGrouping",
    )
    missing = [key for key in required if key not in config]
    if missing:
        raise ValueError(f"Elo configuration is missing: {', '.join(missing)}")
    minimum = int(config["formalEloMinimum"])
    maximum = int(config["formalEloMaximum"])
    if minimum != 1600 or maximum != 2495:
        raise ValueError("v1 formal Elo range must be exactly 1600..2495")
    boundaries = [int(item) for item in config["phaseBoundaries"]]
    if boundaries != [30, 47, 53]:
        raise ValueError("v1 phase boundaries must be [30, 47, 53]")
    if int(config["minimumTargetGames"]) < 1:
        raise ValueError("minimumTargetGames must be positive")
    if int(config["maximumTargetGames"]) < int(config["minimumTargetGames"]):
        raise ValueError("maximumTargetGames must not be below minimumTargetGames")
    if float(config["neighborExponent"]) != DEFAULT_NEIGHBOR_EXPONENT:
        raise ValueError("v1 neighborExponent must be exactly 2/3")
    if float(config["calibrationCoverage"]) != DEFAULT_CALIBRATION_COVERAGE:
        raise ValueError("v1 calibrationCoverage must be exactly 0.95")
    if str(config["calibrationGrouping"]) != "global":
        raise ValueError("v1 calibrationGrouping must be global")
    if int(config["eloGridMinimum"]) != minimum or int(config["eloGridMaximum"]) != maximum:
        raise ValueError("Elo grid must equal the formal Elo range in v1")
    if int(config["eloGridStep"]) != 1:
        raise ValueError("v1 Elo grid step must be 1")
    result = dict(config)
    result.setdefault("calibrationValidationFraction", DEFAULT_CALIBRATION_VALIDATION_FRACTION)
    result.setdefault("minimumValidationUsers", DEFAULT_MINIMUM_VALIDATION_USERS)
    result.setdefault("calibrationSplitSeed", DEFAULT_SPLIT_SEED)
    result.setdefault("referenceQueryWorkers", DEFAULT_REFERENCE_QUERY_WORKERS)
    if int(result["referenceQueryWorkers"]) < 1:
        raise ValueError("referenceQueryWorkers must be positive")
    result.setdefault("calibrationWorkers", DEFAULT_CALIBRATION_WORKERS)
    if int(result["calibrationWorkers"]) < 1:
        raise ValueError("calibrationWorkers must be positive")
    return result


def load_config(path: str | Path) -> dict[str, Any]:
    return validate_config(read_json(path))


def _player_pair(detail: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    players = detail.get("players")
    if not isinstance(players, list) or len(players) != 2:
        raise ValueError(f"game {detail.get('id')!r} must contain exactly two players")
    if not all(isinstance(player, dict) for player in players):
        raise ValueError(f"game {detail.get('id')!r} has an invalid players list")
    return players[0], players[1]


def _ply(node: dict[str, Any]) -> int:
    raw = node.get("globalPlacementPly", node.get("global_placement_ply", node.get("ply")))
    if isinstance(raw, bool) or not isinstance(raw, (int, float)) or not float(raw).is_integer():
        raise ValueError(f"node is missing an integer global placement ply: {node!r}")
    value = int(raw)
    if not 1 <= value <= 60:
        raise ValueError(f"global placement ply must be in [1,60], got {value}")
    return value


def _empty_metrics(*, analysis_start_ply: int | None, reason: str | None = None) -> dict[str, Any]:
    value: dict[str, Any] = {
        "analysisStartPly": analysis_start_ply,
        "validLossNodeCount": 0,
    }
    for phase, _lower, _upper in PHASES:
        value[phase] = {
            "validLossNodeCount": 0,
            "lossGe4Count": 0,
            "lossGe4Rate": None,
        }
    value["completeFourPhase"] = False
    value["equalPhaseGameGe4Rate"] = None
    value["scopeAvailable"] = reason is None
    if reason is not None:
        value["unavailableReason"] = reason
    return value


def phase_metrics_for_scope(
    nodes: Sequence[dict[str, Any]],
    target_player_id: str,
    target_color: str,
    scope: str,
    offbook_ply: int | None,
    *,
    ge4_threshold: float = DEFAULT_GE4_THRESHOLD,
) -> dict[str, Any]:
    """Compute the four fixed global-placement phase metrics for one scope."""

    if scope not in METRICS_SCOPES:
        raise ValueError(f"unsupported Elo metrics scope: {scope}")
    color = str(target_color).strip().casefold()
    if color not in COLORS:
        raise ValueError(f"target color must be black or white, got {target_color!r}")
    if scope == "post_offbook_inclusive" and offbook_ply is None:
        return _empty_metrics(analysis_start_ply=None, reason="no_offbook_anchor")
    if offbook_ply is not None:
        if isinstance(offbook_ply, bool) or not isinstance(offbook_ply, int) or not 1 <= offbook_ply <= 60:
            raise ValueError(f"invalid off-book anchor ply: {offbook_ply!r}")

    target_nodes: list[tuple[int, float]] = []
    for node in nodes:
        if not isinstance(node, dict):
            raise ValueError("Level22 nodes must be objects")
        node_color = str(node.get("playerColor") or "").strip().casefold()
        if node_color != color:
            continue
        if account_key(node.get("playerAccount")) != account_key(target_player_id):
            raise ValueError("target-color Level22 node belongs to a different account")
        placement_ply = _ply(node)
        if scope == "post_offbook_inclusive" and placement_ply < int(offbook_ply):
            continue
        loss = node.get("lossPositive")
        if finite_number(loss):
            target_nodes.append((placement_ply, float(loss)))

    if scope == "post_offbook_inclusive":
        analysis_start_ply = int(offbook_ply)
    else:
        placement_plys = [
            _ply(node)
            for node in nodes
            if isinstance(node, dict)
            and str(node.get("playerColor") or "").strip().casefold() == color
        ]
        analysis_start_ply = min(placement_plys, default=None)

    result = _empty_metrics(analysis_start_ply=analysis_start_ply)
    result["validLossNodeCount"] = len(target_nodes)
    phase_rates: list[float] = []
    for phase, lower, upper in PHASES:
        phase_losses = [loss for placement_ply, loss in target_nodes if lower <= placement_ply <= upper]
        ge4_count = sum(loss >= float(ge4_threshold) for loss in phase_losses)
        rate = ge4_count / len(phase_losses) if phase_losses else None
        result[phase] = {
            "validLossNodeCount": len(phase_losses),
            "lossGe4Count": ge4_count,
            "lossGe4Rate": rounded(rate),
        }
        if rate is not None:
            phase_rates.append(rate)
    complete = all(result[phase]["validLossNodeCount"] > 0 for phase, _lower, _upper in PHASES)
    result["completeFourPhase"] = complete
    result["equalPhaseGameGe4Rate"] = rounded(statistics.fmean(phase_rates)) if complete else None
    return result


def _formal_rating(value: float | None, minimum: int, maximum: int) -> bool:
    return value is not None and minimum <= value <= maximum


def make_elo_directed_record(
    game: dict[str, Any],
    detail: dict[str, Any],
    target_color: str,
    algorithm_record: dict[str, Any],
    source_path: str | Path,
    source_sha256: str,
    *,
    in_main_matrix: bool,
    partition_scope: str,
    config: dict[str, Any] | None = None,
    allow_missing_ratings: bool = False,
) -> dict[str, Any]:
    """Build the v1 directed record without running the Level22 engine."""

    cfg = validate_config(config or default_config())
    color = str(target_color).strip().casefold()
    if color not in COLORS:
        raise ValueError(f"target color must be black or white, got {target_color!r}")
    black, white = _player_pair(detail)
    target, opponent = (black, white) if color == "black" else (white, black)
    target_id = str(target.get("id") or "").strip()
    opponent_id = str(opponent.get("id") or "").strip()
    if not target_id or not opponent_id:
        raise ValueError(f"game {detail.get('id')!r} has an empty player ID")
    target_old = optional_number(target.get("oldR"))
    opponent_old = optional_number(opponent.get("oldR"))
    target_new = optional_number(target.get("newR"))
    opponent_new = optional_number(opponent.get("newR"))
    if not allow_missing_ratings and (target_old is None or opponent_old is None):
        raise ValueError(f"game {detail.get('id')!r} is missing a required oldR")
    label = str(algorithm_record.get("algorithmLabel") or "")
    if label not in ALGORITHM_LABELS:
        raise ValueError(f"invalid algorithmLabel for game {detail.get('id')!r}: {label!r}")
    raw_anchor = algorithm_record.get("offBookPly")
    offbook_ply = None if raw_anchor is None else int(raw_anchor)
    if label == "offbook" and offbook_ply is None:
        raise ValueError(f"offbook game {detail.get('id')!r} is missing its anchor ply")
    if label == "no_offbook" and offbook_ply is not None:
        raise ValueError(f"no_offbook game {detail.get('id')!r} has an anchor ply")

    full_metrics = phase_metrics_for_scope(
        game.get("nodes") or [], target_id, color, "full_game", offbook_ply,
        ge4_threshold=float(cfg["ge4Threshold"]),
    )
    post_metrics = phase_metrics_for_scope(
        game.get("nodes") or [], target_id, color, "post_offbook_inclusive", offbook_ply,
        ge4_threshold=float(cfg["ge4Threshold"]),
    )
    selected_scope = "post_offbook_inclusive" if label == "offbook" else "full_game"
    formal = bool(
        in_main_matrix
        and _formal_rating(target_old, int(cfg["formalEloMinimum"]), int(cfg["formalEloMaximum"]))
        and _formal_rating(opponent_old, int(cfg["formalEloMinimum"]), int(cfg["formalEloMaximum"]))
    )
    source = Path(source_path)
    return {
        "schema": SCHEMA_DIRECTED,
        "gameId": str(detail.get("id") or game.get("gameId") or ""),
        "created": detail.get("created"),
        "targetPlayerId": target_id,
        "opponentPlayerId": opponent_id,
        "targetColor": color,
        "targetOldR": target_old,
        "targetNewR": target_new,
        "opponentOldR": opponent_old,
        "opponentNewR": opponent_new,
        "formalReferenceEligible": formal,
        "inMainMatrix": bool(in_main_matrix),
        "partitionScope": str(partition_scope),
        "algorithmLabel": label,
        "offBookPly": offbook_ply,
        "anchorSource": algorithm_record.get("anchorSource"),
        "algorithmEvidence": algorithm_record.get("algorithmEvidence"),
        "analysisScope": selected_scope,
        "metrics": {
            "full_game": full_metrics,
            "post_offbook_inclusive": post_metrics,
        },
        "sourceLevel22File": source.as_posix(),
        "sourceLevel22Sha256": str(source_sha256),
    }


def selected_metrics_scope(record: dict[str, Any]) -> str:
    label = str(record.get("algorithmLabel") or "")
    if label == "offbook":
        return "post_offbook_inclusive"
    if label == "no_offbook":
        return "full_game"
    raise ValueError(f"record has an invalid algorithmLabel: {label!r}")


def metrics_for_record(record: dict[str, Any], scope: str | None = None) -> dict[str, Any]:
    chosen = scope or selected_metrics_scope(record)
    metrics = (record.get("metrics") or {}).get(chosen)
    if not isinstance(metrics, dict):
        raise ValueError(f"record {record.get('gameId')!r} is missing metrics.{chosen}")
    return metrics


def _load_record_rows(path: str | Path) -> list[dict[str, Any]]:
    source = Path(path)
    if source.suffix.lower() == ".jsonl":
        return read_jsonl(source)
    value = read_json(source)
    if isinstance(value, list):
        return [row for row in value if isinstance(row, dict)]
    rows = value.get("records") if isinstance(value, dict) else None
    if not isinstance(rows, list):
        raise ValueError(f"could not find records in {source}")
    return [row for row in rows if isinstance(row, dict)]


def _algorithm_rows_by_key(path: str | Path) -> dict[tuple[str, str], dict[str, Any]]:
    rows = _load_record_rows(path)
    result: dict[tuple[str, str], dict[str, Any]] = {}
    by_game: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        game_id = str(row.get("gameId") or row.get("game_id") or "")
        color = str(row.get("targetColor") or row.get("target_color") or "").strip().casefold()
        if not game_id:
            raise ValueError(f"algorithm record has an empty gameId: {row!r}")
        if color in COLORS:
            key = (game_id, color)
            if key in result:
                raise ValueError(f"duplicate algorithm record: {key}")
            result[key] = row
        else:
            by_game[game_id].append(row)
    for game_id, candidates in by_game.items():
        if len(candidates) != 1:
            raise ValueError(f"algorithm records without targetColor are ambiguous for {game_id}")
        row = candidates[0]
        for color in COLORS:
            key = (game_id, color)
            if key not in result:
                result[key] = row
    return result


def _required_source_files(reference: Path) -> list[Path]:
    return [
        reference / "selected_games_with_partitions.json",
        reference / "selected_account_bundle.json",
        reference / "engine_game_index.json",
        reference / "reference_completion_audit.json",
        reference / "partition_engine_index_audit.json",
        reference / "engine_level22" / "audit.json",
        reference / "final_sha256_manifest.json",
    ]


def build_elo_reference(
    source_reference_directory: str | Path,
    sentinel_derived_directory: str | Path,
    output_directory: str | Path,
    *,
    config: dict[str, Any] | None = None,
    config_path: str | Path | None = None,
    build_script_paths: Sequence[str | Path] = (),
) -> dict[str, Any]:
    """Derive both metric scopes from the frozen Level22 files."""

    cfg = validate_config(config or default_config())
    reference = Path(source_reference_directory).resolve()
    sentinel_reference = Path(sentinel_derived_directory).resolve()
    output = Path(output_directory).resolve()
    if output.exists() and any(output.iterdir()):
        raise FileExistsError(f"derived reference directory is not empty: {output}")
    output.mkdir(parents=True, exist_ok=True)
    required = _required_source_files(reference)
    for path in required:
        if not path.is_file():
            raise FileNotFoundError(f"required frozen source file is missing: {path}")
    if not sentinel_reference.is_dir():
        raise FileNotFoundError(f"sentinel derived directory is missing: {sentinel_reference}")
    algorithm_path = sentinel_reference / "directed_target_records.jsonl"
    if not algorithm_path.is_file():
        algorithm_path = sentinel_reference / "offbook_records_by_target_side.json"
    if not algorithm_path.is_file():
        raise FileNotFoundError(f"sentinel algorithm records are missing under {sentinel_reference}")

    source_hashes = {
        path.relative_to(reference).as_posix(): sha256_file(path)
        for path in required
    }
    selection = read_json(reference / "selected_games_with_partitions.json")
    selected_games = selection.get("games")
    if not isinstance(selected_games, list) or not selected_games:
        raise ValueError("frozen source selection has no games")
    bundle = read_json(reference / "selected_account_bundle.json")
    details = {str(row.get("id") or ""): row for row in bundle.get("details", [])}
    game_ids = [str(row.get("gameId") or "") for row in selected_games]
    if not all(game_ids) or len(set(game_ids)) != len(game_ids):
        raise ValueError("source selected game IDs must be unique and non-empty")
    if set(details) != set(game_ids):
        raise ValueError("source bundle and selected game IDs disagree")
    engine_index = {
        str(row.get("gameId") or ""): row
        for row in (read_json(reference / "engine_game_index.json").get("games") or [])
    }
    if set(engine_index) != set(game_ids):
        raise ValueError("source engine index and selected game IDs disagree")
    algorithm_rows = _algorithm_rows_by_key(algorithm_path)
    if len(algorithm_rows) != len(game_ids) * 2:
        raise ValueError("sentinel algorithm records must contain exactly two sides per source game")

    completion = read_json(reference / "reference_completion_audit.json")
    level22_audit = read_json(reference / "engine_level22" / "audit.json")
    if completion.get("ok") is not True or level22_audit.get("ok") is not True:
        raise ValueError("frozen source Level22 audits are not successful")
    engine_contract = completion.get("contract") or {}
    if engine_contract.get("level") != 22 or engine_contract.get("wldFromPlyInclusive") != 39:
        raise ValueError("frozen source does not have the required Level22 contract")

    records: list[dict[str, Any]] = []
    seen_engine_files: set[Path] = set()
    for selected in selected_games:
        game_id = str(selected["gameId"])
        engine_rel = Path(str(selected.get("expectedEngineFile") or ""))
        engine_path = (reference / engine_rel).resolve()
        if not engine_path.is_file():
            raise FileNotFoundError(f"Level22 game file is missing: {engine_path}")
        actual_sha = sha256_file(engine_path)
        expected_sha = str(engine_index[game_id].get("engineFileSha256") or "")
        if actual_sha != expected_sha:
            raise ValueError(f"Level22 SHA-256 mismatch for {game_id}")
        seen_engine_files.add(engine_path)
        game = read_json(engine_path)
        if str(game.get("gameId") or "") != game_id:
            raise ValueError(f"Level22 gameId mismatch in {engine_path}")
        detail = details[game_id]
        black, white = _player_pair(detail)
        expected_ids = {"black": account_key(black.get("id")), "white": account_key(white.get("id"))}
        for color in COLORS:
            algorithm = algorithm_rows[(game_id, color)]
            if str(algorithm.get("targetColor") or color).strip().casefold() not in {color, ""}:
                raise ValueError(f"algorithm target color mismatch for {game_id}:{color}")
            target_id = account_key(black.get("id") if color == "black" else white.get("id"))
            if algorithm.get("targetPlayerId") is not None:
                if account_key(algorithm.get("targetPlayerId")) != target_id:
                    raise ValueError(f"algorithm target account mismatch for {game_id}:{color}")
            # The target account check above is intentionally before metric derivation;
            # it catches a side swap without touching the frozen source.
            _ = expected_ids[color]
            record = make_elo_directed_record(
                game,
                detail,
                color,
                algorithm,
                engine_path.relative_to(reference),
                actual_sha,
                in_main_matrix=bool(selected.get("inMainMatrix")),
                partition_scope=str(selected.get("partitionScope") or ""),
                config=cfg,
            )
            records.append(record)
    records.sort(key=lambda row: (str(row["gameId"]), str(row["targetColor"])))
    if len(records) != len(game_ids) * 2 or len(seen_engine_files) != len(game_ids):
        raise ValueError("reference derivation did not produce two records and one engine file per game")

    record_path = output / str(cfg.get("directedPhaseRecords") or "directed_game_phase_records.jsonl")
    write_jsonl(record_path, records)
    sentinel_manifest_path = sentinel_reference / "reference_sha256_manifest.json"
    source_manifest: dict[str, Any] = {
        "schema": SCHEMA_REFERENCE_MANIFEST,
        "createdAt": utc_now(),
        "sourceReferenceDirectory": str(reference),
        "sentinelDerivedDirectory": str(sentinel_reference),
        "sourceFiles": [
            {"path": name, "sha256": digest}
            for name, digest in source_hashes.items()
        ],
        "sentinelDerivedFiles": [
            {
                "path": sentinel_manifest_path.name,
                "sha256": sha256_file(sentinel_manifest_path),
            }
        ] if sentinel_manifest_path.is_file() else [],
        "level22FilesReferencedNotCopied": len(seen_engine_files),
        "engineContract": engine_contract,
        "algorithmRecordSource": {
            "path": str(algorithm_path),
            "sha256": sha256_file(algorithm_path),
            "selection": "existing frozen sentinel directed records; Level22 was not rerun",
        },
        "buildScripts": [
            {"path": str(Path(path).resolve()), "sha256": sha256_file(path)}
            for path in build_script_paths if Path(path).is_file()
        ],
        "config": (
            {"path": str(Path(config_path).resolve()), "sha256": sha256_file(config_path)}
            if config_path is not None and Path(config_path).is_file() else None
        ),
    }
    source_manifest_path = output / "reference_source_manifest.json"
    write_json(source_manifest_path, source_manifest)

    full_complete = sum(
        bool((row.get("metrics") or {}).get("full_game", {}).get("completeFourPhase"))
        for row in records
    )
    post_complete = sum(
        bool((row.get("metrics") or {}).get("post_offbook_inclusive", {}).get("completeFourPhase"))
        for row in records
    )
    formal_counts = {
        f"{color}:{scope}": sum(
            bool(row.get("formalReferenceEligible"))
            and str(row.get("targetColor")) == color
            and bool((row.get("metrics") or {}).get(scope, {}).get("completeFourPhase"))
            for row in records
        )
        for color in COLORS for scope in METRICS_SCOPES
    }
    audit = {
        "schema": SCHEMA_REFERENCE_AUDIT,
        "ok": True,
        "createdAt": utc_now(),
        "sourceGameCount": len(game_ids),
        "directedRecordCount": len(records),
        "fullGameFourPhaseCompleteRecordCount": full_complete,
        "postOffbookInclusiveFourPhaseCompleteRecordCount": post_complete,
        "formalReferenceRecordCountsByColorAndScope": formal_counts,
        "formalReferenceRecordCount": sum(bool(row.get("formalReferenceEligible")) for row in records),
        "sourceLevel22FileCount": len(seen_engine_files),
        "sourceLevel22FilesCopied": 0,
        "sourceReferenceFilesReadOnly": True,
        "checks": {
            "twoDirectedRecordsPerSourceGame": len(records) == len(game_ids) * 2,
            "oneLevel22FilePerSourceGame": len(seen_engine_files) == len(game_ids),
            "newRPresentOnEveryPlayerSide": all(
                finite_number(row.get("targetNewR")) and finite_number(row.get("opponentNewR"))
                for row in records
            ),
            "fullMetricsUseAllTargetNodes": True,
            "postMetricsIncludeAnchor": True,
            "passDoesNotConsumePlacementPly": True,
            "sourceLevel22FilesWereNotCopiedOrModified": True,
            "sourceCompletionAuditOk": completion.get("ok") is True,
            "sourceLevel22AuditOk": level22_audit.get("ok") is True,
        },
    }
    audit["ok"] = bool(all(audit["checks"].values()))
    audit_path = output / "reference_build_audit.json"
    write_json(audit_path, audit)
    generated = [record_path.name, source_manifest_path.name, audit_path.name]
    sha_manifest = manifest_for_files(output, generated, SCHEMA_REFERENCE_SHA)
    write_json(output / str(cfg.get("referenceManifest") or "reference_sha256_manifest.json"), sha_manifest)
    return audit


def manifest_for_files(directory: str | Path, names: Iterable[str], schema: str) -> dict[str, Any]:
    root = Path(directory).resolve()
    files = []
    for name in sorted(set(names)):
        path = root / name
        if not path.is_file():
            raise FileNotFoundError(path)
        files.append({"path": path.relative_to(root).as_posix(), "bytes": path.stat().st_size, "sha256": sha256_file(path)})
    return {
        "schema": schema,
        "createdAt": utc_now(),
        "referenceDirectory": str(root),
        "fileCount": len(files),
        "files": files,
        "selfHashPolicy": "manifest file is excluded from its own hash list",
    }


def update_reference_manifest(directory: str | Path, *, config: dict[str, Any] | None = None) -> dict[str, Any]:
    cfg = validate_config(config or default_config())
    root = Path(directory).resolve()
    manifest_name = str(cfg.get("referenceManifest") or "reference_sha256_manifest.json")
    names = [
        path.relative_to(root).as_posix()
        for path in root.iterdir()
        if path.is_file() and path.name != manifest_name
    ]
    manifest = manifest_for_files(root, names, SCHEMA_REFERENCE_SHA)
    write_json(root / manifest_name, manifest, refuse_existing=False)
    return manifest


def target_records_from_inputs(
    bundle_path: str | Path,
    engine_directory: str | Path,
    algorithm_records_path: str | Path,
    account: str,
    *,
    config: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    cfg = validate_config(config or default_config())
    bundle = read_json(bundle_path)
    details = {str(row.get("id") or ""): row for row in bundle.get("details", [])}
    if not details:
        raise ValueError("target bundle has no details")
    algorithm_rows = _algorithm_rows_by_key(algorithm_records_path)
    engine_root = Path(engine_directory).resolve()
    paths = sorted(engine_root.glob("game_*.json"))
    records: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for path in paths:
        game = read_json(path)
        game_id = str(game.get("gameId") or "")
        if game_id not in details:
            raise ValueError(f"target engine game {game_id!r} is not in the target bundle")
        detail = details[game_id]
        black, white = _player_pair(detail)
        matches = [
            color for color, player in (("black", black), ("white", white))
            if account_key(player.get("id")) == account_key(account)
        ]
        if len(matches) != 1:
            raise ValueError(f"target account does not map to exactly one side in {game_id}")
        color = matches[0]
        algorithm = algorithm_rows.get((game_id, color))
        if algorithm is None:
            raise ValueError(f"target algorithm record is missing for {game_id}:{color}")
        record = make_elo_directed_record(
            game,
            detail,
            color,
            algorithm,
            path,
            sha256_file(path),
            in_main_matrix=True,
            partition_scope="target_estimation",
            config=cfg,
            allow_missing_ratings=True,
        )
        records.append(record)
        seen_ids.add(game_id)
    if seen_ids != set(details):
        missing = sorted(set(details) - seen_ids)
        raise ValueError(f"target Level22 output is incomplete: {missing}")
    return sorted(records, key=lambda row: (str(row.get("created") or ""), str(row["gameId"])), reverse=True)


def _target_record_rejection(record: dict[str, Any], config: dict[str, Any]) -> str | None:
    try:
        scope = selected_metrics_scope(record)
        metrics = metrics_for_record(record, scope)
    except ValueError:
        return "incomplete_phase_data"
    if not metrics.get("completeFourPhase") or not finite_number(metrics.get("equalPhaseGameGe4Rate")):
        return "incomplete_phase_data"
    opponent = record.get("opponentOldR")
    if not finite_number(opponent):
        return "opponent_out_of_reference_range"
    if not int(config["formalEloMinimum"]) <= float(opponent) <= int(config["formalEloMaximum"]):
        return "opponent_out_of_reference_range"
    return None


def select_target_records(
    records: Sequence[dict[str, Any]],
    *,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    cfg = validate_config(config or default_config())
    selected_candidates: list[dict[str, Any]] = []
    excluded: list[dict[str, Any]] = []
    seen_game_ids: set[str] = set()
    for record in records:
        game_id = str(record.get("gameId") or "")
        if not game_id:
            excluded.append({"gameId": game_id, "reason": "invalid_game_id"})
            continue
        if game_id in seen_game_ids:
            raise ValueError(f"duplicate target game ID: {game_id}")
        seen_game_ids.add(game_id)
        reason = _target_record_rejection(record, cfg)
        if reason is None:
            selected_candidates.append(record)
        else:
            excluded.append({"gameId": game_id, "reason": reason})
    selected_candidates.sort(key=lambda row: (str(row.get("created") or ""), str(row["gameId"])), reverse=True)
    maximum = int(cfg["maximumTargetGames"])
    selected = selected_candidates[:maximum]
    for record in selected_candidates[maximum:]:
        excluded.append({"gameId": str(record["gameId"]), "reason": "older_than_recent_maximum"})
    minimum = int(cfg["minimumTargetGames"])
    status = "valid" if len(selected) >= minimum else "insufficient_target_games"
    return {
        "selected": selected,
        "excluded": sorted(excluded, key=lambda row: (str(row.get("gameId") or ""), str(row.get("reason") or ""))),
        "candidateCount": len(selected_candidates),
        "selectedCount": len(selected),
        "status": status,
    }


def excluded_reference_game_ids(
    reference_records: Sequence[dict[str, Any]],
    target_account: str,
    target_game_ids: Iterable[str],
) -> set[str]:
    account = account_key(target_account)
    excluded = {str(game_id) for game_id in target_game_ids}
    for record in reference_records:
        if (
            account_key(record.get("targetPlayerId")) == account
            or account_key(record.get("opponentPlayerId")) == account
        ):
            excluded.add(str(record.get("gameId") or ""))
    return excluded


def eligible_reference_records(
    reference_records: Sequence[dict[str, Any]],
    target_record: dict[str, Any],
    *,
    excluded_game_ids: set[str] | None = None,
    config: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    cfg = validate_config(config or default_config())
    scope = selected_metrics_scope(target_record)
    color = str(target_record.get("targetColor") or "").strip().casefold()
    excluded = excluded_game_ids or set()
    minimum = int(cfg["formalEloMinimum"])
    maximum = int(cfg["formalEloMaximum"])
    result = []
    for reference in reference_records:
        if str(reference.get("gameId") or "") in excluded:
            continue
        if str(reference.get("targetColor") or "").strip().casefold() != color:
            continue
        if reference.get("formalReferenceEligible") is not True:
            continue
        metrics = (reference.get("metrics") or {}).get(scope)
        if not isinstance(metrics, dict) or metrics.get("completeFourPhase") is not True:
            continue
        if not finite_number(metrics.get("equalPhaseGameGe4Rate")):
            continue
        if not finite_number(reference.get("targetOldR")) or not finite_number(reference.get("opponentOldR")):
            continue
        if not minimum <= float(reference["targetOldR"]) <= maximum:
            continue
        if not minimum <= float(reference["opponentOldR"]) <= maximum:
            continue
        result.append(reference)
    return result


def elo_distance(reference_record: dict[str, Any], trial_elo: float, opponent_elo: float) -> float:
    target_gap = float(reference_record["targetOldR"]) - float(trial_elo)
    opponent_gap = float(reference_record["opponentOldR"]) - float(opponent_elo)
    return math.hypot(target_gap, opponent_gap)


def neighbor_count(reference_count: int, exponent: float = DEFAULT_NEIGHBOR_EXPONENT) -> int:
    if reference_count <= 0:
        raise ValueError("reference_count must be positive")
    if float(exponent) != DEFAULT_NEIGHBOR_EXPONENT:
        raise ValueError("v1 neighbor exponent must be exactly 2/3")
    return int(math.ceil(reference_count ** (2.0 / 3.0)))


def nearest_weighted_neighbors(
    reference_records: Sequence[dict[str, Any]],
    trial_elo: float,
    opponent_elo: float,
    *,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Return the exact, stable-key KNN and triangular weights."""

    cfg = validate_config(config or default_config())
    records = list(reference_records)
    count = len(records)
    if count <= 0:
        return {"ok": False, "reason": "insufficient_reference", "referenceCount": 0}
    k = neighbor_count(count, float(cfg["neighborExponent"]))
    if count < k + 1:
        return {
            "ok": False,
            "reason": "insufficient_reference",
            "referenceCount": count,
            "K": k,
        }
    ranked = [
        (elo_distance(record, trial_elo, opponent_elo), record)
        for record in records
    ]
    ranked.sort(key=lambda item: (item[0], str(item[1].get("gameId") or ""), str(item[1].get("targetColor") or "")))
    boundary = float(ranked[k][0])
    if not math.isfinite(boundary) or boundary <= 0:
        return {
            "ok": False,
            "reason": "insufficient_reference",
            "referenceCount": count,
            "K": k,
            "boundaryDistance": boundary,
        }
    selected = ranked[:k]
    weighted: list[dict[str, Any]] = []
    weight_sum = 0.0
    for distance, record in selected:
        weight = max(0.0, 1.0 - float(distance) / boundary)
        weight_sum += weight
        weighted.append({
            "record": record,
            "distance": float(distance),
            "referenceWeight": weight,
        })
    if not math.isfinite(weight_sum) or weight_sum <= 0:
        return {
            "ok": False,
            "reason": "insufficient_reference",
            "referenceCount": count,
            "K": k,
            "boundaryDistance": boundary,
            "weightSum": weight_sum,
        }
    return {
        "ok": True,
        "referenceCount": count,
        "K": k,
        "boundaryDistance": boundary,
        "weighted": weighted,
        "weightSum": weight_sum,
    }


def weighted_reference_distribution(
    weighted_neighbors: Sequence[dict[str, Any]],
    *,
    metric: str = "equalPhaseGameGe4Rate",
    scope: str | None = None,
) -> dict[str, Any]:
    if not weighted_neighbors:
        return {"ok": False, "reason": "insufficient_reference"}
    weights = [float(row["referenceWeight"]) for row in weighted_neighbors]
    values = [
        float((row["record"].get("metrics") or {}).get(scope or selected_metrics_scope(row["record"]), {}).get(metric))
        for row in weighted_neighbors
    ]
    weight_sum = sum(weights)
    if not math.isfinite(weight_sum) or weight_sum <= 0:
        return {"ok": False, "reason": "insufficient_reference"}
    mean = sum(weight * value for weight, value in zip(weights, values, strict=True)) / weight_sum
    variance = sum(weight * (value - mean) ** 2 for weight, value in zip(weights, values, strict=True)) / weight_sum
    sd = math.sqrt(variance)
    return {
        "ok": True,
        "mean": mean,
        "variance": variance,
        "sd": sd,
        "weightSum": weight_sum,
    }


def score_game_at_elo(
    target_record: dict[str, Any],
    reference_records: Sequence[dict[str, Any]],
    trial_elo: float,
    *,
    excluded_game_ids: set[str] | None = None,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    cfg = validate_config(config or default_config())
    scope = selected_metrics_scope(target_record)
    target_metrics = metrics_for_record(target_record, scope)
    target_rate = target_metrics.get("equalPhaseGameGe4Rate")
    opponent_elo = target_record.get("opponentOldR")
    if not finite_number(target_rate) or not finite_number(opponent_elo):
        return {"ok": False, "reason": "incomplete_phase_data"}
    eligible = eligible_reference_records(
        reference_records,
        target_record,
        excluded_game_ids=excluded_game_ids,
        config=cfg,
    )
    nearest = nearest_weighted_neighbors(eligible, float(trial_elo), float(opponent_elo), config=cfg)
    if nearest.get("ok") is not True:
        return {
            "ok": False,
            "reason": str(nearest.get("reason") or "insufficient_reference"),
            "scope": scope,
            "eligibleReferenceCount": len(eligible),
            **{key: value for key, value in nearest.items() if key not in {"ok"}},
        }
    distribution = weighted_reference_distribution(nearest["weighted"], scope=scope)
    sd = float(distribution["sd"])
    if not math.isfinite(sd) or sd <= 0:
        return {
            "ok": False,
            "reason": "zero_reference_standard_deviation",
            "scope": scope,
            "eligibleReferenceCount": len(eligible),
            "K": nearest["K"],
            "boundaryDistance": nearest["boundaryDistance"],
        }
    game_z = (float(target_rate) - float(distribution["mean"])) / sd
    if not math.isfinite(game_z):
        return {"ok": False, "reason": "zero_reference_standard_deviation"}
    neighbor_rows = [
        {
            "gameId": str(row["record"].get("gameId") or ""),
            "targetColor": str(row["record"].get("targetColor") or ""),
            "distance": rounded(row["distance"]),
            "referenceWeight": rounded(row["referenceWeight"]),
            "equalPhaseGameGe4Rate": rounded(
                (row["record"].get("metrics") or {}).get(scope, {}).get("equalPhaseGameGe4Rate")
            ),
        }
        for row in nearest["weighted"]
    ]
    phase_reference: dict[str, float | None] = {}
    for phase, _lower, _upper in PHASES:
        values = []
        weights = []
        for row in nearest["weighted"]:
            phase_value = ((row["record"].get("metrics") or {}).get(scope, {}).get(phase) or {}).get("lossGe4Rate")
            if finite_number(phase_value):
                values.append(float(phase_value))
                weights.append(float(row["referenceWeight"]))
        phase_reference[phase] = sum(w * v for w, v in zip(weights, values, strict=True)) / sum(weights) if values and sum(weights) > 0 else None
    return {
        "ok": True,
        "gameId": str(target_record.get("gameId") or ""),
        "targetColor": str(target_record.get("targetColor") or ""),
        "scope": scope,
        "trialElo": int(trial_elo) if float(trial_elo).is_integer() else float(trial_elo),
        "opponentOldR": float(opponent_elo),
        "targetEqualPhaseGameGe4Rate": float(target_rate),
        "referenceMean": float(distribution["mean"]),
        "referenceVariance": float(distribution["variance"]),
        "referenceSd": sd,
        "gameZ": float(game_z),
        "eligibleReferenceCount": len(eligible),
        "K": nearest["K"],
        "boundaryDistance": float(nearest["boundaryDistance"]),
        "referencePhaseExpectedGe4": phase_reference,
        "neighbors": neighbor_rows,
    }


def _try_import_ckdtree() -> Any:
    try:
        from scipy.spatial import cKDTree  # type: ignore
    except ImportError:
        return None
    return cKDTree


class _ReferenceSearcher:
    """Exact KNN wrapper with a vectorized SciPy path and a stdlib path."""

    def __init__(self, records: Sequence[dict[str, Any]], config: dict[str, Any], scope: str) -> None:
        self.records = list(records)
        self.config = config
        self.scope = scope
        self.query_workers = int(config.get("referenceQueryWorkers", DEFAULT_REFERENCE_QUERY_WORKERS))
        self.k = neighbor_count(len(self.records), float(config["neighborExponent"])) if self.records else 0
        self.tree = None
        self._np = None
        if self.records and len(self.records) >= self.k + 1:
            cKDTree = _try_import_ckdtree()
            if cKDTree is not None:
                try:
                    import numpy as np  # type: ignore
                    self._np = np
                    self.tree = cKDTree(
                        np.asarray(
                            [[float(row["targetOldR"]), float(row["opponentOldR"])] for row in self.records],
                            dtype=float,
                        )
                    )
                except (ImportError, ValueError):
                    self.tree = None
                    self._np = None
        self.x = [
            float((row.get("metrics") or {}).get(self.scope, {}).get("equalPhaseGameGe4Rate"))
            for row in self.records
        ]

    def _one(self, trial_elo: float, opponent_elo: float) -> dict[str, Any]:
        return nearest_weighted_neighbors(self.records, trial_elo, opponent_elo, config=self.config)

    def score_grid(self, grid: Sequence[int], opponent_elo: float, target_rate: float) -> list[dict[str, Any]]:
        return self.score_grid_batch([(opponent_elo, target_rate)], grid)[0]

    def score_grid_batch(
        self,
        requests: Sequence[tuple[float, float]],
        grid: Sequence[int],
        *,
        batch_size: int = 8,
    ) -> list[list[dict[str, Any]]]:
        """Score several target games in bounded batches of tree queries."""

        if not requests:
            return []
        if not self.records:
            return [
                [{"ok": False, "reason": "insufficient_reference"} for _ in grid]
                for _ in requests
            ]
        if self.tree is None or self._np is None:
            output: list[list[dict[str, Any]]] = []
            for opponent, rate in requests:
                rows = []
                for trial in grid:
                    nearest = self._one(trial, opponent)
                    rows.append(self._score_nearest(nearest, rate, self.scope))
                output.append(rows)
            return output
        if self.k == 0:
            return [
                [{"ok": False, "reason": "insufficient_reference"} for _ in grid]
                for _ in requests
            ]
        np = self._np
        grid_values = np.asarray(grid, dtype=float)
        output: list[list[dict[str, Any]]] = [
            [dict() for _ in grid] for _ in requests
        ]
        for start in range(0, len(requests), max(1, int(batch_size))):
            batch = requests[start:start + max(1, int(batch_size))]
            query_count = len(batch) * len(grid)
            queries = np.empty((query_count, 2), dtype=float)
            for batch_index, (opponent, _rate) in enumerate(batch):
                begin = batch_index * len(grid)
                end = begin + len(grid)
                queries[begin:end, 0] = grid_values
                queries[begin:end, 1] = float(opponent)
            distances, indexes = self.tree.query(queries, k=self.k + 1, workers=self.query_workers)
            selected_distances = distances[:, :self.k]
            boundary_distances = distances[:, self.k]
            with np.errstate(divide="ignore", invalid="ignore"):
                weights = np.maximum(0.0, 1.0 - selected_distances / boundary_distances[:, None])
                weight_sums = weights.sum(axis=1)
                values = np.asarray(self.x, dtype=float)[indexes[:, :self.k]]
                means = (weights * values).sum(axis=1) / weight_sums
                variances = (weights * (values - means[:, None]) ** 2).sum(axis=1) / weight_sums
                sds = np.sqrt(variances)
                rates = np.asarray([rate for _opponent, rate in batch for _elo in grid], dtype=float)
                z_values = (rates - means) / sds
            for batch_index, (opponent, rate) in enumerate(batch):
                begin = batch_index * len(grid)
                end = begin + len(grid)
                batch_output: list[dict[str, Any]] = []
                for local_index, trial in enumerate(grid):
                    row_index = begin + local_index
                    boundary = float(boundary_distances[row_index])
                    sd = float(sds[row_index])
                    valid = (
                        math.isfinite(boundary) and boundary > 0
                        and math.isfinite(float(weight_sums[row_index])) and float(weight_sums[row_index]) > 0
                        and math.isfinite(sd) and sd > 0
                        and math.isfinite(float(z_values[row_index]))
                    )
                    if not valid:
                        batch_output.append({
                            "ok": False,
                            "reason": "zero_reference_standard_deviation" if math.isfinite(sd) and sd <= 0 else "insufficient_reference",
                            "boundaryDistance": boundary,
                        })
                        continue
                    # cKDTree has deterministic distances, but its order among
                    # exact ties is unspecified. Re-run only boundary-tie rows
                    # through the stable-key implementation.
                    if abs(float(selected_distances[row_index, -1]) - boundary) <= 1e-12:
                        nearest = self._one(trial, opponent)
                        batch_output.append(self._score_nearest(nearest, rate, self.scope))
                    else:
                        batch_output.append({
                            "ok": True,
                            "gameZ": float(z_values[row_index]),
                            "referenceMean": float(means[row_index]),
                            "referenceVariance": float(variances[row_index]),
                            "referenceSd": sd,
                            "boundaryDistance": boundary,
                            "K": self.k,
                            "referenceCount": len(self.records),
                        })
                output[start + batch_index] = batch_output
        return output

    @staticmethod
    def _score_nearest(nearest: dict[str, Any], target_rate: float, scope: str) -> dict[str, Any]:
        if nearest.get("ok") is not True:
            return {"ok": False, "reason": nearest.get("reason", "insufficient_reference"), **nearest}
        distribution = weighted_reference_distribution(nearest["weighted"], scope=scope)
        sd = float(distribution["sd"])
        if not math.isfinite(sd) or sd <= 0:
            return {"ok": False, "reason": "zero_reference_standard_deviation"}
        return {
            "ok": True,
            "gameZ": (float(target_rate) - float(distribution["mean"])) / sd,
            "referenceMean": float(distribution["mean"]),
            "referenceVariance": float(distribution["variance"]),
            "referenceSd": sd,
            "boundaryDistance": float(nearest["boundaryDistance"]),
            "K": nearest["K"],
            "referenceCount": nearest["referenceCount"],
        }


def elo_grid(config: dict[str, Any] | None = None) -> list[int]:
    cfg = validate_config(config or default_config())
    return list(range(int(cfg["eloGridMinimum"]), int(cfg["eloGridMaximum"]) + 1, int(cfg["eloGridStep"])))


def _curve_stats(points: Sequence[dict[str, Any]], grid_step: int = 1) -> dict[str, Any]:
    valid = [point for point in points if finite_number(point.get("candidateZ")) and finite_number(point.get("score"))]
    if not valid:
        return {
            "minimumScore": None,
            "bestGridPoints": [],
            "crossings": [],
            "minimumPlateauWidth": None,
            "secondaryMinimumGap": None,
            "maximumAdjacentCandidateZJump": None,
        }
    minimum_score = min(float(point["score"]) for point in valid)
    best = [int(point["elo"]) for point in valid if abs(float(point["score"]) - minimum_score) <= 1e-12]
    crossings: list[list[int]] = []
    previous = None
    for point in valid:
        z = float(point["candidateZ"])
        if z == 0:
            current = [int(point["elo"]), int(point["elo"])]
        elif previous is not None and float(previous["candidateZ"]) * z < 0:
            current = [int(previous["elo"]), int(point["elo"])]
        else:
            previous = point
            continue
        if (
            crossings
            and current[0] == current[1]
            and crossings[-1][1] == current[0]
        ):
            crossings[-1][1] = current[1]
        else:
            crossings.append(current)
        previous = point
    local_minimum_scores: list[float] = []
    for index, point in enumerate(valid):
        score = float(point["score"])
        left = float(valid[index - 1]["score"]) if index > 0 else math.inf
        right = float(valid[index + 1]["score"]) if index + 1 < len(valid) else math.inf
        if score <= left and score <= right:
            local_minimum_scores.append(score)
    local_minimum_scores.sort()
    secondary_gap = (
        local_minimum_scores[1] - local_minimum_scores[0]
        if len(local_minimum_scores) >= 2 else None
    )
    jumps = [
        abs(float(right["candidateZ"]) - float(left["candidateZ"]))
        for left, right in zip(valid, valid[1:])
    ]
    return {
        "minimumScore": minimum_score,
        "bestGridPoints": best,
        "crossings": crossings,
        "minimumPlateauWidth": (max(best) - min(best)) if best else None,
        "secondaryMinimumGap": secondary_gap,
        "maximumAdjacentCandidateZJump": max(jumps) if jumps else 0.0,
    }


def classify_curve(
    curve: dict[str, Any],
    *,
    diagnostic_thresholds: dict[str, Any] | None = None,
) -> dict[str, Any]:
    points = curve.get("points") if isinstance(curve.get("points"), list) else []
    stats = _curve_stats(points)
    valid = [point for point in points if finite_number(point.get("candidateZ"))]
    if not valid:
        return {"status": "insufficient_reference", "statusReasons": ["no_grid_point_was_scorable"], **stats}
    z_values = [float(point["candidateZ"]) for point in valid]
    if all(value < 0 for value in z_values):
        return {"status": "above_reference_range", "statusReasons": ["candidateZ_is_negative_over_the_full_grid"], **stats}
    if all(value > 0 for value in z_values):
        return {"status": "below_reference_range", "statusReasons": ["candidateZ_is_positive_over_the_full_grid"], **stats}
    if len(stats["crossings"]) > 1:
        return {"status": "multiple_crossings", "statusReasons": ["multiple_separated_zero_crossings"], **stats}
    thresholds = diagnostic_thresholds or {}
    if (
        finite_number(thresholds.get("multipleCrossingsScoreDelta"))
        and finite_number(stats.get("secondaryMinimumGap"))
        and float(stats["secondaryMinimumGap"]) <= float(thresholds["multipleCrossingsScoreDelta"])
        and len(stats.get("bestGridPoints") or []) == 1
    ):
        return {"status": "multiple_crossings", "statusReasons": ["calibrated_near_tied_minima"], **stats}
    if (
        finite_number(thresholds.get("lowResolutionEloWidth"))
        and finite_number(stats.get("minimumPlateauWidth"))
        and float(stats["minimumPlateauWidth"]) > float(thresholds["lowResolutionEloWidth"])
    ):
        return {"status": "low_resolution", "statusReasons": ["calibrated_minimum_region_is_wide"], **stats}
    if (
        finite_number(thresholds.get("abnormalLocalJumpThreshold"))
        and finite_number(stats.get("maximumAdjacentCandidateZJump"))
        and float(stats["maximumAdjacentCandidateZJump"]) > float(thresholds["abnormalLocalJumpThreshold"])
    ):
        return {"status": "low_resolution", "statusReasons": ["calibrated_local_curve_jump"], **stats}
    return {"status": "valid", "statusReasons": ["one_internal_zero_crossing_or_exact_zero"], **stats}


def score_candidate_curve(
    target_records: Sequence[dict[str, Any]],
    reference_records: Sequence[dict[str, Any]],
    *,
    target_account: str,
    config: dict[str, Any] | None = None,
    diagnostic_thresholds: dict[str, Any] | None = None,
) -> dict[str, Any]:
    cfg = validate_config(config or default_config())
    grid = elo_grid(cfg)
    target_rows = list(target_records)
    excluded = excluded_reference_game_ids(
        reference_records,
        target_account,
        [str(row.get("gameId") or "") for row in target_rows],
    )
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = {}
    searchers: dict[tuple[str, str], _ReferenceSearcher] = {}
    target_curves: dict[str, list[float | None]] = {}
    target_failures: dict[str, list[str]] = defaultdict(list)
    batch_requests: dict[tuple[str, str], list[tuple[float, float]]] = defaultdict(list)
    batch_game_ids: dict[tuple[str, str], list[str]] = defaultdict(list)
    for target in target_rows:
        scope = selected_metrics_scope(target)
        color = str(target.get("targetColor") or "").strip().casefold()
        key = (color, scope)
        if key not in grouped:
            grouped[key] = eligible_reference_records(
                reference_records,
                target,
                excluded_game_ids=excluded,
                config=cfg,
            )
            searchers[key] = _ReferenceSearcher(grouped[key], cfg, scope)
        target_metrics = metrics_for_record(target, scope)
        rate = target_metrics.get("equalPhaseGameGe4Rate")
        opponent = target.get("opponentOldR")
        game_id = str(target.get("gameId") or "")
        if not finite_number(rate) or not finite_number(opponent):
            target_curves[game_id] = [None for _ in grid]
            target_failures[game_id].append("incomplete_phase_data")
            continue
        batch_requests[key].append((float(opponent), float(rate)))
        batch_game_ids[key].append(game_id)

    for key, requests in batch_requests.items():
        scored_rows = searchers[key].score_grid_batch(requests, grid, batch_size=8)
        for game_id, scored in zip(batch_game_ids[key], scored_rows, strict=True):
            values: list[float | None] = []
            for item in scored:
                if item.get("ok") is True and finite_number(item.get("gameZ")):
                    values.append(float(item["gameZ"]))
                else:
                    values.append(None)
                    target_failures[game_id].append(str(item.get("reason") or "insufficient_reference"))
            target_curves[game_id] = values

    points: list[dict[str, Any]] = []
    for index, elo in enumerate(grid):
        game_zs = [values[index] for values in target_curves.values()]
        if game_zs and all(value is not None and math.isfinite(float(value)) for value in game_zs):
            candidate_z = statistics.fmean(float(value) for value in game_zs if value is not None)
            points.append({"elo": elo, "candidateZ": candidate_z, "score": abs(candidate_z)})
        else:
            points.append({"elo": elo, "candidateZ": None, "score": None})
    curve = {
        "eloGridMinimum": grid[0],
        "eloGridMaximum": grid[-1],
        "eloGridStep": int(cfg["eloGridStep"]),
        "points": points,
        "targetGameCount": len(target_rows),
        "excludedReferenceGameCount": len(excluded),
        "excludedReferenceGameIds": sorted(excluded),
        "targetGameFailures": {
            game_id: sorted(set(reasons)) for game_id, reasons in sorted(target_failures.items()) if reasons
        },
    }
    curve.update(classify_curve(curve, diagnostic_thresholds=diagnostic_thresholds))
    best = curve.get("bestGridPoints") or []
    best_elo = best[0] if best else None
    curve["bestGridPoint"] = best_elo
    curve["candidateZAtBest"] = next(
        (point["candidateZ"] for point in points if point["elo"] == best_elo), None
    ) if best_elo is not None else None
    curve["gameCurves"] = target_curves
    return curve


def interpolate_score(points: Sequence[dict[str, Any]], elo: float) -> float | None:
    if not finite_number(elo):
        return None
    ordered = sorted(
        (point for point in points if finite_number(point.get("score"))),
        key=lambda point: int(point["elo"]),
    )
    if not ordered or float(elo) < ordered[0]["elo"] or float(elo) > ordered[-1]["elo"]:
        return None
    for point in ordered:
        if float(point["elo"]) == float(elo):
            return float(point["score"])
    lower = max((point for point in ordered if float(point["elo"]) < float(elo)), key=lambda p: p["elo"], default=None)
    upper = min((point for point in ordered if float(point["elo"]) > float(elo)), key=lambda p: p["elo"], default=None)
    if lower is None or upper is None:
        return None
    fraction = (float(elo) - float(lower["elo"])) / (float(upper["elo"]) - float(lower["elo"]))
    return float(lower["score"]) * (1.0 - fraction) + float(upper["score"]) * fraction


def intervals_for_score_threshold(
    points: Sequence[dict[str, Any]],
    allowed_score: float,
) -> list[dict[str, Any]]:
    eligible = [
        int(point["elo"])
        for point in points
        if finite_number(point.get("score")) and float(point["score"]) <= float(allowed_score)
    ]
    if not eligible:
        return []
    intervals: list[dict[str, Any]] = []
    start = previous = eligible[0]
    for elo in eligible[1:]:
        if elo == previous + 1:
            previous = elo
            continue
        intervals.append({
            "lower": start,
            "upper": previous,
            "truncatedLower": start == int(points[0]["elo"]),
            "truncatedUpper": previous == int(points[-1]["elo"]),
        })
        start = previous = elo
    intervals.append({
        "lower": start,
        "upper": previous,
        "truncatedLower": start == int(points[0]["elo"]),
        "truncatedUpper": previous == int(points[-1]["elo"]),
    })
    return intervals


def _latest_known_elos(bundle: dict[str, Any]) -> dict[str, float | None]:
    candidates: dict[str, list[tuple[str, str, float | None]]] = defaultdict(list)
    for detail in bundle.get("details", []) if isinstance(bundle.get("details"), list) else []:
        game_id = str(detail.get("id") or "")
        created = str(detail.get("created") or "")
        for player in detail.get("players", []) if isinstance(detail.get("players"), list) else []:
            key = account_key(player.get("id"))
            if not key:
                continue
            candidates[key].append((created, game_id, optional_number(player.get("newR"))))
    result: dict[str, float | None] = {}
    for key, rows in candidates.items():
        latest = max(rows, key=lambda row: (row[0], row[1]))
        result[key] = latest[2]
    return result


def _split_accounts(accounts: Sequence[str], config: dict[str, Any]) -> tuple[list[str], list[str], dict[str, Any]]:
    ordered = sorted(
        (account_key(account) for account in accounts),
        key=lambda account: hashlib.sha256(
            f"{int(config.get('calibrationSplitSeed', DEFAULT_SPLIT_SEED))}|{account}".encode("utf-8")
        ).hexdigest(),
    )
    if len(ordered) < 2:
        return [], ordered, {
            "method": "sha256(seed|accountKey) lexicographic order",
            "seed": int(config.get("calibrationSplitSeed", DEFAULT_SPLIT_SEED)),
            "calibrationFraction": float(config.get("calibrationValidationFraction", DEFAULT_CALIBRATION_VALIDATION_FRACTION)),
        }
    fraction = float(config.get("calibrationValidationFraction", DEFAULT_CALIBRATION_VALIDATION_FRACTION))
    calibration_count = int(math.floor(len(ordered) * (1.0 - fraction)))
    calibration_count = max(1, min(len(ordered) - 1, calibration_count))
    return ordered[:calibration_count], ordered[calibration_count:], {
        "method": "sha256(seed|accountKey) lexicographic order",
        "seed": int(config.get("calibrationSplitSeed", DEFAULT_SPLIT_SEED)),
        "calibrationFraction": calibration_count / len(ordered),
        "validationFraction": (len(ordered) - calibration_count) / len(ordered),
    }


def _calibration_user_records(
    reference_records: Sequence[dict[str, Any]],
    account: str,
    *,
    config: dict[str, Any],
) -> dict[str, Any]:
    rows = [
        row for row in reference_records
        if account_key(row.get("targetPlayerId")) == account_key(account)
        and row.get("formalReferenceEligible") is True
        and _target_record_rejection(row, config) is None
    ]
    rows.sort(key=lambda row: (str(row.get("created") or ""), str(row.get("gameId") or "")), reverse=True)
    maximum = int(config["maximumTargetGames"])
    return {
        "allValidRecords": rows,
        "selected": rows[:maximum],
        "excludedOlder": rows[maximum:],
    }


def _error_summary(values: Sequence[float]) -> dict[str, Any]:
    ordered = sorted(float(value) for value in values)
    if not ordered:
        return {"count": 0, "median": None, "mean": None, "p90": None, "p95": None}
    def q(probability: float) -> float:
        position = (len(ordered) - 1) * probability
        lower = math.floor(position)
        upper = math.ceil(position)
        if lower == upper:
            return ordered[lower]
        fraction = position - lower
        return ordered[lower] * (1.0 - fraction) + ordered[upper] * fraction
    return {
        "count": len(ordered),
        "median": q(0.5),
        "mean": statistics.fmean(ordered),
        "p90": q(0.9),
        "p95": q(0.95),
    }


def _make_calibration_case(
    role: str,
    account: str,
    selected: Sequence[dict[str, Any]],
    known: float,
    reference_records: Sequence[dict[str, Any]],
    config: dict[str, Any],
) -> dict[str, Any]:
    minimum_elo = int(config["formalEloMinimum"])
    maximum_elo = int(config["formalEloMaximum"])
    selected_rows = list(selected)
    excluded = excluded_reference_game_ids(
        reference_records,
        account,
        [str(row.get("gameId") or "") for row in selected_rows],
    )
    curve = score_candidate_curve(
        selected_rows,
        reference_records,
        target_account=account,
        config=config,
    )
    known_in_range = minimum_elo <= float(known) <= maximum_elo
    score_at_known = interpolate_score(curve.get("points", []), float(known)) if known_in_range else None
    minimum_score = curve.get("minimumScore")
    return {
        "schema": "player-sentinel-elo-calibration-case-v1",
        "account": account,
        "role": role,
        "knownElo": float(known),
        "knownEloDefinition": "newR from the account's latest created source-bundle detail",
        "selectedGameIds": [str(row.get("gameId") or "") for row in selected_rows],
        "selectedGameCount": len(selected_rows),
        "excludedReferenceGameCount": len(excluded),
        "curveStatus": curve.get("status"),
        "bestGridPoint": curve.get("bestGridPoint"),
        "minimumScore": minimum_score,
        "candidateZAtBest": curve.get("candidateZAtBest"),
        "knownEloInFormalRange": known_in_range,
        "scoreAtKnownElo": score_at_known,
        "trueScoreIncrease": (
            float(score_at_known) - float(minimum_score)
            if score_at_known is not None and finite_number(minimum_score) else None
        ),
        "estimatedEloError": (
            float(curve["bestGridPoint"]) - float(known)
            if curve.get("bestGridPoint") is not None else None
        ),
        "scoreCurve": curve.get("points", []),
        "statusReasons": curve.get("statusReasons", []),
    }


_CALIBRATION_WORKER_REFERENCE_RECORDS: list[dict[str, Any]] = []
_CALIBRATION_WORKER_BY_ACCOUNT: dict[str, list[dict[str, Any]]] = {}
_CALIBRATION_WORKER_CONFIG: dict[str, Any] = {}


def _init_calibration_worker(reference_records_path: str, config: dict[str, Any]) -> None:
    global _CALIBRATION_WORKER_REFERENCE_RECORDS
    global _CALIBRATION_WORKER_BY_ACCOUNT
    global _CALIBRATION_WORKER_CONFIG
    _CALIBRATION_WORKER_REFERENCE_RECORDS = read_jsonl(reference_records_path)
    _CALIBRATION_WORKER_CONFIG = validate_config(config)
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in _CALIBRATION_WORKER_REFERENCE_RECORDS:
        account = account_key(record.get("targetPlayerId"))
        if (
            account
            and record.get("formalReferenceEligible") is True
            and _target_record_rejection(record, _CALIBRATION_WORKER_CONFIG) is None
        ):
            grouped[account].append(record)
    for account in grouped:
        grouped[account].sort(
            key=lambda row: (str(row.get("created") or ""), str(row.get("gameId") or "")),
            reverse=True,
        )
    _CALIBRATION_WORKER_BY_ACCOUNT = dict(grouped)


def _calibration_case_worker(task: tuple[str, str, float]) -> dict[str, Any]:
    role, account, known = task
    selected = _CALIBRATION_WORKER_BY_ACCOUNT[account][:_CALIBRATION_WORKER_CONFIG["maximumTargetGames"]]
    return _make_calibration_case(
        role,
        account,
        selected,
        known,
        _CALIBRATION_WORKER_REFERENCE_RECORDS,
        _CALIBRATION_WORKER_CONFIG,
    )


def calibrate_global_interval(
    reference_records: Sequence[dict[str, Any]],
    source_bundle: dict[str, Any],
    *,
    config: dict[str, Any] | None = None,
    reference_records_path: str | Path | None = None,
    parallel_workers: int | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Build a leave-one-account-out global threshold and independent check."""

    cfg = validate_config(config or default_config())
    by_account: dict[str, list[dict[str, Any]]] = defaultdict(list)
    known_elos = _latest_known_elos(source_bundle)
    for record in reference_records:
        account = account_key(record.get("targetPlayerId"))
        if not account or record.get("formalReferenceEligible") is not True:
            continue
        if _target_record_rejection(record, cfg) is None:
            by_account[account].append(record)
    for account in by_account:
        by_account[account].sort(
            key=lambda row: (str(row.get("created") or ""), str(row.get("gameId") or "")),
            reverse=True,
        )
    eligible_accounts: list[str] = []
    skipped_accounts: list[dict[str, Any]] = []
    for account in sorted(by_account):
        selected = by_account[account][:int(cfg["maximumTargetGames"])]
        known = known_elos.get(account)
        if len(selected) < int(cfg["minimumTargetGames"]):
            skipped_accounts.append({"account": account, "reason": "insufficient_target_games", "validRecordCount": len(selected)})
            continue
        if not finite_number(known):
            skipped_accounts.append({"account": account, "reason": "missing_known_newR"})
            continue
        eligible_accounts.append(account)
    calibration_accounts, validation_accounts, split = _split_accounts(eligible_accounts, cfg)
    min_elo = int(cfg["formalEloMinimum"])
    max_elo = int(cfg["formalEloMaximum"])
    tasks = [
        (role, account, float(known_elos[account]))
        for role, accounts in (("calibration", calibration_accounts), ("validation", validation_accounts))
        for account in accounts
    ]
    workers = int(parallel_workers if parallel_workers is not None else cfg.get("calibrationWorkers", 1))
    workers = max(1, workers)
    if reference_records_path is not None and workers > 1 and len(tasks) > 1:
        worker_config = dict(cfg)
        # Sixteen processes are the parallel unit. A tree query thread per
        # process avoids an accidental 16x16 oversubscription.
        worker_config["referenceQueryWorkers"] = 1
        with ProcessPoolExecutor(
            max_workers=workers,
            initializer=_init_calibration_worker,
            initargs=(str(Path(reference_records_path).resolve()), worker_config),
        ) as executor:
            cases = list(executor.map(_calibration_case_worker, tasks, chunksize=1))
    else:
        cases = [
            _make_calibration_case(
                role,
                account,
                by_account[account][:int(cfg["maximumTargetGames"])],
                float(known_elos[account]),
                reference_records,
                cfg,
            )
            for role, account, _known in tasks
        ]

    calibration_cases = [
        case for case in cases
        if case["role"] == "calibration"
        and case["knownEloInFormalRange"] is True
        and finite_number(case.get("trueScoreIncrease"))
        and case.get("curveStatus") == "valid"
    ]
    increases = [float(case["trueScoreIncrease"]) for case in calibration_cases]
    if increases:
        ordered = sorted(increases)
        position = (len(ordered) - 1) * float(cfg["calibrationCoverage"])
        lower = math.floor(position)
        upper = math.ceil(position)
        t95 = ordered[lower] if lower == upper else ordered[lower] * (upper - position) + ordered[upper] * (position - lower)
    else:
        t95 = None
    threshold_source = calibration_cases
    # Diagnostic thresholds are themselves artifacts of the calibration set;
    # no user-specific adjustment is made at estimation time.
    widths = []
    gaps = []
    jumps = []
    for case in threshold_source:
        stats = _curve_stats(case["scoreCurve"])
        if finite_number(stats.get("minimumPlateauWidth")):
            widths.append(float(stats["minimumPlateauWidth"]))
        if finite_number(stats.get("secondaryMinimumGap")):
            gaps.append(float(stats["secondaryMinimumGap"]))
        if finite_number(stats.get("maximumAdjacentCandidateZJump")):
            jumps.append(float(stats["maximumAdjacentCandidateZJump"]))
    diagnostic_thresholds = {
        "method": "empirical calibration-user quantiles",
        "lowResolutionEloWidth": max(widths) if widths else None,
        "multipleCrossingsScoreDelta": min(gaps) if gaps else None,
        "abnormalLocalJumpThreshold": max(jumps) if jumps else None,
        "sourceCalibrationUserCount": len(threshold_source),
    }

    validation_cases = [
        case for case in cases
        if case["role"] == "validation"
        and case["knownEloInFormalRange"] is True
        and finite_number(case.get("scoreAtKnownElo"))
        and finite_number(case.get("minimumScore"))
        and case.get("bestGridPoint") is not None
    ]
    covered = [
        float(case["scoreAtKnownElo"]) <= float(case["minimumScore"]) + float(t95)
        for case in validation_cases
    ] if t95 is not None else []
    validation_coverage = statistics.fmean(covered) if covered else None
    errors = [
        abs(float(case["estimatedEloError"]))
        for case in validation_cases if finite_number(case.get("estimatedEloError"))
    ]
    min_validation_users = int(cfg.get("minimumValidationUsers", DEFAULT_MINIMUM_VALIDATION_USERS))
    validated = bool(
        t95 is not None
        and len(calibration_cases) >= 1
        and len(validation_cases) >= min_validation_users
        and validation_coverage is not None
        and validation_coverage >= float(cfg["calibrationCoverage"])
    )
    status = "validated" if validated else "calibration_unavailable"
    artifact = {
        "schema": SCHEMA_CALIBRATION,
        "version": "v1",
        "createdAt": utc_now(),
        "formalEloMinimum": min_elo,
        "formalEloMaximum": max_elo,
        "minimumTargetGames": int(cfg["minimumTargetGames"]),
        "maximumTargetGames": int(cfg["maximumTargetGames"]),
        "calibrationCoverage": float(cfg["calibrationCoverage"]),
        "calibrationGrouping": "global",
        "knownEloDefinition": "newR from the latest created source-bundle detail for each account",
        "knownEloInterpolation": "linear interpolation between adjacent integer Elo score points",
        "quantileMethod": "unweighted empirical linear interpolation at p=(n-1)*q",
        "t95": t95,
        "calibrationUserCount": len(calibration_accounts),
        "validationUserCount": len(validation_accounts),
        "calibrationCaseCount": len(calibration_cases),
        "validationCaseCount": len(validation_cases),
        "validationCoveredCount": sum(covered) if covered else 0,
        "validationCoverage": validation_coverage,
        "minimumValidationUsers": min_validation_users,
        "status": status,
        "split": {
            **split,
            "calibrationAccounts": calibration_accounts,
            "validationAccounts": validation_accounts,
        },
        "skippedAccounts": skipped_accounts,
        "diagnosticThresholds": diagnostic_thresholds,
        "validationErrorSummary": _error_summary(errors),
        "parallelWorkers": workers,
        "referenceQueryWorkersPerWorker": 1 if reference_records_path is not None and workers > 1 else int(cfg.get("referenceQueryWorkers", DEFAULT_REFERENCE_QUERY_WORKERS)),
        "independentValidation": {
            "required": True,
            "usersAreDisjointFromCalibration": not bool(set(calibration_accounts) & set(validation_accounts)),
            "coverageTarget": float(cfg["calibrationCoverage"]),
            "coverageConfirmed": validated,
        },
    }
    return artifact, sorted(cases, key=lambda case: (str(case.get("role")), str(case.get("account"))))


@dataclass(frozen=True)
class TargetEstimate:
    payload: dict[str, Any]
    curve: dict[str, Any]
    selected_records: tuple[dict[str, Any], ...]


def estimate_database_calibrated_range(
    account: str,
    target_records: Sequence[dict[str, Any]],
    reference_records: Sequence[dict[str, Any]],
    *,
    config: dict[str, Any] | None = None,
    calibration: dict[str, Any] | None = None,
    reference_version: str | None = None,
    reference_manifest_sha256: str | None = None,
    calibration_version: str | None = None,
) -> TargetEstimate:
    cfg = validate_config(config or default_config())
    selection = select_target_records(target_records, config=cfg)
    selected = list(selection["selected"])
    base: dict[str, Any] = {
        "schema": SCHEMA_ESTIMATE,
        "account": account,
        "referenceVersion": reference_version,
        "referenceManifestSha256": reference_manifest_sha256,
        "calibrationVersion": calibration_version,
        "selectedGameIds": [str(row.get("gameId") or "") for row in selected],
        "selectedGameCount": len(selected),
        "excludedGamesWithReasons": selection["excluded"],
        "formalMinimumGameCount": int(cfg["minimumTargetGames"]),
        "formalMaximumGameCount": int(cfg["maximumTargetGames"]),
        "eloGridMinimum": int(cfg["eloGridMinimum"]),
        "eloGridMaximum": int(cfg["eloGridMaximum"]),
        "estimatedElo": None,
        "bestGridPoint": None,
        "minimumScore": None,
        "candidateZAtBest": None,
        "databaseCalibrated95Range": None,
        "databaseCalibrated95Intervals": [],
        "status": selection["status"],
        "statusReasons": [],
        "phaseDiagnostics": [],
        "gameDiagnostics": [],
        "curveFile": None,
        "createdAt": utc_now(),
    }
    if selection["status"] != "valid":
        base["statusReasons"] = ["fewer_than_minimum_complete_recent_target_games"]
        curve = {
            "points": [],
            "status": selection["status"],
            "statusReasons": base["statusReasons"],
            "gameCurves": {},
        }
        return TargetEstimate(base, curve, tuple(selected))

    thresholds = (calibration or {}).get("diagnosticThresholds") if calibration else None
    curve = score_candidate_curve(
        selected,
        reference_records,
        target_account=account,
        config=cfg,
        diagnostic_thresholds=thresholds,
    )
    curve_status = str(curve.get("status") or "insufficient_reference")
    best = curve.get("bestGridPoint")
    base["bestGridPoint"] = best
    base["minimumScore"] = curve.get("minimumScore")
    base["candidateZAtBest"] = curve.get("candidateZAtBest")
    base["statusReasons"] = list(curve.get("statusReasons") or [])
    base["status"] = curve_status
    if curve_status == "valid" and best is not None:
        base["estimatedElo"] = int(best)
        if calibration and calibration.get("status") == "validated" and finite_number(calibration.get("t95")):
            allowed = float(curve["minimumScore"]) + float(calibration["t95"])
            intervals = intervals_for_score_threshold(curve["points"], allowed)
            base["databaseCalibrated95Intervals"] = intervals
            if len(intervals) == 1:
                base["databaseCalibrated95Range"] = intervals[0]
            if len(intervals) > 1:
                base["status"] = "multiple_crossings"
                base["statusReasons"].append("calibrated_score_set_has_multiple_intervals")
        else:
            base["status"] = "calibration_unavailable"
            base["statusReasons"].append("independent_validation_did_not_confirm_database_95_percent_coverage")

    best_game_diagnostics: list[dict[str, Any]] = []
    phase_rows: list[dict[str, Any]] = []
    if best is not None:
        excluded = excluded_reference_game_ids(
            reference_records,
            account,
            [str(row.get("gameId") or "") for row in selected],
        )
        for target in selected:
            scored = score_game_at_elo(
                target,
                reference_records,
                float(best),
                excluded_game_ids=excluded,
                config=cfg,
            )
            if scored.get("ok") is not True:
                continue
            game_id = str(target.get("gameId") or "")
            best_game_diagnostics.append({
                "gameId": game_id,
                "targetColor": target.get("targetColor"),
                "scope": scored.get("scope"),
                "targetEqualPhaseGameGe4Rate": scored.get("targetEqualPhaseGameGe4Rate"),
                "referenceMean": scored.get("referenceMean"),
                "referenceSd": scored.get("referenceSd"),
                "gameZ": scored.get("gameZ"),
                "referenceNeighborCount": scored.get("K"),
                "eligibleReferenceCount": scored.get("eligibleReferenceCount"),
            })
            metrics = metrics_for_record(target)
            reference_phase = scored.get("referencePhaseExpectedGe4") or {}
            for phase, _lower, _upper in PHASES:
                target_phase = (metrics.get(phase) or {}).get("lossGe4Rate")
                reference_value = reference_phase.get(phase)
                phase_rows.append({
                    "gameId": game_id,
                    "targetColor": target.get("targetColor"),
                    "scope": scored.get("scope"),
                    "trialElo": int(best),
                    "phase": phase,
                    "targetGe4Rate": target_phase,
                    "referenceExpectedGe4Rate": reference_value,
                    "differenceTargetMinusReference": (
                        float(target_phase) - float(reference_value)
                        if finite_number(target_phase) and finite_number(reference_value) else None
                    ),
                    "direction": (
                        "worse_than_trial" if float(target_phase) > float(reference_value)
                        else "better_than_trial" if float(target_phase) < float(reference_value)
                        else "equal"
                    ) if finite_number(target_phase) and finite_number(reference_value) else None,
                })
    game_zs = [float(row["gameZ"]) for row in best_game_diagnostics if finite_number(row.get("gameZ"))]
    base["gameDiagnostics"] = best_game_diagnostics
    base["phaseDiagnostics"] = phase_rows
    base["diagnosticSummary"] = {
        "gameZMinimum": min(game_zs) if game_zs else None,
        "gameZMaximum": max(game_zs) if game_zs else None,
        "gameZMean": statistics.fmean(game_zs) if game_zs else None,
        "gameZMedian": statistics.median(game_zs) if game_zs else None,
        "meanAbsGameZ": statistics.fmean(abs(value) for value in game_zs) if game_zs else None,
        "scoreCurveMinimumRegionWidth": curve.get("minimumPlateauWidth"),
        "candidateZLocalGradient": _candidate_gradient(curve.get("points", []), best),
        "crossings": curve.get("crossings", []),
    }
    return TargetEstimate(base, curve, tuple(selected))


def _candidate_gradient(points: Sequence[dict[str, Any]], elo: int | None) -> float | None:
    if elo is None:
        return None
    by_elo = {int(point["elo"]): point for point in points if finite_number(point.get("candidateZ"))}
    if elo - 1 in by_elo and elo + 1 in by_elo:
        return (float(by_elo[elo + 1]["candidateZ"]) - float(by_elo[elo - 1]["candidateZ"])) / 2.0
    if elo + 1 in by_elo and elo in by_elo:
        return float(by_elo[elo + 1]["candidateZ"]) - float(by_elo[elo]["candidateZ"])
    if elo - 1 in by_elo and elo in by_elo:
        return float(by_elo[elo]["candidateZ"]) - float(by_elo[elo - 1]["candidateZ"])
    return None


def reference_records_from_directory(directory: str | Path, *, config: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    cfg = validate_config(config or default_config())
    path = Path(directory) / str(cfg.get("directedPhaseRecords") or "directed_game_phase_records.jsonl")
    if not path.is_file():
        raise FileNotFoundError(path)
    rows = read_jsonl(path)
    if any(row.get("schema") != SCHEMA_DIRECTED for row in rows):
        raise ValueError("reference phase JSONL contains an unsupported schema")
    return rows


def calibration_cases_to_jsonl(path: str | Path, cases: Sequence[dict[str, Any]]) -> None:
    write_jsonl(path, list(cases))
