const sendJson = (res, statusCode, body) => {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
};

const requestSupabaseJson = async (path, options = {}) => {
  const {
    method = 'GET',
    token = null,
    useServiceRoleAuth = true,
    body = null,
    extraHeaders = {}
  } = options;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error('Supabase server credentials are not configured');
  }

  const authToken = useServiceRoleAuth ? supabaseServiceRoleKey : token;
  if (!authToken) {
    throw new Error('Auth token missing');
  }

  const response = await fetch(`${supabaseUrl}${path}`, {
    method,
    headers: {
      'apikey': supabaseServiceRoleKey,
      'Authorization': `Bearer ${authToken}`,
      'Accept': 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...extraHeaders
    },
    ...(body ? { body: JSON.stringify(body) } : {})
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

const fetchSupabaseJson = async (path, token = null, useServiceRoleAuth = true) => {
  return requestSupabaseJson(path, {
    method: 'GET',
    token,
    useServiceRoleAuth
  });
};

const buildInFilter = (values) => values
  .map((value) => encodeURIComponent(String(value)))
  .join(',');

const loadSecuritiesByIds = async (securityIds) => {
  const rows = await fetchSupabaseJson(
    `/rest/v1/securities?select=id,name,symbol,isin&id=in.(${buildInFilter(securityIds)})`
  );
  return rows || [];
};

const buildOrderbookRows = (holdings, securitiesRows) => {
  const securitiesMap = {};
  securitiesRows.forEach((security) => {
    securitiesMap[security.id] = security;
  });

  return (holdings || []).map((row, index) => {
    const security = securitiesMap[row.security_id] || {};
    const quantityValue = Number(row.quantity);
    const isQuantityNumeric = Number.isFinite(quantityValue);
    const marketValueNumber = Number(row.market_value);
    const hasMarketValue = Number.isFinite(marketValueNumber);

    return {
      line: index + 1,
      instrumentName: security.name || '-',
      ticker: security.symbol ?? '-',
      isin: security.isin ?? '-',
      side: isQuantityNumeric ? (quantityValue < 0 ? 'SELL' : 'BUY') : '-',
      totalQuantity: isQuantityNumeric
        ? quantityValue.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 6 })
        : (row.quantity ?? '-'),
      marketValueNumber: hasMarketValue ? marketValueNumber : 0,
      marketValue: hasMarketValue
        ? `R ${marketValueNumber.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : '-',
      orderType: 'Market',
      settlementAccount: '',
      brokerRef: ''
    };
  });
};

const toOrderbookCsvContent = (rows) => {
  const normalizeCsv = (value) => {
    const base = String(value ?? '');
    return `"${base.replace(/"/g, '""')}"`;
  };

  const header = ['Line', 'Instrument Name', 'Ticker', 'ISIN', 'Side', 'Total Quantity', 'Order Type', 'Settlement Account', 'Broker Ref'];
  const csvLines = [header.map(normalizeCsv).join(',')];

  (rows || []).forEach((row) => {
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

const sendOrderbookCsvEmail = async ({ subject, csvContent, fileName, idempotencyKey }) => {
  const resendApiKey = process.env.RESEND_API_KEY;
  const orderbookEmailFrom = process.env.ORDERBOOK_EMAIL_FROM;
  const orderbookEmailTo = process.env.ORDERBOOK_EMAIL_TO;

  if (!resendApiKey || !orderbookEmailFrom || !orderbookEmailTo) {
    throw new Error('Email service not configured. Set RESEND_API_KEY, ORDERBOOK_EMAIL_FROM, ORDERBOOK_EMAIL_TO');
  }

  const recipients = String(orderbookEmailTo)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': String(idempotencyKey) } : {})
    },
    body: JSON.stringify({
      from: orderbookEmailFrom,
      to: recipients,
      subject: subject || 'Order Book CSV',
      text: 'Attached is the latest order book CSV.',
      attachments: [
        {
          filename: String(fileName || 'order-book.csv'),
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

const loadLiveOrderbookRows = async (sinceIso = null) => {
  const sinceFilter = sinceIso
    ? `&updated_at=gt.${encodeURIComponent(String(sinceIso))}`
    : '';

  const holdings = await fetchSupabaseJson(
    `/rest/v1/stock_holdings?select=id,user_id,security_id,quantity,avg_fill,market_value,unrealized_pnl,as_of_date,created_at,updated_at,%22Status%22,%22Fill_date%22,%22Exit_date%22,avg_exit,strategy_id&order=updated_at.desc${sinceFilter}`
  );

  const securityIds = [...new Set((holdings || []).map((row) => row.security_id).filter(Boolean))];
  const securitiesRows = securityIds.length ? await loadSecuritiesByIds(securityIds) : [];
  return buildOrderbookRows(holdings || [], securitiesRows || []);
};



const handleSendTradeConfirmation = async (req, res, token) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const { holdingId, bndReference, forceResend } = body;
  
  if (!holdingId) {
    return sendJson(res, 400, { error: 'Missing holdingId' });
  }

  try {
    const holdingsData = await fetchSupabaseJson(`/rest/v1/stock_holdings_c?id=eq.${encodeURIComponent(holdingId)}`, token);
    const holding = holdingsData && holdingsData[0];
    if (!holding) {
      return sendJson(res, 404, { error: 'Holding not found' });
    }

    const isBatch = !!holding.rebalance_batch_id;

    let strategyHoldings = null;
    let existingConfirms = [];

    // --- DEDUPLICATION ---
    // For strategy (batch) purchases: if ANY holding in this batch already has a sent
    // confirmation, skip — the grouped email was already sent by the first holding.
    if (isBatch && !forceResend) {
      const batchConfirms = await fetchSupabaseJson(
        `/rest/v1/investor_trade_confirmations?rebalance_batch_id=eq.${encodeURIComponent(holding.rebalance_batch_id)}&status=eq.sent&select=id&limit=1`,
        token
      );
      if (batchConfirms && batchConfirms.length > 0) {
        return sendJson(res, 200, { ok: true, skipped: true, reason: 'Batch email already sent.' });
      }
    } else if (!isBatch) {
      if (holding.strategy_id) {
        try {
          const stratHoldingsData = await fetchSupabaseJson(
            `/rest/v1/stock_holdings_c?strategy_id=eq.${encodeURIComponent(holding.strategy_id)}&user_id=eq.${encodeURIComponent(holding.user_id)}&order=Fill_date.desc&limit=50`,
            token
          );
          const fillDay = holding.Fill_date ? holding.Fill_date.substring(0, 10) : null;
          strategyHoldings = (stratHoldingsData || []).filter(h =>
            !fillDay || (h.Fill_date && h.Fill_date.substring(0, 10) === fillDay)
          );
        } catch (e) {
          strategyHoldings = [holding];
        }
        
        if (!forceResend) {
          const holdingIds = strategyHoldings.map(h => h.id).filter(Boolean);
          if (holdingIds.length > 0) {
            existingConfirms = await fetchSupabaseJson(
              `/rest/v1/investor_trade_confirmations?holding_id=in.(${buildInFilter(holdingIds)})&select=id,sent_at,status`,
              token
            );
            const alreadySent = existingConfirms && existingConfirms.some((r) => r.sent_at && r.status === 'sent');
            if (alreadySent) {
              return sendJson(res, 400, { error: 'Email already sent for this strategy order.' });
            }
          }
        }
      } else if (!forceResend) {
        existingConfirms = await fetchSupabaseJson(
          `/rest/v1/investor_trade_confirmations?holding_id=eq.${encodeURIComponent(holdingId)}&select=id,sent_at,status`,
          token
        );
        const alreadySent = existingConfirms && existingConfirms.some((r) => r.sent_at && r.status === 'sent');
        if (alreadySent) {
          return sendJson(res, 400, { error: 'Email already sent for this holding.' });
        }
      }
    }

    let profile = {};
    if (holding.user_id) {
      const profileData = await fetchSupabaseJson(`/rest/v1/profiles?id=eq.${encodeURIComponent(holding.user_id)}`, token);
      if (profileData && profileData.length) profile = profileData[0];
    }

    let clientEmail = profile.email;
    if (!clientEmail) {
      return sendJson(res, 400, { error: 'Client email not found' });
    }

    const resendApiKey = process.env.RESEND_API_KEY;
    const orderbookEmailFrom = process.env.ORDERBOOK_EMAIL_FROM;

    const DASHBOARD_URL = 'https://app.mymint.co.za';
    const currentDateStr = new Date().toLocaleDateString('en-ZA', { year: 'numeric', month: 'long', day: 'numeric' });

    const buildTradeRow = ({ side, assetName, quantityDisplay, totalAmountStr, ref }) => {
      const isSell = side === 'SELL';
      const badgeColor = isSell ? '#dc2626' : '#059669';
      const badgeBg = isSell ? '#fef2f2' : '#f0fdf4';
      const badgeLabel = isSell ? 'SELL' : 'BUY';
      return `
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin-bottom:12px;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
          <tr>
            <td style="padding:16px 20px;background:#f8fafc;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td style="font-size:13px;font-weight:700;color:#0f172a;">${assetName}</td>
                  <td style="text-align:right;">
                    <span style="display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:0.05em;color:${badgeColor};background:${badgeBg};">${badgeLabel}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:0 20px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td style="padding:12px 0;border-bottom:1px solid #f1f5f9;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:#94a3b8;">Total Amount</td>
                  <td style="padding:12px 0;border-bottom:1px solid #f1f5f9;font-size:15px;font-weight:800;color:#0f172a;text-align:right;">${totalAmountStr}</td>
                </tr>
                <tr>
                  <td style="padding:12px 0;border-bottom:1px solid #f1f5f9;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:#94a3b8;">Quantity</td>
                  <td style="padding:12px 0;border-bottom:1px solid #f1f5f9;font-size:13px;font-weight:600;color:#1e293b;text-align:right;">${quantityDisplay} shares</td>
                </tr>
                <tr>
                  <td style="padding:12px 0;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:#94a3b8;">Reference</td>
                  <td style="padding:12px 0;font-size:12px;font-weight:700;color:#7c3aed;text-align:right;font-family:monospace,monospace;">${ref}</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      `;
    };

    const buildEmailHtml = ({ firstName, mintRef, orderDate, tableRowsHtml, subjectHeading, subjectIntro }) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light only">
  <title>${subjectHeading}</title>
</head>
<body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <span style="display:none!important;visibility:hidden;mso-hide:all;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${subjectIntro.replace(/<[^>]+>/g, '')}</span>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#ffffff" style="background:#ffffff;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 8px 32px rgba(15,23,42,0.07);">

          <!-- Header Image -->
          <tr>
            <td style="padding:0;">
              <img src="https://cdn.jsdelivr.net/gh/MufaroAlgohive/MyMintAdmin@main/public/images/email-header.jpg" alt="Mint Investment Platform" width="600" style="width:100%;max-width:600px;height:auto;display:block;border-radius:18px 18px 0 0;" />
            </td>
          </tr>
          <!-- Subject Heading -->
          <tr>
            <td style="padding:32px 36px 0 36px;">
              <h1 style="margin:0;color:#0f172a;font-size:26px;line-height:1.2;font-weight:800;letter-spacing:-0.5px;">${subjectHeading}</h1>
            </td>
          </tr>

          <!-- Greeting -->
          <tr>
            <td style="padding:32px 36px 0 36px;">
              <p style="margin:0 0 8px 0;font-size:16px;color:#1e293b;font-weight:600;">Hi ${firstName},</p>
              <p style="margin:0;font-size:14px;color:#475569;line-height:1.6;">${subjectIntro}</p>
            </td>
          </tr>

          <!-- Reference banner -->
          <tr>
            <td style="padding:24px 36px 0 36px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#faf7ff;border:1px solid #ede5ff;border-radius:12px;">
                <tr>
                  <td style="padding:16px 20px;text-align:center;border-right:1px solid #ede5ff;width:50%;">
                    <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#7c3aed;margin-bottom:4px;">Reference</div>
                    <div style="font-size:13px;font-weight:700;color:#0f172a;font-family:monospace,monospace;">${mintRef}</div>
                  </td>
                  <td style="padding:16px 20px;text-align:center;width:50%;">
                    <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#7c3aed;margin-bottom:4px;">Order Date</div>
                    <div style="font-size:13px;font-weight:700;color:#0f172a;">${orderDate}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Trade rows -->
          <tr>
            <td style="padding:20px 36px 0 36px;">
              ${tableRowsHtml}
            </td>
          </tr>

          <!-- CTA -->
          <tr>
            <td style="padding:28px 36px 36px 36px;text-align:center;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center">
                <tr>
                  <td style="border-radius:999px;background:#5c3bcf;box-shadow:0 4px 14px rgba(92,59,207,0.3);">
                    <a href="${DASHBOARD_URL}" target="_blank" style="display:inline-block;padding:14px 36px;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:999px;letter-spacing:0.2px;">View Portfolio</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:24px 36px 32px 36px;border-top:1px solid #f0f0f3;">
              <p style="margin:0 0 12px 0;font-size:10px;color:#94a3b8;line-height:1.6;text-align:justify;">MINT Platforms (Pty) Ltd is an authorised Financial Services Provider (FSP 55118) regulated by the Financial Sector Conduct Authority and a registered Credit Provider (NCRCP22892) under the National Credit Act. All investment activity carries risk, including the possible loss of capital and liquidity constraints. Any information provided here is educational in nature, does not constitute personalised financial advice, and should not be relied on as a recommendation to buy or sell securities.</p>
              <p style="margin:0;font-size:10px;color:#94a3b8;">&copy; ${new Date().getFullYear()} MINT. All rights reserved. &middot; ${currentDateStr} &middot; <a href="https://www.mymint.co.za" style="color:#94a3b8;text-decoration:underline;">mymint.co.za</a></p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    const firstName = profile.first_name || 'Investor';
    let subject = 'Trade Confirmation — MINT';
    let htmlContent = '';

    if (!isBatch) {
      let security = {};
      if (holding.security_id) {
        const secData = await fetchSupabaseJson(`/rest/v1/securities_c?id=eq.${encodeURIComponent(holding.security_id)}`, token);
        if (secData && secData.length) security = secData[0];
      }

      let strategyName = 'Mint';
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
      const execDate = holding.Fill_date
        ? new Date(holding.Fill_date).toLocaleDateString('en-ZA', { year: 'numeric', month: 'long', day: 'numeric' })
        : currentDateStr;

      const isStrategy = !!holding.strategy_id;
      const quantityDisplay = Number(quantity).toLocaleString('en-ZA', { minimumFractionDigits: 0, maximumFractionDigits: 4 });
      const totalAmountValue = (quantity * (holding.avg_fill || 0)) / 100;
      const totalAmountStr = `R ${totalAmountValue.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

      if (isStrategy) {
        let tableRowsHtml = '';
        const groupedStrategyHoldings = {};
        for (const h of (strategyHoldings || [holding])) {
          const side = h.trade_side || (h.quantity < 0 ? 'SELL' : 'BUY');
          const key = `${h.security_id}_${side}`;
          if (!groupedStrategyHoldings[key]) {
            groupedStrategyHoldings[key] = {
              security_id: h.security_id,
              trade_side: side,
              total_quantity: Math.abs(h.quantity),
              total_value: (Math.abs(h.quantity) * (h.avg_fill || 0)) / 100,
              ref: h.id === holding.id && bndReference ? bndReference : `BND-${h.id.substring(0, 8).toUpperCase()}`
            };
          } else {
            groupedStrategyHoldings[key].total_quantity += Math.abs(h.quantity);
            groupedStrategyHoldings[key].total_value += (Math.abs(h.quantity) * (h.avg_fill || 0)) / 100;
          }
        }

        for (const sHolding of Object.values(groupedStrategyHoldings)) {
          let sSecurity = {};
          if (sHolding.security_id) {
            const secData = await fetchSupabaseJson(`/rest/v1/securities_c?id=eq.${encodeURIComponent(sHolding.security_id)}`, token);
            if (secData && secData.length) sSecurity = secData[0];
          }
          const sTicker = sSecurity.symbol || '-';
          const sSide = sHolding.trade_side;
          const sQtyDisplay = Number(sHolding.total_quantity).toLocaleString('en-ZA', { minimumFractionDigits: 0, maximumFractionDigits: 4 });
          const sTotalStr = `R ${sHolding.total_value.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
          
          if (tableRowsHtml !== '') {
            tableRowsHtml += `<tr><td colspan="2" style="height:20px;border-bottom:1px solid #e2e8f0;background:#f8fafc;"></td></tr>`;
          }
          tableRowsHtml += buildTradeRow({ side: sSide, assetName: sSecurity.name || sTicker, quantityDisplay: sQtyDisplay, totalAmountStr: sTotalStr, ref: sHolding.ref });
        }

        subject = 'Basket Purchased — MINT';
        htmlContent = buildEmailHtml({
          firstName,
          mintRef: ref,
          orderDate: execDate,
          tableRowsHtml,
          subjectHeading: 'Basket Purchased.',
          subjectIntro: `Welcome to intentional investing. <br/><br/>Your <strong>${strategyName}</strong> is built and MINT's engine is now actively managing it for you. Here is what we executed:`
        });
      } else {
        htmlContent = buildEmailHtml({
          firstName,
          mintRef: ref,
          orderDate: execDate,
          tableRowsHtml: buildTradeRow({ side, assetName: security.name || ticker, quantityDisplay, totalAmountStr, ref }),
          subjectHeading: 'Asset Purchased.',
          subjectIntro: `You have successfully purchased a single asset. Your trade for <strong>${security.name || ticker}</strong> has been successfully filled.`
        });
      }

    } else {
      subject = 'Portfolio Realignment — MINT';
      const batchHoldings = await fetchSupabaseJson(
        `/rest/v1/stock_holdings_c?rebalance_batch_id=eq.${encodeURIComponent(holding.rebalance_batch_id)}&user_id=eq.${encodeURIComponent(holding.user_id)}`,
        token
      );

      const strategyName = holding.strategy_name_snapshot || 'Mint';
      const batchRef = `BND-${holding.rebalance_batch_id.substring(0, 8).toUpperCase()}`;
      const batchDate = holding.Fill_date
        ? new Date(holding.Fill_date).toLocaleDateString('en-ZA', { year: 'numeric', month: 'long', day: 'numeric' })
        : currentDateStr;

      let tableRowsHtml = '';
      const groupedBatchHoldings = {};
      for (const h of batchHoldings) {
        const side = h.trade_side || (h.quantity < 0 ? 'SELL' : 'BUY');
        const key = `${h.security_id}_${side}`;
        if (!groupedBatchHoldings[key]) {
          groupedBatchHoldings[key] = {
            security_id: h.security_id,
            trade_side: side,
            total_quantity: Math.abs(h.quantity),
            total_value: (Math.abs(h.quantity) * (h.avg_fill || 0)) / 100,
            ref: `BND-${h.id.substring(0, 8).toUpperCase()}`
          };
        } else {
          groupedBatchHoldings[key].total_quantity += Math.abs(h.quantity);
          groupedBatchHoldings[key].total_value += (Math.abs(h.quantity) * (h.avg_fill || 0)) / 100;
        }
      }

      for (const bHolding of Object.values(groupedBatchHoldings)) {
        let security = {};
        if (bHolding.security_id) {
          const secData = await fetchSupabaseJson(`/rest/v1/securities_c?id=eq.${encodeURIComponent(bHolding.security_id)}`, token);
          if (secData && secData.length) security = secData[0];
        }
        const ticker = security.symbol || '-';
        const side = bHolding.trade_side;
        const quantityDisplay = Number(bHolding.total_quantity).toLocaleString('en-ZA', { minimumFractionDigits: 0, maximumFractionDigits: 4 });
        const totalAmountStr = `R ${bHolding.total_value.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        
        if (tableRowsHtml !== '') {
          tableRowsHtml += `<tr><td colspan="2" style="height:20px;border-bottom:1px solid #e2e8f0;background:#f8fafc;"></td></tr>`;
        }
        tableRowsHtml += buildTradeRow({ side, assetName: security.name || ticker, quantityDisplay, totalAmountStr, ref: bHolding.ref });
      }

      htmlContent = buildEmailHtml({
        firstName,
        mintRef: batchRef,
        orderDate: batchDate,
        tableRowsHtml,
        subjectHeading: 'Portfolio Realigned.',
        subjectIntro: `Your <strong>${strategyName}</strong> portfolio has been successfully realigned. The following trades were executed to match the target strategy:`
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

    const resendPayload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(resendPayload.message || resendPayload.error || `Resend error: ${response.status}`);
    }

    const resendId = resendPayload?.id || null;
    const nowIso = new Date().toISOString();

    if (isBatch) {
      const ref = `BND-${holding.rebalance_batch_id.substring(0, 8).toUpperCase()}`;
      const confirmRecord = {
        user_id: holding.user_id,
        holding_id: null,
        rebalance_batch_id: holding.rebalance_batch_id,
        reference_number: ref,
        recipient_email: clientEmail,
        status: 'sent',
        resend_id: resendId,
        executed_price_cents: holding.avg_fill || null,
        quantity_filled: holding.quantity ? Math.abs(holding.quantity) : null,
        strategy_name_at_execution: holding.strategy_name_snapshot || null,
        sent_payload: { batch_id: holding.rebalance_batch_id },
        sent_at: nowIso
      };
      await requestSupabaseJson('/rest/v1/investor_trade_confirmations', { method: 'POST', token, body: confirmRecord }).catch(() => {});
    } else if (strategyHoldings && strategyHoldings.length > 0) {
      for (const sHolding of strategyHoldings) {
        const sRef = sHolding.id === holdingId && bndReference ? bndReference : `BND-${sHolding.id.substring(0, 8).toUpperCase()}`;
        const confirmRecord = {
          user_id: holding.user_id,
          holding_id: sHolding.id,
          rebalance_batch_id: null,
          reference_number: sRef,
          recipient_email: clientEmail,
          status: 'sent',
          resend_id: resendId,
          executed_price_cents: sHolding.avg_fill || null,
          quantity_filled: sHolding.quantity ? Math.abs(sHolding.quantity) : null,
          strategy_name_at_execution: sHolding.strategy_name_snapshot || null,
          sent_payload: { holding_id: sHolding.id, grouped_with: holdingId },
          sent_at: nowIso
        };
        await requestSupabaseJson('/rest/v1/investor_trade_confirmations', { method: 'POST', token, body: confirmRecord }).catch(async () => {
          if (sHolding.id === holdingId && existingConfirms && existingConfirms[0]?.id) {
            await requestSupabaseJson(`/rest/v1/investor_trade_confirmations?id=eq.${encodeURIComponent(existingConfirms[0].id)}`, { method: 'PATCH', token, body: { status: 'sent', sent_at: nowIso, resend_id: resendId } });
          }
        });
      }
    } else {
      const ref = bndReference || `BND-${holding.id.substring(0, 8).toUpperCase()}`;
      const confirmRecord = {
        user_id: holding.user_id,
        holding_id: holdingId,
        rebalance_batch_id: null,
        reference_number: ref,
        recipient_email: clientEmail,
        status: 'sent',
        resend_id: resendId,
        executed_price_cents: holding.avg_fill || null,
        quantity_filled: holding.quantity ? Math.abs(holding.quantity) : null,
        strategy_name_at_execution: holding.strategy_name_snapshot || null,
        sent_payload: { holding_id: holdingId },
        sent_at: nowIso
      };
      await requestSupabaseJson('/rest/v1/investor_trade_confirmations', { method: 'POST', token, body: confirmRecord }).catch(async () => {
        const existingId = existingConfirms && existingConfirms[0]?.id;
        if (existingId) {
          await requestSupabaseJson(`/rest/v1/investor_trade_confirmations?id=eq.${encodeURIComponent(existingId)}`, { method: 'PATCH', token, body: { status: 'sent', sent_at: nowIso, resend_id: resendId } });
        }
      });
    }

    return sendJson(res, 200, { ok: true });
  } catch (error) {
    console.error('send-trade-confirmation error', error);
    return sendJson(res, 500, {
      error: 'Could not send trade confirmation',
      details: error?.message || 'Unknown error'
    });
  }
};
module.exports = { sendJson, requestSupabaseJson, fetchSupabaseJson, buildInFilter, toOrderbookCsvContent, sendOrderbookCsvEmail, loadLiveOrderbookRows, handleSendTradeConfirmation };
