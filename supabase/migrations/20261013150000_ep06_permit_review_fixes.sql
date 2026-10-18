-- EP06 review fixes (permits): the guarantees the permit gate and its fees
-- stand on hold for every writer, as in EP04 and EP05.
--
--  1. A community's permitting authority is set only by a community.write holder
--     inside the division wall, through set_community_permit_authority; a signed-in
--     member never writes the column.
--  2. "No permit required" stands on the authority's letter on the application, a
--     reason, and the community's authority; an approval on the issued permit and
--     the stamped plans as two distinct files, each filed under its document kind.
--  3. A fee's payables keep what reconciliation reads: a member never writes a
--     linked bill's paid amount or moves a linked payable's status without the
--     authority payables demands; bill lines must sit on the fee's home and foot
--     to the bill. Paying a fee claims it first, so two payers cannot each create
--     a payable for the same remainder, and a failed link leaves no orphan.
--  4. Whoever entered a counter-paid expense may link it to the fee.
--  5. A correction round has a due date; dates are the home's local date (the
--     community's time zone); a fee due before submission blocks the submission.
--  6. Every permit function authorizes before it locks, and answers a stranger
--     and an out-of-scope member the same way.
--  7. start_gate_sql_evidence stays inside the caller's division wall; the start
--     release re-checks the permit gate in its own transaction.
--  8. Evidence files: a home's deletion carries them with it; otherwise the
--     refusal says what to do, and the bytes cannot be swapped.

-- ---------------------------------------------------------------------------
-- 0. Shared helpers.
-- ---------------------------------------------------------------------------

