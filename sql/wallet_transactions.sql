-- Wallet transactions history table
begin;

create table if not exists public.wallet_transactions (
  id uuid not null default gen_random_uuid (),
  wallet_id uuid not null references public.wallets (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  amount numeric(18, 2) not null,
  transaction_type text not null check (transaction_type in ('manual', 'csv_upload', 'eft', 'adjustment')),
  reference text null,
  created_at timestamp with time zone not null default now(),
  constraint wallet_transactions_pkey primary key (id)
) tablespace pg_default;

create index if not exists idx_wallet_transactions_user_id
  on public.wallet_transactions (user_id, created_at desc) tablespace pg_default;

create index if not exists idx_wallet_transactions_wallet_id
  on public.wallet_transactions (wallet_id, created_at desc) tablespace pg_default;

commit;
