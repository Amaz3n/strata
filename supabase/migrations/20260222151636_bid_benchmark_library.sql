-- Arc benchmark library for bid pricing guidance.
--
-- Privacy model:
-- - Store normalized benchmark facts per submission.
-- - Never expose raw bid rows to organizations.
-- - Return only aggregated signals when sample + org diversity thresholds are met.

create table if not exists arc_bid_benchmark_facts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  bid_submission_id uuid not null unique,
  bid_invite_id uuid not null,
  bid_package_id uuid not null,
  project_id uuid not null,
  currency text not null default 'usd',
  total_cents integer not null check (total_cents >= 0),
  normalized_trade text not null,
  project_type text not null,
  property_type text not null,
  project_value_bucket text not null,
  lead_time_bucket text not null,
  duration_bucket text not null,
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint arc_bid_benchmark_submission_org_fk
    foreign key (org_id, bid_submission_id)
    references bid_submissions (org_id, id)
    on delete cascade,
  constraint arc_bid_benchmark_invite_org_fk
    foreign key (org_id, bid_invite_id)
    references bid_invites (org_id, id)
    on delete cascade,
  constraint arc_bid_benchmark_package_org_fk
    foreign key (org_id, bid_package_id)
    references bid_packages (org_id, id)
    on delete cascade,
  constraint arc_bid_benchmark_project_org_fk
    foreign key (org_id, project_id)
    references projects (org_id, id)
    on delete cascade
);

create index if not exists arc_bid_benchmark_facts_org_idx
  on arc_bid_benchmark_facts (org_id);

create index if not exists arc_bid_benchmark_facts_cohort_strict_idx
  on arc_bid_benchmark_facts (
    currency,
    normalized_trade,
    project_type,
    property_type,
    project_value_bucket,
    lead_time_bucket,
    duration_bucket,
    total_cents
  );

create index if not exists arc_bid_benchmark_facts_cohort_relaxed_idx
  on arc_bid_benchmark_facts (
    currency,
    normalized_trade,
    project_type,
    property_type,
    total_cents
  );

alter table arc_bid_benchmark_facts enable row level security;

drop policy if exists arc_bid_benchmark_facts_service_role on arc_bid_benchmark_facts;
create policy arc_bid_benchmark_facts_service_role on arc_bid_benchmark_facts
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create or replace function public.arc_benchmark_normalize_trade(p_trade text)
returns text
language sql
immutable
as $$
  select coalesce(
    nullif(
      regexp_replace(
        lower(trim(coalesce(p_trade, ''))),
        '\\s+',
        ' ',
        'g'
      ),
      ''
    ),
    'unknown'
  );
$$;

create or replace function public.arc_benchmark_value_bucket(p_value integer)
returns text
language sql
immutable
as $$
  select case
    when p_value is null or p_value <= 0 then 'unknown'
    when p_value < 250000 then 'micro'
    when p_value < 1000000 then 'small'
    when p_value < 5000000 then 'medium'
    when p_value < 15000000 then 'large'
    else 'xlarge'
  end;
$$;

create or replace function public.arc_benchmark_days_bucket(p_days integer)
returns text
language sql
immutable
as $$
  select case
    when p_days is null or p_days < 0 then 'unknown'
    when p_days <= 7 then '0_7'
    when p_days <= 14 then '8_14'
    when p_days <= 30 then '15_30'
    when p_days <= 60 then '31_60'
    else '61_plus'
  end;
$$;

