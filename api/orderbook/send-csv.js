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
    await fetchSupabaseJson('/auth/v1/user', token, false);

    const action = req.query?.action || new URL(req.url, `http://${req.headers.host}`).searchParams.get('action');
    if (action === 'trade-confirmation') {
      return handleSendTradeConfirmation(req, res, token);
    }

    // Fetch a user's transactions using service-role key (bypasses RLS).
    // Used by the reverse-investor modal to find the refund amount.
    if (action === 'get-user-transactions') {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const userId = String(body.userId || '').trim();
      if (!userId) return sendJson(res, 400, { error: 'userId required' });

      // Only "Strategy Investment ..." txns that haven't been reversed yet.
      let qs = `user_id=eq.${encodeURIComponent(userId)}&name=ilike.${encodeURIComponent('%Strategy Investment%')}&reversed=eq.false&select=id,amount,name,description,direction,status,transaction_date,created_at&order=transaction_date.desc&limit=200`;
      if (body.dateFrom) qs += `&transaction_date=gte.${encodeURIComponent(body.dateFrom)}`;
      if (body.dateTo)   qs += `&transaction_date=lte.${encodeURIComponent(body.dateTo)}`;

      const rows = await fetchSupabaseJson(`/rest/v1/transactions?${qs}`);
      return sendJson(res, 200, { transactions: Array.isArray(rows) ? rows : [] });
    }

    // Reverse an investor's order: delete holdings, refund wallet, audit credit
    // txn, and flag source txn reversed=true. Done server-side to bypass RLS.
    if (action === 'reverse-investor') {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const userId = String(body.userId || '').trim();
      const context = body.context === 'security' ? 'security' : 'strategy';
      const strategyId = String(body.strategyId || '').trim();
      const sourceId = String(body.sourceId || '').trim();
      const selectedTxnId = String(body.selectedTxnId || '').trim();
      const targetName = String(body.targetName || 'Order');

      if (!userId) return sendJson(res, 400, { error: 'userId required' });
      if (context === 'strategy' && !strategyId) return sendJson(res, 400, { error: 'strategyId required for strategy context' });
      if (context === 'security' && !sourceId) return sendJson(res, 400, { error: 'sourceId required for security context' });

      // 1. Holdings to delete.
      const holdingsPath = context === 'strategy'
        ? `/rest/v1/stock_holdings_c?user_id=eq.${encodeURIComponent(userId)}&strategy_id=eq.${encodeURIComponent(strategyId)}&select=id`
        : `/rest/v1/stock_holdings_c?id=eq.${encodeURIComponent(sourceId)}&select=id`;
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

      // 3. Current wallet (if any).
      const walletRows = await fetchSupabaseJson(
        `/rest/v1/wallets?user_id=eq.${encodeURIComponent(userId)}&select=id,balance`
      );
      const wallet = Array.isArray(walletRows) && walletRows[0] ? walletRows[0] : null;
      const balanceBefore = Number(wallet?.balance || 0);
      const balanceAfter = balanceBefore + refundRand;
      const nowIso = new Date().toISOString();

      // 4. Delete holdings (service-role bypasses RLS).
      // Use bare DELETE (no Prefer/select) so PostgREST returns 204 No Content —
      // some tables/views reject return=representation on DELETE with 405.
      // We verify success with a follow-up SELECT instead.
      let deletedCount = 0;
      let leftoverIds = [];
      if (holdingIds.length) {
        await requestSupabaseJson(
          `/rest/v1/stock_holdings_c?id=in.(${buildInFilter(holdingIds)})`,
          { method: 'DELETE', useServiceRoleAuth: true }
        );
        const stillThere = await fetchSupabaseJson(
          `/rest/v1/stock_holdings_c?id=in.(${buildInFilter(holdingIds)})&select=id`
        );
        leftoverIds = Array.isArray(stillThere) ? stillThere.map((r) => r.id) : [];
        deletedCount = holdingIds.length - leftoverIds.length;
        if (leftoverIds.length) {
          return sendJson(res, 500, {
            error: 'Holdings delete did not remove all rows',
            details: `${leftoverIds.length} of ${holdingIds.length} stock_holdings_c row(s) still present after DELETE. Check FK constraints or triggers on stock_holdings_c.`,
            requestedHoldingIds: holdingIds,
            leftoverIds,
          });
        }
      }

      // 5. Apply refund.
      let walletUpdated = false;
      if (refundRand > 0) {
        if (wallet) {
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
        const auditDescription = JSON.stringify({
          type: 'reversal',
          context,
          strategyId: strategyId || null,
          sourceId: sourceId || null,
          name: targetName,
          holdingIdsDeleted: holdingIds,
          sourceTxnId: selectedTxn?.id || null,
        });
        const created = await requestSupabaseJson(
          `/rest/v1/transactions?select=id`,
          {
            method: 'POST',
            useServiceRoleAuth: true,
            body: {
              user_id: userId,
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
