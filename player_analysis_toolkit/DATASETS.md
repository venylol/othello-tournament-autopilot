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

Generated smoke runs, superseded experiment snapshots, caches, logs, and
player-specific investigation artifacts are intentionally excluded.

To rebuild the assets, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File tools/repository/build_release_assets.ps1 `
  -SourceRoot . `
  -OutputDirectory C:\path\to\release-assets `
  -ManifestPath tools/repository/public-release-layout.json `
  -BlockedRegex '<local-private-pattern>'
```
