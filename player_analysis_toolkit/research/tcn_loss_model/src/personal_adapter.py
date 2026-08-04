"""Frozen-base 64-to-4 personal residual-logit adapters trained game-equally."""

from __future__ import annotations

import hashlib
import json
import os
import time
from datetime import datetime, timezone
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np
import torch
from torch.nn import functional as F

from .checkpoint import load_transferred_model, load_transferred_profile_model, sha256_file
from .oq_profile_features import OQ_PROFILE_FEATURE_NAMES, profile_ablation_hash
from .data_contract import validate_model_ready_npz
from .feature_policy import INPUT_POLICY
from .progress import atomic_write_json


@dataclass(frozen=True)
class AdapterConfig:
    optimizer: str
    max_iter: int
    line_search_fn: str
    tolerance_grad: float
    tolerance_change: float
    kl_weight: float
    delta_w_l2_weight: float
    delta_b_l2_weight: float

    @classmethod
    def load(cls, path: Path) -> "AdapterConfig":
        payload = json.loads(path.read_text(encoding="utf-8"))
        if payload.get("schema") != "tcn-loss-personal-adapter-config-v1":
            raise ValueError("personal adapter config schema mismatch")
        if payload.get("input_policy") != INPUT_POLICY:
            raise ValueError("personal adapter input policy mismatch")
        values = {key: value for key, value in payload.items() if key not in {"schema", "input_policy"}}
        cfg = cls(**values)
        if cfg.optimizer != "LBFGS" or cfg.line_search_fn != "strong_wolfe":
            raise ValueError("the formal personal adapter supports only deterministic LBFGS strong_wolfe")
        if cfg.max_iter <= 0 or min(cfg.kl_weight, cfg.delta_w_l2_weight, cfg.delta_b_l2_weight) < 0:
            raise ValueError("invalid adapter optimization configuration")
        return cfg


def _state_sha256(model: torch.nn.Module) -> str:
    digest = hashlib.sha256()
    for name, value in model.state_dict().items():
        digest.update(name.encode("utf-8")); digest.update(b"\0")
        array = value.detach().cpu().contiguous().numpy()
        digest.update(str(array.dtype).encode("ascii")); digest.update(str(array.shape).encode("ascii"))
        digest.update(array.tobytes())
    return digest.hexdigest()


def _save(path: Path, payload: dict[str, Any]) -> None:
    temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
    torch.save(payload, temporary)
    os.replace(temporary, path)


def _per_game_mean(values: torch.Tensor, game_index: torch.Tensor, game_count: int) -> torch.Tensor:
    sums = torch.zeros(game_count, dtype=values.dtype, device=values.device).scatter_add(0, game_index, values)
    counts = torch.zeros(game_count, dtype=values.dtype, device=values.device).scatter_add(
        0, game_index, torch.ones_like(values)
    )
    # A retained record in which the target never moved has no eligible term.
    # It contributes zero, while remaining in the fixed all-record denominator.
    return (sums / counts.clamp_min(1)).mean()


def adapter_objective(
    hidden: torch.Tensor, base_logits: torch.Tensor, targets: torch.Tensor,
    game_index: torch.Tensor, game_count: int, delta_w: torch.Tensor, delta_b: torch.Tensor,
    cfg: AdapterConfig,
) -> dict[str, torch.Tensor]:
    personal_logits = base_logits + hidden @ delta_w + delta_b
    log_personal = F.log_softmax(personal_logits, dim=-1)
    base_probability = F.softmax(base_logits, dim=-1)
    log_base = F.log_softmax(base_logits, dim=-1)
    cross_entropy_by_node = F.nll_loss(log_personal, targets, reduction="none")
    kl_by_node = (base_probability * (log_base - log_personal)).sum(dim=-1)
    cross_entropy = _per_game_mean(cross_entropy_by_node, game_index, game_count)
    kl = _per_game_mean(kl_by_node, game_index, game_count)
    delta_w_l2 = delta_w.square().sum()
    delta_b_l2 = delta_b.square().sum()
    total = cross_entropy + cfg.kl_weight * kl + cfg.delta_w_l2_weight * delta_w_l2 + cfg.delta_b_l2_weight * delta_b_l2
    return {"total": total, "gameEqualCrossEntropy": cross_entropy, "gameEqualKlBaseToPersonal": kl,
            "deltaWL2": delta_w_l2, "deltaBL2": delta_b_l2}


