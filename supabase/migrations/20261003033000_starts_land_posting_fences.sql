-- STAGED, UNAPPLIED. Starts workers may post only their home's land transfer.
-- Ordinary Books callers retain existing policies and journal constraints.
create function public.fence_starts_land_posting_write() returns trigger
language plpgsql set search_path=public,pg_catalog as $$
declare v_headers jsonb; v_pkg public.start_packages%rowtype; v_rows jsonb[]; v_row jsonb;
 v_entry public.journal_entries%rowtype; v_actor uuid; v_code text;
begin
 v_headers:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
 if v_headers->>'x-starts-job-id' is null and v_headers->>'x-starts-claim-token' is null then
   if tg_op='DELETE' then return old; end if; return new;
 end if;
 if current_user in ('anon','authenticated') then raise exception 'Browser cannot use starts worker headers' using errcode='42501'; end if;
 if tg_op='INSERT' then v_rows:=array[to_jsonb(new)];
 elsif tg_op='DELETE' then v_rows:=array[to_jsonb(old)];
 else v_rows:=array[to_jsonb(old),to_jsonb(new)]; end if;
 v_pkg:=public.lock_starts_release_write_scope((v_rows[1]->>'org_id')::uuid);
 select (payload->>'actor_id')::uuid into v_actor from public.outbox where id=(v_headers->>'x-starts-job-id')::bigint;
 if v_actor is null then raise exception 'Starts posting actor missing' using errcode='42501'; end if;
 foreach v_row in array v_rows loop
   if (v_row->>'org_id')::uuid is distinct from v_pkg.org_id then raise exception 'Starts posting organization mismatch' using errcode='42501'; end if;
   if tg_table_name='journal_entries' then
     v_entry:=jsonb_populate_record(null::public.journal_entries,v_row);
   else
     if tg_table_name='journal_lines' then
       select * into v_entry from public.journal_entries where org_id=v_pkg.org_id and id=(v_row->>'entry_id')::uuid for share;
     else
       if v_row->>'source_type' is distinct from 'inventory_event'
         or (v_row->>'project_id')::uuid is distinct from v_pkg.project_id
         or (v_row->>'incurred_on')::date is distinct from v_pkg.scheduled_start_date
         or v_row->'metadata'->>'lot_id' is distinct from v_pkg.lot_id::text
         or v_row->'metadata'->>'journal_entry_id' is distinct from v_row->>'source_id'
         or v_row->>'status' is distinct from 'posted'
         or (v_row->>'is_billable')::boolean is distinct from false
         or ((v_row->>'cost_cents')::bigint>0) is not true then
         raise exception 'Starts job-cost transfer mismatch' using errcode='42501';
       end if;
       select * into v_entry from public.journal_entries where org_id=v_pkg.org_id and id=(v_row->>'source_id')::uuid for share;
     end if;
     if not found then raise exception 'Starts posting parent missing' using errcode='42501'; end if;
   end if;
   if v_entry.source_type is distinct from 'inventory_start'
     or v_entry.source_id is distinct from v_pkg.lot_id
     or v_entry.posting_key is distinct from 'inventory_start:'||v_pkg.lot_id::text
     or v_entry.entry_date is distinct from v_pkg.scheduled_start_date
     or v_entry.created_by is distinct from v_actor then
     raise exception 'Starts journal transfer mismatch' using errcode='42501';
   end if;
   if tg_table_name='job_cost_entries' then
     if v_entry.status is distinct from 'posted' or (v_row->>'cost_cents')::bigint is distinct from
       (select sum(debit_cents) from public.journal_lines where org_id=v_pkg.org_id and entry_id=v_entry.id and project_id=v_pkg.project_id) then
       raise exception 'Starts job-cost amount mismatch' using errcode='42501';
     end if;
   end if;
   if tg_table_name='journal_lines' then
     if v_row->'dimensions'->>'lot_id' is distinct from v_pkg.lot_id::text then raise exception 'Starts journal lot mismatch' using errcode='42501'; end if;
     select code into v_code from public.gl_accounts where org_id=v_pkg.org_id and id=(v_row->>'account_id')::uuid and active and account_type='asset' for share;
     if not found then raise exception 'Starts inventory account missing' using errcode='42501'; end if;
     if ((v_code='1160' and (v_row->>'project_id')::uuid=v_pkg.project_id and (v_row->>'debit_cents')::bigint>0 and (v_row->>'credit_cents')::bigint=0)
       or (v_code='1120' and v_row->>'project_id' is null and (v_row->>'credit_cents')::bigint>0 and (v_row->>'debit_cents')::bigint=0)) is not true then
       raise exception 'Starts inventory line mismatch' using errcode='42501';
     end if;
   end if;
 end loop;
 if tg_op='DELETE' then raise exception 'Starts worker cannot delete land postings' using errcode='42501'; end if;
 return new;