-- Today on the home's wall clock: the community's zone, else the org's.
create or replace function public.permit_local_today(p_org_id uuid, p_project_id uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select (now() at time zone public.selection_home_time_zone(p_org_id, p_project_id))::date
$$;

revoke all on function public.permit_local_today(uuid, uuid) from public, anon;
grant execute on function public.permit_local_today(uuid, uuid) to authenticated, service_role;

-- Authorize first (the org-level permission, then the home's reach), lock second.
-- A stranger and a member outside the home's scope get the same answer for an
-- application that exists and one that does not.
create or replace function public.permit_lock_authorized(p_org_id uuid, p_application_id uuid, p_permissions text[])
returns public.permit_applications
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project_id uuid;
begin
  perform public.permit_actor(p_org_id, null, p_permissions);
  select a.project_id into v_project_id from public.permit_applications a where a.org_id = p_org_id and a.id = p_application_id;
  if v_project_id is null
     or not (p_org_id = any (public.member_unscoped_org_ids()) or v_project_id in (select public.member_reachable_project_ids())) then
    raise exception 'This home is outside your access' using errcode = '42501';
  end if;
  return public.permit_lock_application(p_org_id, p_application_id);
end;
$$;

revoke all on function public.permit_lock_authorized(uuid, uuid, text[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1. The community's permitting authority.
-- ---------------------------------------------------------------------------

create or replace function public.tg_community_permit_authority_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if (tg_op = 'INSERT' and new.permit_jurisdiction_company_id is not null)
     or (tg_op = 'UPDATE' and new.permit_jurisdiction_company_id is distinct from old.permit_jurisdiction_company_id) then
    raise exception 'A community''s permitting authority is set from its settings, by someone who manages communities' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists communities_permit_authority_guard on public.communities;
create trigger communities_permit_authority_guard
  before insert or update on public.communities
  for each row execute function public.tg_community_permit_authority_guard();

create or replace function public.set_community_permit_authority(p_org_id uuid, p_community_id uuid, p_company_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_before uuid;
  v_division uuid;
begin
  if v_actor is null or not public.has_org_permission(p_org_id, 'community.write') then
    raise exception 'This needs the community.write permission' using errcode = '42501';
  end if;
  select c.permit_jurisdiction_company_id, c.division_id into v_before, v_division
  from public.communities c where c.org_id = p_org_id and c.id = p_community_id for update;
  if not found
     or not (p_org_id = any (public.member_division_unscoped_org_ids()) or v_division in (select public.member_reachable_division_ids())) then
    raise exception 'Community not found' using errcode = '42501';
  end if;
  if p_company_id is not null and not exists (
    select 1 from public.companies where org_id = p_org_id and id = p_company_id and archived_at is null
  ) then
    raise exception 'Authority not found' using errcode = '23503';
  end if;
  update public.communities set permit_jurisdiction_company_id = p_company_id where org_id = p_org_id and id = p_community_id;
  insert into public.audit_log (org_id, actor_user_id, action, entity_type, entity_id, before_data, after_data, source)
  values (p_org_id, v_actor, 'update', 'community', p_community_id,
    jsonb_build_object('permit_jurisdiction_company_id', v_before), jsonb_build_object('permit_jurisdiction_company_id', p_company_id),
    'permits.community_authority_set');
  insert into public.events (org_id, event_type, entity_type, entity_id, payload, channel)
  values (p_org_id, 'community.permit_authority_set', 'community', p_community_id,
    jsonb_build_object('company_id', p_company_id, 'actor_id', v_actor), 'activity');
end;
$$;

revoke all on function public.set_community_permit_authority(uuid, uuid, uuid) from public, anon;
grant execute on function public.set_community_permit_authority(uuid, uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Evidence that is a decision's own: two distinct files for an approval.
-- ---------------------------------------------------------------------------

alter table public.permit_applications drop constraint if exists permit_application_evidence_distinct;
alter table public.permit_applications add constraint permit_application_evidence_distinct
  check (issued_permit_file_id is null or issued_permit_file_id is distinct from approved_plans_file_id) not valid;

alter table public.permit_fees add column if not exists pay_claim_until timestamptz;

-- ---------------------------------------------------------------------------
-- 3. Functions: authorize before lock; the home's local date.
-- ---------------------------------------------------------------------------

create or replace function public.assign_permit_application(p_org_id uuid, p_application_id uuid, p_owner_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_app public.permit_applications%rowtype := public.permit_lock_authorized(p_org_id, p_application_id, array['permit.write']);
  v_actor uuid := (select auth.uid());
begin
  perform public.permit_assert_member(p_org_id, p_owner_user_id);
  update public.permit_applications set owner_user_id = p_owner_user_id where id = v_app.id;
  perform public.permit_record_change(p_org_id, v_actor, 'permit_application', v_app.id, 'update', 'permits.application_assigned',
    'permit_application.assigned', jsonb_build_object('owner_user_id', v_app.owner_user_id), jsonb_build_object('owner_user_id', p_owner_user_id),
    jsonb_build_object('project_id', v_app.project_id, 'owner_user_id', p_owner_user_id), v_app.id);
end;
$$;

create or replace function public.set_permit_document(
  p_org_id uuid, p_application_id uuid, p_document_kind text, p_label text, p_required_for text, p_file_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_app public.permit_applications%rowtype := public.permit_lock_authorized(p_org_id, p_application_id, array['permit.write']);
  v_actor uuid := (select auth.uid());
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

-- A submission to the authority. Refused while a document required for
-- submission has no file or a fee due before submission is unpaid.
create or replace function public.record_permit_submission(
  p_org_id uuid, p_application_id uuid, p_submitted_on date, p_reference text, p_note text, p_responds_to_round_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_app public.permit_applications%rowtype := public.permit_lock_authorized(p_org_id, p_application_id, array['permit.write']);
  v_actor uuid := (select auth.uid());
  v_missing text;
  v_unpaid text;
  v_count integer;
  v_round public.permit_correction_rounds%rowtype;
  v_review_days integer;
  v_version_id uuid;
  v_elevation_id uuid;
  v_submission public.permit_submissions%rowtype;
begin
  perform public.permit_assert_open(v_app);
  if p_submitted_on is null or p_submitted_on > public.permit_local_today(p_org_id, v_app.project_id) then
    raise exception 'A submission date cannot be in the future' using errcode = '23514';
  end if;
  select string_agg(label, ', ' order by sort_order) into v_missing
  from public.permit_application_documents
  where application_id = v_app.id and required_for = 'submission' and file_id is null;
  if v_missing is not null then
    raise exception 'Attach the documents the authority needs before submitting: %', v_missing using errcode = '23514';
  end if;
  select string_agg(f.kind || ' $' || to_char(f.amount_cents / 100.0, 'FM999999990.00'), ', ') into v_unpaid
  from public.permit_fees f
  where f.application_id = v_app.id and f.status = 'open' and f.due_before = 'submission'
    and public.permit_fee_paid_cents(f.id) < f.amount_cents;
  if v_unpaid is not null then
    raise exception 'Fees due before submission are not paid: %', v_unpaid using errcode = '23514';
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

-- The authority returned comments on the latest submission. A round is always
-- due on a date: one with none never ages and never reminds anyone.
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
  v_app public.permit_applications%rowtype := public.permit_lock_authorized(p_org_id, p_application_id, array['permit.write']);
  v_actor uuid := (select auth.uid());
  v_submission public.permit_submissions%rowtype;
  v_round public.permit_correction_rounds%rowtype;
begin
  perform public.permit_assert_open(v_app);
  select * into v_submission from public.permit_submissions where application_id = v_app.id order by submission_no desc limit 1;
  if v_submission.id is null then
    raise exception 'Corrections answer a submission; record the submission first' using errcode = '23514';
  end if;
  if p_received_on is null or p_received_on < v_submission.submitted_on or p_received_on > public.permit_local_today(p_org_id, v_app.project_id) then
    raise exception 'Corrections are received after the submission they answer, and not in the future' using errcode = '23514';
  end if;
  if p_due_on is null then
    raise exception 'Say when the response is due' using errcode = '23514';
  end if;
  if p_due_on < p_received_on then
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
  v_actor uuid := (select auth.uid());
  v_after public.permit_correction_rounds%rowtype;
  v_to text;
  v_note text := nullif(btrim(p_note), '');
  v_today date;
begin
  perform public.permit_actor(p_org_id, null, array['permit.write']);
  if jsonb_typeof(p_patch) is distinct from 'object'
     or exists (select 1 from jsonb_object_keys(p_patch) k where k not in ('owner_user_id', 'due_on', 'status')) then
    raise exception 'Invalid correction round update' using errcode = '22023';
  end if;
  select application_id into v_application_id from public.permit_correction_rounds where org_id = p_org_id and id = p_round_id;
  if v_application_id is null then
    raise exception 'This home is outside your access' using errcode = '42501';
  end if;
  v_app := public.permit_lock_authorized(p_org_id, v_application_id, array['permit.write']);
  perform public.permit_assert_open(v_app);
  select * into v_round from public.permit_correction_rounds where id = p_round_id for update;
  if v_round.status in ('resolved', 'withdrawn') then
    raise exception 'Round % is closed; record a new round for new comments', v_round.round_no using errcode = '23514';
  end if;
  if p_patch ? 'owner_user_id' then
    perform public.permit_assert_member(p_org_id, nullif(p_patch->>'owner_user_id', '')::uuid);
  end if;
  if p_patch ? 'due_on' then
    if nullif(p_patch->>'due_on', '') is null then
      raise exception 'A round is always due on a date' using errcode = '23514';
    end if;
    if (p_patch->>'due_on')::date < v_round.received_on then
      raise exception 'A response cannot be due before the corrections arrived' using errcode = '23514';
    end if;
  end if;
  v_today := public.permit_local_today(p_org_id, v_app.project_id);
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
      due_on = case when p_patch ? 'due_on' then (p_patch->>'due_on')::date else due_on end,
      metadata = case when p_patch ? 'due_on' and (p_patch->>'due_on')::date is distinct from due_on
        then metadata - 'reminded_due_soon' - 'reminded_overdue' else metadata end,
      status = v_to,
      resolved_on = case when v_to = 'resolved' then v_today else null end,
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

-- The authority's decision. An approval stands on the issued permit and the
-- stamped plans as two distinct files, filed as the application's own documents
-- (kinds issued_permit and approved_plans), every other required document
-- attached, no round waiting, a permit number, the plan it reviewed, and every
-- fee due before submission or issuance paid. "Not required" stands on the
-- authority's letter filed as its own document (kind authority_letter), a
-- reason, and the community's authority being set.
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
  v_app public.permit_applications%rowtype := public.permit_lock_authorized(p_org_id, p_application_id, array['permit.write']);
  v_actor uuid := (select auth.uid());
  v_after public.permit_applications%rowtype;
  v_missing text;
  v_unpaid text;
  v_open integer;
  v_today date := public.permit_local_today(p_org_id, v_app.project_id);
  v_authority uuid;
  v_shared text;
begin
  perform public.permit_assert_open(v_app);
  if p_decision not in ('approved', 'denied', 'withdrawn', 'not_required') then
    raise exception 'Invalid permit decision' using errcode = '22023';
  end if;
  if p_decided_on is null or p_decided_on > v_today then
    raise exception 'A decision date cannot be in the future' using errcode = '23514';
  end if;
  if p_decision in ('denied', 'withdrawn') and coalesce(length(btrim(p_note)), 0) < 5 then
    raise exception 'Record why the application was %', p_decision using errcode = '23514';
  end if;
  if p_decision = 'not_required' then
    if v_app.permit_type <> 'building' then
      raise exception 'Only the building application can be recorded as not required' using errcode = '23514';
    end if;
    if coalesce(length(btrim(p_note)), 0) < 10 then
      raise exception 'Say why no permit is required, in at least 10 characters' using errcode = '23514';
    end if;
    select c.permit_jurisdiction_company_id into v_authority
    from public.lots l join public.communities c on c.org_id = l.org_id and c.id = l.community_id
    where l.org_id = p_org_id and l.id = v_app.lot_id;
    if v_authority is null then
      raise exception 'Set the community''s permitting authority first: the letter must come from it' using errcode = '23514';
    end if;
    if v_authority <> v_app.jurisdiction_company_id then
      raise exception 'The application is to a different authority than the community''s' using errcode = '23514';
    end if;
    perform public.permit_assert_home_file(p_org_id, v_app.project_id, p_issued_permit_file_id, 'The authority''s no-permit letter');
    select string_agg(d.label, ', ') into v_shared
    from public.permit_application_documents d
    where d.application_id = v_app.id and d.file_id = p_issued_permit_file_id and d.document_kind <> 'authority_letter';
    if v_shared is not null then
      raise exception 'The no-permit letter must be its own file, not the one filed as: %', v_shared using errcode = '23514';
    end if;
  end if;
  if p_decision = 'approved' then
    if not exists (select 1 from public.permit_submissions where application_id = v_app.id) then
      raise exception 'An application is approved only after it was submitted' using errcode = '23514';
    end if;
    select string_agg(label, ', ' order by sort_order) into v_missing
    from public.permit_application_documents
    where application_id = v_app.id and file_id is null and document_kind not in ('issued_permit', 'approved_plans', 'authority_letter');
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
    if p_issued_permit_file_id = p_approved_plans_file_id then
      raise exception 'The issued permit and the stamped plans are two files' using errcode = '23514';
    end if;
    select string_agg(d.label, ', ') into v_shared
    from public.permit_application_documents d
    where d.application_id = v_app.id and d.document_kind not in ('issued_permit', 'approved_plans')
      and d.file_id in (p_issued_permit_file_id, p_approved_plans_file_id);
    if v_shared is not null then
      raise exception 'The permit and the stamped plans must be their own files, not the ones filed as: %', v_shared using errcode = '23514';
    end if;
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
    perform set_config('arc.permit_note', 'Resolved by the approval', true);
    update public.permit_correction_rounds set status = 'resolved', resolved_on = p_decided_on, resolved_by = v_actor
    where application_id = v_app.id and status = 'responded';
    perform set_config('arc.permit_note', '', true);
  end if;

  if p_decision in ('approved', 'not_required') then
    insert into public.permit_application_documents (org_id, project_id, application_id, document_kind, label, required_for, source,
      file_id, attached_at, attached_by, sort_order)
    select p_org_id, v_app.project_id, v_app.id, e.kind, e.label, 'decision', 'added', e.file_id, clock_timestamp(), v_actor,
      (select coalesce(max(sort_order), 0) + 10 from public.permit_application_documents where application_id = v_app.id)
    from (values
      ('issued_permit', 'Issued permit', case when p_decision = 'approved' then p_issued_permit_file_id end),
      ('approved_plans', 'Stamped plans', case when p_decision = 'approved' then p_approved_plans_file_id end),
      ('authority_letter', 'Authority''s no-permit letter', case when p_decision = 'not_required' then p_issued_permit_file_id end)
    ) as e(kind, label, file_id)
    where e.file_id is not null
    on conflict (application_id, document_kind) do update
      set file_id = excluded.file_id, attached_at = excluded.attached_at, attached_by = excluded.attached_by;
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
  v_app public.permit_applications%rowtype := public.permit_lock_authorized(p_org_id, p_application_id, array['permit.write']);
  v_actor uuid := (select auth.uid());
  v_fee public.permit_fees%rowtype;
begin
  if v_app.superseded_at is not null then
    raise exception 'This application was superseded by a revision' using errcode = '42501';
  end if;
  if p_assessed_on is null or p_assessed_on > public.permit_local_today(p_org_id, v_app.project_id) then
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

create or replace function public.void_permit_fee(p_org_id uuid, p_fee_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_application_id uuid;
  v_fee public.permit_fees%rowtype;
  v_app public.permit_applications%rowtype;
  v_actor uuid := (select auth.uid());
  v_after public.permit_fees%rowtype;
begin
  perform public.permit_actor(p_org_id, null, array['permit.write']);
  select application_id into v_application_id from public.permit_fees where org_id = p_org_id and id = p_fee_id;
  if v_application_id is null then
    raise exception 'This home is outside your access' using errcode = '42501';
  end if;
  v_app := public.permit_lock_authorized(p_org_id, v_application_id, array['permit.write']);
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

-- ---------------------------------------------------------------------------
-- 4. Fee payments: claim, link, release. Money functions: the service role
--    only, with the acting member passed in and checked here for the org, the
--    permission and the home's reach (the service has already checked the
--    member's session).
-- ---------------------------------------------------------------------------

-- Whether the member may reach a home: an org admin or an unscoped member
-- anywhere, otherwise inside their divisions and projects.
create or replace function public.permit_actor_reaches(p_org_id uuid, p_actor_id uuid, p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    join public.projects p on p.org_id = m.org_id and p.id = p_project_id
    where m.org_id = p_org_id
      and m.user_id = p_actor_id
      and m.status = 'active'
      and (
        public.membership_is_org_admin(m.id, m.role_id)
        or (
          (m.division_scope = 'all' or p.division_id in (select md.division_id from public.membership_divisions md where md.membership_id = m.id))
          and (
            m.project_scope = 'all'
            or exists (
              select 1 from public.project_members pm
              where pm.project_id = p.id and pm.user_id = m.user_id and pm.org_id = m.org_id and pm.status = 'active'
            )
          )
        )
      )
  )
$$;

revoke all on function public.permit_actor_reaches(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.permit_actor_reaches(uuid, uuid, uuid) to service_role;

-- The member holds one of the permissions in the org (a grant, not denied), and
-- the home, when given, is in reach.
create or replace function public.permit_service_actor(p_org_id uuid, p_actor_id uuid, p_project_id uuid, p_permissions text[])
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_permission text;
  v_allowed boolean := false;
begin
  if p_actor_id is null then
    raise exception 'Sign in to work on permits' using errcode = '42501';
  end if;
  foreach v_permission in array p_permissions loop
    if exists (
         select 1
         from public.memberships m
         left join public.role_permissions rp on rp.role_id = m.role_id and rp.permission_key = v_permission
         left join public.membership_permission_overrides mpo
           on mpo.membership_id = m.id and mpo.permission_key = v_permission and mpo.effect = 'grant'
         where m.org_id = p_org_id and m.user_id = p_actor_id and m.status = 'active'
           and (rp.permission_key is not null or mpo.permission_key is not null)
       )
       and not exists (
         select 1
         from public.memberships m
         join public.membership_permission_overrides mpo
           on mpo.membership_id = m.id and mpo.permission_key = v_permission and mpo.effect = 'deny'
         where m.org_id = p_org_id and m.user_id = p_actor_id and m.status = 'active'
       ) then
      v_allowed := true;
      exit;
    end if;
  end loop;
  if not v_allowed then
    raise exception 'This needs the % permission', array_to_string(p_permissions, ' or ') using errcode = '42501';
  end if;
  if p_project_id is not null and not public.permit_actor_reaches(p_org_id, p_actor_id, p_project_id) then
    raise exception 'This home is outside your access' using errcode = '42501';
  end if;
  return p_actor_id;
end;
$$;

revoke all on function public.permit_service_actor(uuid, uuid, uuid, text[]) from public, anon, authenticated;
grant execute on function public.permit_service_actor(uuid, uuid, uuid, text[]) to service_role;

-- Who may work a fee's payables: whoever manages permits or enters payables,
-- and, for a counter payment, whoever entered the expense.
drop function if exists public.permit_fee_actor(uuid, uuid, uuid);

create or replace function public.permit_fee_actor(p_org_id uuid, p_actor_id uuid, p_project_id uuid, p_expense_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_expense_id is not null and p_actor_id is not null
     and exists (
       select 1 from public.project_expenses e
       join public.memberships m on m.org_id = e.org_id and m.user_id = p_actor_id and m.status = 'active'
       where e.org_id = p_org_id and e.id = p_expense_id and e.submitted_by_user_id = p_actor_id and e.project_id = p_project_id
     )
     and public.permit_actor_reaches(p_org_id, p_actor_id, p_project_id) then
    return p_actor_id;
  end if;
  return public.permit_service_actor(p_org_id, p_actor_id, p_project_id, array['permit.write', 'bill.write']);
end;
$$;

revoke all on function public.permit_fee_actor(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.permit_fee_actor(uuid, uuid, uuid, uuid) to service_role;

-- Take the fee for one payer while a bill or expense is created for what remains
-- of it. Returns that remainder. The claim lapses after two minutes.
create or replace function public.claim_permit_fee_payment(p_org_id uuid, p_actor_id uuid, p_fee_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_application_id uuid;
  v_project_id uuid;
  v_fee public.permit_fees%rowtype;
  v_remaining bigint;
begin
  perform public.permit_service_actor(p_org_id, p_actor_id, null, array['permit.write', 'bill.write']);
  select application_id, project_id into v_application_id, v_project_id from public.permit_fees where org_id = p_org_id and id = p_fee_id;
  if v_application_id is null or not public.permit_actor_reaches(p_org_id, p_actor_id, v_project_id) then
    raise exception 'This home is outside your access' using errcode = '42501';
  end if;
  perform public.permit_lock_application(p_org_id, v_application_id);
  select * into v_fee from public.permit_fees where id = p_fee_id for update;
  if v_fee.status <> 'open' then
    raise exception 'A void fee is not paid' using errcode = '23514';
  end if;
  if v_fee.pay_claim_until is not null and v_fee.pay_claim_until > clock_timestamp() then
    raise exception 'Someone is already recording a payment on this fee; reload in a moment' using errcode = '55P03';
  end if;
  v_remaining := v_fee.amount_cents - public.permit_fee_linked_cents(v_fee.id);
  if v_remaining <= 0 then
    raise exception 'Nothing remains to pay on this fee' using errcode = '23514';
  end if;
  update public.permit_fees set pay_claim_until = clock_timestamp() + interval '2 minutes' where id = v_fee.id;
  return v_remaining;
end;
$$;

drop function if exists public.claim_permit_fee_payment(uuid, uuid);
revoke all on function public.claim_permit_fee_payment(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_permit_fee_payment(uuid, uuid, uuid) to service_role;

create or replace function public.release_permit_fee_claim(p_org_id uuid, p_actor_id uuid, p_fee_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project_id uuid;
begin
  perform public.permit_service_actor(p_org_id, p_actor_id, null, array['permit.write', 'bill.write']);
  select project_id into v_project_id from public.permit_fees where org_id = p_org_id and id = p_fee_id;
  if v_project_id is null or not public.permit_actor_reaches(p_org_id, p_actor_id, v_project_id) then
    raise exception 'This home is outside your access' using errcode = '42501';
  end if;
  update public.permit_fees set pay_claim_until = null where org_id = p_org_id and id = p_fee_id;
end;
$$;

drop function if exists public.release_permit_fee_claim(uuid, uuid);
revoke all on function public.release_permit_fee_claim(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.release_permit_fee_claim(uuid, uuid, uuid) to service_role;

drop function if exists public.link_permit_fee_payment(uuid, uuid, uuid, uuid);

create or replace function public.link_permit_fee_payment(p_org_id uuid, p_actor_id uuid, p_fee_id uuid, p_vendor_bill_id uuid, p_project_expense_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fee public.permit_fees%rowtype;
  v_app public.permit_applications%rowtype;
  v_application_id uuid;
  v_actor uuid;
  v_amount bigint;
  v_project uuid;
  v_company uuid;
  v_status text;
  v_payment public.permit_fee_payments%rowtype;
  v_lines integer;
  v_stray integer;
  v_lines_total numeric;
begin
  if num_nonnulls(p_vendor_bill_id, p_project_expense_id) <> 1 then
    raise exception 'Link one bill or one expense' using errcode = '22023';
  end if;
  select application_id, project_id into v_application_id, v_project from public.permit_fees where org_id = p_org_id and id = p_fee_id;
  if v_application_id is null then
    perform public.permit_service_actor(p_org_id, p_actor_id, null, array['permit.write', 'bill.write']);
    raise exception 'This home is outside your access' using errcode = '42501';
  end if;
  v_actor := public.permit_fee_actor(p_org_id, p_actor_id, v_project, p_project_expense_id);
  v_app := public.permit_lock_application(p_org_id, v_application_id);
  select * into v_fee from public.permit_fees where id = p_fee_id for update;
  if v_fee.status <> 'open' then
    raise exception 'A void fee is not paid' using errcode = '23514';
  end if;
  if p_vendor_bill_id is not null then
    select b.total_cents, b.project_id, b.company_id, b.status into v_amount, v_project, v_company, v_status
    from public.vendor_bills b where b.org_id = p_org_id and b.id = p_vendor_bill_id for update;
    select count(*), count(*) filter (where l.project_id is distinct from v_app.project_id),
           coalesce(sum(round(coalesce(l.quantity, 1) * coalesce(l.unit_cost_cents, 0))), 0)
      into v_lines, v_stray, v_lines_total
    from public.bill_lines l where l.org_id = p_org_id and l.bill_id = p_vendor_bill_id;
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
  if p_vendor_bill_id is not null and v_stray > 0 then
    raise exception 'The payable''s lines are coded to another home; a permit fee is job cost on its own home' using errcode = '23514';
  end if;
  if p_vendor_bill_id is not null and v_lines > 0 and v_lines_total <> v_amount then
    raise exception 'The payable''s lines do not add up to its total' using errcode = '23514';
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
  update public.permit_fees set pay_claim_until = null where id = v_fee.id;
  perform public.permit_record_change(p_org_id, v_actor, 'permit_fee', v_fee.id, 'update', 'permits.fee_payment_linked',
    'permit_fee.payment_linked', null, to_jsonb(v_payment),
    jsonb_build_object('project_id', v_app.project_id, 'application_id', v_app.id, 'vendor_bill_id', p_vendor_bill_id,
      'project_expense_id', p_project_expense_id, 'amount_cents', v_amount), v_app.id);
  return v_payment.id;
end;
$$;

revoke all on function public.link_permit_fee_payment(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.link_permit_fee_payment(uuid, uuid, uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Guards: the payables a fee reads, the evidence files, the community.
-- ---------------------------------------------------------------------------

-- Whether a payable pays a permit fee, and the home and total a linked bill is
-- held to. Definer, so the guards below can read the links without the caller's
-- row security and still run as the caller (current_user tells a signed-in
-- member from a definer path or the service role).
create or replace function public.permit_fee_link_terms(p_vendor_bill_id uuid, p_project_expense_id uuid)
returns table (linked boolean, project_id uuid, total_cents bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select true, coalesce(b.project_id, e.project_id), coalesce(b.total_cents, (e.amount_cents + e.tax_cents)::bigint)
  from public.permit_fee_payments p
  left join public.vendor_bills b on b.id = p.vendor_bill_id
  left join public.project_expenses e on e.id = p.project_expense_id
  where ((p_vendor_bill_id is not null and p.vendor_bill_id = p_vendor_bill_id)
     or (p_project_expense_id is not null and p.project_expense_id = p_project_expense_id))
    -- A signed-in member learns only about their own org's payables.
    and (coalesce((select auth.role()), '') <> 'authenticated' or public.is_org_member(p.org_id))
  limit 1
$$;

revoke all on function public.permit_fee_link_terms(uuid, uuid) from public, anon;
grant execute on function public.permit_fee_link_terms(uuid, uuid) to authenticated, service_role;

-- A payable linked to a permit fee keeps its amount, payee and home; and a
-- signed-in member moves its status and what was paid only with the authority
-- payables demands. Definer paths and the service role carry their own checks.
create or replace function public.guard_permit_fee_payables()
returns trigger
language plpgsql
set search_path = ''
as $$
declare v_linked boolean;
begin
  if tg_table_name = 'vendor_bills' then
    select coalesce((select t.linked from public.permit_fee_link_terms(old.id, null) t), false) into v_linked;
  else
    select coalesce((select t.linked from public.permit_fee_link_terms(null, old.id) t), false) into v_linked;
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
  if current_user <> 'authenticated' then
    return new;
  end if;
  if tg_table_name = 'vendor_bills' then
    if row(new.paid_cents, new.paid_at) is distinct from row(old.paid_cents, old.paid_at) then
      raise exception 'A payment is recorded in payables, not written onto a bill that pays a permit fee' using errcode = '42501';
    end if;
    if new.status is distinct from old.status then
      if new.status in ('paid', 'partial') then
        if not public.has_org_permission(new.org_id, 'payment.release') then
          raise exception 'Paying a bill that pays a permit fee needs payment.release' using errcode = '42501';
        end if;
      elsif new.status in ('approved', 'rejected') or old.status in ('approved', 'partial', 'paid', 'rejected') then
        if not public.has_org_permission(new.org_id, 'bill.approve') then
          raise exception 'Approving or rejecting a bill that pays a permit fee needs bill.approve' using errcode = '42501';
        end if;
      end if;
    end if;
  elsif new.status is distinct from old.status or new.approved_by_pm_user_id is distinct from old.approved_by_pm_user_id then
    if not public.has_org_permission(new.org_id, 'bill.approve') then
      raise exception 'Approving or rejecting an expense that pays a permit fee needs bill.approve' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

-- The job cost of a linked bill stays on the fee's home and keeps its amount.
create or replace function public.guard_permit_fee_bill_lines()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_terms record;
  v_lines numeric;
begin
  select t.linked, t.project_id, t.total_cents into v_terms from public.permit_fee_link_terms(new.bill_id, null) t;
  if not coalesce(v_terms.linked, false) then
    return new;
  end if;
  if new.project_id is distinct from v_terms.project_id then
    raise exception 'A permit fee is job cost on its own home' using errcode = '42501';
  end if;
  if current_user = 'authenticated' then
    if tg_op = 'UPDATE' and (new.quantity, new.unit_cost_cents) is distinct from (old.quantity, old.unit_cost_cents) then
      raise exception 'A bill that pays a permit fee keeps its line amounts' using errcode = '42501';
    end if;
    select coalesce(sum(round(coalesce(l.quantity, 1) * coalesce(l.unit_cost_cents, 0))), 0) into v_lines
    from public.bill_lines l where l.bill_id = new.bill_id and l.id is distinct from new.id;
    if v_lines + round(coalesce(new.quantity, 1) * coalesce(new.unit_cost_cents, 0)) > v_terms.total_cents then
      raise exception 'A bill that pays a permit fee cannot be coded for more than its total' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

-- A file a permit record cites is evidence: it is not deleted, archived, moved to
-- another home or swapped for other bytes while cited. A home's deletion carries
-- its files with it; otherwise detach or replace the file on the Permits page first.
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
  -- The home itself is being deleted: its files and permit records go together.
  if old.project_id is not null and not exists (select 1 from public.projects p where p.id = old.project_id) then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    raise exception 'This file is permit evidence and cannot be deleted while a permit application cites it; leave it in place' using errcode = '42501';
  end if;
  if (new.org_id, new.project_id, new.storage_path, new.checksum, new.size_bytes)
       is distinct from (old.org_id, old.project_id, old.storage_path, old.checksum, old.size_bytes)
     or (new.archived_at is not null and old.archived_at is null) then
    raise exception 'This file is permit evidence; it stays on its home as it is while a permit application cites it' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. The queue's facts in the home's own date; the start gate's reach.
-- ---------------------------------------------------------------------------

create or replace view public.permit_application_positions with (security_invoker = on) as
select
  a.id, a.org_id, a.project_id, a.lot_id, a.jurisdiction_company_id, a.permit_type, a.owner_user_id,
  a.permit_number, a.decision, a.decided_on, a.expires_on, a.superseded_at, a.created_at,
  l.community_id, c.division_id, l.lot_number, l.block, c.name as community_name,
  s.submission_count, s.last_submitted_on, s.expected_decision_on,
  r.open_rounds, r.unresolved_rounds, r.next_round_due_on,
  d.missing_submission_documents, d.missing_decision_documents,
  (select sp.target_week from public.start_packages sp
    where sp.org_id = a.org_id and sp.lot_id = a.lot_id and sp.status in ('open', 'ready')
    order by sp.created_at desc limit 1) as start_target_week,
  t.today_local,
  (coalesce(r.unresolved_rounds, 0) > 0 or s.expected_decision_on <= t.today_local + 3) as chase,
  (a.decision is null and a.superseded_at is null and coalesce(s.submission_count, 0) > 0
    and coalesce(r.open_rounds, 0) = 0 and s.expected_decision_on < t.today_local) as decision_overdue
from public.permit_applications a
left join public.lots l on l.org_id = a.org_id and l.id = a.lot_id
left join public.communities c on c.org_id = a.org_id and c.id = l.community_id
left join lateral (select public.permit_local_today(a.org_id, a.project_id) as today_local) t on true
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

revoke all on public.permit_application_positions from anon, authenticated;
grant select on public.permit_application_positions to authenticated, service_role;

-- Evidence the database computes itself, for the package's lot and home. A
-- signed-in member asks only about a package inside their division wall.
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
  v_today date;
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
  if coalesce((select auth.role()), '') = 'authenticated'
     and not (p_org_id = any (public.member_unscoped_org_ids()) or v_project_id in (select public.member_reachable_project_ids())) then
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
  v_today := public.permit_local_today(p_org_id, v_project_id);
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
        (a.decision = 'not_required' and v_authority_id is not null)
        or (
          a.decision = 'approved'
          and (a.expires_on is null or a.expires_on >= v_today)
          and a.house_plan_version_id = v_version_id
          and a.house_plan_elevation_id = v_elevation_id
          and exists (
            select 1 from public.files f
            where f.id = a.approved_plans_file_id and f.org_id = p_org_id and f.project_id = a.project_id and f.archived_at is null
              and a.approved_plans_file_id is distinct from a.issued_permit_file_id
          )
        )
      )
  );
end;
$$;

-- The release re-reads the permit gate in its own transaction: a permit revised
-- or expired between the readiness refresh and the queue stops it before any
-- release step has run.
create or replace function public.queue_start_release(p_org_id uuid, p_package_id uuid, p_actor_id uuid, p_scheduled_start_date date,
  p_target_week date, p_slot_target integer, p_confirm_over_slot boolean)
returns jsonb language plpgsql set search_path=public,pg_catalog as $$
declare v_pkg public.start_packages%rowtype; v_others integer; v_over boolean; v_job_id bigint;
  v_now timestamptz:=clock_timestamp(); v_after jsonb;
begin
  if p_scheduled_start_date is null or p_target_week is null or p_slot_target is null or p_slot_target<0
    or p_confirm_over_slot is null then raise exception 'Invalid starts release request'; end if;
  v_pkg:=public.lock_starts_release_control(p_org_id,p_package_id,p_actor_id);
  if v_pkg.status is distinct from 'ready' then raise exception 'The start package is not ready to release.' using errcode='40001'; end if;
  if v_pkg.project_id is null then raise exception 'The start package has no home to release.' using errcode='42501'; end if;
  if exists(select 1 from public.start_package_gates g join public.start_gate_definitions d on d.id=g.gate_definition_id and d.org_id=g.org_id
      where g.org_id=p_org_id and g.start_package_id=p_package_id and d.auto_source='permit_approved')
    and not public.start_gate_sql_evidence(p_org_id,p_package_id,'permit_approved') then
    raise exception 'The permit gate is no longer satisfied: the home''s permit changed. Refresh the package.' using errcode='40001'; end if;
  if exists(select 1 from public.outbox where org_id=p_org_id and job_type='start_release'
    and payload->>'start_package_id'=p_package_id::text and status in ('pending','processing')) then
    raise exception 'This start package is already being released.' using errcode='40001'; end if;
  perform pg_advisory_xact_lock(hashtextextended('start_release_week:'||p_org_id||':'||v_pkg.community_id||':'||p_target_week,0));
  select count(*) into v_others from public.start_packages where org_id=p_org_id and community_id=v_pkg.community_id
    and target_week=p_target_week and status in ('releasing','released') and id<>p_package_id;
  v_over:=v_others+1>p_slot_target;
  if v_over and not p_confirm_over_slot then
    return jsonb_build_object('queued',false,'target_week',p_target_week,'target',p_slot_target,'already_targeted',v_others);
  end if;
  update public.start_packages set status='releasing',scheduled_start_date=p_scheduled_start_date,target_week=p_target_week,
    released_by=p_actor_id,
    metadata=coalesce(metadata,'{}')||jsonb_build_object('release_requested_at',v_now,'release_lease_token',null,'release_lease_at',null)
    where org_id=p_org_id and id=p_package_id;
  insert into public.start_release_steps(org_id,start_package_id,step_key,status,completed_at,started_at,error)
    select p_org_id,p_package_id,step,case when step='project' then 'completed' else 'pending' end,
      case when step='project' then v_now end,null,null
    from unnest(array['project','budget','schedule','checklists','drawings','pos','notify_trades','finalize']) step
  on conflict (start_package_id,step_key) do update set status=excluded.status,completed_at=excluded.completed_at,started_at=null,error=null
    where public.start_release_steps.status not in ('completed','skipped');
  insert into public.outbox(org_id,job_type,payload,run_at,dedupe_key)
    values(p_org_id,'start_release',jsonb_build_object('start_package_id',p_package_id,'actor_id',p_actor_id),v_now,
      'start_release:start_package_id:'||p_package_id)
    returning id into v_job_id;
  v_after:=jsonb_build_object('status','releasing','scheduled_start_date',p_scheduled_start_date,'target_week',p_target_week,
    'job_id',v_job_id::text,'target',p_slot_target,'already_targeted',v_others,'over_slot',v_over,'actor_id',p_actor_id);
  insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,before_data,after_data,source)
    values(p_org_id,p_actor_id,'update','start_package',p_package_id,
      jsonb_build_object('status',v_pkg.status,'scheduled_start_date',v_pkg.scheduled_start_date,'target_week',v_pkg.target_week),
      v_after,'starts.release_queued');
  insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel)
    values(p_org_id,case when v_over then 'start.released_over_slot' else 'start.release_queued' end,'start_package',p_package_id,v_after,'activity');
  insert into public.outbox(org_id,job_type,payload) values(p_org_id,'reindex_search',jsonb_build_object('entity_type','start_package','entity_id',p_package_id));
  return jsonb_build_object('queued',true,'job_id',v_job_id::text,'over_slot',v_over,
    'target_week',p_target_week,'target',p_slot_target,'already_targeted',v_others);
end $$;
revoke all on function public.queue_start_release(uuid,uuid,uuid,date,date,integer,boolean) from public,anon,authenticated;
grant execute on function public.queue_start_release(uuid,uuid,uuid,date,date,integer,boolean) to service_role;
