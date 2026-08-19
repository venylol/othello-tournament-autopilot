# Repository workflow constraints

## Unified single-player investigation entrypoint

- Any new metric, diagnostic, or analysis that is specifically about investigating one player must be added to `scripts/analysis/sentinel_unified_analysis.py` and exposed through its unified per-player command surface.
- `scripts/analysis/run_player_investigation.py` is the lifecycle orchestrator: it prepares inputs, invokes the unified analysis stage, and assembles the final report. Do not put the analysis implementation directly into this orchestrator.
- The legacy `sentinel_analysis.py` and the database-maintenance `sentinel_elo_analysis.py` CLIs remain compatibility/maintenance interfaces. Their per-player results must be consumable by the unified analysis output and final report.
- Do not add another standalone per-player investigation script when the capability can be implemented as a stage or metric in the unified analysis script.
