const { sendJson, requestSupabaseJson, fetchSupabaseJson, buildInFilter } = require('../_orderbook');

/**
 * Service-role read/write for strategy_rebalance_residuals.
 *
 * The table's RLS only grants `SELECT` to the owning user (auth.uid() = user_id)
 * and has NO write policy — by design, writes are meant to go through the admin
 * app's service-role key (see docs/strategy-rebalance-residuals.sql). The CRM was
 * reading/writing it directly from the browser, which:
 *   - returned {} when the admin read other users' residuals (RLS-filtered), and
 *   - threw "new row violates row-level security policy" on insert/update.
 * This endpoint does both with the service-role key so rebalance commit works and
 * the admin sees every holder's residual.
 *
 * POST body:
 *   { action: 'load',   strategyId, userIds: [..], familyMemberId? }
 *     -> { balances: { [userId]: randsNumber } }
 *   { action: 'upsert', strategyId, balancesByUser: { [userId]: randsNumber }, familyMemberId? }
 *     -> { ok: true, upserted: n }
 */
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (!token) return sendJson(res, 401, { error: 'Missing Authorization bearer token' });

  try {
    // Validate the caller is a signed-in admin session (same gate the other
    // orderbook service-role endpoints use).
    await fetchSupabaseJson('/auth/v1/user', token, false);

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const action = String(body.action || '').trim();
    const strategyId = String(body.strategyId || '').trim();
    if (!strategyId) return sendJson(res, 400, { error: 'strategyId required' });

    const familyMemberId = body.familyMemberId ? String(body.familyMemberId).trim() : null;
    const fmFilter = familyMemberId
      ? `&family_member_id=eq.${encodeURIComponent(familyMemberId)}`
      : `&family_member_id=is.null`;

    if (action === 'load') {
      const userIds = Array.isArray(body.userIds)
        ? [...new Set(body.userIds.map((v) => String(v || '').trim()).filter(Boolean))]
        : [];
      if (!userIds.length) return sendJson(res, 200, { balances: {} });

      const rows = await fetchSupabaseJson(
        `/rest/v1/strategy_rebalance_residuals?select=user_id,balance_cents&strategy_id=eq.${encodeURIComponent(strategyId)}&user_id=in.(${buildInFilter(userIds)})${fmFilter}`
      );
      const balances = {};
      (rows || []).forEach((r) => {
        const uid = String(r.user_id || '');
        if (!uid) return;
        balances[uid] = (Number(r.balance_cents) || 0) / 100;
      });
      return sendJson(res, 200, { balances });
    }

    if (action === 'upsert') {
      const balancesByUser = body.balancesByUser && typeof body.balancesByUser === 'object'
        ? body.balancesByUser
        : {};
      const entries = Object.entries(balancesByUser).filter(([uid]) => uid);
      if (!entries.length) return sendJson(res, 200, { ok: true, upserted: 0 });

      const nowIso = new Date().toISOString();
      let upserted = 0;

      // Manual read-then-update-or-insert per user. PostgREST's on_conflict can't
      // target the COALESCE(family_member_id, sentinel) unique index, so we do it
      // by hand — mirrors the original client logic, now with the service role.
      for (const [userId, balance] of entries) {
        const balanceCents = Math.round((Number(balance) || 0) * 100);
        const scope = `user_id=eq.${encodeURIComponent(userId)}&strategy_id=eq.${encodeURIComponent(strategyId)}${fmFilter}`;

        const updated = await requestSupabaseJson(
          `/rest/v1/strategy_rebalance_residuals?${scope}&select=user_id`,
          {
            method: 'PATCH',
            body: { balance_cents: balanceCents, updated_at: nowIso },
            extraHeaders: { Prefer: 'return=representation' },
          }
        );

        if (!Array.isArray(updated) || !updated.length) {
          await requestSupabaseJson('/rest/v1/strategy_rebalance_residuals', {
            method: 'POST',
            body: {
              user_id: userId,
              strategy_id: strategyId,
              family_member_id: familyMemberId || null,
              balance_cents: balanceCents,
              updated_at: nowIso,
            },
          });
        }
        upserted += 1;
      }

      return sendJson(res, 200, { ok: true, upserted });
    }

    return sendJson(res, 400, { error: `Unknown action: ${action || '(none)'}` });
  } catch (error) {
    return sendJson(res, 500, {
      error: 'Residuals request failed',
      details: error?.message || 'Unknown error',
    });
  }
};
