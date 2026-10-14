-- EP06 review fixes for design studio sessions and buyer selection approvals:
-- the division wall reaches studio rooms and hours (and a session booked into
-- another division's studio), a Resend on an approval's signing envelope keeps
-- the request instead of voiding it, and an in-person approval's signed copy
-- must be the file uploaded for that approval. Re-runnable.

-- ---------------------------------------------------------------------------
-- 1. The division wall on rooms and consultant hours.
-- ---------------------------------------------------------------------------

drop policy if exists design_studio_rooms_division_scope on public.design_studio_rooms;
create policy design_studio_rooms_division_scope on public.design_studio_rooms
  as restrictive
  for all
  to authenticated
  using (
    exists (
      select 1 from public.design_studio_locations l
      where l.id = location_id
        and (
          l.division_id is null
          or l.org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
          or l.division_id in (select public.member_reachable_division_ids())
        )
    )
  )
  with check (
    exists (
      select 1 from public.design_studio_locations l
      where l.id = location_id
        and (
          l.division_id is null
          or l.org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
          or l.division_id in (select public.member_reachable_division_ids())
        )
    )
  );

drop policy if exists design_studio_consultant_hours_division_scope on public.design_studio_consultant_hours;
create policy design_studio_consultant_hours_division_scope on public.design_studio_consultant_hours
  as restrictive
  for all
  to authenticated
  using (
    exists (
      select 1 from public.design_studio_locations l
      where l.id = location_id
        and (
          l.division_id is null
          or l.org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
          or l.division_id in (select public.member_reachable_division_ids())
        )
    )
  )
  with check (
    exists (
      select 1 from public.design_studio_locations l
      where l.id = location_id
        and (
          l.division_id is null
          or l.org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
          or l.division_id in (select public.member_reachable_division_ids())
        )
    )
  );

-- The service role books too, so the wall is also a fact about the data: a
-- session sits in a studio of its home's division, or in an undivided studio.
create or replace function public.tg_design_studio_appointment_division_wall()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_studio_division uuid;
  v_home_division uuid;
begin
  if new.status <> 'scheduled' or new.location_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.location_id is not distinct from old.location_id and new.status is not distinct from old.status then
    return new;
  end if;
  select l.division_id into v_studio_division from public.design_studio_locations l where l.id = new.location_id and l.org_id = new.org_id;
  if v_studio_division is null then
    return new;
  end if;
  select p.division_id into v_home_division from public.projects p where p.id = new.project_id and p.org_id = new.org_id;
  if v_home_division is distinct from v_studio_division then
    raise exception 'That studio belongs to another division; choose one of this home''s division' using errcode = '23514', detail = 'DESIGN_STUDIO_DIVISION';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_design_studio_appointment_division_wall() from public, anon, authenticated;

drop trigger if exists design_studio_appointments_division_wall on public.design_studio_appointments;
create trigger design_studio_appointments_division_wall
  before insert or update on public.design_studio_appointments
  for each row execute function public.tg_design_studio_appointment_division_wall();

-- ---------------------------------------------------------------------------
-- 2. Resend on an approval's signing envelope reissues it, keeping the request.
--    resend_esign_envelope cancels the envelope and sends a replacement in one
--    transaction; the request follows the replacement. Whether a voided envelope
--    was a resend is not read from the reason someone typed: at commit, a request
--    still pointing at an envelope that is voided had no replacement take it over,
--    so it is voided with it.
-- ---------------------------------------------------------------------------

create or replace function public.tg_envelope_selection_approval_outcome()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text := nullif(btrim(new.metadata->>'void_reason'), '');
begin
  if new.status = 'expired' then
    update public.selection_approvals set status = 'expired', expired_at = now()
      where id = new.source_entity_id and org_id = new.org_id and envelope_id = new.id and status = 'sent';
  elsif new.metadata->>'declined_by_request_id' is not null then
    update public.selection_approvals set status = 'declined', declined_at = now(), decline_reason = v_reason
      where id = new.source_entity_id and org_id = new.org_id and envelope_id = new.id and status = 'sent';
  end if;
  return null;
end;
$$;

revoke all on function public.tg_envelope_selection_approval_outcome() from public, anon, authenticated;

create or replace function public.tg_envelope_selection_approval_void_settled()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.selection_approvals
    set status = 'voided', voided_at = now(),
        void_reason = coalesce(nullif(btrim(new.metadata->>'void_reason'), ''), 'The signing request was voided')
    where id = new.source_entity_id and org_id = new.org_id and envelope_id = new.id and status = 'sent';
  return null;
end;
$$;

revoke all on function public.tg_envelope_selection_approval_void_settled() from public, anon, authenticated;

drop trigger if exists envelopes_selection_approval_void_settled on public.envelopes;
create constraint trigger envelopes_selection_approval_void_settled
  after update of status on public.envelopes
  deferrable initially deferred
  for each row
  when (new.source_entity_type = 'selection_approval' and new.status = 'voided' and old.status is distinct from new.status)
  execute function public.tg_envelope_selection_approval_void_settled();

create or replace function public.tg_envelope_selection_approval_send()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_approval public.selection_approvals;
  v_replaces boolean;
begin
  select * into v_approval from public.selection_approvals where id = new.source_entity_id and org_id = new.org_id for update;
  if not found or v_approval.status <> 'sent' or v_approval.channel <> 'esign' then
    raise exception 'This signing document does not carry a request still waiting on the buyer' using errcode = '42501';
  end if;
  v_replaces := v_approval.document_id is distinct from new.document_id;
  if v_replaces and not (
    v_approval.envelope_id is not null
    and new.metadata->>'resend_of_envelope_id' = v_approval.envelope_id::text
    and exists (select 1 from public.envelopes o where o.id = v_approval.envelope_id and o.org_id = new.org_id and o.status = 'voided')
  ) then
    raise exception 'This signing document does not carry a request still waiting on the buyer' using errcode = '42501';
  end if;
  new.metadata := coalesce(new.metadata, '{}'::jsonb)
    || jsonb_build_object('selection_approval_id', v_approval.id, 'selection_terms_hash', v_approval.terms_hash);
  if v_replaces then
    update public.selection_approvals set envelope_id = new.id, document_id = new.document_id where id = v_approval.id;
  end if;
  return new;
end;
$$;

revoke all on function public.tg_envelope_selection_approval_send() from public, anon, authenticated;

-- The one change to the document a request was sent on: its own resend.
create or replace function public.tg_selection_approval_lifecycle()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    -- The home (or the org) went away and took its approvals with it.
    if pg_trigger_depth() > 1 and (
      not exists (select 1 from public.projects p where p.id = old.project_id)
      or not exists (select 1 from public.orgs o where o.id = old.org_id)
    ) then
      return old;
    end if;
    raise exception 'A selection approval is a record and is never deleted' using errcode = '42501';
  end if;
  if row(new.org_id, new.project_id, new.group_id, new.channel, new.terms_hash, new.total_cents, new.sent_by, new.sent_at, new.expires_at)
     is distinct from row(old.org_id, old.project_id, old.group_id, old.channel, old.terms_hash, old.total_cents, old.sent_by, old.sent_at, old.expires_at) then
    raise exception 'What a buyer was asked to approve never changes; void the request and send the selections again' using errcode = '42501';
  end if;
  if new.status is distinct from old.status
     and not (old.status = 'sent' and new.status in ('approved', 'declined', 'expired', 'voided'))
     and not (old.status = 'approved' and new.status = 'voided') then
    raise exception 'A % selection approval cannot become %', old.status, new.status using errcode = '23514';
  end if;
  if (old.envelope_id is not null and new.envelope_id is distinct from old.envelope_id)
     or (old.document_id is not null and new.document_id is distinct from old.document_id) then
    if not (
      old.status = 'sent' and new.status = 'sent' and old.channel = 'esign'
      and new.envelope_id is not null
      and exists (
        select 1 from public.envelopes oe
        where oe.id = old.envelope_id and oe.org_id = old.org_id and oe.status = 'voided'
      )
      and exists (
        select 1 from public.envelopes ne
        where ne.id = new.envelope_id and ne.org_id = new.org_id and ne.document_id = new.document_id
          and ne.source_entity_id = new.id and ne.metadata->>'resend_of_envelope_id' = old.envelope_id::text
      )
    ) then
      raise exception 'A selection approval keeps the document it was sent on' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.tg_selection_approval_lifecycle() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. An in-person approval's signed copy is the file uploaded for it: a recent
--    contracts-category PDF or image the recording coordinator uploaded, never
--    already the evidence of another approval.
-- ---------------------------------------------------------------------------

create or replace function public.approve_selection_terms(
  p_org_id uuid, p_project_id uuid, p_group_id uuid, p_channel text, p_terms_hash text,
  p_contact_id uuid default null, p_user_id uuid default null, p_signed_copy_file_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_terms jsonb;
  v_pending public.selection_approvals;
  v_approval public.selection_approvals;
begin
  if p_channel = 'portal' then
    if p_contact_id is null then
      raise exception 'A portal approval names the buyer who gave it' using errcode = '22023';
    end if;
  elsif p_channel = 'in_person' then
    if p_user_id is null or p_signed_copy_file_id is null then
      raise exception 'An in-person approval needs the buyer''s signed copy filed on the home' using errcode = '22023', detail = 'SELECTION_SIGNED_COPY_REQUIRED';
    end if;
    if not exists (
      select 1 from public.files f
      where f.id = p_signed_copy_file_id and f.org_id = p_org_id and f.project_id = p_project_id and f.archived_at is null
        and f.category = 'contracts'
        and (f.mime_type = 'application/pdf' or f.mime_type like 'image/%')
        and f.uploaded_by is not distinct from p_user_id
        and f.created_at > now() - interval '1 hour'
        and coalesce(f.source, '') <> 'generated'
    ) or exists (
      select 1 from public.selection_approvals a
      where a.signed_copy_file_id = p_signed_copy_file_id or a.executed_file_id = p_signed_copy_file_id
    ) then
      raise exception 'Attach the buyer''s signed copy as a new upload (a PDF or photo) filed with this approval' using errcode = '23514', detail = 'SELECTION_SIGNED_COPY_REQUIRED';
    end if;
  else
    raise exception 'E-signed approvals are recorded by the signing document' using errcode = '22023';
  end if;
  if not exists (select 1 from public.projects where id = p_project_id and org_id = p_org_id) then
    raise exception 'Home not found' using errcode = 'P0002';
  end if;
  perform public.lock_project_selections(p_org_id, p_project_id);
  v_terms := public.assert_selection_terms_approvable(p_org_id, p_project_id, p_group_id, p_terms_hash);

  select * into v_pending from public.selection_approvals a
  where a.org_id = p_org_id and a.project_id = p_project_id and a.group_id is not distinct from p_group_id and a.status = 'sent'
  for update;
  if found then
    if v_pending.channel = 'esign' then
      raise exception 'These selections are out for e-signature; sign the document, or void it first' using errcode = '23505', detail = 'SELECTION_APPROVAL_PENDING';
    end if;
    if v_pending.channel <> p_channel then
      raise exception 'A request to approve these selections is already out; void it first' using errcode = '23505', detail = 'SELECTION_APPROVAL_PENDING';
    end if;
    if v_pending.terms_hash is distinct from p_terms_hash then
      raise exception 'These selections changed since they were shown; review them and try again' using errcode = '40001', detail = 'SELECTION_TERMS_CHANGED';
    end if;
    v_approval := v_pending;
  else
    v_approval := public.insert_selection_approval(p_org_id, p_project_id, p_group_id, p_channel, 'sent', v_terms, p_user_id, null);
  end if;

  return to_jsonb(public.confirm_selection_approval(v_approval.id, now(), jsonb_build_object(
    'contact_id', p_contact_id, 'user_id', p_user_id, 'signed_copy_file_id', p_signed_copy_file_id
  )));
end;
$$;

revoke all on function public.approve_selection_terms(uuid, uuid, uuid, text, text, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.approve_selection_terms(uuid, uuid, uuid, text, text, uuid, uuid, uuid) to service_role;
