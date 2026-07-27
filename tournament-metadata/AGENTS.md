# Agent Instructions

This folder is a protected tournament archive.

- Do not delete or rename this folder.
- Do not delete monthly archive files unless the user explicitly requests that exact deletion.
- Keep one canonical metadata set per month per division. For the no-handicap group, the canonical path is `no-handicap/YYYY-MM/` plus `no-handicap/YYYY-MM.json`.
- Do not create duplicate month folders such as multiple variants for the same no-handicap month. If data is corrected, update the canonical folder and record the correction in audit metadata.
- Monthly archives must include pairing metadata, OQ account metadata, game JSON files, per-node analysis, absence records, and audit files when available.
- When exporting or storing playable transcript strings, omit pass markers (`-`). Do not insert `-` pass elements for review software; it can infer pass automatically.
- Generated reports belong under `exports/no-handicap/YYYY-MM/`.
- Prefer scripts in `scripts/` for reproducible exports instead of one-off manual transformations.
