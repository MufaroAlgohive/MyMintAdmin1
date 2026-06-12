const {
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
  sendInviteEmail
} = require('./_team');

const normEmail = (e) => String(e || '').trim().toLowerCase();

// Best-effort audit log writer. Failures must NOT break the underlying action.
const writeAudit = async (entry) => {
  try {
    await supabaseRequest('/rest/v1/admin_team_audit', {
      method: 'POST',
      extraHeaders: { 'Prefer': 'return=minimal' },
      body: entry
    });
  } catch (err) {
    console.error('[Audit] insert failed:', err.message);
  }
};

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const action = url.searchParams.get('action') || req.body?.action;

    // ME — current user's role + page access
    if (action === 'me') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      const result = await requireAuth(req, res);
      if (!result) return;
      const { user, member } = result;
      // Only allow active members to access the app (pending users must complete signup first)
      if (member.status === 'pending') {
        return sendJson(res, 403, { error: 'Your invite has not been accepted yet' });
      }
      return sendJson(res, 200, {
        ok: true,
        email: user.email,
        full_name: member.full_name || null,
        role: member.role || 'staff',
        page_access: member.page_access || [],
        id: member.id
      });
    }

    // LIST — admin only
    if (action === 'list') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      const result = await requireAdmin(req, res);
      if (!result) return;
      const data = await supabaseRequest(
        '/rest/v1/admin_team?select=id,user_id,email,full_name,role,page_access,status,invited_by,created_at,updated_at&order=created_at.asc'
      );
      // Enrich with last_sign_in_at from Supabase Auth (best-effort).
      let signInByEmail = {};
      let signInByUserId = {};
      try {
        const users = await listAuthUsers();
        users.forEach(u => {
          if (u.email) signInByEmail[String(u.email).toLowerCase()] = u.last_sign_in_at || null;
          if (u.id) signInByUserId[u.id] = u.last_sign_in_at || null;
        });
      } catch (err) {
        console.warn('[team] listAuthUsers failed:', err.message);
      }
      const enriched = (data || []).map(m => ({
        ...m,
        last_sign_in_at: (m.user_id && signInByUserId[m.user_id]) || signInByEmail[String(m.email || '').toLowerCase()] || null
      }));
      return sendJson(res, 200, { ok: true, members: enriched });
    }

    // INVITE — admin only. Stores token, returns signup link, tries to email it.
    if (action === 'invite') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
      const result = await requireAdmin(req, res);
      if (!result) return;
      const email = normEmail(req.body?.email);
      const full_name = (req.body?.full_name || '').trim() || null;
      const role = req.body?.role === 'admin' ? 'admin' : 'staff';
      const page_access = role === 'admin' ? [] : (Array.isArray(req.body?.page_access) ? req.body.page_access : []);

      if (!email) return sendJson(res, 400, { error: 'Email is required' });
      if (!isAllowedDomain(email)) {
        return sendJson(res, 400, { error: `Only ${ALLOWED_DOMAIN} email addresses can be invited` });
      }

      const existing = await supabaseRequest(`/rest/v1/admin_team?email=eq.${encodeURIComponent(email)}`);
      const baseUrl = baseUrlFromReq(req);
      const redirectTo = `${baseUrl}/signup.html`;

      let member;
      if (existing && existing.length > 0) {
        const current = existing[0];
        if (current.status === 'active') {
          return sendJson(res, 400, { error: 'User is already an active team member' });
        }
        // Re-issue the invite for a pending row
        const [updated] = await supabaseRequest(`/rest/v1/admin_team?id=eq.${current.id}`, {
          method: 'PATCH',
          extraHeaders: { 'Prefer': 'return=representation' },
          body: { full_name, role, page_access, invited_by: result.user.id, updated_at: new Date().toISOString() }
        });
        member = updated;
      } else {
        const [created] = await supabaseRequest('/rest/v1/admin_team', {
          method: 'POST',
          body: {
            email,
            full_name,
            role,
            page_access,
            status: 'pending',
            invited_by: result.user.id
          }
        });
        member = created;
      }

      // Generate a proper signup link with access_token (works with both Resend and as fallback).
      let emailSent = false;
      let emailReason = null;
      let signupLink = null;
      let via = 'supabase';

      try {
        signupLink = await generateAuthLink('invite', email, redirectTo);
      } catch (err) {
        console.error('[Invite] generateAuthLink failed:', err.message);
      }

      // Try to send via Resend if configured and link was generated
      if (process.env.RESEND_API_KEY && signupLink) {
        try {
          const sendRes = await sendInviteEmail({
            toEmail: email,
            toName: full_name,
            inviterEmail: result.user.email,
            signupLink
          });
          emailSent = !sendRes.skipped;
          emailReason = sendRes.skipped ? sendRes.reason : null;
          if (emailSent) via = 'resend';
        } catch (err) {
          emailReason = err.message;
        }
      }

      // Fall back to Supabase invite email if Resend didn't send or API key not configured
      if (!emailSent) {
        const supabaseRes = await inviteUserViaSupabase(email, redirectTo, full_name);
        emailSent = supabaseRes.ok;
        emailReason = emailSent ? null : supabaseRes.error;
        via = 'supabase';
      }

      await writeAudit({
        action: 'invite',
        target_email: email,
        target_member_id: member?.id || null,
        actor_email: result.user.email,
        actor_user_id: result.user.id,
        details: {
          role,
          page_access,
          full_name,
          reissue: existing && existing.length > 0,
          email_sent: emailSent,
          email_reason: emailReason || null,
          via,
          signup_link_generated: !!signupLink
        }
      });

      if (!emailSent) {
        const warning = emailReason
          ? `Member added but email could not be sent: ${emailReason}.`
          : 'Member added but email could not be sent.';
        return sendJson(res, 200, {
          ok: true,
          member,
          emailSent: false,
          emailReason,
          signupLink: signupLink || null,
          warning: signupLink
            ? `${warning} Share this link manually: ${signupLink}`
            : warning
        });
      }

      return sendJson(res, 200, { ok: true, member, emailSent: true });
    }

    // RESEND — admin only. Re-issues a fresh invite token for a pending member
    // and re-sends the invitation email (or returns the new link).
    if (action === 'resend') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
      const result = await requireAdmin(req, res);
      if (!result) return;
      const id = req.body?.id;
      if (!id) return sendJson(res, 400, { error: 'id is required' });

      const rows = await supabaseRequest(`/rest/v1/admin_team?id=eq.${id}&limit=1`);
      const member = rows && rows[0];
      if (!member) return sendJson(res, 404, { error: 'Member not found' });
      if (member.status === 'active') return sendJson(res, 400, { error: 'User is already active — no invite to resend' });

      const baseUrl = baseUrlFromReq(req);
      const redirectTo = `${baseUrl}/signup.html`;

      const [updated] = await supabaseRequest(`/rest/v1/admin_team?id=eq.${id}`, {
        method: 'PATCH',
        extraHeaders: { 'Prefer': 'return=representation' },
        body: {
          invited_by: result.user.id,
          updated_at: new Date().toISOString(),
          invite_token: null,
          invite_token_expires_at: null
        }
      });

      // Try Supabase invite first; if user already exists fall back to a magic link via Resend.
      let emailRes = await inviteUserViaSupabase(member.email, redirectTo, member.full_name);
      let via = 'supabase';
      let fallbackLink = null;

      if (!emailRes.ok && emailRes.error && emailRes.error.toLowerCase().includes('already been registered')) {
        // User exists in Supabase Auth — generate a magic link and email it ourselves.
        try {
          fallbackLink = await generateAuthLink('magiclink', member.email, redirectTo);
          if (fallbackLink) {
            const sendRes = await sendInviteEmail({
              toEmail: member.email,
              toName: member.full_name,
              inviterEmail: result.user.email,
              signupLink: fallbackLink
            });
            emailRes = sendRes.skipped
              ? { ok: false, error: sendRes.reason }
              : { ok: true };
            via = 'resend-magic-link';
          }
        } catch (err) {
          emailRes = { ok: false, error: err.message };
        }
      }

      await writeAudit({
        action: 'invite',
        target_email: member.email,
        target_member_id: id,
        actor_email: result.user.email,
        actor_user_id: result.user.id,
        details: {
          role: member.role,
          page_access: member.page_access || [],
          full_name: member.full_name,
          reissue: true,
          email_sent: emailRes.ok,
          email_reason: emailRes.error || null,
          via
        }
      });

      if (!emailRes.ok) {
        return sendJson(res, 200, {
          ok: true,
          member: updated,
          emailSent: false,
          emailReason: emailRes.error,
          signupLink: fallbackLink || null,
          warning: `Could not resend: ${emailRes.error}`
        });
      }

      return sendJson(res, 200, { ok: true, member: updated, emailSent: true });
    }

    // COMPLETE-SIGNUP — called by /signup.html after the invitee has set their password
    // via Supabase. We just mark the admin_team row active and bind their user_id.
    // The user MUST be authenticated (Supabase magic-link session in the Authorization header).
    if (action === 'complete-signup') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
      const auth = await requireAuth(req, res);
      if (!auth) return;
      const email = normEmail(auth.user.email);
      const full_name = (req.body?.full_name || '').trim() || null;

      const rows = await supabaseRequest(`/rest/v1/admin_team?email=eq.${encodeURIComponent(email)}&limit=1`);
      const member = rows && rows[0];
      if (!member) return sendJson(res, 404, { error: 'No team membership found for this email. Ask an admin to invite you.' });

      const [updated] = await supabaseRequest(`/rest/v1/admin_team?id=eq.${member.id}`, {
        method: 'PATCH',
        extraHeaders: { 'Prefer': 'return=representation' },
        body: {
          status: 'active',
          user_id: auth.user.id,
          full_name: full_name || member.full_name,
          invite_token: null,
          invite_token_expires_at: null,
          updated_at: new Date().toISOString()
        }
      });

      await writeAudit({
        action: 'signup',
        target_email: email,
        target_member_id: updated?.id || member.id,
        actor_email: email,
        actor_user_id: auth.user.id,
        details: { full_name: full_name || member.full_name, via: 'supabase' }
      });

      return sendJson(res, 200, { ok: true, member: updated });
    }

    // FORGOT-PASSWORD — public. Asks Supabase to email a reset link.
    if (action === 'forgot-password') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
      const email = normEmail(req.body?.email);
      if (!email) return sendJson(res, 400, { error: 'Email is required' });

      // Silently ignore non-@mymint addresses to prevent email enumeration.
      if (!isAllowedDomain(email)) return sendJson(res, 200, { ok: true });

      // Always respond OK to prevent email enumeration, but only email known team members.
      const rows = await supabaseRequest(`/rest/v1/admin_team?email=eq.${encodeURIComponent(email)}&limit=1`);
      const member = rows && rows[0];
      if (member && member.status === 'active') {
        try {
          const baseUrl = baseUrlFromReq(req);
          const r = await recoverPasswordViaSupabase(email, `${baseUrl}/reset-password.html`);
          if (!r.ok) console.error('[Forgot] Supabase recover failed:', r.error);
        } catch (err) {
          console.error('[Forgot] Failed:', err.message);
        }
      }
      return sendJson(res, 200, { ok: true });
    }

    // UPDATE-EMAIL — admin only. Migrates a team member to a @mymint email address.
    // Updates both the admin_team row and the Supabase Auth user record.
    if (action === 'update-email') {
      if (req.method !== 'POST' && req.method !== 'PATCH') return sendJson(res, 405, { error: 'Method not allowed' });
      const result = await requireAdmin(req, res);
      if (!result) return;
      const { id, new_email } = req.body || {};
      if (!id || !new_email) return sendJson(res, 400, { error: 'id and new_email are required' });

      const normNew = normEmail(new_email);
      if (!isAllowedDomain(normNew)) {
        return sendJson(res, 400, { error: `Only ${ALLOWED_DOMAIN} email addresses are allowed` });
      }

      // Conflict check — another member already has this email
      const conflicts = await supabaseRequest(
        `/rest/v1/admin_team?email=eq.${encodeURIComponent(normNew)}&id=neq.${id}&limit=1`
      );
      if (conflicts && conflicts.length > 0) {
        return sendJson(res, 400, { error: 'That email is already used by another team member' });
      }

      const rows = await supabaseRequest(`/rest/v1/admin_team?id=eq.${id}&limit=1`);
      const member = rows && rows[0];
      if (!member) return sendJson(res, 404, { error: 'Member not found' });
      const oldEmail = member.email;

      // Update Supabase Auth email if the auth user is known
      let authUpdated = false;
      if (member.user_id) {
        try {
          await updateAuthUserEmail(member.user_id, normNew);
          authUpdated = true;
        } catch (err) {
          return sendJson(res, 500, { error: `Could not update auth email: ${err.message}` });
        }
      }

      const [updated] = await supabaseRequest(`/rest/v1/admin_team?id=eq.${id}`, {
        method: 'PATCH',
        extraHeaders: { 'Prefer': 'return=representation' },
        body: { email: normNew, updated_at: new Date().toISOString() }
      });

      await writeAudit({
        action: 'update',
        target_email: normNew,
        target_member_id: id,
        actor_email: result.user.email,
        actor_user_id: result.user.id,
        details: { before: { email: oldEmail }, after: { email: normNew }, auth_updated: authUpdated }
      });

      return sendJson(res, 200, { ok: true, member: updated, authUpdated });
    }

    // UPDATE — admin only
    if (action === 'update') {
      if (req.method !== 'PUT' && req.method !== 'POST' && req.method !== 'PATCH') {
        return sendJson(res, 405, { error: 'Method not allowed' });
      }
      const result = await requireAdmin(req, res);
      if (!result) return;
      const { id, role, page_access } = req.body || {};
      if (!id) return sendJson(res, 400, { error: 'id is required' });

      const beforeRows = await supabaseRequest(`/rest/v1/admin_team?id=eq.${id}&limit=1`);
      const before = beforeRows && beforeRows[0];

      const safeRole = role === 'admin' ? 'admin' : 'staff';
      const safePages = safeRole === 'admin' ? [] : (Array.isArray(page_access) ? page_access : []);
      const [updated] = await supabaseRequest(`/rest/v1/admin_team?id=eq.${id}`, {
        method: 'PATCH',
        extraHeaders: { 'Prefer': 'return=representation' },
        body: {
          role: safeRole,
          page_access: safePages,
          updated_at: new Date().toISOString()
        }
      });

      await writeAudit({
        action: 'update',
        target_email: updated?.email || before?.email || '',
        target_member_id: id,
        actor_email: result.user.email,
        actor_user_id: result.user.id,
        details: {
          before: before ? { role: before.role, page_access: before.page_access || [] } : null,
          after:  { role: safeRole, page_access: safePages }
        }
      });

      return sendJson(res, 200, { ok: true, member: updated });
    }

    // REMOVE — admin only
    if (action === 'remove') {
      if (req.method !== 'DELETE') return sendJson(res, 405, { error: 'Method not allowed' });
      const result = await requireAdmin(req, res);
      if (!result) return;
      const id = req.body?.id || url.searchParams.get('id');
      if (!id) return sendJson(res, 400, { error: 'id is required' });
      if (String(id) === String(result.member.id)) return sendJson(res, 400, { error: 'Cannot remove yourself' });

      const beforeRows = await supabaseRequest(`/rest/v1/admin_team?id=eq.${id}&limit=1`);
      const before = beforeRows && beforeRows[0];

      await supabaseRequest(`/rest/v1/admin_team?id=eq.${id}`, { method: 'DELETE' });

      await writeAudit({
        action: 'remove',
        target_email: before?.email || '',
        target_member_id: id,
        actor_email: result.user.email,
        actor_user_id: result.user.id,
        details: before ? { role: before.role, page_access: before.page_access || [], full_name: before.full_name } : {}
      });

      return sendJson(res, 200, { ok: true });
    }

    // IMPERSONATE — admin only. Generates a magic link for the target client user
    // so the admin can preview the live Mint client app signed in as them.
    if (action === 'impersonate') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
      const result = await requireAdmin(req, res);
      if (!result) return;
      const userId = (req.body?.user_id || '').trim();
      const target = (req.body?.target || 'dev').toLowerCase() === 'live' ? 'live' : 'dev';
      if (!userId) return sendJson(res, 400, { error: 'user_id is required' });

      const mintBase = target === 'live'
        ? (process.env.MINT_APP_URL_LIVE || '').trim().replace(/\/+$/, '')
        : (process.env.MINT_APP_URL_DEV  || '').trim().replace(/\/+$/, '');
      if (!mintBase) {
        return sendJson(res, 500, { error: `Mint app URL not configured (${target === 'live' ? 'MINT_APP_URL_LIVE' : 'MINT_APP_URL_DEV'} env var is missing)` });
      }

      const profileRows = await supabaseRequest(
        `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=id,email,first_name,last_name&limit=1`
      );
      const profile = profileRows && profileRows[0];
      if (!profile || !profile.email) {
        return sendJson(res, 404, { error: 'Client profile not found or has no email' });
      }

      const redirectTo = `${mintBase}/`;
      let actionLink = null;
      try {
        actionLink = await generateAuthLink('magiclink', profile.email, redirectTo);
      } catch (err) {
        return sendJson(res, 500, { error: `Could not generate sign-in link: ${err.message}` });
      }
      if (!actionLink) {
        return sendJson(res, 500, { error: 'Supabase did not return an action link' });
      }

      // Resolve the Supabase verify hop server-side.
      // Supabase's verify endpoint (action_link) 302-redirects to
      //   <mintBase>/?admin_view=1#access_token=...&refresh_token=...
      // If we let the iframe follow this redirect itself, Next.js SSR runs
      // before the browser processes the hash, shows the login screen, and
      // the user appears to be signed out.
      // By following the redirect here (redirect:'manual') we extract the
      // final Location URL — which already contains the tokens in the hash —
      // and hand it directly to the iframe, bypassing the SSR issue entirely.
      try {
        const verifyRes = await fetch(actionLink, { redirect: 'manual' });
        const location = verifyRes.headers.get('location');
        if (location && location.includes('access_token')) {
          console.log('[Impersonate] Resolved verify redirect to final Mint URL');
          actionLink = location;
        } else {
          console.warn('[Impersonate] Verify redirect did not contain tokens; falling back to action_link. Status:', verifyRes.status, 'Location:', location);
        }
      } catch (err) {
        // Non-fatal: fall back to the original action_link
        console.warn('[Impersonate] Could not follow action_link server-side:', err.message);
      }

      await writeAudit({
        action: 'impersonate',
        target_email: profile.email,
        target_member_id: null,
        actor_email: result.user.email,
        actor_user_id: result.user.id,
        details: {
          target_user_id: profile.id,
          target_name: [profile.first_name, profile.last_name].filter(Boolean).join(' ') || null,
          mint_environment: target,
          mint_base: mintBase
        }
      });

      return sendJson(res, 200, {
        ok: true,
        actionLink,
        mintBase,
        target,
        targetEmail: profile.email
      });
    }

    // AUDIT-LIST — admin only
    if (action === 'audit-list') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      const result = await requireAdmin(req, res);
      if (!result) return;
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 500);

      const filters = [];
      const auditAction = (url.searchParams.get('audit_action') || '').trim();
      if (auditAction) filters.push(`action=eq.${encodeURIComponent(auditAction)}`);
      const actorEmail = (url.searchParams.get('actor_email') || '').trim();
      if (actorEmail) filters.push(`actor_email=ilike.${encodeURIComponent('%' + actorEmail + '%')}`);
      const targetEmail = (url.searchParams.get('target_email') || '').trim();
      if (targetEmail) filters.push(`target_email=ilike.${encodeURIComponent('%' + targetEmail + '%')}`);
      const fromDate = (url.searchParams.get('from') || '').trim();
      if (fromDate) filters.push(`created_at=gte.${encodeURIComponent(fromDate)}`);
      const toDate = (url.searchParams.get('to') || '').trim();
      if (toDate) filters.push(`created_at=lte.${encodeURIComponent(toDate)}`);

      const qs = [
        'select=id,action,target_email,target_member_id,actor_email,actor_user_id,details,created_at',
        'order=created_at.desc',
        `limit=${limit}`,
        ...filters
      ].join('&');

      try {
        const rows = await supabaseRequest(`/rest/v1/admin_team_audit?${qs}`);
        return sendJson(res, 200, { ok: true, entries: rows });
      } catch (err) {
        // If the table doesn't exist yet, return an actionable hint
        return sendJson(res, 200, { ok: true, entries: [], notice: 'Audit table not yet created. Run sql/admin_team_audit.sql in your Supabase SQL editor.' });
      }
    }

    // APP-SETTINGS-GET — admin only. Returns a settings JSON blob by key
    // (default 'fees') from the app_settings table.
    if (action === 'app-settings-get') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      const result = await requireAdmin(req, res);
      if (!result) return;
      const key = (url.searchParams.get('key') || 'fees').trim();
      try {
        const rows = await supabaseRequest(
          `/rest/v1/app_settings?key=eq.${encodeURIComponent(key)}&select=value,updated_at,updated_by&limit=1`
        );
        const row = rows && rows[0];
        return sendJson(res, 200, {
          ok: true, key,
          value: row?.value || null,
          updated_at: row?.updated_at || null,
          updated_by: row?.updated_by || null
        });
      } catch (err) {
        return sendJson(res, 200, { ok: true, key, value: null, notice: 'app_settings table not found — run the migration SQL.' });
      }
    }

    // APP-SETTINGS-SAVE — admin only. Upserts a settings JSON blob by key. For
    // 'fees', the payload is whitelisted + coerced to non-negative numbers.
    if (action === 'app-settings-save') {
      if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'PATCH') {
        return sendJson(res, 405, { error: 'Method not allowed' });
      }
      const result = await requireAdmin(req, res);
      if (!result) return;
      const key = (req.body?.key || 'fees').trim();
      const incoming = req.body?.value;
      if (!incoming || typeof incoming !== 'object') return sendJson(res, 400, { error: 'value object is required' });

      let value = incoming;
      if (key === 'fees') {
        const allow = ['isinFeePerAsset', 'brokerFeeRate', 'executionReserveRate', 'transactionFeeRate', 'monthlyStrategyFee', 'rebBrokerageRate', 'rebCustodyFee'];
        value = {};
        for (const k of allow) {
          const n = Number(incoming[k]);
          if (incoming[k] == null || incoming[k] === '' || isNaN(n) || n < 0) {
            return sendJson(res, 400, { error: `Invalid value for ${k}` });
          }
          value[k] = n;
        }
      }

      let before = null;
      try {
        const rows = await supabaseRequest(`/rest/v1/app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`);
        before = (rows && rows[0]?.value) || null;
      } catch { /* table may not exist yet */ }

      let saved;
      try {
        const out = await supabaseRequest(`/rest/v1/app_settings?on_conflict=key`, {
          method: 'POST',
          extraHeaders: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
          body: { key, value, updated_at: new Date().toISOString(), updated_by: result.user.email }
        });
        saved = Array.isArray(out) ? out[0] : out;
      } catch (err) {
        return sendJson(res, 500, { error: `Could not save settings: ${err.message}. Has the app_settings table been created?` });
      }

      await writeAudit({
        action: 'update',
        target_email: result.user.email,
        target_member_id: null,
        actor_email: result.user.email,
        actor_user_id: result.user.id,
        details: { setting: key, before, after: value }
      });

      return sendJson(res, 200, { ok: true, value: saved?.value || value });
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('[Team API]', err);
    sendJson(res, 500, { error: err.message });
  }
};
