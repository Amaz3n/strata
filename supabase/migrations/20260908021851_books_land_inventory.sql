-- Native land basis is proved by acquisition journals, never by expected takedown prices.
alter table public.lots add column books_acquisition_entry_id uuid references public.journal_entries(id) on delete restrict;
create index lots_books_acquisition_idx on public.lots(books_acquisition_entry_id) where books_acquisition_entry_id is not null;
alter table public.job_cost_entries drop constraint job_cost_entries_source_type_check;
alter table public.job_cost_entries add constraint job_cost_entries_source_type_check check(source_type in('vendor_bill_line','project_expense','project_expense_line','time_entry','bank_transaction','inventory_event'));

create or replace function public.acquire_books_land(
 p_org_id uuid,p_date date,p_allocations jsonb,p_cash_account_id uuid,p_cash_cents bigint,p_debt_instrument_id uuid,p_debt_cents bigint,p_reference text,p_evidence_url text,p_actor_id uuid
) returns uuid language plpgsql security definer set search_path='' as $$
declare item jsonb; lot public.lots%rowtype; land uuid; debt public.books_debt_instruments%rowtype; total bigint; policy integer; result_id uuid; lines jsonb:='[]'; n integer:=0; key text; fingerprint text;
begin
 if jsonb_typeof(p_allocations)<>'array' or jsonb_array_length(p_allocations)=0 or p_cash_cents<0 or p_debt_cents<0 or p_cash_cents+p_debt_cents<=0 or length(btrim(p_reference))<3 or p_evidence_url not like 'https://%' then raise exception 'Actual acquisition allocations, funding and evidence are required'; end if;
 if (select count(*) from jsonb_array_elements(p_allocations))<>(select count(distinct x->>'lot_id') from jsonb_array_elements(p_allocations) x) then raise exception 'A lot can appear only once'; end if;
 perform 1 from public.bank_accounts where org_id=p_org_id and gl_account_id=p_cash_account_id order by id for update;
 if p_cash_cents>0 and not exists(select 1 from public.gl_accounts where org_id=p_org_id and id=p_cash_account_id and active and account_type='asset' and subtype='cash') then raise exception 'Actual bank funding account is required'; end if;
 select id into land from public.gl_accounts where org_id=p_org_id and code='1120' and active;
 if land is null then raise exception 'Owned land account is missing'; end if;
 select active_policy_version into policy from public.books_settings where org_id=p_org_id and workspace_enabled and arc_ledger_mode<>'disabled';
 if not found then raise exception 'Books posting is not enabled'; end if;
 if p_debt_cents>0 then
   select * into debt from public.books_debt_instruments where org_id=p_org_id and id=p_debt_instrument_id and active for update;
   if not found then raise exception 'Select the actual debt instrument funding this acquisition'; end if;
 end if;
 -- Row locks establish unique lot ownership and serialize duplicate requests.
 perform 1 from public.lots l where l.org_id=p_org_id and l.id in(select (x->>'lot_id')::uuid from jsonb_array_elements(p_allocations) x) order by l.id for update;
 key:='land_acquisition:'||lower(btrim(p_reference));
 fingerprint:=encode(extensions.digest(jsonb_build_array(p_date,(select jsonb_agg(x order by x->>'lot_id') from jsonb_array_elements(p_allocations) x),p_cash_account_id,p_cash_cents,p_debt_instrument_id,p_debt_cents,p_evidence_url)::text,'sha256'),'hex');
 select e.id into result_id from public.journal_entries e where e.org_id=p_org_id and e.posting_key=key;
 if result_id is not null then
   if not exists(select 1 from public.journal_entries e join public.journal_lines l on l.entry_id=e.id and l.org_id=e.org_id where e.org_id=p_org_id and e.id=result_id and e.status='posted' and l.dimensions->>'acquisition_hash'=fingerprint) then raise exception 'Acquisition reference was already used for different or reversed details'; end if;
   return result_id;
 end if;
 total:=0;
 for item in select x from jsonb_array_elements(p_allocations) x order by x->>'lot_id' loop
   select * into lot from public.lots where org_id=p_org_id and id=(item->>'lot_id')::uuid;
   if not found or lot.status<>'controlled' or lot.books_acquisition_entry_id is not null then raise exception 'Acquisition requires unacquired controlled lots in this organization'; end if;
   if (item->>'amount_cents')::bigint<=0 then raise exception 'Every lot requires an actual positive acquisition allocation'; end if;
   n:=n+1; total:=total+(item->>'amount_cents')::bigint;
   lines:=lines||jsonb_build_array(jsonb_build_object('line_no',n,'account_id',land,'debit_cents',(item->>'amount_cents')::bigint,'credit_cents',0,'description',p_reference,'dimensions',jsonb_build_object('lot_id',lot.id,'community_id',lot.community_id,'division_id',lot.division_id,'evidence_url',p_evidence_url,'acquisition_hash',fingerprint)));
 end loop;
 if total<>p_cash_cents+p_debt_cents then raise exception 'Actual funding must equal the approved lot allocations'; end if;
 if p_cash_cents>0 then n:=n+1; lines:=lines||jsonb_build_array(jsonb_build_object('line_no',n,'account_id',p_cash_account_id,'debit_cents',0,'credit_cents',p_cash_cents,'dimensions','{}'::jsonb)); end if;
 if p_debt_cents>0 then n:=n+1; lines:=lines||jsonb_build_array(jsonb_build_object('line_no',n,'account_id',debt.liability_account_id,'debit_cents',0,'credit_cents',p_debt_cents,'dimensions','{}'::jsonb)); end if;
 result_id:=public.post_books_journal_entry(p_org_id,jsonb_build_object('entry_date',p_date,'entry_kind','adjusting','memo','Land acquisition: '||p_reference,'posting_key',key,'projection_version',1,'policy_version',policy,'source_type','land_acquisition','created_by',p_actor_id),lines);
 if p_debt_cents>0 then
   insert into public.books_debt_events(org_id,instrument_id,event_type,event_date,principal_cents,journal_entry_id,event_key,memo,created_by)
   values(p_org_id,debt.id,'draw',p_date,p_debt_cents,result_id,key,'Land acquisition: '||p_reference,p_actor_id);
 end if;
 for item in select x from jsonb_array_elements(p_allocations) x loop
   update public.lots set status='owned',acquired_date=p_date,cost_basis_cents=(item->>'amount_cents')::bigint,books_acquisition_entry_id=result_id,updated_at=now() where org_id=p_org_id and id=(item->>'lot_id')::uuid;
 end loop;
 return result_id;
