-- ============================================================
-- Mint CRM — Team & Permissions Complete Setup
-- Run this once in Supabase Dashboard → SQL Editor
-- Safe to re-run (uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS)
-- Combines: admin_team, admin_team_audit, admin_team_invites,
--           db-migration-permissions, app_settings
-- ============================================================

-- 1. Core team members table
CREATE TABLE IF NOT EXISTS public.admin_team (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  email         text NOT NULL UNIQUE,
  full_name     text,
  role          text NOT NULL DEFAULT 'staff' CHECK (role IN ('admin', 'staff')),
  page_access   text[] NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active')),
  invited_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.admin_team ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'admin_team' AND policyname = 'service_role_all'
  ) THEN
    CREATE POLICY "service_role_all" ON public.admin_team USING (true) WITH CHECK (true);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS admin_team_user_id_idx ON public.admin_team(user_id);
CREATE INDEX IF NOT EXISTS admin_team_email_idx   ON public.admin_team(email);

-- 2. Invite-token columns (for the signup-from-invite flow)
ALTER TABLE public.admin_team
  ADD COLUMN IF NOT EXISTS invite_token            text,
  ADD COLUMN IF NOT EXISTS invite_token_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS admin_team_invite_token_idx ON public.admin_team(invite_token);

-- 3. Approver tier + granular permissions columns
--    Fixes the 'def' typo that existed in earlier migration scripts — correct value is 'dev'
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'admin_team' AND column_name = 'approver_tier'
  ) THEN
    ALTER TABLE public.admin_team ADD COLUMN approver_tier TEXT CHECK (approver_tier IN ('dev', 'master'));
  END IF;
END $$;

ALTER TABLE public.admin_team
  ADD COLUMN IF NOT EXISTS permissions JSONB DEFAULT '{}';

-- 4. Audit log table
CREATE TABLE IF NOT EXISTS public.admin_team_audit (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  action           text        NOT NULL,
  target_email     text        NOT NULL,
  target_member_id uuid,
  actor_email      text,
  actor_user_id    uuid,
  details          jsonb       DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_team_audit_created_at_idx  ON public.admin_team_audit (created_at DESC);
CREATE INDEX IF NOT EXISTS admin_team_audit_target_email_idx ON public.admin_team_audit (target_email);

-- 5. Approvals inbox table
CREATE TABLE IF NOT EXISTS public.admin_approvals (
  id                 UUID         DEFAULT gen_random_uuid() PRIMARY KEY,
  type               TEXT         NOT NULL,
  status             TEXT         NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by_id    UUID,
  requested_by_email TEXT         NOT NULL,
  reviewed_by_id     UUID,
  reviewed_by_email  TEXT,
  payload            JSONB        DEFAULT '{}',
  notes              TEXT,
  created_at         TIMESTAMPTZ  DEFAULT NOW(),
  reviewed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_admin_approvals_status  ON public.admin_approvals (status);
CREATE INDEX IF NOT EXISTS idx_admin_approvals_type    ON public.admin_approvals (type);
CREATE INDEX IF NOT EXISTS idx_admin_approvals_reqby   ON public.admin_approvals (requested_by_email);
CREATE INDEX IF NOT EXISTS idx_admin_approvals_created ON public.admin_approvals (created_at DESC);

-- 6. App-wide settings table (fee schedules, etc.)
CREATE TABLE IF NOT EXISTS public.app_settings (
  key        TEXT        PRIMARY KEY,
  value      JSONB       NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT
);

INSERT INTO public.app_settings (key, value, updated_at, updated_by)
VALUES (
  'fees',
  '{"isinFeePerAsset":0,"brokerFeeRate":0,"executionReserveRate":0,"transactionFeeRate":0,"monthlyStrategyFee":0,"rebBrokerageRate":0,"rebCustodyFee":0}',
  NOW(),
  'system'
)
ON CONFLICT (key) DO NOTHING;

-- 7. Migrate existing admins from admin_profiles → admin_team (if that table exists)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'admin_profiles'
  ) THEN
    INSERT INTO public.admin_team (email, full_name, role, status, page_access, created_at, updated_at)
    SELECT
      p.email,
      p.full_name,
      'admin',
      'active',
      COALESCE(p.page_permissions, '{}'),
      NOW(),
      NOW()
    FROM public.admin_profiles p
    WHERE p.email IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.admin_team t WHERE t.email = p.email
      );
  END IF;
END;
$$;

-- Done. All team-page tables and columns are now set up.
