-- Bid scope-line model
-- Structured scope items GCs define and subs price against (quote vs tender
-- package modes), per-cell leveling plugs, portal submission drafts, award
-- rescind, and benchmark hardening (region dimension + sharing opt-out).

-- 1. Package mode, deadline timezone, bond requirement -----------------------

alter table public.bid_packages
  add column if not exists mode text not null default 'quote',
  add column if not exists due_tz text,
  add column if not exists bond_required boolean not null default false;

do $$ begin
  alter table public.bid_packages
    add constraint bid_packages_mode_check check (mode in ('quote', 'tender'));
exception when duplicate_object then null; end $$;

-- 2. Scope items (the bid form) ----------------------------------------------

create table if not exists public.bid_scope_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  bid_package_id uuid not null,
  position integer not null default 0,
  item_type text not null default 'base',
  description text not null,
  details text,
  quantity numeric,
  unit text,
  budget_cents bigint,
  cost_code_id uuid,
  created_by uuid,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint bid_scope_items_item_type_check
    check (item_type in ('base', 'alternate', 'allowance', 'unit_price'))
);

create unique index if not exists bid_scope_items_org_id_id_uidx
  on public.bid_scope_items (org_id, id);
create index if not exists bid_scope_items_org_package_idx
  on public.bid_scope_items (org_id, bid_package_id, position);

do $$ begin
  alter table public.bid_scope_items
    add constraint bid_scope_items_org_package_fk
    foreign key (org_id, bid_package_id)
    references public.bid_packages (org_id, id) on delete cascade;
exception when duplicate_object then null; end $$;

alter table public.bid_scope_items enable row level security;
drop policy if exists bid_scope_items_access on public.bid_scope_items;
create policy bid_scope_items_access on public.bid_scope_items
  using ((auth.role() = 'service_role') or public.is_org_member(org_id))
  with check ((auth.role() = 'service_role') or public.is_org_member(org_id));

-- 3. Submission items (per-line pricing + GC leveling cells) -----------------

create table if not exists public.bid_submission_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  bid_submission_id uuid not null,
  bid_scope_item_id uuid,
  -- description snapshots the scope line at submit time and carries ad-hoc
  -- lines the sub added themselves (bid_scope_item_id null)
  description text not null,
  response text not null default 'priced',
  amount_cents bigint,
  unit_rate_cents bigint,
  quantity numeric,
  notes text,
  -- GC-side leveling: a plug fills a hole (excluded / no_bid / suspect) with
  -- the GC's own number so leveled totals stay honest about assumptions
  gc_plug_cents bigint,
  gc_note text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint bid_submission_items_response_check
    check (response in ('priced', 'excluded', 'no_bid'))
);

create unique index if not exists bid_submission_items_org_id_id_uidx
  on public.bid_submission_items (org_id, id);
create index if not exists bid_submission_items_org_submission_idx
  on public.bid_submission_items (org_id, bid_submission_id);
create unique index if not exists bid_submission_items_submission_scope_uidx
  on public.bid_submission_items (bid_submission_id, bid_scope_item_id)
  where bid_scope_item_id is not null;

do $$ begin
  alter table public.bid_submission_items
    add constraint bid_submission_items_org_submission_fk
    foreign key (org_id, bid_submission_id)
    references public.bid_submissions (org_id, id) on delete cascade;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.bid_submission_items
    add constraint bid_submission_items_org_scope_item_fk
    foreign key (org_id, bid_scope_item_id)
    references public.bid_scope_items (org_id, id) on delete set null;
exception when duplicate_object then null; end $$;

alter table public.bid_submission_items enable row level security;
drop policy if exists bid_submission_items_access on public.bid_submission_items;
create policy bid_submission_items_access on public.bid_submission_items
  using ((auth.role() = 'service_role') or public.is_org_member(org_id))
  with check ((auth.role() = 'service_role') or public.is_org_member(org_id));

-- 4. Portal drafts (autosave; one draft per invite) ---------------------------

create table if not exists public.bid_portal_drafts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  bid_invite_id uuid not null,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamp with time zone not null default now()
);

create unique index if not exists bid_portal_drafts_invite_uidx
  on public.bid_portal_drafts (bid_invite_id);

