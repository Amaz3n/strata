-- EP11-01 follow-up: a lot cannot be closed without its home (tg_lots_status_home_guard), so the import
-- records the home first and attaches the lot to it.

create or replace function public.import_installed_warranty_home(p_org_id uuid, p_actor_id uuid, p_batch_id uuid, p_row jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_community public.communities%rowtype; v_lot public.lots%rowtype; v_closing public.closings%rowtype;
 v_project uuid; v_buyer uuid; v_closing_id uuid; v_date date; v_lot_number text; v_block text; v_email text; v_created boolean:=false; v_lot_exists boolean;
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
 v_lot_exists:=found;
 v_email:=nullif(lower(btrim(p_row->>'buyer_email')),'');
 if v_email is not null then select id into v_buyer from public.contacts where org_id=p_org_id and lower(email)=v_email order by created_at limit 1; end if;
 if v_buyer is null then
   insert into public.contacts(org_id,full_name,email,contact_type,metadata) values(p_org_id,btrim(p_row->>'buyer_name'),v_email,'client',jsonb_build_object('installed_home_import_batch',p_batch_id)) returning id into v_buyer;
 end if;
 insert into public.projects(org_id,name,status,property_type,division_id,client_id,created_by,metadata)
   values(p_org_id,v_community.name||' — Lot '||v_lot_number,'completed','production',v_community.division_id,v_buyer,p_actor_id,jsonb_build_object('installed_home_import',true,'installed_home_import_batch',p_batch_id))
   returning id into v_project;
 -- A lot is closed only with its home attached, so the home exists first.
 if v_lot_exists then
   update public.lots set project_id=v_project, status='closed', metadata=metadata||jsonb_build_object('imported',true) where org_id=p_org_id and id=v_lot.id;
 else
   insert into public.lots(org_id,community_id,division_id,lot_number,block,address,status,project_id,metadata)
     values(p_org_id,v_community.id,v_community.division_id,v_lot_number,v_block,nullif(btrim(p_row->>'address'),''),'closed',v_project,jsonb_build_object('imported',true,'installed_home_import_batch',p_batch_id))
     returning * into v_lot;
 end if;
 v_closing_id:=gen_random_uuid();
 perform set_config('arc.installed_home_import', v_closing_id::text, true);
 insert into public.closings(id,org_id,project_id,lot_id,community_id,status,scheduled_date,actual_date,buyer_contact_id,created_by,metadata)
   values(v_closing_id,p_org_id,v_project,v_lot.id,v_community.id,'closed',v_date,v_date,v_buyer,p_actor_id,jsonb_build_object('installed_home_import','true','import_batch_id',p_batch_id,'books_posting_status','not_applicable'));
 perform set_config('arc.installed_home_import', '', true);
 v_created:=true;
 return jsonb_build_object('projectId',v_project,'closingId',v_closing_id,'lotId',v_lot.id,'created',v_created);
end $$;
revoke all on function public.import_installed_warranty_home(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.import_installed_warranty_home(uuid,uuid,uuid,jsonb) to service_role;
