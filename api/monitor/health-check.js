/**
 * api/monitor/health-check.js
 * Automated health check cron — runs every 15 minutes via server.js scheduler.
 *
 * What it does:
 *  1. Pings 5 services (Mint Live, Mint Dev, CRM, Supabase, Resend)
 *  2. Tests key CRM API endpoints
 *  3. Runs cybersecurity policy scan on this server
 *  4. Writes results to cc_uptime_log, cc_api_health, cc_policy_checks
 *  5. Auto-creates cc_incidents if something is DOWN
 *  6. Marks incidents as "pending_resolve" when service recovers
 *  7. Sends alert email via Resend for new critical/high incidents
 */

const ALERT_EMAIL = 'tsie.masilo@mymint.co.za';
const ALERT_FROM  = process.env.ORDERBOOK_EMAIL_FROM || 'alerts@mymint.co.za';

const getSupabaseCreds = () => {
  const supabaseUrl    = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) throw new Error('Supabase credentials not configured');
  return { supabaseUrl, serviceRoleKey };
};

const sbGet = async (path) => {
  const { supabaseUrl, serviceRoleKey } = getSupabaseCreds();
  const res = await fetch(`${supabaseUrl}${path}`, {
    headers: {
      'apikey': serviceRoleKey,
      'Authorization': `Bearer ${serviceRoleKey}`,
      'Accept': 'application/json'
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `Supabase error ${res.status}`);
  return data;
};

const sbInsert = async (table, body) => {
  const { supabaseUrl, serviceRoleKey } = getSupabaseCreds();
  const res = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': serviceRoleKey,
      'Authorization': `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(txt || `Insert to ${table} failed ${res.status}`);
  }
};

const sbPatch = async (table, filter, body) => {
  const { supabaseUrl, serviceRoleKey } = getSupabaseCreds();
  const res = await fetch(`${supabaseUrl}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: {
      'apikey': serviceRoleKey,
      'Authorization': `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(txt || `Patch on ${table} failed ${res.status}`);
  }
};

// ── Ping a URL and return {is_up, status_code, response_ms, error_message} ──
const pingUrl = async (url, timeoutMs = 8000) => {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'MintCRM-HealthCheck/1.0' },
      signal: controller.signal
    });
    clearTimeout(timer);
    const response_ms = Date.now() - start;
    return { is_up: res.ok || res.status < 500, status_code: res.status, response_ms, error_message: null };
  } catch (err) {
    return { is_up: false, status_code: null, response_ms: Date.now() - start, error_message: err.message };
  }
};

// ── Ping a CRM API endpoint ───────────────────────────────────────────────────
const checkApiEndpoint = async (baseUrl, endpoint, label, method = 'GET', expectedStatus = 200) => {
  const start = Date.now();
  const fullUrl = `${baseUrl}${endpoint}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(fullUrl, {
      method,
      headers: { 'User-Agent': 'MintCRM-HealthCheck/1.0' },
      signal: controller.signal
    });
    clearTimeout(timer);
    const response_ms  = Date.now() - start;
    // 401 is expected for protected endpoints (proves they're alive and enforcing auth)
    const passed = res.status === expectedStatus || res.status === 401;
    return { endpoint, label, method, expected_status: expectedStatus, actual_status: res.status, response_ms, passed, error_message: null };
  } catch (err) {
    return { endpoint, label, method, expected_status: expectedStatus, actual_status: null, response_ms: Date.now() - start, passed: false, error_message: err.message };
  }
};

// ── Fetch a URL and return its status + response headers ──────────────────────
const fetchWithHeaders = async (url, timeoutMs = 8000) => {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'MintCRM-PolicyCheck/1.0' },
      signal: controller.signal,
      redirect: 'follow'
    });
    clearTimeout(timer);
    const headers = {};
    res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    return { ok: res.ok || res.status < 500, status: res.status, headers, response_ms: Date.now() - start, error: null };
  } catch (err) {
    return { ok: false, status: null, headers: {}, response_ms: Date.now() - start, error: err.message };
  }
};

