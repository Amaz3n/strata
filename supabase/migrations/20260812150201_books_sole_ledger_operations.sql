-- Operational registers required when Arc Books is the sole ledger of record.
-- Additive only. Application services remain the write boundary.

set lock_timeout = '5s';
set statement_timeout = '120s';

begin;

create extension if not exists supabase_vault with schema vault;

create table public.books_debt_instruments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null check (length(btrim(name)) > 1),
  lender_company_id uuid references public.companies(id) on delete set null,
  liability_account_id uuid not null references public.gl_accounts(id) on delete restrict,
  cash_account_id uuid not null references public.gl_accounts(id) on delete restrict,
  interest_expense_account_id uuid not null references public.gl_accounts(id) on delete restrict,
  opened_on date not null,
  maturity_on date,
  original_principal_cents bigint not null default 0 check (original_principal_cents >= 0),
  annual_interest_bps integer not null default 0 check (annual_interest_bps between 0 and 100000),
  payment_frequency text not null default 'monthly' check (payment_frequency in ('weekly','biweekly','monthly','quarterly','annual','irregular')),
  active boolean not null default true,
  notes text,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name)
);

create table public.books_debt_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  instrument_id uuid not null references public.books_debt_instruments(id) on delete restrict,
  event_type text not null check (event_type in ('opening','draw','payment','interest_accrual','fee','adjustment')),
  event_date date not null,
  principal_cents bigint not null default 0 check (principal_cents >= 0),
  interest_cents bigint not null default 0 check (interest_cents >= 0),
  fee_cents bigint not null default 0 check (fee_cents >= 0),
  journal_entry_id uuid not null unique references public.journal_entries(id) on delete restrict,
  event_key text not null,
  memo text not null,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (org_id, event_key),
  check (principal_cents + interest_cents + fee_cents > 0)
);

create index books_debt_instruments_org_active_idx on public.books_debt_instruments (org_id, active, maturity_on);
create index books_debt_events_instrument_date_idx on public.books_debt_events (instrument_id, event_date, created_at);

create table public.books_fixed_assets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  asset_number text not null,
  name text not null check (length(btrim(name)) > 1),
  description text,
  project_id uuid references public.projects(id) on delete set null,
  placed_in_service_on date not null,
  acquisition_cost_cents bigint not null check (acquisition_cost_cents > 0),
  salvage_value_cents bigint not null default 0 check (salvage_value_cents >= 0),
  useful_life_months integer not null check (useful_life_months between 1 and 1200),
  depreciation_method text not null default 'straight_line' check (depreciation_method = 'straight_line'),
  asset_account_id uuid not null references public.gl_accounts(id) on delete restrict,
  accumulated_depreciation_account_id uuid not null references public.gl_accounts(id) on delete restrict,
  depreciation_expense_account_id uuid not null references public.gl_accounts(id) on delete restrict,
  funding_account_id uuid not null references public.gl_accounts(id) on delete restrict,
  status text not null default 'active' check (status in ('active','fully_depreciated','disposed')),
  disposed_on date,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, asset_number),
  check (salvage_value_cents <= acquisition_cost_cents),
  check ((status = 'disposed') = (disposed_on is not null))
);

create table public.books_fixed_asset_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  asset_id uuid not null references public.books_fixed_assets(id) on delete restrict,
  event_type text not null check (event_type in ('acquisition','depreciation','impairment','disposal','adjustment')),
  event_date date not null,
  amount_cents bigint not null check (amount_cents > 0),
  proceeds_cents bigint not null default 0 check (proceeds_cents >= 0),
  journal_entry_id uuid not null unique references public.journal_entries(id) on delete restrict,
  event_key text not null,
  memo text not null,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (org_id, event_key)
);

create index books_fixed_assets_org_status_idx on public.books_fixed_assets (org_id, status, placed_in_service_on);
create index books_fixed_asset_events_asset_date_idx on public.books_fixed_asset_events (asset_id, event_date, created_at);

