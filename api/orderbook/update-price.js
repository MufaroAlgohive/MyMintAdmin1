const { sendJson, fetchSupabaseJson, requestSupabaseJson, buildInFilter } = require('../_orderbook');

/**
 * Reconcile the execution-reserve (8% buffer) ledger after a BUY fill price is set.
 *
 * When an admin stamps the actual fill price (avg_fill, cents) on a holding, the
 * difference against the price the client was quoted at buy time (Expected_fill,
 * rands) is real slippage. That slippage is absorbed by the 8% buffer that was
 * pre-funded on the parent transaction. This writes that movement into
 * buffer_drawdowns_c and keeps transactions.buffer_consumed_cents in sync.
 *
 * Key facts this relies on:
 *  - A strategy buy is ONE transaction (one buffer_cents pool) with MANY holdings
 *    (one per security), all sharing transaction_id. So the buffer is a shared
 *    pool drawn across every holding of that transaction.
 *  - Expected_fill is per-share RANDS; avg_fill is per-share CENTS.
 *
 * Idempotent by design: each run deletes the transaction's prior fill-type rows
 * (slippage_drawdown / shortfall) and recomputes from the CURRENT state of all
 * its holdings, so re-filling, correcting a price, or batch updates never
 * double-count. Holdings not yet filled contribute zero.
 *
 * Never throws — a ledger problem must not block the admin's price update.
 */
async function reconcileBufferDrawdowns(holdingIds) {
  try {
    if (!holdingIds || !holdingIds.length) return;

    // 1. Resolve which transactions are touched (BUY side only — SELL refunds
    //    are a separate settlement-time flow).
    const affected = await fetchSupabaseJson(
      `/rest/v1/stock_holdings_c?id=in.(${buildInFilter(holdingIds)})&select=id,transaction_id,trade_side`
    );
    const isBuy = (h) => String(h.trade_side || '').toUpperCase() !== 'SELL';
    const txIds = [...new Set((affected || [])
      .filter((h) => isBuy(h) && h.transaction_id)
      .map((h) => h.transaction_id))];
    if (!txIds.length) return;

    for (const txId of txIds) {
      try {
        // 2. Pull the transaction's buffer pool.
        const txRows = await fetchSupabaseJson(
          `/rest/v1/transactions?id=eq.${encodeURIComponent(txId)}&select=id,user_id,family_member_id,buffer_cents,buffer_consumed_cents`
        );
        const tx = txRows && txRows[0];
        if (!tx) continue;
        const bufferPool = Math.max(0, Math.round(Number(tx.buffer_cents) || 0));

        // 3. Pull ALL BUY holdings on this transaction (not just the batch we
        //    just updated) so the recompute reflects the full picture.
        const holdings = await fetchSupabaseJson(
          `/rest/v1/stock_holdings_c?transaction_id=eq.${encodeURIComponent(txId)}&select=id,quantity,avg_fill,user_id,family_member_id,trade_side,%22Expected_fill%22`
        );
        const buys = (holdings || []).filter(isBuy);

        // 4. Clear prior fill-type ledger rows for this transaction.
        await requestSupabaseJson(
          `/rest/v1/buffer_drawdowns_c?transaction_id=eq.${encodeURIComponent(txId)}&event_type=in.(slippage_drawdown,shortfall)`,
          { method: 'DELETE' }
        );

        // 5. Recompute slippage per holding, drawing from the shared pool.
        let remaining = bufferPool;
        let totalConsumed = 0;
        const rows = [];
        for (const h of buys) {
          const qty = Math.abs(Number(h.quantity) || 0);
          const expectedRand = Number(h.Expected_fill);
          const actualCents = Number(h.avg_fill);
          if (!qty) continue;
          if (!Number.isFinite(expectedRand) || expectedRand <= 0) continue;
          if (!Number.isFinite(actualCents) || actualCents <= 0) continue;

          const expectedCents = Math.round(expectedRand * 100);
          const slipPerShare = actualCents - expectedCents;
          if (slipPerShare <= 0) continue; // filled at/below quote → buffer untouched

          const need = slipPerShare * qty;
          const drawn = Math.min(need, remaining);
          const base = {
            transaction_id: txId,
            holding_id: h.id,
            user_id: tx.user_id || h.user_id,
            family_member_id: h.family_member_id || tx.family_member_id || null,
            expected_fill_cents: expectedCents,
            actual_fill_cents: actualCents,
            quantity: qty,
          };
          if (drawn > 0) {
            rows.push({ ...base, event_type: 'slippage_drawdown', delta_cents: drawn,
              notes: 'Fill price above quote — absorbed by execution reserve' });
            remaining -= drawn;
            totalConsumed += drawn;
          }
          const short = need - drawn;
          if (short > 0) {
            rows.push({ ...base, event_type: 'shortfall', delta_cents: short,
              notes: 'Slippage exceeded execution reserve' });
          }
        }

        // 6. Insert fresh ledger rows + sync the transaction's consumed total.
        if (rows.length) {
          await requestSupabaseJson('/rest/v1/buffer_drawdowns_c', { method: 'POST', body: rows });
        }
        if (Math.round(Number(tx.buffer_consumed_cents) || 0) !== totalConsumed) {
          await requestSupabaseJson(
            `/rest/v1/transactions?id=eq.${encodeURIComponent(txId)}`,
            { method: 'PATCH', body: { buffer_consumed_cents: totalConsumed } }
          );
        }
      } catch (txErr) {
        console.error(`[buffer-drawdowns] reconcile failed for tx ${txId}:`, txErr?.message || txErr);
      }
    }
  } catch (err) {
    console.error('[buffer-drawdowns] reconcile failed:', err?.message || err);
  }
}

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

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const ids = Array.isArray(body.ids) ? body.ids.map((value) => String(value || '').trim()).filter(Boolean) : [];
    const payload = body.payload && typeof body.payload === 'object' ? body.payload : null;

    if (!ids.length) {
      return sendJson(res, 400, { error: 'No ids provided' });
    }

    if (!payload || !Object.keys(payload).length) {
      return sendJson(res, 400, { error: 'No payload provided' });
    }

    const updatedRows = await requestSupabaseJson(
      `/rest/v1/stock_holdings_c?id=in.(${buildInFilter(ids)})&select=id`,
      {
        method: 'PATCH',
        token,
        useServiceRoleAuth: true,
        body: payload,
        extraHeaders: {
          Prefer: 'return=representation'
        }
      }
    );

    const updatedCount = Array.isArray(updatedRows) ? updatedRows.length : 0;
    if (!updatedCount) {
      return sendJson(res, 409, {
        error: 'No rows were updated',
        ids
      });
    }

    // If a fill price was set, reconcile the execution-reserve (8% buffer)
    // ledger for the affected transactions. Awaited so buffer_consumed_cents is
    // already up to date by the time the orderbook refreshes, but it can never
    // fail the request (the helper swallows its own errors).
    if (Object.prototype.hasOwnProperty.call(payload, 'avg_fill')) {
      await reconcileBufferDrawdowns(ids);
    }

    return sendJson(res, 200, {
      ok: true,
      updatedCount,
      updatedIds: updatedRows.map((row) => row.id)
    });
  } catch (error) {
    return sendJson(res, 500, {
      error: 'Could not update orderbook price',
      details: error?.message || 'Unknown error'
    });
  }
};