require('dotenv').config();
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sumsubArchiveHandler = require('./api/sumsub/archive');
const teamHandler = require('./api/team');

const port = process.env.PORT || 3000;
const publicDir = path.join(__dirname, 'public');
const indexPath = path.join(publicDir, 'index.html');

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const resendApiKey = process.env.RESEND_API_KEY;
const orderbookEmailFrom = process.env.ORDERBOOK_EMAIL_FROM;
const orderbookEmailTo = process.env.ORDERBOOK_EMAIL_TO;
const orderbookDailyAmHour = Number(process.env.ORDERBOOK_DAILY_AM_HOUR || 15);
const orderbookDailyAmMinute = Number(process.env.ORDERBOOK_DAILY_AM_MINUTE || 30);
const orderbookEnableIntervalScheduler = String(process.env.ORDERBOOK_ENABLE_INTERVAL_SCHEDULER || '').toLowerCase() === 'true';
let lastDailyOrderbookEmailDateKey = '';

const sendJson = (res, statusCode, body) => {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

const parseBearerToken = (authorizationHeader) => {
  if (!authorizationHeader || typeof authorizationHeader !== 'string') return null;
  if (!authorizationHeader.startsWith('Bearer ')) return null;
  return authorizationHeader.slice('Bearer '.length).trim() || null;
};

const readJsonBody = (req) => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 1024 * 1024) {
      reject(new Error('Payload too large'));
      req.destroy();
    }
  });

  req.on('end', () => {
    try {
      const parsed = body ? JSON.parse(body) : {};
      resolve(parsed);
    } catch (error) {
      reject(new Error('Invalid JSON body'));
    }
  });

  req.on('error', (error) => {
    reject(error);
  });
});

const sendOrderbookCsvEmail = async ({ subject, csvContent, fileName }) => {
  if (!resendApiKey || !orderbookEmailFrom || !orderbookEmailTo) {
    throw new Error('Email service not configured. Set RESEND_API_KEY, ORDERBOOK_EMAIL_FROM, ORDERBOOK_EMAIL_TO');
  }

  const safeFileName = String(fileName || 'order-book.csv');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: orderbookEmailFrom,
      to: [orderbookEmailTo],
      subject: subject || 'Order Book CSV',
      text: 'Attached is the latest order book CSV.',
      attachments: [
        {
          filename: safeFileName,
          content: Buffer.from(String(csvContent || ''), 'utf8').toString('base64')
        }
      ]
    })
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message = payload?.message || payload?.error || `Resend request failed with ${response.status}`;
    throw new Error(message);
  }

  return payload;
};

const toOrderbookCsvContent = (rows) => {
  const normalizeCsv = (value) => {
    const base = String(value ?? '');
    return `"${base.replace(/"/g, '""')}"`;
  };

  const header = ['Line', 'Instrument Name', 'Ticker', 'ISIN', 'Side', 'Total Quantity', 'Order Type', 'Settlement Account', 'Broker Ref'];
  const csvLines = [header.map(normalizeCsv).join(',')];

  rows.forEach((row) => {
    csvLines.push([
      row.line,
      row.instrumentName,
      row.ticker,
      row.isin,
      row.side,
      row.totalQuantity,
      row.orderType,
      row.settlementAccount,
      row.brokerRef
    ].map(normalizeCsv).join(','));
  });

  return csvLines.join('\n');
};

const buildDailySnapshotRows = (holdings, securitiesRows) => {
  const securitiesMap = {};
  securitiesRows.forEach((security) => {
    securitiesMap[security.id] = security;
  });

  return (holdings || []).map((row, index) => {
    const security = securitiesMap[row.security_id] || {};
    const quantityValue = Number(row.quantity);
    const isQuantityNumeric = Number.isFinite(quantityValue);

    return {
      line: index + 1,
      instrumentName: security.name || '-',
      ticker: security.symbol ?? '-',
      isin: security.isin ?? security.ISIN ?? security.isin_code ?? security.isincode ?? '-',
      side: isQuantityNumeric ? (quantityValue < 0 ? 'SELL' : 'BUY') : '-',
      totalQuantity: isQuantityNumeric
        ? quantityValue.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 6 })
        : (row.quantity ?? '-'),
      orderType: 'Market',
      settlementAccount: '',
      brokerRef: ''
    };
  });
};

const sendDailyOrderbookSnapshotEmail = async () => {
  const holdings = await fetchSupabaseJson(
    '/rest/v1/stock_holdings?select=id,user_id,security_id,quantity,avg_fill,market_value,unrealized_pnl,as_of_date,created_at,updated_at,%22Status%22,%22Fill_date%22,%22Exit_date%22,avg_exit&order=updated_at.desc',
    null
  );

  const securityIds = [...new Set((holdings || []).map((row) => row.security_id).filter(Boolean))];
  const securitiesRows = securityIds.length ? await loadSecuritiesByIds(securityIds, null) : [];
  const rows = buildDailySnapshotRows(holdings || [], securitiesRows || []);
  const now = new Date();
  const dateLabel = now.toLocaleString();

  await sendOrderbookCsvEmail({
    subject: `Daily Order Book - ${dateLabel}`,
    csvContent: toOrderbookCsvContent(rows),
    fileName: `daily-orderbook-${now.toISOString().slice(0, 10)}.csv`
  });
};

const maybeRunDailyOrderbookScheduler = async () => {
  const now = new Date();
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const currentMinuteOfDay = (hours * 60) + minutes;
  const targetMinuteOfDay = (orderbookDailyAmHour * 60) + orderbookDailyAmMinute;
  const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  if (currentMinuteOfDay < targetMinuteOfDay) {
    return;
  }

  if (lastDailyOrderbookEmailDateKey === dateKey) {
    return;
  }

  lastDailyOrderbookEmailDateKey = dateKey;

  try {
    await sendDailyOrderbookSnapshotEmail();
    console.log(`[OrderbookScheduler] Daily CSV sent for ${dateKey} at ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`);
  } catch (error) {
    console.error('[OrderbookScheduler] Daily CSV send failed:', error?.message || error);
  }
};

const startDailyOrderbookScheduler = () => {
  setInterval(() => {
    maybeRunDailyOrderbookScheduler().catch(err => console.error('[OrderbookScheduler] Interval error:', err?.message || err));
  }, 30000);

  maybeRunDailyOrderbookScheduler().catch(err => console.error('[OrderbookScheduler] Startup error:', err?.message || err));
};

