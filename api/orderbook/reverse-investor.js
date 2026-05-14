const { sendJson, fetchSupabaseJson, requestSupabaseJson, buildInFilter } = require('../_orderbook');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (!token) return sendJson(res, 401, { error: 'Missing Authorization bearer token' });

  try {
    await fetchSupabaseJson('/auth/v1/user', token, false);

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

    // 1. Fetch holdings to delete (so we can return an accurate count).
    let holdingsPath;
    if (context === 'strategy') {
      holdingsPath = `/rest/v1/stock_holdings_c?user_id=eq.${encodeURIComponent(userId)}&strategy_id=eq.${encodeURIComponent(strategyId)}&select=id`;
    } else {
      holdingsPath = `/rest/v1/stock_holdings_c?id=eq.${encodeURIComponent(sourceId)}&select=id`;
    }
    const holdingsRows = await fetchSupabaseJson(holdingsPath);
    const holdingIds = Array.isArray(holdingsRows) ? holdingsRows.map((r) => r.id).filter(Boolean) : [];

    // 2. Resolve refund from the selected transaction (cents → Rand).
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

    // 3. Read current wallet (if any).
    const walletRows = await fetchSupabaseJson(
      `/rest/v1/wallets?user_id=eq.${encodeURIComponent(userId)}&select=id,balance`
    );
    const wallet = Array.isArray(walletRows) && walletRows[0] ? walletRows[0] : null;
    const balanceBefore = Number(wallet?.balance || 0);
    const balanceAfter = balanceBefore + refundRand;
    const nowIso = new Date().toISOString();

    // 4. Delete the holdings (service-role bypasses RLS).
    let deletedCount = 0;
    let leftoverIds = [];
    if (holdingIds.length) {
      const deleted = await requestSupabaseJson(
        `/rest/v1/stock_holdings_c?id=in.(${buildInFilter(holdingIds)})&select=id`,
        { method: 'DELETE', useServiceRoleAuth: true, extraHeaders: { Prefer: 'return=representation' } }
      );
      deletedCount = Array.isArray(deleted) ? deleted.length : 0;
      // Verify — re-query the same ids; anything still present means the delete didn't take.
      const stillThere = await fetchSupabaseJson(
        `/rest/v1/stock_holdings_c?id=in.(${buildInFilter(holdingIds)})&select=id`
      );
      leftoverIds = Array.isArray(stillThere) ? stillThere.map((r) => r.id) : [];
      if (leftoverIds.length) {
        return sendJson(res, 500, {
          error: 'Holdings delete did not remove all rows',
          details: `${leftoverIds.length} of ${holdingIds.length} stock_holdings_c row(s) still present after DELETE. Check FK constraints or triggers on stock_holdings_c.`,
          requestedHoldingIds: holdingIds,
          leftoverIds,
        });
      }
    }

    // 5. Apply refund: update existing wallet or create one.
    let walletUpdated = false;
    if (refundRand > 0) {
      if (wallet) {
        const updated = await requestSupabaseJson(
          `/rest/v1/wallets?id=eq.${encodeURIComponent(wallet.id)}&select=id,balance`,
          {
            method: 'PATCH',
            useServiceRoleAuth: true,
            body: { balance: balanceAfter, updated_at: nowIso },
            extraHeaders: { Prefer: 'return=representation' }
          }
        );
        walletUpdated = Array.isArray(updated) && updated.length > 0;
      } else {
        const created = await requestSupabaseJson(
          `/rest/v1/wallets?select=id,balance`,
          {
            method: 'POST',
            useServiceRoleAuth: true,
            body: { user_id: userId, balance: balanceAfter, currency: 'ZAR', updated_at: nowIso },
            extraHeaders: { Prefer: 'return=representation' }
          }
        );
        walletUpdated = Array.isArray(created) && created.length > 0;
      }
    }

    // 6. Audit credit transaction (amount in cents).
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

    // 7. Mark the source txn as reversed so it disappears from future pickers.
    let sourceTxnReversed = false;
    if (selectedTxn?.id) {
      const updated = await requestSupabaseJson(
        `/rest/v1/transactions?id=eq.${encodeURIComponent(selectedTxn.id)}&select=id`,
        {
          method: 'PATCH',
          useServiceRoleAuth: true,
          body: { reversed: true, updated_at: nowIso },
          extraHeaders: { Prefer: 'return=representation' }
        }
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
  } catch (error) {
    return sendJson(res, 500, {
      error: 'Could not reverse investor order',
      details: error?.message || 'Unknown error'
    });
  }
};
