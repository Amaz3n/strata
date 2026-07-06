create or replace function public.directory_normalize_name(value text)
returns text
language sql
immutable
as $$
  select nullif(regexp_replace(lower(coalesce(value, '')), '[^a-z0-9]+', '', 'g'), '');
$$;

grant execute on function public.directory_normalize_name(text) to authenticated;
grant execute on function public.directory_normalize_name(text) to service_role;

create table if not exists public.directory_relationship_types (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  key text not null,
  label text not null,
  canonical_category text not null default 'other',
  applies_to text not null default 'both'
    check (applies_to in ('company', 'contact', 'both')),
  is_system boolean not null default false,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, key)
);

create index if not exists directory_relationship_types_org_active_idx
  on public.directory_relationship_types (org_id, is_active, sort_order, label);

create table if not exists public.directory_trades (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null,
  normalized_name text not null,
  csi_division_code text,
  cost_code_id uuid references public.cost_codes(id) on delete set null,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, normalized_name)
);

create index if not exists directory_trades_org_active_idx
  on public.directory_trades (org_id, is_active, name);

create index if not exists directory_trades_cost_code_idx
  on public.directory_trades (org_id, cost_code_id)
  where cost_code_id is not null;

alter table if exists public.companies
  add column if not exists relationship_type_id uuid references public.directory_relationship_types(id) on delete set null;

alter table if exists public.companies
  add column if not exists trade_id uuid references public.directory_trades(id) on delete set null;

alter table if exists public.contacts
  add column if not exists relationship_type_id uuid references public.directory_relationship_types(id) on delete set null;

create index if not exists companies_relationship_type_idx
  on public.companies (org_id, relationship_type_id)
  where relationship_type_id is not null;

create index if not exists companies_trade_id_idx
  on public.companies (org_id, trade_id)
  where trade_id is not null;

create index if not exists contacts_relationship_type_idx
  on public.contacts (org_id, relationship_type_id)
  where relationship_type_id is not null;

insert into public.directory_relationship_types
  (org_id, key, label, canonical_category, applies_to, is_system, sort_order)
select
  orgs.id,
  seed.key,
  seed.label,
  seed.canonical_category,
  seed.applies_to,
  true,
  seed.sort_order
from public.orgs
cross join (
  values
    ('subcontractor', 'Subcontractor', 'vendor', 'both', 10),
    ('supplier', 'Supplier', 'vendor', 'company', 20),
    ('vendor', 'Vendor', 'vendor', 'contact', 30),
    ('consultant', 'Consultant', 'vendor', 'contact', 40),
    ('client', 'Client', 'client', 'both', 50),
    ('architect', 'Architect', 'design', 'company', 60),
    ('engineer', 'Engineer', 'design', 'company', 70),
    ('internal', 'Internal', 'internal', 'contact', 80),
    ('other', 'Other', 'other', 'both', 90)
) as seed(key, label, canonical_category, applies_to, sort_order)
on conflict (org_id, key) do update
set
  label = excluded.label,
  canonical_category = excluded.canonical_category,
  applies_to = excluded.applies_to,
  is_system = true,
  sort_order = excluded.sort_order,
  updated_at = now();

insert into public.directory_trades (org_id, name, normalized_name, metadata)
select distinct
  companies.org_id,
  trim(companies.metadata->>'trade') as name,
  public.directory_normalize_name(companies.metadata->>'trade') as normalized_name,
  jsonb_build_object('source', 'companies.metadata.trade')
from public.companies
where nullif(trim(companies.metadata->>'trade'), '') is not null
  and public.directory_normalize_name(companies.metadata->>'trade') is not null
on conflict (org_id, normalized_name) do update
set
  name = excluded.name,
  is_active = true,
  metadata = public.directory_trades.metadata || excluded.metadata,
  updated_at = now();

update public.companies as companies
set relationship_type_id = relationship_types.id
from public.directory_relationship_types as relationship_types
where companies.org_id = relationship_types.org_id
  and relationship_types.key = case
    when companies.company_type in ('subcontractor', 'supplier', 'client', 'architect', 'engineer') then companies.company_type
    else 'other'
  end
  and companies.relationship_type_id is null;

update public.companies as companies
set trade_id = trades.id
from public.directory_trades as trades
where companies.org_id = trades.org_id
  and public.directory_normalize_name(companies.metadata->>'trade') = trades.normalized_name
  and companies.trade_id is null;

