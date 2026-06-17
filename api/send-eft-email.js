const fs = require('fs');
const path = require('path');
const { sendJson, fetchSupabaseJson, requestSupabaseJson, buildInFilter } = require('./_orderbook');
const { logEmail } = require('./_email-logger');

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

  const { user_id, amount, account_type, wallet_status = 'active' } = body || {};

  if (!user_id) return sendJson(res, 400, { error: 'Missing user_id' });
  if (!amount || Number(amount) <= 0) return sendJson(res, 400, { error: 'Invalid amount' });

  const numericAmount = Number(amount);

  // Child accounts live in family_members, not wallets — inserting into wallets
  // would violate fk_user since family member IDs aren't in auth.users/profiles.
  if (account_type === 'child') {
    try {
      const members = await fetchSupabaseJson(
        `/rest/v1/family_members?id=eq.${encodeURIComponent(user_id)}&select=id,available_balance,primary_user_id&limit=1`
      );
      if (!Array.isArray(members) || members.length === 0) {
        return sendJson(res, 404, { error: 'Child account not found' });
      }
      const member = members[0];
      // available_balance is stored in cents — convert the Rand amount before adding.
      const amountCents = Math.round(numericAmount * 100);
      const newBalance = Number(member.available_balance || 0) + amountCents;
      const nowIso = new Date().toISOString();
      await requestSupabaseJson(`/rest/v1/family_members?id=eq.${encodeURIComponent(user_id)}`, {
        method: 'PATCH',
        useServiceRoleAuth: true,
        body: { available_balance: newBalance, updated_at: nowIso },
      });
      // Insert into transactions table (user_id = parent, family_member_id = child).
      const parentUserId = member.primary_user_id;
      if (parentUserId) {
        try {
          await requestSupabaseJson('/rest/v1/transactions', {
            method: 'POST',
            useServiceRoleAuth: true,
            body: {
              user_id: parentUserId,
              family_member_id: user_id,
              amount: amountCents,
              direction: 'credit',
              status: 'posted',
              name: 'Top Up',
              description: 'Wallet top up',
              currency: 'ZAR',
              transaction_date: nowIso,
            },
          });
        } catch (txnErr) {
          console.error('Child transaction insert failed:', txnErr.message);
        }
      }
    } catch (e) {
      return sendJson(res, 500, { error: 'child-wallet-upsert: ' + e.message });
    }
    return sendJson(res, 200, { success: true });
  }

  let existing;
  try {
    existing = await fetchSupabaseJson(
      `/rest/v1/wallets?user_id=eq.${encodeURIComponent(user_id)}&status=eq.${encodeURIComponent(wallet_status)}&limit=1`
    );
  } catch (e) {
    return sendJson(res, 500, { error: 'wallet-fetch: ' + e.message });
  }

  let walletId;
  let newWalletBalance;
  try {
    if (existing && existing.length > 0) {
      const wallet = existing[0];
      walletId = wallet.id;
      if (wallet_status === 'test') {
        newWalletBalance = Number(wallet.balance || 0) + numericAmount;
        await requestSupabaseJson(`/rest/v1/wallets?id=eq.${encodeURIComponent(wallet.id)}`, {
          method: 'PATCH',
          useServiceRoleAuth: true,
          body: { balance: newWalletBalance, updated_at: new Date().toISOString() },
        });
      } else {
        newWalletBalance = Number(wallet.balance || 0); // No immediate update for active wallets
      }
    } else {
      if (wallet_status === 'test') {
        newWalletBalance = numericAmount;
      } else {
        newWalletBalance = 0; // Active wallets start at 0 until approved
      }
      const created = await requestSupabaseJson('/rest/v1/wallets', {
        method: 'POST',
        useServiceRoleAuth: true,
        body: { user_id, balance: newWalletBalance, currency: 'ZAR', status: wallet_status },
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
      const txnStatus = wallet_status === 'test' ? 'approved' : 'pending';
      await requestSupabaseJson('/rest/v1/wallet_transactions', {
        method: 'POST',
        useServiceRoleAuth: true,
        body: { wallet_id: walletId, user_id, amount: numericAmount, transaction_type: 'manual', status: txnStatus },
      });
    } catch (e) {
      console.error('wallet_transactions insert failed:', e.message);
    }
  }

  if (wallet_status === 'active') {
    await sendApprovalNotification(user_id, numericAmount).catch(e => console.error('Notification email error:', e.message));
  }

  return sendJson(res, 200, { success: true, amountAdded: numericAmount, newBalance: newWalletBalance, walletId, pending: wallet_status === 'active' });
};

const APPROVER_EMAILS = ['lonwabo@mymint.co.za', 'mufaro.ncube@mymint.co.za'];

const sendApprovalNotification = async (userId, amount) => {
  const resendApiKey = process.env.RESEND_API_KEY;
  const fromAddress = process.env.ORDERBOOK_EMAIL_FROM;
  if (!resendApiKey || !fromAddress) return;

  let clientName = userId;
  try {
    const profiles = await fetchSupabaseJson(
      `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=first_name,last_name,email&limit=1`
    );
    if (Array.isArray(profiles) && profiles[0]) {
      const p = profiles[0];
      clientName = `${p.first_name || ''} ${p.last_name || ''}`.trim() || p.email || userId;
    }
  } catch (_) {}

  const zarAmount = new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', minimumFractionDigits: 2 }).format(Number(amount));
  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f6fa;margin:0;padding:32px 16px;">
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:520px;margin:0 auto;">
  <tr><td style="background:#fff;border-radius:16px;padding:32px;box-shadow:0 2px 8px rgba(0,0,0,0.07);border:1px solid #ede9fe;">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:24px;">
      <span style="font-size:16px;font-weight:700;color:#0f172a;">Mint Admin</span>
    </div>
    <h2 style="font-size:18px;font-weight:700;color:#1e293b;margin:0 0 8px 0;">Wallet Deposit Request</h2>
    <p style="font-size:14px;color:#64748b;margin:0 0 20px 0;">A wallet top-up requires your approval.</p>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#f8fafc;border-radius:10px;padding:16px;margin-bottom:24px;">
      <tr><td style="padding:6px 0;font-size:13px;color:#94a3b8;width:120px;">Client</td><td style="font-size:13px;font-weight:600;color:#1e293b;">${clientName}</td></tr>
      <tr><td style="padding:6px 0;font-size:13px;color:#94a3b8;">Amount</td><td style="font-size:15px;font-weight:700;color:#f59e0b;">${zarAmount}</td></tr>
      <tr><td style="padding:6px 0;font-size:13px;color:#94a3b8;">Status</td><td style="font-size:13px;font-weight:600;color:#7c3aed;">Pending Approval</td></tr>
    </table>
    <p style="font-size:13px;color:#64748b;margin:0 0 20px 0;">Log in to the Mint Admin Portal and go to <strong>EFT Payments → Pending Approvals</strong> to approve or review this request.</p>
    <a href="https://mint-crm.vercel.app/eft.html" style="display:inline-block;background:#7c3aed;color:#fff;font-size:13px;font-weight:600;padding:12px 24px;border-radius:8px;text-decoration:none;">Review in Admin Portal</a>
    <p style="font-size:11px;color:#94a3b8;margin:24px 0 0 0;">&copy; ${new Date().getFullYear()} MINT (Pty) Ltd. This is an automated notification.</p>
  </td></tr>
</table>
</body></html>`;

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: fromAddress, to: ['lonwabo@mymint.co.za'], subject: `Wallet Request — ${clientName} (${zarAmount})`, html }),
    });
  } catch (e) {
    console.error('Approval notification email failed:', e.message);
  }
};

const handleApproveDeposit = async (req, res, user) => {
  if (!APPROVER_EMAILS.includes((user.email || '').toLowerCase())) {
    return sendJson(res, 403, { error: 'Unauthorized to approve deposits' });
  }

  let body;
  try {
    body = (req.body && typeof req.body === 'object') ? req.body : await readJsonBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: 'body-parse: ' + e.message });
  }

  const { transaction_id } = body;
  if (!transaction_id) return sendJson(res, 400, { error: 'Missing transaction_id' });

  try {
    // Fetch transaction
    const txns = await fetchSupabaseJson(`/rest/v1/wallet_transactions?id=eq.${encodeURIComponent(transaction_id)}&limit=1`);
    if (!txns || txns.length === 0) return sendJson(res, 404, { error: 'Transaction not found' });
    const txn = txns[0];
    if (txn.status !== 'pending') return sendJson(res, 400, { error: 'Transaction is not pending' });

    // Fetch wallet
    const wallets = await fetchSupabaseJson(`/rest/v1/wallets?id=eq.${encodeURIComponent(txn.wallet_id)}&limit=1`);
    if (!wallets || wallets.length === 0) return sendJson(res, 404, { error: 'Wallet not found' });
    const wallet = wallets[0];

    // Update wallet balance
    const newBalance = Number(wallet.balance || 0) + Number(txn.amount);
    await requestSupabaseJson(`/rest/v1/wallets?id=eq.${encodeURIComponent(wallet.id)}`, {
      method: 'PATCH',
      useServiceRoleAuth: true,
      body: { balance: newBalance, updated_at: new Date().toISOString(), mailer: null },
    });

    // Mark transaction as approved
    await requestSupabaseJson(`/rest/v1/wallet_transactions?id=eq.${encodeURIComponent(txn.id)}`, {
      method: 'PATCH',
      useServiceRoleAuth: true,
      body: { status: 'approved' },
    });

    return sendJson(res, 200, { success: true, newBalance });
  } catch (e) {
    return sendJson(res, 500, { error: 'approval-failed: ' + e.message });
  }
};

const handleRejectDeposit = async (req, res, user) => {
  if (!APPROVER_EMAILS.includes((user.email || '').toLowerCase())) {
    return sendJson(res, 403, { error: 'Unauthorized to reject deposits' });
  }

  let body;
  try {
    body = (req.body && typeof req.body === 'object') ? req.body : await readJsonBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: 'body-parse: ' + e.message });
  }

  const { transaction_id, reason } = body;
  if (!transaction_id) return sendJson(res, 400, { error: 'Missing transaction_id' });

  try {
    const txns = await fetchSupabaseJson(`/rest/v1/wallet_transactions?id=eq.${encodeURIComponent(transaction_id)}&limit=1`);
    if (!txns || txns.length === 0) return sendJson(res, 404, { error: 'Transaction not found' });
    const txn = txns[0];
    if (txn.status !== 'pending') return sendJson(res, 400, { error: 'Transaction is not pending' });

    await requestSupabaseJson(`/rest/v1/wallet_transactions?id=eq.${encodeURIComponent(txn.id)}`, {
      method: 'PATCH',
      useServiceRoleAuth: true,
      body: { status: 'rejected', reference: reason || null },
    });

    return sendJson(res, 200, { success: true });
  } catch (e) {
    return sendJson(res, 500, { error: 'rejection-failed: ' + e.message });
  }
};

const handlePendingTransactions = async (req, res) => {
  try {
    const txns = await fetchSupabaseJson(
      '/rest/v1/wallet_transactions?status=eq.pending&order=created_at.desc&select=id,user_id,amount,created_at,status'
    );
    const rows = Array.isArray(txns) ? txns : [];
    const userIds = [...new Set(rows.map(t => t.user_id).filter(Boolean))];
    let profilesMap = {};
    if (userIds.length > 0) {
      const profiles = await fetchSupabaseJson(
        `/rest/v1/profiles?select=id,first_name,last_name,mint_number,email&id=in.(${buildInFilter(userIds)})`
      );
      if (Array.isArray(profiles)) profiles.forEach(p => { profilesMap[p.id] = p; });
    }
    const enriched = rows.map(t => ({ ...t, profile: profilesMap[t.user_id] || null }));
    return sendJson(res, 200, { transactions: enriched });
  } catch (err) {
    return sendJson(res, 500, { error: err.message || 'Failed to fetch pending transactions' });
  }
};

module.exports = async (req, res) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  const token = parseBearerToken(req.headers.authorization);
  if (!token) {
    return sendJson(res, 401, { error: 'Missing Authorization bearer token' });
  }

  try {
    const user = await fetchSupabaseJson('/auth/v1/user', token, false);

    let action = (req.query && req.query.action);
    if (!action && (req.url || '').includes('action=add-wallet')) action = 'add-wallet';
    if (!action && (req.url || '').includes('action=approve-deposit')) action = 'approve-deposit';
    if (!action && (req.url || '').includes('action=reject-deposit')) action = 'reject-deposit';
    if (!action && (req.url || '').includes('action=pending-transactions')) action = 'pending-transactions';

    if (action === 'pending-transactions') {
      return handlePendingTransactions(req, res);
    }
    if (action === 'add-wallet') {
      return handleAddWallet(req, res, token);
    }
    if (action === 'approve-deposit') {
      return handleApproveDeposit(req, res, user);
    }
    if (action === 'reject-deposit') {
      return handleRejectDeposit(req, res, user);
    }

    const body = typeof req.body === 'object' ? req.body : await readJsonBody(req);
    let { to, subject, html, walletId } = body;

    const resendApiKey = process.env.RESEND_API_KEY;
    const orderbookEmailFrom = process.env.ORDERBOOK_EMAIL_FROM;

    if (!resendApiKey || !orderbookEmailFrom) {
      return sendJson(res, 500, { error: 'Email service not configured. Set RESEND_API_KEY and ORDERBOOK_EMAIL_FROM' });
    }

    if (walletId) {
      // Securely fetch wallet, profile, and latest transaction amount
      const wallets = await fetchSupabaseJson(`/rest/v1/wallets?id=eq.${encodeURIComponent(walletId)}&select=balance,currency,user_id&limit=1`);
      if (wallets && wallets[0]) {
        const wallet = wallets[0];
        let amountAdded = null;
        let mintNumber = '—';
        let clientName = '';
        
        const txns = await fetchSupabaseJson(`/rest/v1/wallet_transactions?wallet_id=eq.${encodeURIComponent(walletId)}&transaction_type=eq.manual&order=created_at.desc&limit=1`);
        if (txns && txns[0]) amountAdded = txns[0].amount;

        const profiles = await fetchSupabaseJson(`/rest/v1/profiles?id=eq.${encodeURIComponent(wallet.user_id)}&select=first_name,mint_number&limit=1`);
        if (profiles && profiles[0]) {
          clientName = profiles[0].first_name || '';
          mintNumber = profiles[0].mint_number || '—';
        }

        const currency = wallet.currency || 'ZAR';
        const newBalance = wallet.balance || 0;

        html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>Funds Allocated – MINT</title>
  <style type="text/css">
    body { margin: 0; padding: 0; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif !important; background-color: #f5f5f7; }
    table, td, a { margin: 0; padding: 0; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { border-spacing: 0; border-collapse: collapse; mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { border: 0; outline: none; text-decoration: none; display: block; max-width: 100%; height: auto; }
    body { width: 100% !important; line-height: 1.5; -webkit-font-smoothing: antialiased; text-align: center; }
    @media (prefers-color-scheme: dark) {
      body, .email-wrapper { background-color: #000000 !important; }
      .email-body { background-color: #0d0d12 !important; border-color: #1a1a24 !important; }
      .text-primary { color: #ffffff !important; }
      .text-secondary { color: #8e8eb2 !important; }
      .divider { border-top-color: #1a1a24 !important; }
    }
    @media screen and (max-width: 480px) {
      .email-body { width: 100% !important; border-radius: 0 !important; border: none !important; }
      .padding-mobile { padding: 40px 24px !important; }
      .feature-col-a, .feature-col-b { display: block !important; width: 100% !important; padding: 0 !important; }
      .feature-col-b { margin-top: 40px !important; text-align: center !important; }
      .cta-btn, .cta-btn a { display: block !important; width: 100% !important; }
      .trust-table td { display: block !important; width: 100% !important; border: none !important; padding: 12px 0 !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#f5f5f7;text-align:center;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#f5f5f7;">
    Confirmed: Your funds have been successfully allocated to your MINT wallet.
  </div>
  <table class="email-wrapper" role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:#f5f5f7;text-align:center;">
    <tr>
      <td align="center" style="padding:48px 16px;">
        <div style="max-width:600px;margin:0 auto;">
          <table class="email-body" role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" align="center" style="max-width:600px;background-color:#ffffff;border-radius:24px;border:1px solid #eef0f7;overflow:hidden;box-shadow:0 12px 40px rgba(49,0,94,0.06);text-align:left;margin:0 auto;">
            <tr>
              <td>
                <img src="https://my-mint-admin.vercel.app/images/Mailer%20Funds%20put.avif" width="600" alt="Funds Allocated" style="display:block;width:100%;height:auto;">
              </td>
            </tr>
            <tr>
              <td class="padding-mobile" style="padding:64px 48px 24px 48px;">
                <h1 class="text-primary" style="margin:0 0 16px 0;font-size:32px;font-weight:700;color:#31005e;letter-spacing:-0.8px;line-height:1.1;">
                  Funds Allocated.
                </h1>
                <p class="text-secondary" style="margin:0;font-size:16px;line-height:26px;color:#555c70;font-weight:400;">
                  Hi <span style="font-weight:600;color:#31005e;" class="text-primary">${clientName}</span>, your transfer has been successfully processed. The funds are now active in your MINT Wallet and ready to be deployed.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 48px;">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                  <tr><td class="divider" style="border-top:1px solid #eef0f7;padding-top:40px;"></td></tr>
                </table>
              </td>
            </tr>
            <tr>
              <td class="padding-mobile" style="padding:0 48px 32px 48px;">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                  <tr>
                    <td class="feature-col-a" valign="middle" style="width:55%;padding-right:20px;">
                      <p style="margin:0;font-size:11px;color:#8e8eb2;text-transform:uppercase;letter-spacing:1.5px;font-weight:700;">MINT Number</p>
                      <p class="text-primary" style="margin:6px 0 36px 0;font-size:16px;font-weight:500;color:#31005e;">${mintNumber}</p>
                      ${amountAdded != null ? `
                      <p style="margin:0;font-size:11px;color:#8e8eb2;text-transform:uppercase;letter-spacing:1.5px;font-weight:700;">Amount Added</p>
                      <p style="margin:6px 0 24px 0;font-size:24px;font-weight:700;color:#059669;letter-spacing:-0.5px;">+ ${currency} ${Number(amountAdded).toLocaleString('en-ZA', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</p>
                      ` : ''}
                      <p style="margin:0;font-size:11px;color:#8e8eb2;text-transform:uppercase;letter-spacing:1.5px;font-weight:700;">Total Wallet Balance</p>
                      <p style="margin:6px 0 0 0;font-size:32px;font-weight:700;color:#5c3bcf;letter-spacing:-0.5px;">${currency} ${Number(newBalance).toLocaleString('en-ZA', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</p>
                    </td>
                    <td class="feature-col-b" valign="middle" style="width:45%;text-align:right;">
                      <img src="https://my-mint-admin.vercel.app/images/wallet-illustration.svg" alt="Wallet Illustration" width="180" style="display:inline-block;border-radius:16px;">
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td class="padding-mobile" style="padding:0 48px 64px 48px;text-align:center;">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin:0 auto;">
                  <tr>
                    <td style="border-radius:100px;background-color:#5c3bcf;text-align:center;box-shadow: 0 4px 14px rgba(92,59,207,0.25);">
                      <a href="https://app.mymint.co.za" target="_blank" style="display:inline-block;padding:16px 40px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:100px;letter-spacing:0.5px;">
                        Invest Now
                      </a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
            <tr>
              <td style="padding:48px 24px;text-align:center;">
                <p style="margin:0 0 16px 0;font-size:11px;color:#8e8eb2;line-height:18px;text-align:justify;">
                  MINT (Pty) Ltd is an authorised Financial Services Provider (FSP 55118) regulated by the Financial Sector Conduct Authority and a registered Credit Provider (NCRCP22892) under the National Credit Act. All investment activity carries risk, including the possible loss of capital and liquidity constraints. Any information provided here is educational in nature, does not constitute personalised financial advice, and should not be relied on as a recommendation to buy or sell securities. Please consider whether investing is appropriate for your circumstances and consult an independent adviser where necessary.
                </p>
                <p style="margin:0;font-size:12px;color:#8e8eb2;line-height:22px;">
                  &copy; 2026 MINT. All rights reserved. <br>
                  Date: ${new Date().toLocaleDateString('en-ZA')} <br>
                  <a href="https://www.mymint.co.za" style="color:#8e8eb2;text-decoration:underline;margin-top:8px;display:inline-block;">www.mymint.co.za</a>
                </p>
              </td>
            </tr>
          </table>
        </div>
      </td>
    </tr>
  </table>
</body>
</html>`;
      }
    }

    if (!to || !html) {
      return sendJson(res, 400, { error: 'Missing to or html payload' });
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

    const resendId = payload?.id || null;
    await logEmail({
      emailType: 'eft',
      recipient: to,
      subject: subject || 'Funds Allocated - Mint',
      resendId,
      status: 'sent',
      triggerSource: 'manual',
      metadata: walletId ? { wallet_id: walletId } : null
    });

    if (walletId) {
      await requestSupabaseJson(`/rest/v1/wallets?id=eq.${encodeURIComponent(walletId)}`, {
        method: 'PATCH',
        useServiceRoleAuth: true,
        body: { mailer: 'sent' }
      });
    }

    sendJson(res, 200, { ok: true, message: 'Email sent successfully' });
  } catch (error) {
    await logEmail({
      emailType: 'eft',
      recipient: req?.body?.to || 'unknown',
      status: 'failed',
      triggerSource: 'manual',
      errorMessage: error?.message
    }).catch(() => {});
    sendJson(res, 500, {
      error: 'Could not send EFT email',
      details: error?.message || 'Unknown error'
    });
  }
};
