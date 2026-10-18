-- Pricing and selling off aged spec homes.
--
-- 1. projects.completed_on: the day a home was finished (certificate of
--    occupancy or final inspection), recorded by sales for a home Books does not
--    carry in finished inventory. Spec aging reads
--    coalesce(project_financial_settings.books_inventory_completed_on,
--    projects.completed_on); sellable_lot_inventory is redefined to match, so a
--    completed spec outside Books ages instead of looking new forever.
-- 2. spec_price_proposals: every move of a standing spec's asking price or of
--    its own incentive, as a row. A move inside the organization's band applies
--    at once ('applied'); a larger one waits ('proposed') for a second person
--    holding the band's permission. The rows are the home's price history.
--    One open proposal per home; the decider is never the proposer.
--    Bands live in org_settings.settings.spec_price_approval_bands (the org's
--    defaults home; parsed by lib/sales/spec-price-approval-thresholds.ts).
-- 3. spec_dispositions: selling a spec off outside retail (bulk_sale,
--    investor_sale) through the ordinary agreement and closing path. The
--    disposition names the buyer and the price, is approved by a second person,
--    and is carried out by linking the purchase agreement written to that buyer
--    at that price. When the price is below what the home carries in Books, the
--    database refuses to carry it out until a linked write-down
--    (books_inventory_impairments) is approved. Margin baselines, reservations
--    and cancellations are never written here.
--    record_spec_price_move / decide_spec_price_proposal write a move (or a
--    decision) and the lot's asking price in one transaction, as the caller.
-- 4. RBAC: sales.price_approve and sales.disposition_approve, granted to owners
--    and admins (there is no sales-manager role; grant a sales manager the keys
--    as a member override).

-- ---------------------------------------------------------------------------
-- 1. Recorded completion.
-- ---------------------------------------------------------------------------

alter table public.projects add column if not exists completed_on date;

comment on column public.projects.completed_on is
  'The day the home was finished (CO or final inspection), recorded by sales when Books does not carry the home. Spec aging reads coalesce(books_inventory_completed_on, completed_on). Never a projected date.';

create or replace view public.sellable_lot_inventory
with (security_invoker = true)
as
select
  l.id           as lot_id,
  l.org_id,
  l.community_id,
  l.division_id,
  l.project_id,
  l.status,
  l.lot_number,
  l.block,
  concat_ws('-', nullif(l.block, ''), l.lot_number) as lot_label,
  l.house_plan_id,
  l.created_at,
  c.name         as community_name,
  hp.code        as plan_code,
  hp.name        as plan_name,
  hp.beds        as plan_beds,
  case
    when l.asking_price_override_cents is not null then l.asking_price_override_cents
    when base.base_price_cents is null then null
    else base.base_price_cents + l.premium_cents + coalesce(public.project_structural_option_cents(l.project_id), 0)
  end            as asking_price_cents,
  case
    when coalesce(fs.books_inventory_completed_on, home.completed_on) <= current_date
      then current_date - coalesce(fs.books_inventory_completed_on, home.completed_on)
    else 0
  end            as aging_days
from public.lots l
left join public.communities c on c.id = l.community_id and c.org_id = l.org_id
left join public.house_plans hp on hp.id = l.house_plan_id and hp.org_id = l.org_id
left join public.projects home on home.id = l.project_id and home.org_id = l.org_id
left join lateral (
  select a.base_price_cents
  from public.community_plan_availability a
  where a.org_id = l.org_id
    and a.community_id = l.community_id
    and a.house_plan_id = l.house_plan_id
    and a.is_available
    and (a.elevation_id is null or a.elevation_id = l.house_plan_elevation_id)
    and (a.effective_start is null or a.effective_start <= current_date)
    and (a.effective_end is null or a.effective_end >= current_date)
  order by (a.elevation_id is not null) desc
  limit 1
) base on l.house_plan_id is not null
left join lateral (
  select s.books_inventory_completed_on
  from public.project_financial_settings s
  where s.org_id = l.org_id and s.project_id = l.project_id
  order by s.books_inventory_completed_on desc nulls last
  limit 1
) fs on l.project_id is not null;

