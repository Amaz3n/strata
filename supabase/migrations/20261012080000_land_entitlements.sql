-- Entitlements and the conditions attached to them, as blockers.
--
-- A plat that has not recorded, a zoning case still at council, or a condition
-- of approval ("signal at FM 1431 before the 50th certificate of occupancy")
-- decides whether a lot can be delivered, a house started or a home closed.
-- None of it was recorded, so nothing could hold a start for it.
--
-- 1. land_entitlements: one approval a community (or one of its phases) needs
--    -- zoning, plats, site plans, development agreements, utility service,
--    environmental permits -- with its jurisdiction, status, dates and the
--    milestone it must be in hand before (lot delivery, vertical start,
--    closing; null = tracked, never blocks) and the date it is expected by.
-- 2. land_entitlement_conditions: the conditions attached to an approval. A
--    condition belongs to its entitlement's community and may narrow to one
--    phase, never widen. Met (with a date) or waived (with a reason).
--    Entitlements are community facts: community.read reads them and
--    community.write records them, walled by the community's division.
--    Whether something blocks is decided in lib/land/entitlement-readiness.ts.
-- 3. The `entitlements` start gate (auto source entitlements_clear): holds a
--    start while an entitlement or condition required before vertical start is
--    unmet for the lot's phase. It is waivable with a reason like every gate.
--    Open and ready packages get the gate pending; the next refresh passes it
--    wherever nothing blocks, so an org that records no entitlements sees it
--    clear.
-- 4. Search: land_opportunity (20261012070000) and land_entitlement documents
--    carry their division -- the deal's, and the community's -- and follow it.

set local lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. Entitlements.
-- ---------------------------------------------------------------------------

create table if not exists public.land_entitlements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  community_id uuid not null references public.communities(id) on delete cascade,
  community_phase_id uuid references public.community_phases(id) on delete set null,
  kind text not null,
  name text not null,
  jurisdiction text,
  agency_company_id uuid references public.companies(id) on delete set null,
  reference_number text,
  status text not null default 'not_started',
  required_before text,
  submitted_on date,
  -- When it is expected in hand; past it, an unapproved entitlement is overdue.
  target_on date,
  approved_on date,
  expires_on date,
  owner_user_id uuid references public.app_users(id) on delete set null,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint land_entitlements_kind_check check (kind in (
    'zoning', 'annexation', 'preliminary_plat', 'final_plat', 'site_plan', 'development_agreement',
    'utility_service', 'environmental_permit', 'other'
  )),
  constraint land_entitlements_status_check
    check (status in ('not_started', 'submitted', 'approved', 'denied', 'expired', 'withdrawn')),
  constraint land_entitlements_required_before_check
    check (required_before is null or required_before in ('lot_delivery', 'vertical_start', 'closing')),
  constraint land_entitlements_approved_check check (status <> 'approved' or approved_on is not null),
  constraint land_entitlements_name_check check (length(btrim(name)) > 0 and length(name) <= 200),
  constraint land_entitlements_notes_check check (notes is null or length(notes) <= 4000),
  constraint land_entitlements_metadata_check check (jsonb_typeof(metadata) = 'object')
);

create index if not exists land_entitlements_org_community_idx
  on public.land_entitlements (org_id, community_id, community_phase_id);
create index if not exists land_entitlements_community_idx on public.land_entitlements (community_id);
create index if not exists land_entitlements_phase_idx
  on public.land_entitlements (community_phase_id) where community_phase_id is not null;
create index if not exists land_entitlements_agency_idx
  on public.land_entitlements (agency_company_id) where agency_company_id is not null;
create index if not exists land_entitlements_owner_idx
  on public.land_entitlements (owner_user_id) where owner_user_id is not null;
create index if not exists land_entitlements_created_by_idx
  on public.land_entitlements (created_by) where created_by is not null;
create index if not exists land_entitlements_expiry_idx
  on public.land_entitlements (org_id, expires_on) where status = 'approved' and expires_on is not null;

comment on table public.land_entitlements is
  'An approval a community or phase needs (zoning, plat, agreement...). Whether it blocks a milestone is decided in lib/land/entitlement-readiness.ts.';

-- ---------------------------------------------------------------------------
-- 2. Conditions.
-- ---------------------------------------------------------------------------

