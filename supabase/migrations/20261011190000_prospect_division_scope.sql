-- Division scope for sales leads, start packages, and every search document
-- that indexes a project's record.
--
-- The division wall (20261011010000, 20261011140000, 20261011180000) left
-- three holes a division-limited member could read through:
--
--   * prospects had no division backstop. The Sales board filtered other
--     divisions' buyers out in application code, but the pipeline list and a
--     direct PostgREST read returned every division's leads.
--   * start_packages had none either. The Starts desk scopes by the lot's
--     division in its query; a direct read did not.
--   * search documents carry a project only when their writer remembers to
--     send one. Prospect and start package documents carried neither a project
--     nor a division; meetings, inspections, transmittals, safety incidents,
--     observations and budget transfers are indexed without a project by the
--     outbox indexer; and search.ts's read-through backfill writes warranty,
--     closing, start, design studio and VPO documents without one. All of them
--     passed the search_documents backstop.
--
-- What belongs to a division, by search entity type:
--   * through a project (scoped by project_id): every type whose table has a
--     project_id column -- tasks, files, money, field, drawings, warranty,
--     closings, design studio appointments, takeoff conditions, ...;
--   * through a community or lot (scoped by division_id): community, lot,
--     prospect (its community), start_package (its lot);
--   * org-wide by nature, unchanged: contact, company, prequalification,
--     payment_run, budget_template, and the catalogs house_plan,
--     selection_option and price_agreement.
--
-- A prospect follows its community. A lead with no community -- an
-- unattributed inquiry -- stays visible to the whole org, as the Sales board
-- has always shown it; so does a lead in a community that is in no division,
-- which the board likewise shows to everyone. Only a lead whose community sits
-- in a division the member is not assigned to is out of reach. A start package
-- follows its lot, exactly as the lot does (no division, no reach).
--
-- This migration:
--   1. adds restrictive division policies to prospects and start_packages;
--   2. stamps search documents with the project of the record they index and
--      the division of prospect and start package documents, from the record
--      itself, on every write;
--   3. keeps those stamps current when a prospect changes community, a start
--      package changes lot or project, a community changes division, or a lot
--      changes division;
--   4. scopes prospect and start package documents in the search backstop;
--   5. backfills existing documents.

set local lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. The tables.
-- ---------------------------------------------------------------------------

create or replace function public.member_foreign_division_community_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.id
  from public.memberships m
  join public.communities c on c.org_id = m.org_id
  where m.user_id = (select auth.uid())
    and m.status = 'active'
    and c.division_id is not null
    and c.division_id not in (select public.member_reachable_division_ids());
$$;

comment on function public.member_foreign_division_community_ids() is
  'Communities in the caller''s orgs filed under a division the caller is not assigned to. Policies use it as an uncorrelated NOT IN so it is built once per statement.';

create or replace function public.member_reachable_lot_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select l.id
  from public.lots l
  where l.division_id in (select public.member_reachable_division_ids());
$$;

comment on function public.member_reachable_lot_ids() is
  'Lots in the divisions a division-restricted caller is assigned to. Policies use it as an uncorrelated IN so it is built once per statement.';

revoke all on function public.member_foreign_division_community_ids() from public, anon;
revoke all on function public.member_reachable_lot_ids() from public, anon;
grant execute on function public.member_foreign_division_community_ids() to authenticated, service_role;
grant execute on function public.member_reachable_lot_ids() to authenticated, service_role;

drop policy if exists prospects_division_scope on public.prospects;
create policy prospects_division_scope on public.prospects
  as restrictive
  for all
  to authenticated
  using (
    community_id is null
    or org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
    or community_id not in (select public.member_foreign_division_community_ids())
  )
  with check (
    community_id is null
    or org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
    or community_id not in (select public.member_foreign_division_community_ids())
  );

drop policy if exists start_packages_division_scope on public.start_packages;
create policy start_packages_division_scope on public.start_packages
  as restrictive
  for all
  to authenticated
  using (
    org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
    or lot_id in (select public.member_reachable_lot_ids())
  )
  with check (
    org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
    or lot_id in (select public.member_reachable_lot_ids())
  );

-- ---------------------------------------------------------------------------
-- 2. Search documents carry the record's project and division.
-- ---------------------------------------------------------------------------

comment on column public.search_documents.division_id is
  'Division of a community, lot, prospect or start package document, stamped from its record by tg_search_documents_stamp_division and kept current by the follow triggers. Null for every other document, and for a prospect with no community or a community in no division.';

