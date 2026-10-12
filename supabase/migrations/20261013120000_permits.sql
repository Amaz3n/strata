-- Permits: the building authority's application on the home, its corrections,
-- its fees, and the start gate that reads them (EP06-06, EP06-07, EP06-08).
--
-- The home is the unit. An application belongs to a project (the house on its
-- lot) and to a jurisdiction, which is a directory company with the generic
-- vendor role: the authority is the party the fees are paid to, so fees are
-- bills and expenses on the home's job cost, linked here and never a parallel
-- ledger. Stage is derived (lib/permits/lifecycle.ts); the tables store facts:
-- submissions, correction rounds and their history, required documents, the
-- decision and its evidence, fees and the payables that pay them.
--
-- 1. Jurisdiction profile and document checklist; a community's default authority.
-- 2. Applications, documents, submissions, correction rounds (+ history), fees,
--    fee payments, and the positions view the coordinator queue reads.
-- 3. Row security: read with permit.read inside the division wall; no member
--    writes at all. Every write is a definer function that takes the actor from
--    the session, re-checks permit.write and the home's reach, locks the
--    application and records its audit, event and reindex in one transaction.
-- 4. Functions.
-- 5. Guards on what the guarantees depend on: evidence files, fee payables.
-- 6. The start gate: the permit gate is automatic, computed in SQL from the
--    approved application for the lot's pinned plan, and never waived; the
--    plot-plan gate reads the application's plot plan. Gate definitions are
--    writable only with start.release, and the two system gates never change.
-- 7. RBAC: permit.read, permit.write.

-- ---------------------------------------------------------------------------
-- 1. Jurisdictions.
-- ---------------------------------------------------------------------------

alter table public.communities
  add column if not exists permit_jurisdiction_company_id uuid references public.companies(id) on delete set null;

create index if not exists communities_permit_jurisdiction_idx
  on public.communities (permit_jurisdiction_company_id) where permit_jurisdiction_company_id is not null;

create table public.permit_jurisdiction_profiles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  review_days integer not null default 30 check (review_days between 1 and 365),
  portal_url text check (portal_url is null or length(portal_url) <= 500),
  notes text check (notes is null or length(notes) <= 2000),
  created_by uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, company_id)
);

create index permit_jurisdiction_profiles_company_idx on public.permit_jurisdiction_profiles (company_id);

create table public.permit_jurisdiction_requirements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  permit_type text not null check (permit_type in ('building', 'electrical', 'plumbing', 'mechanical', 'roofing', 'pool', 'right_of_way', 'other')),
  document_kind text not null check (document_kind ~ '^[a-z][a-z0-9_]{1,40}$'),
  label text not null check (length(btrim(label)) between 1 and 160),
  required_for text not null check (required_for in ('submission', 'decision')),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, company_id, permit_type, document_kind)
);

create index permit_jurisdiction_requirements_company_idx on public.permit_jurisdiction_requirements (company_id);

-- ---------------------------------------------------------------------------
-- 2. Applications and their facts.
-- ---------------------------------------------------------------------------

create table public.permit_applications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  lot_id uuid references public.lots(id) on delete set null,
  jurisdiction_company_id uuid not null references public.companies(id),
  permit_type text not null check (permit_type in ('building', 'electrical', 'plumbing', 'mechanical', 'roofing', 'pool', 'right_of_way', 'other')),
  owner_user_id uuid references public.app_users(id),
  -- The plan the authority reviewed: the lot's pin as of the latest submission.
  house_plan_version_id uuid references public.house_plan_versions(id),
  house_plan_elevation_id uuid references public.house_plan_elevations(id),
  permit_number text check (permit_number is null or length(btrim(permit_number)) between 1 and 80),
  decision text check (decision in ('approved', 'denied', 'withdrawn', 'not_required')),
  decided_on date,
  decided_by uuid references public.app_users(id),
  decided_at timestamptz,
  issued_on date,
  expires_on date,
  -- Approved: the issued permit. Not required: the authority's letter saying so.
  issued_permit_file_id uuid references public.files(id),
  approved_plans_file_id uuid references public.files(id),
  decision_note text check (decision_note is null or length(decision_note) <= 2000),
  -- A plan change after a decision opens a revision; the decided record stays.
  supersedes_id uuid references public.permit_applications(id),
  superseded_at timestamptz,
  -- Reminder markers written by the sweep (decision overdue, per submission).
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint permit_application_decision_facts check (
    (decision is null and decided_on is null and decided_by is null and decided_at is null)
    or (decision is not null and decided_on is not null and decided_by is not null and decided_at is not null)
  ),
  constraint permit_application_approval_evidence check (
    decision is distinct from 'approved'
    or (permit_number is not null and issued_permit_file_id is not null and approved_plans_file_id is not null)
  ),
  constraint permit_application_not_required_evidence check (
    decision is distinct from 'not_required' or issued_permit_file_id is not null
  )
);

-- One live building application per home: a denied or withdrawn one is history,
-- and a revision supersedes the one before it.
create unique index permit_applications_one_live_building
  on public.permit_applications (project_id)
  where permit_type = 'building' and superseded_at is null and (decision is null or decision in ('approved', 'not_required'));
create index permit_applications_org_project_idx on public.permit_applications (org_id, project_id);
create index permit_applications_org_jurisdiction_idx on public.permit_applications (org_id, jurisdiction_company_id);
create index permit_applications_lot_idx on public.permit_applications (lot_id) where lot_id is not null;
create index permit_applications_open_idx on public.permit_applications (org_id, owner_user_id) where decision is null and superseded_at is null;
create index permit_applications_owner_idx on public.permit_applications (owner_user_id);
create index permit_applications_issued_file_idx on public.permit_applications (issued_permit_file_id) where issued_permit_file_id is not null;
create index permit_applications_plans_file_idx on public.permit_applications (approved_plans_file_id) where approved_plans_file_id is not null;
create index permit_applications_supersedes_idx on public.permit_applications (supersedes_id) where supersedes_id is not null;
create index permit_applications_version_idx on public.permit_applications (house_plan_version_id) where house_plan_version_id is not null;
create index permit_applications_elevation_idx on public.permit_applications (house_plan_elevation_id) where house_plan_elevation_id is not null;
create index permit_applications_decided_by_idx on public.permit_applications (decided_by) where decided_by is not null;
create index permit_applications_created_by_idx on public.permit_applications (created_by) where created_by is not null;

-- The checklist: snapshotted from the authority's requirements when the
-- application opens (a building application always needs its plot plan), plus
-- anything the authority asked for since.
create table public.permit_application_documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  application_id uuid not null references public.permit_applications(id) on delete cascade,
  document_kind text not null check (document_kind ~ '^[a-z][a-z0-9_]{1,40}$'),
  label text not null check (length(btrim(label)) between 1 and 160),
  required_for text not null check (required_for in ('submission', 'decision')),
  source text not null default 'added' check (source in ('default', 'jurisdiction', 'added')),
  file_id uuid references public.files(id),
  attached_at timestamptz,
  attached_by uuid references public.app_users(id),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (application_id, document_kind),
  constraint permit_document_attachment check ((file_id is null) = (attached_at is null))
);

create index permit_application_documents_org_project_idx on public.permit_application_documents (org_id, project_id);
create index permit_application_documents_file_idx on public.permit_application_documents (file_id) where file_id is not null;
create index permit_application_documents_attached_by_idx on public.permit_application_documents (attached_by) where attached_by is not null;

create table public.permit_submissions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  application_id uuid not null references public.permit_applications(id) on delete cascade,
  submission_no integer not null check (submission_no > 0),
  kind text not null check (kind in ('initial', 'resubmission', 'revision')),
  submitted_on date not null,
  submitted_by uuid not null references public.app_users(id),
  reference text check (reference is null or length(reference) <= 120),
  expected_decision_on date not null,
  house_plan_version_id uuid references public.house_plan_versions(id),
  house_plan_elevation_id uuid references public.house_plan_elevations(id),
  note text check (note is null or length(note) <= 2000),
  created_at timestamptz not null default now(),
  unique (application_id, submission_no)
);

create index permit_submissions_org_project_idx on public.permit_submissions (org_id, project_id);
create index permit_submissions_submitted_by_idx on public.permit_submissions (submitted_by);
create index permit_submissions_version_idx on public.permit_submissions (house_plan_version_id) where house_plan_version_id is not null;
create index permit_submissions_elevation_idx on public.permit_submissions (house_plan_elevation_id) where house_plan_elevation_id is not null;

create table public.permit_correction_rounds (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  application_id uuid not null references public.permit_applications(id) on delete cascade,
  round_no integer not null check (round_no > 0),
  received_on date not null,
  raised_on_submission_id uuid not null references public.permit_submissions(id),
  comments text not null check (length(btrim(comments)) between 1 and 5000),
  comment_file_id uuid references public.files(id),
  owner_user_id uuid references public.app_users(id),
  due_on date,
  status text not null default 'open' check (status in ('open', 'responded', 'resolved', 'withdrawn')),
  responded_submission_id uuid references public.permit_submissions(id),
  responded_on date,
  resolved_on date,
  resolved_by uuid references public.app_users(id),
  -- Reminder threshold markers written by the sweep.
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (application_id, round_no),
  constraint permit_round_response check ((status = 'open') or status = 'withdrawn' or responded_submission_id is not null)
);

create index permit_correction_rounds_org_project_idx on public.permit_correction_rounds (org_id, project_id);
create index permit_correction_rounds_open_due_idx on public.permit_correction_rounds (org_id, due_on) where status = 'open';
create index permit_correction_rounds_open_owner_idx on public.permit_correction_rounds (org_id, owner_user_id) where status in ('open', 'responded');
create index permit_correction_rounds_owner_idx on public.permit_correction_rounds (owner_user_id) where owner_user_id is not null;
create index permit_correction_rounds_submission_idx on public.permit_correction_rounds (raised_on_submission_id);
create index permit_correction_rounds_responded_idx on public.permit_correction_rounds (responded_submission_id) where responded_submission_id is not null;
create index permit_correction_rounds_file_idx on public.permit_correction_rounds (comment_file_id) where comment_file_id is not null;
create index permit_correction_rounds_resolved_by_idx on public.permit_correction_rounds (resolved_by) where resolved_by is not null;
create index permit_correction_rounds_created_by_idx on public.permit_correction_rounds (created_by) where created_by is not null;