create table if not exists public.land_entitlement_conditions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  entitlement_id uuid not null references public.land_entitlements(id) on delete cascade,
  community_id uuid not null references public.communities(id) on delete cascade,
  community_phase_id uuid references public.community_phases(id) on delete set null,
  title text not null,
  description text,
  required_before text,
  due_on date,
  owner_user_id uuid references public.app_users(id) on delete set null,
  owner_company_id uuid references public.companies(id) on delete set null,
  status text not null default 'open',
  met_on date,
  resolved_by uuid references public.app_users(id) on delete set null,
  waived_reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint land_entitlement_conditions_status_check check (status in ('open', 'met', 'waived')),
  constraint land_entitlement_conditions_required_before_check
    check (required_before is null or required_before in ('lot_delivery', 'vertical_start', 'closing')),
  constraint land_entitlement_conditions_met_check check ((status = 'met') = (met_on is not null)),
  constraint land_entitlement_conditions_waiver_check
    check (status <> 'waived' or length(btrim(coalesce(waived_reason, ''))) >= 10),
  constraint land_entitlement_conditions_title_check check (length(btrim(title)) > 0 and length(title) <= 300),
  constraint land_entitlement_conditions_description_check check (description is null or length(description) <= 4000),
  constraint land_entitlement_conditions_metadata_check check (jsonb_typeof(metadata) = 'object')
);

create index if not exists land_entitlement_conditions_org_community_idx
  on public.land_entitlement_conditions (org_id, community_id, community_phase_id);
create index if not exists land_entitlement_conditions_entitlement_idx
  on public.land_entitlement_conditions (entitlement_id);
create index if not exists land_entitlement_conditions_community_idx
  on public.land_entitlement_conditions (community_id);
create index if not exists land_entitlement_conditions_due_idx
  on public.land_entitlement_conditions (org_id, due_on) where status = 'open' and due_on is not null;
create index if not exists land_entitlement_conditions_phase_idx
  on public.land_entitlement_conditions (community_phase_id) where community_phase_id is not null;
create index if not exists land_entitlement_conditions_owner_idx
  on public.land_entitlement_conditions (owner_user_id) where owner_user_id is not null;
create index if not exists land_entitlement_conditions_company_idx
  on public.land_entitlement_conditions (owner_company_id) where owner_company_id is not null;
create index if not exists land_entitlement_conditions_resolved_by_idx
  on public.land_entitlement_conditions (resolved_by) where resolved_by is not null;

-- Every reference stays inside the organization and the community; a condition
-- sits in its entitlement's community and may narrow to a phase, never widen.
create or replace function public.guard_land_entitlement_references()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entitlement public.land_entitlements%rowtype;
begin
  if not exists (select 1 from public.communities c where c.id = new.community_id and c.org_id = new.org_id) then
    raise exception 'The community does not belong to this organization' using errcode = '23503';
  end if;
  if new.community_phase_id is not null and not exists (
    select 1 from public.community_phases p
    where p.id = new.community_phase_id and p.org_id = new.org_id and p.community_id = new.community_id
  ) then
    raise exception 'The phase does not belong to this community' using errcode = '23503';
  end if;
  if new.owner_user_id is not null
     and not exists (select 1 from public.memberships m where m.user_id = new.owner_user_id and m.org_id = new.org_id) then
    raise exception 'The owner is not a member of this organization' using errcode = '23503';
  end if;

  if tg_table_name = 'land_entitlements' then
    if new.agency_company_id is not null
       and not exists (select 1 from public.companies c where c.id = new.agency_company_id and c.org_id = new.org_id) then
      raise exception 'The agency does not belong to this organization' using errcode = '23503';
    end if;
    return new;
  end if;

  select * into v_entitlement from public.land_entitlements e where e.id = new.entitlement_id;
  if not found or v_entitlement.org_id is distinct from new.org_id then
    raise exception 'The entitlement does not belong to this organization' using errcode = '23503';
  end if;
  if v_entitlement.community_id is distinct from new.community_id then
    raise exception 'A condition belongs to its entitlement''s community' using errcode = '23514';
  end if;
  if v_entitlement.community_phase_id is not null
     and new.community_phase_id is distinct from v_entitlement.community_phase_id then
    raise exception 'A condition can narrow its entitlement to a phase, never widen it' using errcode = '23514';
  end if;
  if new.owner_company_id is not null
     and not exists (select 1 from public.companies c where c.id = new.owner_company_id and c.org_id = new.org_id) then
    raise exception 'The company does not belong to this organization' using errcode = '23503';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_land_entitlement_references() from public, anon, authenticated;