end;
$$;
revoke all on function public.acquire_books_land(uuid,date,jsonb,uuid,bigint,uuid,bigint,text,text,uuid) from public,anon,authenticated;
grant execute on function public.acquire_books_land(uuid,date,jsonb,uuid,bigint,uuid,bigint,text,text,uuid) to service_role;

create or replace function public.transfer_books_land_to_start(p_org_id uuid,p_lot_id uuid,p_date date,p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare lot public.lots%rowtype; land uuid; cip uuid; amount bigint; policy integer; result_id uuid; key text; dimensions jsonb;
begin
 select * into lot from public.lots where org_id=p_org_id and id=p_lot_id for update;
 if not found then raise exception 'Lot not found'; end if;
 if lot.books_acquisition_entry_id is null then return jsonb_build_object('status','not_tracked'); end if;
 if lot.project_id is null then raise exception 'Land must be assigned to its project before start'; end if;
 perform 1 from public.project_financial_settings where org_id=p_org_id and project_id=lot.project_id and books_inventory_enabled and books_inventory_effective_on<=p_date and books_inventory_completed_on is null and books_inventory_sold_on is null for update;
 if not found then raise exception 'Adopt the project inventory policy before releasing an owned-lot start'; end if;
 key:='inventory_start:'||lot.id;
 select e.id into result_id from public.journal_entries e where e.org_id=p_org_id and e.posting_key=key and e.status='posted';
 if result_id is not null then return jsonb_build_object('status','posted','id',result_id); end if;
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

create or replace function public.guard_books_land_ownership()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.status='controlled' and new.status in('owned','developed','assigned','started','closed') and new.books_acquisition_entry_id is null and exists(select 1 from public.books_settings where org_id=new.org_id and workspace_enabled and arc_ledger_mode<>'disabled') then raise exception 'Record the actual land acquisition in Books before advancing ownership'; end if;
 if new.books_acquisition_entry_id is not null and not exists(select 1 from public.journal_entries e join public.journal_lines l on l.entry_id=e.id and l.org_id=e.org_id where e.org_id=new.org_id and e.id=new.books_acquisition_entry_id and e.status='posted' and e.source_type='land_acquisition' and l.dimensions->>'lot_id'=new.id::text) then raise exception 'Land acquisition must reference its posted native journal'; end if;
 return new;
end;
$$;
revoke all on function public.guard_books_land_ownership() from public,anon,authenticated;
create trigger books_land_ownership_guard before update of status,books_acquisition_entry_id on public.lots for each row execute function public.guard_books_land_ownership();

-- Allocate recorded development-project costs; receiving lots keep their basis until start.
create or replace function public.allocate_books_development_cost(p_org_id uuid,p_project_id uuid,p_date date,p_allocations jsonb,p_reference text,p_evidence_url text,p_actor_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare source_account uuid; land uuid; available bigint; total bigint; item jsonb; lot public.lots%rowtype; result_id uuid; policy integer; lines jsonb:='[]'; n integer:=0; fingerprint text;
begin
 if jsonb_typeof(p_allocations)<>'array' or jsonb_array_length(p_allocations)=0 or p_evidence_url not like 'https://%' or length(btrim(p_reference))<3 then raise exception 'An approved allocation schedule is required'; end if;
 perform 1 from public.lots l where l.org_id=p_org_id and l.id in(select (x->>'lot_id')::uuid from jsonb_array_elements(p_allocations) x) order by l.id for update;
 perform 1 from public.project_financial_settings where org_id=p_org_id and project_id=p_project_id and books_inventory_enabled and books_inventory_completed_on is null and books_inventory_sold_on is null for update;
 if not found then raise exception 'Source project must hold active owned development inventory'; end if;
 select id into source_account from public.gl_accounts where org_id=p_org_id and code='1160' and active;
 select id into land from public.gl_accounts where org_id=p_org_id and code='1120' and active;
 if source_account is null or land is null then raise exception 'Inventory accounts are missing'; end if;
 if (select count(*) from jsonb_array_elements(p_allocations))<>(select count(distinct x->>'lot_id') from jsonb_array_elements(p_allocations) x) then raise exception 'Allocation lots must be unique'; end if;

 fingerprint:=encode(extensions.digest(jsonb_build_array(p_project_id,p_date,(select jsonb_agg(x order by x->>'lot_id') from jsonb_array_elements(p_allocations) x),p_evidence_url)::text,'sha256'),'hex');
 select e.id into result_id from public.journal_entries e where e.org_id=p_org_id and e.posting_key='development_allocation:'||lower(btrim(p_reference));
 if result_id is not null then
   if not exists(select 1 from public.journal_entries e join public.journal_lines l on l.org_id=e.org_id and l.entry_id=e.id where e.id=result_id and e.org_id=p_org_id and e.status='posted' and l.dimensions->>'allocation_hash'=fingerprint) then raise exception 'Allocation reference already has different or reversed details'; end if;
   return result_id;
 end if;
 select coalesce(sum(l.debit_cents-l.credit_cents),0) into available from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id where l.org_id=p_org_id and l.project_id=p_project_id and l.account_id=source_account and e.status in('posted','reversed') and e.entry_date<=p_date;
 total:=0;
 for item in select x from jsonb_array_elements(p_allocations) x order by x->>'lot_id' loop
   select * into lot from public.lots where org_id=p_org_id and id=(item->>'lot_id')::uuid;
   if not found or lot.books_acquisition_entry_id is null or lot.status not in('owned','developed','assigned') or exists(select 1 from public.journal_entries where org_id=p_org_id and source_type='inventory_start' and source_id=lot.id and status='posted') then raise exception 'Development allocation requires acquired, unstarted lots'; end if;
   if (item->>'amount_cents')::bigint<=0 then raise exception 'Allocation amounts must be positive'; end if;
   total:=total+(item->>'amount_cents')::bigint; n:=n+1;
   lines:=lines||jsonb_build_array(jsonb_build_object('line_no',n,'account_id',land,'debit_cents',(item->>'amount_cents')::bigint,'credit_cents',0,'dimensions',jsonb_build_object('lot_id',lot.id,'community_id',lot.community_id,'division_id',lot.division_id,'source_project_id',p_project_id,'allocation_hash',fingerprint,'evidence_url',p_evidence_url)));
 end loop;
 if total>available then raise exception 'Allocations exceed recorded development costs at this date'; end if;
 n:=n+1; lines:=lines||jsonb_build_array(jsonb_build_object('line_no',n,'account_id',source_account,'project_id',p_project_id,'debit_cents',0,'credit_cents',total,'dimensions',jsonb_build_object('allocation_hash',fingerprint,'evidence_url',p_evidence_url)));
 select active_policy_version into policy from public.books_settings where org_id=p_org_id;
 result_id:=public.post_books_journal_entry(p_org_id,jsonb_build_object('entry_date',p_date,'entry_kind','adjusting','memo','Allocate development costs: '||p_reference,'posting_key','development_allocation:'||lower(btrim(p_reference)),'projection_version',1,'policy_version',policy,'source_type','inventory_development_allocation','source_id',p_project_id,'created_by',p_actor_id),lines);
 insert into public.job_cost_entries(org_id,project_id,source_type,source_id,incurred_on,cost_cents,status,is_billable,metadata) values(p_org_id,p_project_id,'inventory_event',result_id,p_date,-total,'posted',false,jsonb_build_object('allocation_journal_entry_id',result_id));
 for item in select x from jsonb_array_elements(p_allocations) x loop update public.lots set cost_basis_cents=coalesce(cost_basis_cents,0)+(item->>'amount_cents')::bigint,updated_at=now() where org_id=p_org_id and id=(item->>'lot_id')::uuid; end loop;
 return result_id;
end;
$$;
revoke all on function public.allocate_books_development_cost(uuid,uuid,date,jsonb,text,text,uuid) from public,anon,authenticated;
grant execute on function public.allocate_books_development_cost(uuid,uuid,date,jsonb,text,text,uuid) to service_role;

-- Capitalize only supported interest that has already been incurred in the GL.
create or replace function public.capitalize_books_inventory_interest(p_org_id uuid,p_project_id uuid,p_source_line_id uuid,p_date date,p_amount_cents bigint,p_reference text,p_evidence_url text,p_actor_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare s public.project_financial_settings%rowtype; source public.journal_lines%rowtype; available bigint; used bigint; inventory uuid; policy integer; result_id uuid; dimensions jsonb; fingerprint text;
begin
 if p_amount_cents<=0 or length(btrim(p_reference))<3 or p_evidence_url not like 'https://%' then raise exception 'Eligible interest amount and policy evidence are required'; end if;
 select * into s from public.project_financial_settings where org_id=p_org_id and project_id=p_project_id and books_inventory_enabled for update;
 if not found or p_date<s.books_inventory_effective_on or (s.books_inventory_completed_on is not null and p_date>=s.books_inventory_completed_on) or (s.books_inventory_sold_on is not null and p_date>=s.books_inventory_sold_on) then raise exception 'Interest capitalization is limited to active construction before completion'; end if;
 if exists(select 1 from public.projects where org_id=p_org_id and id=p_project_id and status::text in('on_hold','completed','cancelled')) then raise exception 'Suspended or completed projects cannot capitalize interest'; end if;
 select l.* into source from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id join public.gl_accounts a on a.id=l.account_id and a.org_id=l.org_id where l.id=p_source_line_id and l.org_id=p_org_id and e.status='posted' and e.entry_date<=p_date and a.account_type='expense' and a.subtype='interest' and l.debit_cents>0 for update of l;
 if not found then raise exception 'Select an actual posted interest-expense line'; end if;
 fingerprint:=encode(extensions.digest(jsonb_build_array(p_project_id,p_source_line_id,p_date,p_amount_cents,p_evidence_url)::text,'sha256'),'hex');
 select e.id into result_id from public.journal_entries e where e.org_id=p_org_id and e.posting_key='capitalized_interest:'||lower(btrim(p_reference));
 if result_id is not null then
   if not exists(select 1 from public.journal_entries e join public.journal_lines l on l.entry_id=e.id and l.org_id=e.org_id where e.id=result_id and e.org_id=p_org_id and e.status='posted' and l.dimensions->>'interest_hash'=fingerprint) then raise exception 'Interest reference already has different or reversed details'; end if;
   return result_id;
 end if;
 select coalesce(sum(l.credit_cents-l.debit_cents),0) into used from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id where l.org_id=p_org_id and l.account_id=source.account_id and l.dimensions->>'interest_source_line_id'=p_source_line_id::text and e.status in('posted','reversed');
 available:=source.debit_cents-source.credit_cents-used;
 if p_amount_cents>available then raise exception 'Capitalized interest exceeds the unallocated incurred interest'; end if;
 select id into inventory from public.gl_accounts where org_id=p_org_id and code='1160' and active;
 select active_policy_version into policy from public.books_settings where org_id=p_org_id;
 if inventory is null then raise exception 'Construction inventory account is missing'; end if;
 dimensions:=jsonb_build_object('interest_source_line_id',p_source_line_id,'interest_hash',fingerprint,'evidence_url',p_evidence_url);
 result_id:=public.post_books_journal_entry(p_org_id,jsonb_build_object('entry_date',p_date,'entry_kind','adjusting','memo','Capitalize eligible interest: '||p_reference,'posting_key','capitalized_interest:'||lower(btrim(p_reference)),'projection_version',1,'policy_version',policy,'source_type','inventory_interest','source_id',p_project_id,'created_by',p_actor_id),
 jsonb_build_array(jsonb_build_object('line_no',1,'account_id',inventory,'project_id',p_project_id,'debit_cents',p_amount_cents,'credit_cents',0,'dimensions',dimensions),jsonb_build_object('line_no',2,'account_id',source.account_id,'project_id',source.project_id,'debit_cents',0,'credit_cents',p_amount_cents,'dimensions',dimensions)));
 insert into public.job_cost_entries(org_id,project_id,source_type,source_id,incurred_on,cost_cents,status,is_billable,metadata) values(p_org_id,p_project_id,'inventory_event',result_id,p_date,p_amount_cents,'posted',false,dimensions);
 return result_id;
end;
$$;
revoke all on function public.capitalize_books_inventory_interest(uuid,uuid,uuid,date,bigint,text,text,uuid) from public,anon,authenticated;
grant execute on function public.capitalize_books_inventory_interest(uuid,uuid,uuid,date,bigint,text,text,uuid) to service_role;