comment on view public.sellable_lot_inventory is
  'One row per lot with the facts Find a home filters and sorts on: community and plan names, bedrooms, the derived asking price (null when the sheet does not price the plan) and the days a finished home has stood since its recorded completion (Books first, else projects.completed_on). security_invoker so the org RLS on the base tables applies to whoever selects from it.';

-- ---------------------------------------------------------------------------
-- 2. Price and incentive moves.
-- ---------------------------------------------------------------------------

create table if not exists public.spec_price_proposals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  lot_id uuid not null references public.lots(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  community_id uuid not null references public.communities(id) on delete cascade,
  kind text not null,
  -- What the home asked when the move was made: the basis of the band and the
  -- price a decider must still find before the move applies.
  asking_price_cents bigint not null,
  from_cents bigint not null,
  to_cents bigint not null,
  incentive_expires_on date,
  reason text not null,
  required_permission text not null,
  status text not null,
  proposed_by uuid not null references public.app_users(id),
  proposed_at timestamptz not null default now(),
  decided_by uuid references public.app_users(id),
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint spec_price_proposals_kind_check check (kind in ('price', 'incentive')),
  constraint spec_price_proposals_status_check check (status in ('applied', 'proposed', 'approved', 'rejected', 'withdrawn')),
  constraint spec_price_proposals_amounts_check
    check (asking_price_cents >= 0 and from_cents >= 0 and to_cents >= 0 and from_cents <> to_cents),
  constraint spec_price_proposals_price_check
    check (kind <> 'price' or (to_cents > 0 and incentive_expires_on is null)),
  constraint spec_price_proposals_reason_check check (length(btrim(reason)) between 10 and 1000),
  constraint spec_price_proposals_note_check check (decision_note is null or length(decision_note) <= 1000),
  constraint spec_price_proposals_decided_check
    check ((status in ('approved', 'rejected')) = (decided_by is not null)
       and (status in ('approved', 'rejected', 'withdrawn')) = (decided_at is not null)),
  -- The person who proposed a move never approves it.
  constraint spec_price_proposals_independent_check check (decided_by is null or decided_by <> proposed_by)
);

-- One open proposal per home: two waiting moves would each be decided against a stale price.
create unique index if not exists spec_price_proposals_open_key
  on public.spec_price_proposals (lot_id) where status = 'proposed';
create index if not exists spec_price_proposals_org_lot_idx
  on public.spec_price_proposals (org_id, lot_id, created_at desc);
create index if not exists spec_price_proposals_org_project_idx
  on public.spec_price_proposals (org_id, project_id);
create index if not exists spec_price_proposals_org_open_idx
  on public.spec_price_proposals (org_id, proposed_at) where status = 'proposed';
create index if not exists spec_price_proposals_project_idx on public.spec_price_proposals (project_id);
create index if not exists spec_price_proposals_community_idx on public.spec_price_proposals (community_id);
create index if not exists spec_price_proposals_proposed_by_idx on public.spec_price_proposals (proposed_by);
create index if not exists spec_price_proposals_decided_by_idx
  on public.spec_price_proposals (decided_by) where decided_by is not null;

comment on table public.spec_price_proposals is
  'Every move of a standing spec''s asking price or its own incentive. applied = inside the org band, took effect at once; proposed = waiting for a second person with required_permission; approved/rejected/withdrawn are final. The rows are the home''s price history (lib/services/community-sales.ts proposeSpecPriceChange / decideSpecPriceChange).';

-- ---------------------------------------------------------------------------
-- 3. Dispositions.
-- ---------------------------------------------------------------------------

