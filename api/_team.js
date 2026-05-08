const crypto = require('crypto');

const ALLOWED_DOMAIN = '@mymint.co.za';
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const sendJson = (res, statusCode, body) => {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
};

const getSupabaseCreds = () => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) throw new Error('Supabase credentials not configured');
  return { supabaseUrl, serviceRoleKey };
};

const isAllowedDomain = (email) =>
  typeof email === 'string' && email.toLowerCase().endsWith(ALLOWED_DOMAIN);

const verifyToken = async (token) => {
  const { supabaseUrl, serviceRoleKey } = getSupabaseCreds();
  const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      'apikey': serviceRoleKey,
      'Authorization': `Bearer ${token}`
    }
  });
  if (!res.ok) return null;
  return res.json();
};

const getTeamMember = async (email) => {
  const { supabaseUrl, serviceRoleKey } = getSupabaseCreds();
  const res = await fetch(
    `${supabaseUrl}/rest/v1/admin_team?email=eq.${encodeURIComponent(email)}&limit=1`,
    {
      headers: {
        'apikey': serviceRoleKey,
        'Authorization': `Bearer ${serviceRoleKey}`,
        'Accept': 'application/json'
      }
    }
  );
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
};

const requireAuth = async (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) { sendJson(res, 401, { error: 'Missing token' }); return null; }

  const user = await verifyToken(token);
  if (!user) { sendJson(res, 401, { error: 'Invalid token' }); return null; }

  // Check admin_team first
  let member = await getTeamMember(user.email);

  // If not in admin_team, check admin_profiles
  if (!member) {
    try {
      const { supabaseUrl, serviceRoleKey } = getSupabaseCreds();
      const res = await fetch(
        `${supabaseUrl}/rest/v1/admin_profiles?email=eq.${encodeURIComponent(user.email)}&limit=1`,
        {
          headers: {
            'apikey': serviceRoleKey,
            'Authorization': `Bearer ${serviceRoleKey}`,
            'Accept': 'application/json'
          }
        }
      );
      const rows = await res.json();
      member = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    } catch (err) {
      console.warn('[Auth] admin_profiles lookup failed:', err.message);
    }
  }

  if (!member) { sendJson(res, 403, { error: 'Not a team member' }); return null; }

  // Return auth result; callers should check member.status if needed
  return { user, member };
};

const requireAdmin = async (req, res) => {
  const result = await requireAuth(req, res);
  if (!result) return null;
  const role = result.member.role || 'staff';
  if (role !== 'admin') {
    sendJson(res, 403, { error: 'Admin access required' });
    return null;
  }
  return result;
};

const supabaseRequest = async (path, options = {}) => {
  const { supabaseUrl, serviceRoleKey } = getSupabaseCreds();
  const { method = 'GET', body = null, extraHeaders = {} } = options;
  const res = await fetch(`${supabaseUrl}${path}`, {
    method,
    headers: {
      'apikey': serviceRoleKey,
      'Authorization': `Bearer ${serviceRoleKey}`,
      'Accept': 'application/json',
      'Prefer': 'return=representation',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...extraHeaders
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  let payload = null;
  try { payload = await res.json(); } catch { payload = null; }
  if (!res.ok) throw new Error(payload?.message || payload?.error || `Supabase error ${res.status}`);
  return payload;
};

// Create a confirmed Supabase auth user with a chosen password.
const createAuthUser = async (email, password, full_name) => {
  const { supabaseUrl, serviceRoleKey } = getSupabaseCreds();
  const res = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      'apikey': serviceRoleKey,
      'Authorization': `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: full_name ? { full_name } : {}
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.msg || data.message || data.error || `Failed to create user (${res.status})`);
  return data;
};

// List Supabase auth users (paginated). Returns array of { id, email, last_sign_in_at }.
const listAuthUsers = async () => {
  const { supabaseUrl, serviceRoleKey } = getSupabaseCreds();
  const all = [];
  let page = 1;
  const perPage = 200;
  while (true) {
    const res = await fetch(`${supabaseUrl}/auth/v1/admin/users?page=${page}&per_page=${perPage}`, {
      headers: { 'apikey': serviceRoleKey, 'Authorization': `Bearer ${serviceRoleKey}` }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.msg || data.message || `Failed to list users (${res.status})`);
    const users = data.users || [];
    all.push(...users);
    if (users.length < perPage) break;
    page += 1;
    if (page > 25) break;
  }
  return all;
};

// Send an invitation email via Supabase's built-in email service.
// Supabase will create the auth user (if not existing) and email the invite link
// using whatever SMTP/email provider is configured in the Supabase dashboard.
const inviteUserViaSupabase = async (email, redirectTo, full_name) => {
  const { supabaseUrl, serviceRoleKey } = getSupabaseCreds();
  const url = `${supabaseUrl}/auth/v1/invite${redirectTo ? `?redirect_to=${encodeURIComponent(redirectTo)}` : ''}`;
  console.log('[Supabase Invite] Calling:', url.replace(/\?.*/, '?...'));
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': serviceRoleKey,
      'Authorization': `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ email, data: full_name ? { full_name } : {} })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.msg || data.message || data.error_description || data.error || `Supabase invite failed (${res.status})`;
    console.error('[Supabase Invite] Failed:', msg);
    return { ok: false, error: msg, status: res.status };
  }
  console.log('[Supabase Invite] Success for:', email);
  return { ok: true, user: data };
};