create table public.books_tax_jurisdictions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null,
  country_code text not null default 'US' check (country_code ~ '^[A-Z]{2}$'),
  state_code text check (state_code is null or state_code ~ '^[A-Z]{2}$'),
  local_code text,
  sales_tax_rate_micros integer not null default 0 check (sales_tax_rate_micros between 0 and 1000000),
  use_tax_rate_micros integer not null default 0 check (use_tax_rate_micros between 0 and 1000000),
  effective_from date not null,
  effective_through date,
  filing_frequency text not null default 'quarterly' check (filing_frequency in ('monthly','quarterly','annual','none')),
  registration_number_ref text,
  active boolean not null default true,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name, effective_from),
  check (effective_through is null or effective_through >= effective_from)
);

create table public.books_tax_filings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  jurisdiction_id uuid references public.books_tax_jurisdictions(id) on delete restrict,
  filing_type text not null check (filing_type in ('sales_use_tax','form_1099','income_tax_package','payroll_tax','other')),
  period_start date not null,
  period_end date not null,
  due_on date,
  status text not null default 'draft' check (status in ('draft','ready','filed','accepted','rejected','amended')),
  amount_due_cents bigint,
  confirmation_number text,
  filed_at timestamptz,
  filed_by uuid references public.app_users(id) on delete set null,
  evidence_file_id uuid references public.files(id) on delete set null,
  notes text,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (period_end >= period_start),
  check ((status in ('filed','accepted','rejected','amended')) = (filed_at is not null))
);

create index books_tax_filings_org_due_idx on public.books_tax_filings (org_id, status, due_on);

alter table public.invoices
  add column if not exists tax_jurisdiction_id uuid references public.books_tax_jurisdictions(id) on delete set null;
alter table public.vendor_bills
  add column if not exists tax_jurisdiction_id uuid references public.books_tax_jurisdictions(id) on delete set null,
  add column if not exists tax_included_cents bigint not null default 0 check (tax_included_cents >= 0),
  add column if not exists use_tax_accrued_cents bigint not null default 0 check (use_tax_accrued_cents >= 0);
create index if not exists invoices_tax_jurisdiction_idx on public.invoices (org_id, tax_jurisdiction_id, issue_date) where tax_jurisdiction_id is not null;
create index if not exists vendor_bills_tax_jurisdiction_idx on public.vendor_bills (org_id, tax_jurisdiction_id, bill_date) where tax_jurisdiction_id is not null;

create table public.books_greenfield_launches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null unique references public.orgs(id) on delete cascade,
  launched_on date not null,
  opening_position text not null check (opening_position in ('zero','posted_opening_balances')),
  attestation text not null,
  launch_digest text not null,
  launched_by uuid not null references public.app_users(id) on delete restrict,
  launched_at timestamptz not null default now()
);

create table public.books_journal_proposals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  entry_date date not null,
  memo text not null check (length(btrim(memo)) >= 4),
  reversing_on date,
  posting_key text not null,
  policy_version integer not null check (policy_version > 0),
  lines jsonb not null check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) >= 2),
  status text not null default 'pending' check (status in ('pending','posted','rejected')),
  proposed_by uuid not null references public.app_users(id) on delete restrict,
  proposed_at timestamptz not null default now(),
  reviewed_by uuid references public.app_users(id) on delete restrict,
  reviewed_at timestamptz,
  review_note text,
  journal_entry_id uuid references public.journal_entries(id) on delete restrict,
  reversal_entry_id uuid references public.journal_entries(id) on delete restrict,
  unique (org_id, posting_key),
  check ((status = 'pending' and reviewed_at is null and journal_entry_id is null) or (status = 'rejected' and reviewed_at is not null and journal_entry_id is null) or (status = 'posted' and reviewed_at is not null and journal_entry_id is not null))
);
create index books_journal_proposals_org_status_idx on public.books_journal_proposals (org_id, status, proposed_at desc);

create trigger books_debt_events_immutable before update or delete on public.books_debt_events
  for each row execute function public.books_reject_mutation();
create trigger books_fixed_asset_events_immutable before update or delete on public.books_fixed_asset_events
  for each row execute function public.books_reject_mutation();
create trigger books_greenfield_launches_immutable before update or delete on public.books_greenfield_launches
  for each row execute function public.books_reject_mutation();