do $$ begin
  alter table public.bid_portal_drafts
    add constraint bid_portal_drafts_org_invite_fk
    foreign key (org_id, bid_invite_id)
    references public.bid_invites (org_id, id) on delete cascade;
exception when duplicate_object then null; end $$;

alter table public.bid_portal_drafts enable row level security;
drop policy if exists bid_portal_drafts_access on public.bid_portal_drafts;
create policy bid_portal_drafts_access on public.bid_portal_drafts
  using ((auth.role() = 'service_role') or public.is_org_member(org_id))
  with check ((auth.role() = 'service_role') or public.is_org_member(org_id));

-- 5. Award rescind + accepted alternates -------------------------------------

alter table public.bid_awards
  add column if not exists rescinded_at timestamp with time zone,
  add column if not exists rescinded_by uuid,
  add column if not exists rescind_reason text,
  add column if not exists accepted_alternate_ids uuid[] not null default '{}';

create or replace function public.rescind_bid_award(
  p_org_id uuid,
  p_bid_award_id uuid,
  p_actor_id uuid,
  p_reason text default null
) returns table (
  bid_package_id uuid,
  commitment_id uuid,
  commitment_canceled boolean
)
language plpgsql security definer
set search_path to 'public'
as $$
declare
  v_award record;
  v_bill_count integer;
  v_commitment_canceled boolean := false;
begin
  select ba.id, ba.org_id, ba.bid_package_id, ba.awarded_commitment_id, ba.rescinded_at
  into v_award
  from bid_awards ba
  where ba.id = p_bid_award_id and ba.org_id = p_org_id
  for update;

  if not found then
    raise exception 'Bid award not found';
  end if;
  if v_award.rescinded_at is not null then
    raise exception 'Bid award is already rescinded';
  end if;

  if v_award.awarded_commitment_id is not null then
    select count(*) into v_bill_count
    from vendor_bills vb
    where vb.org_id = p_org_id and vb.commitment_id = v_award.awarded_commitment_id;

    if v_bill_count > 0 then
      raise exception 'Cannot rescind: % bill(s) already reference the awarded subcontract', v_bill_count;
    end if;

    update commitments c
    set status = 'canceled', updated_at = now()
    where c.id = v_award.awarded_commitment_id
      and c.org_id = p_org_id
      and c.status in ('draft', 'approved');
    v_commitment_canceled := found;
  end if;

  update bid_awards ba
  set rescinded_at = now(), rescinded_by = p_actor_id, rescind_reason = p_reason
  where ba.id = p_bid_award_id and ba.org_id = p_org_id;

  -- Reopen the package for re-award (bids are still on file)
  update bid_packages bp
  set status = 'closed', updated_at = now()
  where bp.id = v_award.bid_package_id and bp.org_id = p_org_id;

  return query select v_award.bid_package_id, v_award.awarded_commitment_id, v_commitment_canceled;
end;
$$;

revoke all on function public.rescind_bid_award(uuid, uuid, uuid, text) from public;
grant execute on function public.rescind_bid_award(uuid, uuid, uuid, text) to service_role;

-- 6. Benchmark facts: region dimension ----------------------------------------

alter table public.arc_bid_benchmark_facts
  add column if not exists region text;

create index if not exists arc_bid_benchmark_facts_trade_region_idx
  on public.arc_bid_benchmark_facts (normalized_trade, region);

update public.arc_bid_benchmark_facts f
set region = upper(nullif(p.location ->> 'state', ''))
from public.projects p
where p.id = f.project_id and f.region is null;

-- 7. Benchmark RPC v2: region-aware matching + sharing opt-out ----------------
-- Orgs opt out of the cross-org pool with feature flag 'bid_benchmark_sharing'
-- = disabled: their facts are neither recorded nor compared against.

create or replace function public.record_bid_submission_benchmark(
  p_bid_submission_id uuid,
  p_min_sample_size integer default 8,
  p_min_orgs integer default 4
) returns table (
  has_benchmark boolean,
  signal text,
  message text,
  match_level text,
  sample_size integer,
  org_count integer,
  median_cents integer,
  p25_cents integer,
  p75_cents integer,
  submitted_total_cents integer,
  deviation_pct numeric
)
language plpgsql security definer
set search_path to 'public'
as $$
declare
  v_submission record;
  v_sharing_enabled boolean;
  v_sample_size integer;
  v_org_count integer;
  v_p25 integer;
  v_p50 integer;
  v_p75 integer;
  v_match_level text;
  v_signal text;
  v_message text;
  v_deviation numeric;