create table if not exists public.spec_dispositions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  lot_id uuid not null references public.lots(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete restrict,
  community_id uuid not null references public.communities(id) on delete cascade,
  kind text not null,
  -- The buyer of record on the agreement that carries the sale.
  counterparty_contact_id uuid not null references public.contacts(id) on delete restrict,
  counterparty_company_id uuid references public.companies(id) on delete restrict,
  price_cents bigint not null,
  asking_price_cents bigint,
  -- What Books carried for the home when the disposition was proposed (0 when Books does not carry it).
  carrying_cents bigint not null default 0,
  reason text not null,
  status text not null default 'proposed',
  proposed_by uuid not null references public.app_users(id),
  proposed_at timestamptz not null default now(),
  decided_by uuid references public.app_users(id),
  decided_at timestamptz,
  decision_note text,
  impairment_id uuid references public.books_inventory_impairments(id) on delete restrict,
  contract_id uuid references public.contracts(id) on delete restrict,
  executed_by uuid references public.app_users(id),
  executed_at timestamptz,
  cancelled_by uuid references public.app_users(id),
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint spec_dispositions_kind_check check (kind in ('bulk_sale', 'investor_sale')),
  constraint spec_dispositions_status_check check (status in ('proposed', 'approved', 'rejected', 'executed', 'cancelled')),
  constraint spec_dispositions_amounts_check
    check (price_cents > 0 and carrying_cents >= 0 and (asking_price_cents is null or asking_price_cents >= 0)),
  constraint spec_dispositions_reason_check check (length(btrim(reason)) between 10 and 2000),
  constraint spec_dispositions_note_check check (decision_note is null or length(decision_note) <= 1000),
  constraint spec_dispositions_decided_check
    check ((status in ('approved', 'rejected', 'executed')) <= (decided_by is not null)
       and (decided_by is null) = (decided_at is null)),
  constraint spec_dispositions_independent_check check (decided_by is null or decided_by <> proposed_by),
  constraint spec_dispositions_executed_check
    check ((status = 'executed') = (executed_at is not null)
       and (executed_at is null) = (executed_by is null)
       and (status <> 'executed' or contract_id is not null)),
  constraint spec_dispositions_cancelled_check
    check ((status = 'cancelled') = (cancelled_at is not null) and (cancelled_at is null) = (cancelled_by is null))
);

-- One disposition in flight per home.
create unique index if not exists spec_dispositions_open_key
  on public.spec_dispositions (project_id) where status in ('proposed', 'approved');
create index if not exists spec_dispositions_org_project_idx
  on public.spec_dispositions (org_id, project_id, created_at desc);
create index if not exists spec_dispositions_org_open_idx
  on public.spec_dispositions (org_id, proposed_at) where status in ('proposed', 'approved');
create index if not exists spec_dispositions_lot_idx on public.spec_dispositions (lot_id);
create index if not exists spec_dispositions_community_idx on public.spec_dispositions (community_id);
create index if not exists spec_dispositions_contact_idx on public.spec_dispositions (counterparty_contact_id);
create index if not exists spec_dispositions_company_idx
  on public.spec_dispositions (counterparty_company_id) where counterparty_company_id is not null;
create index if not exists spec_dispositions_impairment_idx
  on public.spec_dispositions (impairment_id) where impairment_id is not null;
create index if not exists spec_dispositions_contract_idx
  on public.spec_dispositions (contract_id) where contract_id is not null;
create index if not exists spec_dispositions_proposed_by_idx on public.spec_dispositions (proposed_by);
create index if not exists spec_dispositions_decided_by_idx
  on public.spec_dispositions (decided_by) where decided_by is not null;
create index if not exists spec_dispositions_executed_by_idx
  on public.spec_dispositions (executed_by) where executed_by is not null;
create index if not exists spec_dispositions_cancelled_by_idx
  on public.spec_dispositions (cancelled_by) where cancelled_by is not null;

comment on table public.spec_dispositions is
  'Selling a standing spec outside retail (bulk_sale, investor_sale) through the ordinary agreement and closing path: proposed -> approved (a second person) -> executed (linked to the purchase agreement written to the buyer at the price), or rejected/cancelled. Below Books carrying cost, execution needs an approved write-down (lib/services/spec-dispositions.ts).';

-- ---------------------------------------------------------------------------
-- Guards.
-- ---------------------------------------------------------------------------