create or replace function public.books_guard_journal_proposal()
returns trigger language plpgsql set search_path = public, pg_catalog as $$
begin
  if tg_op = 'DELETE' then raise exception 'Journal proposals cannot be deleted'; end if;
  if old.status <> 'pending' then raise exception 'Reviewed journal proposals are immutable'; end if;
  if new.org_id <> old.org_id or new.entry_date <> old.entry_date or new.memo <> old.memo or new.posting_key <> old.posting_key or new.lines <> old.lines or new.proposed_by <> old.proposed_by then
    raise exception 'Journal proposal economics are immutable';
  end if;
  return new;
end;
$$;
create trigger books_journal_proposals_guard before update or delete on public.books_journal_proposals
  for each row execute function public.books_guard_journal_proposal();

create or replace function public.post_books_registered_subledger_event_atomic(
  p_org_id uuid,
  p_register text,
  p_parent_id uuid,
  p_event jsonb,
  p_entry jsonb,
  p_lines jsonb
) returns uuid
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  journal_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':' || p_register || ':' || p_parent_id::text, 0));
  if p_register = 'debt' then
    if not exists (select 1 from public.books_debt_instruments where id = p_parent_id and org_id = p_org_id) then
      raise exception 'Debt instrument does not belong to the organization';
    end if;
  elsif p_register = 'fixed_asset' then
    if not exists (select 1 from public.books_fixed_assets where id = p_parent_id and org_id = p_org_id) then
      raise exception 'Fixed asset does not belong to the organization';
    end if;
  else
    raise exception 'Unknown Books register %', p_register;
  end if;

  journal_id := public.post_books_journal_entry(p_org_id, p_entry, p_lines);
  if p_register = 'debt' then
    insert into public.books_debt_events (
      org_id, instrument_id, event_type, event_date, principal_cents,
      interest_cents, fee_cents, journal_entry_id, event_key, memo, created_by
    ) values (
      p_org_id, p_parent_id, p_event ->> 'event_type', (p_event ->> 'event_date')::date,
      coalesce((p_event ->> 'principal_cents')::bigint, 0), coalesce((p_event ->> 'interest_cents')::bigint, 0),
      coalesce((p_event ->> 'fee_cents')::bigint, 0), journal_id, p_event ->> 'event_key',
      p_event ->> 'memo', nullif(p_event ->> 'created_by', '')::uuid
    );
  else
    insert into public.books_fixed_asset_events (
      org_id, asset_id, event_type, event_date, amount_cents, proceeds_cents,
      journal_entry_id, event_key, memo, created_by
    ) values (
      p_org_id, p_parent_id, p_event ->> 'event_type', (p_event ->> 'event_date')::date,
      (p_event ->> 'amount_cents')::bigint, coalesce((p_event ->> 'proceeds_cents')::bigint, 0),
      journal_id, p_event ->> 'event_key', p_event ->> 'memo', nullif(p_event ->> 'created_by', '')::uuid
    );
    if p_event ->> 'event_type' = 'disposal' then
      update public.books_fixed_assets
      set status = 'disposed', disposed_on = (p_event ->> 'event_date')::date, updated_at = now()
      where id = p_parent_id and org_id = p_org_id and status <> 'disposed';
      if not found then raise exception 'The fixed asset is already disposed'; end if;
    end if;
  end if;
  return journal_id;
end;
$$;

