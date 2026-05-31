-- Add family_member_id to rebalance_event so the rebalance pipeline can
-- distinguish between a parent's own positions and each child's positions
-- in the same strategy/security. Without this column the SELL lookup in
-- fill & settle can pick the wrong active row, and the new BUY insert
-- always defaults to the parent (silently losing the child's position).
--
-- Safe to re-run.

ALTER TABLE public.rebalance_event
  ADD COLUMN IF NOT EXISTS family_member_id uuid
  REFERENCES public.family_members(id) ON DELETE SET NULL;

-- Index for lookups by (batch, family_member). Useful when the admin
-- inspects which children were affected by a given rebalance.
CREATE INDEX IF NOT EXISTS rebalance_event_batch_fm_idx
  ON public.rebalance_event(batch_id, family_member_id);

-- Sanity check
SELECT COUNT(*) AS rebalance_event_rows,
       COUNT(family_member_id) AS rows_with_family_member
FROM public.rebalance_event;
