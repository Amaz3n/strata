-- Complete the daily-driver Books workflows without weakening the existing
-- accounting fact spine. A multi-invoice receipt remains one projected payment
-- per invoice, but the rows share a durable receipt group so the user records and
-- audits one economic event.

create table if not exists public.receivable_payment_groups (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  received_at timestamptz not null,
  total_cents integer not null check (total_cents > 0),
  currency text not null default 'usd',
  method text not null check (method in ('ach', 'card', 'wire', 'check')),
  reference text,
  provider text not null default 'manual',
  idempotency_key text not null,
  party_type text check (party_type in ('contact', 'company')),
  party_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (org_id, idempotency_key),
  check ((party_type is null) = (party_id is null))
);

create index if not exists receivable_payment_groups_org_received_idx
  on public.receivable_payment_groups (org_id, received_at desc, id desc);

create table if not exists public.receivable_payment_group_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  group_id uuid not null references public.receivable_payment_groups(id) on delete cascade,
  payment_id uuid not null references public.payments(id) on delete restrict,
  invoice_id uuid not null references public.invoices(id) on delete restrict,
  project_id uuid references public.projects(id) on delete set null,
  amount_cents integer not null check (amount_cents > 0),
  created_at timestamptz not null default now(),
  unique (group_id, invoice_id),
  unique (payment_id)
);

create index if not exists receivable_payment_group_items_org_invoice_idx
  on public.receivable_payment_group_items (org_id, invoice_id, created_at desc);

create table if not exists public.books_overhead_budgets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null,
  fiscal_year integer not null check (fiscal_year between 2000 and 2200),
  status text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  notes text,
  created_by uuid references public.app_users(id) on delete set null,
  updated_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, fiscal_year, name)
);

create index if not exists books_overhead_budgets_org_year_idx
  on public.books_overhead_budgets (org_id, fiscal_year desc, status);

create table if not exists public.books_overhead_budget_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  budget_id uuid not null references public.books_overhead_budgets(id) on delete cascade,
  account_id uuid not null references public.gl_accounts(id) on delete restrict,
  month_start date not null check (extract(day from month_start) = 1),
  budget_cents integer not null check (budget_cents >= 0),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (budget_id, account_id, month_start)
);

create index if not exists books_overhead_budget_lines_org_month_idx
  on public.books_overhead_budget_lines (org_id, month_start, account_id);

create table if not exists public.books_deposit_batches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  bank_transaction_id uuid not null references public.bank_transactions(id) on delete restrict,
  bank_account_id uuid not null references public.bank_accounts(id) on delete restrict,
  deposited_on date not null,
  total_cents integer not null check (total_cents > 0),
  status text not null default 'draft' check (status in ('draft', 'posted', 'void')),
  reference text,
  journal_entry_id uuid references public.journal_entries(id) on delete restrict,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (org_id, bank_transaction_id)
);

create index if not exists books_deposit_batches_org_date_idx
  on public.books_deposit_batches (org_id, deposited_on desc, id desc);

create table if not exists public.books_deposit_batch_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  batch_id uuid not null references public.books_deposit_batches(id) on delete cascade,
  payment_id uuid not null references public.payments(id) on delete restrict,
  amount_cents integer not null check (amount_cents > 0),
  created_at timestamptz not null default now(),
  unique (batch_id, payment_id),
  unique (org_id, payment_id)
);

create index if not exists books_deposit_batch_items_org_batch_idx
  on public.books_deposit_batch_items (org_id, batch_id);

alter table public.receivable_payment_groups enable row level security;
alter table public.receivable_payment_group_items enable row level security;
alter table public.books_overhead_budgets enable row level security;
alter table public.books_overhead_budget_lines enable row level security;
alter table public.books_deposit_batches enable row level security;
alter table public.books_deposit_batch_items enable row level security;

-- These tables are intentionally server-only. Application services perform the
-- resource permission checks before using the service role; no browser client
-- needs direct Data API access.
revoke all on table public.receivable_payment_groups from public, anon, authenticated;
revoke all on table public.receivable_payment_group_items from public, anon, authenticated;
revoke all on table public.books_overhead_budgets from public, anon, authenticated;
revoke all on table public.books_overhead_budget_lines from public, anon, authenticated;
revoke all on table public.books_deposit_batches from public, anon, authenticated;
revoke all on table public.books_deposit_batch_items from public, anon, authenticated;

grant all on table public.receivable_payment_groups to service_role;
grant all on table public.receivable_payment_group_items to service_role;
grant all on table public.books_overhead_budgets to service_role;
grant all on table public.books_overhead_budget_lines to service_role;
grant all on table public.books_deposit_batches to service_role;
grant all on table public.books_deposit_batch_items to service_role;

