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

-- ─────────────────────────────────────────────────────────────────────
-- DIAGNOSTIC: if the preview at step 1 returned 0 rows but the UI still
-- shows "Unknown User", the names probably aren't in
-- user_onboarding_pack_details.pack_details. Sumsub data also lives in
-- user_onboarding.sumsub_raw on some accounts. Run these to find out
-- where the name actually is for the missing users.
-- ─────────────────────────────────────────────────────────────────────

-- 4a. Count: of the unnamed profiles, how many have ANY onboarding rows.
SELECT
  (SELECT COUNT(*) FROM public.profiles
     WHERE COALESCE(NULLIF(TRIM(first_name), ''), NULL) IS NULL
       AND COALESCE(NULLIF(TRIM(last_name),  ''), NULL) IS NULL) AS unnamed_profiles,
  (SELECT COUNT(*) FROM public.profiles pr
     WHERE COALESCE(NULLIF(TRIM(pr.first_name), ''), NULL) IS NULL
       AND COALESCE(NULLIF(TRIM(pr.last_name),  ''), NULL) IS NULL
       AND EXISTS (SELECT 1 FROM public.user_onboarding_pack_details p
                    WHERE p.user_id = pr.id AND p.pack_details IS NOT NULL)) AS have_pack_details,
  (SELECT COUNT(*) FROM public.profiles pr
     WHERE COALESCE(NULLIF(TRIM(pr.first_name), ''), NULL) IS NULL
       AND COALESCE(NULLIF(TRIM(pr.last_name),  ''), NULL) IS NULL
       AND EXISTS (SELECT 1 FROM public.user_onboarding o
                    WHERE o.user_id = pr.id AND o.sumsub_raw IS NOT NULL)) AS have_sumsub_raw;

-- 4b. Sample: for unnamed profiles, show the actual keys present in
-- sumsub_raw JSON so we know which fields to pull from.
SELECT
  pr.id, pr.email,
  jsonb_object_keys(o.sumsub_raw::jsonb) AS sumsub_raw_keys
FROM public.profiles pr
JOIN public.user_onboarding o ON o.user_id = pr.id
WHERE COALESCE(NULLIF(TRIM(pr.first_name), ''), NULL) IS NULL
  AND COALESCE(NULLIF(TRIM(pr.last_name),  ''), NULL) IS NULL
  AND o.sumsub_raw IS NOT NULL
LIMIT 20;

-- 4c. Sample: actual extracted names from sumsub_raw with common shapes.
SELECT
  pr.id, pr.email,
  o.sumsub_raw #>> '{info,firstName}'      AS info_first,
  o.sumsub_raw #>> '{info,lastName}'       AS info_last,
  o.sumsub_raw #>> '{fixedInfo,firstName}' AS fixed_first,
  o.sumsub_raw #>> '{fixedInfo,lastName}'  AS fixed_last,
  o.sumsub_raw #>> '{firstName}'           AS root_first,
  o.sumsub_raw #>> '{lastName}'            AS root_last,
  o.sumsub_raw #>> '{applicant,info,firstName}' AS applicant_info_first,
  o.sumsub_raw #>> '{applicant,info,lastName}'  AS applicant_info_last
FROM public.profiles pr
JOIN public.user_onboarding o ON o.user_id = pr.id
WHERE COALESCE(NULLIF(TRIM(pr.first_name), ''), NULL) IS NULL
  AND COALESCE(NULLIF(TRIM(pr.last_name),  ''), NULL) IS NULL
  AND o.sumsub_raw IS NOT NULL
LIMIT 20;
