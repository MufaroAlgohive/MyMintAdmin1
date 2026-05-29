#!/usr/bin/env node
/*
 * One-off backfill: for every public.profiles row missing first_name AND
 * last_name, hit Sumsub's /resources/applicants/-;externalUserId=<id>/one
 * endpoint and update the profile with the firstName/lastName from
 * Sumsub's info or fixedInfo block. Skips users Sumsub doesn't know
 * about (404), logs everything else.
 *
 * Requires env vars (Vercel-style, also works via shell export):
 *   SUPABASE_URL                 (https://....supabase.co)
 *   SUPABASE_SERVICE_ROLE_KEY    (the service role key, NOT anon)
 *   SUMSUB_APP_TOKEN
 *   SUMSUB_APP_SECRET
 *
 * Run:  node scripts/sync-names-from-sumsub.js
 *
 * The script is sequential with a small per-request delay so it doesn't
 * hammer Sumsub rate limits. Reads 100 missing-name rows per page.
 */

const crypto = require('crypto');
const https = require('https');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUMSUB_APP_TOKEN = process.env.SUMSUB_APP_TOKEN;
const SUMSUB_APP_SECRET = process.env.SUMSUB_APP_SECRET;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUMSUB_APP_TOKEN || !SUMSUB_APP_SECRET) {
  console.error('Missing env: need SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUMSUB_APP_TOKEN, SUMSUB_APP_SECRET');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const supabaseRequest = async (path, init = {}) => {
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, { ...init, headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${init.method || 'GET'} ${path} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
};

const fetchSumsubApplicant = (externalUserId) => new Promise((resolve, reject) => {
  const path = `/resources/applicants/-;externalUserId=${encodeURIComponent(externalUserId)}/one`;
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = crypto.createHmac('sha256', SUMSUB_APP_SECRET)
    .update(ts + 'GET' + path).digest('hex');
  const req = https.request({
    hostname: 'api.sumsub.com',
    path,
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'X-App-Token': SUMSUB_APP_TOKEN,
      'X-App-Access-Sig': sig,
      'X-App-Access-Ts': ts,
    },
  }, (r) => {
    let data = '';
    r.on('data', (chunk) => { data += chunk; });
    r.on('end', () => resolve({ status: r.statusCode || 0, body: data }));
  });
  req.on('error', reject);
  req.end();
});

const pickName = (applicant) => {
  const info = applicant?.info || {};
  const fixed = applicant?.fixedInfo || {};
  const first = (info.firstNameEn || info.firstName || fixed.firstNameEn || fixed.firstName || '').trim();
  const last = (info.lastNameEn || info.lastName || fixed.lastNameEn || fixed.lastName || '').trim();
  return { first, last };
};

(async () => {
  console.log('Loading profiles with NULL/empty first_name and last_name...');
  /* PostgREST: cs.first_name=is.null + last_name=is.null, OR empty string. */
  const profiles = await supabaseRequest(
    '/profiles?select=id,email,first_name,last_name&first_name=is.null&last_name=is.null&limit=1000'
  );
  console.log(`Found ${profiles.length} unnamed profile(s).`);

  let updated = 0;
  let notFound = 0;
  let errors = 0;
  let skipped = 0;

  for (const p of profiles) {
    const uid = p.id;
    const email = p.email || '(no email)';
    try {
      const { status, body } = await fetchSumsubApplicant(uid);
      if (status === 404) {
        notFound += 1;
        console.log(`[404] ${email} (${uid}) — no Sumsub applicant`);
      } else if (status >= 400) {
        errors += 1;
        console.log(`[${status}] ${email} (${uid}) — ${body.slice(0, 120)}`);
      } else {
        const applicant = JSON.parse(body);
        const { first, last } = pickName(applicant);
        if (!first && !last) {
          skipped += 1;
          console.log(`[skip] ${email} (${uid}) — applicant has no name fields`);
        } else {
          await supabaseRequest(`/profiles?id=eq.${encodeURIComponent(uid)}`, {
            method: 'PATCH',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({
              ...(first ? { first_name: first } : {}),
              ...(last ? { last_name: last } : {}),
            }),
          });
          updated += 1;
          console.log(`[ok]  ${email} (${uid}) → ${first} ${last}`);
        }
      }
    } catch (err) {
      errors += 1;
      console.log(`[err] ${email} (${uid}) — ${err.message}`);
    }
    await sleep(150); // gentle to Sumsub
  }

  console.log('\n── Summary ──');
  console.log(`Profiles processed: ${profiles.length}`);
  console.log(`Updated:            ${updated}`);
  console.log(`No Sumsub data:     ${notFound}`);
  console.log(`Name fields blank:  ${skipped}`);
  console.log(`Errors:             ${errors}`);
})().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