create or replace function public.apply_multi_invoice_payment_atomic(
  p_org_id uuid,
  p_received_at timestamptz,
  p_method text,
  p_reference text,
  p_provider text,
  p_idempotency_key text,
  p_allocations jsonb,
  p_party_type text default null,
  p_party_id uuid default null,
  p_metadata jsonb default '{}'::jsonb,
  p_created_by uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_group public.receivable_payment_groups%rowtype;
  v_allocation jsonb;
  v_invoice public.invoices%rowtype;
  v_payment jsonb;
  v_total bigint := 0;
  v_count integer := 0;
  v_rows jsonb := '[]'::jsonb;
begin
  if p_idempotency_key is null or length(trim(p_idempotency_key)) < 8 then
    raise exception 'A stable payment idempotency key is required';
  end if;
  if p_method not in ('ach', 'card', 'wire', 'check') then
    raise exception 'Unsupported payment method';
  end if;
  if jsonb_typeof(p_allocations) <> 'array' or jsonb_array_length(p_allocations) = 0 then
    raise exception 'At least one invoice allocation is required';
  end if;
  if (p_party_type is null) <> (p_party_id is null) then
    raise exception 'Payment party type and id must be provided together';
  end if;
  if p_party_type is not null and p_party_type not in ('contact', 'company') then
    raise exception 'Unsupported payment party type';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_org_id::text || ':receipt:' || p_idempotency_key, 0)
  );

  select * into v_group
  from public.receivable_payment_groups
  where org_id = p_org_id and idempotency_key = p_idempotency_key;

  if v_group.id is not null then
    select coalesce(jsonb_agg(to_jsonb(item) order by item.created_at), '[]'::jsonb)
      into v_rows
    from public.receivable_payment_group_items item
    where item.org_id = p_org_id and item.group_id = v_group.id;
    return jsonb_build_object('group', to_jsonb(v_group), 'items', v_rows, 'duplicate', true);
  end if;

  if exists (
    select 1
    from (
      select value ->> 'invoice_id' as invoice_id, count(*)
      from jsonb_array_elements(p_allocations)
      group by value ->> 'invoice_id'
      having count(*) > 1
    ) duplicates
  ) then
    raise exception 'An invoice may appear only once in a receipt';
  end if;

  for v_allocation in
    select value
    from jsonb_array_elements(p_allocations)
    order by value ->> 'invoice_id'
  loop
    if coalesce((v_allocation ->> 'amount_cents')::integer, 0) <= 0 then
      raise exception 'Every allocation must be positive';
    end if;
    select * into v_invoice
    from public.invoices
    where org_id = p_org_id
      and id = (v_allocation ->> 'invoice_id')::uuid
    for update;
    if v_invoice.id is null then
      raise exception 'Invoice not found or inaccessible';
    end if;
    if v_invoice.status = 'void' then
      raise exception 'Cannot apply a receipt to a void invoice';
    end if;
    v_total := v_total + (v_allocation ->> 'amount_cents')::integer;
    v_count := v_count + 1;
  end loop;

  insert into public.receivable_payment_groups (
    org_id, received_at, total_cents, currency, method, reference, provider,
    idempotency_key, party_type, party_id, metadata, created_by
  ) values (
    p_org_id, coalesce(p_received_at, now()), v_total::integer, 'usd', p_method,
    nullif(trim(p_reference), ''), coalesce(nullif(trim(p_provider), ''), 'manual'),
    p_idempotency_key, p_party_type, p_party_id, coalesce(p_metadata, '{}'::jsonb),
    p_created_by
  ) returning * into v_group;

  for v_allocation in
    select value
    from jsonb_array_elements(p_allocations)
    order by value ->> 'invoice_id'
  loop
    select * into v_invoice
    from public.invoices
    where org_id = p_org_id
      and id = (v_allocation ->> 'invoice_id')::uuid;

    v_payment := public.apply_invoice_payment_with_details_atomic(
      p_org_id,
      v_invoice.id,
      (v_allocation ->> 'amount_cents')::integer,
      'usd',
      p_method,
      coalesce(nullif(trim(p_provider), ''), 'manual'),
      'receipt-group:' || v_group.id::text || ':' || v_invoice.id::text,
      'succeeded',
      nullif(trim(p_reference), ''),
      0,
      (v_allocation ->> 'amount_cents')::integer,
      (v_allocation ->> 'amount_cents')::integer,
      p_idempotency_key || ':' || v_invoice.id::text,
      coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object(
        'source', 'arc_multi_invoice_receipt',
        'receipt_group_id', v_group.id
      ),
      coalesce(p_received_at, now()),
      null, null, 0, 0, 0, null, null
    );

    insert into public.receivable_payment_group_items (
      org_id, group_id, payment_id, invoice_id, project_id, amount_cents
    ) values (
      p_org_id,
      v_group.id,
      (v_payment ->> 'id')::uuid,
      v_invoice.id,
      v_invoice.project_id,
      (v_allocation ->> 'amount_cents')::integer
    );
    v_rows := v_rows || jsonb_build_array(
      jsonb_build_object(
        'payment_id', v_payment ->> 'id',
        'invoice_id', v_invoice.id,
        'project_id', v_invoice.project_id,
        'amount_cents', (v_allocation ->> 'amount_cents')::integer
      )
    );
  end loop;

  return jsonb_build_object(
    'group', to_jsonb(v_group),
    'items', v_rows,
    'allocation_count', v_count,
    'duplicate', false
  );
