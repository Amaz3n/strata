-- Rolling a plan change out to homes that already carry the plan.
--
-- A released plan version is immutable, and releasing a new one leaves every
-- home pinned where it was. Until now nothing asked what should happen to those
-- homes: an unsold lot kept a superseded pin, a contracted home failed its plan
-- gate at start with no way to say "build it as sold", and a released home
-- never heard about the change. A plan change proposal is that question, asked
-- once per new version and answered home by home by someone with authority:
--
-- 1. plan_change_proposals: one review of moving a plan's homes onto one
--    version (to_version_id, a draft or released version of the plan).
--    draft -> in_review -> decided, or withdrawn. One open review per plan.
--    The plan library is org-wide, so the review is org-scoped like the plan.
-- 2. plan_change_proposal_homes: every home pinned to an older version of the
--    plan when the review was opened, with the state it was in (unsold, spec,
--    contracted = binding purchase agreement, released = start package
--    released), the version it was pinned to, the takeoff cost delta to the
--    new version and the proposed price amendment. Each home's decision is
--    adopt, decline or defer; adopt and decline are final. An adopted
--    contracted or released home names the change order that amends its
--    agreement and is adopted (adopted_at) only when that change order is
--    executed. A decline is the record that lets a contracted home start on
--    the version it was sold at (lib/services/starts.ts, plan gate).
--    Walled by the home's lot and project, like the lots and homes it names.
-- 3. RBAC: plan.adopt, granted to every role that holds plan.release (the
--    authority that releases a version decides who moves onto it).

-- ---------------------------------------------------------------------------
-- 1. The review.
-- ---------------------------------------------------------------------------

create table if not exists public.plan_change_proposals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  house_plan_id uuid not null references public.house_plans(id) on delete cascade,
  to_version_id uuid not null references public.house_plan_versions(id) on delete cascade,
  status text not null default 'draft',
  summary text,
  created_by uuid not null references public.app_users(id),
  created_at timestamptz not null default now(),
  submitted_at timestamptz,
  reviewed_by uuid references public.app_users(id),
  decided_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint plan_change_proposals_status_check check (status in ('draft', 'in_review', 'decided', 'withdrawn')),
  constraint plan_change_proposals_summary_check check (summary is null or length(summary) <= 2000),
  constraint plan_change_proposals_decided_check check ((status = 'decided') = (decided_at is not null))
);

-- One open review per plan: two reviews deciding the same homes would race.
create unique index if not exists plan_change_proposals_open_key
  on public.plan_change_proposals (house_plan_id) where status in ('draft', 'in_review');
create index if not exists plan_change_proposals_org_plan_idx
  on public.plan_change_proposals (org_id, house_plan_id, created_at desc);
create index if not exists plan_change_proposals_to_version_idx on public.plan_change_proposals (to_version_id);
create index if not exists plan_change_proposals_created_by_idx on public.plan_change_proposals (created_by);
create index if not exists plan_change_proposals_reviewed_by_idx
  on public.plan_change_proposals (reviewed_by) where reviewed_by is not null;

comment on table public.plan_change_proposals is
  'A review of moving the homes pinned to older versions of a house plan onto one version. Decided home by home in plan_change_proposal_homes (lib/services/plan-change-proposals.ts).';

-- ---------------------------------------------------------------------------
-- 2. The homes it names.
-- ---------------------------------------------------------------------------

create table if not exists public.plan_change_proposal_homes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  proposal_id uuid not null references public.plan_change_proposals(id) on delete cascade,
  lot_id uuid not null references public.lots(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  from_version_id uuid not null references public.house_plan_versions(id) on delete cascade,
  home_state text not null,
  cost_delta_cents bigint not null default 0,
  price_delta_cents bigint not null default 0,
  decision text not null default 'pending',
  decided_by uuid references public.app_users(id),
  decided_at timestamptz,
  reason text,
  change_order_id uuid references public.change_orders(id) on delete set null,
  adopted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint plan_change_proposal_homes_state_check check (home_state in ('unsold', 'spec', 'contracted', 'released')),
  constraint plan_change_proposal_homes_decision_check check (decision in ('pending', 'adopt', 'decline', 'defer')),
  constraint plan_change_proposal_homes_decided_check
    check ((decision = 'pending') = (decided_at is null) and (decided_at is null) = (decided_by is null)),
  constraint plan_change_proposal_homes_reason_check
    check (reason is null or length(reason) <= 2000),
  -- A declined home stays on the version it was sold at; say why.
  constraint plan_change_proposal_homes_decline_reason_check
    check (decision <> 'decline' or length(btrim(coalesce(reason, ''))) >= 10),
  constraint plan_change_proposal_homes_adopted_check check (adopted_at is null or decision = 'adopt'),
  constraint plan_change_proposal_homes_lot_key unique (proposal_id, lot_id)
);

