/**
 * api/incidents.js
 * IT Incident Register — CRUD handler for the `it_incidents` Supabase table.
 *
 * Actions (via ?action= query param or req.body.action):
 *   list    GET  — paginated incident list with optional filters
 *   get     GET  — single incident by id
 *   create  POST — create new incident
 *   update  POST — update existing incident
 *   delete  POST — soft/hard delete incident
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

const VALID_PRIORITIES = ['low', 'medium', 'high', 'critical'];
const VALID_STATUSES   = ['open', 'in_progress', 'resolved', 'closed'];
const VALID_CATEGORIES = ['hardware', 'software', 'network', 'security', 'access', 'other'];

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const action = url.searchParams.get('action') || req.body?.action || '';

    // ── LIST ─────────────────────────────────────────────────────────────────
    if (action === 'list' || action === '') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });

      const status   = url.searchParams.get('status') || '';
      const priority = url.searchParams.get('priority') || '';
      const search   = url.searchParams.get('search') || '';
      const page     = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
      const limit    = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10)));
      const offset   = (page - 1) * limit;

      let qs = `/rest/v1/it_incidents?select=*&order=created_at.desc&limit=${limit}&offset=${offset}`;
      if (status && VALID_STATUSES.includes(status))     qs += `&status=eq.${encodeURIComponent(status)}`;
      if (priority && VALID_PRIORITIES.includes(priority)) qs += `&priority=eq.${encodeURIComponent(priority)}`;
      if (search) qs += `&or=(title.ilike.${encodeURIComponent('%' + search + '%')},description.ilike.${encodeURIComponent('%' + search + '%')})`;

      const rows = await sbGet(qs);
      return sendJson(res, 200, { ok: true, incidents: Array.isArray(rows) ? rows : [] });
    }

    // ── GET single ───────────────────────────────────────────────────────────
    if (action === 'get') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      const id = url.searchParams.get('id');
      if (!id) return sendJson(res, 400, { error: 'id required' });
      const rows = await sbGet(`/rest/v1/it_incidents?id=eq.${encodeURIComponent(id)}&limit=1`);
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row) return sendJson(res, 404, { error: 'Incident not found' });
      return sendJson(res, 200, { ok: true, incident: row });
    }

    // ── CREATE ───────────────────────────────────────────────────────────────
    if (action === 'create') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
      const b = req.body || {};
      const title = String(b.title || '').trim();
      if (!title) return sendJson(res, 400, { error: 'title is required' });

      const payload = {
        title,
        description:  String(b.description  || '').trim() || null,
        priority:     VALID_PRIORITIES.includes(b.priority) ? b.priority : 'medium',
        status:       VALID_STATUSES.includes(b.status)     ? b.status   : 'open',
        category:     VALID_CATEGORIES.includes(b.category) ? b.category : 'other',
        assigned_to:  String(b.assigned_to  || '').trim() || null,
        reported_by:  String(b.reported_by  || '').trim() || null,
        notes:        String(b.notes        || '').trim() || null,
        created_at:   new Date().toISOString(),
        updated_at:   new Date().toISOString()
      };

      const rows = await sbMutate('/rest/v1/it_incidents', payload, 'POST');
      const created = Array.isArray(rows) ? rows[0] : rows;
      return sendJson(res, 201, { ok: true, incident: created });
    }

    // ── UPDATE ───────────────────────────────────────────────────────────────
    if (action === 'update') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
      const b = req.body || {};
      const id = String(b.id || '').trim();
      if (!id) return sendJson(res, 400, { error: 'id is required' });

      const patch = { updated_at: new Date().toISOString() };
      if (b.title       !== undefined) patch.title       = String(b.title).trim();
      if (b.description !== undefined) patch.description = String(b.description || '').trim() || null;
      if (b.priority    !== undefined && VALID_PRIORITIES.includes(b.priority)) patch.priority = b.priority;
      if (b.category    !== undefined && VALID_CATEGORIES.includes(b.category)) patch.category = b.category;
      if (b.assigned_to !== undefined) patch.assigned_to = String(b.assigned_to || '').trim() || null;
      if (b.reported_by !== undefined) patch.reported_by = String(b.reported_by || '').trim() || null;
      if (b.notes       !== undefined) patch.notes       = String(b.notes       || '').trim() || null;

      if (b.status !== undefined && VALID_STATUSES.includes(b.status)) {
        patch.status = b.status;
        if (b.status === 'resolved' || b.status === 'closed') {
          patch.resolved_at = new Date().toISOString();
        } else {
          patch.resolved_at = null;
        }
      }

      const rows = await sbMutate(
        `/rest/v1/it_incidents?id=eq.${encodeURIComponent(id)}`,
        patch, 'PATCH'
      );
      const updated = Array.isArray(rows) ? rows[0] : rows;
      return sendJson(res, 200, { ok: true, incident: updated });
    }

    // ── DELETE ───────────────────────────────────────────────────────────────
    if (action === 'delete') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
      const b = req.body || {};
      const id = String(b.id || '').trim();
      if (!id) return sendJson(res, 400, { error: 'id is required' });

      const { supabaseUrl, serviceRoleKey } = getSupabaseCreds();
      const delRes = await fetch(
        `${supabaseUrl}/rest/v1/it_incidents?id=eq.${encodeURIComponent(id)}`,
        {
          method: 'DELETE',
          headers: {
            'apikey': serviceRoleKey,
            'Authorization': `Bearer ${serviceRoleKey}`,
            'Prefer': 'return=minimal'
          }
        }
      );
      if (!delRes.ok) {
        const txt = await delRes.text().catch(() => '');
        throw new Error(txt || `Delete failed with ${delRes.status}`);
      }
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 400, { error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('[Incidents]', err.message);
    return sendJson(res, 500, { error: err.message || 'Internal server error' });
  }
};