-- Every reference stays inside the organization and on the one home.
create or replace function public.guard_spec_home_references()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.lots l
    where l.id = new.lot_id and l.org_id = new.org_id
      and l.project_id = new.project_id and l.community_id = new.community_id
  ) then
    raise exception 'The home does not belong to this lot, community or organization' using errcode = '23503';
  end if;
  if tg_table_name = 'spec_dispositions' then
    if not exists (select 1 from public.contacts c where c.id = new.counterparty_contact_id and c.org_id = new.org_id) then
      raise exception 'The buyer does not belong to this organization' using errcode = '23503';
    end if;
    if new.counterparty_company_id is not null
       and not exists (select 1 from public.companies c where c.id = new.counterparty_company_id and c.org_id = new.org_id) then
      raise exception 'The buying company does not belong to this organization' using errcode = '23503';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_spec_home_references() from public, anon, authenticated;

drop trigger if exists spec_price_proposals_references on public.spec_price_proposals;
create trigger spec_price_proposals_references
  before insert on public.spec_price_proposals
  for each row execute function public.guard_spec_home_references();

drop trigger if exists spec_dispositions_references on public.spec_dispositions;
create trigger spec_dispositions_references
  before insert on public.spec_dispositions
  for each row execute function public.guard_spec_home_references();

-- A move is a record: what was proposed never changes, a decision is final, and
-- a decision is made by someone holding the permission the move's band named.
create or replace function public.guard_spec_price_proposal_decision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.org_id is distinct from old.org_id
     or new.lot_id is distinct from old.lot_id
     or new.project_id is distinct from old.project_id
     or new.community_id is distinct from old.community_id
     or new.kind is distinct from old.kind
     or new.asking_price_cents is distinct from old.asking_price_cents
     or new.from_cents is distinct from old.from_cents
     or new.to_cents is distinct from old.to_cents
     or new.incentive_expires_on is distinct from old.incentive_expires_on
     or new.reason is distinct from old.reason
     or new.required_permission is distinct from old.required_permission
     or new.proposed_by is distinct from old.proposed_by
     or new.proposed_at is distinct from old.proposed_at then
    raise exception 'A proposed price change cannot be edited; withdraw it and propose again' using errcode = '42501';
  end if;
  if old.status <> 'proposed' then
    raise exception 'This price change is final' using errcode = '42501';
  end if;
  if (select auth.role()) is distinct from 'service_role' then
    if new.status in ('approved', 'rejected')
       and not public.has_org_permission(new.org_id, new.required_permission) then
      raise exception 'Deciding this price change needs %', new.required_permission using errcode = '42501';
    end if;
    if new.status = 'withdrawn' and new.proposed_by is distinct from (select auth.uid()) then
      raise exception 'Only the person who proposed a price change can withdraw it' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_spec_price_proposal_decision() from public, anon, authenticated;

drop trigger if exists spec_price_proposals_decision on public.spec_price_proposals;
create trigger spec_price_proposals_decision
  before update on public.spec_price_proposals
  for each row execute function public.guard_spec_price_proposal_decision();

-- A disposition's terms never change; it moves proposed -> approved|rejected|cancelled,
-- approved -> executed|cancelled. Carrying it out needs the agreement that carries
-- the sale and, below Books cost, an approved write-down of this home.
create or replace function public.guard_spec_disposition_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  agreement record;
  impairment record;
