const { sendJson, fetchSupabaseJson, requestSupabaseJson } = require('./_orderbook');

const parseBearerToken = (authHeader) => {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.split(' ')[1];
};

const readJsonBody = (req) => {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
  });
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  const token = parseBearerToken(req.headers.authorization);
  if (!token) {
    return sendJson(res, 401, { error: 'Missing Authorization bearer token' });
  }

  try {
    await fetchSupabaseJson('/auth/v1/user', token, false);

    const body = typeof req.body === 'object' ? req.body : await readJsonBody(req);
    const { user_id, amount } = body;

    if (!user_id) return sendJson(res, 400, { error: 'Missing user_id' });
    if (!amount || Number(amount) <= 0) return sendJson(res, 400, { error: 'Invalid amount' });

    const numericAmount = Number(amount);

    // Check for existing wallet
    const existing = await fetchSupabaseJson(
      `/rest/v1/wallets?user_id=eq.${encodeURIComponent(user_id)}&limit=1`
    );

    let walletId;

    if (existing && existing.length > 0) {
      const wallet = existing[0];
      const newBalance = Number(wallet.balance || 0) + numericAmount;
      await requestSupabaseJson(`/rest/v1/wallets?id=eq.${encodeURIComponent(wallet.id)}`, {
        method: 'PATCH',
        useServiceRoleAuth: true,
        body: { balance: newBalance, updated_at: new Date().toISOString() },
      });
      walletId = wallet.id;
    } else {
      const created = await requestSupabaseJson('/rest/v1/wallets', {
        method: 'POST',
        useServiceRoleAuth: true,
        body: { user_id, balance: numericAmount, currency: 'ZAR' },
        extraHeaders: { Prefer: 'return=representation' },
      });
      walletId = Array.isArray(created) ? created[0]?.id : created?.id;
    }

    // Record transaction
    if (walletId) {
      await requestSupabaseJson('/rest/v1/wallet_transactions', {
        method: 'POST',
        useServiceRoleAuth: true,
        body: { wallet_id: walletId, user_id, amount: numericAmount, transaction_type: 'manual' },
      });
    }

    return sendJson(res, 200, { success: true });
  } catch (err) {
    return sendJson(res, 500, { error: err.message || 'Internal server error' });
  }
};