create index if not exists plan_change_proposal_homes_org_project_idx
  on public.plan_change_proposal_homes (org_id, project_id) where project_id is not null;
create index if not exists plan_change_proposal_homes_org_lot_idx
  on public.plan_change_proposal_homes (org_id, lot_id);
create index if not exists plan_change_proposal_homes_lot_idx on public.plan_change_proposal_homes (lot_id);
create index if not exists plan_change_proposal_homes_project_idx
  on public.plan_change_proposal_homes (project_id) where project_id is not null;
create index if not exists plan_change_proposal_homes_from_version_idx
  on public.plan_change_proposal_homes (from_version_id);
create index if not exists plan_change_proposal_homes_change_order_idx
  on public.plan_change_proposal_homes (change_order_id) where change_order_id is not null;
create index if not exists plan_change_proposal_homes_decided_by_idx
  on public.plan_change_proposal_homes (decided_by) where decided_by is not null;
-- The plan gate asks "was keeping this pin decided" per lot.
create index if not exists plan_change_proposal_homes_declined_idx
  on public.plan_change_proposal_homes (org_id, lot_id, from_version_id) where decision = 'decline';

comment on table public.plan_change_proposal_homes is
  'One home in a plan change review: its state and pin when the review opened, the cost and price delta to the new version, and the decision. adopt and decline are final; an adopted sold home is adopted when its change order executes.';

-- Every reference stays inside the organization and the plan under review.
create or replace function public.guard_plan_change_proposal_references()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  review_plan uuid;
begin
  if tg_table_name = 'plan_change_proposals' then
    if not exists (select 1 from public.house_plans p where p.id = new.house_plan_id and p.org_id = new.org_id) then
      raise exception 'The plan does not belong to this organization' using errcode = '23503';
    end if;
    if not exists (
      select 1 from public.house_plan_versions v
      where v.id = new.to_version_id and v.org_id = new.org_id and v.house_plan_id = new.house_plan_id
    ) then
      raise exception 'The version does not belong to this plan' using errcode = '23503';
    end if;
    return new;
  end if;

  select r.house_plan_id into review_plan
  from public.plan_change_proposals r
  where r.id = new.proposal_id and r.org_id = new.org_id;
  if review_plan is null then
    raise exception 'The review does not belong to this organization' using errcode = '23503';
  end if;
  if not exists (select 1 from public.lots l where l.id = new.lot_id and l.org_id = new.org_id) then
    raise exception 'The lot does not belong to this organization' using errcode = '23503';
  end if;
  if new.project_id is not null
     and not exists (select 1 from public.projects p where p.id = new.project_id and p.org_id = new.org_id) then
    raise exception 'The home does not belong to this organization' using errcode = '23503';
  end if;
  if not exists (
    select 1 from public.house_plan_versions v
    where v.id = new.from_version_id and v.org_id = new.org_id and v.house_plan_id = review_plan
  ) then
    raise exception 'The pinned version does not belong to the plan under review' using errcode = '23503';
  end if;
  if new.change_order_id is not null and not exists (
    select 1 from public.change_orders c
    where c.id = new.change_order_id and c.org_id = new.org_id and c.project_id is not distinct from new.project_id
  ) then
    raise exception 'The change order does not belong to this home' using errcode = '23503';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_plan_change_proposal_references() from public, anon, authenticated;

drop trigger if exists plan_change_proposals_references on public.plan_change_proposals;
create trigger plan_change_proposals_references
  before insert or update of org_id, house_plan_id, to_version_id on public.plan_change_proposals
  for each row execute function public.guard_plan_change_proposal_references();

drop trigger if exists plan_change_proposal_homes_references on public.plan_change_proposal_homes;
create trigger plan_change_proposal_homes_references
  before insert or update of org_id, proposal_id, lot_id, project_id, from_version_id, change_order_id
  on public.plan_change_proposal_homes
  for each row execute function public.guard_plan_change_proposal_references();

-- What the home was when the review opened is a record, not a field; adopt and
-- decline are final; an adoption happens once.
create or replace function public.guard_plan_change_proposal_home_decision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.org_id is distinct from old.org_id
     or new.proposal_id is distinct from old.proposal_id
     or new.lot_id is distinct from old.lot_id
     or new.project_id is distinct from old.project_id
     or new.from_version_id is distinct from old.from_version_id
     or new.home_state is distinct from old.home_state
     or new.cost_delta_cents is distinct from old.cost_delta_cents then
    raise exception 'A home''s place in a plan change review cannot be changed' using errcode = '42501';
  end if;
  if old.decision in ('adopt', 'decline')
     and (new.decision is distinct from old.decision
          or new.decided_by is distinct from old.decided_by
          or new.decided_at is distinct from old.decided_at
          or new.reason is distinct from old.reason
          or new.price_delta_cents is distinct from old.price_delta_cents) then
    raise exception 'This home''s decision is final' using errcode = '42501';
  end if;
  if old.adopted_at is not null and new.adopted_at is distinct from old.adopted_at then
    raise exception 'This home has already adopted the change' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_plan_change_proposal_home_decision() from public, anon, authenticated;