drop trigger if exists land_entitlements_references on public.land_entitlements;
create trigger land_entitlements_references
  before insert or update of org_id, community_id, community_phase_id, agency_company_id, owner_user_id
  on public.land_entitlements
  for each row execute function public.guard_land_entitlement_references();

drop trigger if exists land_entitlement_conditions_references on public.land_entitlement_conditions;
create trigger land_entitlement_conditions_references
  before insert or update of org_id, entitlement_id, community_id, community_phase_id, owner_user_id, owner_company_id
  on public.land_entitlement_conditions
  for each row execute function public.guard_land_entitlement_references();

-- An entitlement stays with its community: its conditions, documents and search
-- entry were filed there.
create or replace function public.guard_land_entitlement_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.org_id is distinct from old.org_id or new.community_id is distinct from old.community_id then
    raise exception 'An entitlement cannot move to another community' using errcode = '42501';
  end if;
  if tg_table_name = 'land_entitlement_conditions' then
    if new.entitlement_id is distinct from old.entitlement_id then
      raise exception 'A condition cannot move to another entitlement' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_land_entitlement_identity() from public, anon, authenticated;

drop trigger if exists land_entitlements_identity on public.land_entitlements;
create trigger land_entitlements_identity
  before update on public.land_entitlements
  for each row execute function public.guard_land_entitlement_identity();

drop trigger if exists land_entitlement_conditions_identity on public.land_entitlement_conditions;
create trigger land_entitlement_conditions_identity
  before update on public.land_entitlement_conditions
  for each row execute function public.guard_land_entitlement_identity();

-- Narrowing an entitlement to a phase narrows the conditions that would
-- otherwise be wider than it.
create or replace function public.tg_land_entitlement_phase_follow()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.community_phase_id is not null then
    update public.land_entitlement_conditions c
       set community_phase_id = new.community_phase_id
     where c.org_id = new.org_id
       and c.entitlement_id = new.id
       and c.community_phase_id is distinct from new.community_phase_id;
  end if;
  return null;
end;
$$;

revoke all on function public.tg_land_entitlement_phase_follow() from public, anon, authenticated;

drop trigger if exists land_entitlements_phase_follow on public.land_entitlements;
create trigger land_entitlements_phase_follow
  after update of community_phase_id on public.land_entitlements
  for each row
  when (old.community_phase_id is distinct from new.community_phase_id)
  execute function public.tg_land_entitlement_phase_follow();

drop trigger if exists land_entitlements_set_updated_at on public.land_entitlements;
create trigger land_entitlements_set_updated_at
  before update on public.land_entitlements
  for each row execute function public.tg_set_updated_at();

drop trigger if exists land_entitlement_conditions_set_updated_at on public.land_entitlement_conditions;
create trigger land_entitlement_conditions_set_updated_at
  before update on public.land_entitlement_conditions
  for each row execute function public.tg_set_updated_at();

-- Row security: community facts, read with community.read and recorded with
-- community.write, walled by the community's division like phases and takedowns.
alter table public.land_entitlements enable row level security;
alter table public.land_entitlement_conditions enable row level security;

do $$
declare
  v_table text;
begin
  foreach v_table in array array['land_entitlements', 'land_entitlement_conditions'] loop
    execute format('drop policy if exists %I on public.%I', v_table || '_read', v_table);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.has_org_permission(org_id, %L))',
      v_table || '_read', v_table, 'community.read'
    );
    execute format('drop policy if exists %I on public.%I', v_table || '_insert', v_table);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (public.has_org_permission(org_id, %L))',
      v_table || '_insert', v_table, 'community.write'
    );
    execute format('drop policy if exists %I on public.%I', v_table || '_update', v_table);
    execute format(
      'create policy %I on public.%I for update to authenticated using (public.has_org_permission(org_id, %L)) with check (public.has_org_permission(org_id, %L))',
      v_table || '_update', v_table, 'community.write', 'community.write'
    );
    execute format('drop policy if exists %I on public.%I', v_table || '_delete', v_table);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (public.has_org_permission(org_id, %L))',
      v_table || '_delete', v_table, 'community.write'
    );
    execute format('drop policy if exists %I on public.%I', v_table || '_division_scope', v_table);
    execute format(
      'create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)',
      v_table || '_division_scope', v_table,
      $clause$(org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
        or community_id in (select public.member_reachable_community_ids()))$clause$,
      $clause$(org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
        or community_id in (select public.member_reachable_community_ids()))$clause$
    );
    execute format('revoke all on table public.%I from anon, authenticated', v_table);
    execute format('grant select, insert, update, delete on table public.%I to authenticated', v_table);
    execute format('grant all on table public.%I to service_role', v_table);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. The start gate.
