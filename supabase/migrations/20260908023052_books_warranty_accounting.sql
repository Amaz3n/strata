-- Visit figures are submitted estimates until an office reviewer links real posted costs.
alter table public.warranty_service_visits
 add column books_cost_sources jsonb not null default '[]'::jsonb,
 add column books_approved_cost_cents bigint not null default 0 check(books_approved_cost_cents>=0),
 add column books_reserve_consumed_cents bigint not null default 0 check(books_reserve_consumed_cents>=0),
 add column books_cost_approved_by uuid references public.app_users(id) on delete restrict,
 add column books_cost_approved_at timestamptz,
 add column books_cost_date date,
 add column books_cost_evidence_url text,
 add column books_cost_journal_entry_id uuid references public.journal_entries(id) on delete restrict;
create index warranty_books_cost_sources_idx on public.warranty_service_visits using gin(books_cost_sources);
create index warranty_books_cost_review_idx on public.warranty_service_visits(org_id,project_id,books_cost_approved_at);
create index warranty_books_cost_reviewer_idx on public.warranty_service_visits(books_cost_approved_by);
create index warranty_books_cost_journal_idx on public.warranty_service_visits(books_cost_journal_entry_id);
alter table public.project_financial_settings add column books_warranty_reserve_cents bigint not null default 0 check(books_warranty_reserve_cents>=0), add column books_warranty_reserve_evidence_url text, add column books_warranty_provisioned_on date;
insert into public.gl_accounts(org_id,code,name,account_type,subtype,normal_balance,cash_flow_category,is_system,active)
select org_id,'2260','Warranty reserve','liability','other_liability','credit','operating',true,true from public.books_settings on conflict(org_id,code) do nothing;

