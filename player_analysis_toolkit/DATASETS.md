# Public dataset releases

Large public datasets and trained artifacts are published as GitHub Release
assets instead of being committed to Git. Each release contains a generated
`SHA256SUMS.txt` and `release-assets.json` manifest.

The curated release set contains:

- the 3,531-game bilateral training dataset;
- the 10,000-game source-only and OQ-profile retrospective datasets;
- the 10,000-game and 11,200-game profile-aware model-ready datasets;
- the public 2,339-player OQ profile snapshot;
- the final 11,200-game warm-start ensemble;
- the base TCN checkpoint;
- the Windows 9950X Egaroucid server handoff.
- the expanded 10,244-game sentinel V6 directed reference, including the
  deterministic per-side offbook anchors;
- the calibrated sentinel estimated-Elo V5 directed phase reference.
- the Sentinel V1 operational Reference derived cache (2,990 directed
  target-side records, including 2,758 formal 1600–2486 records).

Sentinel V1 Reference release:

- tag: `player-toolkit-sentinel-v1-20260815`;
- asset: `oq-sentinel-reference-level22-1600plus-v1-20260814.zip`;
- install by extracting the archive under
  `player_analysis_toolkit/research/offbook_detection/data/`; the checked-in
  `sentinel_reference_config.json` then resolves it by relative path.

The Sentinel asset contains the operational derived records, summaries,
source hashes, and build audit. It references but does not duplicate the 1,495
Level22 engine JSON files. Its public source manifest uses repository-relative
paths so local usernames and machine paths are not published.

Generated smoke runs, superseded experiment snapshots, caches, logs, and
player-specific investigation artifacts are intentionally excluded.

Install the two sentinel archives by extracting their top-level directories
under `research/offbook_detection/data/`. The repository-level
`sentinel_reference_config.json` and `sentinel_elo_reference_config.json`
already point at those versioned directory names.

To rebuild the assets, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File tools/repository/build_release_assets.ps1 `
  -SourceRoot . `
  -OutputDirectory C:\path\to\release-assets `
  -ManifestPath tools/repository/public-release-layout.json `
  -BlockedRegex '<local-private-pattern>'
```
