/**
 * Mint CRM — Permissions Test Suite
 *
 * Safe to run at any time. No writes to the database — ever.
 * Live API calls only use missing/invalid tokens (401/403 checks).
 *
 * Usage:
 *   node scratch-test-permissions.js
 *
 * Sections:
 *   S1 — Unit: buildPermHelper (mintCan logic from access-guard.js)
 *   S2 — Unit: isMasterOrDev logic
 *   S3 — Unit: approver_tier whitelist (server-side sanitisation)
 *   S4 — Unit: hasAnyPermission (team.html warning helper)
 *   S5 — Unit: fillPricePerm gate logic (direct→pending override removed)
 *   S6 — Live API: unauthenticated calls → 401
 *   S7 — Live API: fake token → rejected (401/403)
 */

'use strict';

const BASE_URL = 'http://localhost:5000';

let passed = 0;
let failed = 0;
const results = [];

function assert(label, condition, extra = '') {
  if (condition) {
    passed++;
    results.push(`  ✅ PASS  ${label}`);
  } else {
    failed++;
    results.push(`  ❌ FAIL  ${label}${extra ? ' → ' + extra : ''}`);
  }
}

function section(title) {
  results.push(`\n${'─'.repeat(60)}`);
  results.push(`  ${title}`);
  results.push('─'.repeat(60));
}

// ── Copied from public/js/access-guard.js ────────────────────────────────
const buildPermHelper = (permissions, approverTier) => {
  return (section, field) => {
    if (approverTier === 'dev') return true;
    if (!permissions || typeof permissions !== 'object') return false;
    const sec = permissions[section];
    if (!sec || typeof sec !== 'object') return false;
    return sec[field] !== undefined ? sec[field] : false;
  };
};

// ── Copied from api/team.js ───────────────────────────────────────────────
const isMasterOrDev = (member) =>
  member && (member.approver_tier === 'master' || member.approver_tier === 'dev');

const validTiers = [null, '', 'master', 'dev'];
const safeTier = (t) => (validTiers.includes(t) ? (t || null) : null);

// ── Copied from public/team.html ─────────────────────────────────────────
const hasAnyPermission = (permissions) => {
  if (!permissions || typeof permissions !== 'object') return false;
  return Object.values(permissions).some(sec =>
    sec && typeof sec === 'object' &&
    Object.values(sec).some(v => v !== false && v !== undefined && v !== null)
  );
};

// ═══════════════════════════════════════════════════════════════════════════
// S1 — mintCan / buildPermHelper unit tests
// ═══════════════════════════════════════════════════════════════════════════
section('S1 — mintCan (buildPermHelper) unit tests');

const devCan = buildPermHelper({ orderbook: { edit_fill_price: false } }, 'dev');
assert('Dev tier: edit_fill_price=false in DB still returns true', devCan('orderbook', 'edit_fill_price') === true);
assert('Dev tier: unknown section still returns true', devCan('unknown', 'unknown') === true);
assert('Dev tier: null permissions still returns true', buildPermHelper(null, 'dev')('orderbook', 'edit_fill_price') === true);

const masterCan = buildPermHelper({ orderbook: { edit_fill_price: 'pending', send_confirmation: 'test_only' } }, 'master');
assert('Master: edit_fill_price returns "pending"', masterCan('orderbook', 'edit_fill_price') === 'pending');
assert('Master: send_confirmation returns "test_only"', masterCan('orderbook', 'send_confirmation') === 'test_only');
assert('Master: unknown field returns false', masterCan('orderbook', 'nonexistent') === false);

const directCan = buildPermHelper({ orderbook: { edit_fill_price: 'direct' } }, 'master');
assert('Master: edit_fill_price="direct" stays "direct" (override was removed)', directCan('orderbook', 'edit_fill_price') === 'direct');

const staffCan = buildPermHelper({ orderbook: { edit_fill_price: false, send_confirmation: true } }, null);
assert('Staff: edit_fill_price=false returns false (blocked)', staffCan('orderbook', 'edit_fill_price') === false);
assert('Staff: send_confirmation=true returns true', staffCan('orderbook', 'send_confirmation') === true);

assert('Empty perms: any check returns false', buildPermHelper({}, null)('orderbook', 'edit_fill_price') === false);
assert('Null perms + null tier: any check returns false', buildPermHelper(null, null)('orderbook', 'edit_fill_price') === false);

const partialCan = buildPermHelper({ dashboard: { view: true } }, null);
assert('Missing section returns false', partialCan('orderbook', 'edit_fill_price') === false);
assert('Existing section returns correct value', partialCan('dashboard', 'view') === true);

assert('Explicit false: returns false (not undefined fallback)', buildPermHelper({ orderbook: { edit_fill_price: false } }, null)('orderbook', 'edit_fill_price') === false);

