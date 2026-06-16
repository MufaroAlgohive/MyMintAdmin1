# Mint CRM Admin Portal

## Overview
Internal admin dashboard for the Mint investment platform. Provides client management, KYC verification, investment strategy configuration, and order book reporting.

## Architecture
- **Backend**: Node.js with native `http` module (`server.js`)
- **Frontend**: Static HTML/JS with Tailwind CSS (served from `public/`)
- **Database**: Supabase (PostgreSQL)
- **Services**: Resend (email), Sumsub (KYC)
- **Deployment target**: Vercel (serverless functions in `api/`)
- **auth stuff(stuff)

## Key Pages
- `/signin.html` - Admin login (Supabase Auth)
- `/index.html` - Client profiles / CRM..
- `/dashboard.html` - Main dashboard with four tabs: Overview, Strategy Management, Rebalancing, Factsheets
- `/eft.html` - EFT Payments standalone page (upload bank CSV, confirm pending deposits)
- `/orderbook.html` - Order book email runs; includes "Pending Rebalances" tab for settling trades
- `/strategies.html` - Standalone strategies page (legacy, content now in dashboard)
- `/factsheet.html` - Standalone factsheet page (legacy, content now in dashboard)

## Dashboard Tabs
### Overview Tab (Lovable-style redesign)
- **Live market ticker** — horizontally scrolling bar with security prices and day-change % from `securities` table (simulated live price updates every 5s)
- **Strategy selector** — dropdown to pick which strategy to view; data re-renders for each selection
- **Strategy title bar** — name, inception date, instrument count, client count; AUM and NAV on the right
- **KPI Strip** (7 cards) — YTD Return, 1Y Return, Sharpe Ratio, Max Drawdown, Volatility, Beta, Alpha (from `strategy_analytics.summary`; shows "—" for unavailable fields)
- **Performance chart** (ECharts line, 8 cols) — from `strategy_analytics.curves`; falls back to YTD-scaled illustrative data
- **Sector Exposure** (ECharts donut, 4 cols) — grouped by security sector or individual holding weight with legend
- **Composition table** (7 cols) — holdings with price, weight bar, day change from `securities`
- **Investors table** (5 cols) — from `stock_holdings` by strategy_id, joined with `profiles`; shows qty, P&L, return %
- JS functions: `initOverviewDashboard`, `window.ovSelectStrategy`, `ovRenderTitleBar`, `ovRenderKpiStrip`, `ovRenderTicker`, `ovRenderPerfChart`, `ovRenderSectorChart`, `ovRenderHoldings`, `ovRenderInvestors`

### Strategies Tab
- **Create Strategy form** with holdings builder (search securities from DB, add with shares)
- **Auto-calculated fields**: target weight (based on market value proportions), minimum investment (sum of shares * price)
- **Strategy cards** with holdings preview logos, badges (public/featured/active), risk level, click to open detail modal
- **Detail modal** shows full holdings breakdown with shares, market value, weight, daily change
- **Filters**: search, risk level, visibility (public/featured/active), sort (newest/name/holdings count)
- Strategies saved with `status: 'active'` and warns if `is_public` not checked

### Factsheets Tab
- Grid of strategy cards to select from
- Inline factsheet view matching Mint platform layout: header with badges, daily change marquee, performance summary, strategy description, portfolio holdings table, calendar returns grid, fees & details section

## Strategies Feature
- Holdings stored as JSON array: `[{symbol, ticker, name, shares, quantity, weight}]`
- Minimum investment = sum of (shares * last_price/100) for each holding
- Target weight = (holding_market_value / total_market_value) * 100
- Strategies need `status: 'active'` AND `is_public: true` to appear on Mint's OpenStrategies page
- Missing price data triggers a warning on save

## API Endpoints
- `POST /api/securities/sync-fundamentals` — Pulls latest price, change%, P/E, market cap, dividend, and YTD data from Yahoo Finance for all active securities and writes them to the `securities` table. Requires admin Bearer token. Uses Yahoo Finance crumb auth. Called from the "Sync market data" button in the Strategies tab. Data units: last_price in ZAc (cents), change_percent/dividend_yield/ytd_performance as percentage floats, market_cap in ZAR (rand).

## Database Tables Used
- `profiles` - Client profiles
- `strategies` - Investment strategies with holdings JSON column
- `strategy_analytics` - Performance analytics (summary, curves, calendar_returns)
- `strategy_metrics` - Daily metrics (last_close, change_pct, returns)
- `securities` - Securities with symbol, name, logo_url, last_price, change_percent
- `stock_holdings` - Client stock holdings
- `user_onboarding` - KYC status tracking
- `user_onboarding_pack_details` - Onboarding pack details
- `orderbook_email_runs` - Email report history

### `_c`-suffixed tables (active data sources — use these, not the originals)
- `strategies_c` / `strategies_returns_c` - Strategy data and returns
- `securities_c` / `stock_returns_c` - Securities with prices (in ZAc cents)
- `stock_holdings_c` - Client holdings (settled positions)
- `rebalance_batch` - Rebalance batch records: status PENDING→SETTLED, stores `holdings_snapshot_before` (JSONB array of `{id, user_id, remaining}`) for settlement reference
- `rebalance_event` - Individual trade events per client per rebalance: `batch_id`, `user_id`, `security_id`, `trade_side`, `quantity`, `price_at_commit` (cents), `closed_reason`, `avg_fill`, `fill_date`, `settled_holding_id`

### Rebalancing flow
1. **Commit (dashboard Rebalancing tab)**: writes a `PENDING` `rebalance_batch` + per-client `rebalance_event` rows. Does NOT touch `stock_holdings_c`.
2. **Settle (orderbook Pending Rebalances tab)**: admin enters actual fill prices → closes/reduces old sell positions in `stock_holdings_c`, creates new buy positions, marks batch `SETTLED`.

## Environment Variables Required
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` - Database access
- `RESEND_API_KEY` - Email sending
- `SUMSUB_APP_TOKEN` / `SUMSUB_APP_SECRET` - KYC verification
- `ORDERBOOK_EMAIL_FROM` / `ORDERBOOK_EMAIL_TO` - Report emails
- `CRON_SECRET` - Cron endpoint protection
- `PORT` - Server port (set to 5000)

## Linked App
Connected to the Mint client-facing investment platform which shares the same Supabase backend. Strategies created here appear in Mint's OpenStrategies page when `status: 'active'` and `is_public: true`.
