-- Workstream 04 phase 2: variance taxonomy, VPO classification, settings,
-- and SQL-side variance aggregates for production-scale reporting.

create table public.variance_reason_codes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  code text not null check (length(btrim(code)) > 0),
  label text not null check (length(btrim(label)) > 0),
  description text,
  is_active boolean not null default true,
  is_backcharge boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, code)
);

create table public.purchasing_settings (
  org_id uuid primary key references public.orgs(id),
  pay_on_po_enabled boolean not null default false,
  po_completion_requires_verification boolean not null default true,
  vpo_reason_code_required boolean not null default true,
  vpo_approval_thresholds jsonb not null default
    '[{"up_to_cents":100000,"permission":"vpo.approve"},{"up_to_cents":null,"permission":"vpo.approve_large"}]'::jsonb,
  expiring_agreement_lead_days integer not null default 30 check (expiring_agreement_lead_days between 1 and 365),
  updated_at timestamptz not null default now(),
  constraint purchasing_settings_thresholds_array check (jsonb_typeof(vpo_approval_thresholds) = 'array')
);

alter table public.commitment_change_orders
  add column if not exists reason_code_id uuid references public.variance_reason_codes(id),
  add column if not exists origin text
    check (origin in ('field_mobile','office','design_studio_co','trade_portal')),
  add column if not exists requested_by uuid references public.app_users(id),
  add column if not exists photo_file_ids uuid[] not null default '{}';

create index cco_variance_idx on public.commitment_change_orders
  (org_id, reason_code_id, status) where reason_code_id is not null;
create index cco_requested_by_idx on public.commitment_change_orders (requested_by)
  where requested_by is not null;
create index variance_reason_codes_org_idx on public.variance_reason_codes
  (org_id, is_active, sort_order, label);

create trigger variance_reason_codes_set_updated_at
  before update on public.variance_reason_codes
  for each row execute function public.tg_set_updated_at();
create trigger purchasing_settings_set_updated_at
  before update on public.purchasing_settings
  for each row execute function public.tg_set_updated_at();

alter table public.variance_reason_codes enable row level security;
alter table public.purchasing_settings enable row level security;
create policy variance_reason_codes_org_access on public.variance_reason_codes
  for all to authenticated using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
create policy purchasing_settings_org_access on public.purchasing_settings
  for all to authenticated using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));

grant select, insert, update, delete on public.variance_reason_codes, public.purchasing_settings to authenticated;
grant all on public.variance_reason_codes, public.purchasing_settings to service_role;

