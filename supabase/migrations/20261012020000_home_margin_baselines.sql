-- Locked-in sale price and margin for production homes.
--
-- 1. A binding purchase agreement's price is the price. Nothing stopped an
--    UPDATE of a signed agreement's `snapshot` (configuration and pricing:
--    base, lot premium, options, incentives, quote hash, catalog revision) or
--    its `total_cents`, so the contract a buyer signed could be repriced after
--    the fact by any path that wrote the row. An agreement is binding once it
--    has been executed (`status = 'active'`, set with `signed_at` by
--    executePurchaseAgreementFromEnvelopeExecution) or signed; imported open
--    WIP agreements arrive `active` and are binding the same way. From then on
--    its pricing columns are refused for every role, the service role
--    included. Status, signing and void metadata still move: voiding adds
--    `cancellation_reason` / `cancelled_at` to the snapshot, and only those
--    keys. A change to what the buyer pays is a change order, which the
--    closing settlement adds to the agreement total.
--
-- 2. home_margin_baselines: the sale price, cost and margin a home was sold at
--    (stage 'agreement') and released at (stage 'release'), captured once by
--    the service role and never rewritten. Production reporting reads current
--    margin against it; a change order, a VPO or a catalog repricing moves the
--    current number and leaves this one alone. A row leaves only with its
--    home or its organization.

-- ---------------------------------------------------------------------------
-- 1. Binding purchase agreements keep their price.
-- ---------------------------------------------------------------------------

create or replace function public.guard_binding_purchase_agreement_pricing()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  void_keys constant text[] := array['cancellation_reason', 'cancelled_at'];
  old_snapshot jsonb := coalesce(old.snapshot, '{}'::jsonb);
  new_snapshot jsonb := coalesce(new.snapshot, '{}'::jsonb);
  voiding boolean := old.status is distinct from 'void' and new.status = 'void';
begin
  if old.contract_type is distinct from 'purchase_agreement'
     or not (old.status = 'active' or old.signed_at is not null) then
    return new;
  end if;
  if new.contract_type is distinct from old.contract_type
     or new.org_id is distinct from old.org_id
     or new.project_id is distinct from old.project_id
     or new.total_cents is distinct from old.total_cents
     or new.currency is distinct from old.currency
     or (new_snapshot - void_keys) is distinct from (old_snapshot - void_keys)
     or (not voiding and (new_snapshot -> 'cancellation_reason' is distinct from old_snapshot -> 'cancellation_reason'
                          or new_snapshot -> 'cancelled_at' is distinct from old_snapshot -> 'cancelled_at'))
  then
    raise exception 'A signed purchase agreement''s price and configuration cannot be changed. Amend it with a change order.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_binding_purchase_agreement_pricing() from public, anon, authenticated;

drop trigger if exists binding_purchase_agreement_pricing on public.contracts;
create trigger binding_purchase_agreement_pricing
  before update on public.contracts
  for each row execute function public.guard_binding_purchase_agreement_pricing();

-- ---------------------------------------------------------------------------
-- 2. The baselines.
-- ---------------------------------------------------------------------------

create table if not exists public.home_margin_baselines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null,
  contract_id uuid references public.contracts(id),
  stage text not null,
  sale_price_cents integer,
  incentives_cents integer,
  lot_premium_cents integer,
  options_price_cents integer,
  base_cost_cents integer,
  options_cost_cents integer,
  cost_cents integer,
  margin_cents integer,
  margin_bps integer,
  catalog_revision bigint,
  basis jsonb not null default '{}'::jsonb,
  captured_at timestamptz not null default now(),
  captured_by uuid references public.app_users(id),
  constraint home_margin_baselines_project_fkey
    foreign key (org_id, project_id) references public.projects(org_id, id) on delete cascade,
  constraint home_margin_baselines_stage_check check (stage in ('agreement', 'release')),
  constraint home_margin_baselines_agreement_has_contract check (stage <> 'agreement' or contract_id is not null),
  constraint home_margin_baselines_margin_check check (
    (margin_cents is null) = (sale_price_cents is null or cost_cents is null)
    and (margin_cents is null or margin_cents = sale_price_cents - cost_cents)
    and (margin_bps is null or margin_cents is not null)
  )
);

-- One release baseline per home, and one agreement baseline per agreement: a
-- home whose agreement is voided and sold again gets the new sale's baseline
-- beside the first, and the newest is the home's original.
create unique index home_margin_baselines_release_key on public.home_margin_baselines (project_id) where stage = 'release';
create unique index home_margin_baselines_agreement_key on public.home_margin_baselines (contract_id) where stage = 'agreement';

create index if not exists home_margin_baselines_org_project_idx
  on public.home_margin_baselines (org_id, project_id);
create index if not exists home_margin_baselines_contract_idx
  on public.home_margin_baselines (contract_id) where contract_id is not null;
create index if not exists home_margin_baselines_captured_by_idx
  on public.home_margin_baselines (captured_by) where captured_by is not null;

comment on table public.home_margin_baselines is
  'The sale price, cost and margin a production home was sold at (agreement) and released at (release), in integer cents. Written once by the service role (lib/services/home-margin-baselines.ts); never updated; removed only with the home or the organization.';

-- Write-once. The only way a row leaves is its home or organization being
-- deleted: inside that cascade the parent row is already gone, which is never
-- true of a live baseline. `captured_by` is a plain reference with no action,
-- so removing the user who captured a baseline is refused rather than
-- rewriting it.
create or replace function public.guard_home_margin_baseline_write_once()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.projects p where p.id = old.project_id and p.org_id = old.org_id) then
      return old;
    end if;
    raise exception 'A home''s margin baseline cannot be deleted' using errcode = '42501';
  end if;
  raise exception 'A home''s margin baseline cannot be changed' using errcode = '42501';
end;
$$;

revoke all on function public.guard_home_margin_baseline_write_once() from public, anon, authenticated, service_role;

drop trigger if exists home_margin_baselines_write_once on public.home_margin_baselines;
create trigger home_margin_baselines_write_once
  before update or delete on public.home_margin_baselines
  for each row execute function public.guard_home_margin_baseline_write_once();

alter table public.home_margin_baselines enable row level security;

drop policy if exists home_margin_baselines_read on public.home_margin_baselines;
create policy home_margin_baselines_read on public.home_margin_baselines
  for select
  to authenticated
  using (public.is_org_member(org_id));

-- The division wall, as on every other table that hangs off a home.
drop policy if exists home_margin_baselines_division_scope on public.home_margin_baselines;
create policy home_margin_baselines_division_scope on public.home_margin_baselines
  as restrictive
  for all
  to authenticated
  using (
    org_id = any ((select public.member_unscoped_org_ids())::uuid[])
    or project_id in (select public.member_reachable_project_ids())
  )
  with check (
    org_id = any ((select public.member_unscoped_org_ids())::uuid[])
    or project_id in (select public.member_reachable_project_ids())
  );

revoke all on table public.home_margin_baselines from anon, authenticated;
grant select on table public.home_margin_baselines to authenticated;
grant all on table public.home_margin_baselines to service_role;
