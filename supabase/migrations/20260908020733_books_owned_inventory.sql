-- Owned inventory requires deliberate policy adoption; existing project history is not recoded.
alter table public.project_financial_settings
 add column books_inventory_enabled boolean not null default false,
 add column books_inventory_effective_on date,
 add column books_inventory_completed_on date,
 add column books_inventory_sold_on date,
 add column books_inventory_evidence_url text,
 add constraint books_inventory_policy_dates check(not books_inventory_enabled or (books_inventory_effective_on is not null and (books_inventory_completed_on is null or books_inventory_completed_on>=books_inventory_effective_on) and (books_inventory_sold_on is null or books_inventory_sold_on>=coalesce(books_inventory_completed_on,books_inventory_effective_on))));
create index books_inventory_active_projects_idx on public.project_financial_settings(org_id,project_id) where books_inventory_enabled;
insert into public.gl_accounts(org_id,code,name,account_type,subtype,normal_balance,cash_flow_category,is_system,active)
select s.org_id,a.code,a.name,'asset',a.subtype,'debit','operating',true,true from public.books_settings s cross join (values
 ('1120','Owned land','other_asset'),('1130','Community development inventory','other_asset'),('1170','Completed homes held for sale','work_in_progress')) a(code,name,subtype)
on conflict(org_id,code) do nothing;

