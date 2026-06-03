/**
 * api/webhooks.js
 * Handles POST /api/webhooks/supabase — Supabase Database Webhook receiver.
 *
 * Setup in Supabase Dashboard → Database → Webhooks:
 *   URL:    https://<your-domain>/api/webhooks/supabase
 *   Method: POST
 *   Secret: set SUPABASE_WEBHOOK_SECRET env var and add it as the webhook secret
 */

const { logEmail } = require('./_email-logger');

const SB_URL  = () => process.env.SUPABASE_URL;
const SB_KEY  = () => process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND  = () => process.env.RESEND_API_KEY;
const F       = "Inter,Segoe UI,Arial,sans-serif";

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

const sbGet = async (path) => {
  const res = await fetch(`${SB_URL()}${path}`, {
    headers: { 'apikey': SB_KEY(), 'Authorization': `Bearer ${SB_KEY()}`, 'Accept': 'application/json' }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Supabase ${res.status}`);
  return data;
};

const sendEmail = async ({ to, subject, html, emailType, source = 'webhook', metadata = {} }) => {
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.ORDERBOOK_EMAIL_FROM || 'noreply@mymint.co.za', to: [to], subject, html })
  });
  const payload = await resp.json().catch(() => ({}));
  const ok = resp.ok && !payload.error;
  await logEmail({
    emailType, recipient: to, subject,
    resendId: payload.id || null,
    status: ok ? 'sent' : 'failed',
    triggerSource: source,
    metadata,
    errorMessage: ok ? null : (payload.message || payload.error || `HTTP ${resp.status}`)
  });
  if (!ok) throw new Error(payload.message || payload.error || `Resend error ${resp.status}`);
  return payload;
};

// ── Email builders ────────────────────────────────────────────────────────────

const WELCOME_BANNER_URL = 'https://mfxnghmuccevsxwcetej.supabase.co/storage/v1/object/public/Emailer%20Ads/welcome-banner.jpg';
const KYC_URL = 'https://app.mymint.co.za/kyc';

const buildWelcomeHtml = (firstName) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light only">
  <title>Welcome to MINT</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <span style="display:none!important;visibility:hidden;mso-hide:all;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">Welcome to MINT — verify your identity to get started.</span>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f4f4f7" style="background:#f4f4f7;">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:24px;overflow:hidden;box-shadow:0 12px 40px rgba(15,23,42,0.08);">

          <!-- Banner Image -->
          <tr>
            <td style="padding:0;margin:0;line-height:0;">
              <img src="${WELCOME_BANNER_URL}"
                   alt="Welcome to MINT"
                   width="600"
                   height="auto"
                   loading="eager"
                   fetchpriority="high"
                   style="display:block;width:100%;max-width:600px;height:auto;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;" />
            </td>
          </tr>

          <!-- Content Body -->
          <tr>
            <td style="padding:40px 36px;">

              <!-- Greeting -->
              <p style="font-size:18px;color:#0f172a;font-weight:500;margin:0 0 8px 0;letter-spacing:-0.3px;">
                Hi ${firstName || 'there'},
              </p>
              <p style="font-size:15px;color:#475569;line-height:1.6;margin:0 0 32px 0;font-weight:300;">
                Thank you for creating an account with MINT. We build advanced wealth infrastructure to help you seamlessly deploy capital, fund strategies, and track asset performance with institutional-grade clarity.
              </p>

              <!-- KYC Action Card -->
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#ffffff;border:1px solid #ede5ff;border-radius:20px;margin-bottom:40px;box-shadow:0 12px 32px rgba(124,58,237,0.04);overflow:hidden;">
                <!-- Top accent line -->
                <tr>
                  <td style="padding:0;line-height:0;height:4px;background:linear-gradient(90deg,#5b21b6 0%,#7c3aed 100%);font-size:1px;">&nbsp;</td>
                </tr>
                <tr>
                  <td style="padding:28px 24px;">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                      <tr>
                        <!-- Icon badge -->
                        <td width="64" valign="top" style="padding-right:16px;">
                          <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                            <tr>
                              <td style="width:48px;height:48px;background:#faf7ff;border:1px solid #ede5ff;border-radius:14px;text-align:center;vertical-align:middle;padding:0;">
                                <img src="https://img.icons8.com/ios/50/7c3aed/lock-2.png" width="22" height="22" alt="Lock" style="display:inline-block;margin:13px;" />
                              </td>
                            </tr>
                          </table>
                        </td>
                        <!-- Text column -->
                        <td valign="top">
                          <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:#7c3aed;margin-bottom:6px;">Action Required</div>
                          <div style="font-size:18px;font-weight:500;color:#0f172a;margin-bottom:10px;letter-spacing:-0.3px;">Verify your identity</div>
                          <p style="font-size:14px;color:#475569;line-height:1.6;margin:0 0 20px 0;font-weight:300;">
                            To comply with financial regulations and fully secure your investment vault, please complete a swift identity check.
                          </p>
                          <!-- Steps list -->
                          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin-bottom:24px;">
                            <tr>
                              <td width="28" valign="top" style="padding-bottom:12px;">
                                <div style="width:18px;height:18px;background:#f5f3ff;border:1px solid #ede5ff;border-radius:50%;text-align:center;line-height:18px;font-size:10px;color:#7c3aed;font-weight:700;">1</div>
                              </td>
                              <td valign="top" style="font-size:13px;color:#1e293b;font-weight:400;padding-bottom:12px;line-height:1.4;">Have a valid ID or Passport ready</td>
                            </tr>
                            <tr>
                              <td width="28" valign="top">
                                <div style="width:18px;height:18px;background:#f5f3ff;border:1px solid #ede5ff;border-radius:50%;text-align:center;line-height:18px;font-size:10px;color:#7c3aed;font-weight:700;">2</div>
                              </td>
                              <td valign="top" style="font-size:13px;color:#1e293b;font-weight:400;line-height:1.4;">Complete a 5-second facial scan</td>
                            </tr>
                          </table>
                          <!-- CTA Button -->
                          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                            <tr>
                              <td align="center" bgcolor="#5c3bcf" style="border-radius:12px;box-shadow:0 4px 14px rgba(92,59,207,0.25);">
                                <a href="${KYC_URL}" target="_blank" style="display:block;padding:14px 24px;font-size:14px;font-weight:500;color:#ffffff;text-decoration:none;border-radius:12px;text-align:center;">
                                  Complete Verification &rarr;
                                </a>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- Roadmap Section -->
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="border-top:1px solid #f1f5f9;margin-bottom:40px;">
                <tr>
                  <td style="padding-top:40px;">
                    <p style="font-size:18px;font-weight:500;color:#0f172a;text-align:center;margin:0 0 32px 0;letter-spacing:-0.5px;">The MINT Roadmap</p>
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="max-width:320px;width:100%;">

                      <!-- Step 1: Done -->
                      <tr>
                        <td width="24" valign="top" style="padding-top:4px;">
                          <div style="width:8px;height:8px;border-radius:50%;background:#10b981;margin-top:4px;"></div>
                        </td>
                        <td style="padding-bottom:24px;">
                          <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:#10b981;margin-bottom:4px;">Step 1</div>
                          <div style="font-size:14px;font-weight:400;color:#94a3b8;text-decoration:line-through;">Create MINT profile</div>
                        </td>
                      </tr>

                      <!-- Step 2: Current -->
                      <tr>
                        <td width="24" valign="top" style="padding-top:2px;">
                          <div style="width:12px;height:12px;border-radius:50%;background:#7c3aed;border:3px solid #ede5ff;margin-left:-2px;"></div>
                        </td>
                        <td style="padding-bottom:24px;">
                          <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:#7c3aed;margin-bottom:4px;">Step 2</div>
                          <div style="font-size:16px;font-weight:500;color:#0f172a;letter-spacing:-0.3px;">Verify your identity</div>
                        </td>
                      </tr>

                      <!-- Step 3: Upcoming -->
                      <tr>
                        <td width="24" valign="top" style="padding-top:5px;">
                          <div style="width:8px;height:8px;border-radius:50%;border:2px solid #cbd5e1;"></div>
                        </td>
                        <td style="padding-bottom:24px;">
                          <div style="font-size:10px;font-weight:500;text-transform:uppercase;letter-spacing:0.08em;color:#94a3b8;margin-bottom:4px;">Step 3</div>
                          <div style="font-size:14px;font-weight:400;color:#475569;">Deposit into your wallet</div>
                        </td>
                      </tr>

                      <!-- Step 4: Upcoming -->
                      <tr>
                        <td width="24" valign="top" style="padding-top:5px;">
                          <div style="width:8px;height:8px;border-radius:50%;border:2px solid #cbd5e1;"></div>
                        </td>
                        <td>
                          <div style="font-size:10px;font-weight:500;text-transform:uppercase;letter-spacing:0.08em;color:#94a3b8;margin-bottom:4px;">Step 4</div>
                          <div style="font-size:14px;font-weight:400;color:#475569;line-height:1.5;">Deploy assets into managed baskets</div>
                        </td>
                      </tr>

                    </table>
                  </td>
                </tr>
              </table>

              <!-- Support -->
              <p style="font-size:14px;color:#475569;line-height:1.6;margin:0;text-align:center;font-weight:300;">
                Have any questions? Contact <a href="mailto:support@mymint.co.za" style="color:#7c3aed;font-weight:500;text-decoration:none;">support@mymint.co.za</a>
              </p>

              <!-- Footer -->
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="border-top:1px solid #f0f0f3;margin-top:32px;">
                <tr>
                  <td style="padding-top:32px;text-align:center;">
                    <p style="font-size:10px;font-weight:600;letter-spacing:0.15em;color:#0f172a;text-transform:uppercase;margin:0 0 12px 0;">INVEST &bull; BORROW &bull; PROTECT</p>
                    <p style="font-size:10px;color:#94a3b8;line-height:1.6;margin:0;">&copy; ${new Date().getFullYear()} MINT (Pty) Ltd &middot; FSP 55118 &middot; NCRCP22892</p>
                  </td>
                </tr>
              </table>

            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;



const buildWalletFundedHtml = ({ firstName, amount, walletId }) => {
  const fmt = (n) => 'R ' + Number(n).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wallet Funded</title></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:${F};">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f4f4f7;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 8px 32px rgba(15,23,42,.07);">
<tr><td style="background:linear-gradient(135deg,#31005e 0%,#5b21b6 50%,#7c3aed 100%);padding:36px 36px 28px;">
  <div style="display:inline-block;width:36px;height:36px;background:#fff;border-radius:10px;text-align:center;line-height:36px;font-weight:700;color:#7c3aed;font-size:18px;font-family:${F};">M</div>
  <h1 style="margin:20px 0 0;color:#fff;font-size:26px;font-weight:800;letter-spacing:-.5px;">Funds Received</h1>
</td></tr>
<tr><td style="padding:32px 36px 20px;">
  <p style="margin:0 0 8px;font-size:16px;font-weight:600;color:#1e293b;">Hi ${firstName || 'there'},</p>
  <p style="margin:0 0 24px;font-size:14px;color:#475569;line-height:1.6;">Your Mint wallet has been funded. The amount is ready to invest.</p>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#faf7ff;border:1px solid #ede5ff;border-radius:12px;margin-bottom:24px;">
    <tr>
      <td style="padding:20px;text-align:center;">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#7c3aed;margin-bottom:6px;">Amount Added</div>
        <div style="font-size:28px;font-weight:800;color:#0f172a;">${fmt(amount)}</div>
      </td>
    </tr>
  </table>
  <table role="presentation" cellspacing="0" cellpadding="0" border="0">
    <tr><td style="border-radius:999px;background:#5c3bcf;box-shadow:0 4px 14px rgba(92,59,207,.3);">
      <a href="https://app.mymint.co.za" style="display:inline-block;padding:14px 32px;font-size:14px;font-weight:700;color:#fff;text-decoration:none;border-radius:999px;">View Portfolio</a>
    </td></tr>
  </table>
</td></tr>
<tr><td style="padding:16px 36px 28px;border-top:1px solid #f0f0f3;">
  <p style="margin:0;font-size:10px;color:#94a3b8;">MINT (Pty) Ltd · FSP 55118 · <a href="https://www.mymint.co.za" style="color:#94a3b8;">&copy; ${new Date().getFullYear()} MINT</a></p>
</td></tr>
</table></td></tr></table>
</body></html>`;
};

// ── Email action dispatchers ───────────────────────────────────────────────────

async function handleWelcome(record, trigger) {
  const email = record.email;
  const firstName = record.first_name || record.full_name || '';
  if (!email) throw new Error('No email in profiles record');
  await sendEmail({
    to: email,
    subject: 'Welcome to Mint',
    html: buildWelcomeHtml(firstName),
    emailType: 'welcome',
    metadata: { profile_id: record.id }
  });
  console.log(`[Webhook] Welcome email sent to ${email}`);
}

async function handleWalletFunded(record, trigger) {
  const userId = record[trigger.user_id_field || 'user_id'];
  if (!userId) throw new Error('No user_id in wallet_transactions record');

  const profiles = await sbGet(`/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=email,first_name&limit=1`);
  const profile = Array.isArray(profiles) ? profiles[0] : null;
  if (!profile?.email) throw new Error('No profile/email found for user ' + userId);

  const amount = record.amount || 0;
  await sendEmail({
    to: profile.email,
    subject: `Funds received — R ${Number(amount).toLocaleString('en-ZA', { minimumFractionDigits: 2 })}`,
    html: buildWalletFundedHtml({ firstName: profile.first_name, amount, walletId: record.wallet_id }),
    emailType: 'wallet_funded',
    metadata: { wallet_id: record.wallet_id, amount, user_id: userId }
  });
  console.log(`[Webhook] Wallet funded email sent to ${profile.email}`);
}

async function handleTradeConfirmation(record, trigger) {
  // Delegate to the existing orderbook email system
  const { sendTradeConfirmationForHolding } = require('./_orderbook');
  if (typeof sendTradeConfirmationForHolding === 'function') {
    await sendTradeConfirmationForHolding(record.id, 'webhook');
  } else {
    console.warn('[Webhook] sendTradeConfirmationForHolding not exported from _orderbook.js — skipping');
  }
}

const EMAIL_DISPATCHERS = {
  welcome:              handleWelcome,
  wallet_funded:        handleWalletFunded,
  trade_confirmation:   handleTradeConfirmation,
};

// ── Main handler ──────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });

  // Verify webhook secret
  const secret = process.env.SUPABASE_WEBHOOK_SECRET;
  if (secret) {
    const incomingSecret = req.headers['x-webhook-secret'] || req.headers['authorization']?.replace('Bearer ', '');
    if (incomingSecret !== secret) {
      console.warn('[Webhook] Rejected — invalid secret');
      return sendJson(res, 401, { error: 'Unauthorized' });
    }
  }

  // Parse body
  let payload;
  try {
    const raw = await new Promise((resolve, reject) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
    payload = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { error: 'Invalid JSON body' });
  }

  const { type: eventType, table: tableName, record, old_record } = payload;
  if (!eventType || !tableName) return sendJson(res, 400, { error: 'Missing type or table in payload' });

  console.log(`[Webhook] ${eventType} on ${tableName}`);

  // Load matching triggers from DB
  let triggers = [];
  try {
    triggers = await sbGet(
      `/rest/v1/email_webhook_triggers?table_name=eq.${encodeURIComponent(tableName)}&event_type=eq.${encodeURIComponent(eventType)}&enabled=eq.true&select=*`
    );
    if (!Array.isArray(triggers)) triggers = [];
  } catch (err) {
    if (String(err.message).includes('42P01') || String(err.message).includes('does not exist')) {
      console.warn('[Webhook] email_webhook_triggers table not found — run sql/email_webhook_triggers.sql');
      return sendJson(res, 200, { ok: true, message: 'trigger table not configured' });
    }
    console.error('[Webhook] Failed to load triggers:', err.message);
    return sendJson(res, 500, { error: err.message });
  }

  if (triggers.length === 0) {
    return sendJson(res, 200, { ok: true, matched: 0 });
  }

  // Apply each trigger
  const results = [];
  for (const trigger of triggers) {
    try {
      // Check optional condition
      if (trigger.condition_field && trigger.condition_value !== null && trigger.condition_value !== undefined) {
        const actual = String(record?.[trigger.condition_field] ?? '');
        if (actual !== String(trigger.condition_value)) {
          results.push({ trigger: trigger.name, skipped: true, reason: 'condition not met' });
          continue;
        }
      }

      const dispatcher = EMAIL_DISPATCHERS[trigger.email_type];
      if (!dispatcher) {
        results.push({ trigger: trigger.name, error: `Unknown email_type: ${trigger.email_type}` });
        continue;
      }

      await dispatcher(record || old_record || {}, trigger);
      results.push({ trigger: trigger.name, ok: true });
    } catch (err) {
      console.error(`[Webhook] Trigger "${trigger.name}" failed:`, err.message);
      results.push({ trigger: trigger.name, error: err.message });
    }
  }

  return sendJson(res, 200, { ok: true, matched: triggers.length, results });
};
