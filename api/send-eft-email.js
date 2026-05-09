const fs = require('fs');
const path = require('path');
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

const handleAddWallet = async (req, res, token) => {
  let body;
  try {
    body = (req.body && typeof req.body === 'object') ? req.body : await readJsonBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: 'body-parse: ' + e.message });
  }

  const { user_id, amount, account_type } = body || {};

  if (!user_id) return sendJson(res, 400, { error: 'Missing user_id' });
  if (!amount || Number(amount) <= 0) return sendJson(res, 400, { error: 'Invalid amount' });

  const numericAmount = Number(amount);

  // Child accounts live in family_members, not wallets — inserting into wallets
  // would violate fk_user since family member IDs aren't in auth.users/profiles.
  if (account_type === 'child') {
    try {
      const members = await fetchSupabaseJson(
        `/rest/v1/family_members?id=eq.${encodeURIComponent(user_id)}&select=id,available_balance&limit=1`
      );
      if (!Array.isArray(members) || members.length === 0) {
        return sendJson(res, 404, { error: 'Child account not found' });
      }
      const member = members[0];
      const newBalance = Number(member.available_balance || 0) + numericAmount;
      await requestSupabaseJson(`/rest/v1/family_members?id=eq.${encodeURIComponent(user_id)}`, {
        method: 'PATCH',
        useServiceRoleAuth: true,
        body: { available_balance: newBalance, updated_at: new Date().toISOString() },
      });
    } catch (e) {
      return sendJson(res, 500, { error: 'child-wallet-upsert: ' + e.message });
    }
    return sendJson(res, 200, { success: true });
  }

  let existing;
  try {
    existing = await fetchSupabaseJson(
      `/rest/v1/wallets?user_id=eq.${encodeURIComponent(user_id)}&limit=1`
    );
  } catch (e) {
    return sendJson(res, 500, { error: 'wallet-fetch: ' + e.message });
  }

  let walletId;
  try {
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
      if (Array.isArray(created) && created[0]) {
        walletId = created[0].id;
      } else if (created) {
        walletId = created.id;
      }
    }
  } catch (e) {
    return sendJson(res, 500, { error: 'wallet-upsert: ' + e.message });
  }


  if (walletId) {
    try {
      await requestSupabaseJson('/rest/v1/wallet_transactions', {
        method: 'POST',
        useServiceRoleAuth: true,
        body: { wallet_id: walletId, user_id, amount: numericAmount, transaction_type: 'manual' },
      });
    } catch (e) {
      console.error('wallet_transactions insert failed:', e.message);
    }
  }

  return sendJson(res, 200, { success: true });
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

    const action = (req.query && req.query.action) || (req.url || '').includes('action=add-wallet') && 'add-wallet';
    if (action === 'add-wallet') {
      return handleAddWallet(req, res, token);
    }

    const body = typeof req.body === 'object' ? req.body : await readJsonBody(req);
    const { to, subject, html, walletId } = body;

    if (!to || !html) {
      return sendJson(res, 400, { error: 'Missing to or html payload' });
    }

    const resendApiKey = process.env.RESEND_API_KEY;
    const orderbookEmailFrom = process.env.ORDERBOOK_EMAIL_FROM;

    if (!resendApiKey || !orderbookEmailFrom) {
      return sendJson(res, 500, { error: 'Email service not configured. Set RESEND_API_KEY and ORDERBOOK_EMAIL_FROM' });
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: orderbookEmailFrom,
        to: [to],
        subject: subject || 'Funds Allocated - Mint',
        html: html
      })
    });

    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }

    if (!response.ok) {
      const message = payload?.message || payload?.error || `Resend request failed with ${response.status}`;
      throw new Error(message);
    }

    if (walletId) {
      await requestSupabaseJson(`/rest/v1/wallets?id=eq.${encodeURIComponent(walletId)}`, {
        method: 'PATCH',
        useServiceRoleAuth: true,
        body: { mailer: 'sent' }
      });
    }

    sendJson(res, 200, { ok: true, message: 'Email sent successfully' });
  } catch (error) {
    sendJson(res, 500, {
      error: 'Could not send EFT email',
      details: error?.message || 'Unknown error'
    });
  }
};
