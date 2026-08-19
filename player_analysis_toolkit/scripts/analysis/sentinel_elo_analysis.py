#!/usr/bin/env python3
"""Build, calibrate, and estimate sentinel mode's database-calibrated Elo."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


TOOLKIT_ROOT = Path(__file__).resolve().parents[2]
SRC_ROOT = TOOLKIT_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from player_analysis_toolkit import sentinel_elo as elo  # noqa: E402


DEFAULT_CONFIG_PATH = TOOLKIT_ROOT / "sentinel_elo_reference_config.json"


def _config(path: Path) -> dict[str, Any]:
    if path.is_file():
        return elo.load_config(path)
    if path == DEFAULT_CONFIG_PATH:
        return elo.validate_config(elo.default_config())
    raise FileNotFoundError(path)


def _resolve_from_root(value: str | None, default: str | None = None) -> Path:
    raw = value if value is not None else default
    if raw is None:
        raise ValueError("a path argument is required")
    path = Path(raw)
    return path if path.is_absolute() else TOOLKIT_ROOT / path


def command_build(args: argparse.Namespace) -> int:
    config_path = args.config.resolve()
    config = _config(config_path)
    source = _resolve_from_root(args.source_reference_dir, str(config["sourceReferenceDirectory"]))
    sentinel_dir = _resolve_from_root(args.sentinel_derived_dir, str(config["sentinelDerivedDirectory"]))
    output = _resolve_from_root(args.output_dir, str(config["derivedReferenceDirectory"]))
    audit = elo.build_elo_reference(
        source,
        sentinel_dir,
        output,
        config=config,
        config_path=config_path if config_path.is_file() else None,
        build_script_paths=(Path(__file__), TOOLKIT_ROOT / "src" / "player_analysis_toolkit" / "sentinel_elo.py"),
    )
    print(json.dumps(audit, ensure_ascii=False, indent=2))
    return 0


def command_calibrate(args: argparse.Namespace) -> int:
    config_path = args.config.resolve()
    config = _config(config_path)
    reference_dir = _resolve_from_root(args.reference_dir, str(config["derivedReferenceDirectory"]))
    source_dir = _resolve_from_root(args.source_reference_dir, str(config["sourceReferenceDirectory"]))
    records = elo.reference_records_from_directory(reference_dir, config=config)
    bundle = elo.read_json(source_dir / "selected_account_bundle.json")
    directed_records_path = reference_dir / str(config.get("directedPhaseRecords") or "directed_game_phase_records.jsonl")
    artifact, cases = elo.calibrate_global_interval(
        records,
        bundle,
        config=config,
        reference_records_path=directed_records_path,
        parallel_workers=int(config.get("calibrationWorkers", elo.DEFAULT_CALIBRATION_WORKERS)),
    )
    calibration_path = reference_dir / str(config.get("calibrationArtifact") or "elo_calibration.json")
    cases_path = reference_dir / "elo_calibration_cases.jsonl"
    elo.write_json(calibration_path, artifact)
    elo.calibration_cases_to_jsonl(cases_path, cases)
    manifest = elo.update_reference_manifest(reference_dir, config=config)
    result = {
        "calibration": artifact,
        "caseCount": len(cases),
        "referenceManifest": manifest,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def _write_estimate_outputs(
    output_dir: Path,
    payload: dict[str, Any],
    curve: dict[str, Any],
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    curve_name = "estimated_elo_curve.csv"
    games_name = "estimated_elo_games.csv"
    phase_name = "estimated_elo_phase_diagnostics.csv"
    payload["curveFile"] = curve_name
    elo.write_csv(
        output_dir / curve_name,
        [
            {
                "elo": point.get("elo"),
                "candidateZ": point.get("candidateZ"),
                "score": point.get("score"),
            }
            for point in curve.get("points", [])
        ],
    )
    elo.write_csv(output_dir / games_name, payload.get("gameDiagnostics", []))
    elo.write_csv(output_dir / phase_name, payload.get("phaseDiagnostics", []))
    payload["gamesFile"] = games_name
    payload["phaseDiagnosticsFile"] = phase_name
    elo.write_json(output_dir / "estimated_elo.json", payload)


def command_estimate(args: argparse.Namespace) -> int:
    config_path = args.config.resolve()
    config = _config(config_path)
    reference_dir = _resolve_from_root(args.reference_dir, str(config["derivedReferenceDirectory"]))
    records = elo.reference_records_from_directory(reference_dir, config=config)
    calibration_path = args.calibration.resolve() if args.calibration else reference_dir / str(config.get("calibrationArtifact") or "elo_calibration.json")
    calibration = elo.read_json(calibration_path) if calibration_path.is_file() else None
    target_records = elo.target_records_from_inputs(
        args.bundle.resolve(),
        args.engine_dir.resolve(),
        args.offbook_records.resolve(),
        args.account,
        config=config,
    )
    reference_manifest_path = reference_dir / str(config.get("referenceManifest") or "reference_sha256_manifest.json")
    reference_manifest_sha = elo.sha256_file(reference_manifest_path) if reference_manifest_path.is_file() else None
    calibration_version = elo.sha256_file(calibration_path) if calibration_path.is_file() else None
    estimate = elo.estimate_database_calibrated_range(
        args.account,
        target_records,
        records,
        config=config,
        calibration=calibration,
        reference_version=reference_dir.name,
        reference_manifest_sha256=reference_manifest_sha,
        calibration_version=calibration_version,
    )
    _write_estimate_outputs(args.output_dir.resolve(), estimate.payload, estimate.curve)
    print(json.dumps({
        "account": args.account,
        "status": estimate.payload.get("status"),
        "estimatedElo": estimate.payload.get("estimatedElo"),
        "databaseCalibrated95Intervals": estimate.payload.get("databaseCalibrated95Intervals"),
        "selectedGameCount": estimate.payload.get("selectedGameCount"),
    }, ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config", type=Path, default=DEFAULT_CONFIG_PATH,
        help="UTF-8 Elo reference configuration JSON",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    build = subparsers.add_parser("build-elo-reference", help="derive phase records from frozen Level22 files")
    build.add_argument("--source-reference-dir", type=str)
    build.add_argument("--sentinel-derived-dir", type=str)
    build.add_argument("--output-dir", type=str)
    build.set_defaults(handler=command_build)

    calibrate = subparsers.add_parser("calibrate-elo", help="build leave-one-account-out calibration artifacts")
    calibrate.add_argument("--reference-dir", type=str)
    calibrate.add_argument("--source-reference-dir", type=str)
    calibrate.set_defaults(handler=command_calibrate)

    estimate = subparsers.add_parser("estimate-elo", help="estimate one account from recent target Level22 records")
    estimate.add_argument("--account", required=True)
    estimate.add_argument("--bundle", type=Path, required=True)
    estimate.add_argument("--engine-dir", type=Path, required=True)
    estimate.add_argument("--offbook-records", type=Path, required=True)
    estimate.add_argument("--reference-dir", type=str)
    estimate.add_argument("--calibration", type=Path)
    estimate.add_argument("--output-dir", type=Path, required=True)
    estimate.set_defaults(handler=command_estimate)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.handler(args))


if __name__ == "__main__":
    raise SystemExit(main())
