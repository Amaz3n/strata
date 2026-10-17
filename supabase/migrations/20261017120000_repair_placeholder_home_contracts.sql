-- EP10-02: a production home never needs the placeholder fixed contract that
-- project setup used to open beside its purchase agreement. Books refuses to post
-- to, or adopt as inventory, a home with two primary contracts that earn
-- differently. New homes (start desk, reservation conversion) no longer get one;
-- this removes the ones already created.
--
-- Only an untouched placeholder goes: written by project settings, unsigned, no
-- value, no parent, on a production home that has an active purchase agreement,
-- and referenced by no row anywhere (every foreign key to contracts is checked,
-- so cascading children are never lost). Each removal keeps an audit row holding
-- the removed contract. The function returns how many it removed; a second run
-- finds nothing to remove.

create or replace function public.repair_placeholder_home_contracts()
returns integer language plpgsql security definer set search_path='' as $$
declare c public.contracts%rowtype; fk record; referenced boolean; removed integer:=0;
begin
 for c in
   select k.* from public.contracts k
   join public.projects p on p.org_id=k.org_id and p.id=k.project_id
   where p.property_type='production'
     and k.contract_type in('fixed','cost_plus','time_materials')
     and k.signed_at is null and k.signature_data is null and k.parent_contract_id is null
     and coalesce(k.total_cents,0)=0
     and k.snapshot->>'billing_setup_source'='project_settings'
     and exists(select 1 from public.contracts a where a.org_id=k.org_id and a.project_id=k.project_id and a.contract_type='purchase_agreement' and a.status='active')
   order by k.id
   for update of k
 loop
   referenced:=false;
   for fk in
     select k2.conrelid::regclass::text as tbl, a.attname as col
     from pg_constraint k2 join pg_attribute a on a.attrelid=k2.conrelid and a.attnum=k2.conkey[1]
     where k2.contype='f' and k2.confrelid='public.contracts'::regclass and array_length(k2.conkey,1)=1
   loop
     execute format('select exists(select 1 from %s where %I=$1)',fk.tbl,fk.col) into referenced using c.id;
     exit when referenced;
   end loop;
   if referenced then continue; end if;
   insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,before_data,source)
     values(c.org_id,null,'delete','contract',c.id,to_jsonb(c),'ep10_placeholder_contract_repair');
   delete from public.contracts where id=c.id;
   removed:=removed+1;
 end loop;
 return removed;
end $$;
revoke all on function public.repair_placeholder_home_contracts() from public,anon,authenticated;
grant execute on function public.repair_placeholder_home_contracts() to service_role;

select public.repair_placeholder_home_contracts();
