-- Arc Books C4.4: learned categorization for bank feed transactions.
--
-- WHY A NEW TABLE RATHER THAN EXTENDING `coding_rules`
-- The gameplan assumed bank rules would reuse the B1 coding-rules engine. The
-- *engine* is reused — `nextCodingRuleCounts` in `lib/services/accounting-rules.ts`
-- is the confidence and demotion curve B1 spent a whole directive getting right,
-- and bank rules call it unchanged. The *table* is not, for three reasons:
--
--   1. Different target. A coding rule answers "which cost code does this
--      vendor's bill belong to" (`cost_code_id` / `budget_line_id`). A bank rule
--      answers "which GL account does this bank line hit" (`gl_account_id`).
--   2. Different match input. `coding_rules` matches on `company_id` plus a memo
--      pattern, and `selectCodingSuggestion` filters on `company_id` first. A bank
--      transaction has no company — it has a free-text description a bank wrote.
--   3. `coding_rules.match_kind` was deliberately narrowed to `vendor |
--      vendor_memo` by migration 20260808150000, whose own note says a new match
--      kind "returns with its own migration" because it is a feature, not a
--      cleanup. This is that migration, and keeping the two enums separate is what
--      stops `coding_rules` describing kinds its selector cannot reach again.
--
-- Scoped by `books.reconcile`, which is already the permission for deciding what a
-- bank transaction is. No new RBAC key: this is the same job, automated.

create table if not exists public.bank_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,

  -- `merchant_exact` matches the provider's normalized merchant; `description_contains`
  -- matches a substring of the raw description. Exact wins where both apply.
  match_kind text not null check (match_kind in ('merchant_exact', 'description_contains')),
  -- Stored normalized (trimmed, lowercased) so matching never depends on how the
  -- bank happened to capitalise a payee this month.
  match_value text not null check (length(btrim(match_value)) > 0),
  -- Null means the rule applies whichever way the money moved. A rule that should
  -- only categorize spend sets 'outflow'.
  direction text check (direction is null or direction in ('inflow', 'outflow')),
  -- Null means every account. Set it to keep a rule on one card or one bank.
  bank_account_id uuid references public.bank_accounts(id) on delete cascade,

  gl_account_id uuid not null references public.gl_accounts(id) on delete restrict,
  project_id uuid references public.projects(id) on delete set null,
  cost_code_id uuid references public.cost_codes(id) on delete set null,

  -- Same learning shape as `coding_rules`, so `nextCodingRuleCounts` governs both.
  confidence numeric not null default 0 check (confidence >= 0 and confidence <= 1),
  hit_count integer not null default 0 check (hit_count >= 0),
  correction_count integer not null default 0 check (correction_count >= 0),
  last_hit_at timestamptz,
  last_corrected_at timestamptz,

  active boolean not null default true,
  created_by uuid references public.app_users(id) on delete set null,
  updated_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One rule per shape. `nulls not distinct` so two rules cannot both claim
-- "AMEX PAYMENT, any account, any direction" — without it every null column
-- would make the pair distinct and duplicates would accumulate silently.
create unique index if not exists bank_rules_natural_key
  on public.bank_rules (org_id, match_kind, match_value, bank_account_id, direction)
  nulls not distinct;

create index if not exists bank_rules_org_active_idx
  on public.bank_rules (org_id, active) where active;
create index if not exists bank_rules_org_account_idx
  on public.bank_rules (org_id, bank_account_id);
create index if not exists bank_rules_gl_account_idx
  on public.bank_rules (org_id, gl_account_id);

create trigger bank_rules_set_updated_at
  before update on public.bank_rules
  for each row execute function public.tg_set_updated_at();

-- Org-scoped, select-only for members; every write goes through a service-role
-- server action. Copied from the Books foundation's own policy loop.
alter table public.bank_rules enable row level security;
create policy bank_rules_read on public.bank_rules
  for select to authenticated
  using (public.has_org_permission(org_id, 'books.reconcile'));
grant select on public.bank_rules to authenticated;
grant all on public.bank_rules to service_role;

comment on table public.bank_rules is
  'Learned categorization for bank feed transactions: match a payee or description, post to a GL account. Shares the confidence/demotion engine with coding_rules but not its table — different target, different match input.';