assert('Perm value=true (boolean) returns true', buildPermHelper({ eft: { approve_deposit: true } }, null)('eft', 'approve_deposit') === true);
assert('Perm value="direct" (string) returns "direct"', buildPermHelper({ orderbook: { edit_fill_price: 'direct' } }, null)('orderbook', 'edit_fill_price') === 'direct');
assert('Perm value="pending" (string) returns "pending"', buildPermHelper({ orderbook: { edit_fill_price: 'pending' } }, null)('orderbook', 'edit_fill_price') === 'pending');
assert('Perm value=0 (falsy non-false) returns 0', buildPermHelper({ orderbook: { edit_fill_price: 0 } }, null)('orderbook', 'edit_fill_price') === 0);

// ═══════════════════════════════════════════════════════════════════════════
// S2 — isMasterOrDev logic
// ═══════════════════════════════════════════════════════════════════════════
section('S2 — isMasterOrDev logic unit tests');

assert('approver_tier="dev" → true',  isMasterOrDev({ approver_tier: 'dev' }) === true);
assert('approver_tier="master" → true', isMasterOrDev({ approver_tier: 'master' }) === true);
assert('approver_tier=null → false',  isMasterOrDev({ approver_tier: null }) === false);
assert('approver_tier="" → false',    isMasterOrDev({ approver_tier: '' }) === false);
assert('approver_tier="admin" → false (not a valid tier)', isMasterOrDev({ approver_tier: 'admin' }) === false);
assert('null member → falsy', !isMasterOrDev(null));
assert('undefined member → falsy', !isMasterOrDev(undefined));

// ═══════════════════════════════════════════════════════════════════════════
// S3 — approver_tier whitelist
// ═══════════════════════════════════════════════════════════════════════════
section('S3 — approver_tier whitelist (server-side sanitisation)');

assert('"dev" is valid',             safeTier('dev') === 'dev');
assert('"master" is valid',          safeTier('master') === 'master');
assert('null is valid (→ null)',      safeTier(null) === null);
assert('"" is valid (→ null)',        safeTier('') === null);
assert('"god" NOT valid (→ null)',    safeTier('god') === null);
assert('"admin" NOT valid (→ null)',  safeTier('admin') === null);
assert('"superuser" NOT valid',       safeTier('superuser') === null);
assert('undefined NOT valid (→ null)', safeTier(undefined) === null);
assert('SQL injection NOT valid',     safeTier("'; DROP TABLE admin_team;--") === null);

// ═══════════════════════════════════════════════════════════════════════════
// S4 — hasAnyPermission (team.html warning helper)
// ═══════════════════════════════════════════════════════════════════════════
section('S4 — hasAnyPermission (team.html misconfiguration warning)');

assert('null → false',  hasAnyPermission(null) === false);
assert('undefined → false', hasAnyPermission(undefined) === false);
assert('{} → false (empty object)', hasAnyPermission({}) === false);
assert('{orderbook:{}} → false (empty section)', hasAnyPermission({ orderbook: {} }) === false);
assert('{orderbook:{edit_fill_price:false}} → false (all false)', hasAnyPermission({ orderbook: { edit_fill_price: false } }) === false);
assert('{orderbook:{edit_fill_price:true}} → true', hasAnyPermission({ orderbook: { edit_fill_price: true } }) === true);
assert('{orderbook:{edit_fill_price:"direct"}} → true', hasAnyPermission({ orderbook: { edit_fill_price: 'direct' } }) === true);
assert('{orderbook:{edit_fill_price:"pending"}} → true', hasAnyPermission({ orderbook: { edit_fill_price: 'pending' } }) === true);
assert('mixed sections, one true → true', hasAnyPermission({ eft: { approve: false }, orderbook: { send_confirmation: true } }) === true);
assert('all sections all false → false', hasAnyPermission({ eft: { approve: false }, orderbook: { edit_fill_price: false } }) === false);

// ═══════════════════════════════════════════════════════════════════════════
// S5 — fillPricePerm gate logic (direct→pending override removed)
// ═══════════════════════════════════════════════════════════════════════════
section('S5 — fillPricePerm gate (direct→pending override was removed)');

// Mirrors what orderbook.html now does: only block if === false
const simulateGate = (fillPricePerm) => {
  if (fillPricePerm === false) return { blocked: true, effective: null };
  return { blocked: false, effective: fillPricePerm };
};

const r1 = simulateGate('direct');
assert('fillPricePerm="direct" → not blocked, stays "direct"', !r1.blocked && r1.effective === 'direct');

const r2 = simulateGate('pending');
assert('fillPricePerm="pending" → not blocked, stays "pending"', !r2.blocked && r2.effective === 'pending');