end $$;
do $$ declare v_table text; begin
 foreach v_table in array array['journal_entries','journal_lines','job_cost_entries'] loop
   execute format('create trigger starts_land_posting_worker_fence before insert or update or delete on public.%I for each row execute function public.fence_starts_land_posting_write()',v_table);
 end loop;
end $$;
revoke all on function public.fence_starts_land_posting_write() from public,anon,authenticated;

create or replace function public.transfer_books_land_to_start(p_org_id uuid,p_lot_id uuid,p_date date,p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare worker_package public.start_packages%rowtype; lot public.lots%rowtype; land uuid; cip uuid; amount bigint; policy integer; result_id uuid; key text; dimensions jsonb;
begin
 worker_package:=public.lock_starts_release_write_scope(p_org_id);
 if worker_package.id is not null and (worker_package.lot_id is distinct from p_lot_id or worker_package.scheduled_start_date is distinct from p_date) then
   raise exception 'Starts land transfer scope mismatch' using errcode='42501';
 end if;
 select * into lot from public.lots where org_id=p_org_id and id=p_lot_id for update;
 if not found then raise exception 'Lot not found'; end if;
 if worker_package.id is not null and lot.project_id is distinct from worker_package.project_id then raise exception 'Starts land transfer home mismatch' using errcode='42501'; end if;
 if lot.books_acquisition_entry_id is null then return jsonb_build_object('status','not_tracked'); end if;
 if lot.project_id is null then raise exception 'Land must be assigned to its project before start'; end if;
 perform 1 from public.project_financial_settings where org_id=p_org_id and project_id=lot.project_id and books_inventory_enabled and books_inventory_effective_on<=p_date and books_inventory_completed_on is null and books_inventory_sold_on is null for update;
 if not found then raise exception 'Adopt the project inventory policy before releasing an owned-lot start'; end if;
 key:='inventory_start:'||lot.id;
 select e.id into result_id from public.journal_entries e where e.org_id=p_org_id and e.posting_key=key and e.status='posted';
 if result_id is not null then
   if not exists(select 1 from public.journal_entries e join public.journal_lines l on l.entry_id=e.id and l.org_id=e.org_id
     where e.org_id=p_org_id and e.id=result_id and e.entry_date=p_date and e.source_type='inventory_start' and e.source_id=lot.id
       and l.project_id=lot.project_id and l.dimensions->>'lot_id'=lot.id::text and l.debit_cents>0)
     or not exists(select 1 from public.job_cost_entries j where j.org_id=p_org_id and j.project_id=lot.project_id
       and j.source_type='inventory_event' and j.source_id=result_id::text and j.incurred_on=p_date and j.status='posted'
       and j.cost_cents=(select sum(l.debit_cents) from public.journal_lines l where l.org_id=p_org_id and l.entry_id=result_id and l.project_id=lot.project_id)) then
     raise exception 'Existing land transfer does not match this home, date or job-cost receipt';
   end if;
   return jsonb_build_object('status','posted','id',result_id);
 end if;
 select id into land from public.gl_accounts where org_id=p_org_id and code='1120' and active;
 select id into cip from public.gl_accounts where org_id=p_org_id and code='1160' and active;
 if land is null or cip is null then raise exception 'Inventory accounts are missing'; end if;
 select active_policy_version into policy from public.books_settings where org_id=p_org_id;
 select coalesce(sum(l.debit_cents-l.credit_cents),0) into amount from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id where l.org_id=p_org_id and l.account_id=land and l.dimensions->>'lot_id'=lot.id::text and e.status in('posted','reversed') and e.entry_date<=p_date;
 if amount<=0 then raise exception 'The owned lot has no positive recorded basis at the start date'; end if;
 dimensions:=jsonb_build_object('lot_id',lot.id,'community_id',lot.community_id,'division_id',lot.division_id,'acquisition_entry_id',lot.books_acquisition_entry_id);
 result_id:=public.post_books_journal_entry(p_org_id,jsonb_build_object('entry_date',p_date,'entry_kind','adjusting','memo','Transfer land into home construction','posting_key',key,'projection_version',1,'policy_version',policy,'source_type','inventory_start','source_id',lot.id,'created_by',p_actor_id),
 jsonb_build_array(jsonb_build_object('line_no',1,'account_id',cip,'project_id',lot.project_id,'debit_cents',amount,'credit_cents',0,'dimensions',dimensions),jsonb_build_object('line_no',2,'account_id',land,'debit_cents',0,'credit_cents',amount,'dimensions',dimensions)));
 insert into public.job_cost_entries(org_id,project_id,source_type,source_id,incurred_on,cost_cents,status,is_billable,metadata) values(p_org_id,lot.project_id,'inventory_event',result_id,p_date,amount,'posted',false,jsonb_build_object('lot_id',lot.id,'journal_entry_id',result_id));
 return jsonb_build_object('status','posted','id',result_id,'amount_cents',amount);
end;
$$;
revoke all on function public.transfer_books_land_to_start(uuid,uuid,date,uuid) from public,anon,authenticated;
grant execute on function public.transfer_books_land_to_start(uuid,uuid,date,uuid) to service_role;