create or replace function public.get_variance_analysis(
  p_org_id uuid,
  p_start_date date,
  p_end_date date
) returns table (
  dimension text,
  dimension_id text,
  dimension_label text,
  net_variance_cents bigint,
  absolute_variance_cents bigint,
  incidence bigint,
  direct_cost_budget_cents bigint,
  variance_rate numeric
)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  with approved_vpos as (
    select
      cco.id,
      cco.project_id,
      cco.reason_code_id,
      cco.total_cents::bigint,
      cco.approved_at,
      c.company_id,
      l.community_id,
      l.house_plan_id,
      coalesce(l.division_id, p.division_id) as division_id
    from public.commitment_change_orders cco
    join public.commitments c on c.id = cco.commitment_id and c.org_id = cco.org_id
    join public.projects p on p.id = cco.project_id and p.org_id = cco.org_id
    left join public.lots l on l.project_id = p.id and l.org_id = p.org_id
    where cco.org_id = p_org_id
      and cco.status = 'approved'
      and cco.reason_code_id is not null
      and cco.approved_at::date between p_start_date and p_end_date
  ),
  project_budgets as (
    select distinct on (b.project_id)
      b.project_id, coalesce(b.total_cents, 0)::bigint as budget_cents
    from public.budgets b
    where b.org_id = p_org_id
    order by b.project_id, b.version desc
  ),
  superintendent as (
    select distinct on (pm.project_id)
      pm.project_id, pm.user_id, coalesce(u.full_name, u.email::text, 'Unassigned') as label
    from public.project_members pm
    join public.roles r on r.id = pm.role_id and r.key = 'field'
    join public.app_users u on u.id = pm.user_id
    where pm.org_id = p_org_id and pm.status = 'active'
    order by pm.project_id, pm.created_at
  ),
  expanded as (
    select 'reason'::text dimension, v.reason_code_id::text dimension_id,
      coalesce(rc.label, 'Unclassified')::text dimension_label, v.*
    from approved_vpos v left join public.variance_reason_codes rc on rc.id = v.reason_code_id
    union all
    select 'community', v.community_id::text, coalesce(cm.name, 'No community'), v.*
    from approved_vpos v left join public.communities cm on cm.id = v.community_id
    union all
    select 'plan', v.house_plan_id::text, coalesce(hp.name, 'No plan'), v.*
    from approved_vpos v left join public.house_plans hp on hp.id = v.house_plan_id
    union all
    select 'division', v.division_id::text, coalesce(d.name, 'Main'), v.*
    from approved_vpos v left join public.divisions d on d.id = v.division_id
    union all
    select 'vendor', v.company_id::text, coalesce(co.name, 'No vendor'), v.*
    from approved_vpos v left join public.companies co on co.id = v.company_id
    union all
    select 'superintendent', s.user_id::text, coalesce(s.label, 'Unassigned'), v.*
    from approved_vpos v left join superintendent s on s.project_id = v.project_id
    union all
    select 'month', to_char(v.approved_at, 'YYYY-MM'), to_char(v.approved_at, 'Mon YYYY'), v.*
    from approved_vpos v
  ),
  grouped_vpo as (
    select
      e.dimension,
      coalesce(e.dimension_id, '') as dimension_id,
      e.dimension_label,
      sum(e.total_cents)::bigint as net_variance_cents,
      sum(abs(e.total_cents))::bigint as absolute_variance_cents,
      count(*)::bigint as incidence
    from expanded e
    group by e.dimension, coalesce(e.dimension_id, ''), e.dimension_label
  ),
  covered_projects as (
    select distinct e.dimension, coalesce(e.dimension_id, '') as dimension_id,
      e.dimension_label, e.project_id
    from expanded e
  ),
  grouped_budget as (
    select cp.dimension, cp.dimension_id, cp.dimension_label,
      coalesce(sum(pb.budget_cents), 0)::bigint as direct_cost_budget_cents
    from covered_projects cp
    left join project_budgets pb on pb.project_id = cp.project_id
    group by cp.dimension, cp.dimension_id, cp.dimension_label
  )
  select g.dimension, g.dimension_id, g.dimension_label, g.net_variance_cents,
    g.absolute_variance_cents, g.incidence, b.direct_cost_budget_cents,
    case when b.direct_cost_budget_cents = 0 then 0::numeric
      else g.absolute_variance_cents::numeric / b.direct_cost_budget_cents end
  from grouped_vpo g
  join grouped_budget b using (dimension, dimension_id, dimension_label)
  order by g.dimension, g.absolute_variance_cents desc, g.dimension_label;
$$;

grant execute on function public.get_variance_analysis(uuid, date, date) to authenticated, service_role;

insert into public.permissions (key, description) values
  ('price_book.read', 'View vendor price agreements and price-book health'),
  ('price_book.write', 'Create, reprice, end, void, and import vendor price agreements'),
  ('po.generate', 'Generate purchase orders and derived lot budgets'),
  ('po_exception.resolve', 'Resolve purchase-order generation exceptions'),
  ('vpo.request', 'Request variance purchase orders'),
  ('vpo.approve', 'Approve variance purchase orders within the standard threshold'),
  ('vpo.approve_large', 'Approve large variance purchase orders and backcharges'),
  ('po_completion.report', 'Report purchase-order completion'),
  ('po_completion.verify', 'Verify or reject purchase-order completion')
on conflict (key) do update set description = excluded.description;

insert into public.roles (key, label, scope, description) values (
  'org_purchasing_manager', 'Purchasing manager', 'org',
  'Manages price agreements, generated purchase orders, variance approvals, and completion-to-pay workflows.'
) on conflict (key) do update set label = excluded.label, scope = excluded.scope, description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select r.id, grants.permission_key
from public.roles r cross join (values
  ('price_book.read'),('price_book.write'),('po.generate'),('po_exception.resolve'),
  ('vpo.request'),('vpo.approve'),('vpo.approve_large'),('po_completion.report'),
  ('po_completion.verify'),('commitment.read'),('commitment.write'),('commitment.approve'),
  ('bill.read'),('bill.write'),('bill.approve'),('community.read'),('plan.read'),('bid.read'),('bid.write')
) grants(permission_key)
where r.key in ('org_owner','org_admin','org_purchasing_manager')
on conflict do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, grants.permission_key
from public.roles r cross join (values
  ('price_book.read'),('vpo.request'),('vpo.approve'),('po_completion.report'),('po_completion.verify')
) grants(permission_key)
where r.key in ('org_project_lead','pm','field')
on conflict do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, grants.permission_key
from public.roles r cross join (values
  ('price_book.read'),('po_completion.report'),('po_completion.verify'),('vpo.request')
) grants(permission_key)
where r.key in ('org_office_admin','org_bookkeeper')
on conflict do nothing;
