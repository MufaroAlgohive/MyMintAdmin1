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
    const existingConfirms = await fetchSupabaseJson(
      `/rest/v1/investor_trade_confirmations?holding_id=eq.${encodeURIComponent(holdingId)}&select=id,sent_at,status`,
      token
    );
    const alreadySent = existingConfirms && existingConfirms.some((r) => r.sent_at && r.status === 'sent');
    if (alreadySent && !forceResend) {
      return sendJson(res, 400, { error: 'Email already sent for this holding.' });
    }

    const holdingsData = await fetchSupabaseJson(`/rest/v1/stock_holdings_c?id=eq.${encodeURIComponent(holdingId)}`, token);
    const holding = holdingsData && holdingsData[0];
    if (!holding) {
      return sendJson(res, 404, { error: 'Holding not found' });
    }

    const isBatch = !!holding.rebalance_batch_id;

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

    const HEADER_IMAGE_URL = 'https://my-mint-admin.vercel.app/images/OrderBookMail.avif';
    const DASHBOARD_URL = 'https://app.mymint.co.za';
    const currentDateStr = new Date().toLocaleDateString('en-ZA', { year: 'numeric', month: 'long', day: 'numeric' });

    const buildTradeRow = ({ side, assetName, quantityDisplay, totalAmountStr, ref }) => {
      const orderType = side === 'SELL' ? 'Stock Sale' : 'Stock Purchase';
      const sideAccent = side === 'SELL' ? '#dc2626' : '#059669';
      const sideBg = side === 'SELL' ? '#fff5f5' : '#f0fdf4';
      return `
        <tr style="background:#f8fafc;">
          <td style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.07em;color:#64748b;border-bottom:1px solid #e2e8f0;font-weight:700;">Order Type</td>
          <td style="padding:12px 16px;font-size:13px;color:${sideAccent};font-weight:700;text-align:right;border-bottom:1px solid #e2e8f0;background:${sideBg};">${orderType}</td>
        </tr>
        <tr>
          <td style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.07em;color:#64748b;border-bottom:1px solid #e2e8f0;font-weight:700;">Funding Source</td>
          <td style="padding:12px 16px;font-size:13px;color:#1e293b;font-weight:600;text-align:right;border-bottom:1px solid #e2e8f0;">Wallet</td>
        </tr>
        <tr style="background:#f8fafc;">
          <td style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.07em;color:#64748b;border-bottom:1px solid #e2e8f0;font-weight:700;">Portfolio Asset</td>
          <td style="padding:12px 16px;font-size:13px;color:#1e293b;font-weight:600;text-align:right;border-bottom:1px solid #e2e8f0;">${assetName}</td>
        </tr>
        <tr>
          <td style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.07em;color:#64748b;border-bottom:1px solid #e2e8f0;font-weight:700;">Total Amount</td>
          <td style="padding:12px 16px;font-size:14px;color:#0f172a;font-weight:800;text-align:right;border-bottom:1px solid #e2e8f0;">${totalAmountStr}</td>
        </tr>
        <tr style="background:#f8fafc;">
          <td style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.07em;color:#64748b;border-bottom:1px solid #e2e8f0;font-weight:700;">Quantity</td>
          <td style="padding:12px 16px;font-size:13px;color:#1e293b;font-weight:600;text-align:right;border-bottom:1px solid #e2e8f0;">${quantityDisplay} shares</td>
        </tr>
        <tr>
          <td style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.07em;color:#64748b;border-bottom:1px solid #e2e8f0;font-weight:700;">Reference</td>
          <td style="padding:12px 16px;font-size:13px;color:#7c3aed;font-weight:700;text-align:right;border-bottom:1px solid #e2e8f0;font-family:monospace;">${ref}</td>
        </tr>
        <tr style="background:#fffbeb;">
          <td style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.07em;color:#64748b;border-bottom:1px solid #e2e8f0;font-weight:700;">Status</td>
          <td style="padding:12px 16px;font-size:13px;color:#d97706;font-weight:700;text-align:right;border-bottom:1px solid #e2e8f0;">Pending Settlement</td>
        </tr>
      `;
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
      <img src="${HEADER_IMAGE_URL}" width="600" alt="Mint Order Executed" style="display:block;width:100%;height:auto;border:0;">
      <div style="padding:40px;">
        <h1 style="font-size:28px;font-weight:800;color:#1e293b;margin-top:0;margin-bottom:16px;letter-spacing:-0.02em;">${subjectHeading}</h1>
        <p style="font-size:16px;color:#475569;margin-bottom:8px;">Hello <strong>${firstName}</strong>,</p>
        <p style="font-size:16px;color:#475569;margin-bottom:24px;">${subjectIntro}</p>
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
        <table style="width:100%;border-collapse:collapse;margin-bottom:30px;">
          <tbody>
            ${tableRowsHtml}
          </tbody>
        </table>
        <div style="text-align:center;margin:30px 0;">
          <a href="${DASHBOARD_URL}" style="background-color:#7c3aed;color:#ffffff;padding:14px 32px;border-radius:999px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block;">View Portfolio</a>
        </div>
      </div>
      <div style="padding:40px;background-color:#f8fafc;font-size:11px;color:#94a3b8;line-height:1.5;">
        <p style="font-size:11px;margin-bottom:12px;">MINT (Pty) Ltd is an authorised Financial Services Provider (FSP 55118) regulated by the Financial Sector Conduct Authority and a registered Credit Provider (NCRCP22892) under the National Credit Act. All investment activity carries risk, including the possible loss of capital and liquidity constraints. Any information provided here is educational in nature, does not constitute personalised financial advice, and should not be relied on as a recommendation to buy or sell securities. Please consider whether investing is appropriate for your circumstances and consult an independent adviser where necessary.</p>
        <p style="font-size:11px;margin-bottom:0;">&copy; 2026 MINT. All rights reserved.<br>Date: ${currentDateStr}</p>
      </div>
    </div>
  </div>
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
      const execDate = holding.fill_date
        ? new Date(holding.fill_date).toLocaleDateString('en-ZA', { year: 'numeric', month: 'long', day: 'numeric' })
        : currentDateStr;

      const quantityDisplay = Number(quantity).toLocaleString('en-ZA', { minimumFractionDigits: 0, maximumFractionDigits: 4 });
      const totalAmountValue = (quantity * (holding.avg_fill || 0)) / 100;
      const totalAmountStr = `R ${totalAmountValue.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

      htmlContent = buildEmailHtml({
        firstName,
        mintRef: ref,
        orderDate: execDate,
        tableRowsHtml: buildTradeRow({ side, assetName: security.name || ticker, quantityDisplay, totalAmountStr, ref }),
        subjectHeading: 'Order Executed.',
        subjectIntro: `Your trade for <strong>${security.name || ticker}</strong> has been successfully filled and allocated to your <strong>${strategyName}</strong> portfolio.`
      });

    } else {
      subject = 'Portfolio Realignment — MINT';
      const batchHoldings = await fetchSupabaseJson(
        `/rest/v1/stock_holdings_c?rebalance_batch_id=eq.${encodeURIComponent(holding.rebalance_batch_id)}&user_id=eq.${encodeURIComponent(holding.user_id)}`,
        token
      );

      const strategyName = holding.strategy_name_snapshot || 'Mint';
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
        const quantityDisplay = Number(quantity).toLocaleString('en-ZA', { minimumFractionDigits: 0, maximumFractionDigits: 4 });
        const totalAmountValue = (quantity * (bHolding.avg_fill || 0)) / 100;
        const totalAmountStr = `R ${totalAmountValue.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        const refBatch = `BND-${bHolding.id.substring(0, 8).toUpperCase()}`;

        if (tableRowsHtml !== '') {
          tableRowsHtml += `<tr><td colspan="2" style="height:20px;border-bottom:1px solid #e2e8f0;background:#f8fafc;"></td></tr>`;
        }
        tableRowsHtml += buildTradeRow({ side, assetName: security.name || ticker, quantityDisplay, totalAmountStr, ref: refBatch });
      }

      htmlContent = buildEmailHtml({
        firstName,
        mintRef: batchRef,
        orderDate: batchDate,
        tableRowsHtml,
        subjectHeading: 'Orders Executed.',
        subjectIntro: `The realignment of your <strong>${strategyName}</strong> portfolio has been completed. The following trades were executed:`
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
    const ref = isBatch
      ? `BND-${holding.rebalance_batch_id.substring(0, 8).toUpperCase()}`
      : (bndReference || `BND-${holding.id.substring(0, 8).toUpperCase()}`);

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

    await requestSupabaseJson(
      '/rest/v1/investor_trade_confirmations',
      { method: 'POST', token, body: confirmRecord }
    ).catch(async () => {
      const existingId = existingConfirms && existingConfirms[0]?.id;
      if (existingId) {
        await requestSupabaseJson(
          `/rest/v1/investor_trade_confirmations?id=eq.${encodeURIComponent(existingId)}`,
          { method: 'PATCH', token, body: { status: 'sent', sent_at: nowIso, resend_id: resendId } }
        );
      }
    });

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
