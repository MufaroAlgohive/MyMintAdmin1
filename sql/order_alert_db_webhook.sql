-- Create the Supabase Database Webhook for order alerts entirely in SQL.
-- This is exactly what the Dashboard "Create a new hook" does under the hood:
-- a trigger that calls supabase_functions.http_request on every INSERT into
-- public.transactions, POSTing the row to our webhook receiver.
--
-- No SUPABASE_WEBHOOK_SECRET is set on the MyMintAdmin project, so the receiver
-- skips the secret check and accepts the POST as-is — no auth header needed.
-- (Recommended later: set SUPABASE_WEBHOOK_SECRET in Vercel + add a matching
--  "x-webhook-secret" header here so the endpoint can't be POSTed to by anyone.)

-- Make sure the webhooks extension is available (Supabase ships it).
create extension if not exists pg_net with schema extensions;

-- Drop any prior version so this is safe to re-run.
drop trigger if exists order_alert_webhook on public.transactions;

create trigger order_alert_webhook
  after insert on public.transactions
  for each row
  execute function supabase_functions.http_request(
    'https://my-mint-admin.vercel.app/api/webhooks',  -- URL (api/webhooks.js → /api/webhooks)
    'POST',                                                   -- method
    '{"Content-Type":"application/json"}',                    -- headers (no secret set)
    '{}',                                                     -- params
    '5000'                                                    -- timeout ms
  );
