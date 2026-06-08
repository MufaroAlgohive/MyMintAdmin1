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
 *   list-user-activity  GET  — live feed of user actions from key tables
 *   badge-count         GET  — count of open incidents + failed checks (for red dot)
 */

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

    // ── LIST USER ACTIVITY ────────────────────────────────────────────────────
    if (action === 'list-user-activity') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10)));

      const [recentHoldings, recentWallet, recentKyc, recentProfiles] = await Promise.all([
        sbGet(`/rest/v1/stock_holdings_c?select=id,user_id,security_id,trade_side,quantity,avg_fill,created_at,closed_reason,is_active&order=created_at.desc&limit=${Math.ceil(limit / 4)}`).catch(() => []),
        sbGet(`/rest/v1/wallet_transactions?select=id,user_id,amount,type,description,created_at&order=created_at.desc&limit=${Math.ceil(limit / 4)}`).catch(() => []),
        sbGet(`/rest/v1/user_onboarding?select=id,user_id,status,kyc_status,updated_at&order=updated_at.desc&limit=${Math.ceil(limit / 4)}`).catch(() => []),
        sbGet(`/rest/v1/profiles?select=id,first_name,last_name,email,created_at&order=created_at.desc&limit=${Math.ceil(limit / 4)}`).catch(() => [])
      ]);

      const activities = [];

      (Array.isArray(recentHoldings) ? recentHoldings : []).forEach(r => {
        activities.push({
          type:       'trade',
          icon:       r.trade_side === 'SELL' ? 'sell' : 'buy',
          label:      `${r.trade_side || 'Trade'} — ${r.quantity} units`,
          user_id:    r.user_id,
          detail:     r.is_active ? 'Active position' : `Closed: ${r.closed_reason || 'n/a'}`,
          timestamp:  r.created_at,
          has_error:  false
        });
      });

      (Array.isArray(recentWallet) ? recentWallet : []).forEach(r => {
        activities.push({
          type:      'wallet',
          icon:      'wallet',
          label:     `Wallet ${r.type || 'transaction'} — R${Number(r.amount || 0).toFixed(2)}`,
          user_id:   r.user_id,
          detail:    r.description || '',
          timestamp: r.created_at,
          has_error: false
        });
      });

      (Array.isArray(recentKyc) ? recentKyc : []).forEach(r => {
        const kycFailed = r.kyc_status && !['approved', 'completed'].includes(String(r.kyc_status).toLowerCase());
        activities.push({
          type:      'kyc',
          icon:      kycFailed ? 'error' : 'kyc',
          label:     `KYC ${r.kyc_status || r.status || 'update'}`,
          user_id:   r.user_id,
          detail:    `Status: ${r.status || '—'} / KYC: ${r.kyc_status || '—'}`,
          timestamp: r.updated_at,
          has_error: kycFailed
        });
      });

      (Array.isArray(recentProfiles) ? recentProfiles : []).forEach(r => {
        activities.push({
          type:      'signup',
          icon:      'user',
          label:     `New user: ${[r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || r.id}`,
          user_id:   r.id,
          detail:    r.email || '',
          timestamp: r.created_at,
          has_error: false
        });
      });

      activities.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      return sendJson(res, 200, { ok: true, activities: activities.slice(0, limit) });
    }

    return sendJson(res, 400, { error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('[CyberCompliance]', err.message);
    return sendJson(res, 500, { error: err.message || 'Internal server error' });
  }
};