drop trigger if exists plan_change_proposal_homes_decision on public.plan_change_proposal_homes;
create trigger plan_change_proposal_homes_decision
  before update on public.plan_change_proposal_homes
  for each row execute function public.guard_plan_change_proposal_home_decision();

drop trigger if exists plan_change_proposals_set_updated_at on public.plan_change_proposals;
create trigger plan_change_proposals_set_updated_at
  before update on public.plan_change_proposals
  for each row execute function public.tg_set_updated_at();

drop trigger if exists plan_change_proposal_homes_set_updated_at on public.plan_change_proposal_homes;
create trigger plan_change_proposal_homes_set_updated_at
  before update on public.plan_change_proposal_homes
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- Row security.
-- ---------------------------------------------------------------------------

alter table public.plan_change_proposals enable row level security;

drop policy if exists plan_change_proposals_read on public.plan_change_proposals;
create policy plan_change_proposals_read on public.plan_change_proposals
  for select
  to authenticated
  using (public.has_org_permission(org_id, 'plan.read'));

drop policy if exists plan_change_proposals_insert on public.plan_change_proposals;
create policy plan_change_proposals_insert on public.plan_change_proposals
  for insert
  to authenticated
  with check (
    public.has_org_permission(org_id, 'plan.write')
    and created_by = (select auth.uid())
    and status = 'draft'
  );

-- Submitting and withdrawing are the author's side (plan.write); closing a
-- review once every home is decided is the reviewer's (plan.adopt).
drop policy if exists plan_change_proposals_update on public.plan_change_proposals;
create policy plan_change_proposals_update on public.plan_change_proposals
  for update
  to authenticated
  using (public.has_org_permission(org_id, 'plan.write') or public.has_org_permission(org_id, 'plan.adopt'))
  with check (public.has_org_permission(org_id, 'plan.write') or public.has_org_permission(org_id, 'plan.adopt'));

revoke all on table public.plan_change_proposals from anon, authenticated;
grant select, insert, update on table public.plan_change_proposals to authenticated;
grant all on table public.plan_change_proposals to service_role;

alter table public.plan_change_proposal_homes enable row level security;

drop policy if exists plan_change_proposal_homes_read on public.plan_change_proposal_homes;
create policy plan_change_proposal_homes_read on public.plan_change_proposal_homes
  for select
  to authenticated
  using (public.has_org_permission(org_id, 'plan.read'));

drop policy if exists plan_change_proposal_homes_insert on public.plan_change_proposal_homes;
create policy plan_change_proposal_homes_insert on public.plan_change_proposal_homes
  for insert
  to authenticated
  with check (
    public.has_org_permission(org_id, 'plan.write')
    and decision = 'pending'
    and adopted_at is null
    and change_order_id is null
  );

-- A decision is recorded in the decider's own name.
drop policy if exists plan_change_proposal_homes_decide on public.plan_change_proposal_homes;
create policy plan_change_proposal_homes_decide on public.plan_change_proposal_homes
  for update
  to authenticated
  using (public.has_org_permission(org_id, 'plan.adopt'))
  with check (
    public.has_org_permission(org_id, 'plan.adopt')
    and (decided_by is null or decided_by = (select auth.uid()))
  );

-- The division wall: a home is reachable when its lot and its project are.
drop policy if exists plan_change_proposal_homes_division_scope on public.plan_change_proposal_homes;
create policy plan_change_proposal_homes_division_scope on public.plan_change_proposal_homes
  as restrictive
  for all
  to authenticated
  using (
    (
      org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
      or lot_id in (select public.member_reachable_lot_ids())
    )
    and (
      project_id is null
      or org_id = any ((select public.member_unscoped_org_ids())::uuid[])
      or project_id in (select public.member_reachable_project_ids())
    )
  )
  with check (
    (
      org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
      or lot_id in (select public.member_reachable_lot_ids())
    )
    and (
      project_id is null
      or org_id = any ((select public.member_unscoped_org_ids())::uuid[])
      or project_id in (select public.member_reachable_project_ids())
    )
  );

revoke all on table public.plan_change_proposal_homes from anon, authenticated;
grant select, insert, update on table public.plan_change_proposal_homes to authenticated;
grant all on table public.plan_change_proposal_homes to service_role;

-- ---------------------------------------------------------------------------
-- 3. RBAC.
-- ---------------------------------------------------------------------------

insert into public.permissions (key, description) values
  ('plan.adopt', 'Decide which homes adopt a new plan version, and amend sold homes for it')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select rp.role_id, 'plan.adopt'
from public.role_permissions rp
where rp.permission_key = 'plan.release'
on conflict (role_id, permission_key) do nothing;