@torch.no_grad()
def _extract_control_representation(data_path: Path, base_checkpoint: Path, trained_checkpoint: Path):
    trained = torch.load(trained_checkpoint, map_location="cpu", weights_only=False)
    use_oq_profile = trained.get("schema") == "tcn-loss-profile-checkpoint-v1"
    if trained.get("schema") not in {"tcn-loss-checkpoint-v1", "tcn-loss-profile-checkpoint-v1"}:
        raise ValueError("ensemble member checkpoint schema mismatch")
    if trained["manifest"].get("baseCheckpointSha256") != sha256_file(base_checkpoint):
        raise ValueError("ensemble member official checkpoint mismatch")
    trained_manifest = trained["manifest"]
    profile_ablation = str(trained_manifest.get("oqProfileAblation") or "")
    if use_oq_profile:
        if trained_manifest.get("oqProfileAblationSha256") != profile_ablation_hash(profile_ablation):
            raise ValueError("ensemble member OQ profile ablation hash mismatch")
        validate_model_ready_npz(
            data_path, require_oq_profile=True,
            expected_oq_profile_feature_names=OQ_PROFILE_FEATURE_NAMES,
            expected_oq_profile_preprocessing_sha256=trained_manifest.get("oqProfilePreprocessingSha256"),
            expected_oq_profile_policy=trained_manifest.get("oqProfilePolicy"),
        )
        model, base_payload = load_transferred_profile_model(base_checkpoint, profile_ablation)
    else:
        validate_model_ready_npz(data_path)
        model, base_payload = load_transferred_model(base_checkpoint)
    model.load_state_dict(trained["modelStateDict"], strict=True)
    for parameter in model.parameters():
        parameter.requires_grad_(False)
    model.eval()
    before_hash = _state_sha256(model)
    device = torch.device("cuda:0" if torch.cuda.is_available() else "cpu")
    model.to(device)
    with np.load(data_path, allow_pickle=False) as data:
        splits = data["split"].astype(str)
        selected_games = np.flatnonzero(splits == "train")
        game_ids = data["game_id"].astype(str)[selected_games].tolist()
        reported = data["game_id"].astype(str)[splits == "test"].tolist()
        hidden_parts, logits_parts, target_parts, game_parts, counts = [], [], [], [], []
        for local_game_index, source_game_index in enumerate(selected_games):
            sl = slice(source_game_index, source_game_index + 1)
            model_args = (
                torch.from_numpy(data["X"][sl]).float().to(device),
                torch.from_numpy(data["board_tokens"][sl]).to(device),
                torch.from_numpy(data["board_move_tokens"][sl]).to(device),
                torch.from_numpy(data["current_hint_tokens"][sl]).to(device),
                torch.from_numpy(data["current_hint_values"][sl]).float().to(device),
                torch.from_numpy(data["prev_own_hint_values"][sl]).float().to(device),
                torch.from_numpy(data["actual_thinking_time_ms"][sl]).float().to(device),
            )
            output = model(
                *model_args,
                torch.from_numpy(data["oq_profile_features"][sl]).float().to(device),
                torch.from_numpy(data["oq_profile_missing"][sl]).to(device),
            ) if use_oq_profile else model(*model_args)
            mask = torch.from_numpy(data["mask"][sl]).bool().to(device)
            node_count = int(mask.sum().item())
            if node_count:
                hidden_parts.append(output.severity_hidden[mask].detach().cpu().double())
                logits_parts.append(output.severity_logits[mask].detach().cpu().double())
                target_parts.append(torch.from_numpy(data["severity_class"][sl])[mask.cpu()].long())
                game_parts.append(torch.full((node_count,), local_game_index, dtype=torch.long))
            counts.append(node_count)
    after_hash = _state_sha256(model)
    if before_hash != after_hash:
        raise AssertionError("frozen base model parameters changed during representation extraction")
    return (
        torch.cat(hidden_parts), torch.cat(logits_parts), torch.cat(target_parts), torch.cat(game_parts),
        game_ids, reported, counts, before_hash, base_payload, use_oq_profile, profile_ablation,
    )


