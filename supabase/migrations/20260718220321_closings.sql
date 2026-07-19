-- Workstream 06 phases 2, 4, and 5: closing pipeline, closing gates,
-- purchase-agreement e-sign source support, and server-side backlog rollups.

create table public.closings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  project_id uuid not null references public.projects(id),
  lot_id uuid references public.lots(id),
  community_id uuid references public.communities(id),
  status text not null default 'projected'
    check (status in ('projected','scheduled','cleared_to_close','closed','cancelled')),
  scheduled_date date,
  actual_date date,
  settlement jsonb not null default '{}'::jsonb,
  closing_invoice_id uuid references public.invoices(id) on delete set null,
  cancel_reason text,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint closings_scheduled_date_required check (
    status not in ('scheduled','cleared_to_close','closed') or scheduled_date is not null
  ),
  constraint closings_actual_date_required check (status <> 'closed' or actual_date is not null),
  constraint closings_cancel_reason_required check (
    status <> 'cancelled' or length(btrim(coalesce(cancel_reason, ''))) > 0
  )
);

create unique index closings_project_uniq on public.closings (project_id)
  where status <> 'cancelled';
create index closings_project_idx on public.closings (project_id);
create index closings_lot_idx on public.closings (lot_id) where lot_id is not null;
create index closings_invoice_idx on public.closings (closing_invoice_id)
  where closing_invoice_id is not null;
create index closings_org_status_idx on public.closings (org_id, status, scheduled_date);
create index closings_community_idx on public.closings (org_id, community_id, status, scheduled_date)
  where community_id is not null;
create index closings_created_by_idx on public.closings (created_by) where created_by is not null;

create table public.closing_checklist_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  closing_id uuid not null references public.closings(id) on delete cascade,
  title text not null check (length(btrim(title)) > 0),
  status text not null default 'open' check (status in ('open','complete','waived')),
  is_gate boolean not null default false,
  due_date date,
  responsible_party text,
  file_id uuid references public.files(id) on delete set null,
  notes text,
  sort_order integer not null default 0,
  completed_at timestamptz,
  completed_by uuid references public.app_users(id) on delete set null,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint closing_checklist_completion_shape check (
    status = 'open' or completed_at is not null
  )
);

create index closing_checklist_items_closing_idx
  on public.closing_checklist_items (org_id, closing_id, sort_order);
create index closing_checklist_items_file_idx on public.closing_checklist_items (file_id)
  where file_id is not null;
create index closing_checklist_items_completed_by_idx on public.closing_checklist_items (completed_by)
  where completed_by is not null;
create index closing_checklist_items_created_by_idx on public.closing_checklist_items (created_by)
  where created_by is not null;

create trigger closings_set_updated_at before update on public.closings
  for each row execute function public.tg_set_updated_at();
create trigger closing_checklist_items_set_updated_at before update on public.closing_checklist_items
  for each row execute function public.tg_set_updated_at();

alter table public.closings enable row level security;
alter table public.closing_checklist_items enable row level security;
create policy closings_org_access on public.closings
  for all to authenticated
  using (org_id in (select org_id from public.memberships where user_id = (select auth.uid()) and status = 'active'))
  with check (org_id in (select org_id from public.memberships where user_id = (select auth.uid()) and status = 'active'));
create policy closing_checklist_items_org_access on public.closing_checklist_items
  for all to authenticated
  using (org_id in (select org_id from public.memberships where user_id = (select auth.uid()) and status = 'active'))
  with check (org_id in (select org_id from public.memberships where user_id = (select auth.uid()) and status = 'active'));

grant select, insert, update, delete on public.closings, public.closing_checklist_items to authenticated;
grant all on public.closings, public.closing_checklist_items to service_role;

-- Purchase agreements reuse the contracts capability; widen its existing type
-- guard instead of introducing a parallel sales-contract table.
alter table public.contracts drop constraint if exists contracts_contract_type_check;
alter table public.contracts add constraint contracts_contract_type_check check (
  contract_type in ('fixed','cost_plus','time_materials','purchase_agreement')
);

-- `contract` is a first-class e-sign source for production purchase agreements.
alter table public.documents drop constraint if exists documents_source_entity_type_chk;
alter table public.documents add constraint documents_source_entity_type_chk check (
  source_entity_type is null or source_entity_type in (
    'estimate','proposal','contract','change_order','lien_waiver','selection',
    'subcontract','subcontract_change_order','closeout','other'
  )
);
alter table public.envelopes drop constraint if exists envelopes_source_entity_type_check;
alter table public.envelopes add constraint envelopes_source_entity_type_check check (
  source_entity_type is null or source_entity_type in (
    'estimate','proposal','contract','change_order','lien_waiver','selection',
    'subcontract','subcontract_change_order','closeout','other'
  )
);

