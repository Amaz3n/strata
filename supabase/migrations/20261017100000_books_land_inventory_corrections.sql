-- EP10-02: a posted land acquisition or start transfer can be corrected.
--
-- A reversed acquisition used to strand its lot (still 'owned', still pointing at
-- the reversed journal) and its settlement reference could never be posted again;
-- a reversed start transfer could not be re-posted because its posting key was
-- taken. The generic journal reversal refuses both (they belong to an operational
-- register), so the correction is its own pair of functions that reverse the
-- journal, release the lot / void the job-cost receipt and keep original,
-- reversal and replacement together. Posting keys gain a revision suffix
-- (':rN') only after an earlier entry under the same reference exists, so every
-- existing key is unchanged and a retry still finds the entry it already posted.
--
-- Requires 20261003048000_starts_release_and_purchasing_fences (the start-transfer
-- function below replaces its worker-fenced version).

create or replace function public.acquire_books_land(
 p_org_id uuid,p_date date,p_allocations jsonb,p_cash_account_id uuid,p_cash_cents bigint,p_debt_instrument_id uuid,p_debt_cents bigint,p_reference text,p_evidence_url text,p_actor_id uuid
) returns uuid language plpgsql security definer set search_path='' as $$
declare item jsonb; base text; revision integer; lot public.lots%rowtype; land uuid; debt public.books_debt_instruments%rowtype; total bigint; policy integer; result_id uuid; lines jsonb:='[]'; n integer:=0; key text; fingerprint text;
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
 base:='land_acquisition:'||lower(btrim(p_reference));
 select count(*) into revision from public.journal_entries e where e.org_id=p_org_id and (e.posting_key=base or left(e.posting_key,length(base)+2)=base||':r');
 key:=case when revision=0 then base else base||':r'||revision end;
 fingerprint:=encode(extensions.digest(jsonb_build_array(p_date,(select jsonb_agg(x order by x->>'lot_id') from jsonb_array_elements(p_allocations) x),p_cash_account_id,p_cash_cents,p_debt_instrument_id,p_debt_cents,p_evidence_url)::text,'sha256'),'hex');
 select e.id into result_id from public.journal_entries e where e.org_id=p_org_id and e.status='posted' and (e.posting_key=base or left(e.posting_key,length(base)+2)=base||':r') order by e.created_at desc limit 1;
 if result_id is not null then
   if not exists(select 1 from public.journal_entries e join public.journal_lines l on l.entry_id=e.id and l.org_id=e.org_id where e.org_id=p_org_id and e.id=result_id and e.status='posted' and l.dimensions->>'acquisition_hash'=fingerprint) then raise exception 'Acquisition reference was already used for different details; reverse it to correct it'; end if;
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

