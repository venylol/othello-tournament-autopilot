"""Retained thinking-time head plus one time-conditioned four-class severity head."""

from __future__ import annotations

from dataclasses import dataclass

import torch
from torch import nn
from torch.nn import functional as F

from .backbone import BoardConditionedBackbone, ModelConfig
from .oq_profile_features import OQ_PROFILE_FEATURE_NAMES, profile_ablation_indices

SEVERITY_CLASS_NAMES = ("class_zero", "class_1_3", "class_4_9", "class_ge10")


@dataclass
class ModelOutput:
    pred_time_log_seconds: torch.Tensor
    severity_hidden: torch.Tensor
    severity_logits: torch.Tensor
    severity_class_probabilities: torch.Tensor
    probability_loss_zero: torch.Tensor
    probability_loss_positive: torch.Tensor
    probability_loss_ge4: torch.Tensor
    probability_loss_ge10: torch.Tensor


class TimeConditionedLossModel(nn.Module):
    def __init__(self, cfg: ModelConfig) -> None:
        super().__init__()
        self.backbone = BoardConditionedBackbone(cfg)
        hidden = cfg.channels // 2
        self.severity_context = nn.Sequential(
            nn.Linear(cfg.channels + 2, hidden), nn.GELU(), nn.Dropout(cfg.dropout)
        )
        self.severity_head = nn.Linear(hidden, len(SEVERITY_CLASS_NAMES))

    @staticmethod
    def actual_time_features(actual_thinking_time_ms: torch.Tensor) -> torch.Tensor:
        missing = ~torch.isfinite(actual_thinking_time_ms)
        seconds = torch.where(
            missing,
            torch.zeros_like(actual_thinking_time_ms),
            actual_thinking_time_ms.clamp_min(0) / 1000.0,
        )
        return torch.stack((torch.log1p(seconds), missing.to(seconds.dtype)), dim=-1)

    def forward(self, x: torch.Tensor, board_tokens: torch.Tensor, board_move_tokens: torch.Tensor,
                current_hint_tokens: torch.Tensor, current_hint_values: torch.Tensor,
                prev_own_hint_values: torch.Tensor, actual_thinking_time_ms: torch.Tensor) -> ModelOutput:
        latent = self.backbone.encode(
            x, board_tokens, board_move_tokens, current_hint_tokens,
            current_hint_values, prev_own_hint_values,
        )
        time_pred = self.backbone.head(latent.transpose(1, 2)).squeeze(1)
        severity_hidden = self.severity_context(
            torch.cat((latent, self.actual_time_features(actual_thinking_time_ms)), dim=-1)
        )
        logits = self.severity_head(severity_hidden)
        probabilities = torch.softmax(logits, dim=-1)
        probability_zero = probabilities[..., 0]
        probability_positive = 1.0 - probability_zero
        probability_ge4 = probabilities[..., 2] + probabilities[..., 3]
        probability_ge10 = probabilities[..., 3]
        return ModelOutput(
            time_pred, severity_hidden, logits, probabilities, probability_zero, probability_positive,
            probability_ge4, probability_ge10,
        )


