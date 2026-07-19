-- Workstream 07 Phases 4-5: warranty backcharge attribution and aggregate
-- analytics. The cash artifact remains a negative vendor_bills credit.

create table public.warranty_backcharges (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  warranty_request_id uuid not null references public.warranty_requests(id) on delete cascade,
  company_id uuid not null references public.companies(id),
  commitment_id uuid references public.commitments(id) on delete set null,
  cost_code_id uuid references public.cost_codes(id) on delete set null,
  backcharge_number integer not null check (backcharge_number > 0),
  status text not null default 'draft'
    check (status in ('draft','issued','disputed','recovered','written_off','waived')),
  amount_cents bigint not null check (amount_cents > 0),
  recovered_cents bigint not null default 0
    check (recovered_cents >= 0 and recovered_cents <= amount_cents),
  reason text not null,
  cost_basis jsonb not null default '[]'::jsonb check (jsonb_typeof(cost_basis) = 'array'),
  vendor_credit_bill_id uuid references public.vendor_bills(id) on delete set null,
  issued_at timestamptz,
  issued_by uuid references public.app_users(id) on delete set null,
  disputed_at timestamptz,
  dispute_note text,
  resolved_at timestamptz,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, backcharge_number),
  unique (vendor_credit_bill_id)
);

create index warranty_backcharges_org_status_idx
  on public.warranty_backcharges (org_id, status, issued_at desc);
create index warranty_backcharges_project_idx on public.warranty_backcharges (project_id);
create index warranty_backcharges_company_idx on public.warranty_backcharges (company_id);
create index warranty_backcharges_commitment_idx on public.warranty_backcharges (commitment_id)
  where commitment_id is not null;
create index warranty_backcharges_request_idx on public.warranty_backcharges (warranty_request_id);

drop trigger if exists warranty_backcharges_set_updated_at on public.warranty_backcharges;
create trigger warranty_backcharges_set_updated_at before update on public.warranty_backcharges
  for each row execute function public.tg_set_updated_at();

alter table public.warranty_backcharges enable row level security;
create policy warranty_backcharges_org_access on public.warranty_backcharges
  for all to authenticated using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
grant select, insert, update, delete on table public.warranty_backcharges
  to authenticated, service_role;

create or replace function public.next_warranty_backcharge_number(p_org_id uuid)
returns integer
language sql
set search_path = public, pg_catalog
as $$
  select coalesce(max(backcharge_number), 0) + 1
  from public.warranty_backcharges
  where org_id = p_org_id;
$$;

revoke all on function public.next_warranty_backcharge_number(uuid) from public, anon;
grant execute on function public.next_warranty_backcharge_number(uuid) to authenticated, service_role;