create or replace function public.transfer_books_land_to_start(p_org_id uuid,p_lot_id uuid,p_date date,p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare worker_package public.start_packages%rowtype; lot public.lots%rowtype; land uuid; cip uuid; amount bigint; policy integer; result_id uuid; key text; revision integer; dimensions jsonb;
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
 select count(*) into revision from public.journal_entries e where e.org_id=p_org_id and e.source_type='inventory_start' and e.source_id=lot.id;
 key:='inventory_start:'||lot.id||case when revision=0 then '' else ':r'||revision end;
 select e.id into result_id from public.journal_entries e where e.org_id=p_org_id and e.source_type='inventory_start' and e.source_id=lot.id and e.status='posted';
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

create or replace function public.reverse_books_land_acquisition(p_org_id uuid,p_entry_id uuid,p_date date,p_reason text,p_actor_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare e public.journal_entries%rowtype; rev public.journal_entries%rowtype; land uuid; lot public.lots%rowtype; lot_ids uuid[]; reversal_id uuid; rlines jsonb; amt bigint; net bigint; draw public.books_debt_events%rowtype;
begin
 if length(btrim(coalesce(p_reason,'')))<5 or p_date is null then raise exception 'A reversal date and reason are required'; end if;
 select * into e from public.journal_entries where org_id=p_org_id and id=p_entry_id for update;
 if not found or e.source_type is distinct from 'land_acquisition' then raise exception 'Land acquisition not found'; end if;
 select * into rev from public.journal_entries where org_id=p_org_id and reversal_of_entry_id=e.id and status in('posted','reversed');
 if found then return rev.id; end if;
 if e.status<>'posted' then raise exception 'Only a posted land acquisition can be reversed'; end if;
 select id into land from public.gl_accounts where org_id=p_org_id and code='1120';
 select array_agg(distinct (l.dimensions->>'lot_id')::uuid) into lot_ids from public.journal_lines l where l.org_id=p_org_id and l.entry_id=e.id and l.account_id=land;
 if lot_ids is null then raise exception 'Land acquisition has no lots'; end if;
 for lot in select * from public.lots where org_id=p_org_id and id=any(lot_ids) order by id for update loop
   if lot.books_acquisition_entry_id is distinct from e.id or lot.status<>'owned' then raise exception 'Lot % has moved past ownership; undo its later steps first',lot.lot_number; end if;
   select coalesce(sum(l.debit_cents-l.credit_cents),0) into amt from public.journal_lines l where l.org_id=p_org_id and l.entry_id=e.id and l.account_id=land and l.dimensions->>'lot_id'=lot.id::text;
   select coalesce(sum(l.debit_cents-l.credit_cents),0) into net from public.journal_lines l join public.journal_entries je on je.id=l.entry_id and je.org_id=l.org_id where l.org_id=p_org_id and l.account_id=land and l.dimensions->>'lot_id'=lot.id::text and je.status in('posted','reversed');
   if net<>amt then raise exception 'Lot % has later land entries (a start transfer or development allocation); reverse them first',lot.lot_number; end if;
 end loop;
 select jsonb_agg(jsonb_build_object('line_no',l.line_no,'account_id',l.account_id,'project_id',l.project_id,'company_id',l.company_id,'description',l.description,'debit_cents',l.credit_cents,'credit_cents',l.debit_cents,'dimensions',l.dimensions-'acquisition_hash') order by l.line_no) into rlines
   from public.journal_lines l where l.org_id=p_org_id and l.entry_id=e.id;
 reversal_id:=(public.reverse_books_journal_entry(p_org_id,e.id,jsonb_build_object('fact_id',null,'entry_date',p_date,'entry_kind','reversal','memo','Reversal of '||e.memo||': '||btrim(p_reason),'posting_key','land_acquisition_reversal:'||e.id,'projection_version',e.projection_version,'policy_version',e.policy_version,'source_type',null,'source_id',null,'reversal_of_entry_id',e.id,'created_by',p_actor_id),rlines)->>'id')::uuid;
 select * into draw from public.books_debt_events where org_id=p_org_id and journal_entry_id=e.id and event_type='draw';
 if found then
   insert into public.books_debt_events(org_id,instrument_id,event_type,event_date,principal_cents,journal_entry_id,event_key,memo,created_by)
   values(p_org_id,draw.instrument_id,'payment',p_date,draw.principal_cents,reversal_id,'land_acquisition_reversal:'||e.id,'Reversal of '||draw.memo,p_actor_id);
 end if;
 for lot in select * from public.lots where org_id=p_org_id and id=any(lot_ids) order by id loop
   select coalesce(sum(l.debit_cents),0) into amt from public.journal_lines l where l.org_id=p_org_id and l.entry_id=e.id and l.account_id=land and l.dimensions->>'lot_id'=lot.id::text;
   update public.lots set status='controlled',acquired_date=null,books_acquisition_entry_id=null,cost_basis_cents=nullif(greatest(coalesce(cost_basis_cents,0)-amt,0),0),updated_at=now() where org_id=p_org_id and id=lot.id;
 end loop;
 return reversal_id;
end;
$$;
revoke all on function public.reverse_books_land_acquisition(uuid,uuid,date,text,uuid) from public,anon,authenticated;
grant execute on function public.reverse_books_land_acquisition(uuid,uuid,date,text,uuid) to service_role;

-- Reverses a lot's posted start transfer (and voids its job-cost receipt), then
-- optionally posts it again on p_repost_date. The same date and reason is a retry:
-- it finds the committed reversal and goes straight to the re-post, which is
-- idempotent itself.
create or replace function public.correct_books_land_start_transfer(p_org_id uuid,p_lot_id uuid,p_reversal_date date,p_reason text,p_repost_date date,p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare lot public.lots%rowtype; e public.journal_entries%rowtype; rev public.journal_entries%rowtype; pid uuid; reversal_id uuid; rlines jsonb; outcome jsonb:=null;
begin
 if length(btrim(coalesce(p_reason,'')))<5 or p_reversal_date is null then raise exception 'A reversal date and reason are required'; end if;
 if p_repost_date is not null and p_repost_date<p_reversal_date then raise exception 'The start transfer cannot be posted again before it was reversed'; end if;
 select * into lot from public.lots where org_id=p_org_id and id=p_lot_id for update;
 if not found then raise exception 'Lot not found'; end if;
 -- The same date and reason on a lot whose start was already reversed is a retry, not a second correction.
 select r.* into rev from public.journal_entries r join public.journal_entries o on o.org_id=r.org_id and o.id=r.reversal_of_entry_id
   where r.org_id=p_org_id and o.source_type='inventory_start' and o.source_id=lot.id and r.status='posted' and r.entry_date=p_reversal_date
     and r.memo='Reversal of '||o.memo||': '||btrim(p_reason) limit 1;
 if found then
   reversal_id:=rev.id;
 else
   select * into e from public.journal_entries where org_id=p_org_id and source_type='inventory_start' and source_id=lot.id and status='posted';
   if not found then raise exception 'This lot has no posted start transfer to correct'; end if;
   select l.project_id into pid from public.journal_lines l where l.org_id=p_org_id and l.entry_id=e.id and l.project_id is not null order by l.line_no limit 1;
   perform 1 from public.project_financial_settings where org_id=p_org_id and project_id=pid and books_inventory_enabled and books_inventory_completed_on is null and books_inventory_sold_on is null for update;
   if not found then raise exception 'The home has been completed or sold; the start transfer can no longer be corrected'; end if;
   select jsonb_agg(jsonb_build_object('line_no',l.line_no,'account_id',l.account_id,'project_id',l.project_id,'company_id',l.company_id,'description',l.description,'debit_cents',l.credit_cents,'credit_cents',l.debit_cents,'dimensions',l.dimensions) order by l.line_no) into rlines
     from public.journal_lines l where l.org_id=p_org_id and l.entry_id=e.id;
   reversal_id:=(public.reverse_books_journal_entry(p_org_id,e.id,jsonb_build_object('fact_id',null,'entry_date',p_reversal_date,'entry_kind','reversal','memo','Reversal of '||e.memo||': '||btrim(p_reason),'posting_key','inventory_start_reversal:'||e.id,'projection_version',e.projection_version,'policy_version',e.policy_version,'source_type',null,'source_id',null,'reversal_of_entry_id',e.id,'created_by',p_actor_id),rlines)->>'id')::uuid;
   update public.job_cost_entries set status='voided',metadata=metadata||jsonb_build_object('reversed_by_entry_id',reversal_id),updated_at=now() where org_id=p_org_id and source_type='inventory_event' and source_id=e.id::text;
 end if;
 if p_repost_date is not null then outcome:=public.transfer_books_land_to_start(p_org_id,p_lot_id,p_repost_date,p_actor_id); end if;
 return jsonb_build_object('reversal_entry_id',reversal_id,'transfer',outcome);
end;
$$;
revoke all on function public.correct_books_land_start_transfer(uuid,uuid,date,text,date,uuid) from public,anon,authenticated;
grant execute on function public.correct_books_land_start_transfer(uuid,uuid,date,text,date,uuid) to service_role;