-- Who owned a round, when it was due and where it stood, every time any of
-- those moved, and who moved it. Written by trigger; never edited.
create table public.permit_correction_round_history (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  application_id uuid not null references public.permit_applications(id) on delete cascade,
  round_id uuid not null references public.permit_correction_rounds(id) on delete cascade,
  actor_id uuid references public.app_users(id),
  from_status text,
  to_status text not null,
  from_owner_user_id uuid references public.app_users(id),
  to_owner_user_id uuid references public.app_users(id),
  from_due_on date,
  to_due_on date,
  note text,
  created_at timestamptz not null default clock_timestamp()
);

create index permit_correction_round_history_org_project_idx on public.permit_correction_round_history (org_id, project_id);
create index permit_correction_round_history_round_idx on public.permit_correction_round_history (round_id, created_at);
create index permit_correction_round_history_application_idx on public.permit_correction_round_history (application_id);
create index permit_correction_round_history_actor_idx on public.permit_correction_round_history (actor_id) where actor_id is not null;
create index permit_correction_round_history_from_owner_idx on public.permit_correction_round_history (from_owner_user_id) where from_owner_user_id is not null;
create index permit_correction_round_history_to_owner_idx on public.permit_correction_round_history (to_owner_user_id) where to_owner_user_id is not null;

-- A fee's amount is never edited: it is voided with a reason and assessed again,
-- so the history is the rows.
create table public.permit_fees (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  application_id uuid not null references public.permit_applications(id) on delete cascade,
  kind text not null check (kind in ('plan_review', 'permit', 'impact', 'other')),
  description text check (description is null or length(description) <= 300),
  amount_cents bigint not null check (amount_cents > 0),
  assessed_on date not null,
  due_before text check (due_before in ('submission', 'issuance', 'certificate_of_occupancy')),
  cost_code_id uuid references public.cost_codes(id),
  status text not null default 'open' check (status in ('open', 'void')),
  void_reason text,
  voided_by uuid references public.app_users(id),
  voided_at timestamptz,
  replaces_fee_id uuid references public.permit_fees(id),
  created_by uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint permit_fee_void_facts check (
    (status = 'open' and voided_at is null and void_reason is null)
    or (status = 'void' and voided_at is not null and length(btrim(void_reason)) >= 10)
  )
);

create index permit_fees_org_project_idx on public.permit_fees (org_id, project_id);
create index permit_fees_application_idx on public.permit_fees (application_id);
create index permit_fees_cost_code_idx on public.permit_fees (cost_code_id) where cost_code_id is not null;
create index permit_fees_replaces_idx on public.permit_fees (replaces_fee_id) where replaces_fee_id is not null;
create index permit_fees_voided_by_idx on public.permit_fees (voided_by) where voided_by is not null;
create index permit_fees_created_by_idx on public.permit_fees (created_by) where created_by is not null;

-- Which payable pays which fee. One fee per payable; a fee may be paid by
-- several (a counter payment and a later bill, or a bill paid in parts).
create table public.permit_fee_payments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  fee_id uuid not null references public.permit_fees(id) on delete restrict,
  vendor_bill_id uuid references public.vendor_bills(id) on delete restrict,
  project_expense_id uuid references public.project_expenses(id) on delete restrict,
  linked_by uuid references public.app_users(id),
  linked_at timestamptz not null default now(),
  constraint permit_fee_payment_one_source check (num_nonnulls(vendor_bill_id, project_expense_id) = 1)
);

create unique index permit_fee_payments_bill_key on public.permit_fee_payments (vendor_bill_id) where vendor_bill_id is not null;
create unique index permit_fee_payments_expense_key on public.permit_fee_payments (project_expense_id) where project_expense_id is not null;
create index permit_fee_payments_org_project_idx on public.permit_fee_payments (org_id, project_id);
create index permit_fee_payments_fee_idx on public.permit_fee_payments (fee_id);
create index permit_fee_payments_linked_by_idx on public.permit_fee_payments (linked_by) where linked_by is not null;

do $$
declare v_table text;
begin
  foreach v_table in array array['permit_jurisdiction_profiles', 'permit_jurisdiction_requirements', 'permit_applications',
    'permit_application_documents', 'permit_correction_rounds', 'permit_fees'] loop
    execute format('drop trigger if exists %I on public.%I', v_table || '_set_updated_at', v_table);
    execute format('create trigger %I before update on public.%I for each row execute function public.tg_set_updated_at()',
      v_table || '_set_updated_at', v_table);
  end loop;
end $$;

-- The coordinator queue's facts, one row per application. Paging, filtering and
-- counting happen here; the aging judgment is lib/permits/lifecycle.ts.
create view public.permit_application_positions with (security_invoker = on) as
select
  a.id, a.org_id, a.project_id, a.lot_id, a.jurisdiction_company_id, a.permit_type, a.owner_user_id,
  a.permit_number, a.decision, a.decided_on, a.expires_on, a.superseded_at, a.created_at,
  l.community_id, c.division_id, l.lot_number, l.block, c.name as community_name,
  s.submission_count, s.last_submitted_on, s.expected_decision_on,
  r.open_rounds, r.unresolved_rounds, r.next_round_due_on,
  d.missing_submission_documents, d.missing_decision_documents,
  (select sp.target_week from public.start_packages sp
    where sp.org_id = a.org_id and sp.lot_id = a.lot_id and sp.status in ('open', 'ready')
    order by sp.created_at desc limit 1) as start_target_week
from public.permit_applications a
left join public.lots l on l.org_id = a.org_id and l.id = a.lot_id
left join public.communities c on c.org_id = a.org_id and c.id = l.community_id
left join lateral (
  select count(*)::integer as submission_count, max(s.submitted_on) as last_submitted_on,
    (array_agg(s.expected_decision_on order by s.submission_no desc))[1] as expected_decision_on
  from public.permit_submissions s where s.application_id = a.id
) s on true
left join lateral (
  select count(*) filter (where r.status = 'open')::integer as open_rounds,
    count(*) filter (where r.status in ('open', 'responded'))::integer as unresolved_rounds,
    min(r.due_on) filter (where r.status = 'open') as next_round_due_on
  from public.permit_correction_rounds r where r.application_id = a.id
) r on true
left join lateral (
  select count(*) filter (where d.file_id is null and d.required_for = 'submission')::integer as missing_submission_documents,
    count(*) filter (where d.file_id is null and d.required_for = 'decision')::integer as missing_decision_documents
  from public.permit_application_documents d where d.application_id = a.id
) d on true;

-- ---------------------------------------------------------------------------
-- 3. Row security. Read with permit.read inside the division wall; writes only
-- through the functions below.
-- ---------------------------------------------------------------------------

do $$
declare v_table text;
begin
  foreach v_table in array array['permit_applications', 'permit_application_documents', 'permit_submissions',
    'permit_correction_rounds', 'permit_correction_round_history', 'permit_fees', 'permit_fee_payments'] loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('drop policy if exists %I on public.%I', v_table || '_read', v_table);
    execute format($p$create policy %I on public.%I for select to authenticated using (
      public.has_org_permission(org_id, 'permit.read')
      and (org_id = any ((select public.member_unscoped_org_ids())::uuid[])
        or project_id in (select public.member_reachable_project_ids()))
    )$p$, v_table || '_read', v_table);
    execute format('revoke all on table public.%I from anon, authenticated', v_table);
    execute format('grant select on table public.%I to authenticated', v_table);
    execute format('grant all on table public.%I to service_role', v_table);
  end loop;
  foreach v_table in array array['permit_jurisdiction_profiles', 'permit_jurisdiction_requirements'] loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('drop policy if exists %I on public.%I', v_table || '_read', v_table);
    execute format($p$create policy %I on public.%I for select to authenticated
      using (public.has_org_permission(org_id, 'permit.read'))$p$, v_table || '_read', v_table);
    execute format('revoke all on table public.%I from anon, authenticated', v_table);
    execute format('grant select on table public.%I to authenticated', v_table);
    execute format('grant all on table public.%I to service_role', v_table);
  end loop;
end $$;

revoke all on public.permit_application_positions from anon, authenticated;
grant select on public.permit_application_positions to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Functions.
-- ---------------------------------------------------------------------------

-- The signed-in member acting, with one of the permissions and the home in reach.
create or replace function public.permit_actor(p_org_id uuid, p_project_id uuid, p_permissions text[])
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_permission text;
  v_allowed boolean := false;
begin
  if v_actor is null then
    raise exception 'Sign in to work on permits' using errcode = '42501';
  end if;
  foreach v_permission in array p_permissions loop
    if public.has_org_permission(p_org_id, v_permission) then
      v_allowed := true;
      exit;
    end if;
  end loop;
  if not v_allowed then
    raise exception 'This needs the % permission', array_to_string(p_permissions, ' or ') using errcode = '42501';
  end if;
  if p_project_id is not null
     and not (p_org_id = any (public.member_unscoped_org_ids()) or p_project_id in (select public.member_reachable_project_ids())) then
    raise exception 'This home is outside your access' using errcode = '42501';
  end if;
  return v_actor;
end;
$$;

revoke all on function public.permit_actor(uuid, uuid, text[]) from public, anon, authenticated;