const syncAllSecuritiesFromYahoo = async () => {
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    console.log('[MarketSync] Skipping — Supabase credentials not configured.');
    return;
  }

  console.log('[MarketSync] Starting market data sync…');

  let securities;
  try {
    securities = await fetchSupabaseJson('/rest/v1/securities?select=id,symbol,name&is_active=eq.true', null);
  } catch (err) {
    console.error('[MarketSync] Failed to load securities:', err.message);
    return;
  }

  if (!securities || securities.length === 0) {
    console.log('[MarketSync] No active securities found.');
    return;
  }

  let yfCookie = '';
  let crumb = '';
  try {
    const fcRes = await fetch('https://fc.yahoo.com/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0' }
    });
    yfCookie = fcRes.headers.get('set-cookie') || '';
    const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': yfCookie }
    });
    crumb = await crumbRes.text();
  } catch (err) {
    console.error('[MarketSync] Failed to get Yahoo Finance crumb:', err.message);
    return;
  }

  let updated = 0;
  let failed = 0;

  for (const sec of securities) {
    if (!sec.symbol) continue;
    try {
      const encodedSymbol = encodeURIComponent(sec.symbol);
      const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodedSymbol}?modules=price%2CsummaryDetail%2CdefaultKeyStatistics&crumb=${encodeURIComponent(crumb)}`;
      const yfRes = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': yfCookie, 'Accept': 'application/json' }
      });

      if (!yfRes.ok) { failed++; continue; }

      const yfData = await yfRes.json();
      const result = yfData?.quoteSummary?.result?.[0];
      if (!result) { failed++; continue; }

      const price = result.price || {};
      const summary = result.summaryDetail || {};
      const keyStats = result.defaultKeyStatistics || {};

      const rawChangePct = price.regularMarketChangePercent?.raw ?? null;
      const rawDivYield = summary.dividendYield?.raw ?? null;
      const rawYtd = keyStats.ytdReturn?.raw ?? keyStats['52WeekChange']?.raw ?? null;

      // If YTD not returned by quoteSummary, calculate it from the chart API
      let calculatedYtd = null;
      if (rawYtd == null) {
        try {
          const chartRes = await fetch(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodedSymbol}?interval=1d&range=ytd`,
            { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }
          );
          if (chartRes.ok) {
            const chartData = await chartRes.json();
            const chartResult = chartData?.chart?.result?.[0];
            const currentPrice = chartResult?.meta?.regularMarketPrice;
            const closes = chartResult?.indicators?.quote?.[0]?.close;
            const firstClose = closes?.find(c => c != null);
            if (firstClose && currentPrice) {
              calculatedYtd = ((currentPrice - firstClose) / firstClose) * 100;
            }
          }
        } catch { /* ignore */ }
      }

      const updatePayload = {};
      const lp = price.regularMarketPrice?.raw;
      if (lp != null) updatePayload.last_price = Math.round(lp);
      if (rawChangePct != null) updatePayload.change_percent = rawChangePct * 100;
      const mc = price.marketCap?.raw;
      if (mc != null) updatePayload.market_cap = Math.round(mc);
      const pe = summary.trailingPE?.raw ?? keyStats.trailingPE?.raw;
      if (pe != null) updatePayload.pe_ratio = pe;
      const dr = summary.dividendRate?.raw;
      if (dr != null) updatePayload.dividend_per_share = dr;
      if (rawDivYield != null) updatePayload.dividend_yield = rawDivYield * 100;
      const ytdFinal = rawYtd != null ? rawYtd * 100 : calculatedYtd;
      if (ytdFinal != null) updatePayload.ytd_performance = ytdFinal;

      if (Object.keys(updatePayload).length > 0) {
        await mutateSupabaseJson(
          `/rest/v1/securities?id=eq.${encodeURIComponent(sec.id)}`,
          updatePayload,
          null,
          'PATCH'
        );
        updated++;
      }
    } catch {
      failed++;
    }
    await new Promise(r => setTimeout(r, 150));
  }

  console.log(`[MarketSync] Done — ${updated} updated, ${failed} failed out of ${securities.length} securities.`);
};

const marketSyncDailyHour = Number(process.env.MARKET_SYNC_HOUR || 7);
const marketSyncDailyMinute = Number(process.env.MARKET_SYNC_MINUTE || 0);
let lastMarketSyncDateKey = '';

const maybeRunDailyMarketSync = async () => {
  const now = new Date();
  const currentMinuteOfDay = (now.getHours() * 60) + now.getMinutes();
  const targetMinuteOfDay = (marketSyncDailyHour * 60) + marketSyncDailyMinute;
  const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  if (currentMinuteOfDay < targetMinuteOfDay) return;
  if (lastMarketSyncDateKey === dateKey) return;

  lastMarketSyncDateKey = dateKey;
  await syncAllSecuritiesFromYahoo();
};

const startMarketDataScheduler = () => {
  setTimeout(() => {
    syncAllSecuritiesFromYahoo().catch(err => console.error('[MarketSync] Startup sync error:', err?.message || err));
  }, 10000);

  setInterval(() => {
    maybeRunDailyMarketSync().catch(err => console.error('[MarketSync] Scheduled sync error:', err?.message || err));
  }, 60000);
};

const fetchSupabaseJson = async (path, token, useServiceRoleAuth = true) => {
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error('Supabase server credentials are not configured');
  }

  const url = `${supabaseUrl}${path}`;
  const authToken = useServiceRoleAuth ? supabaseServiceRoleKey : token;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'apikey': supabaseServiceRoleKey,
      'Authorization': `Bearer ${authToken}`,
      'Accept': 'application/json'
    }
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message = payload?.message || payload?.error || `Supabase request failed with status ${response.status}`;
    throw new Error(message);
  }

  return payload;
};

const mutateSupabaseJson = async (path, payload, token, method = 'PATCH', useServiceRoleAuth = true) => {
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error('Supabase server credentials are not configured');
  }

  const url = `${supabaseUrl}${path}`;
  const authToken = useServiceRoleAuth ? supabaseServiceRoleKey : token;
  const response = await fetch(url, {
    method,
    headers: {
      'apikey': supabaseServiceRoleKey,
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
      'Accept': 'application/json'
    },
    body: payload ? JSON.stringify(payload) : undefined
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const message = data?.message || data?.error || `Supabase mutation failed with status ${response.status}`;
    throw new Error(message);
  }

  return data;
};

const buildInFilter = (values) => values
  .map((value) => encodeURIComponent(String(value)))
  .join(',');

const loadSecuritiesByIds = async (securityIds, token) => {
  const variants = [
    'id,name,symbol,isin',
    'id,name,symbol,%22ISIN%22',
    'id,name,symbol,isin_code',
    'id,name,symbol,isincode',
    'id,name,symbol'
  ];

  let lastError = null;
  for (const selectClause of variants) {
    try {
      const rows = await fetchSupabaseJson(
        `/rest/v1/securities?select=${selectClause}&id=in.(${buildInFilter(securityIds)})`,
        token
      );
      return rows || [];
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) throw lastError;
  return [];
};

const buildOrderbookRows = (holdings, securitiesRows, profileRows) => {
  const securitiesMap = {};
  const profilesMap = {};

  securitiesRows.forEach((security) => {
    securitiesMap[security.id] = security;
  });

  profileRows.forEach((profile) => {
    profilesMap[profile.id] = profile;
  });

  return holdings.map((row, index) => {
    const security = securitiesMap[row.security_id] || {};
    const profile = profilesMap[row.user_id] || {};
    const instrumentName = security.name || '-';
    const ticker = security.symbol ?? '-';
    const isin = security.isin ?? security.ISIN ?? security.isin_code ?? security.isincode ?? '-';
    const timestamp = row.updated_at || row.created_at || row.as_of_date || null;
    const clientName = [profile.first_name, profile.last_name].filter(Boolean).join(' ') || String(row.user_id || 'Unknown client');
    const settlementAccount = profile.email || `${clientName} Main`;
    const settlementAccountOptions = [...new Set([
      settlementAccount,
      `${clientName} Main`,
      `${clientName} Trading`
    ].filter(Boolean))];
    const brokerRef = row.id ? `SH-${String(row.id).slice(0, 8)}` : (row.security_id ? `BR-${row.security_id}` : `BR-${index + 1}`);
    const brokerRefOptions = [...new Set([
      brokerRef,
      `${brokerRef}-A`,
      `${brokerRef}-B`
    ].filter(Boolean))];
    const quantityValue = Number(row.quantity);
    const isQuantityNumeric = Number.isFinite(quantityValue);
    const side = isQuantityNumeric
      ? (quantityValue < 0 ? 'SELL' : 'BUY')
      : '-';
    const statusText = String(row.Status || '').trim();
    const orderType = statusText
      || (row.Exit_date ? 'CLOSED' : (row.Fill_date ? 'FILLED' : 'OPEN'));
    const totalQuantity = isQuantityNumeric
      ? quantityValue.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 6 })
      : (row.quantity ?? '-');

    return {
      line: index + 1,
      instrumentName,
      ticker,
      isin,
      side,
      totalQuantity,
      orderType,
      settlementAccount,
      settlementAccountOptions,
      brokerRef,
      brokerRefOptions,
      timestamp
    };
  });
};

