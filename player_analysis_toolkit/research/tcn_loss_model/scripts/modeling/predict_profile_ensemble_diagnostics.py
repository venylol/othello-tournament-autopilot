#!/usr/bin/env python3
"""Write compact node predictions for a completed Profile ensemble diagnostic plot."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import torch

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.checkpoint import load_checkpoint_payload, load_transferred_profile_model, sha256_file
from src.data_contract import validate_model_ready_npz
from src.oq_profile_features import OQ_PROFILE_FEATURE_NAMES, profile_ablation_hash


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--ensemble-manifest", type=Path, required=True)
    parser.add_argument("--base-checkpoint", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--split", choices=("train", "validation", "test"), default="test")
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--batch-size", type=int, default=64)
    args = parser.parse_args()
    if args.output.exists():
        raise FileExistsError(f"refusing to overwrite: {args.output}")
    if args.device.startswith("cuda") and not torch.cuda.is_available():
        raise RuntimeError("CUDA requested but unavailable")

    ensemble = json.loads(args.ensemble_manifest.read_text(encoding="utf-8"))
    members = ensemble.get("members", [])
    if ensemble.get("status") != "completed" or not members:
        raise ValueError("ensemble manifest is not completed")
    first = torch.load(Path(members[0]["bestCheckpoint"]), map_location="cpu", weights_only=False)
    trained_manifest = first["manifest"]
    ablation = str(trained_manifest["oqProfileAblation"])
    if trained_manifest.get("oqProfileAblationSha256") != profile_ablation_hash(ablation):
        raise ValueError("Profile ablation hash mismatch")
    base = load_checkpoint_payload(args.base_checkpoint)
    validation = validate_model_ready_npz(
        args.data,
        expected_input_features=base["input_features"],
        expected_board_channels=base["board_encoding"]["cnn_channels"],
        require_oq_profile=True,
        expected_oq_profile_feature_names=OQ_PROFILE_FEATURE_NAMES,
        expected_oq_profile_preprocessing_sha256=trained_manifest["oqProfilePreprocessingSha256"],
        expected_oq_profile_policy=trained_manifest["oqProfilePolicy"],
    )
    device = torch.device(args.device)
    with np.load(args.data, allow_pickle=False) as data:
        selected_games = np.flatnonzero(data["split"].astype(str) == args.split)
        if not len(selected_games):
            raise ValueError(f"data contain no {args.split} games")
        names = (
            "X", "board_tokens", "board_move_tokens", "current_hint_tokens", "current_hint_values",
            "prev_own_hint_values", "actual_thinking_time_ms", "oq_profile_features",
            "oq_profile_missing", "mask", "game_id", "global_placement_ply", "disc_loss",
            "label_zero", "label_ge4", "label_ge10",
        )
        selected = {name: data[name][selected_games].copy() for name in names}
        probability_sum = np.zeros((*selected["X"].shape[:2], 4), dtype=np.float64)
        for member in members:
            checkpoint_path = Path(member["bestCheckpoint"])
            saved = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
            if saved.get("schema") != "tcn-loss-profile-checkpoint-v1":
                raise ValueError(f"not a Profile checkpoint: {checkpoint_path}")
            identity = saved["manifest"]
            for key in ("oqProfileAblation", "oqProfileAblationSha256", "oqProfilePreprocessingSha256", "oqProfilePolicy"):
                if identity.get(key) != trained_manifest.get(key):
                    raise ValueError(f"ensemble member Profile identity mismatch: {key}")
            if identity.get("baseCheckpointSha256") != sha256_file(args.base_checkpoint):
                raise ValueError("ensemble member base checkpoint mismatch")
            model, _ = load_transferred_profile_model(args.base_checkpoint, ablation)
            model.load_state_dict(saved["modelStateDict"], strict=True)
            model.to(device).eval()
            with torch.no_grad():
                for start in range(0, len(selected_games), args.batch_size):
                    indexes = slice(start, min(start + args.batch_size, len(selected_games)))
                    output = model(
                        torch.from_numpy(selected["X"][indexes]).float().to(device),
                        torch.from_numpy(selected["board_tokens"][indexes]).to(device),
                        torch.from_numpy(selected["board_move_tokens"][indexes]).to(device),
                        torch.from_numpy(selected["current_hint_tokens"][indexes]).to(device),
                        torch.from_numpy(selected["current_hint_values"][indexes]).float().to(device),
                        torch.from_numpy(selected["prev_own_hint_values"][indexes]).float().to(device),
                        torch.from_numpy(selected["actual_thinking_time_ms"][indexes]).float().to(device),
                        torch.from_numpy(selected["oq_profile_features"][indexes]).float().to(device),
                        torch.from_numpy(selected["oq_profile_missing"][indexes]).to(device),
                    )
                    probability_sum[indexes] += output.severity_class_probabilities.cpu().numpy()
            del model
            if device.type == "cuda":
                torch.cuda.empty_cache()
        probabilities = probability_sum / len(members)
        selected_mask = selected["mask"].astype(bool)
        games, steps = selected_mask.shape
        game_grid = np.broadcast_to(selected["game_id"][:, None], (games, steps))
        split_grid = np.full((games, steps), args.split)
        frame = pd.DataFrame({
            "game_id": game_grid[selected_mask], "split": split_grid[selected_mask],
            "global_placement_ply": selected["global_placement_ply"][selected_mask],
            "actual_disc_loss": selected["disc_loss"][selected_mask],
            "actual_loss_zero": selected["label_zero"][selected_mask],
            "actual_loss_ge4": selected["label_ge4"][selected_mask],
            "actual_loss_ge10": selected["label_ge10"][selected_mask],
            "probability_loss_zero": probabilities[..., 0][selected_mask],
            "probability_loss_ge4": (probabilities[..., 2] + probabilities[..., 3])[selected_mask],
            "probability_loss_ge10": probabilities[..., 3][selected_mask],
        })
    args.output.parent.mkdir(parents=True, exist_ok=True)
    frame.to_csv(args.output, index=False, encoding="utf-8")
    print(json.dumps({
        "ok": True, "members": len(members), "split": args.split,
        "games": int(frame["game_id"].nunique()), "rows": len(frame),
        "output": str(args.output.resolve()), "dataValidation": validation["ok"],
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
