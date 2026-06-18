-- ============================================================
-- PHASE 1: Mint CRM — Permissions & Approvals Migration
-- Run this in your Supabase project's SQL editor (Dashboard → SQL Editor)
-- Safe to re-run (all statements use IF NOT EXISTS / ADD COLUMN IF NOT EXISTS)
-- ============================================================

-- 1. Add approver_tier column to admin_team
--    'dev'    = Dev user — bypasses all approval workflows
--    'master' = Master Approver — can review and authorize requests
--    null     = Lower-level staff — approval workflows enforced
ALTER TABLE public.admin_team
  ADD COLUMN IF NOT EXISTS approver_tier TEXT CHECK (approver_tier IN ('dev', 'master'));

-- 2. Add granular permissions JSONB column to admin_team
ALTER TABLE public.admin_team
  ADD COLUMN IF NOT EXISTS permissions JSONB DEFAULT '{}';

-- 3. Create the approvals table for the approval workflow inbox
CREATE TABLE IF NOT EXISTS public.admin_approvals (
  id              UUID         DEFAULT gen_random_uuid() PRIMARY KEY,
  type            TEXT         NOT NULL,
  status          TEXT         NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by_id UUID,
  requested_by_email TEXT      NOT NULL,
  reviewed_by_id  UUID,
  reviewed_by_email TEXT,
  payload         JSONB        DEFAULT '{}',
  notes           TEXT,
  created_at      TIMESTAMPTZ  DEFAULT NOW(),
  reviewed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_admin_approvals_status  ON public.admin_approvals (status);
CREATE INDEX IF NOT EXISTS idx_admin_approvals_type    ON public.admin_approvals (type);
CREATE INDEX IF NOT EXISTS idx_admin_approvals_reqby   ON public.admin_approvals (requested_by_email);
CREATE INDEX IF NOT EXISTS idx_admin_approvals_created ON public.admin_approvals (created_at DESC);

-- 4. Migrate lost admins from admin_profiles → admin_team
--    (only inserts rows that don't already exist in admin_team)
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

-- Done. You can now use the Permissions editor in the Team page.
