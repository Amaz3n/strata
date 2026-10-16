-- EP08 review round 1 (W-D): the lock guarded edits to an issued purchase order but not the way
-- in, and left holes beside its terms.
--
-- 1. A member could INSERT a purchase order as approved, or move a draft to approved (or an
--    approved order to complete) through the data API, skipping approval bands, prequalification
--    and separation of duties and minting a vendor-visible issue. An order enters an issued
--    status only through the service (updateCommitment / executeCommitment / the starts and
--    generation definer paths), none of which run as the authenticated role.
-- 2. The lock now also covers the generation provenance in an order's and a line's metadata
--    (source, source_ref, source_generation_run_id, created_by_user_id, imported_open_wip,
--    source_agreement_ids), a line's needed_by (written by the receiving service) and a line's
--    sort_order (it is inside the hashed terms, so a member's reorder made the vendor's answer
--    stale with no new version).
-- 3. Issue, acknowledgment and receipt history is never destroyed by a member: deleting an
--    order that has any of it is refused, receipts and shortages no longer cascade from a
--    direct delete of their order, and an order with recorded receipts cannot be returned to
--    draft or cancelled by anyone.
-- 4. An open-WIP imported order is history, not a new issue: its version is a backfill, which
--    queues no vendor email and asks nothing of the vendor.

