-- Warranty: routing rules, buyer appointment confirmation, and local time.
--
-- 1. Routing. A request used to wait for someone to read it and assign it. A
--    routing rule says "emergency leaks in Palmetto Ridge go to this tech" so
--    the right person owns the request the moment it lands, and the SLA clock
--    starts with an owner. Rules match on severity, community, responsibility
--    (cost code) and category; a null condition matches anything. The most
--    specific, lowest-priority-number rule wins. Manual triage stays: a person
--    can always reassign, and doing so over a routed request records why.
--
-- 2. Buyer confirmation. A homeowner is told when a visit is booked and can
--    confirm it or ask for another time from the buyer portal. The columns are
--    the buyer's answer; the trade's own confirmation stays in `confirmed_at`.
--
-- 3. Local time. Visit windows are timestamptz; what a homeowner or a
--    coordinator needs is the wall-clock time in the house's time zone. An
--    org has a time zone and a community may override it (a builder with
--    communities in two zones). Nothing here converts stored instants.

alter table public.orgs
  add column if not exists time_zone text not null default 'America/New_York';

comment on column public.orgs.time_zone is
  'IANA time zone the org works in. Warranty visit times render in this zone unless the home''s community sets its own.';

alter table public.communities
  add column if not exists time_zone text;

comment on column public.communities.time_zone is
  'IANA time zone override for homes in this community; null inherits the org''s.';

create table public.warranty_routing_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null check (length(btrim(name)) > 0),
  priority integer not null default 100 check (priority >= 0),
  severity text check (severity in ('emergency', 'routine_30', 'routine_60')),
  category text check (category is null or length(btrim(category)) > 0),
  community_id uuid references public.communities(id) on delete cascade,
  cost_code_id uuid references public.cost_codes(id) on delete cascade,
  assignee_kind text not null check (assignee_kind in ('tech', 'trade')),
  assigned_user_id uuid references public.app_users(id) on delete cascade,
  assigned_company_id uuid references public.companies(id) on delete cascade,
  is_active boolean not null default true,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (assignee_kind = 'tech' and assigned_user_id is not null and assigned_company_id is null)
    or (assignee_kind = 'trade' and assigned_company_id is not null and assigned_user_id is null)
  )
);

create index warranty_routing_rules_org_active_idx
  on public.warranty_routing_rules (org_id, is_active, priority);
create index warranty_routing_rules_community_idx
  on public.warranty_routing_rules (community_id) where community_id is not null;
create index warranty_routing_rules_cost_code_idx
  on public.warranty_routing_rules (cost_code_id) where cost_code_id is not null;
create index warranty_routing_rules_user_idx
  on public.warranty_routing_rules (assigned_user_id) where assigned_user_id is not null;
create index warranty_routing_rules_company_idx
  on public.warranty_routing_rules (assigned_company_id) where assigned_company_id is not null;

create trigger warranty_routing_rules_set_updated_at before update on public.warranty_routing_rules
  for each row execute function public.tg_set_updated_at();

alter table public.warranty_routing_rules enable row level security;

create policy warranty_routing_rules_read on public.warranty_routing_rules
  for select to authenticated
  using (public.is_org_member(org_id));
create policy warranty_routing_rules_insert on public.warranty_routing_rules
  for insert to authenticated
  with check (public.has_org_permission(org_id, 'warranty.manage'));
create policy warranty_routing_rules_update on public.warranty_routing_rules
  for update to authenticated
  using (public.has_org_permission(org_id, 'warranty.manage'))
  with check (public.has_org_permission(org_id, 'warranty.manage'));
create policy warranty_routing_rules_delete on public.warranty_routing_rules
  for delete to authenticated
  using (public.has_org_permission(org_id, 'warranty.manage'));

grant select, insert, update, delete on table public.warranty_routing_rules to authenticated, service_role;

comment on table public.warranty_routing_rules is
  'Severity / community / responsibility / category -> technician or trade. The lowest priority number among the most specific matches owns a new request.';

alter table public.warranty_service_visits
  add column if not exists buyer_confirmed_at timestamptz,
  add column if not exists buyer_reschedule_requested_at timestamptz,
  add column if not exists buyer_reschedule_note text;

comment on column public.warranty_service_visits.buyer_confirmed_at is
  'When the homeowner confirmed this appointment from the buyer portal. Cleared when the window moves.';
comment on column public.warranty_service_visits.buyer_reschedule_requested_at is
  'When the homeowner asked for a different time. Cleared when the office reschedules.';