// Send a password-reset email via Supabase's built-in email service.
const recoverPasswordViaSupabase = async (email, redirectTo) => {
  const { supabaseUrl, serviceRoleKey } = getSupabaseCreds();
  const url = `${supabaseUrl}/auth/v1/recover${redirectTo ? `?redirect_to=${encodeURIComponent(redirectTo)}` : ''}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': serviceRoleKey,
      'Authorization': `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ email })
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const msg = data.msg || data.message || data.error_description || `Supabase recover failed (${res.status})`;
    return { ok: false, error: msg, status: res.status };
  }
  return { ok: true };
};

// Update a Supabase Auth user's email address without requiring confirmation.
const updateAuthUserEmail = async (userId, newEmail) => {
  const { supabaseUrl, serviceRoleKey } = getSupabaseCreds();
  const res = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
    method: 'PATCH',
    headers: {
      'apikey': serviceRoleKey,
      'Authorization': `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ email: newEmail, email_confirm: true })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.msg || data.message || data.error || `Failed to update auth email (${res.status})`);
  return data;
};

// Generate a recovery / signup link via the admin endpoint (no email sent).
const generateAuthLink = async (type, email, redirectTo) => {
  const { supabaseUrl, serviceRoleKey } = getSupabaseCreds();
  console.log(`[Generate Link] Creating ${type} link for ${email}`);
  const res = await fetch(`${supabaseUrl}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: {
      'apikey': serviceRoleKey,
      'Authorization': `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ type, email, ...(redirectTo ? { redirect_to: redirectTo } : {}) })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data.msg || data.message || data.error || `Failed to generate link (${res.status})`;
    console.error(`[Generate Link] Error for ${email}:`, err);
    throw new Error(err);
  }
  const link = data?.action_link || data?.properties?.action_link || null;
  if (link) {
    console.log(`[Generate Link] Success, link has ${link.includes('#') ? 'hash params' : 'no hash'}`);
  } else {
    console.warn(`[Generate Link] No link returned for ${email}`);
  }
  return link;
};

const newInviteToken = () => crypto.randomBytes(24).toString('base64url');

const baseUrlFromReq = (req) => {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers['host'];
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  if (host) return `${proto}://${host}`;
  if (process.env.REPLIT_DEV_DOMAIN) return `https://${process.env.REPLIT_DEV_DOMAIN}`;
  return 'https://my-mint-admin.vercel.app';
};

const sendResendEmail = async ({ to, subject, html, text }) => {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[Email] RESEND_API_KEY not configured. Add it to .env to enable email sending.');
    console.warn('[Email] Skipping Resend email to', to);
    return { skipped: true, reason: 'RESEND_API_KEY missing' };
  }
  const fromEmail = process.env.ORDERBOOK_EMAIL_FROM || 'admin@mintinvestments.co.za';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: fromEmail, to: [to], subject, text, html })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('[Email] Resend error:', data?.message || data?.error || res.status);
      return { skipped: true, reason: data?.message || `Resend error ${res.status}` };
    }
    console.log('[Email] Sent:', data.id, 'to', to);
    return { skipped: false, id: data.id };
  } catch (err) {
    console.error('[Email] Send failed:', err.message);
    return { skipped: true, reason: err.message };
  }
};

