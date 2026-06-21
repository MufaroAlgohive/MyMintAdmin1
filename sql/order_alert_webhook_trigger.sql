-- Desk alert when a real order comes in. Fires the order_alert dispatcher in
-- api/webhooks.js off every transactions INSERT; the dispatcher filters to
-- investment buys ("Strategy Investment: …" / "Purchased …") and skips UAT/test
-- accounts. Idempotent insert (won't duplicate on re-run).
INSERT INTO email_webhook_triggers (name, table_name, event_type, email_type, user_id_field, description)
SELECT 'New order → desk alert', 'transactions', 'INSERT', 'order_alert', 'user_id',
       'Email the desk who/what/when when a real (non-UAT) investment buy is recorded'
WHERE NOT EXISTS (
  SELECT 1 FROM email_webhook_triggers
  WHERE table_name = 'transactions' AND event_type = 'INSERT' AND email_type = 'order_alert'
);
