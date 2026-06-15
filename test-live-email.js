const DASHBOARD_URL = 'https://app.mymint.co.za';

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
<body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <span style="display:none!important;visibility:hidden;mso-hide:all;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${subjectIntro.replace(/<[^>]+>/g, '')}</span>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f4f4f7" style="background:#f4f4f7;">
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
              <p style="margin:0 0 12px 0;font-size:10px;color:#94a3b8;line-height:1.6;text-align:justify;">MINT (Pty) Ltd is an authorised Financial Services Provider (FSP 55118) regulated by the Financial Sector Conduct Authority and a registered Credit Provider (NCRCP22892) under the National Credit Act. All investment activity carries risk, including the possible loss of capital and liquidity constraints. Any information provided here is educational in nature, does not constitute personalised financial advice, and should not be relied on as a recommendation to buy or sell securities.</p>
              <p style="margin:0;font-size:10px;color:#94a3b8;">&copy; ${new Date().getFullYear()} MINT. All rights reserved. &middot; <a href="https://www.mymint.co.za" style="color:#94a3b8;text-decoration:underline;">mymint.co.za</a></p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

const run = async () => {
  const emailTo = 'mufaroncube90@gmail.com';
  const resendApiKey = process.env.RESEND_API_KEY;
  const orderbookEmailFrom = process.env.ORDERBOOK_EMAIL_FROM || 'notifications@mymint.co.za';
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;

  if (!resendApiKey || !supabaseUrl || !supabaseKey) {
    console.error('Missing env vars');
    return;
  }

  const usersToTest = [
    '68a99359-5689-4692-b2ab-c3396704a190',
    '0f3dff04-c62b-491f-87dc-8e94edad57ee'
  ];

  for (const userId of usersToTest) {
    console.log(`\n--- Fetching live data for user ${userId} ---`);

    // Fetch profile
    const pRes = await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${userId}`, {
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` }
    });
    const profiles = await pRes.json();
    const profile = profiles && profiles[0] ? profiles[0] : { first_name: 'Investor' };
    const firstName = profile.first_name || 'Investor';

    // Fetch latest holding
    const holdRes = await fetch(`${supabaseUrl}/rest/v1/stock_holdings_c?user_id=eq.${userId}&order=Fill_date.desc&limit=1`, {
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` }
    });
    const holdings = await holdRes.json();
    if (!holdings || holdings.length === 0) {
      console.log('  No holdings found.');
      continue;
    }
    const holding = holdings[0];
    const isStrategy = !!holding.strategy_id;
    const isBatch = !!holding.rebalance_batch_id;

    const ref = isBatch 
      ? `BND-${holding.rebalance_batch_id.substring(0, 8).toUpperCase()}` 
      : `BND-${holding.id.substring(0, 8).toUpperCase()}`;

    const currentDateStr = new Date().toLocaleDateString('en-ZA', { year: 'numeric', month: 'long', day: 'numeric' });
    const execDate = holding.Fill_date
      ? new Date(holding.Fill_date).toLocaleDateString('en-ZA', { year: 'numeric', month: 'long', day: 'numeric' })
      : currentDateStr;

    let strategyName = 'Mint';
    if (holding.strategy_id) {
      const sRes = await fetch(`${supabaseUrl}/rest/v1/strategies_c?id=eq.${holding.strategy_id}`, {
        headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` }
      });
      const strats = await sRes.json();
      if (strats && strats.length) strategyName = strats[0].name;
    } else if (holding.strategy_name_snapshot) {
      strategyName = holding.strategy_name_snapshot;
    }

    let subjectHeading = '';
    let subjectIntro = '';
    let tableRowsHtml = '';

    if (isStrategy) {
      const fillDay = holding.Fill_date ? holding.Fill_date.substring(0, 10) : null;
      const shRes = await fetch(`${supabaseUrl}/rest/v1/stock_holdings_c?strategy_id=eq.${holding.strategy_id}&user_id=eq.${userId}&order=Fill_date.desc&limit=50`, {
        headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` }
      });
      const allSh = await shRes.json();
      const batchHoldings = (allSh || []).filter(h => !fillDay || (h.Fill_date && h.Fill_date.substring(0, 10) === fillDay));

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

      for (const sHolding of Object.values(groupedBatchHoldings)) {
        let assetName = '-';
        if (sHolding.security_id) {
          const secRes = await fetch(`${supabaseUrl}/rest/v1/securities_c?id=eq.${sHolding.security_id}`, {
            headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` }
          });
          const secs = await secRes.json();
          if (secs && secs.length) assetName = secs[0].name || secs[0].symbol || '-';
        }

        const sSide = sHolding.trade_side;
        const sQtyDisplay = Number(sHolding.total_quantity).toLocaleString('en-ZA', { minimumFractionDigits: 0, maximumFractionDigits: 4 });
        const sTotalStr = `R ${sHolding.total_value.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        const sRef = sHolding.ref;

        if (tableRowsHtml !== '') {
          tableRowsHtml += '<tr><td colspan="2" style="height:20px;border-bottom:1px solid #e2e8f0;background:#f8fafc;"></td></tr>';
        }
        tableRowsHtml += buildTradeRow({ side: sSide, assetName, quantityDisplay: sQtyDisplay, totalAmountStr: sTotalStr, ref: sRef });
      }

      if (isBatch) {
        subjectHeading = 'Portfolio Realigned.';
        subjectIntro = `Your <strong>${strategyName}</strong> portfolio has been successfully realigned. The following trades were executed to match the target strategy:`;
      } else {
        subjectHeading = 'Basket Purchased.';
        subjectIntro = `You have successfully purchased the <strong>${strategyName}</strong> basket. The following trades were executed to build your portfolio:`;
      }

    } else {
      let assetName = '-';
      if (holding.security_id) {
        const secRes = await fetch(`${supabaseUrl}/rest/v1/securities_c?id=eq.${holding.security_id}`, {
          headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` }
        });
        const secs = await secRes.json();
        if (secs && secs.length) assetName = secs[0].name || secs[0].symbol;
      }
      const side = holding.trade_side || (holding.quantity < 0 ? 'SELL' : 'BUY');
      const qty = Math.abs(holding.quantity);
      const qtyDisplay = Number(qty).toLocaleString('en-ZA', { minimumFractionDigits: 0, maximumFractionDigits: 4 });
      const totalVal = (qty * (holding.avg_fill || 0)) / 100;
      const totalStr = `R ${totalVal.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

      tableRowsHtml = buildTradeRow({ side, assetName, quantityDisplay: qtyDisplay, totalAmountStr: totalStr, ref });
      subjectHeading = 'Asset Purchased.';
      subjectIntro = `You have successfully purchased a single asset. Your trade for <strong>${assetName}</strong> has been successfully filled.`;
    }

    const htmlContent = buildEmailHtml({
      firstName,
      mintRef: ref,
      orderDate: execDate,
      tableRowsHtml,
      subjectHeading,
      subjectIntro
    });

    console.log(`  Sending email for ${firstName}...`);
    const subject = isStrategy ? 'Basket Purchased — MINT' : 'Trade Confirmation — MINT';

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: orderbookEmailFrom,
        to: [emailTo],
        subject,
        html: htmlContent
      })
    });

    if (response.ok) {
      console.log('  Live-data mock email sent successfully!');
    } else {
      const err = await response.json().catch(()=>({}));
      console.error('  Failed to send mock email:', err);
    }
  }
};

run();