update public.contacts as contacts
set relationship_type_id = relationship_types.id
from public.directory_relationship_types as relationship_types
where contacts.org_id = relationship_types.org_id
  and relationship_types.key = case
    when contacts.contact_type in ('internal', 'subcontractor', 'client', 'vendor', 'consultant') then contacts.contact_type
    else 'other'
  end
  and contacts.relationship_type_id is null;

insert into public.compliance_document_types
  (org_id, name, code, description, has_expiry, expiry_warning_days, is_system, is_active)
select
  orgs.id,
  'W-9',
  'w9',
  'Request for Taxpayer Identification Number and Certification for year-end 1099 readiness.',
  false,
  0,
  true,
  true
from public.orgs
on conflict (org_id, code) do update
set
  name = excluded.name,
  description = excluded.description,
  has_expiry = excluded.has_expiry,
  expiry_warning_days = excluded.expiry_warning_days,
  is_system = true,
  is_active = true;

create table if not exists public.compliance_autopilot_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  metrics jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists compliance_autopilot_runs_org_started_idx
  on public.compliance_autopilot_runs (org_id, started_at desc);

create table if not exists public.compliance_autopilot_deliveries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  run_id uuid references public.compliance_autopilot_runs(id) on delete set null,
  company_id uuid not null references public.companies(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  document_type_id uuid not null references public.compliance_document_types(id) on delete cascade,
  requirement_id uuid references public.company_compliance_requirements(id) on delete set null,
  document_id uuid references public.compliance_documents(id) on delete set null,
  reminder_kind text not null
    check (reminder_kind in ('missing', 'expiring', 'expired', 'pm_digest')),
  reminder_bucket text not null,
  recipient_email text,
  recipient_name text,
  subject text,
  portal_url text,
  status text not null default 'queued'
    check (status in ('queued', 'sent', 'skipped', 'failed')),
  payload jsonb not null default '{}'::jsonb,
  idempotency_key text not null,
  sent_at timestamptz,
  delivered_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, idempotency_key)
);

create index if not exists compliance_autopilot_deliveries_org_created_idx
  on public.compliance_autopilot_deliveries (org_id, created_at desc);

create index if not exists compliance_autopilot_deliveries_company_idx
  on public.compliance_autopilot_deliveries (org_id, company_id, created_at desc);

create table if not exists public.vendor_scorecards (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  score numeric(5,2) not null default 0,
  rating_label text not null default 'Needs data',
  on_time_bill_rate numeric(5,4),
  bid_response_rate numeric(5,4),
  bid_win_rate numeric(5,4),
  change_order_rate numeric(5,4),
  daily_log_mention_count integer not null default 0,
  warranty_callback_count integer not null default 0,
  invoice_issue_count integer not null default 0,
  committed_cents bigint not null default 0,
  billed_cents bigint not null default 0,
  paid_cents bigint not null default 0,
  metrics jsonb not null default '{}'::jsonb,
  computed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, company_id, period_start, period_end)
);

create index if not exists vendor_scorecards_org_score_idx
  on public.vendor_scorecards (org_id, score desc, computed_at desc);

create index if not exists vendor_scorecards_company_idx
  on public.vendor_scorecards (org_id, company_id, period_end desc);

create table if not exists public.directory_merge_candidates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  entity_type text not null check (entity_type in ('company', 'contact')),
  primary_company_id uuid references public.companies(id) on delete cascade,
  duplicate_company_id uuid references public.companies(id) on delete cascade,
  primary_contact_id uuid references public.contacts(id) on delete cascade,
  duplicate_contact_id uuid references public.contacts(id) on delete cascade,
  confidence numeric(4,3) not null default 0.5 check (confidence >= 0 and confidence <= 1),
  reason_codes text[] not null default array[]::text[],
  evidence jsonb not null default '{}'::jsonb,
  status text not null default 'open'
    check (status in ('open', 'dismissed', 'merged')),
  detected_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.app_users(id) on delete set null,
  resolution_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (
      entity_type = 'company'
      and primary_company_id is not null
      and duplicate_company_id is not null
      and primary_company_id <> duplicate_company_id
      and primary_contact_id is null
      and duplicate_contact_id is null
    )
    or
    (
      entity_type = 'contact'
      and primary_contact_id is not null
      and duplicate_contact_id is not null
      and primary_contact_id <> duplicate_contact_id
      and primary_company_id is null
      and duplicate_company_id is null
    )
  )
);