create or replace function public.permit_record_change(
  p_org_id uuid, p_actor uuid, p_entity_type text, p_entity_id uuid, p_action text,
  p_source text, p_event text, p_before jsonb, p_after jsonb, p_payload jsonb, p_application_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.audit_log (org_id, actor_user_id, action, entity_type, entity_id, before_data, after_data, source)
  values (p_org_id, p_actor, p_action::public.audit_action, p_entity_type, p_entity_id, p_before, p_after, p_source);
  insert into public.events (org_id, event_type, entity_type, entity_id, payload, channel)
  values (p_org_id, p_event, p_entity_type, p_entity_id, coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('actor_id', p_actor), 'activity');
  insert into public.outbox (org_id, job_type, payload)
  values (p_org_id, 'reindex_search', jsonb_build_object('entity_type', 'permit_application', 'entity_id', p_application_id));
end;
$$;

revoke all on function public.permit_record_change(uuid, uuid, text, uuid, text, text, text, jsonb, jsonb, jsonb, uuid) from public, anon, authenticated;

create or replace function public.permit_assert_member(p_org_id uuid, p_user_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_user_id is not null and not exists (
    select 1 from public.memberships m where m.org_id = p_org_id and m.user_id = p_user_id and m.status = 'active'
  ) then
    raise exception 'The owner must be an active member of the organization' using errcode = '23503';
  end if;
end;
$$;

revoke all on function public.permit_assert_member(uuid, uuid) from public, anon, authenticated;

-- A file the record stands on: on this home, and not archived.
create or replace function public.permit_assert_home_file(p_org_id uuid, p_project_id uuid, p_file_id uuid, p_what text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_file_id is null then
    raise exception '% is required', p_what using errcode = '23514';
  end if;
  if not exists (
    select 1 from public.files f
    where f.org_id = p_org_id and f.id = p_file_id and f.project_id = p_project_id and f.archived_at is null
  ) then
    raise exception '% must be a file on this home', p_what using errcode = '23514';
  end if;
end;
$$;

revoke all on function public.permit_assert_home_file(uuid, uuid, uuid, text) from public, anon, authenticated;

create or replace function public.permit_lock_application(p_org_id uuid, p_application_id uuid)
returns public.permit_applications
language plpgsql
security definer
set search_path = ''
as $$
declare v_app public.permit_applications%rowtype;
begin
  select * into v_app from public.permit_applications where org_id = p_org_id and id = p_application_id for update;
  if v_app.id is null then
    raise exception 'Permit application not found' using errcode = '42501';
  end if;
  return v_app;
end;
$$;

revoke all on function public.permit_lock_application(uuid, uuid) from public, anon, authenticated;

create or replace function public.permit_assert_open(p_app public.permit_applications)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_app.superseded_at is not null then
    raise exception 'This application was superseded by a revision' using errcode = '42501';
  end if;
  if p_app.decision is not null then
    raise exception 'The authority has decided this application; open a revision to change it' using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.permit_assert_open(public.permit_applications) from public, anon, authenticated;

-- What a fee has been paid: a linked bill's payments (none once rejected) and a
-- linked expense once approved. Mirrors feePosition() in lib/permits/fees.ts.
create or replace function public.permit_fee_paid_cents(p_fee_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(
    case
      when p.vendor_bill_id is not null then case when b.status = 'rejected' then 0 else coalesce(b.paid_cents, 0) end
      when e.status in ('approved', 'locked') then e.amount_cents + e.tax_cents
      else 0
    end), 0)::bigint
  from public.permit_fee_payments p
  left join public.vendor_bills b on b.id = p.vendor_bill_id
  left join public.project_expenses e on e.id = p.project_expense_id
  where p.fee_id = p_fee_id
$$;

revoke all on function public.permit_fee_paid_cents(uuid) from public, anon, authenticated;

-- What payables already stand against a fee, rejected ones excluded.
create or replace function public.permit_fee_linked_cents(p_fee_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(
    case
      when p.vendor_bill_id is not null then case when b.status = 'rejected' then 0 else coalesce(b.total_cents, 0) end
      when e.status = 'rejected' then 0
      else e.amount_cents + e.tax_cents
    end), 0)::bigint
  from public.permit_fee_payments p
  left join public.vendor_bills b on b.id = p.vendor_bill_id
  left join public.project_expenses e on e.id = p.project_expense_id
  where p.fee_id = p_fee_id
$$;

revoke all on function public.permit_fee_linked_cents(uuid) from public, anon, authenticated;

-- The authority's profile and checklist, replaced as a set.
create or replace function public.set_permit_jurisdiction_profile(
  p_org_id uuid, p_company_id uuid, p_review_days integer, p_portal_url text, p_requirements jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.permit_actor(p_org_id, null, array['permit.write']);
  v_profile_id uuid;
  v_before jsonb;
  v_row jsonb;
  v_index integer := 0;
begin
  if jsonb_typeof(p_requirements) is distinct from 'array' then
    raise exception 'Requirements must be a list' using errcode = '22023';
  end if;
  if not exists (select 1 from public.companies where org_id = p_org_id and id = p_company_id and archived_at is null) then
    raise exception 'Jurisdiction not found' using errcode = '23503';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('permit_jurisdiction:' || p_company_id::text, 0));
  select jsonb_build_object('profile', to_jsonb(p), 'requirements', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.permit_type, r.sort_order)
      from public.permit_jurisdiction_requirements r where r.org_id = p_org_id and r.company_id = p_company_id), '[]'::jsonb))
    into v_before
  from public.permit_jurisdiction_profiles p where p.org_id = p_org_id and p.company_id = p_company_id;

  insert into public.permit_jurisdiction_profiles (org_id, company_id, review_days, portal_url, created_by)
  values (p_org_id, p_company_id, p_review_days, nullif(btrim(p_portal_url), ''), v_actor)
  on conflict (org_id, company_id) do update set review_days = excluded.review_days, portal_url = excluded.portal_url
  returning id into v_profile_id;

  delete from public.permit_jurisdiction_requirements where org_id = p_org_id and company_id = p_company_id;
  for v_row in select value from jsonb_array_elements(p_requirements) loop
    v_index := v_index + 1;
    insert into public.permit_jurisdiction_requirements (org_id, company_id, permit_type, document_kind, label, required_for, sort_order)
    values (p_org_id, p_company_id, v_row->>'permit_type', v_row->>'document_kind', btrim(v_row->>'label'), v_row->>'required_for', v_index * 10);
  end loop;

  insert into public.audit_log (org_id, actor_user_id, action, entity_type, entity_id, before_data, after_data, source)
  values (p_org_id, v_actor, (case when v_before is null then 'insert' else 'update' end)::public.audit_action, 'permit_jurisdiction', p_company_id, v_before,
    jsonb_build_object('review_days', p_review_days, 'portal_url', p_portal_url, 'requirements', p_requirements), 'permits.jurisdiction_set');
  insert into public.events (org_id, event_type, entity_type, entity_id, payload, channel)
  values (p_org_id, 'permit_jurisdiction.updated', 'company', p_company_id,
    jsonb_build_object('review_days', p_review_days, 'requirement_count', jsonb_array_length(p_requirements), 'actor_id', v_actor), 'activity');
  return v_profile_id;
end;
$$;

revoke all on function public.set_permit_jurisdiction_profile(uuid, uuid, integer, text, jsonb) from public, anon;
grant execute on function public.set_permit_jurisdiction_profile(uuid, uuid, integer, text, jsonb) to authenticated, service_role;

