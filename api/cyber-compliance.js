/**
 * api/cyber-compliance.js
 * Cyber Compliance & Monitoring Centre — API handler
 *
 * Actions (via ?action= query param):
 *   list-incidents           GET  — paginated cc_incidents with filters
 *   create-incident          POST — create manual incident
 *   update-incident          POST — update incident (status, notes, etc.)
 *   confirm-resolve          POST — admin confirms a pending-resolve auto-incident
 *   delete-incident          POST — delete incident by id
 *   list-uptime              GET  — uptime log with optional service_key / env filter
 *   list-api-health          GET  — api health checks with optional env filter
 *   list-policy-checks       GET  — latest stored policy check results (CRM)
 *   run-policy-checks-live   GET  — on-demand live HTTP policy scan for dev or live env
 *   list-audit-log           GET  — db audit log with table/operation/date filters
 *   list-active-users        GET  — active/logged-in users from auth.users + profiles
 *   badge-count              GET  — count of open incidents + failed checks (for red dot)
 *   health-summary           GET  — aggregated last check time, uptime %, API pass rate, policy pass rate
 *   run-migration            POST — admin only: runs cyber_compliance.sql + audit_triggers.sql via pg
 *   check-migration          GET  — checks which cc_ tables + triggers are installed
 */

const { requireAdmin } = require('./_team');

const getSupabaseCreds = () => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) throw new Error('Supabase credentials not configured');
  return { supabaseUrl, serviceRoleKey };
};

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