create or replace function public.launch_books_greenfield_atomic(
  p_org_id uuid,
  p_actor_id uuid,
  p_launched_on date,
  p_opening_position text,
  p_attestation text
) returns uuid
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  launch_id uuid;
  digest text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':greenfield-launch', 0));
  if p_attestation <> 'I confirm Arc Books contains the complete opening position and will be the sole accounting ledger.' then
    raise exception 'The greenfield launch attestation does not match';
  end if;
  if p_opening_position not in ('zero','posted_opening_balances') then raise exception 'Invalid opening position'; end if;
  if exists (select 1 from public.accounting_connections where org_id = p_org_id and status = 'active') then
    raise exception 'Greenfield launch is unavailable while an external accounting connection is active';
  end if;
  if exists (select 1 from public.bank_accounts where org_id = p_org_id and active and gl_account_id is null) then
    raise exception 'Every active bank account must be mapped to the chart';
  end if;
  if exists (select 1 from public.journal_entries where org_id = p_org_id and status = 'draft') then
    raise exception 'Draft journals must be resolved before launch';
  end if;
  if p_opening_position = 'posted_opening_balances' and not exists (
    select 1 from public.opening_balance_batches where org_id = p_org_id and status = 'posted'
  ) then raise exception 'A posted opening-balance batch is required'; end if;
  if p_opening_position = 'zero' and exists (
    select 1 from public.opening_balance_batches where org_id = p_org_id and status = 'posted'
  ) then raise exception 'Choose posted opening balances for this organization'; end if;
  if not exists (select 1 from public.accounting_periods where org_id = p_org_id and p_launched_on between period_start and period_end) then
    raise exception 'An accounting period must cover the launch date';
  end if;

  digest := encode(digest(p_org_id::text || ':' || p_actor_id::text || ':' || p_launched_on::text || ':' || p_opening_position, 'sha256'), 'hex');
  insert into public.books_greenfield_launches (org_id, launched_on, opening_position, attestation, launch_digest, launched_by)
  values (p_org_id, p_launched_on, p_opening_position, p_attestation, digest)
  returning id into launch_id;
  update public.books_settings
  set ledger_authority = 'arc', arc_ledger_mode = 'official', external_sync_posture = 'disconnected',
      authoritative_at = now(), authoritative_by = p_actor_id, updated_by = p_actor_id, updated_at = now()
  where org_id = p_org_id and ledger_authority = 'external';
  if not found then raise exception 'Arc Books must be initialized in external/shadow posture before greenfield launch'; end if;
  return launch_id;
end;
$$;