-- The project comes from the indexed record whenever its table has one, so a
-- writer that leaves project_id out (or sends the wrong one) cannot file a
-- project's record where every division can read it. The table list mirrors
-- SEARCH_CONFIGS in lib/services/search-config.ts. A lot keeps no project
-- here: lots are division-scoped, not project-scoped. A document whose record
-- is gone keeps what its writer sent.
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
  end;

  v_table := case new.entity_type
    when 'project' then 'projects'
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

  if v_table is not null then
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

drop trigger if exists search_documents_stamp_division on public.search_documents;
create trigger search_documents_stamp_division
  before insert or update of org_id, entity_type, entity_id, project_id, division_id on public.search_documents
  for each row execute function public.tg_search_documents_stamp_division();

-- ---------------------------------------------------------------------------
-- 3. The stamps follow the record.
-- ---------------------------------------------------------------------------

-- Naming division_id in the update is what re-runs the stamp trigger above,
-- which reads the record again; the value written here is replaced.
create or replace function public.tg_search_documents_restamp()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.search_documents d
     set division_id = null
   where d.org_id = new.org_id
     and d.entity_type = tg_argv[0]
     and d.entity_id = new.id;
  return null;
end;
$$;

-- The documents of the records under a parent: tg_argv is the document type,
-- the child table and the child's column naming this parent.
create or replace function public.tg_search_documents_restamp_children()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  execute format(
    'update public.search_documents d
        set division_id = null
      where d.org_id = $1
        and d.entity_type = $2
        and d.entity_id in (select t.id from public.%I t where t.org_id = $1 and t.%I = $3)',
    tg_argv[1],
    tg_argv[2]
  )
  using new.org_id, tg_argv[0], new.id;
  return null;
end;
$$;

revoke all on function public.tg_search_documents_restamp() from public, anon, authenticated;
revoke all on function public.tg_search_documents_restamp_children() from public, anon, authenticated;

drop trigger if exists prospects_search_follow_community on public.prospects;
create trigger prospects_search_follow_community
  after update of community_id on public.prospects
  for each row
  when (old.community_id is distinct from new.community_id)
  execute function public.tg_search_documents_restamp('prospect');

-- A package gains its project when it is opened or released.
drop trigger if exists start_packages_search_follow_lot on public.start_packages;
create trigger start_packages_search_follow_lot
  after update of lot_id, project_id on public.start_packages
  for each row
  when (old.lot_id is distinct from new.lot_id or old.project_id is distinct from new.project_id)
  execute function public.tg_search_documents_restamp('start_package');

drop trigger if exists communities_search_follow_division_prospects on public.communities;
create trigger communities_search_follow_division_prospects
  after update on public.communities
  for each row
  when (old.division_id is distinct from new.division_id)
  execute function public.tg_search_documents_restamp_children('prospect', 'prospects', 'community_id');

-- No column list, as lots_search_follow_division: a community move changes the
-- lot's division without naming it.
drop trigger if exists lots_search_follow_division_start_packages on public.lots;
create trigger lots_search_follow_division_start_packages
  after update on public.lots
  for each row
  when (old.division_id is distinct from new.division_id)
  execute function public.tg_search_documents_restamp_children('start_package', 'start_packages', 'lot_id');

-- ---------------------------------------------------------------------------
-- 4. The search backstop.
-- ---------------------------------------------------------------------------

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
      entity_type not in ('community', 'lot', 'start_package', 'prospect')
      or (entity_type = 'prospect' and division_id is null)
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
      entity_type not in ('community', 'lot', 'start_package', 'prospect')
      or (entity_type = 'prospect' and division_id is null)
      or org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
      or division_id in (select public.member_reachable_division_ids())
    )
  );

-- ---------------------------------------------------------------------------
-- 5. Backfill: the stamp trigger fills both columns from the record.
-- ---------------------------------------------------------------------------

update public.search_documents
   set division_id = null
 where entity_type in ('prospect', 'start_package')
    or (
      project_id is null
      and entity_type in (
        'project', 'budget', 'budget_transfer', 'certified_payroll_report', 'change_event', 'change_order',
        'closing', 'commitment', 'commitment_change_order', 'contract', 'daily_log', 'design_studio_appointment',
        'drawing_set', 'drawing_sheet', 'estimate', 'expense', 'file', 'inspection', 'invoice', 'meeting',
        'meeting_transcript', 'observation', 'pay_application', 'payable', 'photo', 'portal_access',
        'project_email', 'project_location', 'proposal', 'punch_item', 'rfi', 'safety_incident',
        'schedule_item', 'spec_section', 'submittal', 'takeoff_condition', 'task', 'transmittal',
        'warranty_backcharge', 'warranty_request'
      )
    );