const getSumsubAuthHeaders = (method, pathWithQuery) => {
  const appToken = process.env.SUMSUB_APP_TOKEN;
  const appSecret = process.env.SUMSUB_APP_SECRET;
  if (!appToken || !appSecret) {
    return null;
  }
  const ts = Math.floor(Date.now() / 1000).toString();
  const signaturePayload = ts + method + pathWithQuery;
  const signature = crypto
    .createHmac('sha256', appSecret)
    .update(signaturePayload)
    .digest('hex');

  return {
    'Accept': 'application/json',
    'X-App-Token': appToken,
    'X-App-Access-Sig': signature,
    'X-App-Access-Ts': ts
  };
};


const server = http.createServer((req, res) => {
  if (req.url === '/favicon.ico') {
    fs.readFile(path.join(publicDir, 'icon.png'), (err, data) => {
      if (err) { res.writeHead(204); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      res.end(data);
    });
    return;
  }

  if (req.url.startsWith('/api/mandate-data') && req.method === 'GET') {
    const token = parseBearerToken(req.headers.authorization);
    if (!token) {
      sendJson(res, 401, { error: 'Missing Authorization bearer token' });
      return;
    }
    (async () => {
      try {
        await fetchSupabaseJson('/auth/v1/user', token, false);
        const profileId = new URL(req.url, 'http://localhost').searchParams.get('profileId');
        if (!profileId) {
          sendJson(res, 400, { error: 'Missing profileId parameter' });
          return;
        }
        const rows = await fetchSupabaseJson(
          `/rest/v1/user_onboarding?select=sumsub_raw&user_id=eq.${encodeURIComponent(profileId)}&limit=1`,
          token
        );
        const row = Array.isArray(rows) ? rows[0] : null;
        const raw = row?.sumsub_raw;
        const mandateData = (raw && typeof raw === 'object' ? raw : {}).mandate_data || null;
        sendJson(res, 200, { mandate_data: mandateData });
      } catch (err) {
        sendJson(res, 500, { error: err.message || 'Failed to fetch mandate data' });
      }
    })();
    return;
  }

  if (req.url.startsWith('/api/orderbook/send-csv') && req.method === 'POST') {
    const token = parseBearerToken(req.headers.authorization);
    if (!token) {
      sendJson(res, 401, { error: 'Missing Authorization bearer token' });
      return;
    }

    (async () => {
      try {
        await fetchSupabaseJson('/auth/v1/user', token, false);
        const body = await readJsonBody(req);
        await sendOrderbookCsvEmail({
          subject: body?.subject,
          csvContent: body?.csvContent,
          fileName: body?.fileName
        });
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 500, {
          error: 'Could not send orderbook CSV email',
          details: error?.message || 'Unknown error'
        });
      }
    })();

    return;
  }

  if (req.url.startsWith('/system/orderbook/send-trade-confirmation') && req.method === 'POST') {
    const token = parseBearerToken(req.headers.authorization);
    if (!token) {
      sendJson(res, 401, { error: 'Missing Authorization bearer token' });
      return;
    }

    (async () => {
      try {
        await fetchSupabaseJson('/auth/v1/user', token, false);
        const body = await readJsonBody(req);
        const { holdingId, bndReference, forceResend } = body || {};
        if (!holdingId) {
          sendJson(res, 400, { error: 'Missing holdingId' });
          return;
        }

        // ── Duplicate guard: check investor_trade_confirmations ──────────────
        const existingConfirms = await fetchSupabaseJson(
          `/rest/v1/investor_trade_confirmations?holding_id=eq.${encodeURIComponent(holdingId)}&select=id,sent_at,status`,
          token
        );
        const alreadySent = existingConfirms && existingConfirms.some((r) => r.sent_at && r.status === 'sent');
        if (alreadySent && !forceResend) {
          sendJson(res, 400, { error: 'Email already sent for this holding.' });
          return;
        }

        const holdingsData = await fetchSupabaseJson(`/rest/v1/stock_holdings_c?id=eq.${encodeURIComponent(holdingId)}`, token);
        const holding = holdingsData && holdingsData[0];
        if (!holding) {
          sendJson(res, 404, { error: 'Holding not found' });
          return;
        }

        const isBatch = !!holding.rebalance_batch_id;

        let profile = {};
        if (holding.user_id) {
          const profileData = await fetchSupabaseJson(`/rest/v1/profiles?id=eq.${encodeURIComponent(holding.user_id)}`, token);
          if (profileData && profileData.length) profile = profileData[0];
        }

        let clientEmail = profile.email;
        if (!clientEmail) {
          sendJson(res, 400, { error: 'Client email not found' });
          return;
        }

        // ── Shared template builder ────────────────────────────────────────────
        const HEADER_IMAGE_URL = 'https://my-mint-admin.vercel.app/images/OrderBookMail.avif';
        const DASHBOARD_URL = 'https://app.mymint.co.za';
        const currentDateStr = new Date().toLocaleDateString('en-ZA', { year: 'numeric', month: 'long', day: 'numeric' });

        const buildTradeRow = (side, code, nominal) => {
          const sideColor = side === 'SELL' ? '#dc2626' : '#059669';
          return `<tr>
            <td style="padding:12px 8px;font-size:14px;border-bottom:1px solid #f1f5f9;color:${sideColor};font-weight:700;">${side}</td>
            <td style="padding:12px 8px;font-size:14px;border-bottom:1px solid #f1f5f9;color:#1e293b;font-weight:600;">${code}</td>
            <td style="padding:12px 8px;font-size:14px;border-bottom:1px solid #f1f5f9;color:#1e293b;font-weight:600;">${nominal}</td>
          </tr>`;
        };

        const buildEmailHtml = ({ firstName, mintRef, orderDate, tableRowsHtml, subjectHeading, subjectIntro }) => `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;line-height:1.6;color:#1e293b;margin:0;padding:0;">
  <div style="background-color:#f8fafc;padding:20px;">
    <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.05);">

      <!-- Header Image (force-loaded via absolute CDN URL) -->
      <img src="${HEADER_IMAGE_URL}" width="600" alt="Mint Order Executed" style="display:block;width:100%;height:auto;border:0;">

      <!-- Body Content -->
      <div style="padding:40px;">
        <h1 style="font-size:28px;font-weight:800;color:#1e293b;margin-top:0;margin-bottom:16px;letter-spacing:-0.02em;">${subjectHeading}</h1>
        <p style="font-size:16px;color:#475569;margin-bottom:8px;">Hello <strong>${firstName}</strong>,</p>
        <p style="font-size:16px;color:#475569;margin-bottom:24px;">${subjectIntro}</p>

        <!-- Client Meta Bar -->
        <div style="border-top:1px solid #f1f5f9;border-bottom:1px solid #f1f5f9;padding:20px 0;margin-bottom:30px;display:flex;">
          <div style="text-align:center;flex:1;">
            <span style="font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:#94a3b8;font-weight:700;display:block;margin-bottom:4px;">Reference</span>
            <span style="font-size:14px;font-weight:700;color:#1e293b;">${mintRef}</span>
          </div>
          <div style="text-align:center;flex:1;">
            <span style="font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:#94a3b8;font-weight:700;display:block;margin-bottom:4px;">Order Date</span>
            <span style="font-size:14px;font-weight:700;color:#1e293b;">${orderDate}</span>
          </div>
        </div>

        <!-- Trade Table -->
        <table style="width:100%;border-collapse:collapse;margin-bottom:30px;">
          <thead>
            <tr>
              <th style="text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#94a3b8;padding:12px 8px;border-bottom:2px solid #f1f5f9;">Buy / Sell</th>
              <th style="text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#94a3b8;padding:12px 8px;border-bottom:2px solid #f1f5f9;">Equity Code</th>
              <th style="text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#94a3b8;padding:12px 8px;border-bottom:2px solid #f1f5f9;">Nominal</th>
            </tr>
          </thead>
          <tbody>
            ${tableRowsHtml}
          </tbody>
        </table>

        <!-- CTA Button -->
        <div style="text-align:center;margin:30px 0;">
          <a href="${DASHBOARD_URL}" style="background-color:#7c3aed;color:#ffffff;padding:14px 32px;border-radius:999px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block;">View Portfolio</a>
        </div>
      </div>

      <!-- Regulatory Footer -->
      <div style="padding:40px;background-color:#f8fafc;font-size:11px;color:#94a3b8;line-height:1.5;">
        <p style="font-size:11px;margin-bottom:12px;">MINT (Pty) Ltd is an authorised Financial Services Provider (FSP 55118) regulated by the Financial Sector Conduct Authority and a registered Credit Provider (NCRCP22892) under the National Credit Act.</p>
        <p style="font-size:11px;margin-bottom:12px;">All investment activity carries risk, including the possible loss of capital and liquidity constraints. Any information provided is educational in nature and does not constitute personalised financial advice.</p>
        <p style="font-size:11px;margin-bottom:0;">&copy; 2026 MINT. All rights reserved.<br>
        Date: ${currentDateStr}<br>
        <a href="https://www.mymint.co.za" style="color:#7c3aed;text-decoration:none;">www.mymint.co.za</a></p>
      </div>
    </div>
  </div>
</body>
</html>`;
        // ──────────────────────────────────────────────────────────────────────

        const firstName = profile.first_name || 'Investor';
        let subject = 'Trade Confirmation — MINT';
        let htmlContent = '';

        if (!isBatch) {
          // ── Single trade confirmation ──────────────────────────────────────
          let security = {};
          if (holding.security_id) {
            const secData = await fetchSupabaseJson(`/rest/v1/securities_c?id=eq.${encodeURIComponent(holding.security_id)}`, token);
            if (secData && secData.length) security = secData[0];
          }

          let strategyName = 'your portfolio';
          if (holding.strategy_id) {
            const stratData = await fetchSupabaseJson(`/rest/v1/strategies_c?id=eq.${encodeURIComponent(holding.strategy_id)}`, token);
            if (stratData && stratData.length) strategyName = stratData[0].name;
          } else if (holding.strategy_name_snapshot) {
            strategyName = holding.strategy_name_snapshot;
          }

          const ticker = security.symbol || '-';
          const side = holding.trade_side || (holding.quantity < 0 ? 'SELL' : 'BUY');
          const quantity = Math.abs(holding.quantity);
          const avgFill = (holding.avg_fill / 100).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          const ref = bndReference || `BND-${holding.id.substring(0, 8).toUpperCase()}`;
          const execDate = holding.fill_date
            ? new Date(holding.fill_date).toLocaleDateString('en-ZA', { year: 'numeric', month: 'long', day: 'numeric' })
            : currentDateStr;

          const quantityDisplay = parseFloat(quantity.toFixed(4)).toLocaleString('en-ZA');
          const nominalDisplay = `${quantityDisplay} @ R ${avgFill}`;

          htmlContent = buildEmailHtml({
            firstName,
            mintRef: ref,
            orderDate: execDate,
            tableRowsHtml: buildTradeRow(side, ticker, nominalDisplay),
            subjectHeading: 'Order Executed.',
            subjectIntro: `your trade for <strong>${security.name || ticker}</strong> has been successfully filled and allocated to your <strong>${strategyName}</strong> portfolio.`
          });

        } else {
          // ── Portfolio realignment (batch) ──────────────────────────────────
          subject = 'Portfolio Realignment — MINT';
          const batchHoldings = await fetchSupabaseJson(
            `/rest/v1/stock_holdings_c?rebalance_batch_id=eq.${encodeURIComponent(holding.rebalance_batch_id)}&user_id=eq.${encodeURIComponent(holding.user_id)}`,
            token
          );

          const strategyName = holding.strategy_name_snapshot || 'your portfolio';
          const batchRef = `BND-${holding.rebalance_batch_id.substring(0, 8).toUpperCase()}`;
          const batchDate = holding.fill_date
            ? new Date(holding.fill_date).toLocaleDateString('en-ZA', { year: 'numeric', month: 'long', day: 'numeric' })
            : currentDateStr;

          let tableRowsHtml = '';
          for (const bHolding of batchHoldings) {
            let security = {};
            if (bHolding.security_id) {
              const secData = await fetchSupabaseJson(`/rest/v1/securities_c?id=eq.${encodeURIComponent(bHolding.security_id)}`, token);
              if (secData && secData.length) security = secData[0];
            }
            const ticker = security.symbol || '-';
            const side = bHolding.trade_side || (bHolding.quantity < 0 ? 'SELL' : 'BUY');
            const quantity = Math.abs(bHolding.quantity);
            const avgFill = (bHolding.avg_fill / 100).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            const quantityDisplay = parseFloat(quantity.toFixed(4)).toLocaleString('en-ZA');
            const nominalDisplay = `${quantityDisplay} @ R ${avgFill}`;
            tableRowsHtml += buildTradeRow(side, ticker, nominalDisplay);
          }

          htmlContent = buildEmailHtml({
            firstName,
            mintRef: batchRef,
            orderDate: batchDate,
            tableRowsHtml,
            subjectHeading: 'Orders Executed.',
            subjectIntro: `the realignment of your <strong>${strategyName}</strong> portfolio has been completed. The following trades were executed:`
          });
        }

        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${resendApiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: orderbookEmailFrom || 'notifications@mymint.co.za',
            to: [clientEmail],
            subject,
            html: htmlContent
          })
        });

        // Parse Resend response once — used for error check and resendId capture
        const resendPayload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(resendPayload.message || resendPayload.error || `Resend error: ${response.status}`);
        }

        // ── Record send in investor_trade_confirmations ───────────────────────
        const resendId = resendPayload?.id || null;
        const nowIso = new Date().toISOString();
        const ref = isBatch
          ? `BND-${holding.rebalance_batch_id.substring(0, 8).toUpperCase()}`
          : (body.bndReference || `BND-${holding.id.substring(0, 8).toUpperCase()}`);

        const confirmRecord = {
          user_id: holding.user_id,
          holding_id: isBatch ? null : holdingId,
          rebalance_batch_id: isBatch ? holding.rebalance_batch_id : null,
          reference_number: ref,
          recipient_email: clientEmail,
          status: 'sent',
          resend_id: resendId,
          executed_price_cents: holding.avg_fill || null,
          quantity_filled: holding.quantity ? Math.abs(holding.quantity) : null,
          strategy_name_at_execution: holding.strategy_name_snapshot || null,
          sent_payload: isBatch ? { batch_id: holding.rebalance_batch_id } : { holding_id: holdingId },
          sent_at: nowIso
        };

        // Try INSERT first; if reference_number conflicts (duplicate click), PATCH instead
        await mutateSupabaseJson(
          '/rest/v1/investor_trade_confirmations',
          confirmRecord,
          token,
          'POST'
        ).catch(async () => {
          const existingId = existingConfirms && existingConfirms[0]?.id;
          if (existingId) {
            await mutateSupabaseJson(
              `/rest/v1/investor_trade_confirmations?id=eq.${encodeURIComponent(existingId)}`,
              { status: 'sent', sent_at: nowIso, resend_id: resendId },
              token,
              'PATCH'
            );
          }
        });

        sendJson(res, 200, { ok: true });
      } catch (error) {
        console.error('send-trade-confirmation error', error);
        sendJson(res, 500, {
          error: 'Could not send trade confirmation',
          details: error?.message || 'Unknown error'
        });
      }
    })();
    return;
  }

  if (req.url.startsWith('/api/orderbook')) {
    const token = parseBearerToken(req.headers.authorization);
    if (!token) {
      sendJson(res, 401, { error: 'Missing Authorization bearer token' });
      return;
    }

    (async () => {
      try {
        await fetchSupabaseJson('/auth/v1/user', token, false);

        const holdings = await fetchSupabaseJson(
          '/rest/v1/stock_holdings?select=id,user_id,security_id,quantity,avg_fill,market_value,unrealized_pnl,as_of_date,created_at,updated_at,%22Status%22,%22Fill_date%22,%22Exit_date%22,avg_exit&order=updated_at.desc',
          token
        );

        const securityIds = [...new Set((holdings || []).map((row) => row.security_id).filter(Boolean))];
        const userIds = [...new Set((holdings || []).map((row) => row.user_id).filter(Boolean))];

        const securitiesRows = securityIds.length ? await loadSecuritiesByIds(securityIds, token) : [];
        const profileRows = userIds.length
          ? await fetchSupabaseJson(
            `/rest/v1/profiles?select=id,first_name,last_name,email,phone_number,mint_number&id=in.(${buildInFilter(userIds)})`,
            token
          )
          : [];

        const rows = buildOrderbookRows(holdings || [], securitiesRows || [], profileRows || []);
        sendJson(res, 200, { rows });
      } catch (error) {
        sendJson(res, 500, {
          error: 'Could not load orderbook data',
          details: error?.message || 'Unknown error'
        });
      }
    })();

    return;
  }

  if (req.url.startsWith('/api/sumsub/applicant')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const externalUserId = url.searchParams.get('externalUserId');
    if (!externalUserId) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'externalUserId is required' }));
      return;
    }

    const method = 'GET';
    const pathWithQuery = `/resources/applicants/-;externalUserId=${encodeURIComponent(externalUserId)}/one`;
    const headers = getSumsubAuthHeaders(method, pathWithQuery);
    if (!headers) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Sumsub credentials are not configured' }));
      return;
    }

    const options = {
      hostname: 'api.sumsub.com',
      path: pathWithQuery,
      method,
      headers: {
        ...headers
      }
    };

    const sumsubReq = https.request(options, (sumsubRes) => {
      let data = '';
      sumsubRes.on('data', (chunk) => {
        data += chunk;
      });
      sumsubRes.on('end', () => {
        res.writeHead(sumsubRes.statusCode || 500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(data);
      });
    });

    sumsubReq.on('error', (err) => {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Sumsub request failed', details: err.message }));
    });

    sumsubReq.end();
    return;
  }

  if (req.url.startsWith('/api/sumsub/metadata')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const applicantId = url.searchParams.get('applicantId');
    if (!applicantId) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'applicantId is required' }));
      return;
    }

    const method = 'GET';
    const pathWithQuery = `/resources/applicants/${encodeURIComponent(applicantId)}/metadata/resources`;
    const headers = getSumsubAuthHeaders(method, pathWithQuery);
    if (!headers) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Sumsub credentials are not configured' }));
      return;
    }

    const options = {
      hostname: 'api.sumsub.com',
      path: pathWithQuery,
      method,
      headers
    };

    const sumsubReq = https.request(options, (sumsubRes) => {
      let data = '';
      sumsubRes.on('data', (chunk) => {
        data += chunk;
      });
      sumsubRes.on('end', () => {
        res.writeHead(sumsubRes.statusCode || 500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(data);
      });
    });

    sumsubReq.on('error', (err) => {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Sumsub request failed', details: err.message }));
    });

    sumsubReq.end();
    return;
  }

  if (req.url.startsWith('/api/sumsub/image')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const inspectionId = url.searchParams.get('inspectionId');
    const imageId = url.searchParams.get('imageId');
    if (!inspectionId || !imageId) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'inspectionId and imageId are required' }));
      return;
    }

    const method = 'GET';
    const pathWithQuery = `/resources/inspections/${encodeURIComponent(inspectionId)}/resources/${encodeURIComponent(imageId)}`;
    const headers = getSumsubAuthHeaders(method, pathWithQuery);
    if (!headers) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Sumsub credentials are not configured' }));
      return;
    }

    const options = {
      hostname: 'api.sumsub.com',
      path: pathWithQuery,
      method,
      headers
    };

    const sumsubReq = https.request(options, (sumsubRes) => {
      res.writeHead(sumsubRes.statusCode || 500, {
        'Content-Type': sumsubRes.headers['content-type'] || 'application/octet-stream'
      });
      sumsubRes.pipe(res);
    });

    sumsubReq.on('error', (err) => {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Sumsub request failed', details: err.message }));
    });

    sumsubReq.end();
    return;
  }

  if (req.url.startsWith('/api/sumsub/archive')) {
    (async () => {
      try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        req.query = Object.fromEntries(url.searchParams.entries());

        if (req.method === 'POST') {
          req.body = await readJsonBody(req);
        }

        await sumsubArchiveHandler(req, res);
      } catch (error) {
        sendJson(res, 500, {
          error: 'Could not handle sumsub archive request',
          details: error?.message || 'Unknown error'
        });
      }
    })();
    return;
  }

  if (req.url.startsWith('/api/disburse') && req.method === 'POST') {
    const token = parseBearerToken(req.headers.authorization);
    if (!token) {
      sendJson(res, 401, { error: 'Missing Authorization bearer token' });
      return;
    }

    (async () => {
      try {
        // 1. Verify Admin User and Get ID for Audit Logging
        const adminUser = await fetchSupabaseJson('/auth/v1/user', token, false);
        const adminId = adminUser?.id;

        const body = await readJsonBody(req);
        const { loanId, bank_acc, amount, idempotency_key } = body;

        if (!loanId || !bank_acc || !amount) {
          sendJson(res, 400, { error: 'Missing required payout details (loanId, bank_acc, amount)' });
          return;
        }

        // 2. "Stale Price" Check: Recalculate LTV before release
        const pledges = await fetchSupabaseJson(`/rest/v1/pbc_collateral_pledges?loan_application_id=eq.${loanId}`, token);
        if (!pledges || pledges.length === 0) {
          sendJson(res, 400, { error: 'No collateral pledges found for this loan' });
          return;
        }

        const symbols = [...new Set(pledges.map(p => p.symbol))];
        const pricesData = await fetchSupabaseJson(`/rest/v1/security_prices_c?symbol=in.(${symbols.map(s => `%22${s}%22`).join(',')})`, token);

        const priceMap = {};
        (pricesData || []).forEach(p => { priceMap[p.symbol] = p.last_price; });

        let currentCollateralValue = 0;
        pledges.forEach(p => {
          const latestPrice = priceMap[p.symbol] || 0;
          currentCollateralValue += parseFloat(p.pledged_quantity) * latestPrice;
        });

        const currentLTV = (parseFloat(amount) / currentCollateralValue) * 100;

        if (currentLTV >= 100) {
          sendJson(res, 400, {
            error: 'LTV Threshold Exceeded',
            details: `Current LTV is ${currentLTV.toFixed(2)}% due to market fluctuations. Payout blocked for safety.`
          });
          return;
        }

        // 3. Integration with South African Gateway (Mock)
        console.log(`[EFT] [Admin:${adminId}] Initiating payout for Loan ${loanId} (LTV: ${currentLTV.toFixed(2)}%) to account ${bank_acc} for amount ZAR ${amount}`);
        const gatewayResponse = { success: true, reference: `MINT-LIQ-${loanId}` };

        if (gatewayResponse.success) {
          // 4. Finalize Database State with Audit Logging
          const updatePayload = {
            status: 'disbursed',
            disbursed_at: new Date().toISOString(),
            disbursed_by_admin_id: adminId
          };

          const result = await mutateSupabaseJson(
            `/rest/v1/loan_application?id=eq.${encodeURIComponent(loanId)}`,
            updatePayload,
            token,
            'PATCH'
          );

          sendJson(res, 200, {
            ok: true,
            message: "Funds Released via EFT",
            gateway_ref: gatewayResponse.reference,
            current_ltv: currentLTV,
            data: result
          });
        } else {
          sendJson(res, 500, { error: 'Payment gateway rejected the EFT request' });
        }
      } catch (error) {
        sendJson(res, 500, {
          error: 'Could not execute EFT disbursement',
          details: error?.message || 'Unknown error'
        });
      }
    })();

    return;
  }

  if (req.url.startsWith('/api/securities/sync-fundamentals') && req.method === 'POST') {
    const token = parseBearerToken(req.headers.authorization);
    if (!token) {
      sendJson(res, 401, { error: 'Missing Authorization bearer token' });
      return;
    }

    (async () => {
      try {
        await fetchSupabaseJson('/auth/v1/user', token, false);
        await syncAllSecuritiesFromYahoo();
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 500, { error: 'Sync failed', details: error?.message || 'Unknown error' });
      }
    })();

    return;
  }

  /* ── WTD / MTD performance calculated from Yahoo Finance chart API ── */
  if (req.url.startsWith('/api/security-performance') && req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const symbolsParam = url.searchParams.get('symbols') || '';
    const symbols = symbolsParam.split(',').map(s => s.trim()).filter(Boolean);
    if (!symbols.length) { sendJson(res, 400, { error: 'symbols param required' }); return; }

    (async () => {
      try {
        console.log(`[PerfAPI] request for ${symbols.length} symbols`);
        const now = new Date();
        const dow = now.getDay();
        const monday = new Date(now);
        monday.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1));
        monday.setHours(0, 0, 0, 0);
        const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

        const YF_HEADERS = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' };

        const fetchPerf = async (sym) => {
          const enc = encodeURIComponent(sym);
          const perf = { symbol: sym, wtd_performance: null, mtd_performance: null };

          const calcReturn = (cr, cutoff) => {
            const timestamps = cr.timestamp || [];
            const closes = cr.indicators?.quote?.[0]?.close || [];
            const cur = cr.meta?.regularMarketPrice;
            if (!cur) return null;
            let startPrice = null;
            for (let i = 0; i < timestamps.length; i++) {
              if (new Date(timestamps[i] * 1000) >= cutoff && closes[i] != null) { startPrice = closes[i]; break; }
            }
            if (startPrice == null) startPrice = closes.find(c => c != null);
            return (startPrice && cur) ? ((cur - startPrice) / startPrice) * 100 : null;
          };

          const [wtdRes, mtdRes] = await Promise.allSettled([
            fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${enc}?interval=1d&range=5d`, { headers: YF_HEADERS }),
            fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${enc}?interval=1d&range=1mo`, { headers: YF_HEADERS })
          ]);

          if (wtdRes.status === 'fulfilled' && wtdRes.value.ok) {
            const d = await wtdRes.value.json().catch(() => null);
            const cr = d?.chart?.result?.[0];
            if (cr) perf.wtd_performance = calcReturn(cr, monday);
          }
          if (mtdRes.status === 'fulfilled' && mtdRes.value.ok) {
            const d = await mtdRes.value.json().catch(() => null);
            const cr = d?.chart?.result?.[0];
            if (cr) perf.mtd_performance = calcReturn(cr, firstOfMonth);
          }
          return perf;
        };

        /* Process in parallel batches of 8 to avoid overloading Yahoo Finance */
        const results = {};
        const BATCH = 8;
        for (let i = 0; i < symbols.length; i += BATCH) {
          const batch = symbols.slice(i, i + BATCH);
          const perfs = await Promise.all(batch.map(fetchPerf));
          perfs.forEach(p => { results[p.symbol] = p; });
          if (i + BATCH < symbols.length) await new Promise(r => setTimeout(r, 300));
        }

        console.log(`[PerfAPI] done — ${Object.values(results).filter(p => p.wtd_performance != null).length}/${symbols.length} with WTD data`);
        sendJson(res, 200, { results });
      } catch (err) {
        sendJson(res, 500, { error: err?.message || 'Failed' });
      }
    })();
    return;
  }

  if (req.url.startsWith('/api/confirm-eft-deposit') && req.method === 'POST') {
    const token = parseBearerToken(req.headers.authorization);
    if (!token) {
      sendJson(res, 401, { error: 'Missing Authorization bearer token' });
      return;
    }

    (async () => {
      try {
        await fetchSupabaseJson('/auth/v1/user', token, false);
        const body = await readJsonBody(req);
        const ref = body?.reference;

        if (!ref) {
          sendJson(res, 400, { error: 'Missing reference' });
          return;
        }

        const updatePayload = {
          status: 'completed',
          updated_at: new Date().toISOString()
        };

        const result = await mutateSupabaseJson(
          `/rest/v1/transactions?store_reference=eq.${encodeURIComponent(ref)}&status=eq.pending`,
          updatePayload,
          token,
          'PATCH'
        );

        sendJson(res, 200, { ok: true, data: result });
      } catch (error) {
        sendJson(res, 500, {
          error: 'Could not confirm EFT deposit',
          details: error?.message || 'Unknown error'
        });
      }
    })();

    return;
  }

  if ((req.url.startsWith('/api/add-wallet') || req.url.startsWith('/api/send-eft-email?action=add-wallet')) && req.method === 'POST') {
    const token = parseBearerToken(req.headers.authorization);
    if (!token) {
      sendJson(res, 401, { error: 'Missing Authorization bearer token' });
      return;
    }

    (async () => {
      try {
        await fetchSupabaseJson('/auth/v1/user', token, false);
        const body = await readJsonBody(req);
        const { user_id, amount, account_type } = body;

        if (!user_id || typeof amount !== 'number' || amount <= 0) {
          sendJson(res, 400, { error: 'Invalid user_id or amount' });
          return;
        }

        if (!supabaseUrl || !supabaseServiceRoleKey) {
          sendJson(res, 500, { error: 'Supabase not configured' });
          return;
        }

        const sbHeaders = {
          apikey: supabaseServiceRoleKey,
          Authorization: `Bearer ${supabaseServiceRoleKey}`,
          'Content-Type': 'application/json'
        };

        // Handle child wallet payments
        if (account_type === 'child') {
          const getFamilyUrl = `${supabaseUrl}/rest/v1/family_members?id=eq.${user_id}&select=*`;
          const getFamilyResponse = await fetch(getFamilyUrl, { headers: sbHeaders });
          const getFamilyResult = await getFamilyResponse.json();

          if (!getFamilyResponse.ok) {
            throw new Error(`Failed to fetch child account: ${getFamilyResult.message || JSON.stringify(getFamilyResult)}`);
          }

          if (Array.isArray(getFamilyResult) && getFamilyResult.length > 0) {
            const childAccount = getFamilyResult[0];
            const newBalance = Number(childAccount.available_balance || 0) + amount;
            const updateFamilyUrl = `${supabaseUrl}/rest/v1/family_members?id=eq.${user_id}`;
            const updateFamilyResponse = await fetch(updateFamilyUrl, {
              method: 'PATCH',
              headers: sbHeaders,
              body: JSON.stringify({ available_balance: newBalance, updated_at: new Date().toISOString() })
            });
            if (!updateFamilyResponse.ok && updateFamilyResponse.status !== 204) {
              const updateFamilyResult = await updateFamilyResponse.json();
              throw new Error(`Failed to update child wallet: ${updateFamilyResult.message || JSON.stringify(updateFamilyResult)}`);
            }
          } else {
            throw new Error('Child account not found');
          }
        } else {
          // Handle parent wallet payments
          const getWalletUrl = `${supabaseUrl}/rest/v1/wallets?user_id=eq.${user_id}&select=*`;
          const getResponse = await fetch(getWalletUrl, { headers: sbHeaders });
          const getResult = await getResponse.json();

          if (!getResponse.ok) {
            throw new Error(`Failed to fetch wallet: ${getResult.message || JSON.stringify(getResult)}`);
          }

          if (Array.isArray(getResult) && getResult.length > 0) {
            const wallet = getResult[0];
            const newBalance = Number(wallet.balance) + amount;
            const updateUrl = `${supabaseUrl}/rest/v1/wallets?id=eq.${wallet.id}`;
            const updateResponse = await fetch(updateUrl, {
              method: 'PATCH',
              headers: sbHeaders,
              body: JSON.stringify({ balance: newBalance, updated_at: new Date().toISOString() })
            });
            if (!updateResponse.ok && updateResponse.status !== 204) {
              const updateResult = await updateResponse.json();
              throw new Error(`Failed to update wallet: ${updateResult.message || JSON.stringify(updateResult)}`);
            }

            // Record transaction
            const txUrl = `${supabaseUrl}/rest/v1/wallet_transactions`;
            await fetch(txUrl, {
              method: 'POST',
              headers: sbHeaders,
              body: JSON.stringify({
                wallet_id: wallet.id,
                user_id,
                amount,
                transaction_type: 'manual',
                reference: null,
                created_at: new Date().toISOString()
              })
            });
          } else {
            const insertUrl = `${supabaseUrl}/rest/v1/wallets`;
            const insertResponse = await fetch(insertUrl, {
              method: 'POST',
              headers: sbHeaders,
              body: JSON.stringify({
                user_id,
                balance: amount,
                currency: 'ZAR',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
              })
            });
            if (!insertResponse.ok) {
              const insertResult = await insertResponse.json();
              throw new Error(`Failed to create wallet: ${insertResult.message || JSON.stringify(insertResult)}`);
            }

            // Get the newly created wallet and record transaction
            const newWalletRes = await fetch(`${supabaseUrl}/rest/v1/wallets?user_id=eq.${user_id}&select=id`, { headers: sbHeaders });
            const newWallets = await newWalletRes.json();
            if (Array.isArray(newWallets) && newWallets.length > 0) {
              const txUrl = `${supabaseUrl}/rest/v1/wallet_transactions`;
              await fetch(txUrl, {
                method: 'POST',
                headers: sbHeaders,
                body: JSON.stringify({
                  wallet_id: newWallets[0].id,
                  user_id,
                  amount,
                  transaction_type: 'manual',
                  reference: null,
                  created_at: new Date().toISOString()
                })
              });
            }
          }
        }

        sendJson(res, 200, { ok: true, message: 'Wallet updated successfully' });
      } catch (error) {
        sendJson(res, 500, {
          error: 'Could not add to wallet',
          details: error?.message || 'Unknown error'
        });
      }
    })();

    return;
  }

  if (req.url.startsWith('/api/upload-wallet-payments') && req.method === 'POST') {
    const token = parseBearerToken(req.headers.authorization);
    if (!token) {
      sendJson(res, 401, { error: 'Missing Authorization bearer token' });
      return;
    }

    (async () => {
      try {
        await fetchSupabaseJson('/auth/v1/user', token, false);
        const body = await readJsonBody(req);
        const { payments } = body;

        if (!Array.isArray(payments) || payments.length === 0) {
          sendJson(res, 400, { error: 'No payments provided' });
          return;
        }

        if (!supabaseUrl || !supabaseServiceRoleKey) {
          sendJson(res, 500, { error: 'Supabase not configured' });
          return;
        }

        const sbHeaders = {
          apikey: supabaseServiceRoleKey,
          Authorization: `Bearer ${supabaseServiceRoleKey}`,
          'Content-Type': 'application/json'
        };

        let successCount = 0;
        for (const payment of payments) {
          const { userId, amount, reference } = payment;

          // Get wallet
          const getWalletUrl = `${supabaseUrl}/rest/v1/wallets?user_id=eq.${userId}&select=id,balance`;
          const getResponse = await fetch(getWalletUrl, { headers: sbHeaders });
          const wallets = await getResponse.json();

          if (!getResponse.ok || !Array.isArray(wallets) || wallets.length === 0) {
            continue;
          }

          const wallet = wallets[0];
          const newBalance = Number(wallet.balance) + amount;

          // Update wallet
          const updateUrl = `${supabaseUrl}/rest/v1/wallets?id=eq.${wallet.id}`;
          await fetch(updateUrl, {
            method: 'PATCH',
            headers: sbHeaders,
            body: JSON.stringify({ balance: newBalance, updated_at: new Date().toISOString() })
          });

          // Record transaction
          const txUrl = `${supabaseUrl}/rest/v1/wallet_transactions`;
          await fetch(txUrl, {
            method: 'POST',
            headers: sbHeaders,
            body: JSON.stringify({
              wallet_id: wallet.id,
              user_id: userId,
              amount,
              transaction_type: 'csv_upload',
              reference: reference || null,
              created_at: new Date().toISOString()
            })
          });

          successCount++;
        }

        sendJson(res, 200, { ok: true, message: `Successfully uploaded ${successCount} payments` });
      } catch (error) {
        sendJson(res, 500, {
          error: 'Could not upload payments',
          details: error?.message || 'Unknown error'
        });
      }
    })();

    return;
  }

  if (req.url.startsWith('/api/send-eft-email') && req.method === 'POST') {
    const token = parseBearerToken(req.headers.authorization);
    if (!token) {
      sendJson(res, 401, { error: 'Missing Authorization bearer token' });
      return;
    }

    (async () => {
      try {
        await fetchSupabaseJson('/auth/v1/user', token, false);
        const body = await readJsonBody(req);
        const { to, subject, html, walletId } = body;

        if (!to || !html) {
          sendJson(res, 400, { error: 'Missing to or html payload' });
          return;
        }

        if (!resendApiKey || !orderbookEmailFrom) {
          sendJson(res, 500, { error: 'Email service not configured. Set RESEND_API_KEY and ORDERBOOK_EMAIL_FROM' });
          return;
        }

        const attachments = [];
        try {
          const bannerPath = path.join(publicDir, 'images', 'Mailer Funds put.avif');
          if (fs.existsSync(bannerPath)) {
            attachments.push({
              filename: 'banner.avif',
              content: fs.readFileSync(bannerPath).toString('base64'),
              cid: 'banner'
            });
          }
          const logoPath = path.join(publicDir, 'icon.png');
          if (fs.existsSync(logoPath)) {
            attachments.push({
              filename: 'logo.png',
              content: fs.readFileSync(logoPath).toString('base64'),
              cid: 'logo'
            });
          }
        } catch (e) {
          console.error('[EFT Email] Error reading attachments:', e);
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
            html: html,
            attachments: attachments
          })
        });

        let payload = null;
        try { payload = await response.json(); } catch { payload = null; }

        if (!response.ok) {
          const message = payload?.message || payload?.error || `Resend request failed with ${response.status}`;
          throw new Error(message);
        }

        if (walletId) {
          const sbHeaders = {
            apikey: supabaseServiceRoleKey,
            Authorization: `Bearer ${supabaseServiceRoleKey}`,
            'Content-Type': 'application/json'
          };
          await fetch(`${supabaseUrl}/rest/v1/wallets?id=eq.${encodeURIComponent(walletId)}`, {
            method: 'PATCH',
            headers: sbHeaders,
            body: JSON.stringify({ mailer: 'sent' })
          });
        }

        sendJson(res, 200, { ok: true, message: 'Email sent successfully' });
      } catch (error) {
        sendJson(res, 500, {
          error: 'Could not send EFT email',
          details: error?.message || 'Unknown error'
        });
      }
    })();
    return;
  }

  // Investor data endpoint — uses service role key to bypass RLS
  if (req.url === '/api/investors/data' && req.method === 'GET') {
    (async () => {
      try {
        if (!supabaseUrl || !supabaseServiceRoleKey) return sendJson(res, 500, { error: 'Supabase not configured' });
        const sbH = { apikey: supabaseServiceRoleKey, Authorization: `Bearer ${supabaseServiceRoleKey}`, 'Content-Type': 'application/json' };
        const sbGet = (path) => fetch(`${supabaseUrl}/rest/v1/${path}`, { headers: sbH }).then(r => r.json());

        const [holdings, strategies] = await Promise.all([
          sbGet('stock_holdings_c?select=user_id,security_id,strategy_id,quantity,avg_fill,market_value,created_at&is_active=eq.true&trade_side=eq.BUY'),
          sbGet('strategies_c?select=id,name,short_name,description,risk_level,sector'),
        ]);

        const userIds = [...new Set((holdings || []).map(r => r.user_id).filter(Boolean))];
        const secIds = [...new Set((holdings || []).map(r => r.security_id).filter(Boolean))];
        /* Fetch per-investor NAV history from client_strategy_returns_c — keyed by user_id */
        const stratHistArrays = userIds.length
          ? await Promise.all(userIds.map(uid =>
            sbGet(`client_strategy_returns_c?select=user_id,strategy_id,as_of_date,basket_value,1d_pct,5d_pct,1m_pct,6m_pct,ytd_pct,1y_pct,5y_pct,inception_pct,inception_pnl&user_id=eq.${uid}&order=as_of_date.asc`)
          ))
          : [];
        const stratHist = stratHistArrays.flat();

        /* Recalculate inception_pnl and inception_pct on the LATEST row per user only
           (fixes avg_fill unit mismatches for the investor card without distorting chart history) */
        const investedByUser = {};
        (holdings || []).forEach(h => {
          const uid = h.user_id;
          const cost = Number(h.avg_fill) * Number(h.quantity);
          if (uid && cost > 0) investedByUser[uid] = (investedByUser[uid] || 0) + cost;
        });
        /* Find the latest row per user (stratHist is ordered asc, so last entry is latest) */
        const latestRowByUser = {};
        stratHist.forEach(r => { latestRowByUser[r.user_id] = r; });
        Object.values(latestRowByUser).forEach(r => {
          const invested = investedByUser[r.user_id];
          if (invested > 0) {
            r.inception_pnl = r.basket_value - invested;
            r.inception_pct = (r.inception_pnl / invested) * 100;
          }
        });

        const [profiles, secMeta, secLive, txns] = await Promise.all([
          userIds.length ? sbGet(`profiles?select=id,first_name,last_name,email,mint_number&id=in.(${userIds.join(',')})`) : Promise.resolve([]),
          secIds.length ? sbGet(`securities_c?select=id,symbol,name,sector,logo_url&id=in.(${secIds.join(',')})`) : Promise.resolve([]),
          secIds.length ? sbGet(`stock_returns_c?select=security_id,symbol,current_price,1d_pct,ytd_pct,1y_pct,as_of_date&security_id=in.(${secIds.join(',')})&order=as_of_date.desc`) : Promise.resolve([]),
          userIds.length ? sbGet(`transactions?select=user_id,amount,direction,name,description,status,transaction_date&user_id=in.(${userIds.join(',')})&order=transaction_date.desc`) : Promise.resolve([]),
        ]);

        sendJson(res, 200, { holdings, strategies, stratHist, profiles, secMeta, secLive, txns });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
    })();
    return;
  }

  // Team management routes
  if (req.url.startsWith('/api/team')) {
    (async () => {
      try {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          req.body = await readJsonBody(req).catch(() => ({}));
        }
        await teamHandler(req, res);
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { error: err.message });
        }
      }
    })();
    return;
  }

  const urlWithoutQuery = req.url.split('?')[0];
  const requestPath = urlWithoutQuery === '/' ? '/dashboard.html' : urlWithoutQuery;
  const safePath = path.normalize(requestPath).replace(/^([/\\])+/, '');
  const filePath = path.join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal Server Error');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    const cacheControl = ext === '.html'
      ? 'no-cache, no-store, must-revalidate'
      : 'public, max-age=86400';
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': cacheControl });
    res.end(data);
  });
});

process.on('SIGTERM', () => {
  console.log('[Process] SIGTERM received — closing server gracefully...');
  server.close(() => {
    console.log('[Process] Server closed, exiting cleanly.');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});

process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught exception:', err?.message || err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled promise rejection:', reason?.message || reason);
});

const startServer = (portToUse) => {
  server.listen(portToUse, () => {
    console.log(`Server running at http://localhost:${portToUse}`);
    if (orderbookEnableIntervalScheduler) {
      startDailyOrderbookScheduler();
    }
    startMarketDataScheduler();
  });
};

let _startRetries = 0;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && _startRetries < 5) {
    _startRetries++;
    console.error(`[Server] Port ${port} in use — retry ${_startRetries}/5 in 2s...`);
    setTimeout(() => startServer(port), 2000);
  } else {
    console.error('[Server] HTTP server error:', err?.message || err);
    process.exit(1);
  }
});

startServer(port);
