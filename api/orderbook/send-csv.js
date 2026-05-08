const { sendJson, fetchSupabaseJson, sendOrderbookCsvEmail, handleSendTradeConfirmation } = require('../_orderbook');

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

    // Fetch confirmation statuses using service-role key (bypasses RLS)
    if (action === 'get-confirmation-statuses') {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const { holdingIds } = body;
      if (!holdingIds || !holdingIds.length) {
        return sendJson(res, 200, { statuses: {} });
      }
      // Chunk into batches of 200 to avoid URL length limits
      const chunkSize = 200;
      const statuses = {};
      for (let i = 0; i < holdingIds.length; i += chunkSize) {
        const chunk = holdingIds.slice(i, i + chunkSize);
        const inFilter = chunk.map(id => `"${id}"`).join(',');
        const rows = await fetchSupabaseJson(
          `/rest/v1/investor_trade_confirmations?holding_id=in.(${inFilter})&select=holding_id,status`
        );
        if (Array.isArray(rows)) {
          rows.forEach(r => {
            if (!statuses[r.holding_id] || r.status === 'sent') {
              statuses[r.holding_id] = r.status;
            }
          });
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