begin
  if new.org_id is distinct from old.org_id
     or new.lot_id is distinct from old.lot_id
     or new.project_id is distinct from old.project_id
     or new.community_id is distinct from old.community_id
     or new.kind is distinct from old.kind
     or new.counterparty_contact_id is distinct from old.counterparty_contact_id
     or new.counterparty_company_id is distinct from old.counterparty_company_id
     or new.price_cents is distinct from old.price_cents
     or new.asking_price_cents is distinct from old.asking_price_cents
     or new.carrying_cents is distinct from old.carrying_cents
     or new.reason is distinct from old.reason
     or new.proposed_by is distinct from old.proposed_by
     or new.proposed_at is distinct from old.proposed_at then
    raise exception 'A disposition''s terms cannot be edited; cancel it and propose again' using errcode = '42501';
  end if;
  if old.status in ('rejected', 'executed', 'cancelled') then
    raise exception 'This disposition is final' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and not (
    (old.status = 'proposed' and new.status in ('approved', 'rejected', 'cancelled'))
    or (old.status = 'approved' and new.status in ('executed', 'cancelled'))
  ) then
    raise exception 'A disposition cannot move from % to %', old.status, new.status using errcode = '42501';
  end if;
  if (new.decided_by, new.decided_at) is distinct from (old.decided_by, old.decided_at)
     and not (old.status = 'proposed' and new.status in ('approved', 'rejected')) then
    raise exception 'A disposition is decided once' using errcode = '42501';
  end if;
  -- A decision is made in the decider's own name, by a holder of sales.disposition_approve.
  if (select auth.role()) is distinct from 'service_role'
     and old.status = 'proposed' and new.status in ('approved', 'rejected') then
    if not public.has_org_permission(new.org_id, 'sales.disposition_approve') then
      raise exception 'Deciding a disposition needs sales.disposition_approve' using errcode = '42501';
    end if;
    if new.decided_by is distinct from (select auth.uid()) then
      raise exception 'A disposition is decided in the decider''s own name' using errcode = '42501';
    end if;
  end if;

  if new.impairment_id is distinct from old.impairment_id then
    if old.impairment_id is not null
       and exists (select 1 from public.books_inventory_impairments i where i.id = old.impairment_id and i.status = 'approved') then
      raise exception 'An approved write-down stays linked to its disposition' using errcode = '42501';
    end if;
    if new.impairment_id is not null and not exists (
      select 1 from public.books_inventory_impairments i
      where i.id = new.impairment_id and i.org_id = new.org_id and i.project_id = new.project_id
    ) then
      raise exception 'The write-down is not a review of this home' using errcode = '23503';
    end if;
  end if;

  if new.status = 'executed' and old.status = 'approved' then
    select c.status, c.contract_type, c.buyer_contact_id, c.total_cents into agreement
    from public.contracts c
    where c.id = new.contract_id and c.org_id = new.org_id and c.project_id = new.project_id;
    if not found or agreement.contract_type is distinct from 'purchase_agreement' or agreement.status not in ('draft', 'active') then
      raise exception 'A disposition is carried out by an open purchase agreement on this home' using errcode = '23514';
    end if;
    if agreement.buyer_contact_id is distinct from new.counterparty_contact_id then
      raise exception 'The agreement''s buyer is not the disposition''s buyer' using errcode = '23514';
    end if;
    if agreement.total_cents is distinct from new.price_cents then
      raise exception 'The agreement''s price is not the approved disposition price' using errcode = '23514';
    end if;
    if new.price_cents < new.carrying_cents then
      select i.status into impairment from public.books_inventory_impairments i where i.id = new.impairment_id;
      if not found or impairment.status is distinct from 'approved' then
        raise exception 'The price is below the home''s cost in Books; the write-down must be approved first' using errcode = '23514';
      end if;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_spec_disposition_transition() from public, anon, authenticated;

drop trigger if exists spec_dispositions_transition on public.spec_dispositions;
create trigger spec_dispositions_transition
  before update on public.spec_dispositions
  for each row execute function public.guard_spec_disposition_transition();

drop trigger if exists spec_price_proposals_set_updated_at on public.spec_price_proposals;
create trigger spec_price_proposals_set_updated_at
  before update on public.spec_price_proposals
  for each row execute function public.tg_set_updated_at();

drop trigger if exists spec_dispositions_set_updated_at on public.spec_dispositions;
create trigger spec_dispositions_set_updated_at
  before update on public.spec_dispositions
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- Row security.
-- ---------------------------------------------------------------------------

alter table public.spec_price_proposals enable row level security;

