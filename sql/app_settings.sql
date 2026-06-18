-- App-wide key/value settings table.
-- Used by the Team page (Settings tab) to store fee schedules and other config.
-- key: unique identifier e.g. 'fees'
-- value: JSONB blob — schema depends on the key
-- Run once in the Supabase SQL editor.

CREATE TABLE IF NOT EXISTS public.app_settings (
  key        TEXT        PRIMARY KEY,
  value      JSONB       NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT
);

-- Seed a default fees row so the Settings tab loads without errors
INSERT INTO public.app_settings (key, value, updated_at, updated_by)
VALUES (
  'fees',
  '{
    "isinFeePerAsset": 0,
    "brokerFeeRate": 0,
    "executionReserveRate": 0,
    "transactionFeeRate": 0,
    "monthlyStrategyFee": 0,
    "rebBrokerageRate": 0,
    "rebCustodyFee": 0
  }',
  NOW(),
  'system'
)
ON CONFLICT (key) DO NOTHING;