-- Open an application on a home, or a revision of one (p_supersedes_id).
create or replace function public.create_permit_application(
  p_org_id uuid, p_project_id uuid, p_jurisdiction_company_id uuid, p_permit_type text,
  p_owner_user_id uuid, p_supersedes_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.permit_actor(p_org_id, p_project_id, array['permit.write']);
  v_lot_id uuid;
  v_previous public.permit_applications%rowtype;
  v_app public.permit_applications%rowtype;
begin
  if not exists (select 1 from public.projects where org_id = p_org_id and id = p_project_id) then
    raise exception 'Home not found' using errcode = '23503';
  end if;
  if not exists (select 1 from public.companies where org_id = p_org_id and id = p_jurisdiction_company_id and archived_at is null) then
    raise exception 'Jurisdiction not found' using errcode = '23503';
  end if;
  perform public.permit_assert_member(p_org_id, p_owner_user_id);
  perform pg_advisory_xact_lock(hashtextextended('permit_home:' || p_project_id::text, 0));
  select id into v_lot_id from public.lots where org_id = p_org_id and project_id = p_project_id order by created_at limit 1;

  if p_supersedes_id is not null then
    v_previous := public.permit_lock_application(p_org_id, p_supersedes_id);
    if v_previous.project_id <> p_project_id or v_previous.permit_type <> p_permit_type then
      raise exception 'A revision replaces an application of the same type on the same home' using errcode = '23514';
    end if;
    if v_previous.superseded_at is not null then
      raise exception 'That application was already revised' using errcode = '23514';
    end if;
    update public.permit_applications set superseded_at = clock_timestamp() where id = v_previous.id;
  end if;

  insert into public.permit_applications (org_id, project_id, lot_id, jurisdiction_company_id, permit_type, owner_user_id, supersedes_id, created_by)
  values (p_org_id, p_project_id, v_lot_id, p_jurisdiction_company_id, p_permit_type, coalesce(p_owner_user_id, v_actor), p_supersedes_id, v_actor)
  returning * into v_app;

  if p_permit_type = 'building' then
    insert into public.permit_application_documents (org_id, project_id, application_id, document_kind, label, required_for, source, sort_order)
    values (p_org_id, p_project_id, v_app.id, 'plot_plan', 'Plot / site plan', 'submission', 'default', 0);
  end if;
  insert into public.permit_application_documents (org_id, project_id, application_id, document_kind, label, required_for, source, sort_order)
  select p_org_id, p_project_id, v_app.id, r.document_kind, r.label, r.required_for, 'jurisdiction', r.sort_order
  from public.permit_jurisdiction_requirements r
  where r.org_id = p_org_id and r.company_id = p_jurisdiction_company_id and r.permit_type = p_permit_type
  on conflict (application_id, document_kind) do nothing;

  perform public.permit_record_change(p_org_id, v_actor, 'permit_application', v_app.id, 'insert', 'permits.application_created',
    case when p_supersedes_id is null then 'permit_application.created' else 'permit_application.revised' end,
    null, to_jsonb(v_app),
    jsonb_build_object('project_id', p_project_id, 'permit_type', p_permit_type, 'supersedes_id', p_supersedes_id), v_app.id);
  return v_app.id;
end;
$$;

revoke all on function public.create_permit_application(uuid, uuid, uuid, text, uuid, uuid) from public, anon;
grant execute on function public.create_permit_application(uuid, uuid, uuid, text, uuid, uuid) to authenticated, service_role;

create or replace function public.assign_permit_application(p_org_id uuid, p_application_id uuid, p_owner_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_app public.permit_applications%rowtype := public.permit_lock_application(p_org_id, p_application_id);
  v_actor uuid := public.permit_actor(p_org_id, v_app.project_id, array['permit.write']);
begin
  perform public.permit_assert_member(p_org_id, p_owner_user_id);
  update public.permit_applications set owner_user_id = p_owner_user_id where id = v_app.id;
  perform public.permit_record_change(p_org_id, v_actor, 'permit_application', v_app.id, 'update', 'permits.application_assigned',
    'permit_application.assigned', jsonb_build_object('owner_user_id', v_app.owner_user_id), jsonb_build_object('owner_user_id', p_owner_user_id),
    jsonb_build_object('project_id', v_app.project_id, 'owner_user_id', p_owner_user_id), v_app.id);
end;
$$;

revoke all on function public.assign_permit_application(uuid, uuid, uuid) from public, anon;
grant execute on function public.assign_permit_application(uuid, uuid, uuid) to authenticated, service_role;

-- Attach (or clear) the file for a checklist document, or add one the authority
-- asked for (a new kind needs a label).
create or replace function public.set_permit_document(
  p_org_id uuid, p_application_id uuid, p_document_kind text, p_label text, p_required_for text, p_file_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_app public.permit_applications%rowtype := public.permit_lock_application(p_org_id, p_application_id);
  v_actor uuid := public.permit_actor(p_org_id, v_app.project_id, array['permit.write']);
  v_before public.permit_application_documents%rowtype;
  v_after public.permit_application_documents%rowtype;
begin
  perform public.permit_assert_open(v_app);
  if p_file_id is not null then
    perform public.permit_assert_home_file(p_org_id, v_app.project_id, p_file_id, 'The document');
  end if;
  select * into v_before from public.permit_application_documents where application_id = v_app.id and document_kind = p_document_kind for update;
  if v_before.id is null then
    if nullif(btrim(p_label), '') is null or p_required_for is null then
      raise exception 'A new required document needs a label and when it is due' using errcode = '23514';
    end if;
    insert into public.permit_application_documents (org_id, project_id, application_id, document_kind, label, required_for, source,
      file_id, attached_at, attached_by, sort_order)
    values (p_org_id, v_app.project_id, v_app.id, p_document_kind, btrim(p_label), p_required_for, 'added',
      p_file_id, case when p_file_id is not null then clock_timestamp() end, case when p_file_id is not null then v_actor end,
      (select coalesce(max(sort_order), 0) + 10 from public.permit_application_documents where application_id = v_app.id))
    returning * into v_after;
  else
    update public.permit_application_documents
    set file_id = p_file_id,
        attached_at = case when p_file_id is not null then clock_timestamp() end,
        attached_by = case when p_file_id is not null then v_actor end
    where id = v_before.id
    returning * into v_after;
  end if;
  perform public.permit_record_change(p_org_id, v_actor, 'permit_application', v_app.id, 'update', 'permits.document_set',
    case when p_file_id is null then 'permit_application.document_cleared' else 'permit_application.document_attached' end,
    case when v_before.id is null then null else to_jsonb(v_before) end, to_jsonb(v_after),
    jsonb_build_object('project_id', v_app.project_id, 'document_kind', p_document_kind, 'file_id', p_file_id), v_app.id);
  return v_after.id;
end;
$$;

revoke all on function public.set_permit_document(uuid, uuid, text, text, text, uuid) from public, anon;
grant execute on function public.set_permit_document(uuid, uuid, text, text, text, uuid) to authenticated, service_role;

-- A submission to the authority. Refused while a document required for
-- submission has no file. A response to a correction round marks it responded.
create or replace function public.record_permit_submission(
  p_org_id uuid, p_application_id uuid, p_submitted_on date, p_reference text, p_note text, p_responds_to_round_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_app public.permit_applications%rowtype := public.permit_lock_application(p_org_id, p_application_id);
  v_actor uuid := public.permit_actor(p_org_id, v_app.project_id, array['permit.write']);
  v_missing text;
  v_count integer;
  v_round public.permit_correction_rounds%rowtype;
  v_review_days integer;
  v_version_id uuid;
  v_elevation_id uuid;
  v_submission public.permit_submissions%rowtype;
begin
  perform public.permit_assert_open(v_app);
  if p_submitted_on is null or p_submitted_on > current_date then
    raise exception 'A submission date cannot be in the future' using errcode = '23514';
  end if;
  select string_agg(label, ', ' order by sort_order) into v_missing
  from public.permit_application_documents
  where application_id = v_app.id and required_for = 'submission' and file_id is null;
  if v_missing is not null then
    raise exception 'Attach the documents the authority needs before submitting: %', v_missing using errcode = '23514';
  end if;
  select count(*) into v_count from public.permit_submissions where application_id = v_app.id;
  if p_responds_to_round_id is not null then
    select * into v_round from public.permit_correction_rounds
    where application_id = v_app.id and id = p_responds_to_round_id for update;
    if v_round.id is null then
      raise exception 'Correction round not found on this application' using errcode = '23503';
    end if;
    if v_round.status <> 'open' then
      raise exception 'Round % is not waiting on a response', v_round.round_no using errcode = '23514';
    end if;
  end if;
  select review_days into v_review_days from public.permit_jurisdiction_profiles
  where org_id = p_org_id and company_id = v_app.jurisdiction_company_id;
  select house_plan_version_id, house_plan_elevation_id into v_version_id, v_elevation_id
  from public.lots where org_id = p_org_id and id = v_app.lot_id;

  insert into public.permit_submissions (org_id, project_id, application_id, submission_no, kind, submitted_on, submitted_by, reference,
    expected_decision_on, house_plan_version_id, house_plan_elevation_id, note)
  values (p_org_id, v_app.project_id, v_app.id, v_count + 1,
    case when v_count = 0 then 'initial' when p_responds_to_round_id is not null then 'resubmission' else 'revision' end,
    p_submitted_on, v_actor, nullif(btrim(p_reference), ''), p_submitted_on + coalesce(v_review_days, 30),
    v_version_id, v_elevation_id, nullif(btrim(p_note), ''))
  returning * into v_submission;

  -- The plan the authority reviews is the one on the lot as submitted.
  update public.permit_applications
  set house_plan_version_id = v_version_id, house_plan_elevation_id = v_elevation_id
  where id = v_app.id;

  if v_round.id is not null then
    perform set_config('arc.permit_note', coalesce(nullif(btrim(p_note), ''), 'Responded with submission ' || v_submission.submission_no), true);
    update public.permit_correction_rounds
    set status = 'responded', responded_submission_id = v_submission.id, responded_on = p_submitted_on
    where id = v_round.id;
    perform set_config('arc.permit_note', '', true);
  end if;

  perform public.permit_record_change(p_org_id, v_actor, 'permit_application', v_app.id, 'update', 'permits.submitted',
    'permit_application.submitted', null, to_jsonb(v_submission),
    jsonb_build_object('project_id', v_app.project_id, 'submission_no', v_submission.submission_no, 'kind', v_submission.kind,
      'expected_decision_on', v_submission.expected_decision_on, 'responds_to_round_id', p_responds_to_round_id), v_app.id);
  return v_submission.id;
end;
$$;

revoke all on function public.record_permit_submission(uuid, uuid, date, text, text, uuid) from public, anon;
grant execute on function public.record_permit_submission(uuid, uuid, date, text, text, uuid) to authenticated, service_role;

-- The authority returned comments on the latest submission.
create or replace function public.record_permit_correction_round(
  p_org_id uuid, p_application_id uuid, p_received_on date, p_comments text, p_comment_file_id uuid,
  p_owner_user_id uuid, p_due_on date
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_app public.permit_applications%rowtype := public.permit_lock_application(p_org_id, p_application_id);
  v_actor uuid := public.permit_actor(p_org_id, v_app.project_id, array['permit.write']);
  v_submission public.permit_submissions%rowtype;
  v_round public.permit_correction_rounds%rowtype;
begin
  perform public.permit_assert_open(v_app);
  select * into v_submission from public.permit_submissions where application_id = v_app.id order by submission_no desc limit 1;
  if v_submission.id is null then
    raise exception 'Corrections answer a submission; record the submission first' using errcode = '23514';
  end if;
  if p_received_on is null or p_received_on < v_submission.submitted_on or p_received_on > current_date then
    raise exception 'Corrections are received after the submission they answer, and not in the future' using errcode = '23514';
  end if;
  if p_due_on is not null and p_due_on < p_received_on then
    raise exception 'A response cannot be due before the corrections arrived' using errcode = '23514';
  end if;
  if p_comment_file_id is not null then
    perform public.permit_assert_home_file(p_org_id, v_app.project_id, p_comment_file_id, 'The comment letter');
  end if;
  perform public.permit_assert_member(p_org_id, p_owner_user_id);
  insert into public.permit_correction_rounds (org_id, project_id, application_id, round_no, received_on, raised_on_submission_id,
    comments, comment_file_id, owner_user_id, due_on, created_by)
  values (p_org_id, v_app.project_id, v_app.id,
    (select coalesce(max(round_no), 0) + 1 from public.permit_correction_rounds where application_id = v_app.id),
    p_received_on, v_submission.id, btrim(p_comments), p_comment_file_id, coalesce(p_owner_user_id, v_app.owner_user_id, v_actor), p_due_on, v_actor)
  returning * into v_round;
  perform public.permit_record_change(p_org_id, v_actor, 'permit_correction_round', v_round.id, 'insert', 'permits.corrections_received',
    'permit_application.corrections_received', null, to_jsonb(v_round),
    jsonb_build_object('project_id', v_app.project_id, 'application_id', v_app.id, 'round_no', v_round.round_no,
      'owner_user_id', v_round.owner_user_id, 'due_on', v_round.due_on), v_app.id);
  return v_round.id;
end;
$$;

revoke all on function public.record_permit_correction_round(uuid, uuid, date, text, uuid, uuid, date) from public, anon;
grant execute on function public.record_permit_correction_round(uuid, uuid, date, text, uuid, uuid, date) to authenticated, service_role;

-- Reassign, re-date, resolve, withdraw or reopen a round, with a note the
-- history keeps. Responding is a submission (record_permit_submission).
create or replace function public.update_permit_correction_round(p_org_id uuid, p_round_id uuid, p_patch jsonb, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_application_id uuid;
  v_round public.permit_correction_rounds%rowtype;
  v_app public.permit_applications%rowtype;
  v_actor uuid;
  v_after public.permit_correction_rounds%rowtype;
  v_to text;
  v_note text := nullif(btrim(p_note), '');
begin
  if jsonb_typeof(p_patch) is distinct from 'object'
     or exists (select 1 from jsonb_object_keys(p_patch) k where k not in ('owner_user_id', 'due_on', 'status')) then
    raise exception 'Invalid correction round update' using errcode = '22023';
  end if;
  select application_id into v_application_id from public.permit_correction_rounds where org_id = p_org_id and id = p_round_id;
  if v_application_id is null then
    raise exception 'Correction round not found' using errcode = '42501';
  end if;
  v_app := public.permit_lock_application(p_org_id, v_application_id);
  v_actor := public.permit_actor(p_org_id, v_app.project_id, array['permit.write']);
  perform public.permit_assert_open(v_app);
  select * into v_round from public.permit_correction_rounds where id = p_round_id for update;
  if v_round.status in ('resolved', 'withdrawn') then
    raise exception 'Round % is closed; record a new round for new comments', v_round.round_no using errcode = '23514';
  end if;
  if p_patch ? 'owner_user_id' then
    perform public.permit_assert_member(p_org_id, nullif(p_patch->>'owner_user_id', '')::uuid);
  end if;
  if p_patch ? 'due_on' and nullif(p_patch->>'due_on', '')::date < v_round.received_on then
    raise exception 'A response cannot be due before the corrections arrived' using errcode = '23514';
  end if;
  v_to := coalesce(p_patch->>'status', v_round.status);
  if v_to <> v_round.status then
    if not ((v_round.status = 'responded' and v_to in ('resolved', 'open'))
            or (v_round.status = 'open' and v_to = 'withdrawn')) then
      raise exception 'A round moves open → responded (by a submission) → resolved; the authority can send a response back, and an open round can be withdrawn' using errcode = '23514';
    end if;
    if v_to in ('withdrawn', 'open') and coalesce(length(v_note), 0) < 5 then
      raise exception 'Say why in the note' using errcode = '23514';
    end if;
  end if;
  perform set_config('arc.permit_note', coalesce(v_note, ''), true);
  update public.permit_correction_rounds
  set owner_user_id = case when p_patch ? 'owner_user_id' then nullif(p_patch->>'owner_user_id', '')::uuid else owner_user_id end,
      due_on = case when p_patch ? 'due_on' then nullif(p_patch->>'due_on', '')::date else due_on end,
      -- A new due date earns its reminders again.
      metadata = case when p_patch ? 'due_on' and nullif(p_patch->>'due_on', '')::date is distinct from due_on
        then metadata - 'reminded_due_soon' - 'reminded_overdue' else metadata end,
      status = v_to,
      resolved_on = case when v_to = 'resolved' then current_date else null end,
      resolved_by = case when v_to = 'resolved' then v_actor else null end,
      responded_submission_id = case when v_to = 'open' then null else responded_submission_id end,
      responded_on = case when v_to = 'open' then null else responded_on end
  where id = v_round.id
  returning * into v_after;
  perform set_config('arc.permit_note', '', true);
  perform public.permit_record_change(p_org_id, v_actor, 'permit_correction_round', v_round.id, 'update', 'permits.correction_updated',
    case when v_to = 'resolved' and v_round.status <> 'resolved' then 'permit_correction.resolved' else 'permit_correction.updated' end,
    to_jsonb(v_round), to_jsonb(v_after),
    jsonb_build_object('project_id', v_app.project_id, 'application_id', v_app.id, 'round_no', v_round.round_no,
      'status', v_to, 'owner_user_id', v_after.owner_user_id, 'due_on', v_after.due_on, 'note', v_note), v_app.id);
end;
$$;

revoke all on function public.update_permit_correction_round(uuid, uuid, jsonb, text) from public, anon;
grant execute on function public.update_permit_correction_round(uuid, uuid, jsonb, text) to authenticated, service_role;

-- The authority's decision. An approval stands only on its evidence: every
-- required document attached, no round waiting on a response, the issued permit
-- and the approved plans on the home, a permit number, the plan it reviewed,
-- and every fee due before submission or issuance paid. "Not required" stands on
-- the authority's letter.
create or replace function public.record_permit_decision(
  p_org_id uuid, p_application_id uuid, p_decision text, p_decided_on date, p_permit_number text,
  p_issued_on date, p_expires_on date, p_issued_permit_file_id uuid, p_approved_plans_file_id uuid, p_note text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_app public.permit_applications%rowtype := public.permit_lock_application(p_org_id, p_application_id);
  v_actor uuid := public.permit_actor(p_org_id, v_app.project_id, array['permit.write']);
  v_after public.permit_applications%rowtype;
  v_missing text;
  v_unpaid text;
  v_open integer;
begin
  perform public.permit_assert_open(v_app);
  if p_decision not in ('approved', 'denied', 'withdrawn', 'not_required') then
    raise exception 'Invalid permit decision' using errcode = '22023';
  end if;
  if p_decided_on is null or p_decided_on > current_date then
    raise exception 'A decision date cannot be in the future' using errcode = '23514';
  end if;
  if p_decision in ('denied', 'withdrawn') and coalesce(length(btrim(p_note)), 0) < 5 then
    raise exception 'Record why the application was %', p_decision using errcode = '23514';
  end if;
  if p_decision = 'not_required' then
    perform public.permit_assert_home_file(p_org_id, v_app.project_id, p_issued_permit_file_id, 'The authority''s no-permit letter');
  end if;
  if p_decision = 'approved' then
    if not exists (select 1 from public.permit_submissions where application_id = v_app.id) then
      raise exception 'An application is approved only after it was submitted' using errcode = '23514';
    end if;
    select string_agg(label, ', ' order by sort_order) into v_missing
    from public.permit_application_documents where application_id = v_app.id and file_id is null;
    if v_missing is not null then
      raise exception 'Approval needs every required document on file: %', v_missing using errcode = '23514';
    end if;
    select count(*) into v_open from public.permit_correction_rounds where application_id = v_app.id and status = 'open';
    if v_open > 0 then
      raise exception 'A correction round is still waiting on a response' using errcode = '23514';
    end if;
    if nullif(btrim(p_permit_number), '') is null then
      raise exception 'Record the permit number' using errcode = '23514';
    end if;
    perform public.permit_assert_home_file(p_org_id, v_app.project_id, p_issued_permit_file_id, 'The issued permit');
    perform public.permit_assert_home_file(p_org_id, v_app.project_id, p_approved_plans_file_id, 'The approved plan set');
    if v_app.lot_id is not null and v_app.house_plan_version_id is null then
      raise exception 'The approval must name the plan the authority reviewed; submit with the lot''s plan pinned' using errcode = '23514';
    end if;
    if p_expires_on is not null and p_expires_on < coalesce(p_issued_on, p_decided_on) then
      raise exception 'A permit cannot expire before it is issued' using errcode = '23514';
    end if;
    select string_agg(f.kind || ' $' || to_char(f.amount_cents / 100.0, 'FM999999990.00'), ', ') into v_unpaid
    from public.permit_fees f
    where f.application_id = v_app.id and f.status = 'open' and f.due_before in ('submission', 'issuance')
      and public.permit_fee_paid_cents(f.id) < f.amount_cents;
    if v_unpaid is not null then
      raise exception 'Fees due before issuance are not paid: %', v_unpaid using errcode = '23514';
    end if;
    -- The authority approving is the authority accepting the responses it had.
    perform set_config('arc.permit_note', 'Resolved by the approval', true);
    update public.permit_correction_rounds set status = 'resolved', resolved_on = p_decided_on, resolved_by = v_actor
    where application_id = v_app.id and status = 'responded';
    perform set_config('arc.permit_note', '', true);
  end if;

  update public.permit_applications
  set decision = p_decision, decided_on = p_decided_on, decided_by = v_actor, decided_at = clock_timestamp(),
      permit_number = case when p_decision = 'approved' then btrim(p_permit_number) else nullif(btrim(p_permit_number), '') end,
      issued_on = case when p_decision = 'approved' then coalesce(p_issued_on, p_decided_on) end,
      expires_on = case when p_decision = 'approved' then p_expires_on end,
      issued_permit_file_id = case when p_decision in ('approved', 'not_required') then p_issued_permit_file_id end,
      approved_plans_file_id = case when p_decision = 'approved' then p_approved_plans_file_id end,
      decision_note = nullif(btrim(p_note), '')
  where id = v_app.id
  returning * into v_after;

  perform public.permit_record_change(p_org_id, v_actor, 'permit_application', v_app.id, 'update', 'permits.decided',
    'permit_application.decided', to_jsonb(v_app), to_jsonb(v_after),
    jsonb_build_object('project_id', v_app.project_id, 'decision', p_decision, 'permit_number', v_after.permit_number,
      'lot_id', v_app.lot_id), v_app.id);
end;
$$;

revoke all on function public.record_permit_decision(uuid, uuid, text, date, text, date, date, uuid, uuid, text) from public, anon;
grant execute on function public.record_permit_decision(uuid, uuid, text, date, text, date, date, uuid, uuid, text) to authenticated, service_role;

create or replace function public.assess_permit_fee(
  p_org_id uuid, p_application_id uuid, p_kind text, p_description text, p_amount_cents bigint,
  p_assessed_on date, p_due_before text, p_cost_code_id uuid, p_replaces_fee_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_app public.permit_applications%rowtype := public.permit_lock_application(p_org_id, p_application_id);
  v_actor uuid := public.permit_actor(p_org_id, v_app.project_id, array['permit.write']);
  v_fee public.permit_fees%rowtype;
begin
  if v_app.superseded_at is not null then
    raise exception 'This application was superseded by a revision' using errcode = '42501';
  end if;
  if p_assessed_on is null or p_assessed_on > current_date then
    raise exception 'An assessment date cannot be in the future' using errcode = '23514';
  end if;
  if p_cost_code_id is not null and not exists (select 1 from public.cost_codes where org_id = p_org_id and id = p_cost_code_id) then
    raise exception 'Cost code not found' using errcode = '23503';
  end if;
  if p_replaces_fee_id is not null and not exists (
    select 1 from public.permit_fees where application_id = v_app.id and id = p_replaces_fee_id and status = 'void'
  ) then
    raise exception 'A replacement stands for a voided fee on this application' using errcode = '23514';
  end if;
  insert into public.permit_fees (org_id, project_id, application_id, kind, description, amount_cents, assessed_on, due_before,
    cost_code_id, replaces_fee_id, created_by)
  values (p_org_id, v_app.project_id, v_app.id, p_kind, nullif(btrim(p_description), ''), p_amount_cents, p_assessed_on, p_due_before,
    p_cost_code_id, p_replaces_fee_id, v_actor)
  returning * into v_fee;
  perform public.permit_record_change(p_org_id, v_actor, 'permit_fee', v_fee.id, 'insert', 'permits.fee_assessed',
    'permit_fee.assessed', null, to_jsonb(v_fee),
    jsonb_build_object('project_id', v_app.project_id, 'application_id', v_app.id, 'kind', p_kind, 'amount_cents', p_amount_cents), v_app.id);
  return v_fee.id;
end;
$$;

revoke all on function public.assess_permit_fee(uuid, uuid, text, text, bigint, date, text, uuid, uuid) from public, anon;
grant execute on function public.assess_permit_fee(uuid, uuid, text, text, bigint, date, text, uuid, uuid) to authenticated, service_role;

create or replace function public.void_permit_fee(p_org_id uuid, p_fee_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fee public.permit_fees%rowtype;
  v_app public.permit_applications%rowtype;
  v_actor uuid;
  v_after public.permit_fees%rowtype;
begin
  select * into v_fee from public.permit_fees where org_id = p_org_id and id = p_fee_id;
  if v_fee.id is null then
    raise exception 'Permit fee not found' using errcode = '42501';
  end if;
  v_app := public.permit_lock_application(p_org_id, v_fee.application_id);
  v_actor := public.permit_actor(p_org_id, v_app.project_id, array['permit.write']);
  select * into v_fee from public.permit_fees where id = p_fee_id for update;
  if v_fee.status = 'void' then
    raise exception 'This fee is already void' using errcode = '23514';
  end if;
  if coalesce(length(btrim(p_reason)), 0) < 10 then
    raise exception 'Voiding a fee needs a reason of at least 10 characters' using errcode = '23514';
  end if;
  if public.permit_fee_linked_cents(v_fee.id) > 0 then
    raise exception 'A payable stands against this fee; reject it in payables before voiding the fee' using errcode = '23514';
  end if;
  update public.permit_fees set status = 'void', void_reason = btrim(p_reason), voided_by = v_actor, voided_at = clock_timestamp()
  where id = v_fee.id returning * into v_after;
  perform public.permit_record_change(p_org_id, v_actor, 'permit_fee', v_fee.id, 'update', 'permits.fee_voided',
    'permit_fee.voided', to_jsonb(v_fee), to_jsonb(v_after),
    jsonb_build_object('project_id', v_app.project_id, 'application_id', v_app.id, 'reason', btrim(p_reason)), v_app.id);
end;
$$;

revoke all on function public.void_permit_fee(uuid, uuid, text) from public, anon;
grant execute on function public.void_permit_fee(uuid, uuid, text) to authenticated, service_role;

-- Link a bill or an expense to the jurisdiction on this home to the fee it pays.
-- Whoever assesses permits, or whoever enters payables, links.
create or replace function public.link_permit_fee_payment(p_org_id uuid, p_fee_id uuid, p_vendor_bill_id uuid, p_project_expense_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fee public.permit_fees%rowtype;
  v_app public.permit_applications%rowtype;
  v_actor uuid;
  v_amount bigint;
  v_project uuid;
  v_company uuid;
  v_status text;
  v_payment public.permit_fee_payments%rowtype;
begin
  if num_nonnulls(p_vendor_bill_id, p_project_expense_id) <> 1 then
    raise exception 'Link one bill or one expense' using errcode = '22023';
  end if;
  select * into v_fee from public.permit_fees where org_id = p_org_id and id = p_fee_id;
  if v_fee.id is null then
    raise exception 'Permit fee not found' using errcode = '42501';
  end if;
  v_app := public.permit_lock_application(p_org_id, v_fee.application_id);
  v_actor := public.permit_actor(p_org_id, v_app.project_id, array['permit.write', 'bill.write']);
  select * into v_fee from public.permit_fees where id = p_fee_id for update;
  if v_fee.status <> 'open' then
    raise exception 'A void fee is not paid' using errcode = '23514';
  end if;
  if p_vendor_bill_id is not null then
    select b.total_cents, b.project_id, b.company_id, b.status into v_amount, v_project, v_company, v_status
    from public.vendor_bills b where b.org_id = p_org_id and b.id = p_vendor_bill_id for update;
  else
    select e.amount_cents + e.tax_cents, e.project_id, e.vendor_company_id, e.status into v_amount, v_project, v_company, v_status
    from public.project_expenses e where e.org_id = p_org_id and e.id = p_project_expense_id for update;
  end if;
  if v_project is null then
    raise exception 'Payable not found' using errcode = '23503';
  end if;
  if v_project <> v_app.project_id then
    raise exception 'The payable is on another home; a permit fee is paid on its own home''s job cost' using errcode = '23514';
  end if;
  if v_company is distinct from v_app.jurisdiction_company_id then
    raise exception 'The payable is not to this application''s jurisdiction' using errcode = '23514';
  end if;
  if v_status = 'rejected' then
    raise exception 'A rejected payable pays nothing' using errcode = '23514';
  end if;
  if public.permit_fee_linked_cents(v_fee.id) + v_amount > v_fee.amount_cents then
    raise exception 'The payable is more than what remains of the fee' using errcode = '23514';
  end if;
  insert into public.permit_fee_payments (org_id, project_id, fee_id, vendor_bill_id, project_expense_id, linked_by)
  values (p_org_id, v_app.project_id, v_fee.id, p_vendor_bill_id, p_project_expense_id, v_actor)
  returning * into v_payment;
  perform public.permit_record_change(p_org_id, v_actor, 'permit_fee', v_fee.id, 'update', 'permits.fee_payment_linked',
    'permit_fee.payment_linked', null, to_jsonb(v_payment),
    jsonb_build_object('project_id', v_app.project_id, 'application_id', v_app.id, 'vendor_bill_id', p_vendor_bill_id,
      'project_expense_id', p_project_expense_id, 'amount_cents', v_amount), v_app.id);
  return v_payment.id;
end;
$$;

revoke all on function public.link_permit_fee_payment(uuid, uuid, uuid, uuid) from public, anon;
grant execute on function public.link_permit_fee_payment(uuid, uuid, uuid, uuid) to authenticated, service_role;

-- History: who owned a round, when it was due and where it stood.
create or replace function public.tg_permit_correction_round_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare v_note text := nullif(current_setting('arc.permit_note', true), '');
begin
  if tg_op = 'INSERT' then
    insert into public.permit_correction_round_history (org_id, project_id, application_id, round_id, actor_id, to_status,
      to_owner_user_id, to_due_on, note)
    values (new.org_id, new.project_id, new.application_id, new.id, (select auth.uid()), new.status, new.owner_user_id, new.due_on,
      coalesce(v_note, 'Corrections received'));
  elsif (new.status, new.owner_user_id, new.due_on) is distinct from (old.status, old.owner_user_id, old.due_on) then
    insert into public.permit_correction_round_history (org_id, project_id, application_id, round_id, actor_id, from_status, to_status,
      from_owner_user_id, to_owner_user_id, from_due_on, to_due_on, note)
    values (new.org_id, new.project_id, new.application_id, new.id, (select auth.uid()), old.status, new.status,
      old.owner_user_id, new.owner_user_id, old.due_on, new.due_on, v_note);
  end if;
  return null;
end;
$$;

revoke all on function public.tg_permit_correction_round_history() from public, anon, authenticated;

create trigger permit_correction_rounds_history
  after insert or update on public.permit_correction_rounds
  for each row execute function public.tg_permit_correction_round_history();

-- ---------------------------------------------------------------------------
-- 5. Guards on the records the permit stands on.
-- ---------------------------------------------------------------------------

-- A file a permit record cites is evidence: it is not deleted, archived, moved
-- to another home or swapped for other bytes while cited. A checklist document
-- of an open application is detached first.
create or replace function public.guard_permit_evidence_files()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (
    exists (select 1 from public.permit_applications a where a.issued_permit_file_id = old.id or a.approved_plans_file_id = old.id)
    or exists (select 1 from public.permit_application_documents d where d.file_id = old.id)
    or exists (select 1 from public.permit_correction_rounds r where r.comment_file_id = old.id)
  ) then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    raise exception 'This file is permit evidence and cannot be deleted' using errcode = '42501';
  end if;
  if (new.org_id, new.project_id, new.storage_path) is distinct from (old.org_id, old.project_id, old.storage_path)
     or (new.archived_at is not null and old.archived_at is null) then
    raise exception 'This file is permit evidence; it stays on its home as it is' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_permit_evidence_files() from public, anon, authenticated;

create trigger files_permit_evidence_guard
  before update or delete on public.files
  for each row execute function public.guard_permit_evidence_files();

-- A payable linked to a permit fee keeps its amount, payee and home: the fee's
-- reconciliation reads them. Approval and payment move as for any payable.
create or replace function public.guard_permit_fee_payables()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare v_linked boolean;
begin
  if tg_table_name = 'vendor_bills' then
    select exists (select 1 from public.permit_fee_payments p where p.vendor_bill_id = old.id) into v_linked;
  else
    select exists (select 1 from public.permit_fee_payments p where p.project_expense_id = old.id) into v_linked;
  end if;
  if not v_linked then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    raise exception 'This payable pays a permit fee and cannot be deleted; reject it instead' using errcode = '42501';
  end if;
  if exists (
    select 1
    from unnest(case when tg_table_name = 'vendor_bills'
      then array['org_id', 'project_id', 'company_id', 'total_cents', 'currency']
      else array['org_id', 'project_id', 'vendor_company_id', 'amount_cents', 'tax_cents'] end) as k(column_name)
    where (to_jsonb(new) -> k.column_name) is distinct from (to_jsonb(old) -> k.column_name)
  ) then
    raise exception 'This payable pays a permit fee; its amount, payee and home are fixed' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_permit_fee_payables() from public, anon, authenticated;

create trigger vendor_bills_permit_fee_guard
  before update or delete on public.vendor_bills
  for each row execute function public.guard_permit_fee_payables();
create trigger project_expenses_permit_fee_guard
  before update or delete on public.project_expenses
  for each row execute function public.guard_permit_fee_payables();

-- The job cost of a linked bill stays on the fee's home.
create or replace function public.guard_permit_fee_bill_lines()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare v_project uuid;
begin
  select b.project_id into v_project
  from public.vendor_bills b
  join public.permit_fee_payments p on p.vendor_bill_id = b.id
  where b.id = new.bill_id;
  if v_project is null or new.project_id is null then
    return new;
  end if;
  if new.project_id is distinct from v_project then
    raise exception 'A permit fee is job cost on its own home' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_permit_fee_bill_lines() from public, anon, authenticated;

create trigger bill_lines_permit_fee_guard
  before insert or update on public.bill_lines
  for each row execute function public.guard_permit_fee_bill_lines();

-- ---------------------------------------------------------------------------
-- 6. The start gate.
-- ---------------------------------------------------------------------------

-- Evidence the database computes itself, for the package's lot and home, so no
-- caller's row security or supplied verdict can decide it:
--   permit_approved: the live building application on this lot is approved for
--     the plan and elevation pinned on the lot today, under the community's
--     authority when it has one, unexpired, with the issued permit and the
--     approved plans still on file — or the authority said no permit is needed,
--     in a letter on file.
--   plot_plan_file: the live building application carries its plot plan.
create or replace function public.start_gate_sql_evidence(p_org_id uuid, p_package_id uuid, p_source text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_project_id uuid;
  v_lot_id uuid;
  v_version_id uuid;
  v_elevation_id uuid;
  v_authority_id uuid;
begin
  if coalesce((select auth.role()), '') = 'authenticated' and not public.has_org_permission(p_org_id, 'start.read') then
    raise exception 'Start gates need the start.read permission' using errcode = '42501';
  end if;
  if p_source not in ('permit_approved', 'plot_plan_file') then
    raise exception 'Unknown database-evidenced gate source %', p_source using errcode = '22023';
  end if;
  select sp.project_id, sp.lot_id, l.house_plan_version_id, l.house_plan_elevation_id, c.permit_jurisdiction_company_id
    into v_project_id, v_lot_id, v_version_id, v_elevation_id, v_authority_id
  from public.start_packages sp
  join public.lots l on l.org_id = sp.org_id and l.id = sp.lot_id
  join public.communities c on c.org_id = sp.org_id and c.id = sp.community_id
  where sp.org_id = p_org_id and sp.id = p_package_id;
  if v_project_id is null then
    return false;
  end if;
  if p_source = 'plot_plan_file' then
    return exists (
      select 1
      from public.permit_applications a
      join public.permit_application_documents d on d.application_id = a.id and d.document_kind = 'plot_plan'
      join public.files f on f.id = d.file_id
      where a.org_id = p_org_id and a.project_id = v_project_id and a.permit_type = 'building'
        and a.superseded_at is null and (a.decision is null or a.decision in ('approved', 'not_required'))
        and f.org_id = p_org_id and f.project_id = v_project_id and f.archived_at is null
    );
  end if;
  return exists (
    select 1
    from public.permit_applications a
    where a.org_id = p_org_id and a.project_id = v_project_id and a.lot_id = v_lot_id
      and a.permit_type = 'building' and a.superseded_at is null
      and (v_authority_id is null or a.jurisdiction_company_id = v_authority_id)
      and exists (
        select 1 from public.files f
        where f.id = a.issued_permit_file_id and f.org_id = p_org_id and f.project_id = a.project_id and f.archived_at is null
      )
      and (
        a.decision = 'not_required'
        or (
          a.decision = 'approved'
          and (a.expires_on is null or a.expires_on >= current_date)
          and a.house_plan_version_id = v_version_id
          and a.house_plan_elevation_id = v_elevation_id
          and exists (
            select 1 from public.files f
            where f.id = a.approved_plans_file_id and f.org_id = p_org_id and f.project_id = a.project_id and f.archived_at is null
          )
        )
      )
  );
end;
$$;

revoke all on function public.start_gate_sql_evidence(uuid, uuid, text) from public, anon;
grant execute on function public.start_gate_sql_evidence(uuid, uuid, text) to authenticated, service_role;

alter table public.start_gate_definitions drop constraint if exists start_gate_definitions_auto_source_check;
alter table public.start_gate_definitions add constraint start_gate_definitions_auto_source_check
  check (auto_source is null or auto_source in (
    'selections_locked', 'budget_generated', 'pos_generated', 'plan_pinned',
    'plot_plan_file', 'po_exceptions_clear', 'entitlements_clear', 'agreement_milestones_clear', 'permit_approved'
  ));

update public.start_gate_definitions
   set check_kind = 'auto', auto_source = 'permit_approved', applies_when = 'always', is_active = true,
       requires_attestation_permission = null, label = 'Approved permit for this plan'
 where key = 'permit';

update public.start_gate_definitions
   set check_kind = 'auto', auto_source = 'plot_plan_file', applies_when = 'always', is_active = true,
       requires_attestation_permission = null
 where key = 'plot_plan';

-- The permit and plot-plan gates are the system's: their source, applicability
-- and activity never change and they are never deleted, by any writer.
create or replace function public.guard_system_start_gates()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.key in ('permit', 'plot_plan') then
      raise exception 'The % gate is part of every start and cannot be removed', old.key using errcode = '42501';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and old.key in ('permit', 'plot_plan') and new.key is distinct from old.key then
    raise exception 'The % gate is part of every start and cannot be renamed', old.key using errcode = '42501';
  end if;
  if new.key = 'permit'
     and (new.check_kind, new.auto_source, new.applies_when, new.is_active, new.requires_attestation_permission)
         is distinct from ('auto'::text, 'permit_approved'::text, 'always'::text, true, null::text) then
    raise exception 'The permit gate reads the approved permit for the lot''s plan; it cannot be made manual, conditional or inactive' using errcode = '42501';
  end if;
  if new.key = 'plot_plan'
     and (new.check_kind, new.auto_source, new.applies_when, new.is_active, new.requires_attestation_permission)
         is distinct from ('auto'::text, 'plot_plan_file'::text, 'always'::text, true, null::text) then
    raise exception 'The plot plan gate reads the permit application''s plot plan; it cannot be made manual, conditional or inactive' using errcode = '42501';
  end if;
  if new.key <> 'permit' and new.auto_source = 'permit_approved' then
    raise exception 'Only the permit gate reads the approved permit' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_system_start_gates() from public, anon, authenticated;

drop trigger if exists start_gate_definitions_system_guard on public.start_gate_definitions;
create trigger start_gate_definitions_system_guard
  before insert or update or delete on public.start_gate_definitions
  for each row execute function public.guard_system_start_gates();

-- Gate definitions: read with start.read, changed only with start.release.
drop policy if exists start_gate_definitions_org_access on public.start_gate_definitions;
drop policy if exists start_gate_definitions_read on public.start_gate_definitions;
create policy start_gate_definitions_read on public.start_gate_definitions
  for select to authenticated using (public.has_org_permission(org_id, 'start.read'));
drop policy if exists start_gate_definitions_insert on public.start_gate_definitions;
create policy start_gate_definitions_insert on public.start_gate_definitions
  for insert to authenticated with check (public.has_org_permission(org_id, 'start.release'));
drop policy if exists start_gate_definitions_update on public.start_gate_definitions;
create policy start_gate_definitions_update on public.start_gate_definitions
  for update to authenticated
  using (public.has_org_permission(org_id, 'start.release'))
  with check (public.has_org_permission(org_id, 'start.release'));
drop policy if exists start_gate_definitions_delete on public.start_gate_definitions;
create policy start_gate_definitions_delete on public.start_gate_definitions
  for delete to authenticated using (public.has_org_permission(org_id, 'start.release'));

-- Packages still being assembled lose a permit gate cleared by hand: the house
-- starts on an approved permit, not on a note. Released and releasing packages
-- keep their record.
do $$
declare r record;
begin
  for r in
    select g.id as gate_id, g.org_id, g.start_package_id, g.status, g.passed_via, p.status as package_status
    from public.start_package_gates g
    join public.start_gate_definitions d on d.id = g.gate_definition_id and d.org_id = g.org_id
    join public.start_packages p on p.id = g.start_package_id and p.org_id = g.org_id
    where d.key = 'permit' and p.status in ('open', 'ready') and g.passed_via in ('attested', 'waived')
  loop
    update public.start_package_gates
       set status = 'pending', passed_via = null, attested_by = null, attested_at = null, waived_reason = null, evidence_file_id = null
     where id = r.gate_id;
    if r.package_status = 'ready' then
      update public.start_packages set status = 'open' where id = r.start_package_id and status = 'ready';
    end if;
    insert into public.audit_log (org_id, actor_user_id, action, entity_type, entity_id, before_data, after_data, source)
    values (r.org_id, null, 'update', 'start_gate', r.gate_id,
      jsonb_build_object('status', r.status, 'passed_via', r.passed_via, 'package_status', r.package_status),
      jsonb_build_object('status', 'pending', 'reason', 'The permit gate now reads the approved permit'), 'starts.permit_gate_reset');
  end loop;
end $$;

-- Attest, waive or reopen one gate (replaces 20261011060000). A manual gate
-- that is a fact is attested with evidence on this home; a sign-off (final
-- approval, or a gate naming its own attestation permission) is attested by
-- who may give it.
-- The permit gate is never waived.
create or replace function public.mutate_start_gate(p_org_id uuid,p_package_id uuid,p_gate_id uuid,p_actor_id uuid,
  p_action text,p_input jsonb,p_purchasing_enabled boolean)
returns jsonb language plpgsql set search_path=public,pg_catalog as $$
declare v_pkg public.start_packages%rowtype; v_gate public.start_package_gates%rowtype; v_after public.start_package_gates%rowtype;
  v_def public.start_gate_definitions%rowtype; v_tally record; v_event uuid:=gen_random_uuid(); v_reason text;
  v_evidence uuid; v_verb text; v_status text;
begin
  if p_action is null or p_action not in ('attest','waive','reopen') or p_purchasing_enabled is null
    or jsonb_typeof(coalesce(p_input,'{}')) is distinct from 'object' then raise exception 'Invalid start gate request'; end if;
  v_pkg:=public.lock_starts_desk_package(p_org_id,p_package_id,p_actor_id,
    case when p_action='waive' then array['start.release'] else array['start.write'] end);
  if v_pkg.status not in ('open','ready') then raise exception 'Gates cannot change after release begins.' using errcode='40001'; end if;
  select * into v_gate from public.start_package_gates where org_id=p_org_id and start_package_id=p_package_id and id=p_gate_id for update;
  if not found then raise exception 'Start gate not found' using errcode='42501'; end if;
  select * into v_def from public.start_gate_definitions where org_id=p_org_id and id=v_gate.gate_definition_id;
  if not found then raise exception 'Start gate not found' using errcode='42501'; end if;
  if p_action='attest' then
    if v_def.check_kind<>'manual' then raise exception 'Only manual gates can be attested.' using errcode='42501'; end if;
    if v_def.requires_attestation_permission is not null then
      perform public.assert_starts_desk_actor(v_pkg,p_actor_id,v_def.requires_attestation_permission); end if;
    if v_def.key='final_approval' then
      select * into v_tally from public.start_package_gate_tally(v_pkg,p_purchasing_enabled,'final_approval');
      if v_tally.satisfied<>v_tally.total then
        raise exception 'Clear every other readiness gate before final approval.' using errcode='40001'; end if;
    end if;
    v_evidence:=nullif(p_input->>'evidence_file_id','')::uuid;
    if v_evidence is null and v_def.requires_attestation_permission is null and v_def.key<>'final_approval' then
      raise exception 'Attach the evidence for this gate: a file on this home.' using errcode='23514'; end if;
    if v_evidence is not null then
      perform 1 from public.files where org_id=p_org_id and id=v_evidence and project_id=v_pkg.project_id and archived_at is null;
      if not found then raise exception 'Evidence must be a file on this home' using errcode='23514'; end if;
    end if;
    update public.start_package_gates set status='passed',passed_via='attested',attested_by=p_actor_id,attested_at=clock_timestamp(),
      evidence_file_id=v_evidence,notes=nullif(btrim(coalesce(p_input->>'notes','')),''),waived_reason=null
      where id=p_gate_id returning * into v_after;
    v_verb:='attested';
  elsif p_action='waive' then
    if v_def.auto_source='permit_approved' then
      raise exception 'The permit gate is never waived. Record the authority''s decision on the home''s permits: approved, or not required with its letter.'
        using errcode='42501'; end if;
    v_reason:=btrim(coalesce(p_input->>'reason',''));
    if length(v_reason)<10 then raise exception 'A waiver needs a reason of at least 10 characters.'; end if;
    update public.start_package_gates set status='waived',passed_via='waived',attested_by=p_actor_id,attested_at=clock_timestamp(),
      waived_reason=v_reason where id=p_gate_id returning * into v_after;
    v_verb:='waived';
  else
    update public.start_package_gates set status='pending',passed_via=null,attested_by=null,attested_at=null,waived_reason=null
      where id=p_gate_id returning * into v_after;
    v_verb:='reopened';
  end if;
  insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,before_data,after_data,source)
    values(p_org_id,p_actor_id,'update','start_gate',p_gate_id,to_jsonb(v_gate),to_jsonb(v_after),'starts.gate_'||v_verb);
  insert into public.events(id,org_id,event_type,entity_type,entity_id,payload,channel)
    values(v_event,p_org_id,'start_gate.'||v_verb,'start_gate',p_gate_id,
      jsonb_strip_nulls(jsonb_build_object('start_package_id',p_package_id,'gate_key',v_def.key,'reason',v_reason,'actor_id',p_actor_id)),'activity');
  if p_action='waive' then perform public.queue_start_package_notice(v_pkg,'gate_waived',v_event,v_reason); end if;
  v_status:=public.settle_start_package_readiness(v_pkg,p_actor_id,p_purchasing_enabled);
  return jsonb_build_object('status',v_status);
end $$;
revoke all on function public.mutate_start_gate(uuid,uuid,uuid,uuid,text,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.mutate_start_gate(uuid,uuid,uuid,uuid,text,jsonb,boolean) to service_role;

-- Re-decide applicability and record auto evidence (replaces 20261011060000).
-- The permit and plot-plan gates are evidenced here, from the tables; whatever
-- the caller supplied for them is ignored. Every other auto gate records the
-- evidence the service derived (p_evidence: gate id -> passed).
create or replace function public.refresh_start_package_gates(p_org_id uuid,p_package_id uuid,p_actor_id uuid,
  p_purchasing_enabled boolean,p_evidence jsonb)
returns jsonb language plpgsql set search_path=public,pg_catalog as $$
declare v_pkg public.start_packages%rowtype; r record; v_to text; v_via text; v_changes jsonb:='[]'; v_status text;
begin
  if p_purchasing_enabled is null or jsonb_typeof(p_evidence) is distinct from 'object' then
    raise exception 'Invalid start gate refresh'; end if;
  v_pkg:=public.lock_starts_desk_package(p_org_id,p_package_id,p_actor_id,array['start.read']);
  if v_pkg.status not in ('open','ready') then return jsonb_build_object('status',v_pkg.status,'changed',0); end if;
  for r in select g.id,g.status,g.passed_via,d.key,d.check_kind,d.applies_when,d.auto_source
    from public.start_package_gates g join public.start_gate_definitions d on d.id=g.gate_definition_id and d.org_id=g.org_id
    where g.org_id=p_org_id and g.start_package_id=p_package_id order by g.id for update of g
  loop
    if not public.start_gate_applies(r.applies_when,v_pkg,p_purchasing_enabled) then
      v_to:='not_applicable'; v_via:=null;
    elsif r.check_kind='auto' and r.auto_source='permit_approved' then
      v_to:=case when public.start_gate_sql_evidence(p_org_id,p_package_id,r.auto_source) then 'passed' else 'pending' end;
      v_via:=case when v_to='passed' then 'auto' end;
    elsif r.status='waived' or r.check_kind<>'auto' then
      if r.status<>'not_applicable' then continue; end if;
      v_to:='pending'; v_via:=null;
    elsif r.auto_source='plot_plan_file' then
      v_to:=case when public.start_gate_sql_evidence(p_org_id,p_package_id,r.auto_source) then 'passed' else 'pending' end;
      v_via:=case when v_to='passed' then 'auto' end;
    else
      if jsonb_typeof(p_evidence->(r.id::text)) is distinct from 'boolean' then
        raise exception 'Readiness evidence is missing for the % gate; refresh again.',r.key using errcode='40001'; end if;
      v_to:=case when (p_evidence->>(r.id::text))::boolean then 'passed' else 'pending' end;
      v_via:=case when v_to='passed' then 'auto' end;
    end if;
    if r.status is distinct from v_to or r.passed_via is distinct from v_via then
      update public.start_package_gates set status=v_to,passed_via=v_via where id=r.id;
      v_changes:=v_changes||jsonb_build_array(jsonb_build_object('gate_id',r.id,'key',r.key,'from',r.status,'to',v_to));
    end if;
  end loop;
  if jsonb_array_length(v_changes)>0 then
    insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,before_data,after_data,source)
      values(p_org_id,p_actor_id,'update','start_package',p_package_id,jsonb_build_object('status',v_pkg.status),
        jsonb_build_object('gates',v_changes),'starts.gates_refreshed');
    insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel)
      values(p_org_id,'start_gate.refreshed','start_package',p_package_id,
        jsonb_build_object('gates',v_changes,'actor_id',p_actor_id),'activity');
  end if;
  v_status:=public.settle_start_package_readiness(v_pkg,p_actor_id,p_purchasing_enabled);
  return jsonb_build_object('status',v_status,'changed',jsonb_array_length(v_changes));
end $$;
revoke all on function public.refresh_start_package_gates(uuid,uuid,uuid,boolean,jsonb) from public,anon,authenticated;
grant execute on function public.refresh_start_package_gates(uuid,uuid,uuid,boolean,jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 7. RBAC. Everyone who reads starts reads permits (and the bookkeeper, who
-- reconciles their fees); everyone who manages start packages manages permits.
-- ---------------------------------------------------------------------------

insert into public.permissions (key, description) values
  ('permit.read', 'View permit applications, corrections and fees'),
  ('permit.write', 'Manage permit applications, corrections, decisions and fees')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select distinct rp.role_id, 'permit.read'
from public.role_permissions rp
where rp.permission_key = 'start.read'
on conflict (role_id, permission_key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, 'permit.read'
from public.roles r
where r.key = 'org_bookkeeper'
on conflict (role_id, permission_key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select distinct rp.role_id, 'permit.write'
from public.role_permissions rp
where rp.permission_key = 'start.write'
on conflict (role_id, permission_key) do nothing;