begin
  p_min_sample_size := greatest(coalesce(p_min_sample_size, 8), 1);
  p_min_orgs := greatest(coalesce(p_min_orgs, 4), 1);

  select
    bs.id as bid_submission_id,
    bs.org_id,
    bi.id as bid_invite_id,
    bp.id as bid_package_id,
    p.id as project_id,
    coalesce(nullif(lower(bs.currency), ''), 'usd') as currency,
    bs.total_cents,
    bs.status,
    arc_benchmark_normalize_trade(bp.trade) as normalized_trade,
    coalesce(p.project_type::text, 'unknown') as project_type,
    coalesce(p.property_type::text, 'unknown') as property_type,
    arc_benchmark_value_bucket(p.total_value) as project_value_bucket,
    arc_benchmark_days_bucket(bs.lead_time_days) as lead_time_bucket,
    arc_benchmark_days_bucket(bs.duration_days) as duration_bucket,
    upper(nullif(p.location ->> 'state', '')) as region,
    bs.submitted_at
  into v_submission
  from bid_submissions bs
  join bid_invites bi
    on bi.id = bs.bid_invite_id
   and bi.org_id = bs.org_id
  join bid_packages bp
    on bp.id = bi.bid_package_id
   and bp.org_id = bi.org_id
  join projects p
    on p.id = bp.project_id
   and p.org_id = bp.org_id
  where bs.id = p_bid_submission_id
  limit 1;

  if not found then
    raise exception 'Bid submission % not found', p_bid_submission_id;
  end if;

  if v_submission.total_cents is null or v_submission.total_cents < 0 then
    return query
    select
      false, 'insufficient_data'::text,
      'Benchmark unavailable for this submission.'::text,
      'none'::text, 0, 0,
      null::integer, null::integer, null::integer,
      v_submission.total_cents, null::numeric;
    return;
  end if;

  v_sharing_enabled := not exists (
    select 1 from feature_flags ff
    where ff.org_id = v_submission.org_id
      and ff.flag_key = 'bid_benchmark_sharing'
      and ff.enabled = false
      and (ff.expires_at is null or ff.expires_at > now())
  );

  if v_sharing_enabled then
    insert into arc_bid_benchmark_facts (
      org_id, bid_submission_id, bid_invite_id, bid_package_id, project_id,
      currency, total_cents, normalized_trade, project_type, property_type,
      project_value_bucket, lead_time_bucket, duration_bucket, region,
      submitted_at, updated_at
    )
    values (
      v_submission.org_id, v_submission.bid_submission_id, v_submission.bid_invite_id,
      v_submission.bid_package_id, v_submission.project_id,
      v_submission.currency, v_submission.total_cents, v_submission.normalized_trade,
      v_submission.project_type, v_submission.property_type,
      v_submission.project_value_bucket, v_submission.lead_time_bucket,
      v_submission.duration_bucket, v_submission.region,
      v_submission.submitted_at, now()
    )
    on conflict (bid_submission_id)
    do update set
      org_id = excluded.org_id,
      bid_invite_id = excluded.bid_invite_id,
      bid_package_id = excluded.bid_package_id,
      project_id = excluded.project_id,
      currency = excluded.currency,
      total_cents = excluded.total_cents,
      normalized_trade = excluded.normalized_trade,
      project_type = excluded.project_type,
      property_type = excluded.property_type,
      project_value_bucket = excluded.project_value_bucket,
      lead_time_bucket = excluded.lead_time_bucket,
      duration_bucket = excluded.duration_bucket,
      region = excluded.region,
      submitted_at = excluded.submitted_at,
      updated_at = now();
  else
    -- opted-out orgs neither contribute nor keep stale facts in the pool
    delete from arc_bid_benchmark_facts f
    where f.bid_submission_id = v_submission.bid_submission_id;

    return query
    select
      false, 'insufficient_data'::text,
      'Benchmark sharing is disabled for this workspace.'::text,
      'none'::text, 0, 0,
      null::integer, null::integer, null::integer,
      v_submission.total_cents, null::numeric;
    return;
  end if;

  with eligible_facts as (
    select f.org_id, f.total_cents, f.currency, f.normalized_trade,
           f.project_type, f.property_type, f.project_value_bucket,
           f.lead_time_bucket, f.duration_bucket, f.region
    from arc_bid_benchmark_facts f
    join bid_submissions bs on bs.id = f.bid_submission_id and bs.org_id = f.org_id
    where bs.status in ('submitted', 'revised')
      and f.org_id <> v_submission.org_id
      and f.currency = v_submission.currency
      and f.normalized_trade = v_submission.normalized_trade
      and not exists (
        select 1 from feature_flags ff
        where ff.org_id = f.org_id
          and ff.flag_key = 'bid_benchmark_sharing'
          and ff.enabled = false
          and (ff.expires_at is null or ff.expires_at > now())
      )
  ),
  level_candidates as (
    select 1 as level_rank, 'strict'::text as level_name, f.org_id, f.total_cents
    from eligible_facts f
    where f.project_type = v_submission.project_type
      and f.property_type = v_submission.property_type
      and f.project_value_bucket = v_submission.project_value_bucket
      and f.lead_time_bucket = v_submission.lead_time_bucket
      and f.duration_bucket = v_submission.duration_bucket
      and v_submission.region is not null
      and f.region = v_submission.region

    union all

    select 2, 'trade_type_size'::text, f.org_id, f.total_cents
    from eligible_facts f
    where f.project_type = v_submission.project_type
      and f.property_type = v_submission.property_type
      and f.project_value_bucket = v_submission.project_value_bucket
      and v_submission.region is not null
      and f.region = v_submission.region

    union all

    select 3, 'trade_and_type'::text, f.org_id, f.total_cents
    from eligible_facts f
    where f.project_type = v_submission.project_type
      and f.property_type = v_submission.property_type
      and v_submission.region is not null
      and f.region = v_submission.region

    union all

    select 4, 'trade_type_family'::text, f.org_id, f.total_cents
    from eligible_facts f
    where f.project_type = v_submission.project_type

    union all

    select 5, 'trade_only'::text, f.org_id, f.total_cents
    from eligible_facts f
  ),
  level_stats as (
    select
      level_rank,
      level_name,
      count(*)::integer as sample_size,
      count(distinct org_id)::integer as org_count,
      percentile_disc(0.25) within group (order by total_cents)::integer as p25_cents,
      percentile_disc(0.5) within group (order by total_cents)::integer as p50_cents,
      percentile_disc(0.75) within group (order by total_cents)::integer as p75_cents
    from level_candidates
    group by level_rank, level_name
  )
  select ls.sample_size, ls.org_count, ls.p25_cents, ls.p50_cents, ls.p75_cents, ls.level_name
  into v_sample_size, v_org_count, v_p25, v_p50, v_p75, v_match_level
  from level_stats ls
  where ls.sample_size >= p_min_sample_size
    and ls.org_count >= p_min_orgs
  order by ls.level_rank
  limit 1;

  if v_sample_size is null then
    return query
    select
      false, 'insufficient_data'::text,
      'Not enough similar bids yet to produce a private benchmark.'::text,
      'none'::text, 0, 0,
      null::integer, null::integer, null::integer,
      v_submission.total_cents, null::numeric;
    return;
  end if;

  if v_p50 is not null and v_p50 > 0 then
    v_deviation := round((((v_submission.total_cents - v_p50)::numeric / v_p50::numeric) * 100)::numeric, 1);
  else
    v_deviation := null;
  end if;

  if v_submission.total_cents < v_p25 then
    v_signal := 'below_range';
    v_message := 'Based on similar bids, this price is below the typical range.';
  elsif v_submission.total_cents > v_p75 then
    v_signal := 'above_range';
    v_message := 'Based on similar bids, this price is above the typical range.';
  else
    v_signal := 'in_range';
    v_message := 'Based on similar bids, this price is within the typical range.';
  end if;

  return query
  select
    true, v_signal, v_message, v_match_level,
    v_sample_size, v_org_count,
    v_p50, v_p25, v_p75,
    v_submission.total_cents, v_deviation;
end;
$$;