create or replace function public.record_bid_submission_benchmark(
  p_bid_submission_id uuid,
  p_min_sample_size integer default 8,
  p_min_orgs integer default 4
)
returns table (
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
language plpgsql
security definer
set search_path = public
as $$
declare
  v_submission record;
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
      false,
      'insufficient_data'::text,
      'Benchmark unavailable for this submission.'::text,
      'none'::text,
      0,
      0,
      null::integer,
      null::integer,
      null::integer,
      v_submission.total_cents,
      null::numeric;
    return;
  end if;

  insert into arc_bid_benchmark_facts (
    org_id,
    bid_submission_id,
    bid_invite_id,
    bid_package_id,
    project_id,
    currency,
    total_cents,
    normalized_trade,
    project_type,
    property_type,
    project_value_bucket,
    lead_time_bucket,
    duration_bucket,
    submitted_at,
    updated_at
  )
  values (
    v_submission.org_id,
    v_submission.bid_submission_id,
    v_submission.bid_invite_id,
    v_submission.bid_package_id,
    v_submission.project_id,
    v_submission.currency,
    v_submission.total_cents,
    v_submission.normalized_trade,
    v_submission.project_type,
    v_submission.property_type,
    v_submission.project_value_bucket,
    v_submission.lead_time_bucket,
    v_submission.duration_bucket,
    v_submission.submitted_at,
    now()
  )
  on conflict (bid_submission_id)
  do update
  set
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
    submitted_at = excluded.submitted_at,
    updated_at = now();

  with level_candidates as (
    select 1 as level_rank, 'strict'::text as level_name, f.org_id, f.total_cents
    from arc_bid_benchmark_facts f
    join bid_submissions bs on bs.id = f.bid_submission_id and bs.org_id = f.org_id
    where bs.status in ('submitted', 'revised')
      and f.org_id <> v_submission.org_id
      and f.currency = v_submission.currency
      and f.normalized_trade = v_submission.normalized_trade
      and f.project_type = v_submission.project_type
      and f.property_type = v_submission.property_type
      and f.project_value_bucket = v_submission.project_value_bucket
      and f.lead_time_bucket = v_submission.lead_time_bucket
      and f.duration_bucket = v_submission.duration_bucket

    union all

    select 2 as level_rank, 'trade_type_size'::text as level_name, f.org_id, f.total_cents
    from arc_bid_benchmark_facts f
    join bid_submissions bs on bs.id = f.bid_submission_id and bs.org_id = f.org_id
    where bs.status in ('submitted', 'revised')
      and f.org_id <> v_submission.org_id
      and f.currency = v_submission.currency
      and f.normalized_trade = v_submission.normalized_trade
      and f.project_type = v_submission.project_type
      and f.property_type = v_submission.property_type
      and f.project_value_bucket = v_submission.project_value_bucket

    union all

    select 3 as level_rank, 'trade_and_type'::text as level_name, f.org_id, f.total_cents
    from arc_bid_benchmark_facts f
    join bid_submissions bs on bs.id = f.bid_submission_id and bs.org_id = f.org_id
    where bs.status in ('submitted', 'revised')
      and f.org_id <> v_submission.org_id
      and f.currency = v_submission.currency
      and f.normalized_trade = v_submission.normalized_trade
      and f.project_type = v_submission.project_type
      and f.property_type = v_submission.property_type

    union all

    select 4 as level_rank, 'trade_type_family'::text as level_name, f.org_id, f.total_cents
    from arc_bid_benchmark_facts f
    join bid_submissions bs on bs.id = f.bid_submission_id and bs.org_id = f.org_id
    where bs.status in ('submitted', 'revised')
      and f.org_id <> v_submission.org_id
      and f.currency = v_submission.currency
      and f.normalized_trade = v_submission.normalized_trade
      and f.project_type = v_submission.project_type

    union all

    select 5 as level_rank, 'trade_only'::text as level_name, f.org_id, f.total_cents
    from arc_bid_benchmark_facts f
    join bid_submissions bs on bs.id = f.bid_submission_id and bs.org_id = f.org_id
    where bs.status in ('submitted', 'revised')
      and f.org_id <> v_submission.org_id
      and f.currency = v_submission.currency
      and f.normalized_trade = v_submission.normalized_trade
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
  select
    ls.sample_size,
    ls.org_count,
    ls.p25_cents,
    ls.p50_cents,
    ls.p75_cents,
    ls.level_name
  into
    v_sample_size,
    v_org_count,
    v_p25,
    v_p50,
    v_p75,
    v_match_level
  from level_stats ls
  where ls.sample_size >= p_min_sample_size
    and ls.org_count >= p_min_orgs
  order by ls.level_rank
  limit 1;

  if v_sample_size is null then
    return query
    select
      false,
      'insufficient_data'::text,
      'Not enough similar bids yet to produce a private benchmark.'::text,
      'none'::text,
      0,
      0,
      null::integer,
      null::integer,
      null::integer,
      v_submission.total_cents,
      null::numeric;
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
    true,
    v_signal,
    v_message,
    v_match_level,
    v_sample_size,
    v_org_count,
    v_p50,
    v_p25,
    v_p75,
    v_submission.total_cents,
    v_deviation;
end;
$$;

revoke all on function public.record_bid_submission_benchmark(uuid, integer, integer) from public;
revoke all on function public.record_bid_submission_benchmark(uuid, integer, integer) from anon;
revoke all on function public.record_bid_submission_benchmark(uuid, integer, integer) from authenticated;
grant execute on function public.record_bid_submission_benchmark(uuid, integer, integer) to service_role;

insert into arc_bid_benchmark_facts (
  org_id,
  bid_submission_id,
  bid_invite_id,
  bid_package_id,
  project_id,
  currency,
  total_cents,
  normalized_trade,
  project_type,
  property_type,
  project_value_bucket,
  lead_time_bucket,
  duration_bucket,
  submitted_at,
  updated_at
)
select
  bs.org_id,
  bs.id,
  bi.id,
  bp.id,
  p.id,
  coalesce(nullif(lower(bs.currency), ''), 'usd') as currency,
  bs.total_cents,
  arc_benchmark_normalize_trade(bp.trade) as normalized_trade,
  coalesce(p.project_type::text, 'unknown') as project_type,
  coalesce(p.property_type::text, 'unknown') as property_type,
  arc_benchmark_value_bucket(p.total_value) as project_value_bucket,
  arc_benchmark_days_bucket(bs.lead_time_days) as lead_time_bucket,
  arc_benchmark_days_bucket(bs.duration_days) as duration_bucket,
  bs.submitted_at,
  now()
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
where bs.total_cents is not null
  and bs.total_cents >= 0
  and bs.status in ('submitted', 'revised')
on conflict (bid_submission_id)
do update
set
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
  submitted_at = excluded.submitted_at,
  updated_at = now();