// Shared email shell: gradient header, white card, button, footer.
// Designed to render well in Gmail, Outlook, Apple Mail and on dark mode.
const emailShell = ({ preheader, heading, intro, ctaLabel, ctaUrl, fallbackUrl, body, footer }) => `
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light only">
  <title>${heading}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <span style="display:none!important;visibility:hidden;mso-hide:all;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${preheader || ''}</span>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f4f4f7" style="background:#f4f4f7;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 8px 32px rgba(15,23,42,0.06);">
          <tr>
            <td style="background:linear-gradient(135deg,#5b21b6 0%,#7c3aed 100%);padding:36px 36px 28px 36px;text-align:left;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="vertical-align:middle;">
                    <div style="display:inline-block;width:36px;height:36px;background:#ffffff;border-radius:10px;text-align:center;line-height:36px;font-weight:700;color:#7c3aed;font-size:18px;letter-spacing:-0.5px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">M</div>
                  </td>
                  <td style="vertical-align:middle;padding-left:12px;">
                    <div style="color:#ffffff;font-weight:600;font-size:15px;letter-spacing:-0.2px;">Mint CRM</div>
                    <div style="color:rgba(255,255,255,0.75);font-size:12px;font-weight:500;">Admin Portal</div>
                  </td>
                </tr>
              </table>
              <h1 style="margin:24px 0 0 0;color:#ffffff;font-size:24px;line-height:1.25;font-weight:700;letter-spacing:-0.4px;">${heading}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 36px 24px 36px;color:#1c1c1e;font-size:15px;line-height:1.6;">
              ${intro ? `<p style="margin:0 0 20px 0;color:#3c3c43;">${intro}</p>` : ''}
              ${body || ''}
              ${ctaUrl ? `
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:28px 0 8px 0;">
                  <tr>
                    <td align="center" bgcolor="#0f172a" style="border-radius:12px;">
                      <a href="${ctaUrl}" target="_blank" style="display:inline-block;padding:14px 28px;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;letter-spacing:-0.2px;border-radius:12px;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${ctaLabel || 'Open Mint'}</a>
                    </td>
                  </tr>
                </table>
              ` : ''}
              ${fallbackUrl ? `
                <p style="margin:18px 0 0 0;font-size:12px;color:#8e8e93;line-height:1.55;">If the button doesn't work, copy and paste this link into your browser:<br>
                  <a href="${fallbackUrl}" target="_blank" style="color:#5b21b6;word-break:break-all;text-decoration:underline;">${fallbackUrl}</a>
                </p>
              ` : ''}
              ${footer ? `<p style="margin:24px 0 0 0;font-size:12px;color:#8e8e93;line-height:1.55;">${footer}</p>` : ''}
            </td>
          </tr>
          <tr>
            <td style="padding:18px 36px 28px 36px;border-top:1px solid #f0f0f3;color:#8e8e93;font-size:11px;line-height:1.55;">
              You're receiving this because someone with admin access at Mint added your email to the team.
              <br>If this wasn't expected, you can safely ignore this email.
            </td>
          </tr>
        </table>
        <div style="max-width:600px;margin:14px auto 0;color:#a1a1aa;font-size:11px;text-align:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
          © ${new Date().getFullYear()} Mint Investments &middot; Admin Portal
        </div>
      </td>
    </tr>
  </table>
</body>
</html>
`;

