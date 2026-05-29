-- Backfill profiles.first_name / profiles.last_name from
-- user_onboarding_pack_details.pack_details (Sumsub-sourced JSON) for users
-- whose name columns are NULL or empty. Run once in Supabase SQL editor.
--
-- Safe to re-run: only updates rows that are still missing names, so the
-- second run is a no-op.
--
-- Performance: scopes the join to the small set of profiles with missing
-- names first, then probes pack_details. Should complete in seconds, not
-- minutes, even on a large profiles table — no full table scan of
-- user_onboarding_pack_details.

-- 1. Sanity preview — how many rows would be touched, and what we'd write.
--    Run this FIRST and eyeball a few rows before the UPDATE below.
WITH missing AS (
  SELECT id, first_name, last_name, email
  FROM public.profiles
  WHERE COALESCE(NULLIF(TRIM(first_name), ''), NULL) IS NULL
    AND COALESCE(NULLIF(TRIM(last_name),  ''), NULL) IS NULL
),
candidates AS (
  SELECT
    m.id AS profile_id,
    m.email,
    /* Try info.firstName → fixedInfo.firstName → firstName */
    COALESCE(
      NULLIF(TRIM(p.pack_details #>> '{info,firstName}'), ''),
      NULLIF(TRIM(p.pack_details #>> '{fixedInfo,firstName}'), ''),
      NULLIF(TRIM(p.pack_details #>> '{firstName}'), '')
    ) AS picked_first_name,
    COALESCE(
      NULLIF(TRIM(p.pack_details #>> '{info,lastName}'), ''),
      NULLIF(TRIM(p.pack_details #>> '{fixedInfo,lastName}'), ''),
      NULLIF(TRIM(p.pack_details #>> '{lastName}'), '')
    ) AS picked_last_name
  FROM missing m
  JOIN public.user_onboarding_pack_details p ON p.user_id = m.id
  WHERE p.pack_details IS NOT NULL
)
SELECT profile_id, email, picked_first_name, picked_last_name
FROM candidates
WHERE picked_first_name IS NOT NULL OR picked_last_name IS NOT NULL
ORDER BY email
LIMIT 50;

-- 2. Actual backfill. Uncomment to run after the preview looks right.
--
-- UPDATE public.profiles AS pr
-- SET
--   first_name = COALESCE(NULLIF(TRIM(pr.first_name), ''), c.picked_first_name),
--   last_name  = COALESCE(NULLIF(TRIM(pr.last_name),  ''), c.picked_last_name)
-- FROM (
--   SELECT
--     m.id AS profile_id,
--     COALESCE(
--       NULLIF(TRIM(p.pack_details #>> '{info,firstName}'), ''),
--       NULLIF(TRIM(p.pack_details #>> '{fixedInfo,firstName}'), ''),
--       NULLIF(TRIM(p.pack_details #>> '{firstName}'), '')
--     ) AS picked_first_name,
--     COALESCE(
--       NULLIF(TRIM(p.pack_details #>> '{info,lastName}'), ''),
--       NULLIF(TRIM(p.pack_details #>> '{fixedInfo,lastName}'), ''),
--       NULLIF(TRIM(p.pack_details #>> '{lastName}'), '')
--     ) AS picked_last_name
--   FROM public.profiles m
--   JOIN public.user_onboarding_pack_details p ON p.user_id = m.id
--   WHERE COALESCE(NULLIF(TRIM(m.first_name), ''), NULL) IS NULL
--     AND COALESCE(NULLIF(TRIM(m.last_name),  ''), NULL) IS NULL
--     AND p.pack_details IS NOT NULL
-- ) c
-- WHERE pr.id = c.profile_id
--   AND (c.picked_first_name IS NOT NULL OR c.picked_last_name IS NOT NULL);

-- 3. After UPDATE, this should return 0 rows for users who had a usable pack.
--
-- SELECT COUNT(*) AS still_missing
-- FROM public.profiles
-- WHERE COALESCE(NULLIF(TRIM(first_name), ''), NULL) IS NULL
--   AND COALESCE(NULLIF(TRIM(last_name),  ''), NULL) IS NULL;