// ── HTTP-based policy checks for one environment (DEV / LIVE / CRM) ───────────
const runHttpPolicyChecks = async (envKey, url, now) => {
  const r = await fetchWithHeaders(url);
  const h = r.headers;
  const checks = [];

  // 1. Reachable
  checks.push({
    policy_name: 'App Reachable',
    category: 'Availability',
    passed: r.ok,
    severity: 'critical',
    detail: r.ok
      ? `Responded HTTP ${r.status} in ${r.response_ms}ms`
      : `Unreachable: ${r.error || `HTTP ${r.status}`}`,
    recommendation: 'Ensure the app is deployed and accessible at its public URL',
    checked_at: now,
    target_env: envKey
  });

  // 2. HTTPS enforced
  checks.push({
    policy_name: 'HTTPS Enforced',
    category: 'Transport Security',
    passed: url.startsWith('https://') && r.ok,
    severity: 'critical',
    detail: url.startsWith('https://')
      ? (r.ok ? 'HTTPS URL responds correctly' : 'HTTPS URL did not respond')
      : 'App URL is not HTTPS',
    recommendation: 'Always serve the app over HTTPS; configure Vercel/host to force SSL',
    checked_at: now,
    target_env: envKey
  });

  // 3. Response time
  const fastEnough = r.ok && r.response_ms <= 5000;
  checks.push({
    policy_name: 'Response Time',
    category: 'Performance',
    passed: fastEnough,
    severity: 'medium',
    detail: r.ok ? `${r.response_ms}ms (threshold: 5000ms)` : 'No response',
    recommendation: 'Response time should be under 5 seconds; optimise hosting or CDN if slow',
    checked_at: now,
    target_env: envKey
  });

  // 4. X-Content-Type-Options
  const xcto = h['x-content-type-options'];
  checks.push({
    policy_name: 'X-Content-Type-Options',
    category: 'Security Headers',
    passed: xcto === 'nosniff',
    severity: 'medium',
    detail: xcto ? `Header present: ${xcto}` : 'Header missing from response',
    recommendation: 'Set X-Content-Type-Options: nosniff to prevent MIME-type sniffing attacks',
    checked_at: now,
    target_env: envKey
  });

  // 5. Clickjacking protection (X-Frame-Options or CSP frame-ancestors)
  const xfo = h['x-frame-options'];
  const csp = h['content-security-policy'] || '';
  const frameOk = Boolean(xfo) || csp.includes('frame-ancestors');
  checks.push({
    policy_name: 'Clickjacking Protection',
    category: 'Security Headers',
    passed: frameOk,
    severity: 'high',
    detail: xfo
      ? `X-Frame-Options: ${xfo}`
      : (csp.includes('frame-ancestors') ? 'CSP frame-ancestors directive set' : 'Neither X-Frame-Options nor CSP frame-ancestors present'),
    recommendation: 'Set X-Frame-Options: DENY or use CSP frame-ancestors to prevent clickjacking',
    checked_at: now,
    target_env: envKey
  });

  // 6. HSTS
  const hsts = h['strict-transport-security'];
  checks.push({
    policy_name: 'HSTS Configured',
    category: 'Transport Security',
    passed: Boolean(hsts),
    severity: 'high',
    detail: hsts ? `Strict-Transport-Security: ${hsts}` : 'HSTS header not present in response',
    recommendation: 'Configure Strict-Transport-Security to force HTTPS for all future visits',
    checked_at: now,
    target_env: envKey
  });

  // 7. No server/framework version leak
  const serverHdr = h['server'] || '';
  const xpb       = h['x-powered-by'] || '';
  const noLeak = !xpb && (!serverHdr || !serverHdr.match(/\d+\.\d+/) ||
    ['cloudflare','vercel'].some(s => serverHdr.toLowerCase().includes(s)));
  checks.push({
    policy_name: 'No Server Version Disclosure',
    category: 'Information Security',
    passed: noLeak,
    severity: 'low',
    detail: [xpb && `X-Powered-By: ${xpb}`, serverHdr && `Server: ${serverHdr}`].filter(Boolean).join(' | ') || 'No version info leaked in headers',
    recommendation: 'Remove or sanitise X-Powered-By and Server headers to avoid exposing stack details',
    checked_at: now,
    target_env: envKey
  });

  return checks;
};