class ProfileConditionedLossModel(TimeConditionedLossModel):
    """Independent Player-context schema; its zero FiLM projection is an exact identity."""

    def __init__(self, cfg: ModelConfig, profile_ablation: str = "full-31") -> None:
        super().__init__(cfg)
        indices = profile_ablation_indices(profile_ablation)
        if not indices:
            raise ValueError("profile-conditioned model requires at least one selected profile feature")
        self.profile_ablation = profile_ablation
        self.register_buffer(
            "oq_profile_feature_indices",
            torch.as_tensor(indices, dtype=torch.long),
            persistent=True,
        )
        embedding_dim = 32
        self.profile_encoder = nn.Sequential(
            nn.Linear(len(indices) * 2, embedding_dim),
            nn.GELU(),
            nn.Linear(embedding_dim, embedding_dim),
            nn.GELU(),
        )
        hidden = cfg.channels // 2
        self.profile_severity_film = nn.Linear(embedding_dim, hidden * 2)
        nn.init.zeros_(self.profile_severity_film.weight)
        nn.init.zeros_(self.profile_severity_film.bias)

    def forward(self, x: torch.Tensor, board_tokens: torch.Tensor, board_move_tokens: torch.Tensor,
                current_hint_tokens: torch.Tensor, current_hint_values: torch.Tensor,
                prev_own_hint_values: torch.Tensor, actual_thinking_time_ms: torch.Tensor,
                oq_profile_features: torch.Tensor, oq_profile_missing: torch.Tensor) -> ModelOutput:
        expected = (*x.shape[:2], len(OQ_PROFILE_FEATURE_NAMES))
        if tuple(oq_profile_features.shape) != expected or tuple(oq_profile_missing.shape) != expected:
            raise ValueError(
                f"expected OQ profile feature/missing shapes {expected}, got "
                f"{tuple(oq_profile_features.shape)} and {tuple(oq_profile_missing.shape)}"
            )
        latent = self.backbone.encode(
            x, board_tokens, board_move_tokens, current_hint_tokens,
            current_hint_values, prev_own_hint_values,
        )
        time_pred = self.backbone.head(latent.transpose(1, 2)).squeeze(1)
        severity_hidden = self.severity_context(
            torch.cat((latent, self.actual_time_features(actual_thinking_time_ms)), dim=-1)
        )
        indices = self.oq_profile_feature_indices
        selected_features = oq_profile_features.float().index_select(-1, indices)
        selected_missing = oq_profile_missing.to(selected_features.dtype).index_select(-1, indices)
        profile_embedding = self.profile_encoder(torch.cat((selected_features, selected_missing), dim=-1))
        gamma, beta = self.profile_severity_film(profile_embedding).chunk(2, dim=-1)
        conditioned_hidden = severity_hidden * (1.0 + gamma) + beta
        logits = self.severity_head(conditioned_hidden)
        probabilities = torch.softmax(logits, dim=-1)
        probability_zero = probabilities[..., 0]
        probability_positive = 1.0 - probability_zero
        probability_ge4 = probabilities[..., 2] + probabilities[..., 3]
        probability_ge10 = probabilities[..., 3]
        return ModelOutput(
            time_pred, conditioned_hidden, logits, probabilities,
            probability_zero, probability_positive, probability_ge4, probability_ge10,
        )


def multitask_loss(output: ModelOutput, actual_time_ms: torch.Tensor,
                   severity_class: torch.Tensor, mask: torch.Tensor,
                   time_weight: float = 0.25,
                   severity_weight: float = 1.0,
                   class_weights: tuple[float, float, float, float] | list[float] = (1, 1, 1, 1)) -> dict[str, torch.Tensor]:
    valid = mask.bool() & torch.isfinite(severity_class) & torch.isfinite(actual_time_ms)
    if not bool(valid.any()):
        raise ValueError("batch has no valid supervised nodes")
    target_class = severity_class[valid].long()
    if bool(((target_class < 0) | (target_class > 3)).any()):
        raise ValueError("severity class must be in 0..3")
    weights = torch.as_tensor(class_weights, dtype=output.severity_logits.dtype, device=output.severity_logits.device)
    if weights.shape != (4,) or not bool(torch.isfinite(weights).all()) or bool((weights <= 0).any()):
        raise ValueError("severity class weights must contain four finite positive values")
    time_target = torch.log1p(actual_time_ms[valid].clamp_min(0) / 1000.0)
    time_loss = F.mse_loss(output.pred_time_log_seconds[valid], time_target)
    severity_loss = F.cross_entropy(output.severity_logits[valid], target_class, weight=weights)
    total = time_weight * time_loss + severity_weight * severity_loss
    return {"total": total, "thinking_time": time_loss, "severity_classification": severity_loss}