end;
$$;

revoke all on function public.apply_multi_invoice_payment_atomic(
  uuid, timestamptz, text, text, text, text, jsonb, text, uuid, jsonb, uuid
) from public, anon, authenticated;
grant execute on function public.apply_multi_invoice_payment_atomic(
  uuid, timestamptz, text, text, text, text, jsonb, text, uuid, jsonb, uuid
) to service_role;

create or replace function public.replace_books_overhead_budget_atomic(
  p_org_id uuid,
  p_budget_id uuid,
  p_name text,
  p_fiscal_year integer,
  p_status text,
  p_notes text,
  p_lines jsonb,
  p_actor_id uuid
) returns uuid
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_budget_id uuid;
  v_line jsonb;
  v_account public.gl_accounts%rowtype;
  v_month date;
begin
  if length(trim(coalesce(p_name, ''))) < 2 then
    raise exception 'Budget name must contain at least two characters';
  end if;
  if p_fiscal_year < 2000 or p_fiscal_year > 2200 then
    raise exception 'Fiscal year is outside the supported range';
  end if;
  if p_status not in ('draft', 'active', 'archived') then
    raise exception 'Unsupported overhead budget status';
  end if;
  if jsonb_typeof(p_lines) <> 'array' then
    raise exception 'Budget lines must be an array';
  end if;

  if p_budget_id is null then
    insert into public.books_overhead_budgets (
      org_id, name, fiscal_year, status, notes, created_by, updated_by
    ) values (
      p_org_id, trim(p_name), p_fiscal_year, p_status, nullif(trim(p_notes), ''),
      p_actor_id, p_actor_id
    ) returning id into v_budget_id;
  else
    update public.books_overhead_budgets
    set name = trim(p_name),
        fiscal_year = p_fiscal_year,
        status = p_status,
        notes = nullif(trim(p_notes), ''),
        updated_by = p_actor_id,
        updated_at = now()
    where org_id = p_org_id and id = p_budget_id
    returning id into v_budget_id;
    if v_budget_id is null then
      raise exception 'Overhead budget not found';
    end if;
    delete from public.books_overhead_budget_lines
    where org_id = p_org_id and budget_id = v_budget_id;
  end if;

  for v_line in select value from jsonb_array_elements(p_lines)
  loop
    if coalesce((v_line ->> 'budget_cents')::integer, 0) < 0 then
      raise exception 'Budget amounts cannot be negative';
    end if;
    v_month := (v_line ->> 'month_start')::date;
    if extract(day from v_month) <> 1 or extract(year from v_month) <> p_fiscal_year then
      raise exception 'Every budget month must be the first day of the fiscal year month';
    end if;
    select * into v_account
    from public.gl_accounts
    where org_id = p_org_id
      and id = (v_line ->> 'account_id')::uuid
      and account_type = 'expense'
      and active = true;
    if v_account.id is null then
      raise exception 'Overhead budgets may use active expense accounts only';
    end if;
    if (v_line ->> 'budget_cents')::integer > 0 then
      insert into public.books_overhead_budget_lines (
        org_id, budget_id, account_id, month_start, budget_cents, notes
      ) values (
        p_org_id, v_budget_id, v_account.id, v_month,
        (v_line ->> 'budget_cents')::integer,
        nullif(trim(v_line ->> 'notes'), '')
      );
    end if;
  end loop;

  return v_budget_id;
end;
$$;

revoke all on function public.replace_books_overhead_budget_atomic(
  uuid, uuid, text, integer, text, text, jsonb, uuid
) from public, anon, authenticated;
grant execute on function public.replace_books_overhead_budget_atomic(
  uuid, uuid, text, integer, text, text, jsonb, uuid
) to service_role;
