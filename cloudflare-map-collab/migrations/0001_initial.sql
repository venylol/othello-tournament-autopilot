CREATE TABLE IF NOT EXISTS mapping_tables (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT NOT NULL,
  edit_token_hash TEXT NOT NULL,
  view_token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mapping_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  patch_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (table_id) REFERENCES mapping_tables(id)
);

CREATE INDEX IF NOT EXISTS idx_mapping_audit_table_id ON mapping_audit(table_id, id);