-- ---------------------------------------------------------------------------

alter table public.start_gate_definitions drop constraint if exists start_gate_definitions_auto_source_check;
alter table public.start_gate_definitions add constraint start_gate_definitions_auto_source_check
  check (auto_source is null or auto_source in (
    'selections_locked', 'budget_generated', 'pos_generated', 'plan_pinned',
    'plot_plan_file', 'po_exceptions_clear', 'entitlements_clear'
  ));

insert into public.start_gate_definitions (org_id, key, label, check_kind, auto_source, applies_when, sort_order)
select distinct d.org_id, 'entitlements', 'Entitlements & conditions met', 'auto', 'entitlements_clear', 'always', 5
from public.start_gate_definitions d
on conflict (org_id, key) do nothing;

insert into public.start_package_gates (org_id, start_package_id, gate_definition_id, status)
select p.org_id, p.id, d.id, 'pending'
from public.start_packages p
join public.start_gate_definitions d on d.org_id = p.org_id and d.key = 'entitlements'
where p.status in ('open', 'ready')
on conflict (start_package_id, gate_definition_id) do nothing;

-- ---------------------------------------------------------------------------
-- 4. Search documents carry the deal's and the entitlement's division.
-- ---------------------------------------------------------------------------

comment on column public.search_documents.division_id is
  'Division of a community, lot, prospect, start package, land deal or entitlement document, or of a lead-filed estimate, proposal, file or bid package with no project (its lead''s community''s division), stamped by tg_search_documents_stamp_division and kept current by the follow triggers. Null for every other document, and for a lead with no community or a community in no division.';

create or replace function public.tg_search_documents_stamp_division()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table text;
  v_found boolean;
  v_project_id uuid;
  v_prospect_id uuid;
