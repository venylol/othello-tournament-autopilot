#!/usr/bin/env python3
"""Unified per-player sentinel analysis entry point.

The existing sentinel and estimated-Elo CLIs remain available for their
legacy and database-maintenance commands.  This script is the single
per-player analysis entry point used by ``run_player_investigation.py``: it
loads the completed legacy sentinel outputs, calculates the database-
calibrated Elo from the cached calibration artifact, and writes one combined
analysis payload for the final report.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from types import ModuleType
from typing import Any


TOOLKIT_ROOT = Path(__file__).resolve().parents[2]
SRC_ROOT = TOOLKIT_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from player_analysis_toolkit import sentinel_elo as elo  # noqa: E402


SCHEMA_UNIFIED = "player-sentinel-unified-analysis-v1"
LEGACY_COMMANDS = {"acquire", "build-reference", "score", "scan", "freeze"}
ELO_COMMANDS = {"build-elo-reference", "calibrate-elo", "estimate-elo"}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def require_file(path: Path, label: str) -> Path:
    resolved = path.resolve()
    if not resolved.is_file():
        raise FileNotFoundError(f"{label} not found: {resolved}")
    return resolved


def require_directory(path: Path, label: str) -> Path:
    resolved = path.resolve()
    if not resolved.is_dir():
        raise FileNotFoundError(f"{label} not found: {resolved}")
    return resolved


def resolve_root_relative(value: str | Path) -> Path:
    raw = Path(value)
    return raw.resolve() if raw.is_absolute() else (TOOLKIT_ROOT / raw).resolve()


def load_elo_reference(config_path: Path) -> dict[str, Any]:
    config_path = require_file(config_path, "sentinel Elo reference config")
    config = elo.load_config(config_path)
    derived = require_directory(
        resolve_root_relative(str(config["derivedReferenceDirectory"])),
        "sentinel Elo derived reference",
    )
    records_path = require_file(
        derived / str(config.get("directedPhaseRecords") or "directed_game_phase_records.jsonl"),
        "sentinel Elo directed phase records",
    )
    manifest_path = require_file(
        derived / str(config.get("referenceManifest") or "reference_sha256_manifest.json"),
        "sentinel Elo reference manifest",
    )
    calibration_path = require_file(
        derived / str(config.get("calibrationArtifact") or "elo_calibration.json"),
        "sentinel Elo calibration cache",
    )
    manifest = read_json(manifest_path)
    if manifest.get("schema") != "player-sentinel-elo-reference-sha256-manifest-v1":
        raise ValueError("unsupported sentinel Elo reference manifest schema")
    for item in manifest.get("files", []):
        path = derived / str(item["path"])
        if not path.is_file() or elo.sha256_file(path) != item.get("sha256"):
            raise ValueError(f"sentinel Elo reference manifest mismatch: {path}")
    calibration = read_json(calibration_path)
    if calibration.get("schema") != "player-sentinel-elo-calibration-v1":
        raise ValueError("unsupported sentinel Elo calibration schema")
    return {
        "config": config,
        "configPath": config_path,
        "derived": derived,
        "recordsPath": records_path,
        "manifestPath": manifest_path,
        "calibrationPath": calibration_path,
        "manifestSha256": elo.sha256_file(manifest_path),
        "calibrationSha256": elo.sha256_file(calibration_path),
        "calibration": calibration,
    }


def write_estimate_outputs(output_dir: Path, payload: dict[str, Any], curve: dict[str, Any]) -> None:
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
        refuse_existing=False,
    )
    elo.write_csv(output_dir / games_name, payload.get("gameDiagnostics", []), refuse_existing=False)
    elo.write_csv(output_dir / phase_name, payload.get("phaseDiagnostics", []), refuse_existing=False)
    payload["gamesFile"] = games_name
    payload["phaseDiagnosticsFile"] = phase_name
    elo.write_json(output_dir / "estimated_elo.json", payload, refuse_existing=False)


def legacy_summary(output_dir: Path) -> dict[str, Any]:
    paths = {
        "scores": output_dir / "per_game_reference_scores.json",
        "scan": output_dir / "sentinel_scan_results.json",
        "pseudoScan": output_dir / "pseudo_scan_summary.json",
        "selection": output_dir / "selection_manifest.json",
        "modelGroups": output_dir / "model_review_groups.json",
    }
    for label, path in paths.items():
        require_file(path, f"legacy sentinel {label} output")
    scores = read_json(paths["scores"])
    scan = read_json(paths["scan"])
    selection = read_json(paths["selection"])
    return {
        "classification": scan.get("classification"),
        "selectedK": scan.get("selectedK"),
        "reportedGameIds": scan.get("reportedGameIds", []),
        "modelReviewReady": selection.get("modelReviewReady"),
        "targetRecordCount": scores.get("targetRecordCount"),
        "calibratableGameCount": scores.get("calibratableGameCount"),
        "excludedReferenceGameCount": scores.get("excludedReferenceGameCount"),
        "selection": selection,
        "sentinelScan": scan,
        "outputArtifacts": {
            label: {
                "path": str(path.resolve()),
                "sha256": elo.sha256_file(path),
            }
            for label, path in paths.items()
        },
    }


def command_run(args: argparse.Namespace) -> int:
    output_dir = require_directory(args.output_dir.resolve(), "sentinel unified output directory")
    reference = load_elo_reference(args.elo_reference_config.resolve())
    config = reference["config"]
    records = elo.reference_records_from_directory(reference["derived"], config=config)
    calibration = reference["calibration"]
    target_records = elo.target_records_from_inputs(
        args.bundle.resolve(),
        args.engine_dir.resolve(),
        args.offbook_records.resolve(),
        args.account,
        config=config,
    )
    estimate = elo.estimate_database_calibrated_range(
        args.account,
        target_records,
        records,
        config=config,
        calibration=calibration,
        reference_version=reference["derived"].name,
        reference_manifest_sha256=reference["manifestSha256"],
        calibration_version=reference["calibrationSha256"],
    )
    estimate_dir = output_dir / "estimated_elo"
    write_estimate_outputs(estimate_dir, estimate.payload, estimate.curve)
    unified = {
        "schema": SCHEMA_UNIFIED,
        "account": args.account,
        "createdAt": utc_now(),
        "legacySentinel": legacy_summary(output_dir),
        "estimatedElo": estimate.payload,
        "reference": {
            "version": reference["derived"].name,
            "manifestSha256": reference["manifestSha256"],
            "calibrationSha256": reference["calibrationSha256"],
            "calibrationStatus": calibration.get("status"),
        },
        "estimatedEloArtifacts": {
            "directory": str(estimate_dir.resolve()),
            "sha256": elo.sha256_file(estimate_dir / "estimated_elo.json"),
        },
    }
    elo.write_json(output_dir / "sentinel_unified_analysis.json", unified, refuse_existing=False)
    print(json.dumps({
        "account": args.account,
        "legacyClassification": unified["legacySentinel"]["classification"],
        "reportedGameCount": len(unified["legacySentinel"]["reportedGameIds"]),
        "estimatedEloStatus": estimate.payload.get("status"),
        "estimatedElo": estimate.payload.get("estimatedElo"),
        "selectedGameCount": estimate.payload.get("selectedGameCount"),
        "output": str((output_dir / "sentinel_unified_analysis.json").resolve()),
    }, ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run", help="combine legacy sentinel outputs with estimated Elo")
    run.add_argument("--account", required=True)
    run.add_argument("--bundle", type=Path, required=True)
    run.add_argument("--engine-dir", type=Path, required=True)
    run.add_argument("--offbook-records", type=Path, required=True)
    run.add_argument("--elo-reference-config", type=Path, required=True)
    run.add_argument("--output-dir", type=Path, required=True)
    run.set_defaults(handler=command_run)
    return parser


def load_script(path: Path, module_name: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import compatibility CLI: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args or args[0] in {"-h", "--help"}:
        build_parser().print_help()
        print(
            "\nCompatibility command families: "
            "acquire/build-reference/score/scan/freeze and "
            "build-elo-reference/calibrate-elo/estimate-elo."
        )
        return 0 if args else 2
    command = args[0]
    if command == "run":
        parsed = build_parser().parse_args(args)
        return int(parsed.handler(parsed))
    if command in LEGACY_COMMANDS:
        legacy = load_script(TOOLKIT_ROOT / "scripts" / "analysis" / "sentinel_analysis.py", "sentinel_legacy_cli")
        return int(legacy.main(args))
    if command in ELO_COMMANDS:
        elo_cli = load_script(TOOLKIT_ROOT / "scripts" / "analysis" / "sentinel_elo_analysis.py", "sentinel_elo_cli")
        return int(elo_cli.main(args))
    raise ValueError(f"unknown unified sentinel command: {command}")


if __name__ == "__main__":
    raise SystemExit(main())
