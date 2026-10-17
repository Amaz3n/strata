-- EP11-01: bring over homes that closed before Arc and are still under warranty.
--
-- A historical closing has no Arc invoice, settlement or readiness gates: the
-- sale happened elsewhere. The closing-evidence guard therefore lets ONE writer
-- record a closed closing without them: import_installed_warranty_home, which
-- names the closing it is inserting in `arc.installed_home_import` for its own
-- transaction (the same way reverse_books_home_closing names a reversal). No
-- invoice, no ledger entry, no outbox job and no reserve is created for these
-- homes; coverage is enrolled afterwards by the settlement path
-- (enrollSystemWarrantyCoverage) from the closing's actual date.

alter table public.import_batches drop constraint if exists import_batches_importer_check;
alter table public.import_batches add constraint import_batches_importer_check check (importer in (
  'cost_codes','plan_library','option_catalog','price_book','communities_lots','open_wip','team','warranty_homes'));
alter table public.import_mapping_profiles drop constraint if exists import_mapping_profiles_importer_check;
alter table public.import_mapping_profiles add constraint import_mapping_profiles_importer_check check (importer in (
  'cost_codes','plan_library','option_catalog','price_book','communities_lots','open_wip','team','warranty_homes'));

create or replace function public.guard_closing_settlement_evidence() returns trigger
language plpgsql security definer set search_path=public,pg_catalog as $$
declare gates integer;
begin
 if tg_op='DELETE' then
  if old.status in ('closed','cancelled') then raise exception 'Recorded closing history cannot be deleted'; end if;
  return old;
 end if;
 if tg_op='UPDATE' then
  if (new.id,new.org_id,new.project_id,new.lot_id,new.community_id) is distinct from (old.id,old.org_id,old.project_id,old.lot_id,old.community_id) then raise exception 'Closing home identity cannot change'; end if;
  -- The one change a recorded closing allows: its reversal, made only by
  -- reverse_books_home_closing (which sets arc.closing_reversal for this row).
  if old.status='closed' and new.status='cancelled' and current_setting('arc.closing_reversal', true)=old.id::text
   and (new.scheduled_date,new.actual_date,new.settlement,new.closing_invoice_id) is not distinct from (old.scheduled_date,old.actual_date,old.settlement,old.closing_invoice_id) then
   return new;
  end if;
  if old.status in ('closed','cancelled') and
   (new.status,new.scheduled_date,new.actual_date,new.settlement,new.closing_invoice_id,new.cancel_reason,new.metadata->'adjustments') is distinct from
   (old.status,old.scheduled_date,old.actual_date,old.settlement,old.closing_invoice_id,old.cancel_reason,old.metadata->'adjustments') then
   raise exception 'Recorded closing settlement evidence is immutable';
  end if;
 end if;
 if new.status='closed' and (tg_op='INSERT' or old.status<>'closed') then
  -- A home that closed before Arc: recorded only by import_installed_warranty_home.
  if tg_op='INSERT' and current_setting('arc.installed_home_import', true)=new.id::text and new.closing_invoice_id is null and new.metadata->>'installed_home_import'='true' then
   return new;
  end if;
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

-- One historical home: its lot, house, buyer and closed closing, in one
-- transaction. Matching is by the lot the row names, so a re-import (or a retry
-- after coverage enrollment failed) finds what is already there and creates
-- nothing twice.
create or replace function public.import_installed_warranty_home(p_org_id uuid, p_actor_id uuid, p_batch_id uuid, p_row jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_community public.communities%rowtype; v_lot public.lots%rowtype; v_closing public.closings%rowtype;
 v_project uuid; v_buyer uuid; v_closing_id uuid; v_date date; v_lot_number text; v_block text; v_email text; v_created boolean:=false;
begin
 v_date:=(p_row->>'closing_date')::date;
 v_lot_number:=nullif(btrim(p_row->>'lot_number'),''); v_block:=nullif(btrim(p_row->>'block'),'');
 if v_date is null or v_lot_number is null or nullif(btrim(p_row->>'buyer_name'),'') is null then raise exception 'Each installed home needs a lot, a buyer and its actual closing date'; end if;
 select * into v_community from public.communities where org_id=p_org_id and id=(p_row->>'community_id')::uuid for share;
 if not found then raise exception 'Community not found'; end if;
 select * into v_lot from public.lots where org_id=p_org_id and community_id=v_community.id and lot_number=v_lot_number and block is not distinct from v_block for update;
 if found and v_lot.project_id is not null then
   select * into v_closing from public.closings where org_id=p_org_id and project_id=v_lot.project_id and status='closed';
   if not found then raise exception 'Lot % already has a home that has not closed; record its closing in Arc instead', v_lot_number; end if;
   if v_closing.actual_date is distinct from v_date then raise exception 'Lot % closed on % in Arc, not %', v_lot_number, v_closing.actual_date, v_date; end if;
   return jsonb_build_object('projectId',v_lot.project_id,'closingId',v_closing.id,'lotId',v_lot.id,'created',false);
 end if;
 if found and v_lot.status='controlled' then raise exception 'Lot % is still controlled land; it cannot have a closed home', v_lot_number; end if;
 if not found then
   insert into public.lots(org_id,community_id,division_id,lot_number,block,address,status,metadata)
     values(p_org_id,v_community.id,v_community.division_id,v_lot_number,v_block,nullif(btrim(p_row->>'address'),''),'closed',jsonb_build_object('imported',true,'installed_home_import_batch',p_batch_id))
     returning * into v_lot;
 end if;
 v_email:=nullif(lower(btrim(p_row->>'buyer_email')),'');
 if v_email is not null then select id into v_buyer from public.contacts where org_id=p_org_id and lower(email)=v_email order by created_at limit 1; end if;
 if v_buyer is null then
   insert into public.contacts(org_id,full_name,email,contact_type,metadata) values(p_org_id,btrim(p_row->>'buyer_name'),v_email,'client',jsonb_build_object('installed_home_import_batch',p_batch_id)) returning id into v_buyer;
 end if;
 insert into public.projects(org_id,name,status,property_type,division_id,client_id,created_by,metadata)
   values(p_org_id,v_community.name||' — Lot '||v_lot_number,'completed','production',v_community.division_id,v_buyer,p_actor_id,jsonb_build_object('installed_home_import',true,'installed_home_import_batch',p_batch_id))
   returning id into v_project;
 v_closing_id:=gen_random_uuid();
 perform set_config('arc.installed_home_import', v_closing_id::text, true);
 insert into public.closings(id,org_id,project_id,lot_id,community_id,status,scheduled_date,actual_date,buyer_contact_id,created_by,metadata)
   values(v_closing_id,p_org_id,v_project,v_lot.id,v_community.id,'closed',v_date,v_date,v_buyer,p_actor_id,jsonb_build_object('installed_home_import','true','import_batch_id',p_batch_id,'books_posting_status','not_applicable'));
 perform set_config('arc.installed_home_import', '', true);
 update public.lots set project_id=v_project, status='closed', metadata=metadata||jsonb_build_object('imported',true) where org_id=p_org_id and id=v_lot.id;
 v_created:=true;
 return jsonb_build_object('projectId',v_project,'closingId',v_closing_id,'lotId',v_lot.id,'created',v_created);
end $$;
revoke all on function public.import_installed_warranty_home(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.import_installed_warranty_home(uuid,uuid,uuid,jsonb) to service_role;
