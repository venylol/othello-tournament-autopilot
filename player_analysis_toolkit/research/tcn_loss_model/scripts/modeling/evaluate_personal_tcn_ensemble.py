#!/usr/bin/env python3
"""Predict reported games with personal TCN members and whole-game bootstrap."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import torch

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.checkpoint import load_checkpoint_payload, load_transferred_model, load_transferred_profile_model, sha256_file
from src.oq_profile_features import OQ_PROFILE_FEATURE_NAMES, profile_ablation_hash
from src.data_contract import validate_model_ready_npz

METRICS = {
    "ge4": ("actual_loss_ge4", "probability_loss_ge4"),
    "zero": ("actual_loss_zero", "probability_loss_zero"),
    "ge10": ("actual_loss_ge10", "probability_loss_ge10"),
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--personal-ensemble-manifest", type=Path, required=True)
    parser.add_argument("--base-checkpoint", type=Path, required=True)
    parser.add_argument("--reported-game", action="append", required=True)
    parser.add_argument("--offbook-ply", action="append", required=True, help="GAME_ID=PLY")
    parser.add_argument("--node-output", type=Path, required=True)
    parser.add_argument("--summary-output", type=Path, required=True)
    parser.add_argument("--bootstrap-replicates", type=int, default=10000)
    parser.add_argument("--bootstrap-seed", type=int, default=20260803)
    parser.add_argument("--device", default="cuda:0")
    return parser.parse_args()


def parse_mapping(items: list[str]) -> dict[str, int]:
    result = {}
    for item in items:
        key, separator, value = item.partition("=")
        if not separator:
            raise ValueError(f"expected GAME_ID=PLY, got {item!r}")
        result[key] = int(value)
    return result


def bootstrap_draws(replicates: int, member_count: int, game_count: int, seed: int) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    member_draws = rng.integers(0, member_count, size=(replicates, member_count))
    game_draws = rng.integers(0, game_count, size=(replicates, game_count))
    return member_draws, game_draws


def quantiles(values: np.ndarray) -> dict[str, float]:
    lower, upper = np.quantile(values, [0.025, 0.975])
    return {"lower": float(lower), "upper": float(upper)}


def summarize_group(frame: pd.DataFrame, member_probabilities: dict[str, np.ndarray], game_ids: list[str],
                    member_draws: np.ndarray, game_draws: np.ndarray) -> dict[str, Any]:
    use = frame["game_id"].isin(game_ids).to_numpy()
    group = frame.loc[use].reset_index(drop=True)
    games = np.asarray(game_ids)
    group_member_probabilities = {name: values[:, use] for name, values in member_probabilities.items()}
    point_estimates: dict[str, Any] = {}
    group_game_values = group["game_id"].to_numpy()
    for metric, (actual_column, _probability_column) in METRICS.items():
        actual = group[actual_column].to_numpy(dtype=float)
        ensemble_probability = group_member_probabilities[metric].mean(axis=0)
        residual = actual - ensemble_probability
        per_game = []
        for game_id in game_ids:
            game_mask = group_game_values == game_id
            per_game.append({
                "gameId": game_id, "nodes": int(game_mask.sum()),
                "actualRate": float(actual[game_mask].mean()),
                "meanEnsembleProbability": float(ensemble_probability[game_mask].mean()),
                "actualMinusExpected": float(residual[game_mask].mean()),
            })
        point_estimates[metric] = {
            "gameEqualActualRate": float(np.mean([item["actualRate"] for item in per_game])),
            "gameEqualMeanEnsembleProbability": float(np.mean([item["meanEnsembleProbability"] for item in per_game])),
            "gameEqualActualMinusExpected": float(np.mean([item["actualMinusExpected"] for item in per_game])),
            "perGame": per_game,
        }

    replicates = len(member_draws)
    bootstrap_values = {metric: np.zeros(replicates, dtype=np.float64) for metric in METRICS}
    for replicate in range(replicates):
        selected_members = member_draws[replicate]
        selected_game_ids = games[game_draws[replicate]]
        for metric, (actual_column, _probability_column) in METRICS.items():
            probabilities = group_member_probabilities[metric][selected_members].mean(axis=0)
            residual = group[actual_column].to_numpy(dtype=float) - probabilities
            bootstrap_values[metric][replicate] = np.mean([
                residual[group_game_values == game_id].mean() for game_id in selected_game_ids
            ])
    intervals = {metric: quantiles(values) for metric, values in bootstrap_values.items()}
    return {
        "gameIds": game_ids, "nodes": int(len(group)), "aggregationUnit": "whole-game",
        "pointEstimates": point_estimates, "bootstrap95PercentIntervals": intervals,
    }


@torch.no_grad()
def main() -> int:
    started_clock = time.perf_counter()
    started_at = datetime.now(timezone.utc).isoformat()
    args = parse_args()
    if args.device.startswith("cuda") and not torch.cuda.is_available():
        raise RuntimeError("CUDA requested but unavailable")
    base = load_checkpoint_payload(args.base_checkpoint)
    manifest = json.loads(args.personal_ensemble_manifest.read_text(encoding="utf-8"))
    members = manifest.get("members", [])
    if len(members) != 12:
        raise ValueError(f"expected exactly 12 personal members, found {len(members)}")
    first_base_member = torch.load(Path(members[0]["baseEnsembleCheckpoint"]), map_location="cpu", weights_only=False)
    use_oq_profile = first_base_member.get("schema") == "tcn-loss-profile-checkpoint-v1"
    profile_manifest = first_base_member.get("manifest", {})
    profile_ablation = str(profile_manifest.get("oqProfileAblation") or "")
    validation = validate_model_ready_npz(
        args.data, expected_input_features=base["input_features"],
        expected_board_channels=base["board_encoding"]["cnn_channels"],
        expected_preprocessing_sha256=hashlib.sha256(json.dumps(base["preprocessing"], sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest(),
        require_oq_profile=use_oq_profile,
        expected_oq_profile_feature_names=OQ_PROFILE_FEATURE_NAMES if use_oq_profile else None,
        expected_oq_profile_preprocessing_sha256=profile_manifest.get("oqProfilePreprocessingSha256") if use_oq_profile else None,
        expected_oq_profile_policy=profile_manifest.get("oqProfilePolicy") if use_oq_profile else None,
    )
    if use_oq_profile and profile_manifest.get("oqProfileAblationSha256") != profile_ablation_hash(profile_ablation):
        raise ValueError("OQ profile ablation hash mismatch")
    reported = args.reported_game
    offbook = parse_mapping(args.offbook_ply)
    if set(reported) != set(offbook):
        raise ValueError("every reported game must have exactly one offbook ply")
    device = torch.device(args.device)
    with np.load(args.data, allow_pickle=False) as data:
        games, steps = data["X"].shape[:2]
        valid = data["mask"].astype(bool)
        game_grid = np.broadcast_to(data["game_id"][:, None], (games, steps)).astype(str)
        selected = valid & np.isin(game_grid, reported)
        ply = data["global_placement_ply"][selected]
        selected_games = game_grid[selected]
        after_offbook = np.asarray([node_ply >= offbook[game_id] for node_ply, game_id in zip(ply, selected_games, strict=True)])
        flat_indexes = np.flatnonzero(selected.reshape(-1))[after_offbook]
        base_columns = {
            "game_id": game_grid.reshape(-1)[flat_indexes],
            "player_id": data["player_id"].reshape(-1)[flat_indexes],
            "move_index": data["move_index"].reshape(-1)[flat_indexes],
            "global_placement_ply": data["global_placement_ply"].reshape(-1)[flat_indexes],
            "side_to_move": data["side_to_move"].reshape(-1)[flat_indexes],
            "actual_disc_loss": data["disc_loss"].reshape(-1)[flat_indexes],
            "actual_loss_zero": data["label_zero"].reshape(-1)[flat_indexes],
            "actual_loss_ge4": data["label_ge4"].reshape(-1)[flat_indexes],
            "actual_loss_ge10": data["label_ge10"].reshape(-1)[flat_indexes],
            "raw_thinking_time_ms": data["raw_thinking_time_ms"].reshape(-1)[flat_indexes],
            "effective_thinking_time_ms": data["effective_thinking_time_ms"].reshape(-1)[flat_indexes],
        }
        source_by_game = dict(zip(data["game_id"].astype(str), data["source_time_limit_ms"].astype(int), strict=True))
        scale_by_game = dict(zip(data["game_id"].astype(str), data["time_scale_factor"].astype(float), strict=True))
        base_columns["source_time_limit_ms"] = [source_by_game[game_id] for game_id in base_columns["game_id"]]
        base_columns["effective_time_limit_ms"] = 300000
        base_columns["time_scale_factor"] = [scale_by_game[game_id] for game_id in base_columns["game_id"]]
        base_columns["time_control_policy"] = str(data["time_control_policy"].item())
        model_inputs = {
            name: torch.from_numpy(data[name]).to(device)
            for name in ("X", "board_tokens", "board_move_tokens", "current_hint_tokens", "current_hint_values", "prev_own_hint_values", "actual_thinking_time_ms")
        }
        if use_oq_profile:
            model_inputs["oq_profile_features"] = torch.from_numpy(data["oq_profile_features"]).float().to(device)
            model_inputs["oq_profile_missing"] = torch.from_numpy(data["oq_profile_missing"]).to(device)
    frame = pd.DataFrame(base_columns)
    member_classes = []
    for member in members:
        checkpoint_path = Path(member["personalCheckpoint"])
        saved = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
        if saved.get("schema") != "personal-tcn-adapter-v1":
            raise ValueError(f"personal adapter checkpoint schema mismatch: {checkpoint_path}")
        base_member = torch.load(Path(member["baseEnsembleCheckpoint"]), map_location="cpu", weights_only=False)
        expected_schema = "tcn-loss-profile-checkpoint-v1" if use_oq_profile else "tcn-loss-checkpoint-v1"
        if base_member.get("schema") != expected_schema:
            raise ValueError("personal adapter base ensemble checkpoint schema mismatch")
        model, _ = (
            load_transferred_profile_model(args.base_checkpoint, profile_ablation)
            if use_oq_profile else load_transferred_model(args.base_checkpoint)
        )
        model.load_state_dict(base_member["modelStateDict"], strict=True)
        model.to(device).eval()
        model_args = (
            model_inputs["X"].float(), model_inputs["board_tokens"], model_inputs["board_move_tokens"],
            model_inputs["current_hint_tokens"], model_inputs["current_hint_values"].float(),
            model_inputs["prev_own_hint_values"].float(), model_inputs["actual_thinking_time_ms"].float(),
        )
        output = model(
            *model_args, model_inputs["oq_profile_features"], model_inputs["oq_profile_missing"]
        ) if use_oq_profile else model(*model_args)
        base_logits = output.severity_logits.detach().cpu().double().reshape(-1, 4)[flat_indexes]
        hidden = output.severity_hidden.detach().cpu().double().reshape(-1, 64)[flat_indexes]
        probabilities = torch.softmax(base_logits + hidden @ saved["deltaW"].double() + saved["deltaB"].double(), dim=-1).numpy()
        if not np.all(np.isfinite(probabilities)) or not np.allclose(probabilities.sum(axis=1), 1.0, atol=1e-6):
            raise ValueError("non-finite or non-unit personal class probabilities")
        member_classes.append(probabilities)
        member_index = int(member["member"])
        for class_index, class_name in enumerate(("zero", "1_3", "4_9", "ge10")):
            frame[f"member_{member_index:02d}_probability_class_{class_name}"] = probabilities[:, class_index]
        frame[f"member_{member_index:02d}_probability_loss_ge4"] = probabilities[:, 2] + probabilities[:, 3]
        del model, output
        if device.type == "cuda":
            torch.cuda.empty_cache()
    classes = np.stack(member_classes)
    ensemble_classes = classes.mean(axis=0)
    for class_index, class_name in enumerate(("zero", "1_3", "4_9", "ge10")):
        frame[f"ensemble_probability_class_{class_name}"] = ensemble_classes[:, class_index]
    frame["probability_loss_zero"] = ensemble_classes[:, 0]
    frame["probability_loss_ge4"] = ensemble_classes[:, 2] + ensemble_classes[:, 3]
    frame["probability_loss_ge10"] = ensemble_classes[:, 3]
    for metric, (actual_column, probability_column) in METRICS.items():
        frame[f"actual_minus_expected_{metric}"] = frame[actual_column] - frame[probability_column]
    args.node_output.parent.mkdir(parents=True, exist_ok=True)
    frame.to_csv(args.node_output, index=False, encoding="utf-8")

    member_probabilities = {
        "zero": classes[:, :, 0], "ge4": classes[:, :, 2] + classes[:, :, 3], "ge10": classes[:, :, 3],
    }
    group_results = {}
    for game_id in reported:
        member_draws, game_draws = bootstrap_draws(args.bootstrap_replicates, len(members), 1, args.bootstrap_seed)
        group_results[game_id] = summarize_group(frame, member_probabilities, [game_id], member_draws, game_draws)
    member_draws, game_draws = bootstrap_draws(args.bootstrap_replicates, len(members), len(reported), args.bootstrap_seed)
    group_results["combined"] = summarize_group(frame, member_probabilities, reported, member_draws, game_draws)
    compositions, counts = np.unique(np.sort(game_draws, axis=1), axis=0, return_counts=True)
    summary = {
        "schema": "personal-tcn-reported-bootstrap-v1", "status": "completed",
        "interpretation": "actual indicator minus twelve-personal-model ensemble probability",
        "notCheatingProbability": True, "reportedGames": reported,
        "offbookGlobalPlacementPlyInclusive": offbook,
        "memberCount": len(members), "bootstrapReplicates": args.bootstrap_replicates,
        "bootstrapSeed": args.bootstrap_seed,
        "modelVariant": "oq-profile" if use_oq_profile else "baseline",
        "oqProfileAblation": profile_ablation if use_oq_profile else "",
        "bootstrapProtocol": {
            "memberDraw": "12 members with replacement, averaged within replicate",
            "gameDraw": "whole reported games with replacement, same count as observed games",
            "sharedDraws": "one member draw and one whole-game draw shared by ge4/zero/ge10 within each replicate",
            "phaseBinning": "none",
            "minimumStatisticalUnit": "whole-game",
            "controlGamesResampled": False,
            "conditionedOnCompleteControlSet": True,
            "firstFiveMemberDraws": member_draws[:5].tolist(),
            "firstFiveGameDraws": game_draws[:5].tolist(),
            "combinedGameDrawCompositionCounts": [
                {"gameIndexes": row.tolist(), "count": int(count)} for row, count in zip(compositions, counts, strict=True)
            ],
        },
        "groups": group_results,
        "nodePredictions": str(args.node_output.resolve()), "nodePredictionsSha256": sha256_file(args.node_output),
        "dataValidation": validation,
        "timing": {
            "startedAtUtc": started_at,
            "completedAtUtc": datetime.now(timezone.utc).isoformat(),
            "elapsedSeconds": time.perf_counter() - started_clock,
        },
        "limitations": [
            "The five-minute reported group contains one game.",
            "The ten-minute game is an exploratory linear 0.5 clock-normalized estimate, not native ten-minute support.",
            "Intervals quantify finite ensemble and whole-game sampling under the complete fixed personal control set; they are not cheating probabilities.",
        ],
    }
    args.summary_output.parent.mkdir(parents=True, exist_ok=True)
    args.summary_output.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