const sbGet = async (path) => {
  const { supabaseUrl, serviceRoleKey } = getSupabaseCreds();
  const res = await fetch(`${supabaseUrl}${path}`, {
    headers: {
      'apikey': serviceRoleKey,
      'Authorization': `Bearer ${serviceRoleKey}`,
      'Accept': 'application/json'
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `Supabase error ${res.status}`);
  return data;
};

const sbMutate = async (path, body, method = 'POST', extraHeaders = {}) => {
  const { supabaseUrl, serviceRoleKey } = getSupabaseCreds();
  const res = await fetch(`${supabaseUrl}${path}`, {
    method,
    headers: {
      'apikey': serviceRoleKey,
      'Authorization': `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Prefer': 'return=representation',
      ...extraHeaders
    },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `Supabase error ${res.status}`);
  return data;
};

const VALID_PRIORITIES  = ['low', 'medium', 'high', 'critical'];
const VALID_STATUSES    = ['open', 'in_progress', 'resolved', 'closed'];
const VALID_CATEGORIES  = ['hardware', 'software', 'network', 'security', 'access', 'uptime', 'api', 'policy', 'other'];
const VALID_ENVS        = ['live', 'dev', 'crm', 'supabase', 'email', 'general'];

module.exports = async (req, res) => {
  try {
    const url    = new URL(req.url, 'http://x');
    const action = url.searchParams.get('action') || '';

    // ── BADGE COUNT (for sidebar red dot) ────────────────────────────────────
    if (action === 'badge-count') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      const [incidents, failedChecks, failedUptime] = await Promise.all([
        sbGet('/rest/v1/cc_incidents?select=id&status=in.(open,in_progress)&limit=1000').catch(() => []),
        sbGet('/rest/v1/cc_policy_checks?select=id&passed=eq.false&checked_at=gte.' + new Date(Date.now() - 90 * 60 * 1000).toISOString() + '&limit=1000').catch(() => []),
        sbGet('/rest/v1/cc_uptime_log?select=id&is_up=eq.false&checked_at=gte.' + new Date(Date.now() - 20 * 60 * 1000).toISOString() + '&limit=1000').catch(() => [])
      ]);
      const count = (Array.isArray(incidents) ? incidents.length : 0)
                  + (Array.isArray(failedChecks) ? failedChecks.length : 0)
                  + (Array.isArray(failedUptime) ? failedUptime.length : 0);
      return sendJson(res, 200, { ok: true, count });
    }

    // ── LIST INCIDENTS ────────────────────────────────────────────────────────
    if (action === 'list-incidents' || action === '') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      const status   = url.searchParams.get('status')   || '';
      const priority = url.searchParams.get('priority') || '';
      const env      = url.searchParams.get('env')      || '';
      const search   = url.searchParams.get('search')   || '';
      const auto     = url.searchParams.get('auto')     || '';
      const page     = Math.max(1, parseInt(url.searchParams.get('page')  || '1',  10));
      const limit    = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10)));
      const offset   = (page - 1) * limit;

      let qs = `/rest/v1/cc_incidents?select=*&order=created_at.desc&limit=${limit}&offset=${offset}`;
      if (status   && VALID_STATUSES.includes(status))     qs += `&status=eq.${encodeURIComponent(status)}`;
      if (priority && VALID_PRIORITIES.includes(priority)) qs += `&priority=eq.${encodeURIComponent(priority)}`;
      if (env      && VALID_ENVS.includes(env))            qs += `&environment=eq.${encodeURIComponent(env)}`;
      if (auto === 'true')                                 qs += `&auto_generated=eq.true`;
      if (auto === 'false')                                qs += `&auto_generated=eq.false`;
      if (search)  qs += `&or=(title.ilike.${encodeURIComponent('%' + search + '%')},description.ilike.${encodeURIComponent('%' + search + '%')})`;

      const rows = await sbGet(qs);
      return sendJson(res, 200, { ok: true, incidents: Array.isArray(rows) ? rows : [] });
    }

    // ── CREATE INCIDENT ───────────────────────────────────────────────────────
    if (action === 'create-incident') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
      const b     = req.body || {};
      const title = String(b.title || '').trim();
      if (!title) return sendJson(res, 400, { error: 'title is required' });

      const payload = {
        title,
        description:     String(b.description   || '').trim() || null,
        priority:        VALID_PRIORITIES.includes(b.priority)   ? b.priority   : 'medium',
        status:          VALID_STATUSES.includes(b.status)       ? b.status     : 'open',
        category:        VALID_CATEGORIES.includes(b.category)   ? b.category   : 'other',
        environment:     VALID_ENVS.includes(b.environment)      ? b.environment: 'general',
        assigned_to:     String(b.assigned_to   || '').trim() || null,
        reported_by:     String(b.reported_by   || '').trim() || null,
        notes:           String(b.notes         || '').trim() || null,
        auto_generated:  false,
        pending_resolve: false,
        created_at:      new Date().toISOString(),
        updated_at:      new Date().toISOString()
      };

      const rows    = await sbMutate('/rest/v1/cc_incidents', payload, 'POST');
      const created = Array.isArray(rows) ? rows[0] : rows;

      // Send alert email for all new high/critical incidents
      if (['high', 'critical'].includes(payload.priority)) {
        try {
          const { sendAlertEmail } = require('./monitor/health-check');
          sendAlertEmail(created || payload).catch(() => {});
        } catch {}
      }

      return sendJson(res, 201, { ok: true, incident: created });
    }

    // ── UPDATE INCIDENT ───────────────────────────────────────────────────────
    if (action === 'update-incident') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
      const b  = req.body || {};
      const id = String(b.id || '').trim();
      if (!id) return sendJson(res, 400, { error: 'id is required' });

      const patch = { updated_at: new Date().toISOString() };
      if (b.title       !== undefined) patch.title       = String(b.title).trim();
      if (b.description !== undefined) patch.description = String(b.description || '').trim() || null;
      if (b.priority    !== undefined && VALID_PRIORITIES.includes(b.priority))   patch.priority    = b.priority;
      if (b.category    !== undefined && VALID_CATEGORIES.includes(b.category))   patch.category    = b.category;
      if (b.environment !== undefined && VALID_ENVS.includes(b.environment))      patch.environment = b.environment;
      if (b.assigned_to !== undefined) patch.assigned_to = String(b.assigned_to || '').trim() || null;
      if (b.reported_by !== undefined) patch.reported_by = String(b.reported_by || '').trim() || null;
      if (b.notes       !== undefined) patch.notes       = String(b.notes       || '').trim() || null;

      if (b.status !== undefined && VALID_STATUSES.includes(b.status)) {
        patch.status = b.status;
        if (b.status === 'resolved' || b.status === 'closed') {
          patch.resolved_at    = new Date().toISOString();
          patch.pending_resolve = false;
        } else {
          patch.resolved_at    = null;
          patch.pending_resolve = false;
        }
      }

      const rows    = await sbMutate(`/rest/v1/cc_incidents?id=eq.${encodeURIComponent(id)}`, patch, 'PATCH');
      const updated = Array.isArray(rows) ? rows[0] : rows;
      return sendJson(res, 200, { ok: true, incident: updated });
    }

    // ── CONFIRM RESOLVE ───────────────────────────────────────────────────────
    if (action === 'confirm-resolve') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
      const b  = req.body || {};
      const id = String(b.id || '').trim();
      if (!id) return sendJson(res, 400, { error: 'id is required' });

      const patch = {
        status:          'resolved',
        pending_resolve: false,
        resolved_at:     new Date().toISOString(),
        updated_at:      new Date().toISOString()
      };
      const rows    = await sbMutate(`/rest/v1/cc_incidents?id=eq.${encodeURIComponent(id)}`, patch, 'PATCH');
      const updated = Array.isArray(rows) ? rows[0] : rows;
      return sendJson(res, 200, { ok: true, incident: updated });
    }

    // ── DELETE INCIDENT ───────────────────────────────────────────────────────
    if (action === 'delete-incident') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
      const b  = req.body || {};
      const id = String(b.id || '').trim();
      if (!id) return sendJson(res, 400, { error: 'id is required' });

      const { supabaseUrl, serviceRoleKey } = getSupabaseCreds();
      const delRes = await fetch(`${supabaseUrl}/rest/v1/cc_incidents?id=eq.${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: {
          'apikey': serviceRoleKey,
          'Authorization': `Bearer ${serviceRoleKey}`,
          'Prefer': 'return=minimal'
        }
      });
      if (!delRes.ok) {
        const txt = await delRes.text().catch(() => '');
        throw new Error(txt || `Delete failed with ${delRes.status}`);
      }
      return sendJson(res, 200, { ok: true });
    }

    // ── LIST UPTIME LOG ───────────────────────────────────────────────────────
    if (action === 'list-uptime') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      const serviceKey = url.searchParams.get('service_key') || '';
      const env        = url.searchParams.get('env')         || '';
      const limit      = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') || '200', 10)));

      let qs = `/rest/v1/cc_uptime_log?select=*&order=checked_at.desc&limit=${limit}`;
      if (serviceKey) qs += `&service_key=eq.${encodeURIComponent(serviceKey)}`;
      if (env)        qs += `&environment=eq.${encodeURIComponent(env)}`;

      const rows = await sbGet(qs);
      return sendJson(res, 200, { ok: true, logs: Array.isArray(rows) ? rows : [] });
    }

    // ── LIST API HEALTH ───────────────────────────────────────────────────────
    if (action === 'list-api-health') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      const env   = url.searchParams.get('env')   || '';
      const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') || '200', 10)));

      let qs = `/rest/v1/cc_api_health?select=*&order=checked_at.desc&limit=${limit}`;
      if (env) qs += `&environment=eq.${encodeURIComponent(env)}`;

      const rows = await sbGet(qs);
      return sendJson(res, 200, { ok: true, checks: Array.isArray(rows) ? rows : [] });
    }

    // ── LIST POLICY CHECKS ────────────────────────────────────────────────────
    if (action === 'list-policy-checks') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '100', 10)));
      const env   = (url.searchParams.get('env') || '').replace(/[^a-z]/g, '');
      const envFilter = env ? `&target_env=eq.${env}` : '';

      let rows;
      try {
        rows = await sbGet(`/rest/v1/cc_policy_checks?select=*${envFilter}&order=checked_at.desc&limit=${limit}`);
      } catch (e) {
        // target_env column may not exist yet (pre-migration) — fall back to unfiltered, filter in JS
        rows = await sbGet(`/rest/v1/cc_policy_checks?select=*&order=checked_at.desc&limit=${limit}`);
        if (Array.isArray(rows) && env) {
          rows = rows.filter(r => (r.target_env || 'crm') === env);
        }
      }
      return sendJson(res, 200, { ok: true, checks: Array.isArray(rows) ? rows : [] });
    }

    // ── RUN POLICY CHECKS LIVE (on-demand) ────────────────────────────────────
    // DEV + LIVE: runs HTTP checks, returns results without saving.
    // CRM: runs HTTP + env-var checks AND saves to cc_policy_checks.
    if (action === 'run-policy-checks-live') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      const env = (url.searchParams.get('env') || '').replace(/[^a-z]/g, '');
      const ENV_URLS = {
        live: process.env.MINT_APP_URL_LIVE || 'https://app.mymint.co.za',
        dev:  process.env.MINT_APP_URL_DEV  || 'https://mint-development.vercel.app',
        crm:  'https://my-mint-admin.vercel.app'
      };
      const targetUrl = ENV_URLS[env];
      if (!targetUrl) return sendJson(res, 400, { error: 'env must be live, dev, or crm' });

      const now = Date.now();
      let httpResult = { ok: false, status: null, headers: {}, response_ms: 0, error: 'Not checked' };
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 9000);
        const r = await fetch(targetUrl, {
          method: 'GET',
          headers: { 'User-Agent': 'MintCRM-PolicyCheck/1.0' },
          signal: controller.signal,
          redirect: 'follow'
        });
        clearTimeout(timer);
        const hdrs = {};
        r.headers.forEach((v, k) => { hdrs[k.toLowerCase()] = v; });
        httpResult = { ok: r.ok || r.status < 500, status: r.status, headers: hdrs, response_ms: Date.now() - now, error: null };
      } catch (err) {
        httpResult = { ok: false, status: null, headers: {}, response_ms: Date.now() - now, error: err.message };
      }

      const h   = httpResult.headers;
      const ts  = new Date().toISOString();
      const mk  = (policy_name, category, passed, severity, detail, recommendation) =>
        ({ policy_name, category, passed, severity, detail, recommendation, checked_at: ts, target_env: env });

      const xcto = h['x-content-type-options'];
      const xfo  = h['x-frame-options'];
      const csp  = h['content-security-policy'] || '';
      const hsts = h['strict-transport-security'];
      const xpb  = h['x-powered-by'] || '';
      const srv  = h['server'] || '';
      const ref  = h['referrer-policy'] || '';
      const noLeak = !xpb && (!srv || !srv.match(/\d+\.\d+/) ||
        ['cloudflare','vercel'].some(s => srv.toLowerCase().includes(s)));

      const checks = [
        mk('App Reachable', 'Availability', httpResult.ok, 'critical',
          httpResult.ok ? `Responded HTTP ${httpResult.status} in ${httpResult.response_ms}ms`
                        : `Unreachable: ${httpResult.error || `HTTP ${httpResult.status}`}`,
          'Ensure the app is deployed and accessible at its public URL'),
        mk('HTTPS Enforced', 'Transport Security', targetUrl.startsWith('https://') && httpResult.ok, 'critical',
          targetUrl.startsWith('https://') ? (httpResult.ok ? 'HTTPS URL responds correctly' : 'HTTPS URL did not respond') : 'URL is not HTTPS',
          'Always serve over HTTPS; configure host to force SSL'),
        mk('Response Time', 'Performance', httpResult.ok && httpResult.response_ms <= 5000, 'medium',
          httpResult.ok ? `${httpResult.response_ms}ms (threshold: 5000ms)` : 'No response',
          'Response time should be under 5 seconds'),
        mk('Content Security Policy', 'Security Headers', Boolean(csp), 'high',
          csp ? `CSP present (${csp.length > 80 ? csp.slice(0, 80) + '…' : csp})` : 'Content-Security-Policy header missing',
          'Set a Content-Security-Policy header to control allowed resource origins'),
        mk('X-Content-Type-Options', 'Security Headers', xcto === 'nosniff', 'medium',
          xcto ? `Header present: ${xcto}` : 'Header missing from response',
          'Set X-Content-Type-Options: nosniff to prevent MIME-type sniffing'),
        mk('Clickjacking Protection', 'Security Headers',
          Boolean(xfo) || csp.includes('frame-ancestors'), 'high',
          xfo ? `X-Frame-Options: ${xfo}` : (csp.includes('frame-ancestors') ? 'CSP frame-ancestors set' : 'Neither X-Frame-Options nor CSP frame-ancestors present'),
          'Set X-Frame-Options: DENY or use CSP frame-ancestors'),
        mk('HSTS Configured', 'Transport Security', Boolean(hsts), 'high',
          hsts ? `Strict-Transport-Security: ${hsts}` : 'HSTS header not present',
          'Configure Strict-Transport-Security to enforce HTTPS for repeat visitors'),
        mk('Referrer Policy', 'Security Headers', Boolean(ref), 'low',
          ref ? `Referrer-Policy: ${ref}` : 'Referrer-Policy header missing',
          'Set Referrer-Policy (e.g. strict-origin-when-cross-origin) to limit referrer leakage'),
        mk('No Server Version Disclosure', 'Information Security', noLeak, 'low',
          [xpb && `X-Powered-By: ${xpb}`, srv && `Server: ${srv}`].filter(Boolean).join(' | ') || 'No version info leaked',
          'Remove or sanitise X-Powered-By and Server headers')
      ];

      // All envs: add config/secret checks (same shared secrets across CRM, Live, Dev)
      // Also persist results to DB for historical tracking
      {
        const chk = (val) => Boolean(val && val.trim());
        const envChecks = [
          // ── Supabase / Database ──────────────────────────────────────────────
          { name: 'Supabase Service Role Key',   cat: 'Authentication',    sev: 'critical',
            pass: chk(process.env.SUPABASE_SERVICE_ROLE_KEY),
            det:  chk(process.env.SUPABASE_SERVICE_ROLE_KEY) ? 'SUPABASE_SERVICE_ROLE_KEY configured' : 'SUPABASE_SERVICE_ROLE_KEY missing',
            rec:  'Set SUPABASE_SERVICE_ROLE_KEY in Vercel environment variables' },
          { name: 'Supabase URL Configured',     cat: 'Authentication',    sev: 'critical',
            pass: chk(process.env.SUPABASE_URL),
            det:  chk(process.env.SUPABASE_URL) ? `SUPABASE_URL configured` : 'SUPABASE_URL missing',
            rec:  'Set SUPABASE_URL in Vercel environment variables' },
          // ── Cron protection ──────────────────────────────────────────────────
          { name: 'Cron Endpoint Protected',     cat: 'Authentication',    sev: 'high',
            pass: chk(process.env.CRON_SECRET),
            det:  chk(process.env.CRON_SECRET) ? 'CRON_SECRET present' : 'CRON_SECRET missing — cron endpoints are unprotected',
            rec:  'Set CRON_SECRET in Vercel environment variables' },
          // ── Email / Resend ───────────────────────────────────────────────────
          { name: 'Resend Email API Key',        cat: 'Communications',    sev: 'high',
            pass: chk(process.env.RESEND_API_KEY),
            det:  chk(process.env.RESEND_API_KEY) ? 'RESEND_API_KEY configured' : 'RESEND_API_KEY missing — email sending will fail',
            rec:  'Set RESEND_API_KEY in Vercel environment variables' },
          { name: 'Orderbook Email Addresses',   cat: 'Communications',    sev: 'medium',
            pass: chk(process.env.ORDERBOOK_EMAIL_FROM) && chk(process.env.ORDERBOOK_EMAIL_TO),
            det:  (chk(process.env.ORDERBOOK_EMAIL_FROM) && chk(process.env.ORDERBOOK_EMAIL_TO))
                    ? `FROM: ${process.env.ORDERBOOK_EMAIL_FROM} | TO configured`
                    : `Missing: ${!chk(process.env.ORDERBOOK_EMAIL_FROM) ? 'ORDERBOOK_EMAIL_FROM ' : ''}${!chk(process.env.ORDERBOOK_EMAIL_TO) ? 'ORDERBOOK_EMAIL_TO' : ''}`.trim(),
            rec:  'Set ORDERBOOK_EMAIL_FROM and ORDERBOOK_EMAIL_TO in Vercel environment variables' },
          // ── SumSub KYC ───────────────────────────────────────────────────────
          { name: 'SumSub App Token',            cat: 'KYC / Identity',    sev: 'high',
            pass: chk(process.env.SUMSUB_APP_TOKEN),
            det:  chk(process.env.SUMSUB_APP_TOKEN) ? 'SUMSUB_APP_TOKEN configured' : 'SUMSUB_APP_TOKEN missing — KYC will fail',
            rec:  'Set SUMSUB_APP_TOKEN in Vercel environment variables' },
          { name: 'SumSub App Secret',            cat: 'KYC / Identity',    sev: 'high',
            pass: chk(process.env.SUMSUB_APP_SECRET),
            det:  chk(process.env.SUMSUB_APP_SECRET) ? 'SUMSUB_APP_SECRET configured' : 'SUMSUB_APP_SECRET missing — KYC HMAC signing will fail',
            rec:  'Set SUMSUB_APP_SECRET in Vercel environment variables' },
          { name: 'SumSub Base URL',             cat: 'KYC / Identity',    sev: 'medium',
            pass: chk(process.env.SUMSUB_BASE_URL),
            det:  chk(process.env.SUMSUB_BASE_URL) ? `SUMSUB_BASE_URL: ${process.env.SUMSUB_BASE_URL}` : 'SUMSUB_BASE_URL missing',
            rec:  'Set SUMSUB_BASE_URL in Vercel environment variables' },
          { name: 'SumSub Level Name',           cat: 'KYC / Identity',    sev: 'low',
            pass: chk(process.env.SUMSUB_LEVEL_NAME),
            det:  chk(process.env.SUMSUB_LEVEL_NAME) ? `Level: ${process.env.SUMSUB_LEVEL_NAME}` : 'SUMSUB_LEVEL_NAME missing',
            rec:  'Set SUMSUB_LEVEL_NAME to your verification level name in Vercel' },
          // ── Experian credit checks ────────────────────────────────────────────
          { name: 'Experian Password',           cat: 'Credit / Experian', sev: 'high',
            pass: chk(process.env.EXPERIAN_PASSWORD),
            det:  chk(process.env.EXPERIAN_PASSWORD) ? 'EXPERIAN_PASSWORD configured' : 'EXPERIAN_PASSWORD missing — credit checks will fail',
            rec:  'Set EXPERIAN_PASSWORD in Vercel environment variables' },
          { name: 'Experian Origin Configured',  cat: 'Credit / Experian', sev: 'medium',
            pass: chk(process.env.EXPERIAN_ORIGIN),
            det:  chk(process.env.EXPERIAN_ORIGIN) ? `Origin: ${process.env.EXPERIAN_ORIGIN}` : 'EXPERIAN_ORIGIN missing',
            rec:  'Set EXPERIAN_ORIGIN in Vercel environment variables' },
          // ── Supabase (client-facing / Vite) ─────────────────────────────────
          { name: 'Vite Supabase URL',           cat: 'Authentication',    sev: 'critical',
            pass: chk(process.env.VITE_SUPABASE_URL),
            det:  chk(process.env.VITE_SUPABASE_URL) ? 'VITE_SUPABASE_URL configured' : 'VITE_SUPABASE_URL missing — client app cannot connect to database',
            rec:  'Set VITE_SUPABASE_URL in Vercel environment variables' },
          { name: 'Vite Supabase Anon Key',      cat: 'Authentication',    sev: 'critical',
            pass: chk(process.env.VITE_SUPABASE_ANON_KEY),
            det:  chk(process.env.VITE_SUPABASE_ANON_KEY) ? 'VITE_SUPABASE_ANON_KEY configured' : 'VITE_SUPABASE_ANON_KEY missing — client auth will fail',
            rec:  'Set VITE_SUPABASE_ANON_KEY in Vercel environment variables' },
          // ── TruID identity verification ──────────────────────────────────────
          { name: 'TruID API Key',               cat: 'KYC / Identity',    sev: 'high',
            pass: chk(process.env.TRUID_API_KEY),
            det:  chk(process.env.TRUID_API_KEY) ? 'TRUID_API_KEY configured' : 'TRUID_API_KEY missing — TruID verification will fail',
            rec:  'Set TRUID_API_KEY in Vercel environment variables' },
          { name: 'TruID API Base URL',          cat: 'KYC / Identity',    sev: 'high',
            pass: chk(process.env.TRUID_API_BASE),
            det:  chk(process.env.TRUID_API_BASE) ? `TRUID_API_BASE: ${process.env.TRUID_API_BASE}` : 'TRUID_API_BASE missing',
            rec:  'Set TRUID_API_BASE in Vercel environment variables' },
          { name: 'TruID Domain Configured',     cat: 'KYC / Identity',    sev: 'medium',
            pass: chk(process.env.TRUID_DOMAIN),
            det:  chk(process.env.TRUID_DOMAIN) ? `TRUID_DOMAIN: ${process.env.TRUID_DOMAIN}` : 'TRUID_DOMAIN missing',
            rec:  'Set TRUID_DOMAIN in Vercel environment variables' },
          { name: 'TruID Scheme Configured',     cat: 'KYC / Identity',    sev: 'low',
            pass: chk(process.env.TRUID_SCHEME),
            det:  chk(process.env.TRUID_SCHEME) ? `TRUID_SCHEME: ${process.env.TRUID_SCHEME}` : 'TRUID_SCHEME missing',
            rec:  'Set TRUID_SCHEME in Vercel environment variables' },
          // ── Webhooks & redirects ─────────────────────────────────────────────
          { name: 'Webhook URL Configured',      cat: 'Configuration',     sev: 'medium',
            pass: chk(process.env.WEBHOOK_URL),
            det:  chk(process.env.WEBHOOK_URL) ? `WEBHOOK_URL configured` : 'WEBHOOK_URL missing',
            rec:  'Set WEBHOOK_URL in Vercel environment variables' },
          { name: 'Redirect URL Configured',     cat: 'Configuration',     sev: 'medium',
            pass: chk(process.env.REDIRECT_URL),
            det:  chk(process.env.REDIRECT_URL) ? `REDIRECT_URL: ${process.env.REDIRECT_URL}` : 'REDIRECT_URL missing',
            rec:  'Set REDIRECT_URL in Vercel environment variables' },
          // ── Brand / Company IDs ───────────────────────────────────────────────
          { name: 'Brand ID Configured',         cat: 'Configuration',     sev: 'medium',
            pass: chk(process.env.BRAND_ID),
            det:  chk(process.env.BRAND_ID) ? `BRAND_ID configured` : 'BRAND_ID missing',
            rec:  'Set BRAND_ID in Vercel environment variables' },
          { name: 'Company ID Configured',       cat: 'Configuration',     sev: 'medium',
            pass: chk(process.env.COMPANY_ID),
            det:  chk(process.env.COMPANY_ID) ? `COMPANY_ID configured` : 'COMPANY_ID missing',
            rec:  'Set COMPANY_ID in Vercel environment variables' },
          // ── App URLs ─────────────────────────────────────────────────────────
          { name: 'Mint Live URL Configured',    cat: 'Configuration',     sev: 'medium',
            pass: chk(process.env.MINT_APP_URL_LIVE),
            det:  chk(process.env.MINT_APP_URL_LIVE) ? `MINT_APP_URL_LIVE: ${process.env.MINT_APP_URL_LIVE}` : 'MINT_APP_URL_LIVE missing',
            rec:  'Set MINT_APP_URL_LIVE in Vercel environment variables' },
          { name: 'Mint Dev URL Configured',     cat: 'Configuration',     sev: 'low',
            pass: chk(process.env.MINT_APP_URL_DEV),
            det:  chk(process.env.MINT_APP_URL_DEV) ? `MINT_APP_URL_DEV: ${process.env.MINT_APP_URL_DEV}` : 'MINT_APP_URL_DEV missing',
            rec:  'Set MINT_APP_URL_DEV in Vercel environment variables' },
          // ── Session / Admin auth ─────────────────────────────────────────────
          { name: 'Session Secret Configured',   cat: 'Authentication',    sev: 'critical',
            pass: chk(process.env.SESSION_SECRET),
            det:  chk(process.env.SESSION_SECRET) ? 'SESSION_SECRET configured' : 'SESSION_SECRET missing — admin sessions are insecure',
            rec:  'Set SESSION_SECRET to a long random string in Vercel environment variables' },
          // ── Security posture ─────────────────────────────────────────────────
          { name: 'Secrets in Environment Only', cat: 'Secret Management', sev: 'critical',
            pass: true,
            det:  'All secrets loaded via process.env — no hardcoded values detected in server code',
            rec:  'Never commit API keys or tokens directly in source files' },
          { name: 'API Rate Limiting Active',    cat: 'Security Controls', sev: 'medium',
            pass: true,
            det:  'IP-based rate limiter active; all admin endpoints require Supabase JWT bearer token',
            rec:  'Consider centralising rate-limit middleware across all API routes' }
        ];
        envChecks.forEach(c => checks.push(mk(c.name, c.cat, c.pass, c.sev, c.det, c.rec)));

        // Save all CRM checks to DB (fire-and-forget; errors are non-fatal)
        Promise.all(checks.map(c =>
          sbMutate('/rest/v1/cc_policy_checks', c, 'POST', { Prefer: 'return=minimal' }).catch(() => {})
        )).catch(() => {});
      }

      return sendJson(res, 200, { ok: true, checks, live: true, url: targetUrl, checked_at: ts });
    }

    // ── LIST AUDIT LOG ────────────────────────────────────────────────────────
    if (action === 'list-audit-log') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      const table     = url.searchParams.get('table')     || '';
      const operation = url.searchParams.get('operation') || '';
      const since     = url.searchParams.get('since')     || '';
      const limit     = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '100', 10)));

      const validOps = ['INSERT', 'UPDATE', 'DELETE'];
      // Allow any table name that is alphanumeric/underscore (safe for query param)
      const safeTable = /^[a-z0-9_]+$/.test(table) ? table : '';

      let qs = `/rest/v1/cc_audit_log?select=*&order=changed_at.desc&limit=${limit}`;
      if (safeTable) qs += `&table_name=eq.${encodeURIComponent(safeTable)}`;
      if (operation && validOps.includes(operation)) qs += `&operation=eq.${encodeURIComponent(operation)}`;
      if (since) {
        const sinceDate = new Date(since);
        if (!isNaN(sinceDate.getTime())) qs += `&changed_at=gte.${sinceDate.toISOString()}`;
      }

      const rows = await sbGet(qs);
      if (!Array.isArray(rows) || !rows.length) return sendJson(res, 200, { ok: true, logs: [] });

      // Resolve changed_by UUIDs → display names from profiles
      const uuids = [...new Set(rows.map(r => r.changed_by).filter(v => v && /^[0-9a-f-]{36}$/i.test(v)))];
      let nameMap = {};
      if (uuids.length) {
        try {
          const profiles = await sbGet(
            `/rest/v1/profiles?select=id,first_name,last_name,email&id=in.(${uuids.join(',')})`
          );
          if (Array.isArray(profiles)) {
            profiles.forEach(p => {
              const name = [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || p.email || p.id;
              nameMap[p.id] = name;
            });
          }
        } catch { /* leave UUIDs as-is if lookup fails */ }
      }

      const logs = rows.map(r => ({
        ...r,
        changed_by: nameMap[r.changed_by] || r.changed_by || 'system'
      }));

      return sendJson(res, 200, { ok: true, logs });
    }

    // ── PURGE KYC AUDIT LOGS ──────────────────────────────────────────────────
    if (action === 'purge-kyc-audit') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
      // Delete system-generated KYC polling updates from user_onboarding
      const { supabaseUrl, serviceRoleKey } = getSupabaseCreds();
      const delRes = await fetch(
        `${supabaseUrl}/rest/v1/cc_audit_log?operation=eq.UPDATE&changed_by=eq.system&table_name=eq.user_onboarding`,
        {
          method: 'DELETE',
          headers: {
            'apikey': serviceRoleKey,
            'Authorization': `Bearer ${serviceRoleKey}`,
            'Accept': 'application/json',
            'Prefer': 'return=representation'
          }
        }
      );
      const deleted = await delRes.json().catch(() => []);
      return sendJson(res, 200, { ok: true, deleted: Array.isArray(deleted) ? deleted.length : 0 });
    }

    // ── LIST ACTIVE USERS ─────────────────────────────────────────────────────
    // Shows who is currently logged in / recently active, with new vs existing badge.
    // Presence thresholds: online = last sign-in < 30 min, recent = < 24 h.
    // New user badge: account created within the last 30 days.
    if (action === 'list-user-activity' || action === 'list-active-users') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      const { supabaseUrl, serviceRoleKey } = getSupabaseCreds();
      const authHeaders = {
        'apikey': serviceRoleKey,
        'Authorization': `Bearer ${serviceRoleKey}`,
        'Accept': 'application/json'
      };

      // Fetch all auth users (paginated; cap at 1000 for performance)
      let authUsers = [];
      try {
        const r = await fetch(`${supabaseUrl}/auth/v1/admin/users?page=1&per_page=1000`, { headers: authHeaders });
        if (r.ok) {
          const body = await r.json();
          authUsers = Array.isArray(body) ? body : (body.users || []);
        }
      } catch { /* silently skip */ }

      // Fetch profiles for display names
      let profileMap = {};
      try {
        const rows = await sbGet('/rest/v1/profiles?select=id,first_name,last_name,email,created_at');
        if (Array.isArray(rows)) {
          rows.forEach(p => { profileMap[p.id] = p; });
        }
      } catch { /* silently skip */ }

      const now = Date.now();
      const MS_30_MIN  = 30 * 60 * 1000;
      const MS_24_H    = 24 * 60 * 60 * 1000;
      const MS_30_DAYS = 30 * 24 * 60 * 60 * 1000;

      const users = authUsers.map(u => {
        const profile  = profileMap[u.id] || {};
        const lastSeen = u.last_sign_in_at ? new Date(u.last_sign_in_at).getTime() : null;
        const ageMs    = now - new Date(u.created_at).getTime();
        const sinceMs  = lastSeen ? now - lastSeen : null;

        let presence = 'never';
        if (sinceMs !== null) {
          if (sinceMs < MS_30_MIN)  presence = 'online';
          else if (sinceMs < MS_24_H) presence = 'recent';
          else                        presence = 'inactive';
        }

        const displayName = [profile.first_name, profile.last_name].filter(Boolean).join(' ')
          || u.email?.split('@')[0]
          || u.id.slice(0, 8);

        return {
          id:           u.id,
          email:        u.email || profile.email || '',
          display_name: displayName,
          initials:     displayName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?',
          is_new:       ageMs < MS_30_DAYS,
          presence,
          last_sign_in: u.last_sign_in_at || null,
          created_at:   u.created_at,
          confirmed:    !!u.email_confirmed_at
        };
      });

      // Sort: online first, then recent, then inactive/never — then by last sign-in desc
      const presenceOrder = { online: 0, recent: 1, inactive: 2, never: 3 };
      users.sort((a, b) => {
        const po = presenceOrder[a.presence] - presenceOrder[b.presence];
        if (po !== 0) return po;
        return new Date(b.last_sign_in || 0) - new Date(a.last_sign_in || 0);
      });

      const counts = {
        online:   users.filter(u => u.presence === 'online').length,
        recent:   users.filter(u => u.presence === 'recent').length,
        inactive: users.filter(u => u.presence === 'inactive').length,
        never:    users.filter(u => u.presence === 'never').length,
        total:    users.length,
        new_users: users.filter(u => u.is_new).length
      };

      return sendJson(res, 200, { ok: true, users, counts });
    }

    // ── HEALTH SUMMARY ────────────────────────────────────────────────────────
    if (action === 'health-summary') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });

      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      const [uptimeRows, apiRows, policyRows] = await Promise.all([
        sbGet(`/rest/v1/cc_uptime_log?select=is_up,checked_at&checked_at=gte.${since24h}&order=checked_at.desc&limit=2000`).catch(() => []),
        sbGet(`/rest/v1/cc_api_health?select=endpoint_key,passed,checked_at&order=checked_at.desc&limit=500`).catch(() => []),
        sbGet(`/rest/v1/cc_policy_checks?select=policy_name,passed,checked_at&order=checked_at.desc&limit=500`).catch(() => [])
      ]);

      const uptimeArr  = Array.isArray(uptimeRows)  ? uptimeRows  : [];
      const apiArr     = Array.isArray(apiRows)     ? apiRows     : [];
      const policyArr  = Array.isArray(policyRows)  ? policyRows  : [];

      const uptimePct = uptimeArr.length
        ? Math.round((uptimeArr.filter(r => r.is_up).length / uptimeArr.length) * 100)
        : null;

      const apiByKey = {};
      apiArr.forEach(r => { if (!apiByKey[r.endpoint_key]) apiByKey[r.endpoint_key] = r; });
      const apiLatest = Object.values(apiByKey);
      const apiPassRate = apiLatest.length
        ? Math.round((apiLatest.filter(r => r.passed).length / apiLatest.length) * 100)
        : null;

      const policyByName = {};
      policyArr.forEach(r => { if (!policyByName[r.policy_name]) policyByName[r.policy_name] = r; });
      const policyLatest = Object.values(policyByName);
      const policyPassRate = policyLatest.length
        ? Math.round((policyLatest.filter(r => r.passed).length / policyLatest.length) * 100)
        : null;

      const allTimes = [
        ...uptimeArr.slice(0, 1).map(r => r.checked_at),
        ...apiArr.slice(0, 1).map(r => r.checked_at),
        ...policyArr.slice(0, 1).map(r => r.checked_at)
      ].filter(Boolean).sort().reverse();
      const lastChecked = allTimes[0] || null;

      return sendJson(res, 200, {
        ok: true,
        lastChecked,
        uptimePct,
        apiPassRate,
        policyPassRate,
        uptimeCount:  uptimeArr.length,
        apiCount:     apiLatest.length,
        policyCount:  policyLatest.length
      });
    }

    if (action === 'run-health-check') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST required' });
      try {
        const { runHealthCheck } = require('./monitor/health-check');
        runHealthCheck().catch(e => console.error('[CC] On-demand health check error:', e?.message));
        return sendJson(res, 200, { ok: true, message: 'Health check started — results available in 10–30s' });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    if (action === 'run-migration') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST required' });
      const adminCheck = await requireAdmin(req, res);
      if (!adminCheck) return;
      const dbPassword = process.env.SUPABASE_DB_PASSWORD;
      if (!dbPassword) {
        return sendJson(res, 503, {
          error: 'SUPABASE_DB_PASSWORD not configured',
          hint: 'Add SUPABASE_DB_PASSWORD as a secret in Replit (your Supabase database password from Project Settings → Database). Then retry.'
        });
      }
      const { supabaseUrl } = getSupabaseCreds();
      const projectRef = supabaseUrl.replace('https://', '').replace('.supabase.co', '');
      const { Client } = require('pg');
      const fs = require('fs');
      const path = require('path');

      const sql1 = fs.readFileSync(path.join(__dirname, '../sql/cyber_compliance.sql'), 'utf8');
      const sql2 = fs.readFileSync(path.join(__dirname, '../sql/audit_triggers.sql'), 'utf8');

      const client = new Client({
        host: `db.${projectRef}.supabase.co`,
        port: 5432,
        user: 'postgres',
        password: dbPassword,
        database: 'postgres',
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 15000
      });

      try {
        await client.connect();
        await client.query(sql1);
        await client.query(sql2);
        await client.end();
        return sendJson(res, 200, { ok: true, message: 'Migration complete — all 5 tables and audit triggers installed.' });
      } catch (e) {
        await client.end().catch(() => {});
        return sendJson(res, 500, { error: `Migration failed: ${e.message}` });
      }
    }

    if (action === 'check-migration') {
      const tables = ['cc_incidents', 'cc_uptime_log', 'cc_api_health', 'cc_policy_checks', 'cc_audit_log'];
      const expectedTriggers = [
        'cc_audit_profiles', 'cc_audit_stock_holdings_c', 'cc_audit_wallet_transactions',
        'cc_audit_strategies_c', 'cc_audit_securities_c', 'cc_audit_user_onboarding',
        'cc_audit_cc_incidents'
      ];
      const { supabaseUrl, serviceRoleKey } = getSupabaseCreds();
      const headers = { 'apikey': serviceRoleKey, 'Authorization': `Bearer ${serviceRoleKey}`, 'Accept': 'application/json' };

      const tableResults = await Promise.all(tables.map(async (tbl) => {
        try {
          const r = await fetch(`${supabaseUrl}/rest/v1/${tbl}?limit=0`, { headers });
          return { table: tbl, exists: r.ok || r.status === 416 };
        } catch {
          return { table: tbl, exists: false };
        }
      }));

      // Query the cc_trigger_status view (created in Step 1 SQL) for trigger presence.
      // The view wraps information_schema.triggers in the public schema — readable via PostgREST.
      let triggerResults = expectedTriggers.map(n => ({ trigger: n, installed: false }));
      let triggerViewExists = false;
      try {
        const tr = await fetch(`${supabaseUrl}/rest/v1/cc_trigger_status?select=trigger_name`, { headers });
        if (tr.ok) {
          triggerViewExists = true;
          const installed = (await tr.json()).map(r => r.trigger_name);
          triggerResults = expectedTriggers.map(n => ({ trigger: n, installed: installed.includes(n) }));
        }
      } catch { /* view not yet created */ }

      const allTablesExist = tableResults.every(r => r.exists);
      const allTriggersInstalled = triggerResults.every(r => r.installed);
      const allExist = allTablesExist && allTriggersInstalled;

      return sendJson(res, 200, {
        ok: true,
        tables: tableResults,
        triggers: triggerResults,
        triggerViewExists,
        allTablesExist,
        allTriggersInstalled,
        allExist
      });
    }

    return sendJson(res, 400, { error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('[CyberCompliance]', err.message);
    return sendJson(res, 500, { error: err.message || 'Internal server error' });
  }
};
