-- Workstream 04 phase 1: effective-dated vendor price book.

create table public.vendor_price_agreements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  company_id uuid not null references public.companies(id),
  cost_code_id uuid not null references public.cost_codes(id),
  cost_type public.cost_type,
  division_id uuid references public.divisions(id),
  community_id uuid references public.communities(id),
  house_plan_id uuid references public.house_plans(id),
  house_plan_version_id uuid references public.house_plan_versions(id),
  pricing_kind text not null check (pricing_kind in ('unit','lump_sum')),
  uom text,
  unit_cost_cents bigint,
  lump_sum_cents bigint,
  scope_of_work text,
  effective_from date not null default current_date,
  effective_to date,
  status text not null default 'active'
    check (status in ('draft','active','expired','superseded','void')),
  superseded_by_id uuid references public.vendor_price_agreements(id),
  source text not null default 'manual' check (source in ('manual','bid_award','import')),
  source_bid_award_id uuid references public.bid_awards(id),
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vendor_price_agreements_price_shape check (
    (pricing_kind = 'unit' and length(btrim(uom)) > 0 and unit_cost_cents is not null
      and unit_cost_cents >= 0 and lump_sum_cents is null)
    or
    (pricing_kind = 'lump_sum' and lump_sum_cents is not null and lump_sum_cents >= 0
      and unit_cost_cents is null and house_plan_id is not null)
  ),
  constraint vendor_price_agreements_dates check (
    effective_to is null or effective_to >= effective_from
  ),
  constraint vendor_price_agreements_version_scope check (
    house_plan_version_id is null or house_plan_id is not null
  )
);

comment on table public.vendor_price_agreements is
  'Effective-dated purchasing price book. Active price and scope fields are immutable; repricing inserts a successor and supersedes this row.';

create index vpa_resolution_idx on public.vendor_price_agreements
  (org_id, cost_code_id, status, effective_from desc);
create index vpa_company_idx on public.vendor_price_agreements (org_id, company_id, status);
create index vpa_division_idx on public.vendor_price_agreements (division_id) where division_id is not null;
create index vpa_community_idx on public.vendor_price_agreements (org_id, community_id)
  where community_id is not null;
create index vpa_plan_idx on public.vendor_price_agreements (org_id, house_plan_id)
  where house_plan_id is not null;
create index vpa_plan_version_idx on public.vendor_price_agreements (house_plan_version_id)
  where house_plan_version_id is not null;
create index vpa_source_award_idx on public.vendor_price_agreements (source_bid_award_id)
  where source_bid_award_id is not null;
create index vpa_superseded_by_idx on public.vendor_price_agreements (superseded_by_id)
  where superseded_by_id is not null;
create index vpa_expiring_idx on public.vendor_price_agreements (org_id, effective_to)
  where status = 'active' and effective_to is not null;

create trigger vendor_price_agreements_set_updated_at
  before update on public.vendor_price_agreements
  for each row execute function public.tg_set_updated_at();

create function public.tg_vendor_price_agreement_history()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
begin
  if old.status = 'active' and (
    new.org_id is distinct from old.org_id
    or new.company_id is distinct from old.company_id
    or new.cost_code_id is distinct from old.cost_code_id
    or new.cost_type is distinct from old.cost_type
    or new.division_id is distinct from old.division_id
    or new.community_id is distinct from old.community_id
    or new.house_plan_id is distinct from old.house_plan_id
    or new.house_plan_version_id is distinct from old.house_plan_version_id
    or new.pricing_kind is distinct from old.pricing_kind
    or new.uom is distinct from old.uom
    or new.unit_cost_cents is distinct from old.unit_cost_cents
    or new.lump_sum_cents is distinct from old.lump_sum_cents
    or new.scope_of_work is distinct from old.scope_of_work
    or new.effective_from is distinct from old.effective_from
    or new.source is distinct from old.source
    or new.source_bid_award_id is distinct from old.source_bid_award_id
  ) then
    raise exception 'Active price agreements are immutable; create a repriced successor';
  end if;
  return new;
end;
$$;

create trigger vendor_price_agreements_history_guard
  before update on public.vendor_price_agreements
  for each row execute function public.tg_vendor_price_agreement_history();

alter table public.vendor_price_agreements enable row level security;
create policy vendor_price_agreements_org_access on public.vendor_price_agreements
  for all to authenticated
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

grant select, insert, update, delete on public.vendor_price_agreements to authenticated;
grant all on public.vendor_price_agreements to service_role;

create or replace function public.reprice_vendor_price_agreement(
  p_org_id uuid,
  p_agreement_id uuid,
  p_effective_from date,
  p_unit_cost_cents bigint default null,
  p_lump_sum_cents bigint default null,
  p_notes text default null,
  p_actor_id uuid default null
) returns uuid
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_old public.vendor_price_agreements%rowtype;
  v_new_id uuid;
begin
  select * into v_old from public.vendor_price_agreements
    where org_id = p_org_id and id = p_agreement_id for update;
  if not found then raise exception 'Price agreement not found'; end if;
  if v_old.status <> 'active' then raise exception 'Only active agreements can be repriced'; end if;
  if p_effective_from <= v_old.effective_from then
    raise exception 'Reprice effective date must follow the current agreement start';
  end if;
  if v_old.pricing_kind = 'unit' and (p_unit_cost_cents is null or p_lump_sum_cents is not null) then
    raise exception 'Unit repricing requires unit cost only';
  end if;
  if v_old.pricing_kind = 'lump_sum' and (p_lump_sum_cents is null or p_unit_cost_cents is not null) then
    raise exception 'Lump-sum repricing requires lump sum only';
  end if;

  insert into public.vendor_price_agreements (
    org_id, company_id, cost_code_id, cost_type, division_id, community_id,
    house_plan_id, house_plan_version_id, pricing_kind, uom, unit_cost_cents,
    lump_sum_cents, scope_of_work, effective_from, effective_to, status,
    source, source_bid_award_id, notes, metadata, created_by
  ) values (
    v_old.org_id, v_old.company_id, v_old.cost_code_id, v_old.cost_type,
    v_old.division_id, v_old.community_id, v_old.house_plan_id,
    v_old.house_plan_version_id, v_old.pricing_kind, v_old.uom,
    p_unit_cost_cents, p_lump_sum_cents, v_old.scope_of_work, p_effective_from,
    v_old.effective_to, 'active', 'manual', null, p_notes,
    v_old.metadata || jsonb_build_object('repriced_from_id', v_old.id), p_actor_id
  ) returning id into v_new_id;

  update public.vendor_price_agreements set
    status = 'superseded', superseded_by_id = v_new_id,
    effective_to = p_effective_from - 1
  where org_id = p_org_id and id = v_old.id;
  return v_new_id;
end;
$$;

revoke all on function public.reprice_vendor_price_agreement(uuid, uuid, date, bigint, bigint, text, uuid)
  from public, anon, authenticated;
grant execute on function public.reprice_vendor_price_agreement(uuid, uuid, date, bigint, bigint, text, uuid)
  to service_role;
