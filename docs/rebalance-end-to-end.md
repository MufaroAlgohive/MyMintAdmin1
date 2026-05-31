# Rebalance — End-to-End Flow

How rebalancing works across the MyMintAdmin CRM and the MINT user app,
from "admin clicks Execute" to "user sees the new position + leftover cash."
This is the full A → Z so you can sanity-check the design.

---

## TL;DR

```
┌──────────────── MyMintAdmin (CRM, you) ─────────────────┐
│  Pick strategy → Pick SELL ISIN → Pick BUY ISIN         │
│  → rebExecute() inserts:                                 │
│      • rebalance_batch (PENDING)                         │
│      • rebalance_event (SELL/BUY rows)                   │
│      • strategy_rebalance_residuals (per-strategy cash)  │
│  → Orderbook: PENDING batch shows up                     │
│  → Fill & Settle:                                        │
│      • old SELL row in stock_holdings_c → inactive       │
│      • new BUY row in stock_holdings_c → active          │
│      • rebalance_batch → SETTLED                         │
└──────────────────────────────────────────────────────────┘
                       │ (writes to Supabase)
                       ▼
┌──────────── Supabase tables (shared by both apps) ──────┐
│   stock_holdings_c     ← positions, per (user, security,│
│                          strategy, transaction_id)      │
│   rebalance_batch      ← one row per executed rebalance │
│   rebalance_event      ← one row per user × side        │
│   strategy_rebalance_  ← per-(user, strategy) cash pool │
│      residuals                                          │
│   wallets              ← .balance (main wallet) and     │
│                          .rebalance_residual (legacy    │
│                          per-user unallocated pool)     │
└─────────────────────────────────────────────────────────┘
                       │ (reads from Supabase)
                       ▼
┌─────────────── MINT (user app, your clients) ───────────┐
│  Strategy card shows:                                    │
│    positionsValue  = Σ live_price × qty (active holdings)│
│  + residualCash    = strategy_rebalance_residuals balance│
│  = currentValue    = what the user "owns" in this        │
│                      strategy right now                  │
└──────────────────────────────────────────────────────────┘
```

---

## Cast of characters (tables & files)

### Tables
| Table | Purpose | Key money columns |
|---|---|---|
| `stock_holdings_c` | One row per (user × security × strategy × transaction_id). The user's actual positions. | `avg_fill` (cents), `Expected_fill` (rands), `quantity`, `Status` ('active'/'inactive'), `is_active` (bool) |
| `rebalance_batch` | One row per rebalance event you executed. | `total_sell_quantity`, `total_buy_quantity`, `net_proceeds`, `status` ('PENDING'/'SETTLED'/'REVERSED') |
| `rebalance_event` | One row per (user × side) inside a batch. The orderbook reads these to show pending fills. | `quantity`, `price_at_commit` (cents), `avg_fill` (filled price, cents), `closed_reason` |
| `strategy_rebalance_residuals` | **NEW** — per-(user, strategy, family_member_id) cash bucket from rebalances. `family_member_id` is NULL for the parent's own residual; a uuid points at a child for per-child residual once the rebalance UI supports per-child execution. | `balance_cents` |
| `wallets` | User's main spendable wallet. | `balance` (rands), `rebalance_residual` (cents, legacy) |

### Files (CRM side)
- `MyMintAdmin/public/dashboard.html` — `rebLoadStrategy`, `rebExecute`, `rebExecuteLiquidate`, `rebShowWalletModal`
- `MyMintAdmin/public/orderbook.html` — fill & settle workflow that consumes `rebalance_event` rows and writes the position changes into `stock_holdings_c`

### Files (MINT side)
- `MINT/src/lib/useUserStrategies.js` — fetches strategy data + per-strategy residual, exposes `currentValue = positionsValue + residualCash`
- `MINT/src/pages/HomePage.jsx` — renders strategy cards using `useUserStrategies` output
- `MINT/src/components/SwipeableBalanceCard.jsx` — overall portfolio total card

---

## Step-by-step flow

