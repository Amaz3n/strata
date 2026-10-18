-- EP11 fix round. (1) The installed-home import matches a lot by the same normalized key staging uses
-- (case and whitespace folded, blank block = no block), so a re-import that differs only in case matches the
-- existing home instead of recording a second one. (2) Recovery reconciliation reads the request's whole
-- current state (every approved visit, every posted credit), whatever the entry date: reversing an
-- earlier-dated visit used to cut the later visits' cost and credits at its own date and take their
-- recoveries back with it. The entry date still says when the adjustment was made.

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
 select * into v_lot from public.lots where org_id=p_org_id and community_id=v_community.id
   and lower(regexp_replace(btrim(lot_number),'\s+',' ','g'))=lower(regexp_replace(v_lot_number,'\s+',' ','g'))
   and lower(regexp_replace(btrim(coalesce(block,'')),'\s+',' ','g'))=lower(regexp_replace(coalesce(v_block,''),'\s+',' ','g'))
   order by created_at,id limit 1 for update;
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

create or replace function public.reconcile_books_warranty_recovery(p_org_id uuid,p_request_id uuid,p_date date)
returns uuid language plpgsql security definer set search_path='' as $$
declare project uuid; reserve uuid; expense uuid; covered bigint; covered_on date; credited bigint; credited_on date; restored bigint; delta bigint; revision integer; policy integer; result_id uuid; dimensions jsonb; effective date;
begin
 select project_id into project from public.warranty_requests where org_id=p_org_id and id=p_request_id for update;
 if not found then raise exception 'Warranty request not found'; end if;
 perform 1 from public.project_financial_settings where org_id=p_org_id and project_id=project for update;
 select id into reserve from public.gl_accounts where org_id=p_org_id and code='2260' and active;
 select id into expense from public.gl_accounts where org_id=p_org_id and code='5050' and active;
 select coalesce(sum(books_reserve_consumed_cents),0), max(books_cost_date) into covered, covered_on from public.warranty_service_visits where org_id=p_org_id and request_id=p_request_id and books_cost_approved_at is not null;
 select c.credited_cents, c.credited_on into credited, credited_on from public.books_warranty_recovery_credited(p_org_id,p_request_id,'9999-12-31') c;
 select coalesce(sum(l.credit_cents-l.debit_cents),0) into restored from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id where l.org_id=p_org_id and l.account_id=reserve and l.dimensions->>'warranty_recovery_request_id'=p_request_id::text and e.status in('posted','reversed');
 delta:=least(covered,credited)-restored;
 if delta=0 then return null; end if;
 if reserve is null or expense is null then raise exception 'Warranty recovery accounts are missing'; end if;
 -- A recovery takes effect when the later of its cost approval and its credit did; taking one back, today.
 effective:=case when delta>0 then least(p_date,greatest(coalesce(covered_on,p_date),coalesce(credited_on,p_date))) else p_date end;
 select active_policy_version into policy from public.books_settings where org_id=p_org_id;
 select count(*)+1 into revision from public.journal_entries where org_id=p_org_id and source_type='warranty_reserve_recovery' and source_id=p_request_id;
 dimensions:=jsonb_build_object('warranty_reserve_adjustment',true,'warranty_recovery_request_id',p_request_id,'covered_cents',covered,'posted_recovery_cents',credited,'effective_on',effective);
 result_id:=public.post_books_journal_entry(p_org_id,jsonb_build_object('entry_date',p_date,'entry_kind','adjusting','memo','Reconcile reserve-backed warranty recovery','posting_key','warranty_recovery:'||p_request_id||':'||revision,'projection_version',1,'policy_version',policy,'source_type','warranty_reserve_recovery','source_id',p_request_id),
 jsonb_build_array(jsonb_build_object('line_no',1,'account_id',expense,'project_id',project,'debit_cents',greatest(delta,0),'credit_cents',greatest(-delta,0),'dimensions',dimensions),jsonb_build_object('line_no',2,'account_id',reserve,'project_id',project,'debit_cents',greatest(-delta,0),'credit_cents',greatest(delta,0),'dimensions',dimensions)));
 return result_id;
end;
$$;
revoke all on function public.reconcile_books_warranty_recovery(uuid,uuid,date) from public,anon,authenticated;
grant execute on function public.reconcile_books_warranty_recovery(uuid,uuid,date) to service_role;