const sendInviteEmail = async ({ toEmail, toName, inviterEmail, signupLink }) => {
  const greet = toName ? `Hi ${toName},` : 'Hi there,';
  return sendResendEmail({
    to: toEmail,
    subject: 'You have been invited to Mint Admin',
    text:
      `${greet}

${inviterEmail} has invited you to join the Mint Admin Portal.

Click the link below to set your password and finish creating your account:
${signupLink}

This link is valid for 7 days. Be sure to use the email address this message was sent to.

— The Mint team`,
    html: emailShell({
      preheader: `${inviterEmail} invited you to the Mint Admin Portal — set your password to get started.`,
      heading: 'You\'re invited to Mint Admin',
      intro: `${greet} <strong>${inviterEmail}</strong> has invited you to join the Mint Admin Portal.`,
      body: `
        <p style="margin:0 0 20px 0;color:#3c3c43;">Click the button below to <strong>create your password</strong> and finish setting up your account. It only takes a moment.</p>
        <div style="background:#faf7ff;border:1px solid #ede5ff;border-radius:12px;padding:16px 18px;margin:8px 0 4px 0;">
          <div style="font-size:12px;font-weight:600;color:#5b21b6;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:6px;">What happens next</div>
          <ol style="margin:0;padding-left:20px;color:#3c3c43;font-size:14px;line-height:1.7;">
            <li>Open the secure signup page</li>
            <li>Choose a password (at least 8 characters)</li>
            <li>Sign in and start using the portal</li>
          </ol>
        </div>
      `,
      ctaLabel: 'Create your password',
      ctaUrl: signupLink,
      fallbackUrl: signupLink,
      footer: 'This invitation expires in 7 days. For your security, only the email address it was sent to can complete signup.'
    })
  });
};

const sendWelcomeEmail = async ({ toEmail, toName, dashboardLink }) => {
  const greet = toName ? `Hi ${toName},` : 'Welcome,';
  return sendResendEmail({
    to: toEmail,
    subject: 'Welcome to Mint Admin',
    text: `${greet}\n\nYour Mint Admin account is ready. Sign in here: ${dashboardLink}\n\n— The Mint team`,
    html: emailShell({
      preheader: 'Your Mint Admin account is ready — sign in to get started.',
      heading: 'Welcome to Mint Admin',
      intro: `${greet} your account is ready and you can sign in any time.`,
      body: `<p style="margin:0;color:#3c3c43;">Bookmark the sign-in page so you can get back to the portal quickly.</p>`,
      ctaLabel: 'Open Mint Admin',
      ctaUrl: dashboardLink,
      fallbackUrl: dashboardLink,
      footer: 'If you didn\'t expect this email, please let your administrator know.'
    })
  });
};

const sendResetEmail = async ({ toEmail, resetLink }) => {
  return sendResendEmail({
    to: toEmail,
    subject: 'Reset your Mint Admin password',
    text: `Reset your Mint Admin password using this link (valid for 1 hour): ${resetLink}\n\nIf you didn't request this, you can ignore this email.`,
    html: emailShell({
      preheader: 'Use this link to choose a new password for your Mint Admin account.',
      heading: 'Reset your password',
      intro: 'Click the button below to choose a new password for your Mint Admin account.',
      body: `<p style="margin:0;color:#3c3c43;">For your security, this link is valid for <strong>1 hour</strong>. If it expires, you can request a new one from the sign-in page.</p>`,
      ctaLabel: 'Reset password',
      ctaUrl: resetLink,
      fallbackUrl: resetLink,
      footer: 'If you didn\'t ask to reset your password, you can safely ignore this email — your current password will keep working.'
    })
  });
};

module.exports = {
  ALLOWED_DOMAIN,
  INVITE_TTL_MS,
  sendJson,
  isAllowedDomain,
  requireAuth,
  requireAdmin,
  supabaseRequest,
  createAuthUser,
  listAuthUsers,
  generateAuthLink,
  newInviteToken,
  baseUrlFromReq,
  inviteUserViaSupabase,
  recoverPasswordViaSupabase,
  updateAuthUserEmail,
  sendInviteEmail,
  sendWelcomeEmail,
  sendResetEmail
};