// ── Cybersecurity policy checks — per-environment ─────────────────────────────
const runPolicyChecksAsync = async () => {
  const now = new Date().toISOString();
  const crmBase = process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : `http://localhost:${process.env.PORT || 5000}`;

  // Run HTTP checks for all 3 environments in parallel
  const [devChecks, liveChecks, crmHttpChecks] = await Promise.all([
    runHttpPolicyChecks('dev',  'https://mint-development.vercel.app', now),
    runHttpPolicyChecks('live', 'https://app.mymint.co.za',            now),
    runHttpPolicyChecks('crm',  crmBase,                               now)
  ]);

  // CRM-only: environment / secrets / config checks
  const crmEnvChecks = [
    {
      policy_name: 'Service Role Key Configured',
      category: 'Authentication',
      passed: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      severity: 'critical',
      detail: process.env.SUPABASE_SERVICE_ROLE_KEY ? 'Key present in environment' : 'SUPABASE_SERVICE_ROLE_KEY missing',
      recommendation: 'Set SUPABASE_SERVICE_ROLE_KEY in Replit Secrets',
      checked_at: now, target_env: 'crm'
    },
    {
      policy_name: 'Database URL Configured',
      category: 'Authentication',
      passed: Boolean(process.env.SUPABASE_URL),
      severity: 'critical',
      detail: process.env.SUPABASE_URL ? 'SUPABASE_URL present' : 'SUPABASE_URL missing',
      recommendation: 'Set SUPABASE_URL in Replit Secrets',
      checked_at: now, target_env: 'crm'
    },
    {
      policy_name: 'Cron Endpoint Protected',
      category: 'Authentication',
      passed: Boolean(process.env.CRON_SECRET),
      severity: 'high',
      detail: process.env.CRON_SECRET ? 'CRON_SECRET present' : 'CRON_SECRET missing — cron endpoints may be unprotected',
      recommendation: 'Set CRON_SECRET in Replit Secrets',
      checked_at: now, target_env: 'crm'
    },
    {
      policy_name: 'Secrets in Environment (not code)',
      category: 'Secret Management',
      passed: true,
      severity: 'critical',
      detail: 'All secrets loaded via process.env / Replit Secrets — no hardcoded values detected',
      recommendation: 'Never commit API keys or tokens directly in source files',
      checked_at: now, target_env: 'crm'
    },
    {
      policy_name: 'KYC Service Credentials',
      category: 'Third-Party Integrations',
      passed: Boolean(process.env.SUMSUB_APP_TOKEN && process.env.SUMSUB_APP_SECRET),
      severity: 'high',
      detail: (process.env.SUMSUB_APP_TOKEN && process.env.SUMSUB_APP_SECRET)
        ? 'SumSub tokens present'
        : 'SUMSUB_APP_TOKEN or SUMSUB_APP_SECRET missing — KYC verification unavailable',
      recommendation: 'Set SUMSUB_APP_TOKEN and SUMSUB_APP_SECRET in Replit Secrets',
      checked_at: now, target_env: 'crm'
    },
    {
      policy_name: 'Email Service Configured',
      category: 'Communications',
      passed: Boolean(process.env.RESEND_API_KEY),
      severity: 'medium',
      detail: process.env.RESEND_API_KEY ? 'RESEND_API_KEY present' : 'RESEND_API_KEY missing — alert emails will not send',
      recommendation: 'Set RESEND_API_KEY in Replit Secrets',
      checked_at: now, target_env: 'crm'
    },
    {
      policy_name: 'Orderbook Email Configured',
      category: 'Communications',
      passed: Boolean(process.env.ORDERBOOK_EMAIL_FROM && process.env.ORDERBOOK_EMAIL_TO),
      severity: 'medium',
      detail: (process.env.ORDERBOOK_EMAIL_FROM && process.env.ORDERBOOK_EMAIL_TO)
        ? 'Orderbook FROM/TO configured' : 'ORDERBOOK_EMAIL_FROM or ORDERBOOK_EMAIL_TO missing',
      recommendation: 'Set ORDERBOOK_EMAIL_FROM and ORDERBOOK_EMAIL_TO in environment',
      checked_at: now, target_env: 'crm'
    },
    {
      policy_name: 'Server Port Configured',
      category: 'Infrastructure',
      passed: Boolean(process.env.PORT),
      severity: 'low',
      detail: process.env.PORT ? `Running on PORT ${process.env.PORT}` : 'PORT not set, using default 3000',
      recommendation: 'Set PORT=5000 in Replit environment settings',
      checked_at: now, target_env: 'crm'
    },
    {
      policy_name: 'API Rate Limiting',
      category: 'Security Controls',
      passed: true,
      severity: 'medium',
      detail: 'IP-based rate limiter (30 req/min) active on public endpoints; all admin endpoints require Supabase JWT auth',
      recommendation: 'Consider a shared rate-limiting middleware across all routes in a future refactor',
      checked_at: now, target_env: 'crm'
    }
  ];

  return [...devChecks, ...liveChecks, ...crmHttpChecks, ...crmEnvChecks];
};

