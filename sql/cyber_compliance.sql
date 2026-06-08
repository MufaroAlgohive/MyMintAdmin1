-- ─────────────────────────────────────────────────────────────────────────────
-- Cyber Compliance & Monitoring Centre — Database Schema
-- Run this in Supabase SQL Editor (run once)
-- All tables use the cc_ prefix naming convention
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. cc_incidents ───────────────────────────────────────────────────────────
-- Central incident log: replaces it_incidents
-- auto_generated = true when created by the health-check cron
-- pending_resolve = true when cron detects service recovered but admin hasn't confirmed
CREATE TABLE IF NOT EXISTS cc_incidents (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title            TEXT NOT NULL,
  description      TEXT,
  priority         TEXT NOT NULL DEFAULT 'medium'
                     CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  status           TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  category         TEXT NOT NULL DEFAULT 'other'
                     CHECK (category IN ('hardware', 'software', 'network', 'security', 'access', 'uptime', 'api', 'policy', 'other')),
  environment      TEXT NOT NULL DEFAULT 'live'
                     CHECK (environment IN ('live', 'dev', 'crm', 'supabase', 'email', 'general')),
  assigned_to      TEXT,
  reported_by      TEXT,
  notes            TEXT,
  auto_generated   BOOLEAN NOT NULL DEFAULT FALSE,
  pending_resolve  BOOLEAN NOT NULL DEFAULT FALSE,
  service_key      TEXT,        -- machine key used to correlate open/resolve e.g. "uptime:live"
  resolved_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cc_incidents_status_idx      ON cc_incidents (status);
CREATE INDEX IF NOT EXISTS cc_incidents_priority_idx    ON cc_incidents (priority);
CREATE INDEX IF NOT EXISTS cc_incidents_created_idx     ON cc_incidents (created_at DESC);
CREATE INDEX IF NOT EXISTS cc_incidents_service_key_idx ON cc_incidents (service_key);

ALTER TABLE cc_incidents DISABLE ROW LEVEL SECURITY;

-- ── 2. cc_uptime_log ──────────────────────────────────────────────────────────
-- Every 15-min ping result per monitored service
CREATE TABLE IF NOT EXISTS cc_uptime_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_name    TEXT NOT NULL,   -- e.g. "Mint Live", "Supabase", "CRM"
  service_key     TEXT NOT NULL,   -- e.g. "mint-live", "supabase", "crm"
  environment     TEXT NOT NULL DEFAULT 'live'
                    CHECK (environment IN ('live', 'dev', 'crm', 'supabase', 'email', 'other')),
  url             TEXT,
  is_up           BOOLEAN NOT NULL,
  status_code     INTEGER,
  response_ms     INTEGER,
  error_message   TEXT,
  checked_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cc_uptime_log_service_key_idx ON cc_uptime_log (service_key, checked_at DESC);
CREATE INDEX IF NOT EXISTS cc_uptime_log_checked_at_idx  ON cc_uptime_log (checked_at DESC);

ALTER TABLE cc_uptime_log DISABLE ROW LEVEL SECURITY;

-- ── 3. cc_api_health ──────────────────────────────────────────────────────────
-- Per-endpoint health check results from each cron run
CREATE TABLE IF NOT EXISTS cc_api_health (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment      TEXT NOT NULL DEFAULT 'crm'
                     CHECK (environment IN ('live', 'dev', 'crm')),
  endpoint         TEXT NOT NULL,      -- e.g. "/api/team?action=list"
  label            TEXT NOT NULL,      -- human label e.g. "Team List"
  method           TEXT NOT NULL DEFAULT 'GET',
  expected_status  INTEGER NOT NULL DEFAULT 200,
  actual_status    INTEGER,
  response_ms      INTEGER,
  passed           BOOLEAN NOT NULL,
  error_message    TEXT,
  checked_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cc_api_health_env_idx        ON cc_api_health (environment, checked_at DESC);
CREATE INDEX IF NOT EXISTS cc_api_health_checked_at_idx ON cc_api_health (checked_at DESC);

ALTER TABLE cc_api_health DISABLE ROW LEVEL SECURITY;

-- ── 4. cc_policy_checks ───────────────────────────────────────────────────────
-- Cybersecurity policy scan results
CREATE TABLE IF NOT EXISTS cc_policy_checks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_name   TEXT NOT NULL,    -- e.g. "HTTPS Enforced"
  category      TEXT NOT NULL,    -- e.g. "Transport Security", "Authentication", "Headers"
  passed        BOOLEAN NOT NULL,
  severity      TEXT NOT NULL DEFAULT 'medium'
                  CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  detail        TEXT,             -- description or failure reason
  recommendation TEXT,            -- how to fix if failed
  checked_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cc_policy_checks_checked_at_idx ON cc_policy_checks (checked_at DESC);
CREATE INDEX IF NOT EXISTS cc_policy_checks_passed_idx     ON cc_policy_checks (passed, checked_at DESC);

ALTER TABLE cc_policy_checks DISABLE ROW LEVEL SECURITY;

-- ── 5. cc_audit_log ───────────────────────────────────────────────────────────
-- Full database change log written by triggers (see audit_triggers.sql)
CREATE TABLE IF NOT EXISTS cc_audit_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name   TEXT NOT NULL,
  operation    TEXT NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
  old_row      JSONB,
  new_row      JSONB,
  changed_by   TEXT,   -- auth.uid() or 'system'
  changed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cc_audit_log_table_idx      ON cc_audit_log (table_name, changed_at DESC);
CREATE INDEX IF NOT EXISTS cc_audit_log_changed_at_idx ON cc_audit_log (changed_at DESC);
CREATE INDEX IF NOT EXISTS cc_audit_log_operation_idx  ON cc_audit_log (operation, changed_at DESC);

ALTER TABLE cc_audit_log DISABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- Optional: migrate existing it_incidents data into cc_incidents
-- Uncomment to run after creating the table if you have existing data:
-- INSERT INTO cc_incidents (id, title, description, priority, status, category,
--   assigned_to, reported_by, notes, resolved_at, created_at, updated_at,
--   environment, auto_generated, pending_resolve)
-- SELECT id, title, description, priority, status,
--   CASE WHEN category = 'hardware' THEN 'hardware'
--        WHEN category = 'software' THEN 'software'
--        WHEN category = 'network'  THEN 'network'
--        WHEN category = 'security' THEN 'security'
--        WHEN category = 'access'   THEN 'access'
--        ELSE 'other' END,
--   assigned_to, reported_by, notes, resolved_at, created_at, updated_at,
--   'general', false, false
-- FROM it_incidents
-- ON CONFLICT (id) DO NOTHING;

-- Optional: drop the old table after migrating
-- DROP TABLE IF EXISTS it_incidents;