create unique index if not exists directory_merge_candidates_company_open_key
  on public.directory_merge_candidates (org_id, primary_company_id, duplicate_company_id)
  where entity_type = 'company' and status = 'open';

create unique index if not exists directory_merge_candidates_contact_open_key
  on public.directory_merge_candidates (org_id, primary_contact_id, duplicate_contact_id)
  where entity_type = 'contact' and status = 'open';

create index if not exists directory_merge_candidates_org_status_idx
  on public.directory_merge_candidates (org_id, status, confidence desc, detected_at desc);

create table if not exists public.vendor_tax_readiness (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  tax_year integer not null,
  requires_1099 boolean not null default false,
  w9_document_type_id uuid references public.compliance_document_types(id) on delete set null,
  w9_document_id uuid references public.compliance_documents(id) on delete set null,
  w9_status text not null default 'missing'
    check (w9_status in ('ready', 'missing', 'pending_review', 'rejected', 'not_required')),
  qbo_vendor_id text,
  qbo_vendor_name text,
  paid_cents bigint not null default 0,
  bill_count integer not null default 0,
  last_bill_date date,
  last_checked_at timestamptz not null default now(),
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, company_id, tax_year)
);

create index if not exists vendor_tax_readiness_org_year_status_idx
  on public.vendor_tax_readiness (org_id, tax_year, requires_1099, w9_status);

create index if not exists vendor_tax_readiness_company_idx
  on public.vendor_tax_readiness (org_id, company_id, tax_year desc);

