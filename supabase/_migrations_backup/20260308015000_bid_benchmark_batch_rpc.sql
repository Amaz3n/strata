-- Batch benchmark recording for bid submissions to avoid per-row RPC calls.

create or replace function public.record_bid_submission_benchmarks(
  p_bid_submission_ids uuid[],
  p_min_sample_size integer default 8,
  p_min_orgs integer default 4
)
returns table (
  bid_submission_id uuid,
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
language sql
security definer
set search_path = public
as $$
  with requested as (
    select distinct bid_submission_id
    from unnest(coalesce(p_bid_submission_ids, '{}'::uuid[])) as t(bid_submission_id)
    where bid_submission_id is not null
  )
  select
    requested.bid_submission_id,
    benchmark.has_benchmark,
    benchmark.signal,
    benchmark.message,
    benchmark.match_level,
    benchmark.sample_size,
    benchmark.org_count,
    benchmark.median_cents,
    benchmark.p25_cents,
    benchmark.p75_cents,
    benchmark.submitted_total_cents,
    benchmark.deviation_pct
  from requested
  left join lateral public.record_bid_submission_benchmark(
    requested.bid_submission_id,
    p_min_sample_size,
    p_min_orgs
  ) as benchmark on true;
$$;

revoke all on function public.record_bid_submission_benchmarks(uuid[], integer, integer) from public;
revoke all on function public.record_bid_submission_benchmarks(uuid[], integer, integer) from anon;
revoke all on function public.record_bid_submission_benchmarks(uuid[], integer, integer) from authenticated;
grant execute on function public.record_bid_submission_benchmarks(uuid[], integer, integer) to service_role;
