-- ─────────────────────────────────────────────────────────────────────────────
-- Audit Triggers — writes INSERT/UPDATE/DELETE to cc_audit_log
-- Run AFTER cyber_compliance.sql (cc_audit_log must exist first)
-- Run this in Supabase SQL Editor (run once)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Shared trigger function ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION cc_audit_trigger_fn()
RETURNS TRIGGER AS $$
DECLARE
  _old_row  JSONB := NULL;
  _new_row  JSONB := NULL;
  _actor    TEXT  := 'system';
BEGIN
  -- Try to get the authenticated user; fall back to 'system'
  BEGIN
    _actor := coalesce(auth.uid()::TEXT, 'system');
  EXCEPTION WHEN OTHERS THEN
    _actor := 'system';
  END;

  IF TG_OP = 'DELETE' THEN
    _old_row := to_jsonb(OLD);
  ELSIF TG_OP = 'INSERT' THEN
    _new_row := to_jsonb(NEW);
  ELSE -- UPDATE
    _old_row := to_jsonb(OLD);
    _new_row := to_jsonb(NEW);
  END IF;

  INSERT INTO cc_audit_log (table_name, operation, old_row, new_row, changed_by, changed_at)
  VALUES (TG_TABLE_NAME, TG_OP, _old_row, _new_row, _actor, now());

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── Attach trigger to: profiles ───────────────────────────────────────────────
DROP TRIGGER IF EXISTS cc_audit_profiles ON profiles;
CREATE TRIGGER cc_audit_profiles
  AFTER INSERT OR UPDATE OR DELETE ON profiles
  FOR EACH ROW EXECUTE FUNCTION cc_audit_trigger_fn();

-- ── Attach trigger to: stock_holdings_c ──────────────────────────────────────
DROP TRIGGER IF EXISTS cc_audit_stock_holdings_c ON stock_holdings_c;
CREATE TRIGGER cc_audit_stock_holdings_c
  AFTER INSERT OR UPDATE OR DELETE ON stock_holdings_c
  FOR EACH ROW EXECUTE FUNCTION cc_audit_trigger_fn();

-- ── Attach trigger to: wallet_transactions ────────────────────────────────────
DROP TRIGGER IF EXISTS cc_audit_wallet_transactions ON wallet_transactions;
CREATE TRIGGER cc_audit_wallet_transactions
  AFTER INSERT OR UPDATE OR DELETE ON wallet_transactions
  FOR EACH ROW EXECUTE FUNCTION cc_audit_trigger_fn();

-- ── Attach trigger to: strategies_c ──────────────────────────────────────────
DROP TRIGGER IF EXISTS cc_audit_strategies_c ON strategies_c;
CREATE TRIGGER cc_audit_strategies_c
  AFTER INSERT OR UPDATE OR DELETE ON strategies_c
  FOR EACH ROW EXECUTE FUNCTION cc_audit_trigger_fn();

-- ── Attach trigger to: securities_c ──────────────────────────────────────────
DROP TRIGGER IF EXISTS cc_audit_securities_c ON securities_c;
CREATE TRIGGER cc_audit_securities_c
  AFTER INSERT OR UPDATE OR DELETE ON securities_c
  FOR EACH ROW EXECUTE FUNCTION cc_audit_trigger_fn();

-- ── Attach trigger to: user_onboarding ───────────────────────────────────────
DROP TRIGGER IF EXISTS cc_audit_user_onboarding ON user_onboarding;
CREATE TRIGGER cc_audit_user_onboarding
  AFTER INSERT OR UPDATE OR DELETE ON user_onboarding
  FOR EACH ROW EXECUTE FUNCTION cc_audit_trigger_fn();

-- ── Attach trigger to: cc_incidents (audit the auditor) ──────────────────────
DROP TRIGGER IF EXISTS cc_audit_cc_incidents ON cc_incidents;
CREATE TRIGGER cc_audit_cc_incidents
  AFTER INSERT OR UPDATE OR DELETE ON cc_incidents
  FOR EACH ROW EXECUTE FUNCTION cc_audit_trigger_fn();