create or replace function public.enable_books_project_inventory(p_org_id uuid,p_project_id uuid,p_effective_on date,p_evidence_url text,p_actor_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.projects where org_id=p_org_id and id=p_project_id for update;
 if not found then raise exception 'Project not found'; end if;
 if p_effective_on is null or p_evidence_url not like 'https://%' then raise exception 'Inventory adoption date and ownership evidence are required'; end if;
 if exists(select 1 from public.project_financial_settings where org_id=p_org_id and project_id=p_project_id and books_inventory_enabled) then
   if exists(select 1 from public.project_financial_settings where org_id=p_org_id and project_id=p_project_id and books_inventory_effective_on=p_effective_on and books_inventory_evidence_url=p_evidence_url) then return; end if;
   raise exception 'Inventory policy has already been adopted; correct prior balances through reviewed entries';
 end if;
 if exists(select 1 from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id join public.gl_accounts a on a.id=l.account_id and a.org_id=l.org_id where l.org_id=p_org_id and l.project_id=p_project_id and e.status in ('posted','reversed') and e.entry_date>=p_effective_on and a.account_type='cogs') then raise exception 'Choose an adoption date after existing cost postings and separately approve any opening inventory reclassification'; end if;
 insert into public.project_financial_settings(org_id,project_id,billing_model,books_inventory_enabled,books_inventory_effective_on,books_inventory_evidence_url,created_by,updated_by)
 values(p_org_id,p_project_id,'fixed_price',true,p_effective_on,p_evidence_url,p_actor_id,p_actor_id)
 on conflict(org_id,project_id) do update set books_inventory_enabled=true,books_inventory_effective_on=p_effective_on,books_inventory_evidence_url=p_evidence_url,updated_by=p_actor_id;
end;
$$;
revoke all on function public.enable_books_project_inventory(uuid,uuid,date,text,uuid) from public,anon,authenticated;
grant execute on function public.enable_books_project_inventory(uuid,uuid,date,text,uuid) to service_role;

create or replace function public.transition_books_project_inventory(p_org_id uuid,p_project_id uuid,p_transition text,p_date date,p_evidence_url text,p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare settings public.project_financial_settings%rowtype; cip uuid; completed uuid; cogs uuid; cip_cents bigint; completed_cents bigint; target uuid; total bigint; policy integer; revision integer; result_id uuid; lines jsonb; evidence jsonb;
begin
 select * into settings from public.project_financial_settings where org_id=p_org_id and project_id=p_project_id for update;
 if not found or not settings.books_inventory_enabled then return jsonb_build_object('status','not_enabled'); end if;
 if p_transition not in ('completion','sale_relief') or p_date<settings.books_inventory_effective_on or p_evidence_url not like 'https://%' then raise exception 'Invalid inventory transition or missing evidence'; end if;
 if p_transition='completion' and settings.books_inventory_sold_on is not null then raise exception 'A sold home cannot return to completed inventory'; end if;
 if p_transition='completion' and settings.books_inventory_completed_on is not null and settings.books_inventory_completed_on<>p_date then raise exception 'The completion date is already recorded'; end if;
 if p_transition='sale_relief' and p_date<coalesce(settings.books_inventory_completed_on,settings.books_inventory_effective_on) then raise exception 'Sale cannot precede completion or inventory adoption'; end if;
 select id into cip from public.gl_accounts where org_id=p_org_id and code='1160' and active;
 select id into completed from public.gl_accounts where org_id=p_org_id and code='1170' and active;
 select id into cogs from public.gl_accounts where org_id=p_org_id and code='5000' and active;
 if cip is null or completed is null or cogs is null then raise exception 'Inventory accounts are missing'; end if;
 select active_policy_version into policy from public.books_settings where org_id=p_org_id and workspace_enabled and arc_ledger_mode<>'disabled';
 if not found then raise exception 'Books posting is not enabled'; end if;
 select coalesce(sum(l.debit_cents-l.credit_cents) filter(where l.account_id=cip),0),coalesce(sum(l.debit_cents-l.credit_cents) filter(where l.account_id=completed),0)
 into cip_cents,completed_cents from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id where l.org_id=p_org_id and l.project_id=p_project_id and l.account_id in(cip,completed) and e.status in('posted','reversed') and e.entry_date<=p_date;
 if (select coalesce(sum(j.cost_cents),0) from public.job_cost_entries j where j.org_id=p_org_id and j.project_id=p_project_id and j.status='posted' and j.incurred_on<=p_date) is distinct from
   (select coalesce(sum(l.debit_cents-l.credit_cents),0) from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id join public.gl_accounts a on a.id=l.account_id and a.org_id=l.org_id where l.org_id=p_org_id and l.project_id=p_project_id and e.status in('posted','reversed') and e.entry_date<=p_date and (a.account_type='cogs' or a.code in('1160','1170')) and coalesce(l.dimensions->>'warranty_reserve_adjustment','false')<>'true') then
   raise exception 'Project costs must fully tie to Books before completing or selling inventory';
 end if;
 if p_transition='completion' then completed_cents:=0; end if;
 total:=cip_cents+completed_cents;
 if (total<0 or cip_cents<0 or completed_cents<0) and settings.books_inventory_completed_on is null and settings.books_inventory_sold_on is null then raise exception 'Negative inventory requires review before a lifecycle transition'; end if;
 if cip_cents<>0 or completed_cents<>0 then
   select count(*)+1 into revision from public.journal_entries where org_id=p_org_id and source_type='inventory_'||p_transition and source_id=p_project_id;
   evidence:=jsonb_build_object('inventory_transition',p_transition,'evidence_url',p_evidence_url,'inventory_basis_cents',total);
   target:=case when p_transition='completion' then completed else cogs end;
   lines:='[]'::jsonb;
   if total<>0 then lines:=jsonb_build_array(jsonb_build_object('line_no',1,'account_id',target,'project_id',p_project_id,'debit_cents',greatest(total,0),'credit_cents',greatest(-total,0),'dimensions',evidence)); end if;
   if cip_cents<>0 then lines:=lines||jsonb_build_array(jsonb_build_object('line_no',2,'account_id',cip,'project_id',p_project_id,'debit_cents',greatest(-cip_cents,0),'credit_cents',greatest(cip_cents,0),'dimensions',evidence)); end if;
   if completed_cents<>0 then lines:=lines||jsonb_build_array(jsonb_build_object('line_no',3,'account_id',completed,'project_id',p_project_id,'debit_cents',greatest(-completed_cents,0),'credit_cents',greatest(completed_cents,0),'dimensions',evidence)); end if;
   result_id:=public.post_books_journal_entry(p_org_id,jsonb_build_object('entry_date',p_date,'entry_kind','adjusting','memo','Inventory '||p_transition,'posting_key','inventory:'||p_project_id||':'||p_transition||':'||revision,'projection_version',1,'policy_version',policy,'source_type','inventory_'||p_transition,'source_id',p_project_id,'created_by',p_actor_id),lines);
 end if;
 update public.project_financial_settings set books_inventory_completed_on=case when p_transition='completion' then p_date else books_inventory_completed_on end,
   books_inventory_sold_on=case when p_transition='sale_relief' then coalesce(books_inventory_sold_on,p_date) else books_inventory_sold_on end,updated_at=now() where org_id=p_org_id and project_id=p_project_id;
 return jsonb_build_object('status','posted','id',result_id,'amount_cents',total);
end;
$$;
revoke all on function public.transition_books_project_inventory(uuid,uuid,text,date,text,uuid) from public,anon,authenticated;
grant execute on function public.transition_books_project_inventory(uuid,uuid,text,date,text,uuid) to service_role;

create or replace function public.guard_books_inventory_policy()
returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='INSERT' then
   if new.books_inventory_enabled and current_user not in ('postgres','service_role') then raise exception 'Inventory policy changes require the Books service'; end if;
   return new;
 end if;
 if (to_jsonb(old)->'books_inventory_enabled',to_jsonb(old)->'books_inventory_effective_on',to_jsonb(old)->'books_inventory_completed_on',to_jsonb(old)->'books_inventory_sold_on') is distinct from (to_jsonb(new)->'books_inventory_enabled',to_jsonb(new)->'books_inventory_effective_on',to_jsonb(new)->'books_inventory_completed_on',to_jsonb(new)->'books_inventory_sold_on') and current_user not in ('postgres','service_role') then raise exception 'Inventory policy changes require the Books service'; end if;
 return new;
end;
$$;
create trigger books_inventory_policy_guard before insert or update on public.project_financial_settings for each row execute function public.guard_books_inventory_policy();

-- Serialize operational cost writes against completion/sale and reject a stale draft.
create or replace function public.guard_books_inventory_cost_stage()
returns trigger language plpgsql security definer set search_path='' as $$
declare e public.journal_entries%rowtype; s public.project_financial_settings%rowtype; a public.gl_accounts%rowtype; expected text;
begin
 if new.project_id is null then return new; end if;
 select * into e from public.journal_entries where org_id=new.org_id and id=new.entry_id;
 if e.source_type not in ('vendor_bill','expense','labor_cost','bank_transaction') or e.entry_kind='reversal' then return new; end if;
 select * into a from public.gl_accounts where org_id=new.org_id and id=new.account_id;
 if a.account_type<>'cogs' and a.code not in ('1160','1170') then return new; end if;
 select * into s from public.project_financial_settings where org_id=new.org_id and project_id=new.project_id and books_inventory_enabled for update;
 if not found or e.entry_date<s.books_inventory_effective_on then return new; end if;
 expected:=case when s.books_inventory_sold_on is not null and e.entry_date>=s.books_inventory_sold_on then 'cogs' when s.books_inventory_completed_on is not null and e.entry_date>=s.books_inventory_completed_on then '1170' else '1160' end;
 if (expected='cogs' and a.account_type<>'cogs') or (expected<>'cogs' and a.code<>expected) then raise exception 'Inventory stage changed; refresh the cost projection before posting'; end if;
 return new;
end;
$$;
revoke all on function public.guard_books_inventory_cost_stage() from public,anon,authenticated;
create trigger books_inventory_cost_stage_guard before insert on public.journal_lines for each row execute function public.guard_books_inventory_cost_stage();

-- Bank-coded build costs follow the same adopted project policy as bills and labor.
do $$ declare definition text; begin
 definition:=pg_get_functiondef('public.categorize_books_bank_transaction_atomic(uuid,uuid,uuid,uuid,uuid,text,uuid)'::regprocedure);
 definition:=replace(definition,'begin'||chr(10)||' select b.*', 'declare inventory_code text; inventory_account uuid;'||chr(10)||'begin'||chr(10)||' select b.*');
 definition:=replace(definition,' debit:=case when txn.direction=',
 ' inventory_account:=category.id;'||chr(10)||
 ' if category.account_type=''cogs'' and p_project_id is not null then'||chr(10)||
 '   select case when s.books_inventory_sold_on is not null and txn.transaction_date>=s.books_inventory_sold_on then null when s.books_inventory_completed_on is not null and txn.transaction_date>=s.books_inventory_completed_on then ''1170'' else ''1160'' end into inventory_code from public.project_financial_settings s where s.org_id=p_org_id and s.project_id=p_project_id and s.books_inventory_enabled and txn.transaction_date>=s.books_inventory_effective_on for update;'||chr(10)||
 '   if inventory_code is not null then select id into inventory_account from public.gl_accounts where org_id=p_org_id and code=inventory_code and active; if inventory_account is null then raise exception ''Inventory account is missing''; end if; end if;'||chr(10)||
 ' end if;'||chr(10)||
 ' debit:=case when txn.direction=');
 definition:=replace(definition,'l.account_id=category.id','l.account_id=inventory_account');
 definition:=replace(definition,'''account_id'',category.id','''account_id'',inventory_account');
 -- PL/pgSQL has one DECLARE section; append declarations to the existing section.
 definition:=replace(definition,'declare inventory_code text; inventory_account uuid;', 'inventory_code text; inventory_account uuid;');
 if position('inventory_account:=category.id' in definition)=0 then raise exception 'Bank categorization definition does not match the inventory adapter'; end if;
 execute definition;
end $$;
