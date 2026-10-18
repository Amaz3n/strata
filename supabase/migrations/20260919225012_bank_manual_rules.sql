-- User-authored transaction coding controls live separately from bank_rules,
-- which Arc learns from accepted categorizations. This prevents learning from
-- overwriting an explicit instruction or presenting inference as user intent.
create table public.bank_manual_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  match_kind text not null check (match_kind in ('merchant_exact', 'description_contains')),
  match_value text not null check (length(btrim(match_value)) >= 2),
  direction text check (direction is null or direction in ('inflow', 'outflow')),
  bank_account_id uuid references public.bank_accounts(id) on delete cascade,
  gl_account_id uuid not null references public.gl_accounts(id) on delete restrict,
  vendor_id uuid references public.companies(id) on delete set null,
  active boolean not null default true,
  created_by uuid references public.app_users(id) on delete set null,
  updated_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index bank_manual_rules_natural_key
  on public.bank_manual_rules (org_id, match_kind, match_value, bank_account_id, direction)
  nulls not distinct;
create index bank_manual_rules_org_active_idx
  on public.bank_manual_rules (org_id, active) where active;
create index bank_manual_rules_bank_account_idx
  on public.bank_manual_rules (org_id, bank_account_id) where bank_account_id is not null;
create index bank_manual_rules_gl_account_idx
  on public.bank_manual_rules (org_id, gl_account_id);
create index bank_manual_rules_vendor_idx
  on public.bank_manual_rules (org_id, vendor_id) where vendor_id is not null;

create trigger bank_manual_rules_set_updated_at
  before update on public.bank_manual_rules
  for each row execute function public.tg_set_updated_at();

alter table public.bank_manual_rules enable row level security;
create policy bank_manual_rules_read on public.bank_manual_rules
  for select to authenticated
  using (public.has_org_permission(org_id, 'books.reconcile'));
revoke all on public.bank_manual_rules from public, anon, authenticated;
grant select on public.bank_manual_rules to authenticated;
grant all on public.bank_manual_rules to service_role;

comment on table public.bank_manual_rules is
  'Explicit user-authored bank transaction coding rules. Separate from learned bank_rules; these rules suggest a category and never auto-post.';
