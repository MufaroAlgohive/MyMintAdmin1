const { sendJson, requestSupabaseJson, fetchSupabaseJson } = require('../_orderbook');

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
    const { holdingId, bndReference, forceResend } = body || {};
    
    if (!holdingId) {
      return sendJson(res, 400, { error: 'Missing holdingId' });
    }

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

        <div style="text-align:center;margin:30px 0;">
          <a href="${DASHBOARD_URL}" style="background-color:#7c3aed;color:#ffffff;padding:14px 32px;border-radius:999px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block;">View Portfolio</a>
        </div>
      </div>

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

    const firstName = profile.first_name || 'Investor';
    let subject = 'Trade Confirmation — MINT';
    let htmlContent = '';

    if (!isBatch) {
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

    sendJson(res, 200, { ok: true });
  } catch (error) {
    console.error('send-trade-confirmation error', error);
    sendJson(res, 500, {
      error: 'Could not send trade confirmation',
      details: error?.message || 'Unknown error'
    });
  }
};