begin
  new.division_id := case new.entity_type
    when 'community' then (
      select c.division_id from public.communities c where c.org_id = new.org_id and c.id = new.entity_id
    )
    when 'lot' then (
      select l.division_id from public.lots l where l.org_id = new.org_id and l.id = new.entity_id
    )
    when 'prospect' then (
      select c.division_id
      from public.prospects p
      join public.communities c on c.org_id = p.org_id and c.id = p.community_id
      where p.org_id = new.org_id and p.id = new.entity_id
    )
    when 'start_package' then (
      select l.division_id
      from public.start_packages sp
      join public.lots l on l.org_id = sp.org_id and l.id = sp.lot_id
      where sp.org_id = new.org_id and sp.id = new.entity_id
    )
    when 'land_opportunity' then (
      select o.division_id from public.land_opportunities o where o.org_id = new.org_id and o.id = new.entity_id
    )
    when 'land_entitlement' then (
      select c.division_id
      from public.land_entitlements e
      join public.communities c on c.org_id = e.org_id and c.id = e.community_id
      where e.org_id = new.org_id and e.id = new.entity_id
    )
  end;

  v_table := case new.entity_type
    when 'project' then 'projects'
    when 'bid_package' then 'bid_packages'
    when 'budget' then 'budgets'
    when 'budget_transfer' then 'budget_transfers'
    when 'certified_payroll_report' then 'certified_payroll_reports'
    when 'change_event' then 'change_events'
    when 'change_order' then 'change_orders'
    when 'closing' then 'closings'
    when 'commitment' then 'commitments'
    when 'commitment_change_order' then 'commitment_change_orders'
    when 'contract' then 'contracts'
    when 'daily_log' then 'daily_logs'
    when 'design_studio_appointment' then 'design_studio_appointments'
    when 'drawing_set' then 'drawing_sets'
    when 'drawing_sheet' then 'drawing_sheets'
    when 'estimate' then 'estimates'
    when 'expense' then 'project_expenses'
    when 'file' then 'files'
    when 'inspection' then 'inspections'
    when 'invoice' then 'invoices'
    when 'meeting' then 'meetings'
    when 'meeting_transcript' then 'meeting_transcripts'
    when 'observation' then 'observations'
    when 'pay_application' then 'pay_applications'
    when 'payable' then 'vendor_bills'
    when 'photo' then 'photos'
    when 'portal_access' then 'portal_access_tokens'
    when 'project_email' then 'project_emails'
    when 'project_location' then 'project_locations'
    when 'proposal' then 'proposals'
    when 'punch_item' then 'punch_items'
    when 'rfi' then 'rfis'
    when 'safety_incident' then 'safety_incidents'
    when 'schedule_item' then 'schedule_items'
    when 'spec_section' then 'spec_sections'
    when 'start_package' then 'start_packages'
    when 'submittal' then 'submittals'
    when 'takeoff_condition' then 'takeoff_conditions'
    when 'task' then 'tasks'
    when 'transmittal' then 'transmittals'
    when 'warranty_backcharge' then 'warranty_backcharges'
    when 'warranty_request' then 'warranty_requests'
  end;

  if v_table in ('estimates', 'proposals', 'files', 'bid_packages') then
    execute format('select true, t.project_id, t.prospect_id from public.%I t where t.org_id = $1 and t.id = $2', v_table)
    into v_found, v_project_id, v_prospect_id
    using new.org_id, new.entity_id;
    if v_found then
      new.project_id := v_project_id;
      if v_project_id is null and v_prospect_id is not null then
        new.division_id := (
          select c.division_id
          from public.prospects p
          join public.communities c on c.org_id = p.org_id and c.id = p.community_id
          where p.org_id = new.org_id and p.id = v_prospect_id
        );
      elsif v_project_id is null and v_table = 'bid_packages' then
        -- A package bid for a community (no home, no lead) belongs to that
        -- community's division.
        new.division_id := (
          select c.division_id
          from public.bid_packages b
          join public.communities c on c.org_id = b.org_id and c.id = b.community_id
          where b.org_id = new.org_id and b.id = new.entity_id
        );
      end if;
    end if;
  elsif v_table is not null then
    execute format(
      'select true, t.%I from public.%I t where t.org_id = $1 and t.id = $2',
      case when v_table = 'projects' then 'id' else 'project_id' end,
      v_table
    )
    into v_found, v_project_id
    using new.org_id, new.entity_id;
    if v_found then
      new.project_id := v_project_id;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.tg_search_documents_stamp_division() from public, anon, authenticated;

drop trigger if exists land_opportunities_search_follow_division on public.land_opportunities;
create trigger land_opportunities_search_follow_division
  after update of division_id on public.land_opportunities
  for each row
  when (old.division_id is distinct from new.division_id)
  execute function public.tg_search_documents_restamp('land_opportunity');

drop trigger if exists communities_search_follow_division_entitlements on public.communities;
create trigger communities_search_follow_division_entitlements
  after update on public.communities
  for each row
  when (old.division_id is distinct from new.division_id)
  execute function public.tg_search_documents_restamp_children('land_entitlement', 'land_entitlements', 'community_id');

-- A deal or an entitlement in no division is reachable only by members who
-- reach every division, exactly as its record is.
drop policy if exists search_documents_division_scope on public.search_documents;
create policy search_documents_division_scope on public.search_documents
  as restrictive
  for all
  to authenticated
  using (
    (
      project_id is null
      or org_id = any ((select public.member_unscoped_org_ids())::uuid[])
      or project_id in (select public.member_reachable_project_ids())
    )
    and (
      entity_type not in (
        'community', 'lot', 'start_package', 'prospect', 'estimate', 'proposal', 'file', 'bid_package',
        'land_opportunity', 'land_entitlement'
      )
      or (entity_type in ('prospect', 'estimate', 'proposal', 'file', 'bid_package') and division_id is null)
      or org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
      or division_id in (select public.member_reachable_division_ids())
    )
  )
  with check (
    (
      project_id is null
      or org_id = any ((select public.member_unscoped_org_ids())::uuid[])
      or project_id in (select public.member_reachable_project_ids())
    )
    and (
      entity_type not in (
        'community', 'lot', 'start_package', 'prospect', 'estimate', 'proposal', 'file', 'bid_package',
        'land_opportunity', 'land_entitlement'
      )
      or (entity_type in ('prospect', 'estimate', 'proposal', 'file', 'bid_package') and division_id is null)
      or org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
      or division_id in (select public.member_reachable_division_ids())
    )
  );
