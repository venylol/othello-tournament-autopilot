# Local State Command Architecture

`local-server.js` is the sole runtime writer of `data/checkin-state.json`.
Runtime callers load an authoritative snapshot with `GET /api/state`, capture
stable entity IDs/revisions, and commit owned changes with
`POST /api/state/commands`.

Commands are serialized by the server and reduced by `state-commands.js`.
Same-entity stale revisions return HTTP 409 with the authoritative entity;
unrelated entities can commit independently. `commandId` retries are
idempotent. Semantic no-ops do not write, increment revisions, or emit SSE.
Multi-entity commands validate every precondition before their cloned result is
persisted atomically.

SSE `entities` events contain one global revision plus changed authoritative
entities. Metadata entities exclude child collections and browser-local viewed
round/navigation fields. The frontend applies keyed changes and keeps focused
drafts locally; initial load and reconnect recovery are the only full snapshot
reads.

`POST /api/state` is not a routine synchronization API. It accepts only an
explicit `operation: "import"` or `operation: "reset"` with the exact current
global revision. It never performs timestamp merging.

The following direct-file paths are fixture/test-only and reject the live state
path: Python score/EGA helpers and `cloudflare-map-collab/tools/pull-map-collab.js
--direct-file`. `cloudflare-checkin-static/public/app.js` and
`agent_cache/onlicheck-live-app.js` are historical deployment/cache snapshots;
they are not served or invoked by the local `recovered/` workflow and were not
made alternate runtime synchronization clients.
