-- AI usage telemetry: one row per model attempt, including failed and escalated
-- attempts, so the platform page can show what escalation actually costs.
--
-- org_id is nullable on purpose: platform-internal calls (evals, backfills) have
-- no tenant. Those rows are readable only by the service role.

create table if not exists public.ai_usage_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.orgs(id) on delete cascade,
  feature text not null,
  tier text not null,
  provider text not null,
  model text not null,
  input_tokens integer,
  output_tokens integer,
  total_tokens integer,
  -- Null means "this model has no known price", never zero. A fabricated zero
  -- silently under-reports spend.
  cost_usd numeric(12, 6),
  latency_ms integer not null,
  attempt integer not null default 1,
  escalated_from text,
  status text not null default 'ok',
  error_kind text,
  entity_type text,
  entity_id uuid,
  created_at timestamptz not null default now(),

  constraint ai_usage_events_status_check
    check (status in ('ok', 'error', 'cache_hit')),
  constraint ai_usage_events_tier_check
    check (tier in ('fast', 'standard', 'heavy')),
  constraint ai_usage_events_escalated_from_check
    check (escalated_from is null or escalated_from in ('fast', 'standard', 'heavy'))
);

-- The dashboard queries: spend over time, per org, per feature, per model.
create index if not exists ai_usage_events_org_created_idx
  on public.ai_usage_events (org_id, created_at desc);
create index if not exists ai_usage_events_created_idx
  on public.ai_usage_events (created_at desc);
create index if not exists ai_usage_events_feature_created_idx
  on public.ai_usage_events (feature, created_at desc);
create index if not exists ai_usage_events_model_created_idx
  on public.ai_usage_events (provider, model, created_at desc);
-- Partial index so "show me what is failing" stays cheap as the table grows.
create index if not exists ai_usage_events_errors_idx
  on public.ai_usage_events (created_at desc)
  where status = 'error';
create index if not exists ai_usage_events_entity_idx
  on public.ai_usage_events (entity_type, entity_id)
  where entity_id is not null;

alter table public.ai_usage_events enable row level security;

-- Members read their own org's usage; writes are service-role only, so this is
-- deliberately a select-only policy rather than the usual `for all`.
create policy ai_usage_events_org_read on public.ai_usage_events
  for select to authenticated
  using (org_id is not null and public.is_org_member(org_id));

grant select on table public.ai_usage_events to authenticated;
grant all on table public.ai_usage_events to service_role;

comment on table public.ai_usage_events is
  'One row per AI model attempt (including failures and escalations). Written by the AI gateway via the service role.';
comment on column public.ai_usage_events.cost_usd is
  'USD cost, or NULL when the model has no known price. Never defaulted to zero.';
comment on column public.ai_usage_events.escalated_from is
  'Tier this attempt escalated up from, NULL when it ran at the requested tier.';
