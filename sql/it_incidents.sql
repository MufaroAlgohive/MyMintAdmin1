-- IT Incident Register table
-- Run this in Supabase SQL Editor to create the incidents table.

CREATE TABLE IF NOT EXISTS it_incidents (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title        TEXT NOT NULL,
  description  TEXT,
  priority     TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  status       TEXT NOT NULL DEFAULT 'open'   CHECK (status   IN ('open', 'in_progress', 'resolved', 'closed')),
  category     TEXT NOT NULL DEFAULT 'other'  CHECK (category IN ('hardware', 'software', 'network', 'security', 'access', 'other')),
  assigned_to  TEXT,
  reported_by  TEXT,
  notes        TEXT,
  resolved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for common filter patterns
CREATE INDEX IF NOT EXISTS it_incidents_status_idx   ON it_incidents (status);
CREATE INDEX IF NOT EXISTS it_incidents_priority_idx ON it_incidents (priority);
CREATE INDEX IF NOT EXISTS it_incidents_created_idx  ON it_incidents (created_at DESC);

-- Disable RLS — access controlled via server-side service role key
ALTER TABLE it_incidents DISABLE ROW LEVEL SECURITY;