create or replace function public.post_books_warranty_reserve(p_org_id uuid,p_project_id uuid,p_date date,p_initial boolean,p_actor_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare s public.project_financial_settings%rowtype; reserve uuid; expense uuid; current_cents bigint; delta bigint; policy integer; revision integer; result_id uuid; dimensions jsonb;
begin
 select * into s from public.project_financial_settings where org_id=p_org_id and project_id=p_project_id for update;
 if not found or (p_initial and s.books_warranty_provisioned_on is not null) then return null; end if;
 if s.books_warranty_reserve_cents>0 and coalesce(s.books_warranty_reserve_evidence_url,'') not like 'https://%' then raise exception 'Warranty reserve requires an approved estimate'; end if;
 select id into reserve from public.gl_accounts where org_id=p_org_id and code='2260' and active;
 select id into expense from public.gl_accounts where org_id=p_org_id and code='5050' and active;
 select active_policy_version into policy from public.books_settings where org_id=p_org_id and workspace_enabled and arc_ledger_mode<>'disabled';
 if not found then return null; end if;
 select coalesce(sum(l.credit_cents-l.debit_cents),0) into current_cents from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id where l.org_id=p_org_id and l.project_id=p_project_id and l.account_id=reserve and e.status in('posted','reversed') and e.entry_date<=p_date;
 delta:=s.books_warranty_reserve_cents-current_cents;
 if delta<>0 then
   if reserve is null or expense is null then raise exception 'Warranty reserve accounts are missing'; end if;
   select count(*)+1 into revision from public.journal_entries where org_id=p_org_id and source_type='warranty_reserve' and source_id=p_project_id;
   dimensions:=jsonb_build_object('warranty_reserve_adjustment',true,'evidence_url',s.books_warranty_reserve_evidence_url,'estimate_cents',s.books_warranty_reserve_cents);
   result_id:=public.post_books_journal_entry(p_org_id,jsonb_build_object('entry_date',p_date,'entry_kind','adjusting','memo','Approved warranty reserve estimate','posting_key','warranty_reserve:'||p_project_id||':'||revision,'projection_version',1,'policy_version',policy,'source_type','warranty_reserve','source_id',p_project_id,'created_by',p_actor_id),
   jsonb_build_array(jsonb_build_object('line_no',1,'account_id',expense,'project_id',p_project_id,'debit_cents',greatest(delta,0),'credit_cents',greatest(-delta,0),'dimensions',dimensions),jsonb_build_object('line_no',2,'account_id',reserve,'project_id',p_project_id,'debit_cents',greatest(-delta,0),'credit_cents',greatest(delta,0),'dimensions',dimensions)));
 end if;
 if p_initial then update public.project_financial_settings set books_warranty_provisioned_on=p_date where org_id=p_org_id and project_id=p_project_id; end if;
 return result_id;
end;
$$;
revoke all on function public.post_books_warranty_reserve(uuid,uuid,date,boolean,uuid) from public,anon,authenticated;
grant execute on function public.post_books_warranty_reserve(uuid,uuid,date,boolean,uuid) to service_role;

create or replace function public.approve_books_warranty_cost(p_org_id uuid,p_visit_id uuid,p_date date,p_sources jsonb,p_evidence_url text,p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare visit public.warranty_service_visits%rowtype; item jsonb; cost public.job_cost_entries%rowtype; used bigint; total bigint:=0; covered bigint; reserve uuid; expense uuid; available bigint; result_id uuid; policy integer; source_kind text; resolved_source_id uuid; dimensions jsonb;
begin
 if jsonb_typeof(p_sources)<>'array' or jsonb_array_length(p_sources)=0 or p_evidence_url not like 'https://%' then raise exception 'Posted source costs and supporting evidence are required'; end if;
 if (select count(*) from jsonb_array_elements(p_sources))<>(select count(distinct x->>'job_cost_entry_id') from jsonb_array_elements(p_sources) x) then raise exception 'Cost sources must be unique'; end if;
 perform 1 from public.job_cost_entries j where j.org_id=p_org_id and j.id in(select (x->>'job_cost_entry_id')::uuid from jsonb_array_elements(p_sources) x) order by j.id for update;
 select * into visit from public.warranty_service_visits where org_id=p_org_id and id=p_visit_id for update;
 if not found or visit.status<>'completed' then raise exception 'Only completed warranty visits can receive cost approval'; end if;
 if visit.books_cost_approved_at is not null then
   if visit.books_cost_sources=p_sources and visit.books_cost_date=p_date and visit.books_cost_evidence_url=p_evidence_url then return jsonb_build_object('id',visit.books_cost_journal_entry_id,'approved_cents',visit.books_approved_cost_cents,'reserve_cents',visit.books_reserve_consumed_cents); end if;
   raise exception 'Reverse the prior cost approval before changing its sources';
 end if;
 perform 1 from public.project_financial_settings where org_id=p_org_id and project_id=visit.project_id for update;
 for item in select x from jsonb_array_elements(p_sources) x loop
   select * into cost from public.job_cost_entries where org_id=p_org_id and id=(item->>'job_cost_entry_id')::uuid;
   if not found or cost.project_id<>visit.project_id or cost.status<>'posted' or cost.cost_cents<=0 or cost.incurred_on>p_date or (item->>'amount_cents')::bigint<=0 then raise exception 'Select positive posted costs from this visit project on or before the approval date'; end if;
   source_kind:=case cost.source_type when 'vendor_bill_line' then 'vendor_bill' when 'project_expense_line' then 'expense' when 'project_expense' then 'expense' when 'time_entry' then 'labor_cost' when 'bank_transaction' then 'bank_transaction' else null end;
   resolved_source_id:=case cost.source_type when 'vendor_bill_line' then (select bill_id from public.bill_lines where org_id=p_org_id and id=cost.source_id) when 'project_expense_line' then (select expense_id from public.project_expense_lines where org_id=p_org_id and id=cost.source_id) when 'time_entry' then cost.id else cost.source_id end;
   if source_kind is null or not exists(select 1 from public.journal_entries e where e.org_id=p_org_id and e.source_type=source_kind and e.source_id=resolved_source_id and e.status='posted') then raise exception 'Post the actual cost source to Books before allocating it to warranty'; end if;
   select coalesce(sum((allocation->>'amount_cents')::bigint),0) into used from public.warranty_service_visits v cross join lateral jsonb_array_elements(v.books_cost_sources) allocation where v.org_id=p_org_id and v.books_cost_approved_at is not null and allocation->>'job_cost_entry_id'=cost.id::text;
   if used+(item->>'amount_cents')::bigint>cost.cost_cents then raise exception 'Warranty allocations exceed the actual source cost'; end if;
   total:=total+(item->>'amount_cents')::bigint;
 end loop;
 select id into reserve from public.gl_accounts where org_id=p_org_id and code='2260' and active;
 select id into expense from public.gl_accounts where org_id=p_org_id and code='5050' and active;
 select coalesce(sum(l.credit_cents-l.debit_cents),0) into available from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id where l.org_id=p_org_id and l.project_id=visit.project_id and l.account_id=reserve and e.status in('posted','reversed') and e.entry_date<=p_date;
 covered:=least(total,greatest(available,0));
 if covered>0 then
   if expense is null then raise exception 'Warranty expense account is missing'; end if;
   select active_policy_version into policy from public.books_settings where org_id=p_org_id;
   dimensions:=jsonb_build_object('warranty_reserve_adjustment',true,'warranty_visit_id',visit.id,'evidence_url',p_evidence_url,'actual_sources',p_sources);
   result_id:=public.post_books_journal_entry(p_org_id,jsonb_build_object('entry_date',p_date,'entry_kind','adjusting','memo','Consume warranty reserve for approved actual cost','posting_key','warranty_cost:'||visit.id||':'||encode(extensions.digest(p_sources::text||p_date::text||now()::text,'sha256'),'hex'),'projection_version',1,'policy_version',policy,'source_type','warranty_reserve_consumption','source_id',visit.id,'created_by',p_actor_id),
   jsonb_build_array(jsonb_build_object('line_no',1,'account_id',reserve,'project_id',visit.project_id,'debit_cents',covered,'credit_cents',0,'dimensions',dimensions),jsonb_build_object('line_no',2,'account_id',expense,'project_id',visit.project_id,'debit_cents',0,'credit_cents',covered,'dimensions',dimensions)));
 end if;
 update public.warranty_service_visits set books_cost_sources=p_sources,books_approved_cost_cents=total,books_reserve_consumed_cents=covered,books_cost_approved_by=p_actor_id,books_cost_approved_at=now(),books_cost_date=p_date,books_cost_evidence_url=p_evidence_url,books_cost_journal_entry_id=result_id,updated_at=now() where org_id=p_org_id and id=visit.id;
 return jsonb_build_object('id',result_id,'approved_cents',total,'reserve_cents',covered);
end;
$$;
revoke all on function public.approve_books_warranty_cost(uuid,uuid,date,jsonb,text,uuid) from public,anon,authenticated;
grant execute on function public.approve_books_warranty_cost(uuid,uuid,date,jsonb,text,uuid) to service_role;

create or replace function public.reverse_books_warranty_cost(p_org_id uuid,p_visit_id uuid,p_date date,p_reason text,p_actor_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare visit public.warranty_service_visits%rowtype; original public.journal_entries%rowtype; lines jsonb;
begin
 select * into visit from public.warranty_service_visits where org_id=p_org_id and id=p_visit_id for update;
 if not found then raise exception 'Visit not found'; end if;
 if visit.books_cost_approved_at is null then return; end if;
 if p_date<visit.books_cost_date or length(btrim(p_reason))<10 then raise exception 'A reversal date and explanation are required'; end if;
 if visit.books_cost_journal_entry_id is not null then
   select * into original from public.journal_entries where org_id=p_org_id and id=visit.books_cost_journal_entry_id;
   select jsonb_agg(jsonb_build_object('line_no',l.line_no,'account_id',l.account_id,'project_id',l.project_id,'company_id',l.company_id,'debit_cents',l.credit_cents,'credit_cents',l.debit_cents,'description',p_reason,'dimensions',l.dimensions) order by l.line_no) into lines from public.journal_lines l where l.org_id=p_org_id and l.entry_id=original.id;
   perform public.reverse_books_journal_entry(p_org_id,original.id,jsonb_build_object('entry_date',p_date,'entry_kind','reversal','memo','Reverse warranty approval: '||p_reason,'posting_key','reverse_warranty_cost:'||original.id,'projection_version',original.projection_version,'policy_version',original.policy_version,'reversal_of_entry_id',original.id,'created_by',p_actor_id),lines);
 end if;
 update public.warranty_service_visits set metadata=metadata||jsonb_build_object('books_cost_review_history',coalesce(metadata->'books_cost_review_history','[]'::jsonb)||jsonb_build_array(jsonb_build_object('sources',books_cost_sources,'approved_at',books_cost_approved_at,'approved_by',books_cost_approved_by,'cost_cents',books_approved_cost_cents,'journal_entry_id',books_cost_journal_entry_id,'reversed_on',p_date,'reason',p_reason))),books_cost_sources='[]',books_approved_cost_cents=0,books_reserve_consumed_cents=0,books_cost_approved_by=null,books_cost_approved_at=null,books_cost_date=null,books_cost_evidence_url=null,books_cost_journal_entry_id=null,updated_at=now() where org_id=p_org_id and id=p_visit_id;
end;
$$;
revoke all on function public.reverse_books_warranty_cost(uuid,uuid,date,text,uuid) from public,anon,authenticated;
grant execute on function public.reverse_books_warranty_cost(uuid,uuid,date,text,uuid) to service_role;

create or replace function public.guard_books_warranty_approval()
returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='INSERT' then
   if current_user not in('postgres','service_role') and (new.books_cost_approved_at is not null or new.books_cost_sources<>'[]'::jsonb or new.books_approved_cost_cents<>0 or new.books_reserve_consumed_cents<>0 or new.books_cost_journal_entry_id is not null) then raise exception 'Warranty accounting approvals require the Books service'; end if;
   return new;
 end if;
 if current_user not in('postgres','service_role') and (
   to_jsonb(new)->'books_cost_sources' is distinct from to_jsonb(old)->'books_cost_sources' or
   to_jsonb(new)->'books_cost_approved_at' is distinct from to_jsonb(old)->'books_cost_approved_at' or
   to_jsonb(new)->'books_approved_cost_cents' is distinct from to_jsonb(old)->'books_approved_cost_cents' or
   to_jsonb(new)->'books_reserve_consumed_cents' is distinct from to_jsonb(old)->'books_reserve_consumed_cents' or
   to_jsonb(new)->'books_cost_journal_entry_id' is distinct from to_jsonb(old)->'books_cost_journal_entry_id') then raise exception 'Warranty accounting approvals require the Books service'; end if;
 return new;
end;
$$;
create trigger books_warranty_approval_guard before insert or update on public.warranty_service_visits for each row execute function public.guard_books_warranty_approval();

create or replace function public.guard_books_allocated_warranty_cost()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if (tg_op='DELETE' or (new.cost_cents,new.project_id,new.status,new.source_type,new.source_id,new.incurred_on,new.cost_code_id) is distinct from (old.cost_cents,old.project_id,old.status,old.source_type,old.source_id,old.incurred_on,old.cost_code_id)) and exists(select 1 from public.warranty_service_visits v where v.org_id=old.org_id and v.books_cost_approved_at is not null and v.books_cost_sources @> jsonb_build_array(jsonb_build_object('job_cost_entry_id',old.id))) then raise exception 'Reverse the linked warranty cost approval before changing this cost source'; end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end;
$$;
revoke all on function public.guard_books_allocated_warranty_cost() from public,anon,authenticated;
create trigger books_warranty_source_guard before update or delete on public.job_cost_entries for each row execute function public.guard_books_allocated_warranty_cost();

create or replace function public.set_books_warranty_estimate(p_org_id uuid,p_project_id uuid,p_date date,p_amount_cents bigint,p_evidence_url text,p_actor_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare provisioned date;
begin
 if p_amount_cents<0 or p_evidence_url not like 'https://%' then raise exception 'Approved remaining warranty estimate and evidence are required'; end if;
 perform 1 from public.projects where org_id=p_org_id and id=p_project_id for update;
 if not found then raise exception 'Project not found'; end if;
 select books_warranty_provisioned_on into provisioned from public.project_financial_settings where org_id=p_org_id and project_id=p_project_id for update;
 if provisioned is not null and p_date<provisioned then raise exception 'Estimate revision cannot precede initial provision'; end if;
 insert into public.project_financial_settings(org_id,project_id,billing_model,books_warranty_reserve_cents,books_warranty_reserve_evidence_url,created_by,updated_by) values(p_org_id,p_project_id,'fixed_price',p_amount_cents,p_evidence_url,p_actor_id,p_actor_id)
 on conflict(org_id,project_id) do update set books_warranty_reserve_cents=p_amount_cents,books_warranty_reserve_evidence_url=p_evidence_url,updated_by=p_actor_id;
 if provisioned is not null then perform public.post_books_warranty_reserve(p_org_id,p_project_id,p_date,false,p_actor_id); end if;
end;
$$;
revoke all on function public.set_books_warranty_estimate(uuid,uuid,date,bigint,text,uuid) from public,anon,authenticated;
grant execute on function public.set_books_warranty_estimate(uuid,uuid,date,bigint,text,uuid) to service_role;

create or replace function public.guard_books_warranty_policy()
returns trigger language plpgsql set search_path='' as $$
begin
 if current_user not in('postgres','service_role') then
   if tg_op='INSERT' then
     if new.books_warranty_reserve_cents<>0 or new.books_warranty_provisioned_on is not null then raise exception 'Warranty reserve policy requires the Books service'; end if;
   elsif (new.books_warranty_reserve_cents,new.books_warranty_reserve_evidence_url,new.books_warranty_provisioned_on) is distinct from (old.books_warranty_reserve_cents,old.books_warranty_reserve_evidence_url,old.books_warranty_provisioned_on) then raise exception 'Warranty reserve policy requires the Books service'; end if;
 end if;
 return new;
end;
$$;
create trigger books_warranty_policy_guard before insert or update on public.project_financial_settings for each row execute function public.guard_books_warranty_policy();

-- Cost analytics use approved source actuals. Backcharge face values are recovery
-- claims, not additional spending; adding them double-counted remediation.
do $$ declare fn record; definition text; begin
 for fn in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in('warranty_cost_summary','warranty_defect_analysis_scoped') loop
   definition:=pg_get_functiondef(fn.oid);
   definition:=replace(definition,'coalesce(v.internal_labor_cents, 0) + coalesce(v.internal_material_cents, 0)','case when v.books_cost_approved_at is not null then v.books_approved_cost_cents else 0 end');
   definition:=replace(definition,'coalesce(sum(pb.cost_cents), 0) + coalesce(sum(iv.internal_cents), 0)','coalesce(sum(iv.internal_cents), 0)');
   definition:=replace(definition,'coalesce(rb.backcharge_cents, 0) + coalesce(ri.internal_cents, 0)','coalesce(ri.internal_cents, 0)');
   execute definition;
 end loop;
end $$;

-- Restore only reserve-backed costs recovered by posted vendor credits. Operational
-- backcharge status alone never establishes a recovery; a reversing bill unwinds it.
create or replace function public.reconcile_books_warranty_recovery(p_org_id uuid,p_request_id uuid,p_date date)
returns uuid language plpgsql security definer set search_path='' as $$
declare project uuid; reserve uuid; expense uuid; covered bigint; credited bigint; restored bigint; delta bigint; revision integer; policy integer; result_id uuid; dimensions jsonb;
begin
 select project_id into project from public.warranty_requests where org_id=p_org_id and id=p_request_id for update;
 if not found then raise exception 'Warranty request not found'; end if;
 perform 1 from public.project_financial_settings where org_id=p_org_id and project_id=project for update;
 select id into reserve from public.gl_accounts where org_id=p_org_id and code='2260' and active;
 select id into expense from public.gl_accounts where org_id=p_org_id and code='5050' and active;
 select coalesce(sum(books_reserve_consumed_cents),0) into covered from public.warranty_service_visits where org_id=p_org_id and request_id=p_request_id and books_cost_approved_at is not null and books_cost_date<=p_date;
 select greatest(-coalesce(sum(l.debit_cents-l.credit_cents),0),0) into credited
 from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id join public.gl_accounts a on a.id=l.account_id and a.org_id=l.org_id
 where l.org_id=p_org_id and e.status in('posted','reversed') and e.entry_date<=p_date and a.account_type='cogs' and coalesce(e.source_id,(select original.source_id from public.journal_entries original where original.id=e.reversal_of_entry_id and original.org_id=e.org_id)) in (
   select vendor_credit_bill_id from public.warranty_backcharges where org_id=p_org_id and warranty_request_id=p_request_id
   union all select (metadata->>'reversal_bill_id')::uuid from public.warranty_backcharges where org_id=p_org_id and warranty_request_id=p_request_id and metadata->>'reversal_bill_id' is not null
 );
 select coalesce(sum(l.credit_cents-l.debit_cents),0) into restored from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id where l.org_id=p_org_id and l.account_id=reserve and l.dimensions->>'warranty_recovery_request_id'=p_request_id::text and e.status in('posted','reversed') and e.entry_date<=p_date;
 delta:=least(covered,credited)-restored;
 if delta=0 then return null; end if;
 if reserve is null or expense is null then raise exception 'Warranty recovery accounts are missing'; end if;
 select active_policy_version into policy from public.books_settings where org_id=p_org_id;
 select count(*)+1 into revision from public.journal_entries where org_id=p_org_id and source_type='warranty_reserve_recovery' and source_id=p_request_id;
 dimensions:=jsonb_build_object('warranty_reserve_adjustment',true,'warranty_recovery_request_id',p_request_id,'covered_cents',covered,'posted_recovery_cents',credited);
 result_id:=public.post_books_journal_entry(p_org_id,jsonb_build_object('entry_date',p_date,'entry_kind','adjusting','memo','Reconcile reserve-backed warranty recovery','posting_key','warranty_recovery:'||p_request_id||':'||revision,'projection_version',1,'policy_version',policy,'source_type','warranty_reserve_recovery','source_id',p_request_id),
 jsonb_build_array(jsonb_build_object('line_no',1,'account_id',expense,'project_id',project,'debit_cents',greatest(delta,0),'credit_cents',greatest(-delta,0),'dimensions',dimensions),jsonb_build_object('line_no',2,'account_id',reserve,'project_id',project,'debit_cents',greatest(-delta,0),'credit_cents',greatest(delta,0),'dimensions',dimensions)));
 return result_id;
end;
$$;
revoke all on function public.reconcile_books_warranty_recovery(uuid,uuid,date) from public,anon,authenticated;
grant execute on function public.reconcile_books_warranty_recovery(uuid,uuid,date) to service_role;
