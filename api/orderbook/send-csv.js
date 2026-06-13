const { sendJson, fetchSupabaseJson, requestSupabaseJson, buildInFilter, sendOrderbookCsvEmail, handleSendTradeConfirmation } = require('../_orderbook');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (!token) {
    return sendJson(res, 401, { error: 'Missing Authorization bearer token' });
  }

  try {
    const authUser = await fetchSupabaseJson('/auth/v1/user', token, false);

    const action = req.query?.action || new URL(req.url, `http://${req.headers.host}`).searchParams.get('action');
    if (action === 'trade-confirmation') {
      return handleSendTradeConfirmation(req, res, token);
    }

    // ── Orderbook pins ────────────────────────────────────────────────────────
    // Pin an investor row (by pin_key = buildInvestorKey: userId|familyMemberId|
    // txn) so it floats to the top of that strategy's investor list. Non-
    // destructive — no password gate. Stored in orderbook_pins (service-role).
    if (action === 'list-pins') {
      const pins = await fetchSupabaseJson('/rest/v1/orderbook_pins?select=pin_key,user_id');
      return sendJson(res, 200, { pins: Array.isArray(pins) ? pins : [] });
    }
    if (action === 'pin-investor' || action === 'unpin-investor') {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const pinKey = String(body.pinKey || '').trim();
      if (!pinKey) return sendJson(res, 400, { error: 'pinKey required' });
      if (action === 'unpin-investor') {
        await requestSupabaseJson(`/rest/v1/orderbook_pins?pin_key=eq.${encodeURIComponent(pinKey)}`, { method: 'DELETE' });
        return sendJson(res, 200, { ok: true, pinned: false });
      }
      await requestSupabaseJson('/rest/v1/orderbook_pins?on_conflict=pin_key', {
        method: 'POST',
        extraHeaders: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: { pin_key: pinKey, user_id: String(body.userId || '') || null, pinned_by: authUser?.email || null, pinned_at: new Date().toISOString() }
      });
      return sendJson(res, 200, { ok: true, pinned: true });
    }

    // Fetch a user's transactions using service-role key (bypasses RLS).
    // Used by the reverse-investor modal to find the refund amount.
    if (action === 'get-user-transactions') {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const userId = String(body.userId || '').trim();
      const familyMemberId = String(body.familyMemberId || '').trim();
      if (!userId) return sendJson(res, 400, { error: 'userId required' });

      const baseQs = () => {
        // Fetch both strategy ("Strategy Investment: X") and single-security
        // ("Purchased X") transactions — the name filter was Strategy Investment
        // only, which silently dropped direct stock buys. Client-side narrows
        // to the specific security/strategy after fetch.
        let qs = `user_id=eq.${encodeURIComponent(userId)}&select=id,amount,name,description,direction,status,transaction_date,created_at,family_member_id&order=transaction_date.desc&limit=400`;
        // Scope to the right account: family member's txns vs parent's own.
        if (familyMemberId) qs += `&family_member_id=eq.${encodeURIComponent(familyMemberId)}`;
        else qs += `&family_member_id=is.null`;
        if (body.dateFrom) qs += `&transaction_date=gte.${encodeURIComponent(body.dateFrom)}`;
        if (body.dateTo)   qs += `&transaction_date=lte.${encodeURIComponent(body.dateTo)}`;
        return qs;
      };

      let rows;
      try {
        rows = await fetchSupabaseJson(`/rest/v1/transactions?${baseQs()}&reversed=eq.false`);
      } catch (_) {
        rows = await fetchSupabaseJson(`/rest/v1/transactions?${baseQs()}`);
      }
      return sendJson(res, 200, { transactions: Array.isArray(rows) ? rows : [] });
    }

    // Reverse an investor's order: delete holdings, refund wallet, audit credit
    // txn, and flag source txn reversed=true. Done server-side to bypass RLS.
    if (action === 'reverse-investor') {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const userId = String(body.userId || '').trim();
      const familyMemberId = String(body.familyMemberId || '').trim();
      const context = body.context === 'security' ? 'security' : 'strategy';
      const strategyId = String(body.strategyId || '').trim();
      const sourceId = String(body.sourceId || '').trim();
      const selectedTxnId = String(body.selectedTxnId || '').trim();
      const targetName = String(body.targetName || 'Order');
      // Scope to a specific buy event by created_at window (the investors
      // panel passes the minute bucket ±5s of the original purchase).
      // Optional — falls back to whole-strategy when missing.
      const createdAtFrom = String(body.createdAtFrom || '').trim();
      const createdAtTo = String(body.createdAtTo || '').trim();

      if (!userId) return sendJson(res, 400, { error: 'userId required' });
      if (context === 'strategy' && !strategyId) return sendJson(res, 400, { error: 'strategyId required for strategy context' });
      if (context === 'security' && !sourceId) return sendJson(res, 400, { error: 'sourceId required for security context' });

      // 1. Holdings to delete — for strategy context, scope by user + strategy
      //    and optionally by created_at window so two separate buys of the
      //    same strategy by the same user don't get reversed together.
      let holdingsPath;
      if (context === 'strategy') {
        let qs = `user_id=eq.${encodeURIComponent(userId)}&strategy_id=eq.${encodeURIComponent(strategyId)}`;
        if (familyMemberId) {
          qs += `&family_member_id=eq.${encodeURIComponent(familyMemberId)}`;
        } else {
          qs += `&family_member_id=is.null`;
        }
        if (createdAtFrom) {
          const fromMs = new Date(createdAtFrom).getTime() - 5000;
          if (Number.isFinite(fromMs)) qs += `&created_at=gte.${encodeURIComponent(new Date(fromMs).toISOString())}`;
        }
        if (createdAtTo) {
          const toMs = new Date(createdAtTo).getTime() + 5000;
          if (Number.isFinite(toMs)) qs += `&created_at=lte.${encodeURIComponent(new Date(toMs).toISOString())}`;
        }
        holdingsPath = `/rest/v1/stock_holdings_c?${qs}&select=id`;
      } else {
        holdingsPath = `/rest/v1/stock_holdings_c?id=eq.${encodeURIComponent(sourceId)}&select=id`;
      }
      const holdingsRows = await fetchSupabaseJson(holdingsPath);
      const holdingIds = Array.isArray(holdingsRows) ? holdingsRows.map((r) => r.id).filter(Boolean) : [];

      // 2. Resolve refund from the selected transaction.
      let refundCents = 0;
      let selectedTxn = null;
      if (selectedTxnId) {
        const txns = await fetchSupabaseJson(
          `/rest/v1/transactions?id=eq.${encodeURIComponent(selectedTxnId)}&user_id=eq.${encodeURIComponent(userId)}&select=id,amount,name,description`
        );
        selectedTxn = Array.isArray(txns) && txns[0] ? txns[0] : null;
        if (!selectedTxn) return sendJson(res, 400, { error: 'Selected transaction not found for this user' });
        refundCents = Math.round(Number(selectedTxn.amount || 0));
      }
      const refundRand = refundCents / 100;

      // 3. Read the right balance source: family_members.available_balance for
      //    a family-member account, wallets.balance for the parent themselves.
      let wallet = null;
      let familyMember = null;
      let balanceBefore = 0;
      if (familyMemberId) {
        const fmRows = await fetchSupabaseJson(
          `/rest/v1/family_members?id=eq.${encodeURIComponent(familyMemberId)}&select=id,available_balance`
        );
        familyMember = Array.isArray(fmRows) && fmRows[0] ? fmRows[0] : null;
        if (!familyMember) return sendJson(res, 400, { error: 'Family member not found' });
        // available_balance is in cents — work in Rands to stay consistent with wallets.
        balanceBefore = Number(familyMember.available_balance || 0) / 100;
      } else {
        const walletRows = await fetchSupabaseJson(
          `/rest/v1/wallets?user_id=eq.${encodeURIComponent(userId)}&select=id,balance`
        );
        wallet = Array.isArray(walletRows) && walletRows[0] ? walletRows[0] : null;
        balanceBefore = Number(wallet?.balance || 0);
      }
      const balanceAfter = balanceBefore + refundRand;
      const nowIso = new Date().toISOString();

      // 4. Delete holdings (service-role bypasses RLS) + verify.
      let deletedCount = 0;
      let leftoverIds = [];
      if (holdingIds.length) {
        const deleted = await requestSupabaseJson(
          `/rest/v1/stock_holdings_c?id=in.(${buildInFilter(holdingIds)})&select=id`,
          { method: 'DELETE', useServiceRoleAuth: true, extraHeaders: { Prefer: 'return=representation' } }
        );
        deletedCount = Array.isArray(deleted) ? deleted.length : 0;
        const stillThere = await fetchSupabaseJson(
          `/rest/v1/stock_holdings_c?id=in.(${buildInFilter(holdingIds)})&select=id`
        );
        leftoverIds = Array.isArray(stillThere) ? stillThere.map((r) => r.id) : [];
        if (!deletedCount) deletedCount = holdingIds.length - leftoverIds.length;
        if (leftoverIds.length) {
          return sendJson(res, 500, {
            error: 'Holdings delete did not remove all rows',
            details: `${leftoverIds.length} of ${holdingIds.length} stock_holdings_c row(s) still present after DELETE. Check FK constraints or triggers on stock_holdings_c.`,
            requestedHoldingIds: holdingIds,
            leftoverIds,
          });
        }
      }

      // 5. Apply refund to the right account.
      let walletUpdated = false;
      if (refundRand > 0) {
        if (familyMember) {
          const updated = await requestSupabaseJson(
            `/rest/v1/family_members?id=eq.${encodeURIComponent(familyMember.id)}&select=id,available_balance`,
            { method: 'PATCH', useServiceRoleAuth: true, body: { available_balance: Math.round(balanceAfter * 100), updated_at: nowIso }, extraHeaders: { Prefer: 'return=representation' } }
          );
          walletUpdated = Array.isArray(updated) && updated.length > 0;
        } else if (wallet) {
          const updated = await requestSupabaseJson(
            `/rest/v1/wallets?id=eq.${encodeURIComponent(wallet.id)}&select=id,balance`,
            { method: 'PATCH', useServiceRoleAuth: true, body: { balance: balanceAfter, updated_at: nowIso }, extraHeaders: { Prefer: 'return=representation' } }
          );
          walletUpdated = Array.isArray(updated) && updated.length > 0;
        } else {
          const created = await requestSupabaseJson(
            `/rest/v1/wallets?select=id,balance`,
            { method: 'POST', useServiceRoleAuth: true, body: { user_id: userId, balance: balanceAfter, currency: 'ZAR', updated_at: nowIso }, extraHeaders: { Prefer: 'return=representation' } }
          );
          walletUpdated = Array.isArray(created) && created.length > 0;
        }
      }

      // 6. Audit credit txn.
      let auditTxnId = null;
      if (refundCents > 0) {
        const auditDescription = `Order reversal for ${targetName}. ${holdingIds.length} holding(s) removed.`;
        const created = await requestSupabaseJson(
          `/rest/v1/transactions?select=id`,
          {
            method: 'POST',
            useServiceRoleAuth: true,
            body: {
              user_id: userId,
              family_member_id: familyMemberId || null,
              amount: refundCents,
              direction: 'credit',
              status: 'posted',
              name: `Reversal: ${targetName}`,
              description: auditDescription,
              currency: 'ZAR',
              transaction_date: nowIso,
            },
            extraHeaders: { Prefer: 'return=representation' }
          }
        );
        auditTxnId = Array.isArray(created) && created[0] ? created[0].id : null;
      }

      // 7. Flag source txn as reversed.
      let sourceTxnReversed = false;
      if (selectedTxn?.id) {
        const updated = await requestSupabaseJson(
          `/rest/v1/transactions?id=eq.${encodeURIComponent(selectedTxn.id)}&select=id`,
          { method: 'PATCH', useServiceRoleAuth: true, body: { reversed: true, updated_at: nowIso }, extraHeaders: { Prefer: 'return=representation' } }
        );
        sourceTxnReversed = Array.isArray(updated) && updated.length > 0;
      }

      return sendJson(res, 200, {
        ok: true,
        deletedCount,
        requestedHoldingIds: holdingIds,
        refund: refundRand,
        refundCents,
        walletUpdated,
        balanceBefore,
        balanceAfter: refundRand > 0 ? balanceAfter : balanceBefore,
        auditTxnId,
        selectedTxnId: selectedTxn?.id || null,
        sourceTxnReversed,
      });
    }

    // Fetch execution-reserve (8% buffer) ledger rows via service-role key
    // (bypasses RLS) so the orderbook's MINT PnL column can reliably show the
    // shortfall (slippage beyond the reserve) regardless of RLS on the table.
    if (action === 'get-buffer-drawdowns') {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const holdingIds = Array.isArray(body.holdingIds)
        ? body.holdingIds.map((v) => String(v || '').trim()).filter(Boolean)
        : [];
      if (!holdingIds.length) return sendJson(res, 200, { drawdowns: [] });

      const chunkSize = 150;
      const all = [];
      for (let i = 0; i < holdingIds.length; i += chunkSize) {
        const chunk = holdingIds.slice(i, i + chunkSize);
        const rows = await fetchSupabaseJson(
          `/rest/v1/buffer_drawdowns_c?holding_id=in.(${buildInFilter(chunk)})&event_type=in.(slippage_drawdown,shortfall)&select=holding_id,event_type,delta_cents`
        );
        if (Array.isArray(rows)) all.push(...rows);
      }
      return sendJson(res, 200, { drawdowns: all });
    }

    // Read strategy_rebalance_residuals with the service-role key. The table's
    // RLS only grants SELECT to the owning user, so a browser read returns {} for
    // every other client — this lets the admin see every holder's residual.
    if (action === 'rebalance-load-residuals') {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const strategyId = String(body.strategyId || '').trim();
      if (!strategyId) return sendJson(res, 400, { error: 'strategyId required' });
      const userIds = Array.isArray(body.userIds)
        ? [...new Set(body.userIds.map((v) => String(v || '').trim()).filter(Boolean))]
        : [];
      if (!userIds.length) return sendJson(res, 200, { balances: {} });
      const familyMemberId = body.familyMemberId ? String(body.familyMemberId).trim() : null;
      const fmFilter = familyMemberId
        ? `&family_member_id=eq.${encodeURIComponent(familyMemberId)}`
        : `&family_member_id=is.null`;

      const rows = await fetchSupabaseJson(
        `/rest/v1/strategy_rebalance_residuals?select=user_id,balance_cents&strategy_id=eq.${encodeURIComponent(strategyId)}&user_id=in.(${buildInFilter(userIds)})${fmFilter}`
      );
      const balances = {};
      (rows || []).forEach((r) => {
        const uid = String(r.user_id || '');
        if (uid) balances[uid] = (Number(r.balance_cents) || 0) / 100;
      });
      return sendJson(res, 200, { balances });
    }

    // Upsert strategy_rebalance_residuals with the service-role key. The table has
    // no write RLS policy (writes are service-role only by design), so a browser
    // upsert fails with "new row violates row-level security policy".
    if (action === 'rebalance-upsert-residuals') {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const strategyId = String(body.strategyId || '').trim();
      if (!strategyId) return sendJson(res, 400, { error: 'strategyId required' });
      const familyMemberId = body.familyMemberId ? String(body.familyMemberId).trim() : null;
      const fmFilter = familyMemberId
        ? `&family_member_id=eq.${encodeURIComponent(familyMemberId)}`
        : `&family_member_id=is.null`;
      const balancesByUser = body.balancesByUser && typeof body.balancesByUser === 'object'
        ? body.balancesByUser
        : {};
      const entries = Object.entries(balancesByUser).filter(([uid]) => uid);
      if (!entries.length) return sendJson(res, 200, { ok: true, upserted: 0 });

      const nowIso = new Date().toISOString();
      let upserted = 0;
      // Manual read-then-update-or-insert per user — PostgREST on_conflict can't
      // target the COALESCE(family_member_id, sentinel) unique index.
      for (const [userId, balance] of entries) {
        const balanceCents = Math.round((Number(balance) || 0) * 100);
        const scope = `user_id=eq.${encodeURIComponent(userId)}&strategy_id=eq.${encodeURIComponent(strategyId)}${fmFilter}`;
        const updated = await requestSupabaseJson(
          `/rest/v1/strategy_rebalance_residuals?${scope}&select=user_id`,
          { method: 'PATCH', body: { balance_cents: balanceCents, updated_at: nowIso }, extraHeaders: { Prefer: 'return=representation' } }
        );
        if (!Array.isArray(updated) || !updated.length) {
          await requestSupabaseJson('/rest/v1/strategy_rebalance_residuals', {
            method: 'POST',
            body: { user_id: userId, strategy_id: strategyId, family_member_id: familyMemberId || null, balance_cents: balanceCents, updated_at: nowIso },
          });
        }
        upserted += 1;
      }
      return sendJson(res, 200, { ok: true, upserted });
    }

    // Fetch confirmation statuses using service-role key (bypasses RLS)
    if (action === 'get-confirmation-statuses') {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const { holdingIds, batchIds } = body;
      const statuses = {};
      const chunkSize = 200;

      // 1. Check individual holding IDs
      if (holdingIds && holdingIds.length) {
        for (let i = 0; i < holdingIds.length; i += chunkSize) {
          const chunk = holdingIds.slice(i, i + chunkSize);
          const inFilter = chunk.map(id => `"${id}"`).join(',');
          const rows = await fetchSupabaseJson(
            `/rest/v1/investor_trade_confirmations?holding_id=in.(${inFilter})&select=holding_id,status`
          );
          if (Array.isArray(rows)) {
            rows.forEach(r => {
              if (!statuses[r.holding_id] || r.status === 'sent') statuses[r.holding_id] = r.status;
            });
          }
        }
      }

      // 2. Check Rebalance Batch IDs
      if (batchIds && batchIds.length) {
        for (let i = 0; i < batchIds.length; i += chunkSize) {
          const chunk = batchIds.slice(i, i + chunkSize);
          const inFilter = chunk.map(id => `"${id}"`).join(',');
          const rows = await fetchSupabaseJson(
            `/rest/v1/investor_trade_confirmations?rebalance_batch_id=in.(${inFilter})&select=rebalance_batch_id,status`
          );
          if (Array.isArray(rows)) {
            rows.forEach(r => {
              if (!statuses[r.rebalance_batch_id] || r.status === 'sent') statuses[r.rebalance_batch_id] = r.status;
            });
          }
        }
      }

      return sendJson(res, 200, { statuses });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    await sendOrderbookCsvEmail({
      subject: body.subject,
      csvContent: body.csvContent,
      fileName: body.fileName
    });

    return sendJson(res, 200, { ok: true });
  } catch (error) {
    return sendJson(res, 500, {
      error: 'Could not process orderbook email request',
      details: error?.message || 'Unknown error'
    });
  }
};