drop policy if exists spec_price_proposals_read on public.spec_price_proposals;
create policy spec_price_proposals_read on public.spec_price_proposals
  for select
  to authenticated
  using (public.has_org_permission(org_id, 'sales.read'));

drop policy if exists spec_price_proposals_insert on public.spec_price_proposals;
create policy spec_price_proposals_insert on public.spec_price_proposals
  for insert
  to authenticated
  with check (
    public.has_org_permission(org_id, 'sales.manage')
    and proposed_by = (select auth.uid())
    and status in ('applied', 'proposed')
    and decided_by is null
  );

-- Withdrawing is the proposer's side (sales.manage); deciding is the band's
-- permission, checked by the decision trigger. A decision is in the decider's name.
drop policy if exists spec_price_proposals_update on public.spec_price_proposals;
create policy spec_price_proposals_update on public.spec_price_proposals
  for update
  to authenticated
  using (public.has_org_permission(org_id, 'sales.manage') or public.has_org_permission(org_id, 'sales.price_approve'))
  with check (
    (public.has_org_permission(org_id, 'sales.manage') or public.has_org_permission(org_id, 'sales.price_approve'))
    and (decided_by is null or decided_by = (select auth.uid()))
  );

drop policy if exists spec_price_proposals_division_scope on public.spec_price_proposals;
create policy spec_price_proposals_division_scope on public.spec_price_proposals
  as restrictive
  for all
  to authenticated
  using (
    (
      org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
      or lot_id in (select public.member_reachable_lot_ids())
    )
    and (
      org_id = any ((select public.member_unscoped_org_ids())::uuid[])
      or project_id in (select public.member_reachable_project_ids())
    )
  )
  with check (
    (
      org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
      or lot_id in (select public.member_reachable_lot_ids())
    )
    and (
      org_id = any ((select public.member_unscoped_org_ids())::uuid[])
      or project_id in (select public.member_reachable_project_ids())
    )
  );

revoke all on table public.spec_price_proposals from anon, authenticated;
grant select, insert, update on table public.spec_price_proposals to authenticated;
grant all on table public.spec_price_proposals to service_role;

alter table public.spec_dispositions enable row level security;

drop policy if exists spec_dispositions_read on public.spec_dispositions;
create policy spec_dispositions_read on public.spec_dispositions
  for select
  to authenticated
  using (public.has_org_permission(org_id, 'sales.read'));

drop policy if exists spec_dispositions_insert on public.spec_dispositions;
create policy spec_dispositions_insert on public.spec_dispositions
  for insert
  to authenticated
  with check (
    public.has_org_permission(org_id, 'sales.manage')
    and proposed_by = (select auth.uid())
    and status = 'proposed'
    and decided_by is null
    and impairment_id is null
    and contract_id is null
  );

drop policy if exists spec_dispositions_update on public.spec_dispositions;
create policy spec_dispositions_update on public.spec_dispositions
  for update
  to authenticated
  using (public.has_org_permission(org_id, 'sales.manage') or public.has_org_permission(org_id, 'sales.disposition_approve'))
  with check (
    (public.has_org_permission(org_id, 'sales.manage') or public.has_org_permission(org_id, 'sales.disposition_approve'))
    and (executed_by is null or executed_by = (select auth.uid()))
    and (cancelled_by is null or cancelled_by = (select auth.uid()))
  );

drop policy if exists spec_dispositions_division_scope on public.spec_dispositions;
create policy spec_dispositions_division_scope on public.spec_dispositions
  as restrictive
  for all
  to authenticated
  using (
    (
      org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
      or lot_id in (select public.member_reachable_lot_ids())
    )
    and (
      org_id = any ((select public.member_unscoped_org_ids())::uuid[])
      or project_id in (select public.member_reachable_project_ids())
    )
  )
  with check (
    (
      org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
      or lot_id in (select public.member_reachable_lot_ids())
    )
    and (
      org_id = any ((select public.member_unscoped_org_ids())::uuid[])
      or project_id in (select public.member_reachable_project_ids())
    )
  );

revoke all on table public.spec_dispositions from anon, authenticated;
grant select, insert, update on table public.spec_dispositions to authenticated;
grant all on table public.spec_dispositions to service_role;