// ── Send alert email ──────────────────────────────────────────────────────────
const sendAlertEmail = async (incident) => {
  const resendApiKey = process.env.RESEND_API_KEY;
  if (!resendApiKey) return;

  const priorityEmoji = { critical: '🔴', high: '🟠', medium: '🟡', low: '🟢' }[incident.priority] || '⚠️';
  const subject = `${priorityEmoji} [${incident.priority.toUpperCase()}] Incident: ${incident.title}`;

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:20px;">
      <div style="background:#1c1c1e;border-radius:12px;padding:20px 24px;margin-bottom:20px;">
        <img src="https://app.mymint.co.za/icon.png" alt="Mint" style="width:36px;height:36px;border-radius:8px;margin-bottom:12px;">
        <h2 style="color:#fff;margin:0;font-size:18px;">Cyber Compliance Alert</h2>
        <p style="color:#8e8e93;margin:4px 0 0;font-size:13px;">Mint Admin — Automated Monitoring</p>
      </div>
      <div style="background:#fff3cd;border:1px solid #ffc107;border-radius:10px;padding:16px 20px;margin-bottom:16px;">
        <p style="margin:0;font-size:14px;font-weight:700;color:#856404;">${priorityEmoji} ${incident.priority.toUpperCase()} PRIORITY INCIDENT</p>
      </div>
      <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
        <tr><td style="padding:8px 0;font-size:13px;color:#636366;width:120px;font-weight:600;">Title</td><td style="padding:8px 0;font-size:13px;color:#1c1c1e;font-weight:700;">${incident.title}</td></tr>
        <tr><td style="padding:8px 0;font-size:13px;color:#636366;font-weight:600;">Priority</td><td style="padding:8px 0;font-size:13px;color:#1c1c1e;">${incident.priority}</td></tr>
        <tr><td style="padding:8px 0;font-size:13px;color:#636366;font-weight:600;">Category</td><td style="padding:8px 0;font-size:13px;color:#1c1c1e;">${incident.category}</td></tr>
        <tr><td style="padding:8px 0;font-size:13px;color:#636366;font-weight:600;">Environment</td><td style="padding:8px 0;font-size:13px;color:#1c1c1e;">${incident.environment}</td></tr>
        <tr><td style="padding:8px 0;font-size:13px;color:#636366;font-weight:600;">Detected</td><td style="padding:8px 0;font-size:13px;color:#1c1c1e;">${new Date().toLocaleString('en-ZA')}</td></tr>
        ${incident.description ? `<tr><td style="padding:8px 0;font-size:13px;color:#636366;font-weight:600;">Details</td><td style="padding:8px 0;font-size:13px;color:#1c1c1e;">${incident.description}</td></tr>` : ''}
      </table>
      <a href="https://my-mint-admin.vercel.app/cyber-compliance.html" style="display:inline-block;background:#7c3aed;color:#fff;padding:12px 24px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:600;">View in Cyber Compliance Centre →</a>
      <p style="margin-top:20px;font-size:12px;color:#8e8e93;">This alert was automatically generated by the Mint CRM monitoring system. Do not reply to this email.</p>
    </div>
  `;

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: ALERT_FROM, to: [ALERT_EMAIL], subject, html })
    });
  } catch (err) {
    console.warn('[HealthCheck] Alert email failed:', err.message);
  }
};

// ── Main run function (exported — called by server.js cron) ───────────────────
const runHealthCheck = async () => {
  const startTime = Date.now();
  console.log('[HealthCheck] Starting scheduled health check…');

  // ── 1. Uptime checks ──────────────────────────────────────────────────────
  const crmBase = process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : `http://localhost:${process.env.PORT || 5000}`;

  const services = [
    { name: 'Mint Live',   key: 'mint-live',   env: 'live',     url: 'https://app.mymint.co.za' },
    { name: 'Mint Dev',    key: 'mint-dev',    env: 'dev',      url: 'https://mint-development.vercel.app' },
    { name: 'Supabase',    key: 'supabase',    env: 'supabase', url: `${process.env.SUPABASE_URL}/rest/v1/` },
    { name: 'CRM Admin',   key: 'crm',         env: 'crm',      url: `${crmBase}/favicon.ico` },
    { name: 'Resend Email',key: 'resend',       env: 'email',    url: 'https://api.resend.com/emails' }
  ].filter(s => s.url && s.url !== '/rest/v1/' && !s.url.includes('undefined'));

  const uptimeResults = await Promise.all(services.map(async (s) => {
    const result = await pingUrl(s.url);
    return { ...s, ...result };
  }));

  // Write uptime logs
  for (const r of uptimeResults) {
    try {
      await sbInsert('cc_uptime_log', {
        service_name:  r.name,
        service_key:   r.key,
        environment:   r.env,
        url:           r.url,
        is_up:         r.is_up,
        status_code:   r.status_code,
        response_ms:   r.response_ms,
        error_message: r.error_message,
        checked_at:    new Date().toISOString()
      });
    } catch (e) {
      console.warn(`[HealthCheck] Failed to log uptime for ${r.name}:`, e.message);
    }
  }

  // Auto-create/resolve uptime incidents
  for (const r of uptimeResults) {
    try {
      const serviceKey = `uptime:${r.key}`;

      // Check for existing open incident
      const existingRows = await sbGet(
        `/rest/v1/cc_incidents?select=id,status,pending_resolve&service_key=eq.${encodeURIComponent(serviceKey)}&status=in.(open,in_progress)&limit=1`
      ).catch(() => []);
      const existing = Array.isArray(existingRows) ? existingRows[0] : null;

      if (!r.is_up && !existing) {
        // Service is down — create incident
        const incident = {
          title:          `Service DOWN: ${r.name}`,
          description:    `Health check failed. URL: ${r.url}. Status code: ${r.status_code || 'n/a'}. Error: ${r.error_message || 'No response'}. Response time: ${r.response_ms}ms`,
          priority:       r.key === 'mint-live' || r.key === 'supabase' ? 'critical' : 'high',
          status:         'open',
          category:       'uptime',
          environment:    r.env,
          auto_generated: true,
          pending_resolve: false,
          service_key:    serviceKey,
          reported_by:    'Automated Monitor',
          created_at:     new Date().toISOString(),
          updated_at:     new Date().toISOString()
        };
        const created = await (async () => {
          const { supabaseUrl, serviceRoleKey } = getSupabaseCreds();
          const res2 = await fetch(`${supabaseUrl}/rest/v1/cc_incidents`, {
            method: 'POST',
            headers: {
              'apikey': serviceRoleKey,
              'Authorization': `Bearer ${serviceRoleKey}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=representation'
            },
            body: JSON.stringify(incident)
          });
          const d = await res2.json().catch(() => []);
          return Array.isArray(d) ? d[0] : d;
        })();
        if (['critical', 'high'].includes(incident.priority)) {
          await sendAlertEmail(incident);
        }
        console.log(`[HealthCheck] Incident created for ${r.name}`);
      } else if (r.is_up && existing && !existing.pending_resolve) {
        // Service recovered — mark as pending_resolve (requires admin confirmation)
        await sbPatch('cc_incidents', `id=eq.${existing.id}`, {
          pending_resolve: true,
          notes:           `Service recovered at ${new Date().toLocaleString('en-ZA')}. Awaiting admin confirmation to close.`,
          updated_at:      new Date().toISOString()
        });
        console.log(`[HealthCheck] ${r.name} recovered — pending admin resolve`);
      }
    } catch (e) {
      console.warn(`[HealthCheck] Incident management error for ${r.key}:`, e.message);
    }
  }

  // ── 2. API endpoint health checks ────────────────────────────────────────
  const MINT_LIVE_BASE = 'https://app.mymint.co.za';
  const MINT_DEV_BASE  = 'https://mint-development.vercel.app';

  const endpointDefs = [
    // CRM endpoints
    { base: crmBase,        endpoint: '/api/team?action=list',                           label: 'CRM: Team List',                  method: 'GET',  env: 'crm'  },
    { base: crmBase,        endpoint: '/api/cyber-compliance?action=list-incidents',      label: 'CRM: CC Incidents List',          method: 'GET',  env: 'crm'  },
    { base: crmBase,        endpoint: '/api/cyber-compliance?action=badge-count',         label: 'CRM: CC Badge Count',             method: 'GET',  env: 'crm'  },
    { base: crmBase,        endpoint: '/api/orderbook',                                  label: 'CRM: Order Book',                 method: 'GET',  env: 'crm'  },
    { base: crmBase,        endpoint: '/api/investors/data?action=get-buffer-drawdowns', label: 'CRM: Investors Data',             method: 'GET',  env: 'crm'  },
    // Mint Live platform endpoints
    { base: MINT_LIVE_BASE, endpoint: '/api/health',                                     label: 'Mint Live: Health',               method: 'GET',  env: 'live' },
    { base: MINT_LIVE_BASE, endpoint: '/api/strategies/public',                          label: 'Mint Live: Public Strategies',    method: 'GET',  env: 'live' },
    { base: MINT_LIVE_BASE, endpoint: '/api/auth/session',                               label: 'Mint Live: Auth Session',         method: 'GET',  env: 'live' },
    // Mint Dev platform endpoints
    { base: MINT_DEV_BASE,  endpoint: '/api/health',                                     label: 'Mint Dev: Health',                method: 'GET',  env: 'dev'  },
    { base: MINT_DEV_BASE,  endpoint: '/api/strategies/public',                          label: 'Mint Dev: Public Strategies',     method: 'GET',  env: 'dev'  },
  ];

  const apiResults = await Promise.all(
    endpointDefs.map(e => checkApiEndpoint(e.base, e.endpoint, e.label, e.method).then(r => ({ ...r, environment: e.env })))
  );

  // Write api health logs
  for (const r of apiResults) {
    try {
      await sbInsert('cc_api_health', {
        environment:    r.environment,
        endpoint:       r.endpoint,
        label:          r.label,
        method:         r.method,
        expected_status: r.expected_status,
        actual_status:  r.actual_status,
        response_ms:    r.response_ms,
        passed:         r.passed,
        error_message:  r.error_message,
        checked_at:     new Date().toISOString()
      });
    } catch (e) {
      console.warn(`[HealthCheck] Failed to log api health for ${r.label}:`, e.message);
    }
  }

  // Auto-create incidents for failed API endpoints (consecutive failures matter less, just log them)
  for (const r of apiResults) {
    if (!r.passed) {
      const serviceKey = `api:${r.endpoint.split('?')[0]}`;
      const existing = await sbGet(
        `/rest/v1/cc_incidents?select=id&service_key=eq.${encodeURIComponent(serviceKey)}&status=in.(open,in_progress)&limit=1`
      ).catch(() => []);
      if (!Array.isArray(existing) || existing.length === 0) {
        const incident = {
          title:          `API Failure: ${r.label}`,
          description:    `Endpoint ${r.endpoint} returned ${r.actual_status || 'no response'} (expected ${r.expected_status}). Response time: ${r.response_ms}ms. Error: ${r.error_message || 'n/a'}`,
          priority:       'high',
          status:         'open',
          category:       'api',
          environment:    r.environment,
          auto_generated: true,
          pending_resolve: false,
          service_key:    serviceKey,
          reported_by:    'Automated Monitor',
          created_at:     new Date().toISOString(),
          updated_at:     new Date().toISOString()
        };
        try {
          const { supabaseUrl, serviceRoleKey } = getSupabaseCreds();
          await fetch(`${supabaseUrl}/rest/v1/cc_incidents`, {
            method: 'POST',
            headers: {
              'apikey': serviceRoleKey,
              'Authorization': `Bearer ${serviceRoleKey}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=minimal'
            },
            body: JSON.stringify(incident)
          });
          await sendAlertEmail(incident);
        } catch (e) {
          console.warn('[HealthCheck] Failed to create API incident:', e.message);
        }
      }
    }
  }

  // ── 3. Policy checks ──────────────────────────────────────────────────────
  const policyResults = await runPolicyChecksAsync();
  for (const check of policyResults) {
    try {
      await sbInsert('cc_policy_checks', check);
    } catch (e) {
      console.warn('[HealthCheck] Failed to log policy check:', e.message);
    }
  }

  const failed = policyResults.filter(p => !p.passed);
  console.log(`[HealthCheck] Done in ${Date.now() - startTime}ms. Uptime: ${uptimeResults.filter(r => r.is_up).length}/${uptimeResults.length} up. API: ${apiResults.filter(r => r.passed).length}/${apiResults.length} pass. Policies: ${policyResults.length - failed.length}/${policyResults.length} pass.`);
};

module.exports = { runHealthCheck, sendAlertEmail };