def train_adapter_member(data_path: Path, base_checkpoint: Path, trained_checkpoint: Path,
                         config_path: Path, output_dir: Path, member_index: int) -> dict[str, Any]:
    started = time.perf_counter()
    cfg = AdapterConfig.load(config_path)
    output_dir.mkdir(parents=True, exist_ok=True)
    checkpoint_path = output_dir / "personal_adapter.pt"
    manifest_path = output_dir / "personal_adapter_manifest.json"
    expected = {
        "member": member_index, "baseEnsembleCheckpointSha256": sha256_file(trained_checkpoint),
        "personalDataSha256": sha256_file(data_path), "configSha256": sha256_file(config_path),
    }
    if checkpoint_path.is_file() and manifest_path.is_file():
        existing = json.loads(manifest_path.read_text(encoding="utf-8"))
        if all(existing.get(key) == value for key, value in expected.items()):
            return {**existing, "personalCheckpoint": str(checkpoint_path.resolve()),
                    "personalCheckpointSha256": sha256_file(checkpoint_path)}
        raise ValueError(f"personal adapter member {member_index} manifest mismatch")
    hidden, base_logits, targets, game_index, control_ids, reported_ids, node_counts, frozen_hash, base_payload, use_oq_profile, profile_ablation = _extract_control_representation(
        data_path, base_checkpoint, trained_checkpoint
    )
    if len(control_ids) != 28 or len(reported_ids) != 2 or set(control_ids) & set(reported_ids):
        raise ValueError(f"expected 28 disjoint controls and 2 reported games, found {len(control_ids)} and {len(reported_ids)}")
    if hidden.shape[1] != 64:
        raise ValueError(f"severity_hidden must have 64 features, got {hidden.shape}")
    delta_w = torch.nn.Parameter(torch.zeros((64, 4), dtype=torch.float64))
    delta_b = torch.nn.Parameter(torch.zeros(4, dtype=torch.float64))
    initial_probability = F.softmax(base_logits + hidden @ delta_w + delta_b, dim=-1)
    base_probability = F.softmax(base_logits, dim=-1)
    identity_max_difference = float((initial_probability - base_probability).abs().max().item())
    if identity_max_difference != 0.0:
        raise AssertionError("zero-initialized personal adapter is not exactly identity")
    initial = adapter_objective(hidden, base_logits, targets, game_index, len(control_ids), delta_w, delta_b, cfg)
    optimizer = torch.optim.LBFGS(
        [delta_w, delta_b], max_iter=cfg.max_iter, line_search_fn=cfg.line_search_fn,
        tolerance_grad=cfg.tolerance_grad, tolerance_change=cfg.tolerance_change,
    )
    evaluations = 0

    def closure() -> torch.Tensor:
        nonlocal evaluations
        optimizer.zero_grad(set_to_none=True)
        losses = adapter_objective(hidden, base_logits, targets, game_index, len(control_ids), delta_w, delta_b, cfg)
        losses["total"].backward()
        evaluations += 1
        return losses["total"]

    optimizer.step(closure)
    final = adapter_objective(hidden, base_logits, targets, game_index, len(control_ids), delta_w, delta_b, cfg)
    final_probability = F.softmax(base_logits + hidden @ delta_w + delta_b, dim=-1)
    if not bool(torch.isfinite(final_probability).all()) or not bool(torch.allclose(final_probability.sum(-1), torch.ones(len(final_probability), dtype=torch.float64), atol=1e-10)):
        raise ValueError("personal adapter produced invalid class probabilities")
    time_policy = ""
    with np.load(data_path, allow_pickle=False) as data:
        if "time_control_policy" in data.files:
            time_policy = str(data["time_control_policy"].item())
    manifest = {
        "schema": "personal-tcn-adapter-manifest-v1", **expected,
        "baseEnsembleCheckpoint": str(trained_checkpoint.resolve()),
        "officialBaseCheckpoint": str(base_checkpoint.resolve()),
        "officialBaseCheckpointSha256": sha256_file(base_checkpoint),
        "controlGameIds": control_ids, "controlNodeCountsByGame": dict(zip(control_ids, node_counts, strict=True)),
        "zeroTargetNodeControlGameIds": [game_id for game_id, count in zip(control_ids, node_counts, strict=True) if count == 0],
        "zeroTargetNodeConvention": "retained in the 28-record denominator with zero CE and KL contribution because the target player made no actual move",
        "reportedExcludedGameIds": reported_ids, "reportedExclusionVerified": True,
        "gameEqualWeighting": True, "adapterShape": {"deltaW": [64, 4], "deltaB": [4]},
        "trainableParameterCount": 260, "zeroInitializationIdentityMaxAbsDifference": identity_max_difference,
        "allBaseParametersFrozen": True, "frozenBaseStateSha256BeforeAndAfter": frozen_hash,
        "modelVariant": "oq-profile" if use_oq_profile else "baseline",
        "oqProfileAblation": profile_ablation if use_oq_profile else "",
        "timeControlPolicy": time_policy, "optimizer": asdict(cfg), "optimizerEvaluations": evaluations,
        "initialControlLoss": {key: float(value.detach()) for key, value in initial.items()},
        "finalControlLoss": {key: float(value.detach()) for key, value in final.items()},
        "averageKlDrift": float(final["gameEqualKlBaseToPersonal"].detach()),
        "fixedProtocolNoPersonalValidation": True, "fixedProtocolNoReportedStopping": True,
        "elapsedSeconds": time.perf_counter() - started,
    }
    checkpoint = {
        "schema": "personal-tcn-adapter-v1", "deltaW": delta_w.detach().cpu(), "deltaB": delta_b.detach().cpu(),
        "manifest": manifest,
    }
    _save(checkpoint_path, checkpoint)
    atomic_write_json(manifest_path, manifest)
    return {**manifest, "personalCheckpoint": str(checkpoint_path.resolve()),
            "personalCheckpointSha256": sha256_file(checkpoint_path)}