-- ---------------------------------------------------------------------------
-- Writes that must land together.
-- ---------------------------------------------------------------------------
-- A move and the price it sets are one fact: the history row and the lot's
-- asking price are written in one transaction, so a refused lot write (the home
-- changed since it was read) leaves no history behind, and a decision is never
-- recorded without its price. Both run as the caller (security invoker), so the
-- policies and guards above apply exactly as they would to a direct write; the
-- service decides the band, the expected price and who may decide before calling.

create or replace function public.record_spec_price_move(
  p_org_id uuid,
  p_lot_id uuid,
  p_project_id uuid,
  p_community_id uuid,
  p_kind text,
  p_asking_price_cents bigint,
  p_from_cents bigint,
  p_to_cents bigint,
  p_expires_on date,
  p_reason text,
  p_required_permission text,
  p_apply boolean,
  p_lot_updated_at timestamptz
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  move_id uuid;
begin
  insert into public.spec_price_proposals (
    org_id, lot_id, project_id, community_id, kind, asking_price_cents, from_cents, to_cents,
    incentive_expires_on, reason, required_permission, status, proposed_by
  ) values (
    p_org_id, p_lot_id, p_project_id, p_community_id, p_kind, p_asking_price_cents, p_from_cents, p_to_cents,
    p_expires_on, p_reason, p_required_permission, case when p_apply then 'applied' else 'proposed' end, (select auth.uid())
  )
  returning id into move_id;

  if p_apply and p_kind = 'price' then
    update public.lots
    set asking_price_override_cents = p_to_cents
    where id = p_lot_id and org_id = p_org_id and updated_at = p_lot_updated_at;
    if not found then
      raise exception 'The home changed while you were repricing it. Review it and try again.' using errcode = '40001';
    end if;
  end if;
  return move_id;
end;
$$;

revoke all on function public.record_spec_price_move(uuid, uuid, uuid, uuid, text, bigint, bigint, bigint, date, text, text, boolean, timestamptz) from public, anon;
grant execute on function public.record_spec_price_move(uuid, uuid, uuid, uuid, text, bigint, bigint, bigint, date, text, text, boolean, timestamptz) to authenticated, service_role;

create or replace function public.decide_spec_price_proposal(
  p_org_id uuid,
  p_proposal_id uuid,
  p_approve boolean,
  p_note text,
  p_lot_updated_at timestamptz
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  proposal record;
begin
  update public.spec_price_proposals
  set status = case when p_approve then 'approved' else 'rejected' end,
      decided_by = (select auth.uid()),
      decided_at = now(),
      decision_note = nullif(btrim(coalesce(p_note, '')), '')
  where id = p_proposal_id and org_id = p_org_id and status = 'proposed'
  returning kind, lot_id, to_cents into proposal;
  if not found then
    raise exception 'This price change was already decided or withdrawn.' using errcode = '40001';
  end if;

  if p_approve and proposal.kind = 'price' then
    update public.lots
    set asking_price_override_cents = proposal.to_cents
    where id = proposal.lot_id and org_id = p_org_id and updated_at = p_lot_updated_at;
    if not found then
      raise exception 'The home changed while you were deciding. Review it and try again.' using errcode = '40001';
    end if;
  end if;
end;
$$;

revoke all on function public.decide_spec_price_proposal(uuid, uuid, boolean, text, timestamptz) from public, anon;
grant execute on function public.decide_spec_price_proposal(uuid, uuid, boolean, text, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. RBAC.
-- ---------------------------------------------------------------------------

insert into public.permissions (key, description) values
  ('sales.price_approve', 'Approve a spec home price or incentive change larger than the organization''s band'),
  ('sales.disposition_approve', 'Approve selling a spec home off in a bulk or investor sale')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from public.roles r
cross join unnest(array['sales.price_approve', 'sales.disposition_approve']) p(permission_key)
where r.key in ('org_owner', 'org_admin')
on conflict (role_id, permission_key) do nothing;