create or replace function public.review_books_journal_proposal_atomic(
  p_org_id uuid,
  p_proposal_id uuid,
  p_reviewer_id uuid,
  p_decision text,
  p_note text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare proposal public.books_journal_proposals%rowtype; journal_id uuid; reversal_id uuid;
begin
  select * into proposal from public.books_journal_proposals
  where id = p_proposal_id and org_id = p_org_id for update;
  if not found or proposal.status <> 'pending' then raise exception 'Pending journal proposal not found'; end if;
  if proposal.proposed_by = p_reviewer_id then raise exception 'The proposal maker cannot approve their own entry'; end if;
  if p_decision not in ('approve','reject') then raise exception 'Unknown review decision'; end if;
  if p_decision = 'reject' then
    if length(btrim(coalesce(p_note, ''))) < 4 then raise exception 'A rejection note is required'; end if;
    update public.books_journal_proposals set status = 'rejected', reviewed_by = p_reviewer_id, reviewed_at = now(), review_note = p_note where id = proposal.id;
    return jsonb_build_object('status','rejected');
  end if;
  journal_id := public.post_books_journal_entry(p_org_id, jsonb_build_object(
    'entry_date', proposal.entry_date, 'entry_kind', 'adjusting', 'memo', proposal.memo,
    'posting_key', proposal.posting_key, 'projection_version', 1, 'policy_version', proposal.policy_version,
    'created_by', proposal.proposed_by
  ), proposal.lines);
  if proposal.reversing_on is not null then
    reversal_id := public.post_books_journal_entry(p_org_id, jsonb_build_object(
      'entry_date', proposal.reversing_on, 'entry_kind', 'reversal', 'memo', 'Automatic reversal: ' || proposal.memo,
      'posting_key', 'scheduled_reversal:' || journal_id::text || ':' || proposal.reversing_on::text,
      'projection_version', 1, 'policy_version', proposal.policy_version, 'reversal_of_entry_id', journal_id,
      'created_by', proposal.proposed_by
    ), (
      select jsonb_agg(item || jsonb_build_object('debit_cents', item -> 'credit_cents', 'credit_cents', item -> 'debit_cents') order by (item ->> 'line_no')::integer)
      from jsonb_array_elements(proposal.lines) item
    ));
  end if;
  update public.books_journal_proposals set status = 'posted', reviewed_by = p_reviewer_id, reviewed_at = now(), review_note = nullif(p_note,''), journal_entry_id = journal_id, reversal_entry_id = reversal_id where id = proposal.id;
  return jsonb_build_object('status','posted','journal_entry_id',journal_id,'reversal_entry_id',reversal_id);
end;
$$;

create or replace function public.store_company_tax_identity_atomic(
  p_org_id uuid,
  p_company_id uuid,
  p_tin text,
  p_actor_id uuid
) returns uuid
language plpgsql
security definer
set search_path = public, vault, pg_catalog
as $$
declare secret_id uuid; identity_id uuid;
begin
  if p_tin !~ '^[0-9]{9}$' then raise exception 'A US taxpayer ID must contain exactly nine digits'; end if;
  if not exists (select 1 from public.companies where id = p_company_id and org_id = p_org_id) then raise exception 'Company not found'; end if;
  if exists (select 1 from public.tax_identity_refs where org_id = p_org_id and company_id = p_company_id and vault_provider = 'supabase_vault') then
    raise exception 'A vaulted tax identity already exists; use the controlled replacement workflow';
  end if;
  secret_id := vault.create_secret(p_tin, 'company-tin-' || p_company_id::text, 'Arc Books taxpayer identity; company ' || p_company_id::text);
  insert into public.tax_identity_refs (org_id, company_id, vault_provider, vault_reference, tin_last4, verification_status)
  values (p_org_id, p_company_id, 'supabase_vault', secret_id::text, right(p_tin, 4), 'pending')
  returning id into identity_id;
  update public.companies set tax_id_last4 = right(p_tin, 4), tin_verification_status = 'pending', updated_at = now() where id = p_company_id and org_id = p_org_id;
  return identity_id;
end;
$$;

create or replace function public.replace_company_tax_identity_atomic(
  p_org_id uuid,
  p_company_id uuid,
  p_tin text,
  p_actor_id uuid
) returns uuid
language plpgsql
security definer
set search_path = public, vault, pg_catalog
as $$
declare identity public.tax_identity_refs%rowtype;
begin
  if p_tin !~ '^[0-9]{9}$' then raise exception 'A US taxpayer ID must contain exactly nine digits'; end if;
  select * into identity from public.tax_identity_refs
  where org_id = p_org_id and company_id = p_company_id and vault_provider = 'supabase_vault'
  for update;
  if not found then raise exception 'No vaulted taxpayer identity exists for this company'; end if;
  perform vault.update_secret(
    identity.vault_reference::uuid,
    p_tin,
    'company-tin-' || p_company_id::text,
    'Arc Books taxpayer identity; company ' || p_company_id::text || '; rotated by ' || p_actor_id::text
  );
  update public.tax_identity_refs
  set tin_last4 = right(p_tin, 4), verification_status = 'pending', verified_at = null, updated_at = now()
  where id = identity.id;
  update public.companies
  set tax_id_last4 = right(p_tin, 4), tin_verification_status = 'pending', updated_at = now()
  where id = p_company_id and org_id = p_org_id;
  return identity.id;
end;
$$;

do $$
declare target record;
begin
  for target in select * from (values
    ('books_debt_instruments','books.read'), ('books_debt_events','books.read'),
    ('books_fixed_assets','books.read'), ('books_fixed_asset_events','books.read'),
    ('books_tax_jurisdictions','books.tax'), ('books_tax_filings','books.tax'),
    ('books_greenfield_launches','books.read')
    ,('books_journal_proposals','books.read')
  ) as v(table_name, permission_key)
  loop
    execute format('alter table public.%I enable row level security', target.table_name);
    execute format('create policy %I on public.%I for select to authenticated using (public.has_org_permission(org_id, %L))', target.table_name || '_read', target.table_name, target.permission_key);
    execute format('grant select on public.%I to authenticated', target.table_name);
    execute format('grant all on public.%I to service_role', target.table_name);
  end loop;
end;
$$;

revoke all on function public.post_books_registered_subledger_event_atomic(uuid, text, uuid, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.launch_books_greenfield_atomic(uuid, uuid, date, text, text) from public, anon, authenticated;
revoke all on function public.review_books_journal_proposal_atomic(uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.store_company_tax_identity_atomic(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.replace_company_tax_identity_atomic(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.post_books_registered_subledger_event_atomic(uuid, text, uuid, jsonb, jsonb, jsonb) to service_role;
grant execute on function public.launch_books_greenfield_atomic(uuid, uuid, date, text, text) to service_role;
grant execute on function public.review_books_journal_proposal_atomic(uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.store_company_tax_identity_atomic(uuid, uuid, text, uuid) to service_role;
grant execute on function public.replace_company_tax_identity_atomic(uuid, uuid, text, uuid) to service_role;
revoke all on function public.books_guard_journal_proposal() from public, anon, authenticated;

commit;
