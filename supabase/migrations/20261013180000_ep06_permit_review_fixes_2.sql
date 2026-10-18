-- EP06 review fixes, round 2 (permits): the payables a fee reads are the ones
-- paying it created, and the permit gate stands only on known facts.
--
--  1. A payable is linked to a fee only by someone holding permit.write (bill.write
--     for a bill), never past another payer's live claim, and only while it is
--     still unapproved and unpaid, so reconciliation never reads a payable that
--     already carried its own paid facts. Whoever entered an expense no longer
--     links it by that alone.
--  2. The permit gate refuses a community with no permitting authority: a gate
--     cannot pass against an unknown jurisdiction.
--  3. "No permit required" stands on the authority's letter filed on the
--     application as its authority letter, then named by the decision.
--  4. A linked bill's lines cannot be deleted or moved off it by a member.
--  5. permit_local_today answers a member of the org only.
--  6. Reminder marks are merged into the row's metadata in one statement.

-- ---------------------------------------------------------------------------
-- 1. Home-local today: only for a member of the org (definer paths pass).
-- ---------------------------------------------------------------------------

create or replace function public.permit_local_today(p_org_id uuid, p_project_id uuid)
returns date
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if coalesce((select auth.role()), '') = 'authenticated' and not public.is_org_member(p_org_id) then
    raise exception 'This home is outside your access' using errcode = '42501';
  end if;
  return (now() at time zone public.selection_home_time_zone(p_org_id, p_project_id))::date;
end;
$$;

revoke all on function public.permit_local_today(uuid, uuid) from public, anon;
grant execute on function public.permit_local_today(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Fee payables: claimed, permitted and created for the fee.
-- ---------------------------------------------------------------------------

alter table public.permit_fees add column if not exists pay_claim_by uuid references public.app_users(id) on delete set null;
create index if not exists permit_fees_pay_claim_by_idx on public.permit_fees (pay_claim_by) where pay_claim_by is not null;

drop function if exists public.permit_fee_actor(uuid, uuid, uuid, uuid);

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
  update public.permit_fees
  set pay_claim_until = clock_timestamp() + interval '2 minutes', pay_claim_by = p_actor_id
  where id = v_fee.id;
  return v_remaining;
end;
$$;

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
  update public.permit_fees set pay_claim_until = null, pay_claim_by = null where org_id = p_org_id and id = p_fee_id;
end;
$$;

revoke all on function public.release_permit_fee_claim(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.release_permit_fee_claim(uuid, uuid, uuid) to service_role;

-- Link a payable to a fee: one entered for it (the payer's claim) or already
-- waiting in payables, but never one already approved or paid.
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
  v_paid bigint;
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
  v_actor := public.permit_service_actor(p_org_id, p_actor_id, v_project,
    case when p_vendor_bill_id is not null then array['permit.write', 'bill.write'] else array['permit.write'] end);
  v_app := public.permit_lock_application(p_org_id, v_application_id);
  select * into v_fee from public.permit_fees where id = p_fee_id for update;
  if v_fee.status <> 'open' then
    raise exception 'A void fee is not paid' using errcode = '23514';
  end if;
  if v_fee.pay_claim_until > clock_timestamp() and v_fee.pay_claim_by is distinct from v_actor then
    raise exception 'Someone is already recording a payment on this fee; reload in a moment' using errcode = '55P03';
  end if;
  if p_vendor_bill_id is not null then
    select b.total_cents, b.project_id, b.company_id, b.status, coalesce(b.paid_cents, 0)
      into v_amount, v_project, v_company, v_status, v_paid
    from public.vendor_bills b where b.org_id = p_org_id and b.id = p_vendor_bill_id for update;
    select count(*), count(*) filter (where l.project_id is distinct from v_app.project_id),
           coalesce(sum(round(coalesce(l.quantity, 1) * coalesce(l.unit_cost_cents, 0))), 0)
      into v_lines, v_stray, v_lines_total
    from public.bill_lines l where l.org_id = p_org_id and l.bill_id = p_vendor_bill_id;
  else
    select e.amount_cents + e.tax_cents, e.project_id, e.vendor_company_id, e.status, 0
      into v_amount, v_project, v_company, v_status, v_paid
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
  if v_paid > 0 or v_status not in (case when p_vendor_bill_id is not null then 'pending' else 'draft' end, 'submitted') then
    raise exception 'The payable is already approved or paid; a payment is recorded after it is linked' using errcode = '23514';
  end if;
  if public.permit_fee_linked_cents(v_fee.id) + v_amount > v_fee.amount_cents then
    raise exception 'The payable is more than what remains of the fee' using errcode = '23514';
  end if;
  insert into public.permit_fee_payments (org_id, project_id, fee_id, vendor_bill_id, project_expense_id, linked_by)
  values (p_org_id, v_app.project_id, v_fee.id, p_vendor_bill_id, p_project_expense_id, v_actor)
  returning * into v_payment;
  update public.permit_fees set pay_claim_until = null, pay_claim_by = null where id = v_fee.id;
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
-- 3. A linked bill keeps its lines: no member deletes them or moves them off.
-- ---------------------------------------------------------------------------

create or replace function public.guard_permit_fee_bill_lines()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_terms record;
  v_lines numeric;
begin
  if tg_op in ('UPDATE', 'DELETE') and current_user = 'authenticated'
     and (tg_op = 'DELETE' or new.bill_id is distinct from old.bill_id)
     and coalesce((select t.linked from public.permit_fee_link_terms(old.bill_id, null) t), false) then
    raise exception 'A bill that pays a permit fee keeps its lines' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
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

drop trigger if exists bill_lines_permit_fee_guard on public.bill_lines;
create trigger bill_lines_permit_fee_guard
  before insert or update or delete on public.bill_lines
  for each row execute function public.guard_permit_fee_bill_lines();

-- ---------------------------------------------------------------------------
-- 4. The decision and the gate.
-- ---------------------------------------------------------------------------

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
      and v_authority_id is not null and a.jurisdiction_company_id = v_authority_id
      and exists (
        select 1 from public.files f
        where f.id = a.issued_permit_file_id and f.org_id = p_org_id and f.project_id = a.project_id and f.archived_at is null
      )
      and (
        a.decision = 'not_required'
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

-- ---------------------------------------------------------------------------
-- 5. Reminder marks, merged in one statement.
-- ---------------------------------------------------------------------------

create or replace function public.mark_permit_reminder(p_entity text, p_org_id uuid, p_id uuid, p_key text, p_at timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_entity = 'permit_correction_round' then
    update public.permit_correction_rounds
    set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(p_key, p_at)
    where org_id = p_org_id and id = p_id;
  elsif p_entity = 'permit_application' then
    update public.permit_applications
    set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(p_key, p_at)
    where org_id = p_org_id and id = p_id;
  else
    raise exception 'Unknown reminder entity %', p_entity using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.mark_permit_reminder(text, uuid, uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.mark_permit_reminder(text, uuid, uuid, text, timestamptz) to service_role;