create or replace function public.po_locked_metadata(p_metadata jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
  from jsonb_each(coalesce(p_metadata, '{}'::jsonb)) e
  where e.key in ('source', 'source_ref', 'source_kind', 'source_id', 'source_generation_run_id',
    'source_agreement_id', 'source_agreement_ids', 'created_by_user_id', 'imported_open_wip');
$$;

grant execute on function public.po_locked_metadata(jsonb) to authenticated, service_role;

-- Row security hides issue, answer and receipt rows from a member, so the existence check is the definer's.
create or replace function public.po_has_history(p_commitment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.po_issue_versions v where v.commitment_id = p_commitment_id)
    or exists (select 1 from public.po_acknowledgments a where a.commitment_id = p_commitment_id)
    or exists (select 1 from public.po_receipts r where r.commitment_id = p_commitment_id);
$$;

revoke all on function public.po_has_history(uuid) from public, anon;
grant execute on function public.po_has_history(uuid) to authenticated, service_role;

create or replace function public.tg_po_issued_lock()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_parent_id uuid;
  v_type text;
  v_status text;
begin
  if current_user <> 'authenticated' then
    return coalesce(new, old);
  end if;

  if tg_table_name = 'commitments' then
    if tg_op = 'INSERT' then
      if new.commitment_type = 'purchase_order' and public.po_status_is_issued(new.status) then
        raise exception 'A purchase order is issued by approving it, not by inserting it as approved' using errcode = '42501';
      end if;
      return new;
    end if;

    if tg_op = 'DELETE' then
      if old.commitment_type = 'purchase_order' and public.po_has_history(old.id) then
        raise exception 'A purchase order that was issued keeps its history and cannot be deleted' using errcode = '42501';
      end if;
      if old.commitment_type = 'purchase_order' and public.po_status_is_issued(old.status) then
        raise exception 'An approved purchase order cannot be deleted; return it to draft first' using errcode = '42501';
      end if;
      return old;
    end if;

    if new.commitment_type = 'purchase_order' and public.po_status_is_issued(new.status)
       and not (old.commitment_type = 'purchase_order' and old.status is not distinct from new.status) then
      raise exception 'A purchase order is issued by approving it, which a member does through the approval service' using errcode = '42501';
    end if;

    if old.commitment_type <> 'purchase_order' or not public.po_status_is_issued(old.status) then
      return new;
    end if;
    if row(new.org_id, new.project_id, new.company_id, new.contact_id, new.commitment_type, new.title, new.scope, new.terms,
           new.total_cents, new.currency, new.contract_number, new.retainage_percent, new.start_date, new.end_date, new.issued_at,
           public.po_locked_metadata(new.metadata))
       is distinct from
       row(old.org_id, old.project_id, old.company_id, old.contact_id, old.commitment_type, old.title, old.scope, old.terms,
           old.total_cents, old.currency, old.contract_number, old.retainage_percent, old.start_date, old.end_date, old.issued_at,
           public.po_locked_metadata(old.metadata)) then
      raise exception 'An approved purchase order is locked: raise a variance order to change it, or return it to draft' using errcode = '42501';
    end if;
    if not public.po_status_is_issued(new.status) then
      raise exception 'An approved purchase order is returned to draft or cancelled from the purchase order, not by editing its row' using errcode = '42501';
    end if;
    return new;
  end if;

  -- commitment_lines: the order the line is on, before and after the change.
  for v_parent_id in
    select distinct x from unnest(array[
      case when tg_op <> 'INSERT' then old.commitment_id end,
      case when tg_op <> 'DELETE' then new.commitment_id end
    ]) x where x is not null
  loop
    select c.commitment_type, c.status into v_type, v_status from public.commitments c where c.id = v_parent_id;
    if v_type = 'purchase_order' and public.po_status_is_issued(v_status) then
      if tg_op = 'UPDATE'
         and row(new.org_id, new.commitment_id, new.cost_code_id, new.budget_line_id, new.description, new.quantity, new.unit,
                 new.unit_cost_cents, new.scheduled_value_cents, new.retainage_percent, new.needed_by, new.sort_order,
                 public.po_locked_metadata(new.metadata))
             is not distinct from
             row(old.org_id, old.commitment_id, old.cost_code_id, old.budget_line_id, old.description, old.quantity, old.unit,
                 old.unit_cost_cents, old.scheduled_value_cents, old.retainage_percent, old.needed_by, old.sort_order,
                 public.po_locked_metadata(old.metadata)) then
        continue;
      end if;
      raise exception 'The lines of an approved purchase order are locked: raise a variance order to change them, or return it to draft' using errcode = '42501';
    end if;
  end loop;
  return coalesce(new, old);
end;
$$;

revoke all on function public.tg_po_issued_lock() from public, anon, authenticated;

drop trigger if exists commitments_po_issued_lock on public.commitments;
create trigger commitments_po_issued_lock
  before insert or update or delete on public.commitments
  for each row execute function public.tg_po_issued_lock();

-- An order with recorded receipts is not un-issued by anyone: the goods arrived against it.
create or replace function public.tg_po_unissue_needs_no_receipts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.commitment_type = 'purchase_order' and public.po_status_is_issued(old.status) and not public.po_status_is_issued(new.status)
     and exists (select 1 from public.po_receipts r where r.commitment_id = new.id and r.status <> 'void') then
    raise exception 'This purchase order has deliveries received against it, so it cannot be returned to draft or cancelled. Raise a variance order instead' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_po_unissue_needs_no_receipts() from public, anon, authenticated;

drop trigger if exists commitments_po_unissue_receipts on public.commitments;
create trigger commitments_po_unissue_receipts
  before update of status on public.commitments
  for each row execute function public.tg_po_unissue_needs_no_receipts();

-- Delivery history does not follow a direct delete of its order.
alter table public.po_receipts drop constraint if exists po_receipts_commitment_id_fkey;
alter table public.po_receipts add constraint po_receipts_commitment_id_fkey
  foreign key (commitment_id) references public.commitments(id);
alter table public.po_receipt_lines drop constraint if exists po_receipt_lines_commitment_id_fkey;
alter table public.po_receipt_lines add constraint po_receipt_lines_commitment_id_fkey
  foreign key (commitment_id) references public.commitments(id);
alter table public.po_shortages drop constraint if exists po_shortages_commitment_id_fkey;
alter table public.po_shortages add constraint po_shortages_commitment_id_fkey
  foreign key (commitment_id) references public.commitments(id);

-- An imported open-WIP order is a backfill version: no vendor email, no request to answer.
create or replace function public.record_po_issue_version(p_org_id uuid, p_commitment_id uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_commitment public.commitments%rowtype;
  v_snapshot jsonb;
  v_revision integer;
  v_id uuid;
  v_actor uuid := (select auth.uid());
begin
  select * into v_commitment from public.commitments
  where id = p_commitment_id and org_id = p_org_id and commitment_type = 'purchase_order'
  for update;
  if not found then
    return null;
  end if;
  v_snapshot := public.po_issue_snapshot(p_org_id, p_commitment_id);
  select coalesce(max(revision), 0) + 1 into v_revision from public.po_issue_versions where commitment_id = p_commitment_id;
  insert into public.po_issue_versions(org_id, project_id, commitment_id, company_id, revision, terms_hash, snapshot, reason, created_by)
  values (p_org_id, v_commitment.project_id, p_commitment_id, v_commitment.company_id, v_revision,
    encode(sha256(convert_to(v_snapshot::text, 'UTF8')), 'hex'), v_snapshot, p_reason,
    (select u.id from public.app_users u where u.id = v_actor))
  returning id into v_id;

  insert into public.audit_log(org_id, actor_user_id, action, entity_type, entity_id, after_data, source)
  values (p_org_id, (select u.id from public.app_users u where u.id = v_actor), 'insert', 'po_issue_version', v_id,
    jsonb_build_object('commitment_id', p_commitment_id, 'project_id', v_commitment.project_id, 'revision', v_revision, 'reason', p_reason),
    'po.issue');
  insert into public.events(org_id, event_type, entity_type, entity_id, payload, channel)
  values (p_org_id, 'po_issue_version.created', 'po_issue_version', v_id,
    jsonb_build_object('commitment_id', p_commitment_id, 'project_id', v_commitment.project_id, 'revision', v_revision, 'reason', p_reason),
    'activity');

  if v_commitment.company_id is not null and p_reason <> 'backfill' then
    insert into public.outbox(org_id, job_type, dedupe_key, payload)
    values (p_org_id, 'po_issue_notice', 'po_issue_notice:' || v_id::text,
      jsonb_build_object('version_id', v_id, 'commitment_id', p_commitment_id, 'project_id', v_commitment.project_id,
        'company_id', v_commitment.company_id, 'revision', v_revision, 'reason', p_reason, 'actor_id', v_actor))
    on conflict do nothing;
  end if;
  return v_id;
end;
$$;

revoke all on function public.record_po_issue_version(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.record_po_issue_version(uuid, uuid, text) to service_role;

create or replace function public.tg_po_issue_on_commitment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.commitment_type <> 'purchase_order' or not public.po_status_is_issued(new.status) then
    return null;
  end if;
  if tg_op = 'UPDATE' and public.po_status_is_issued(old.status) then
    return null;
  end if;
  perform public.record_po_issue_version(new.org_id, new.id,
    case when new.metadata->>'imported_open_wip' = 'true' and not exists (select 1 from public.po_issue_versions v where v.commitment_id = new.id) then 'backfill'
         when exists (select 1 from public.po_issue_versions v where v.commitment_id = new.id) then 'reapproved'
         else 'approved' end);
  return null;
end;
$$;

revoke all on function public.tg_po_issue_on_commitment() from public, anon, authenticated;