create or replace function public.refresh_vendor_tax_readiness(
  p_org_id uuid default null,
  p_tax_year integer default extract(year from current_date)::integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
  v_threshold_cents integer := case when p_tax_year >= 2026 then 200000 else 60000 end;
begin
  insert into public.compliance_document_types
    (org_id, name, code, description, has_expiry, expiry_warning_days, is_system, is_active)
  select
    orgs.id,
    'W-9',
    'w9',
    'Request for Taxpayer Identification Number and Certification for year-end 1099 readiness.',
    false,
    0,
    true,
    true
  from public.orgs
  where p_org_id is null or orgs.id = p_org_id
  on conflict (org_id, code) do update
  set
    name = excluded.name,
    description = excluded.description,
    has_expiry = excluded.has_expiry,
    expiry_warning_days = excluded.expiry_warning_days,
    is_system = true,
    is_active = true;

  with vendor_companies as (
    select
      companies.id,
      companies.org_id,
      companies.name,
      companies.company_type,
      companies.qbo_vendor_id,
      companies.qbo_vendor_name
    from public.companies
    left join public.directory_relationship_types as relationship_types
      on relationship_types.id = companies.relationship_type_id
    where (p_org_id is null or companies.org_id = p_org_id)
      and companies.metadata->>'archived_at' is null
      and (
        companies.company_type in ('subcontractor', 'supplier')
        or relationship_types.canonical_category = 'vendor'
      )
  ),
  w9_types as (
    select id, org_id
    from public.compliance_document_types
    where code = 'w9'
  ),
  paid as (
    select
      vendor_bills.org_id,
      vendor_bills.company_id,
      count(*)::integer as bill_count,
      coalesce(
        sum(
          coalesce(
            vendor_bills.paid_cents,
            case when vendor_bills.status = 'paid' then vendor_bills.total_cents::bigint else 0 end
          )
        ),
        0
      )::bigint as paid_cents,
      max(coalesce(vendor_bills.bill_date, vendor_bills.created_at::date)) as last_bill_date
    from public.vendor_bills
    where vendor_bills.company_id is not null
      and (p_org_id is null or vendor_bills.org_id = p_org_id)
      and coalesce(vendor_bills.paid_at::date, vendor_bills.bill_date, vendor_bills.created_at::date)
        between make_date(p_tax_year, 1, 1) and make_date(p_tax_year, 12, 31)
    group by vendor_bills.org_id, vendor_bills.company_id
  ),
  upserted as (
    insert into public.vendor_tax_readiness (
      org_id,
      company_id,
      tax_year,
      requires_1099,
      w9_document_type_id,
      w9_document_id,
      w9_status,
      qbo_vendor_id,
      qbo_vendor_name,
      paid_cents,
      bill_count,
      last_bill_date,
      last_checked_at,
      metadata,
      updated_at
    )
    select
      vendor_companies.org_id,
      vendor_companies.id,
      p_tax_year,
      coalesce(paid.paid_cents, 0) >= v_threshold_cents,
      w9_types.id,
      latest_w9.id,
      case
        when coalesce(paid.paid_cents, 0) < v_threshold_cents then 'not_required'
        when latest_w9.status = 'approved' then 'ready'
        when latest_w9.status in ('pending_review', 'submitted') then 'pending_review'
        when latest_w9.status = 'rejected' then 'rejected'
        else 'missing'
      end,
      vendor_companies.qbo_vendor_id,
      vendor_companies.qbo_vendor_name,
      coalesce(paid.paid_cents, 0),
      coalesce(paid.bill_count, 0),
      paid.last_bill_date,
      now(),
      jsonb_build_object('threshold_cents', v_threshold_cents, 'source', 'vendor_bills'),
      now()
    from vendor_companies
    join w9_types
      on w9_types.org_id = vendor_companies.org_id
    left join paid
      on paid.org_id = vendor_companies.org_id
      and paid.company_id = vendor_companies.id
    left join lateral (
      select compliance_documents.id, compliance_documents.status
      from public.compliance_documents
      where compliance_documents.org_id = vendor_companies.org_id
        and compliance_documents.company_id = vendor_companies.id
        and compliance_documents.document_type_id = w9_types.id
      order by
        case compliance_documents.status
          when 'approved' then 1
          when 'pending_review' then 2
          when 'submitted' then 3
          when 'rejected' then 4
          else 5
        end,
        compliance_documents.created_at desc
      limit 1
    ) as latest_w9 on true
    on conflict (org_id, company_id, tax_year) do update
    set
      requires_1099 = excluded.requires_1099,
      w9_document_type_id = excluded.w9_document_type_id,
      w9_document_id = excluded.w9_document_id,
      w9_status = excluded.w9_status,
      qbo_vendor_id = excluded.qbo_vendor_id,
      qbo_vendor_name = excluded.qbo_vendor_name,
      paid_cents = excluded.paid_cents,
      bill_count = excluded.bill_count,
      last_bill_date = excluded.last_bill_date,
      last_checked_at = excluded.last_checked_at,
      metadata = excluded.metadata,
      updated_at = now()
    returning 1
  )
  select count(*) into v_count from upserted;

  return coalesce(v_count, 0);
end;
$$;

create or replace function public.refresh_vendor_scorecards(
  p_org_id uuid default null,
  p_period_start date default (current_date - interval '365 days')::date,
  p_period_end date default current_date
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
begin
  with vendor_companies as (
    select
      companies.id,
      companies.org_id,
      companies.name,
      companies.company_type
    from public.companies
    left join public.directory_relationship_types as relationship_types
      on relationship_types.id = companies.relationship_type_id
    where (p_org_id is null or companies.org_id = p_org_id)
      and companies.metadata->>'archived_at' is null
      and (
        companies.company_type in ('subcontractor', 'supplier')
        or relationship_types.canonical_category = 'vendor'
      )
  ),
  bill_metrics as (
    select
      vendor_bills.org_id,
      vendor_bills.company_id,
      count(*) filter (where vendor_bills.paid_at is not null and vendor_bills.due_date is not null)::integer as paid_bill_count,
      count(*) filter (
        where vendor_bills.paid_at is not null
          and vendor_bills.due_date is not null
          and vendor_bills.paid_at::date <= vendor_bills.due_date
      )::integer as on_time_bill_count,
      count(*) filter (
        where vendor_bills.status in ('rejected', 'disputed')
          or vendor_bills.qbo_sync_status = 'error'
      )::integer as invoice_issue_count,
      coalesce(sum(vendor_bills.total_cents), 0)::bigint as billed_cents,
      coalesce(sum(coalesce(vendor_bills.paid_cents, 0)), 0)::bigint as paid_cents
    from public.vendor_bills
    where vendor_bills.company_id is not null
      and (p_org_id is null or vendor_bills.org_id = p_org_id)
      and coalesce(vendor_bills.bill_date, vendor_bills.created_at::date) between p_period_start and p_period_end
    group by vendor_bills.org_id, vendor_bills.company_id
  ),
  commitment_metrics as (
    select
      commitments.org_id,
      commitments.company_id,
      count(*)::integer as commitment_count,
      coalesce(sum(commitments.total_cents), 0)::bigint as committed_cents
    from public.commitments
    where commitments.company_id is not null
      and (p_org_id is null or commitments.org_id = p_org_id)
      and commitments.created_at::date between p_period_start and p_period_end
    group by commitments.org_id, commitments.company_id
  ),
  change_order_metrics as (
    select
      vendor_companies.org_id,
      vendor_companies.id as company_id,
      count(change_orders.id)::integer as change_order_count
    from vendor_companies
    left join public.change_orders
      on change_orders.org_id = vendor_companies.org_id
      and change_orders.created_at::date between p_period_start and p_period_end
      and (
        change_orders.metadata->>'company_id' = vendor_companies.id::text
        or change_orders.metadata->>'vendor_company_id' = vendor_companies.id::text
        or change_orders.metadata->>'commitment_company_id' = vendor_companies.id::text
      )
    group by vendor_companies.org_id, vendor_companies.id
  ),
  bid_metrics as (
    select
      bid_invites.org_id,
      bid_invites.company_id,
      count(distinct bid_invites.id)::integer as invite_count,
      count(distinct bid_submissions.bid_invite_id)::integer as response_count,
      count(distinct bid_awards.id)::integer as award_count
    from public.bid_invites
    left join public.bid_submissions
      on bid_submissions.org_id = bid_invites.org_id
      and bid_submissions.bid_invite_id = bid_invites.id
    left join public.bid_awards
      on bid_awards.org_id = bid_invites.org_id
      and bid_awards.awarded_submission_id = bid_submissions.id
    where (p_org_id is null or bid_invites.org_id = p_org_id)
      and bid_invites.created_at::date between p_period_start and p_period_end
    group by bid_invites.org_id, bid_invites.company_id
  ),
  daily_log_metrics as (
    select
      vendor_companies.org_id,
      vendor_companies.id as company_id,
      count(daily_log_entries.id)::integer as daily_log_mention_count
    from vendor_companies
    left join public.daily_log_entries
      on daily_log_entries.org_id = vendor_companies.org_id
      and daily_log_entries.created_at::date between p_period_start and p_period_end
      and (
        daily_log_entries.metadata->>'company_id' = vendor_companies.id::text
        or daily_log_entries.description ilike ('%' || vendor_companies.name || '%')
      )
    group by vendor_companies.org_id, vendor_companies.id
  ),
  scored as (
    select
      vendor_companies.org_id,
      vendor_companies.id as company_id,
      coalesce(commitment_metrics.committed_cents, 0) as committed_cents,
      coalesce(bill_metrics.billed_cents, 0) as billed_cents,
      coalesce(bill_metrics.paid_cents, 0) as paid_cents,
      coalesce(bill_metrics.invoice_issue_count, 0) as invoice_issue_count,
      coalesce(daily_log_metrics.daily_log_mention_count, 0) as daily_log_mention_count,
      coalesce(change_order_metrics.change_order_count, 0) as change_order_count,
      coalesce(commitment_metrics.commitment_count, 0) as commitment_count,
      coalesce(bid_metrics.invite_count, 0) as invite_count,
      coalesce(bid_metrics.response_count, 0) as response_count,
      coalesce(bid_metrics.award_count, 0) as award_count,
      case
        when coalesce(bill_metrics.paid_bill_count, 0) = 0 then null
        else bill_metrics.on_time_bill_count::numeric / nullif(bill_metrics.paid_bill_count, 0)
      end as on_time_bill_rate,
      case
        when coalesce(bid_metrics.invite_count, 0) = 0 then null
        else bid_metrics.response_count::numeric / nullif(bid_metrics.invite_count, 0)
      end as bid_response_rate,
      case
        when coalesce(bid_metrics.invite_count, 0) = 0 then null
        else bid_metrics.award_count::numeric / nullif(bid_metrics.invite_count, 0)
      end as bid_win_rate,
      case
        when coalesce(commitment_metrics.commitment_count, 0) = 0 then null
        else change_order_metrics.change_order_count::numeric / nullif(commitment_metrics.commitment_count, 0)
      end as change_order_rate
    from vendor_companies
    left join bill_metrics
      on bill_metrics.org_id = vendor_companies.org_id
      and bill_metrics.company_id = vendor_companies.id
    left join commitment_metrics
      on commitment_metrics.org_id = vendor_companies.org_id
      and commitment_metrics.company_id = vendor_companies.id
    left join change_order_metrics
      on change_order_metrics.org_id = vendor_companies.org_id
      and change_order_metrics.company_id = vendor_companies.id
    left join bid_metrics
      on bid_metrics.org_id = vendor_companies.org_id
      and bid_metrics.company_id = vendor_companies.id
    left join daily_log_metrics
      on daily_log_metrics.org_id = vendor_companies.org_id
      and daily_log_metrics.company_id = vendor_companies.id
  ),
  final_scores as (
    select
      scored.*,
      least(
        100::numeric,
        greatest(
          0::numeric,
          round(
            55::numeric
            + (coalesce(scored.on_time_bill_rate, 0.75) * 20)
            + (coalesce(scored.bid_response_rate, 0.50) * 12)
            + (coalesce(scored.bid_win_rate, 0.15) * 8)
            - least(coalesce(scored.invoice_issue_count, 0) * 4, 16)
            - least(coalesce(scored.change_order_rate, 0) * 12, 12)
          )
        )
      ) as score
    from scored
  ),
  upserted as (
    insert into public.vendor_scorecards (
      org_id,
      company_id,
      period_start,
      period_end,
      score,
      rating_label,
      on_time_bill_rate,
      bid_response_rate,
      bid_win_rate,
      change_order_rate,
      daily_log_mention_count,
      warranty_callback_count,
      invoice_issue_count,
      committed_cents,
      billed_cents,
      paid_cents,
      metrics,
      computed_at,
      updated_at
    )
    select
      final_scores.org_id,
      final_scores.company_id,
      p_period_start,
      p_period_end,
      final_scores.score,
      case
        when final_scores.committed_cents = 0
          and final_scores.billed_cents = 0
          and final_scores.invite_count = 0 then 'Needs data'
        when final_scores.score >= 85 then 'Strong'
        when final_scores.score >= 70 then 'Solid'
        when final_scores.score >= 55 then 'Watch'
        else 'Risk'
      end,
      final_scores.on_time_bill_rate,
      final_scores.bid_response_rate,
      final_scores.bid_win_rate,
      final_scores.change_order_rate,
      final_scores.daily_log_mention_count,
      0,
      final_scores.invoice_issue_count,
      final_scores.committed_cents,
      final_scores.billed_cents,
      final_scores.paid_cents,
      jsonb_build_object(
        'invite_count', final_scores.invite_count,
        'response_count', final_scores.response_count,
        'award_count', final_scores.award_count,
        'commitment_count', final_scores.commitment_count,
        'change_order_count', final_scores.change_order_count,
        'period_start', p_period_start,
        'period_end', p_period_end
      ),
      now(),
      now()
    from final_scores
    on conflict (org_id, company_id, period_start, period_end) do update
    set
      score = excluded.score,
      rating_label = excluded.rating_label,
      on_time_bill_rate = excluded.on_time_bill_rate,
      bid_response_rate = excluded.bid_response_rate,
      bid_win_rate = excluded.bid_win_rate,
      change_order_rate = excluded.change_order_rate,
      daily_log_mention_count = excluded.daily_log_mention_count,
      warranty_callback_count = excluded.warranty_callback_count,
      invoice_issue_count = excluded.invoice_issue_count,
      committed_cents = excluded.committed_cents,
      billed_cents = excluded.billed_cents,
      paid_cents = excluded.paid_cents,
      metrics = excluded.metrics,
      computed_at = excluded.computed_at,
      updated_at = now()
    returning 1
  )
  select count(*) into v_count from upserted;

  return coalesce(v_count, 0);
end;
$$;

create or replace function public.detect_directory_merge_candidates(p_org_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_count integer := 0;
  v_contact_count integer := 0;
begin
  with company_pairs as (
    select
      a.org_id,
      a.id as primary_company_id,
      b.id as duplicate_company_id,
      case
        when nullif(a.qbo_vendor_id, '') is not null and a.qbo_vendor_id = b.qbo_vendor_id then 0.98
        when lower(coalesce(a.email, '')) <> '' and lower(a.email) = lower(b.email) then 0.92
        else 0.86
      end::numeric(4,3) as confidence,
      array_remove(array[
        case when public.directory_normalize_name(a.name) = public.directory_normalize_name(b.name) then 'same_name' end,
        case when lower(coalesce(a.email, '')) <> '' and lower(a.email) = lower(b.email) then 'same_email' end,
        case when nullif(a.qbo_vendor_id, '') is not null and a.qbo_vendor_id = b.qbo_vendor_id then 'same_qbo_vendor' end
      ], null)::text[] as reason_codes,
      jsonb_build_object(
        'primary_name', a.name,
        'duplicate_name', b.name,
        'primary_email', a.email,
        'duplicate_email', b.email,
        'primary_qbo_vendor_id', a.qbo_vendor_id,
        'duplicate_qbo_vendor_id', b.qbo_vendor_id
      ) as evidence
    from public.companies a
    join public.companies b
      on b.org_id = a.org_id
      and a.id < b.id
      and b.metadata->>'archived_at' is null
    where (p_org_id is null or a.org_id = p_org_id)
      and a.metadata->>'archived_at' is null
      and (
        public.directory_normalize_name(a.name) = public.directory_normalize_name(b.name)
        or (
          lower(coalesce(a.email, '')) <> ''
          and lower(a.email) = lower(coalesce(b.email, ''))
        )
        or (
          nullif(a.qbo_vendor_id, '') is not null
          and a.qbo_vendor_id = b.qbo_vendor_id
        )
      )
  ),
  inserted as (
    insert into public.directory_merge_candidates (
      org_id,
      entity_type,
      primary_company_id,
      duplicate_company_id,
      confidence,
      reason_codes,
      evidence
    )
    select
      company_pairs.org_id,
      'company',
      company_pairs.primary_company_id,
      company_pairs.duplicate_company_id,
      company_pairs.confidence,
      company_pairs.reason_codes,
      company_pairs.evidence
    from company_pairs
    on conflict (org_id, primary_company_id, duplicate_company_id)
      where entity_type = 'company' and status = 'open'
    do update
    set
      confidence = excluded.confidence,
      reason_codes = excluded.reason_codes,
      evidence = excluded.evidence,
      detected_at = now(),
      updated_at = now()
    returning 1
  )
  select count(*) into v_company_count from inserted;

  with contact_pairs as (
    select
      a.org_id,
      a.id as primary_contact_id,
      b.id as duplicate_contact_id,
      case
        when lower(coalesce(a.email, '')) <> '' and lower(a.email) = lower(b.email) then 0.96
        else 0.82
      end::numeric(4,3) as confidence,
      array_remove(array[
        case when lower(coalesce(a.email, '')) <> '' and lower(a.email) = lower(b.email) then 'same_email' end,
        case when public.directory_normalize_name(a.full_name) = public.directory_normalize_name(b.full_name) then 'same_name' end,
        case when a.primary_company_id is not null and a.primary_company_id = b.primary_company_id then 'same_company' end
      ], null)::text[] as reason_codes,
      jsonb_build_object(
        'primary_name', a.full_name,
        'duplicate_name', b.full_name,
        'primary_email', a.email,
        'duplicate_email', b.email,
        'primary_company_id', a.primary_company_id,
        'duplicate_company_id', b.primary_company_id
      ) as evidence
    from public.contacts a
    join public.contacts b
      on b.org_id = a.org_id
      and a.id < b.id
      and b.metadata->>'archived_at' is null
    where (p_org_id is null or a.org_id = p_org_id)
      and a.metadata->>'archived_at' is null
      and (
        (
          lower(coalesce(a.email, '')) <> ''
          and lower(a.email) = lower(coalesce(b.email, ''))
        )
        or (
          public.directory_normalize_name(a.full_name) = public.directory_normalize_name(b.full_name)
          and a.primary_company_id is not null
          and a.primary_company_id = b.primary_company_id
        )
      )
  ),
  inserted as (
    insert into public.directory_merge_candidates (
      org_id,
      entity_type,
      primary_contact_id,
      duplicate_contact_id,
      confidence,
      reason_codes,
      evidence
    )
    select
      contact_pairs.org_id,
      'contact',
      contact_pairs.primary_contact_id,
      contact_pairs.duplicate_contact_id,
      contact_pairs.confidence,
      contact_pairs.reason_codes,
      contact_pairs.evidence
    from contact_pairs
    on conflict (org_id, primary_contact_id, duplicate_contact_id)
      where entity_type = 'contact' and status = 'open'
    do update
    set
      confidence = excluded.confidence,
      reason_codes = excluded.reason_codes,
      evidence = excluded.evidence,
      detected_at = now(),
      updated_at = now()
    returning 1
  )
  select count(*) into v_contact_count from inserted;

  return coalesce(v_company_count, 0) + coalesce(v_contact_count, 0);
end;
$$;

create or replace function public.refresh_directory_intelligence(p_org_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_scorecards integer := 0;
  v_tax integer := 0;
  v_merge integer := 0;
begin
  v_scorecards := public.refresh_vendor_scorecards(p_org_id);
  v_tax := public.refresh_vendor_tax_readiness(p_org_id);
  v_merge := public.detect_directory_merge_candidates(p_org_id);

  return jsonb_build_object(
    'scorecards', v_scorecards,
    'tax_readiness', v_tax,
    'merge_candidates', v_merge
  );
end;
$$;

grant execute on function public.refresh_vendor_tax_readiness(uuid, integer) to service_role;
grant execute on function public.refresh_vendor_scorecards(uuid, date, date) to service_role;
grant execute on function public.detect_directory_merge_candidates(uuid) to service_role;
grant execute on function public.refresh_directory_intelligence(uuid) to service_role;

do $$
begin
  if exists (select 1 from pg_proc where proname = 'tg_set_updated_at' and pronamespace = 'public'::regnamespace) then
    drop trigger if exists directory_relationship_types_set_updated_at on public.directory_relationship_types;
    create trigger directory_relationship_types_set_updated_at
      before update on public.directory_relationship_types
      for each row execute function public.tg_set_updated_at();

    drop trigger if exists directory_trades_set_updated_at on public.directory_trades;
    create trigger directory_trades_set_updated_at
      before update on public.directory_trades
      for each row execute function public.tg_set_updated_at();

    drop trigger if exists compliance_autopilot_runs_set_updated_at on public.compliance_autopilot_runs;
    create trigger compliance_autopilot_runs_set_updated_at
      before update on public.compliance_autopilot_runs
      for each row execute function public.tg_set_updated_at();

    drop trigger if exists compliance_autopilot_deliveries_set_updated_at on public.compliance_autopilot_deliveries;
    create trigger compliance_autopilot_deliveries_set_updated_at
      before update on public.compliance_autopilot_deliveries
      for each row execute function public.tg_set_updated_at();

    drop trigger if exists vendor_scorecards_set_updated_at on public.vendor_scorecards;
    create trigger vendor_scorecards_set_updated_at
      before update on public.vendor_scorecards
      for each row execute function public.tg_set_updated_at();

    drop trigger if exists directory_merge_candidates_set_updated_at on public.directory_merge_candidates;
    create trigger directory_merge_candidates_set_updated_at
      before update on public.directory_merge_candidates
      for each row execute function public.tg_set_updated_at();

    drop trigger if exists vendor_tax_readiness_set_updated_at on public.vendor_tax_readiness;
    create trigger vendor_tax_readiness_set_updated_at
      before update on public.vendor_tax_readiness
      for each row execute function public.tg_set_updated_at();
  end if;
end;
$$;

alter table public.directory_relationship_types enable row level security;
alter table public.directory_trades enable row level security;
alter table public.compliance_autopilot_runs enable row level security;
alter table public.compliance_autopilot_deliveries enable row level security;
alter table public.vendor_scorecards enable row level security;
alter table public.directory_merge_candidates enable row level security;
alter table public.vendor_tax_readiness enable row level security;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'directory_relationship_types',
    'directory_trades',
    'compliance_autopilot_runs',
    'compliance_autopilot_deliveries',
    'vendor_scorecards',
    'directory_merge_candidates',
    'vendor_tax_readiness'
  ]
  loop
    execute format('drop policy if exists %I on public.%I', table_name || '_access', table_name);
    execute format(
      'create policy %I on public.%I for all using ((auth.role() = ''service_role'') or public.is_org_member(org_id)) with check ((auth.role() = ''service_role'') or public.is_org_member(org_id))',
      table_name || '_access',
      table_name
    );
  end loop;
end;
$$;

grant all on table public.directory_relationship_types to authenticated;
grant all on table public.directory_relationship_types to service_role;
grant all on table public.directory_trades to authenticated;
grant all on table public.directory_trades to service_role;
grant all on table public.compliance_autopilot_runs to authenticated;
grant all on table public.compliance_autopilot_runs to service_role;
grant all on table public.compliance_autopilot_deliveries to authenticated;
grant all on table public.compliance_autopilot_deliveries to service_role;
grant all on table public.vendor_scorecards to authenticated;
grant all on table public.vendor_scorecards to service_role;
grant all on table public.directory_merge_candidates to authenticated;
grant all on table public.directory_merge_candidates to service_role;
grant all on table public.vendor_tax_readiness to authenticated;
grant all on table public.vendor_tax_readiness to service_role;

select public.refresh_directory_intelligence(null);