### A. Admin opens the Rebalance tab in MyMintAdmin
1. Picks a strategy.
2. `rebLoadStrategy(strategyId)` runs. It:
   - Loads every `stock_holdings_c` row for active holders of that strategy.
   - Loads existing per-strategy residual balances: `rebLoadWalletBalances(strategyId, userIds)` queries `strategy_rebalance_residuals` scoped to this strategy.
   - Loads any pending rebalance batch (so you don't double-execute).

### B. Admin clicks Execute (or Liquidate)
There are three variants of execute, all in `dashboard.html`:

| Variant | Function | What it does |
|---|---|---|
| Full rebalance | `rebExecute` | Sells one ISIN, buys another. Leftover cash → residual. |
| Liquidate to cash | `rebExecuteLiquidate` | Sells only, no buy. All proceeds → residual. |
| Wallet-funded buy | `rebShowWalletModal` → execute | Spends from residual (and optionally main wallet) to buy more shares. |

For a full rebalance, `rebExecute`:
1. Inserts `rebalance_batch` (`status='PENDING'`, snapshots before-state).
2. Inserts `rebalance_event` rows — one per user × side. `closed_reason` is one of:
   - `REBALANCE_EVENT_SELL`
   - `REBALANCE_EVENT_BUY` (primary buy funded by the sell proceeds)
   - `REBALANCE_EVENT_BUY_WALLET` (extra buy funded by residual + wallet)
3. **Tops up each user's residual:** `rebUpsertWalletBalances(strategyId, balancesByUser)` upserts into `strategy_rebalance_residuals` keyed by `(user_id, strategy_id)`.

### B.5 History entry written for the user (MINT activity feed)
On every successful fill & settle, one `transactions` row is inserted per
affected user. The row is purely informational:
- `name` = `"Rebalance: <Strategy name>"`
- `description` = `"sold X × SYM_A, bought Y × SYM_B"`
- `amount` = 0 (the swap is positions↔positions, not money in/out)
- `direction` = `'credit'` (so it groups with other "no-cost" events in MINT)
- `status` = `'posted'`, `transaction_date` = now

MINT's existing transactions list automatically picks this up. No new
endpoint or component needed in the user app — the entry shows up under
"Recent Transactions" alongside deposits, withdrawals, and purchases.

### C. Orderbook tab in MyMintAdmin (still admin)
- The PENDING batch appears as a single grouped row.
- Admin enters the actual broker fill price.
- Admin clicks **Fill & Settle**. For each `rebalance_event` row:
  - **SELL side:** updates the existing `stock_holdings_c` row → `Status='inactive'`, `is_active=false`, `closed_at=now`, `closed_reason='REBALANCE_SELL'`, `avg_exit=fill_price`, `Exit_date=today`. Also inserts a separate "audit" row recording the sell at the actual fill.
  - **BUY side:** inserts a NEW `stock_holdings_c` row → `Status='active'`, `is_active=true`, `avg_fill=fill_price_cents`, `Fill_date=today`, `rebalance_batch_id=batch.id`.
- The batch flips to `status='SETTLED'`.

### D. MINT (user app) re-renders
- `useUserStrategies` runs.
- Reads `client_strategy_returns_c.basket_value` for the strategy (Σ live market value of active positions, in cents).
- **NEW:** reads `strategy_rebalance_residuals.balance_cents` for the strategy.
- Returns:
  ```
  positionsValue  = basket_value / 100
  residualCash    = balance_cents / 100
  currentValue    = positionsValue + residualCash    // what to display
  ```
- The strategy card and portfolio total show `currentValue`. Without including the residual, the portfolio would *look like it shrank* whenever a rebalance left cash on the table.

---

## Why per-strategy residual (vs. per-user)

The original `wallets.rebalance_residual` column was a single per-user pool. Problems:
- If a user is in Strategy A and Strategy B, cash from a rebalance of A piles into the same bucket as cash from a rebalance of B. No way to say "this R104 came from A."
- The wallet-funded buy modal could spend Strategy A's residual on a Strategy B buy. Mixing.
- MINT couldn't show *"Strategy A has R104 in cash waiting to be redeployed"* — it didn't know which strategy the cash came from.

The new table fixes all of this. Each (user, strategy) has its own row. Strategy A's residual is locked to Strategy A.

---

## What happens to existing `wallets.rebalance_residual` data

It stays put. Treated as a "legacy unallocated pool" — any balance left over from before this change can still be spent via the wallet modal (we did NOT migrate or zero it). New residual cash from now on goes into `strategy_rebalance_residuals` instead. The legacy column is read-but-not-written for any new rebalance.

If you want, we can later add a UI in the wallet modal to display "Unallocated rebalance cash: Rxx" alongside per-strategy buckets so users can see and choose what to spend.

---

## Cost-basis convention (carry-over vs no-carry-over)

MyMint uses **Model 2 — no carryover** (see [rebalance-cost-basis-carryover.md](rebalance-cost-basis-carryover.md)).

Concretely: when a user's holding is sold during a rebalance and partially redeployed, the **realized gain doesn't hide inside the new position's cost basis.** Instead it lands in cash (the residual). This means:

- New position's `avg_fill` = the actual broker fill price (honest)
- Residual = principal returned + realized gain − fees − cash used for the new buy
- The "PnL pass-down" the user asked about is real and lives in the residual cash, not in synthetic cost-basis adjustments

This pairs naturally with per-strategy residual: the gain made on Strategy A's rebalance stays earmarked for Strategy A.

---

## Data invariants worth knowing

1. **`Status` and `is_active` are kept in lockstep.** Every place that updates one updates the other ([orderbook.html:5917-5994](../public/orderbook.html#L5917-L5994)). Both mean the same thing — `Status='active'` ↔ `is_active=true`. MINT reads `Status='active'`; the admin views read `is_active=true`. Belt-and-braces.

2. **`avg_fill` is always cents. `Expected_fill` is always rands.** A legacy guard in the cost-basis helpers handles old rows that miswrote `Expected_fill` in cents (`if Expected_fill > avg_fill_rands × 5 → /100`).

3. **`transaction_id`** on `stock_holdings_c` ties every holding row to the purchase batch that created it. Two buys of the same strategy by the same user split into two batches in both apps (rebalances don't set transaction_id — they're traceable via `rebalance_batch_id` instead).

4. **MINT only reads, never writes.** All position/residual writes happen from MyMintAdmin (admin-initiated). MINT's RLS policies grant SELECT on the user's own rows only.

---

## Parent + child holding the same strategy

Today's rebalance UI groups all holdings under a single `user_id` regardless of whether they belong to the parent or a child of that parent. Until the admin UI is extended to pick a specific child to rebalance, **`rebalance_event.family_member_id` defaults to `NULL` (parent-scoped)** and:

- `executeFillAndSettle` strictly scopes the SELL lookup by `family_member_id IS NULL` when the event has no family_member_id, so a child's positions of the same security in the same strategy are **left alone** — they are no longer at risk of being silently closed.
- New BUY rows are inserted with `family_member_id = NULL` (parent-only) for the same reason.
- The R0 history transaction is written per `(user_id, family_member_id)` pair, so once per-child rebalance lands, each owner gets their own entry.

When you later want to actually rebalance a child's positions, `rebExecute` needs the UI affordance to select the family member, and then write the events with `family_member_id` set. Everything downstream (fill & settle, residual upsert, history transaction) already reads from `evt.family_member_id` and routes correctly.

## What's NOT in this flow (gaps and future work)

- **Per-child rebalance execution UI.** Schema + execution path are ready; the UI in `rebExecute` still groups all holdings by `user_id`. When you want to rebalance just a child's positions, that's the remaining piece.
- **Migration of legacy `wallets.rebalance_residual`.** Untouched. Any residual that already existed in that per-user pool stays there as unallocated cash. If you want to retroactively attribute old residuals to specific strategies you'd write a one-off SQL with manual rules.

---

## Files changed in this iteration

### MyMintAdmin (pushed to `main`)
- `docs/strategy-rebalance-residuals.sql` — table + RLS migration (run in Supabase SQL editor)
- `public/dashboard.html` — `rebLoadWalletBalances` / `rebUpsertWalletBalances` now use the new table

### MINT (committed to `Mpumi's-Branch`, **not pushed**)
- `src/lib/useUserStrategies.js` — fetches residuals, exposes `positionsValue`, `residualCash`, and includes residual in `currentValue`

---

## Deploy checklist

1. **Supabase:** run [docs/strategy-rebalance-residuals.sql](strategy-rebalance-residuals.sql) in the SQL editor.
2. **MyMintAdmin:** already deployed via Vercel on the `main` push.
3. **MINT:** push `Mpumi's-Branch` when ready. The MINT change is read-only and won't break anything if the table doesn't exist yet (the query just returns no rows).
4. **Smoke test:** in MyMintAdmin, run a small rebalance on a test strategy; in MINT, verify the strategy card's value didn't drop by the residual amount.