def train_adapter_ensemble(data_path: Path, base_checkpoint: Path, ensemble_manifest_path: Path,
                           config_path: Path, output_dir: Path) -> dict[str, Any]:
    started_clock = time.perf_counter()
    started_at = datetime.now(timezone.utc).isoformat()
    ensemble = json.loads(ensemble_manifest_path.read_text(encoding="utf-8"))
    members = ensemble.get("members", [])
    if ensemble.get("status") != "completed" or len(members) not in {1, 12}:
        raise ValueError("base ensemble must be a completed one-member smoke or formal twelve-member ensemble")
    output_dir.mkdir(parents=True, exist_ok=True)
    results = []
    for source_member in members:
        index = int(source_member["member"])
        atomic_write_json(output_dir / "personal_ensemble_progress.json", {
            "schema": "personal-tcn-adapter-ensemble-progress-v1", "status": "training",
            "currentMember": index, "memberCount": len(members), "completedMembers": len(results),
        })
        results.append(train_adapter_member(
            data_path, base_checkpoint, Path(source_member["bestCheckpoint"]), config_path,
            output_dir / "members" / f"member_{index:02d}", index,
        ))
    manifest = {
        "schema": "personal-tcn-adapter-ensemble-manifest-v1", "status": "completed",
        "baseEnsembleManifest": str(ensemble_manifest_path.resolve()),
        "baseEnsembleManifestSha256": sha256_file(ensemble_manifest_path),
        "personalData": str(data_path.resolve()), "personalDataSha256": sha256_file(data_path),
        "memberCount": len(results), "members": results,
        "startedAtUtc": started_at, "completedAtUtc": datetime.now(timezone.utc).isoformat(),
        "elapsedSeconds": time.perf_counter() - started_clock,
    }
    atomic_write_json(output_dir / "personal_ensemble_manifest.json", manifest)
    atomic_write_json(output_dir / "personal_ensemble_progress.json", {
        "schema": "personal-tcn-adapter-ensemble-progress-v1", "status": "completed",
        "memberCount": len(results), "completedMembers": len(results),
    })
    return manifest