const r3 = simulateGate(false);
assert('fillPricePerm=false → blocked', r3.blocked === true);

const r4 = simulateGate(true);
assert('fillPricePerm=true (fallback) → not blocked', !r4.blocked && r4.effective === true);

// ── Print unit test results now ───────────────────────────────────────────
results.forEach(l => console.log(l));
results.length = 0;
console.log(`\n${'═'.repeat(60)}`);
console.log(`  UNIT TESTS: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(60));
if (failed > 0) {
  console.log('\n  Some unit tests FAILED. Fix before running API tests.\n');
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════════════
// S6 & S7 — Live API tests (read-only — no data written ever)
// ═══════════════════════════════════════════════════════════════════════════

const FAKE_TOKEN = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.invalid.token';

async function checkEndpoint(label, url, options, expectedStatus) {
  try {
    const res = await fetch(url, options);
    const body = await res.json().catch(() => ({}));
    const ok = res.status === expectedStatus;
    assert(label, ok, `Expected HTTP ${expectedStatus}, got ${res.status} — ${JSON.stringify(body)}`);
  } catch (err) {
    failed++;
    results.push(`  ❌ FAIL  ${label} → Network error: ${err.message}`);
  }
}

async function checkRejected(label, url, options) {
  try {
    const res = await fetch(url, options);
    const body = await res.json().catch(() => ({}));
    const rejected = res.status === 401 || res.status === 403;
    assert(label, rejected, `Expected 401/403, got ${res.status} — ${JSON.stringify(body)}`);
  } catch (err) {
    failed++;
    results.push(`  ❌ FAIL  ${label} → Network error: ${err.message}`);
  }
}

async function runApiTests() {
  const apiPassed = passed;

  section('S6 — Live API: no token → 401');

  await checkEndpoint('update-permissions — no token → 401',
    `${BASE_URL}/api/team?action=update-permissions`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'test' }) }, 401);

  await checkEndpoint('list-approvals — no token → 401',
    `${BASE_URL}/api/team?action=list-approvals`,
    { method: 'GET' }, 401);

  await checkEndpoint('submit-approval — no token → 401',
    `${BASE_URL}/api/team?action=submit-approval`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'fill_price' }) }, 401);

  await checkEndpoint('resolve-approval — no token → 401',
    `${BASE_URL}/api/team?action=resolve-approval`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'x', decision: 'approved' }) }, 401);

  await checkEndpoint('team list — no token → 401',
    `${BASE_URL}/api/team?action=list`,
    { method: 'GET' }, 401);

  await checkEndpoint('team invite — no token → 401',
    `${BASE_URL}/api/team?action=invite`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 't@t.com' }) }, 401);

  await checkEndpoint('team me — no token → 401',
    `${BASE_URL}/api/team?action=me`,
    { method: 'GET' }, 401);

  await checkEndpoint('approve-deposit — no token → 401',
    `${BASE_URL}/api/send-eft-email?action=approve-deposit`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transaction_id: 'test' }) }, 401);

  section('S7 — Live API: fake token → rejected (401/403)');

  await checkRejected('update-permissions — fake token → rejected',
    `${BASE_URL}/api/team?action=update-permissions`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': FAKE_TOKEN }, body: JSON.stringify({ id: 'test', permissions: {} }) });

  await checkRejected('list-approvals — fake token → rejected',
    `${BASE_URL}/api/team?action=list-approvals`,
    { method: 'GET', headers: { 'Authorization': FAKE_TOKEN } });

  await checkRejected('resolve-approval — fake token → rejected',
    `${BASE_URL}/api/team?action=resolve-approval`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': FAKE_TOKEN }, body: JSON.stringify({ id: 'x', decision: 'approved' }) });

  await checkRejected('team list — fake token → rejected',
    `${BASE_URL}/api/team?action=list`,
    { method: 'GET', headers: { 'Authorization': FAKE_TOKEN } });

  await checkRejected('approve-deposit — fake token → rejected',
    `${BASE_URL}/api/send-eft-email?action=approve-deposit`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': FAKE_TOKEN }, body: JSON.stringify({ transaction_id: 'test' }) });

  results.forEach(l => console.log(l));
  const apiTotal = passed + failed - apiPassed;
  const apiFailed = failed;
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  API TESTS: ${apiTotal - apiFailed} passed, ${apiFailed} failed out of ${apiTotal}`);
  console.log(`  TOTAL:     ${passed} passed, ${failed} failed out of ${passed + failed}`);
  console.log('═'.repeat(60));
  if (failed > 0) {
    console.log('\n  Some tests FAILED. Review the lines above.\n');
    process.exit(1);
  } else {
    console.log('\n  All tests passed.\n');
  }
}

console.log('\n  Mint CRM — Permissions Test Suite');
console.log('  Running unit tests...');
runApiTests();
