/**
 * api/cyber-compliance.js
 * Cyber Compliance & Monitoring Centre — API handler
 *
 * Actions (via ?action= query param):
 *   list-incidents      GET  — paginated cc_incidents with filters
 *   create-incident     POST — create manual incident
 *   update-incident     POST — update incident (status, notes, etc.)
 *   confirm-resolve     POST — admin confirms a pending-resolve auto-incident
 *   delete-incident     POST — delete incident by id
 *   list-uptime         GET  — uptime log with optional service_key / env filter
 *   list-api-health     GET  — api health checks with optional env filter
 *   list-policy-checks  GET  — latest policy check results
 *   list-audit-log      GET  — db audit log with table/operation/date filters
 *   list-active-users   GET  — active/logged-in users from auth.users + profiles (new vs existing badge)
 *   badge-count         GET  — count of open incidents + failed checks (for red dot)
 *   health-summary      GET  — aggregated last check time, uptime %, API pass rate, policy pass rate
 *   run-migration       POST — admin only: runs cyber_compliance.sql + audit_triggers.sql via pg direct connection
 *   check-migration     GET  — checks which cc_ tables + triggers are installed
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

      const qs   = `/rest/v1/cc_policy_checks?select=*&order=checked_at.desc&limit=${limit}`;
      const rows = await sbGet(qs);
      return sendJson(res, 200, { ok: true, checks: Array.isArray(rows) ? rows : [] });
    }

    // ── LIST AUDIT LOG ────────────────────────────────────────────────────────
    if (action === 'list-audit-log') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      const table     = url.searchParams.get('table')     || '';
      const operation = url.searchParams.get('operation') || '';
      const since     = url.searchParams.get('since')     || '';
      const limit     = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '100', 10)));

      const validTables = ['profiles', 'stock_holdings_c', 'wallet_transactions', 'strategies_c', 'securities_c', 'user_onboarding', 'cc_incidents'];
      const validOps    = ['INSERT', 'UPDATE', 'DELETE'];

      let qs = `/rest/v1/cc_audit_log?select=*&order=changed_at.desc&limit=${limit}`;
      if (table     && validTables.includes(table))   qs += `&table_name=eq.${encodeURIComponent(table)}`;
      if (operation && validOps.includes(operation))  qs += `&operation=eq.${encodeURIComponent(operation)}`;
      if (since) {
        const sinceDate = new Date(since);
        if (!isNaN(sinceDate.getTime())) qs += `&changed_at=gte.${sinceDate.toISOString()}`;
      }

      const rows = await sbGet(qs);
      return sendJson(res, 200, { ok: true, logs: Array.isArray(rows) ? rows : [] });
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
