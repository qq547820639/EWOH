-- EWOH V0.5/V1.0 baseline schema (SQLite-compatible subset)
PRAGMA foreign_keys = ON;
CREATE TABLE person (
  person_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  team TEXT,
  skills_json TEXT NOT NULL DEFAULT '[]',
  consent_status TEXT NOT NULL DEFAULT 'unknown',
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE device (
  device_id TEXT PRIMARY KEY,
  device_type TEXT NOT NULL,
  model TEXT NOT NULL,
  firmware_version TEXT,
  person_id TEXT,
  online INTEGER NOT NULL DEFAULT 0,
  source_type TEXT NOT NULL,
  last_seen TEXT,
  FOREIGN KEY(person_id) REFERENCES person(person_id)
);
CREATE TABLE task (
  task_id TEXT PRIMARY KEY,
  task_name TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  required_skill TEXT,
  load_level REAL,
  status TEXT NOT NULL DEFAULT 'pending',
  assigned_person_id TEXT
);
CREATE TABLE telemetry (
  record_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  seq INTEGER,
  payload_json TEXT NOT NULL,
  quality_status TEXT NOT NULL,
  source_type TEXT NOT NULL,
  FOREIGN KEY(device_id) REFERENCES device(device_id)
);
CREATE INDEX idx_telemetry_device_ts ON telemetry(device_id, ts);
CREATE TABLE inference (
  inference_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  ts_start TEXT NOT NULL,
  ts_end TEXT NOT NULL,
  label TEXT NOT NULL,
  confidence REAL,
  model_id TEXT,
  model_version TEXT,
  evidence_json TEXT,
  source_type TEXT NOT NULL
);
CREATE TABLE risk_event (
  event_id TEXT PRIMARY KEY,
  event_code TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  person_id TEXT,
  device_id TEXT,
  task_id TEXT,
  zone_id TEXT,
  start_time TEXT NOT NULL,
  end_time TEXT,
  trigger_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  source_type TEXT NOT NULL,
  handling_json TEXT
);
CREATE TABLE audit_log (
  audit_id TEXT PRIMARY KEY,
  actor_id TEXT,
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT,
  before_json TEXT,
  after_json TEXT,
  ts TEXT NOT NULL
);