create or replace function public.get_sales_backlog_report(
  p_org_id uuid,
  p_division_id uuid default null
) returns table (
  community_id uuid,
  community_name text,
  division_id uuid,
  spec_units bigint,
  hold_units bigint,
  reserved_units bigint,
  backlog_units bigint,
  backlog_value_cents bigint,
  scheduled_30d_units bigint,
  closed_units_ytd bigint,
  closed_value_ytd_cents bigint,
  avg_days_agreement_to_close numeric,
  cancellation_count bigint,
  cancellation_rate numeric,
  incentive_spend_cents bigint,
  incentive_percent_of_price numeric
) language sql stable security invoker set search_path = public, pg_catalog as $$
  with community_scope as (
    select c.id, c.name, c.division_id
    from public.communities c
    where c.org_id = p_org_id
      and c.archived_at is null
      and (p_division_id is null or c.division_id = p_division_id)
  ), agreements as (
    select l.community_id, ct.id, ct.total_cents, ct.status, ct.signed_at,
      coalesce((ct.snapshot #>> '{purchase_agreement,pricing,incentives_cents}')::bigint, 0) incentives_cents,
      cl.status closing_status, cl.actual_date, cl.scheduled_date,
      coalesce((cl.settlement->>'final_price_cents')::bigint, ct.total_cents::bigint, 0) final_price_cents
    from public.contracts ct
    join public.lots l on l.org_id = ct.org_id and l.project_id = ct.project_id
    left join public.closings cl on cl.org_id = ct.org_id and cl.project_id = ct.project_id
    where ct.org_id = p_org_id and ct.contract_type = 'purchase_agreement'
  ), reservation_rollup as (
    select r.community_id,
      count(*) filter (where r.status = 'hold') hold_units,
      count(*) filter (where r.status = 'reserved') reserved_units,
      count(*) filter (where r.status in ('released','expired')) cancellation_count,
      count(*) total_reservations
    from public.lot_reservations r where r.org_id = p_org_id group by r.community_id
  ), agreement_rollup as (
    select a.community_id,
      count(*) filter (where a.status = 'active' and coalesce(a.closing_status, '') <> 'closed') backlog_units,
      coalesce(sum(a.total_cents) filter (where a.status = 'active' and coalesce(a.closing_status, '') <> 'closed'), 0)::bigint backlog_value_cents,
      count(*) filter (where a.closing_status in ('scheduled','cleared_to_close') and a.scheduled_date between current_date and current_date + 30) scheduled_30d_units,
      count(*) filter (where a.closing_status = 'closed' and a.actual_date >= date_trunc('year', current_date)::date) closed_units_ytd,
      coalesce(sum(a.final_price_cents) filter (where a.closing_status = 'closed' and a.actual_date >= date_trunc('year', current_date)::date), 0)::bigint closed_value_ytd_cents,
      round(avg(a.actual_date - a.signed_at::date) filter (where a.closing_status = 'closed' and a.signed_at is not null), 1) avg_days,
      coalesce(sum(a.incentives_cents) filter (where a.status = 'active' or a.closing_status = 'closed'), 0)::bigint incentive_spend,
      coalesce(sum(a.total_cents) filter (where a.status = 'active' or a.closing_status = 'closed'), 0)::bigint agreement_value
    from agreements a group by a.community_id
  ), specs as (
    select l.community_id, count(*) spec_units
    from public.lots l
    where l.org_id = p_org_id and l.project_id is not null
      and not exists (
        select 1 from public.lot_reservations r
        where r.org_id = l.org_id and r.lot_id = l.id and r.status in ('hold','reserved','converted')
      )
      and not exists (
        select 1 from public.contracts ct
        where ct.org_id = l.org_id and ct.project_id = l.project_id
          and ct.contract_type = 'purchase_agreement' and ct.status = 'active'
      )
    group by l.community_id
  )
  select cs.id, cs.name, cs.division_id,
    coalesce(s.spec_units, 0), coalesce(rr.hold_units, 0), coalesce(rr.reserved_units, 0),
    coalesce(ar.backlog_units, 0), coalesce(ar.backlog_value_cents, 0),
    coalesce(ar.scheduled_30d_units, 0), coalesce(ar.closed_units_ytd, 0),
    coalesce(ar.closed_value_ytd_cents, 0), ar.avg_days,
    coalesce(rr.cancellation_count, 0),
    case when coalesce(rr.total_reservations, 0) = 0 then 0
      else round(rr.cancellation_count::numeric * 100 / rr.total_reservations, 2) end,
    coalesce(ar.incentive_spend, 0),
    case when coalesce(ar.agreement_value, 0) = 0 then 0
      else round(ar.incentive_spend::numeric * 100 / ar.agreement_value, 2) end
  from community_scope cs
  left join specs s on s.community_id = cs.id
  left join reservation_rollup rr on rr.community_id = cs.id
  left join agreement_rollup ar on ar.community_id = cs.id
  order by cs.name;
$$;

revoke all on function public.get_sales_backlog_report(uuid, uuid) from public, anon;
grant execute on function public.get_sales_backlog_report(uuid, uuid) to authenticated, service_role;
