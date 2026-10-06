-- Staged/unapplied. Preserve settled evidence and serialize checklist edits
-- through their parent closing. Full permission and monetary commit fencing
-- remains a separate cutover requirement.
create function public.guard_closing_checklist_evidence() returns trigger
language plpgsql security definer set search_path=public,pg_catalog as $$
declare parent public.closings; item public.closing_checklist_items;
begin
 if tg_op='UPDATE' and (new.id,new.org_id,new.closing_id) is distinct from (old.id,old.org_id,old.closing_id) then
  raise exception 'Closing checklist identity cannot change';
 end if;
 if tg_op='DELETE' then item:=old; else item:=new; end if;
 select * into parent from public.closings where id=item.closing_id and org_id=item.org_id for update;
 if not found then
  -- An allowed deletion of an unfinished parent cascades after the parent row
  -- is gone. A recorded parent is already protected by its own DELETE guard.
  if tg_op='DELETE' and pg_trigger_depth()>1 and not exists(select 1 from public.closings where id=item.closing_id) then return old; end if;
  raise exception 'Closing checklist parent scope is invalid';
 end if;
 if parent.status in ('closed','cancelled') then raise exception 'Closed or cancelled checklist evidence is immutable'; end if;
 if tg_op='DELETE' then return old; end if;
 if item.status<>'open' and (item.completed_by is null or item.completed_at is null) then raise exception 'Closing completion attribution is required'; end if;
 if item.status='waived' and length(btrim(coalesce(item.notes,'')))<10 then raise exception 'Closing waiver reason must be documented'; end if;
 if item.file_id is not null then
  perform 1 from public.files where id=item.file_id and org_id=item.org_id and project_id=parent.project_id and archived_at is null for share;
  if not found then raise exception 'Closing evidence file is unavailable or belongs to another home'; end if;
 end if;
 return new;
end $$;
create trigger closing_checklist_evidence_guard before insert or update or delete on public.closing_checklist_items
 for each row execute function public.guard_closing_checklist_evidence();

create function public.guard_closing_settlement_evidence() returns trigger
language plpgsql security definer set search_path=public,pg_catalog as $$
declare gates integer;
begin
 if tg_op='DELETE' then
  if old.status in ('closed','cancelled') then raise exception 'Recorded closing history cannot be deleted'; end if;
  return old;
 end if;
 if tg_op='UPDATE' then
  if (new.id,new.org_id,new.project_id,new.lot_id,new.community_id) is distinct from (old.id,old.org_id,old.project_id,old.lot_id,old.community_id) then raise exception 'Closing home identity cannot change'; end if;
  if old.status in ('closed','cancelled') and
   (new.status,new.scheduled_date,new.actual_date,new.settlement,new.closing_invoice_id,new.cancel_reason,new.metadata->'adjustments') is distinct from
   (old.status,old.scheduled_date,old.actual_date,old.settlement,old.closing_invoice_id,old.cancel_reason,old.metadata->'adjustments') then
   raise exception 'Recorded closing settlement evidence is immutable';
  end if;
 end if;
 if new.status='closed' and (tg_op='INSERT' or old.status<>'closed') then
  if new.closing_invoice_id is null then raise exception 'Closing invoice evidence is required'; end if;
  if jsonb_typeof(new.settlement->'finalPriceCents') is distinct from 'number' or coalesce(new.settlement->>'finalPriceCents','')!~'^[0-9]+$' then raise exception 'Recorded final price cents are invalid'; end if;
  if (new.settlement->>'finalPriceCents')::numeric>9007199254740991 then raise exception 'Recorded final price exceeds safe integer cents'; end if;
  perform 1 from public.invoices where id=new.closing_invoice_id and org_id=new.org_id and project_id=new.project_id and total_cents=(new.settlement->>'finalPriceCents')::numeric for share;
  if not found then raise exception 'Closing invoice belongs to another home, is unavailable or differs from the settlement'; end if;
  perform 1 from public.files f where exists(select 1 from public.closing_checklist_items i
    where i.closing_id=new.id and i.org_id=new.org_id and i.is_gate and i.file_id=f.id) order by f.id for share;
  select count(*) into gates from public.closing_checklist_items where closing_id=new.id and org_id=new.org_id and is_gate;
  if gates=0 then raise exception 'Closing readiness gates are missing'; end if;
  -- No child row locks: checklist writers take the parent lock and either
  -- commit before this read or fail after the parent becomes closed.
  if exists(select 1 from public.closing_checklist_items i where i.closing_id=new.id and i.org_id=new.org_id and i.is_gate and
   (i.status='open' or i.completed_by is null or i.completed_at is null or (i.status='waived' and length(btrim(coalesce(i.notes,'')))<10) or
    (i.file_id is not null and not exists(select 1 from public.files f where f.id=i.file_id and f.org_id=new.org_id and f.project_id=new.project_id and f.archived_at is null)))) then
   raise exception 'Closing readiness gate evidence is incomplete';
  end if;
 end if;
 return new;
end $$;
create trigger closing_settlement_evidence_guard before insert or update or delete on public.closings
 for each row execute function public.guard_closing_settlement_evidence();

-- Preserve source home identity after the closing is recorded. Plain parent
-- reads avoid inverting the closing->file/invoice lock order.
create function public.guard_recorded_closing_sources() returns trigger
language plpgsql security definer set search_path=public,pg_catalog as $$
declare protected boolean;
begin
 if tg_table_name='files' then
  select exists(select 1 from public.closing_checklist_items i join public.closings c on c.id=i.closing_id and c.org_id=i.org_id
    where i.file_id=old.id and c.status in ('closed','cancelled')) into protected;
 else
  select exists(select 1 from public.closings c where c.closing_invoice_id=old.id and c.status in ('closed','cancelled')) into protected;
 end if;
 if protected then
  if tg_op='DELETE' then raise exception 'Recorded closing source cannot be deleted'; end if;
  if (new.id,new.org_id,new.project_id) is distinct from (old.id,old.org_id,old.project_id) then raise exception 'Recorded closing source home cannot change'; end if;
  if tg_table_name='files' and (to_jsonb(new)->'archived_at') is distinct from (to_jsonb(old)->'archived_at') then raise exception 'Recorded closing evidence cannot be archived'; end if;
  if tg_table_name='invoices' and (to_jsonb(new)->'total_cents') is distinct from (to_jsonb(old)->'total_cents') then raise exception 'Recorded closing invoice amount cannot change'; end if;
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
create trigger recorded_closing_file_guard before update or delete on public.files for each row execute function public.guard_recorded_closing_sources();
create trigger recorded_closing_invoice_guard before update or delete on public.invoices for each row execute function public.guard_recorded_closing_sources();
