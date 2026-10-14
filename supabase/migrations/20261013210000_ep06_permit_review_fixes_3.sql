-- EP06 review fixes, round 3 (permits).
--
--  1. A member cannot rewrite a lot's plan, plan version or elevation: the
--     permit gate compares the permit's reviewed plan with that pin. Changing
--     the pin takes lot.write, and is refused outright while the lot's home has
--     an approved building permit (a re-plan goes through a new permit
--     revision). Service-role and definer paths (instantiation, plan adoption,
--     agreement signing, imports) are unaffected.
--  2. A decision cannot be dated before its submission, a permit cannot be
--     issued in the future, and denying or withdrawing an application
--     withdraws its open and responded correction rounds.

create or replace function public.lot_home_has_approved_permit(p_org_id uuid, p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_project_id is not null
    and ((select auth.uid()) is null or public.has_org_permission(p_org_id, 'lot.write'))
    and exists (
    select 1 from public.permit_applications a
    where a.org_id = p_org_id and a.project_id = p_project_id and a.permit_type = 'building'
      and a.decision = 'approved' and a.superseded_at is null
  );
$$;

revoke all on function public.lot_home_has_approved_permit(uuid, uuid) from public, anon;
grant execute on function public.lot_home_has_approved_permit(uuid, uuid) to authenticated, service_role;

create or replace function public.tg_lots_member_write_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_old_base bigint;
  v_new_base bigint;
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.asking_price_override_cents is not null then
      raise exception 'A spec home''s asking price is set by a price move' using errcode = '42501';
    end if;
    if new.project_id is not null and not public.has_org_permission(new.org_id, 'lot.write') then
      raise exception 'Putting a home on lot % takes lot.write', new.lot_number using errcode = '42501';
    end if;
    return new;
  end if;
  -- The permit gate compares a home's reviewed plan with the lot's pin, so the
  -- pin is the lot steward's to move, and never under an approved permit: that
  -- is a new permit revision, not a re-pin.
  if (new.house_plan_id, new.house_plan_version_id, new.house_plan_elevation_id)
     is distinct from (old.house_plan_id, old.house_plan_version_id, old.house_plan_elevation_id) then
    if not public.has_org_permission(new.org_id, 'lot.write') then
      raise exception 'Changing lot %''s plan, version or elevation takes lot.write', old.lot_number using errcode = '42501';
    end if;
    if public.lot_home_has_approved_permit(old.org_id, old.project_id) then
      raise exception 'Lot % has a home with an approved building permit for its current plan: revise the permit instead of re-planning', old.lot_number
        using errcode = '42501';
    end if;
  end if;
  if new.asking_price_override_cents is distinct from old.asking_price_override_cents then
    raise exception 'A spec home''s asking price is set by a price move' using errcode = '42501';
  end if;
  -- The sheet that prices a home is its lot's community's.
  if new.community_id is distinct from old.community_id and coalesce(old.project_id, new.project_id) is not null then
    raise exception 'Lot % has a home: it stays in its community, whose price sheet prices the home', old.lot_number
      using errcode = '42501';
  end if;
  -- A home's asking price, unless it was repriced, is its plan's price on the
  -- sheet plus the lot premium (sellable_lot_inventory). A member moves it only
  -- through a price move, where the approval bands apply.
  if coalesce(old.project_id, new.project_id) is not null then
    if new.premium_cents is distinct from old.premium_cents then
      raise exception 'Lot % has a home: its premium is part of the home''s asking price. Reprice the home from the community''s offering instead.', old.lot_number
        using errcode = '42501';
    end if;
    if new.asking_price_override_cents is null
       and (new.house_plan_id, new.house_plan_elevation_id) is distinct from (old.house_plan_id, old.house_plan_elevation_id) then
      select a.base_price_cents into v_old_base
        from public.community_plan_availability a
       where a.org_id = old.org_id and a.community_id = old.community_id and a.house_plan_id = old.house_plan_id
         and a.is_available
         and (a.elevation_id is null or a.elevation_id = old.house_plan_elevation_id)
         and (a.effective_start is null or a.effective_start <= current_date)
         and (a.effective_end is null or a.effective_end >= current_date)
       order by (a.elevation_id is not null) desc
       limit 1;
      select a.base_price_cents into v_new_base
        from public.community_plan_availability a
       where a.org_id = new.org_id and a.community_id = new.community_id and a.house_plan_id = new.house_plan_id
         and a.is_available
         and (a.elevation_id is null or a.elevation_id = new.house_plan_elevation_id)
         and (a.effective_start is null or a.effective_start <= current_date)
         and (a.effective_end is null or a.effective_end >= current_date)
       order by (a.elevation_id is not null) desc
       limit 1;
      -- A home with no price yet takes its first one from its plan.
      if v_old_base is not null and v_new_base is distinct from v_old_base then
        raise exception 'Changing the plan of lot % would move its home''s asking price. Reprice the home from the community''s offering instead.', old.lot_number
          using errcode = '42501';
      end if;
    end if;
  end if;
  -- Out of started or closed, except forward to closed, is a reversal.
  if old.status in ('started', 'closed')
     and new.status is distinct from old.status
     and not (old.status = 'started' and new.status = 'closed')
     and not public.has_org_permission(new.org_id, 'community.write') then
    raise exception 'Moving a lot out of % is a reversal; it takes community.write and an explicit force confirmation', old.status
      using errcode = '42501';
  end if;
  -- A lot closes with its home's closing.
  if new.status = 'closed' and old.status is distinct from 'closed'
     and not public.has_org_permission(new.org_id, 'community.write')
     and not exists (
       select 1 from public.closings c
        where c.org_id = new.org_id and c.lot_id = new.id and c.status = 'closed'
     ) then
    raise exception 'Lot % closes when its home''s closing is recorded', old.lot_number using errcode = '42501';
  end if;
  -- The premium and plan are frozen only while a home stands on the lot, so
  -- taking the home off and putting it back is itself the lot steward's act:
  -- otherwise a member could detach, reprice and reattach.
  if new.project_id is distinct from old.project_id
     and not public.has_org_permission(new.org_id, 'lot.write') then
    raise exception 'Attaching a home to lot % or detaching it takes lot.write', old.lot_number using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_lots_member_write_guard() from public, anon, authenticated;

drop trigger if exists lots_member_write_guard on public.lots;
create trigger lots_member_write_guard
  before insert or update of asking_price_override_cents, status, premium_cents, house_plan_id, house_plan_version_id, house_plan_elevation_id, project_id, community_id on public.lots
  for each row execute function public.tg_lots_member_write_guard();

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
  v_last_submitted date;
begin
  perform public.permit_assert_open(v_app);
  if p_decision not in ('approved', 'denied', 'withdrawn', 'not_required') then
    raise exception 'Invalid permit decision' using errcode = '22023';
  end if;
  if p_decided_on is null or p_decided_on > v_today then
    raise exception 'A decision date cannot be in the future' using errcode = '23514';
  end if;
  select max(submitted_on) into v_last_submitted from public.permit_submissions where application_id = v_app.id;
  if v_last_submitted is not null and p_decided_on < v_last_submitted then
    raise exception 'A decision cannot be dated before the application was submitted (%)', v_last_submitted using errcode = '23514';
  end if;
  if p_issued_on is not null and p_issued_on > v_today then
    raise exception 'A permit cannot be issued in the future' using errcode = '23514';
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
    if not exists (
      select 1 from public.permit_application_documents d
      where d.application_id = v_app.id and d.document_kind = 'authority_letter' and d.file_id = p_issued_permit_file_id
    ) then
      raise exception 'File the authority''s letter on the application as its authority letter first' using errcode = '23514';
    end if;
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

  if p_decision in ('denied', 'withdrawn') then
    perform set_config('arc.permit_note', 'Closed with the application: ' || p_decision, true);
    update public.permit_correction_rounds set status = 'withdrawn'
    where application_id = v_app.id and status in ('open', 'responded');
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

revoke all on function public.record_permit_decision(uuid, uuid, text, date, text, date, date, uuid, uuid, text) from public, anon;
grant execute on function public.record_permit_decision(uuid, uuid, text, date, text, date, date, uuid, uuid, text) to authenticated, service_role;