create or replace function public.warranty_defect_analysis(
  p_org_id uuid,
  p_group_by text,
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns table (
  group_id text,
  group_name text,
  request_count bigint,
  affected_home_count bigint,
  closed_home_count bigint,
  affected_home_percent numeric,
  remediation_cost_cents bigint,
  recovered_cents bigint,
  average_cost_cents bigint,
  top_categories jsonb
)
language sql
stable
set search_path = public, pg_catalog
as $$
  with request_base as (
    select
      wr.id,
      wr.project_id,
      wr.category,
      coalesce(wr.assigned_company_id, wb.company_id) as company_id,
      wr.cost_code_id,
      l.community_id,
      l.house_plan_version_id,
      hpv.house_plan_id,
      coalesce(sum(wb.amount_cents), 0)::bigint as remediation_cost_cents,
      coalesce(sum(wb.recovered_cents), 0)::bigint as recovered_cents,
      case p_group_by
        when 'community' then l.community_id::text
        when 'company' then coalesce(wr.assigned_company_id, wb.company_id)::text
        when 'cost_code' then wr.cost_code_id::text
        when 'plan_version' then l.house_plan_version_id::text
        when 'plan' then hpv.house_plan_id::text
      end as group_id
    from public.warranty_requests wr
    left join public.warranty_backcharges wb
      on wb.org_id = wr.org_id and wb.warranty_request_id = wr.id
    left join public.lots l on l.org_id = wr.org_id and l.project_id = wr.project_id
    left join public.house_plan_versions hpv on hpv.org_id = wr.org_id and hpv.id = l.house_plan_version_id
    where wr.org_id = p_org_id
      and (p_from is null or wr.created_at >= p_from)
      and (p_to is null or wr.created_at < p_to)
      and p_group_by in ('community','company','cost_code','plan_version','plan')
    group by wr.id, wr.project_id, wr.category, wr.assigned_company_id,
      wb.company_id, wr.cost_code_id, l.community_id, l.house_plan_version_id, hpv.house_plan_id
  ), names as (
    select rb.*,
      case p_group_by
        when 'community' then c.name
        when 'company' then co.name
        when 'cost_code' then concat_ws(' — ', cc.code, cc.name)
        when 'plan_version' then concat_ws(' — ', hp.code, coalesce(hpv.label, 'Version ' || hpv.version_number::text))
        when 'plan' then concat_ws(' — ', hp.code, hp.name)
      end as group_name
    from request_base rb
    left join public.communities c on p_group_by = 'community' and c.id::text = rb.group_id
    left join public.companies co on p_group_by = 'company' and co.id::text = rb.group_id
    left join public.cost_codes cc on p_group_by = 'cost_code' and cc.id::text = rb.group_id
    left join public.house_plan_versions hpv on p_group_by = 'plan_version' and hpv.id::text = rb.group_id
    left join public.house_plans hp on hp.id = coalesce(hpv.house_plan_id,
      case when p_group_by = 'plan' and rb.group_id is not null then rb.group_id::uuid end)
    where rb.group_id is not null
  ), totals as (
    select n.group_id, max(n.group_name) group_name, count(*) request_count,
      count(distinct n.project_id) affected_home_count,
      sum(n.remediation_cost_cents)::bigint remediation_cost_cents,
      sum(n.recovered_cents)::bigint recovered_cents
    from names n group by n.group_id
  ), categories as (
    select group_id,
      coalesce(jsonb_agg(jsonb_build_object('category', category, 'count', category_count)
        order by category_count desc, category) filter (where category_rank <= 3), '[]'::jsonb) top_categories
    from (
      select group_id, coalesce(category, 'Uncategorized') category, count(*) category_count,
        row_number() over (partition by group_id order by count(*) desc, coalesce(category, 'Uncategorized')) category_rank
      from names group by group_id, coalesce(category, 'Uncategorized')
    ) ranked group by group_id
  )
  select t.group_id, t.group_name, t.request_count, t.affected_home_count,
    (select count(*) from public.closings cl
      join public.lots l on l.org_id = cl.org_id and l.project_id = cl.project_id
      left join public.house_plan_versions hpv on hpv.id = l.house_plan_version_id
      where cl.org_id = p_org_id and cl.status = 'closed'
        and case p_group_by
          when 'community' then l.community_id::text = t.group_id
          when 'plan_version' then l.house_plan_version_id::text = t.group_id
          when 'plan' then hpv.house_plan_id::text = t.group_id
          else true
        end)::bigint closed_home_count,
    round(t.affected_home_count * 100.0 / nullif((select count(*) from public.closings cl where cl.org_id = p_org_id and cl.status = 'closed'), 0), 2),
    t.remediation_cost_cents, t.recovered_cents,
    case when t.request_count = 0 then 0 else (t.remediation_cost_cents / t.request_count)::bigint end,
    c.top_categories
  from totals t join categories c using (group_id)
  order by t.request_count desc, t.group_name;
$$;

create or replace function public.warranty_cost_summary(p_org_id uuid, p_community_id uuid default null)
returns table (
  community_id uuid,
  community_name text,
  warranty_cost_cents bigint,
  recovered_cents bigint,
  net_cost_cents bigint,
  closed_revenue_cents bigint,
  cost_percent numeric
)
language sql
stable
set search_path = public, pg_catalog
as $$
  with community_costs as (
    select c.id community_id, c.name community_name,
      coalesce(sum(wb.amount_cents), 0)::bigint warranty_cost_cents,
      coalesce(sum(wb.recovered_cents), 0)::bigint recovered_cents
    from public.communities c
    left join public.lots l on l.org_id = c.org_id and l.community_id = c.id
    left join public.warranty_backcharges wb on wb.org_id = c.org_id and wb.project_id = l.project_id
    where c.org_id = p_org_id and (p_community_id is null or c.id = p_community_id)
    group by c.id, c.name
  ), revenue as (
    select cl.community_id,
      sum(coalesce((cl.settlement->>'final_price_cents')::bigint, i.total_cents::bigint, 0))::bigint closed_revenue_cents
    from public.closings cl
    left join public.invoices i on i.org_id = cl.org_id and i.id = cl.closing_invoice_id
    where cl.org_id = p_org_id and cl.status = 'closed'
    group by cl.community_id
  )
  select cc.community_id, cc.community_name, cc.warranty_cost_cents, cc.recovered_cents,
    (cc.warranty_cost_cents - cc.recovered_cents)::bigint net_cost_cents,
    coalesce(r.closed_revenue_cents, 0)::bigint closed_revenue_cents,
    case when coalesce(r.closed_revenue_cents, 0) > 0
      then round((cc.warranty_cost_cents - cc.recovered_cents) * 100.0 / r.closed_revenue_cents, 3)
      else null end cost_percent
  from community_costs cc left join revenue r on r.community_id = cc.community_id
  order by cc.community_name;
$$;

revoke all on function public.warranty_defect_analysis(uuid,text,timestamptz,timestamptz) from public, anon;
revoke all on function public.warranty_cost_summary(uuid,uuid) from public, anon;
grant execute on function public.warranty_defect_analysis(uuid,text,timestamptz,timestamptz)
  to authenticated, service_role;
grant execute on function public.warranty_cost_summary(uuid,uuid)
  to authenticated, service_role;

comment on table public.warranty_backcharges is
  'Warranty recovery attribution linked to the request and originating commitment; vendor_credit_bill_id is the AP money artifact.';
