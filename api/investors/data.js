module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== 'GET') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: 'Supabase not configured' }));
  }

  try {
    const sbH = {
      apikey: supabaseServiceRoleKey,
      Authorization: `Bearer ${supabaseServiceRoleKey}`,
      'Content-Type': 'application/json',
    };
    const sbGet = (path) =>
      fetch(`${supabaseUrl}/rest/v1/${path}`, { headers: sbH }).then((r) => r.json());

    const [holdings, strategies] = await Promise.all([
      sbGet('stock_holdings_c?select=user_id,family_member_id,security_id,strategy_id,quantity,avg_fill,market_value,created_at&is_active=eq.true&trade_side=eq.BUY'),
      sbGet('strategies_c?select=id,name,short_name,description,risk_level,sector'),
    ]);

    const userIds  = [...new Set((holdings || []).map((r) => r.user_id).filter(Boolean))];
    const secIds   = [...new Set((holdings || []).map((r) => r.security_id).filter(Boolean))];
    const famIds   = [...new Set((holdings || []).map((r) => r.family_member_id).filter(Boolean))];

    /* Fetch per-investor NAV history from client_strategy_returns_c — keyed by user_id */
    const stratHistArrays = userIds.length
      ? await Promise.all(
          userIds.map((uid) =>
            sbGet(
              `client_strategy_returns_c?select=user_id,strategy_id,as_of_date,basket_value,1d_pct,5d_pct,1m_pct,6m_pct,ytd_pct,1y_pct,5y_pct,inception_pct,inception_pnl&user_id=eq.${uid}&order=as_of_date.asc`
            )
          )
        )
      : [];
    const stratHist = stratHistArrays.flat();

    /* Recalculate inception_pnl and inception_pct using avg_fill only (matches
       the orderbook's Client PnL formula). avg_fill is cents, so multiplying
       by quantity gives cents directly — basket_value is also cents. */
    const investedByUser = {};
    (holdings || []).forEach(h => {
      const uid = h.user_id;
      const cost = Number(h.avg_fill) * Number(h.quantity);
      if (uid && cost > 0) investedByUser[uid] = (investedByUser[uid] || 0) + cost;
    });
    const latestRowByUser = {};
    stratHist.forEach(r => { latestRowByUser[r.user_id] = r; });
    Object.values(latestRowByUser).forEach(r => {
      const invested = investedByUser[r.user_id];
      if (invested > 0) {
        r.inception_pnl = r.basket_value - invested;
        r.inception_pct = (r.inception_pnl / invested) * 100;
      }
    });

    const [profiles, secMeta, secReturns, secIntraday, txns, familyMembers] = await Promise.all([
      userIds.length
        ? sbGet(`profiles?select=id,first_name,last_name,email,mint_number&id=in.(${userIds.join(',')})`)
        : Promise.resolve([]),
      secIds.length
        ? sbGet(`securities_c?select=id,symbol,name,sector,logo_url&id=in.(${secIds.join(',')})`)
        : Promise.resolve([]),
      secIds.length
        ? sbGet(`stock_returns_c?select=security_id,symbol,current_price,1d_pct,ytd_pct,1y_pct,as_of_date&security_id=in.(${secIds.join(',')})&order=as_of_date.desc`)
        : Promise.resolve([]),
      /* Live intraday prices — same source the orderbook uses for its Live
         Price + Client PnL columns. First-write-wins per security_id with
         desc ordering gives us the latest tick. */
      secIds.length
        ? sbGet(`stock_intraday_c?select=security_id,current_price,timestamp&security_id=in.(${secIds.join(',')})&order=timestamp.desc`)
        : Promise.resolve([]),
      userIds.length
        ? sbGet(`transactions?select=user_id,amount,direction,name,description,status,transaction_date&user_id=in.(${userIds.join(',')})&order=transaction_date.desc`)
        : Promise.resolve([]),
      famIds.length
        ? sbGet(`family_members?select=id,first_name,last_name&id=in.(${famIds.join(',')})`)
        : Promise.resolve([]),
    ]);

    /* Merge intraday current_price (cents) into secLive rows so the client
       gets one shape. Intraday wins when present; stock_returns_c fills the
       gap for securities without an intraday tick. */
    const intradayByid = {};
    (secIntraday || []).forEach((row) => {
      if (!row?.security_id) return;
      if (intradayByid[row.security_id]) return; // first (latest) wins
      if (row.current_price != null) intradayByid[row.security_id] = Number(row.current_price);
    });
    const secLive = (secReturns || []).map((r) => {
      const intraCents = intradayByid[r.security_id];
      if (Number.isFinite(intraCents) && intraCents > 0) {
        return { ...r, current_price: intraCents };
      }
      return r;
    });
    /* Surface intraday-only securities (no stock_returns_c row) too. */
    const returnsIds = new Set((secReturns || []).map((r) => r.security_id));
    Object.entries(intradayByid).forEach(([sid, cents]) => {
      if (returnsIds.has(sid)) return;
      secLive.push({ security_id: sid, current_price: cents });
    });

    res.statusCode = 200;
    res.end(JSON.stringify({ holdings, strategies, stratHist, profiles, secMeta, secLive, txns, familyMembers }));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: err.message }));
  }
};
