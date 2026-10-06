-- Private project review reads: bounded source pages and complete selected-root proof.
-- No export snapshot, no temporary tables, no caller-supplied table names.
create index books_payroll_workspace_source_page_idx on public.books_payroll_correction_sources(org_id, prepared_at desc, id desc);
create index books_payroll_workspace_source_run_idx on public.books_payroll_correction_sources using gin(run jsonb_path_ops);
create index books_payroll_workspace_import_run_idx on public.books_payroll_imports using gin(run jsonb_path_ops);
create index books_payroll_workspace_job_root_idx on public.job_cost_entries(org_id, (metadata->>'payroll_original_posting_id')) where source_type='payroll_correction';
create index books_payroll_workspace_job_receipt_idx on public.job_cost_entries(org_id, (metadata->>'payroll_correction_posting_id')) where source_type='payroll_correction';
create index books_payroll_workspace_job_original_idx on public.job_cost_entries(org_id, (metadata->>'payroll_posting_id')) where source_type='payroll_import';
create index books_payroll_workspace_liability_code_idx on public.journal_lines(org_id, ((dimensions->'books_account_classification')->>'code'), entry_id);

create function public.capture_books_payroll_workspace_snapshot(
 p_org_id uuid, p_project_id uuid, p_source_id uuid default null,
 p_before_time timestamptz default null, p_before_id uuid default null, p_limit integer default 50
) returns jsonb language plpgsql stable security invoker
set search_path = pg_catalog, public
as $$
declare
 v_page jsonb; v_ids uuid[]; v_roots uuid[]; v_imports uuid[]; v_projects uuid[];
 v_jobs uuid[]; v_native_journals uuid[]; v_native_facts uuid[]; v_times uuid[];
 v_liability_journals uuid[]; v_journals uuid[]; v_facts uuid[]; v_codes uuid[];
 v_table text; v_predicate text; v_rows jsonb; v_tables jsonb := '{}'::jsonb;
 v_more boolean; v_next jsonb; v_project jsonb;
begin
 if p_org_id is null or p_project_id is null or p_limit is null or p_limit not between 1 and 50
   or (p_before_time is null) <> (p_before_id is null)
   or (p_source_id is not null and p_before_time is not null) then
  raise exception 'Invalid payroll workspace scope or pagination';
 end if;
 select to_jsonb(p) into v_project from public.projects p where p.org_id=p_org_id and p.id=p_project_id;
 if v_project is null then raise exception 'Project is unavailable in this organization'; end if;
 with affected_roots as (
  select p.id from public.books_payroll_postings p
  join public.books_payroll_imports i on i.org_id=p.org_id and i.id=p.payroll_import_id
  where p.org_id=p_org_id and i.run @> jsonb_build_object('employees',jsonb_build_array(jsonb_build_object('allocations',jsonb_build_array(jsonb_build_object('project_id',p_project_id)))))
  union
  select s.posting_id from public.books_payroll_correction_sources s where s.org_id=p_org_id
  and s.run @> jsonb_build_object('employees',jsonb_build_array(jsonb_build_object('allocations',jsonb_build_array(jsonb_build_object('project_id',p_project_id)))))
 ), page as (
  select s.id,s.posting_id,s.prepared_at from public.books_payroll_correction_sources s
  where s.org_id=p_org_id and s.posting_id in(select id from affected_roots)
  and (p_source_id is null or s.id=p_source_id)
  and (p_before_time is null or (s.prepared_at,s.id)<(p_before_time,p_before_id))
  order by s.prepared_at desc,s.id desc limit p_limit+1
 ) select coalesce(jsonb_agg(to_jsonb(page) order by prepared_at desc,id desc),'[]'::jsonb) into v_page from page;
 if p_source_id is not null and jsonb_array_length(v_page)<>1 then raise exception 'Payroll correction does not affect this project or is unavailable';end if;
 v_more := jsonb_array_length(v_page)>p_limit;
 if v_more then v_page := v_page - p_limit; end if;
 select coalesce(array_agg((r->>'id')::uuid order by ordinal),'{}'::uuid[]),coalesce(array_agg(distinct (r->>'posting_id')::uuid),'{}'::uuid[])
 into v_ids,v_roots from jsonb_array_elements(v_page) with ordinality x(r,ordinal);
 if cardinality(v_ids)=0 then
  return jsonb_build_object('orgId',p_org_id,'projectId',p_project_id,'projectName',coalesce(v_project->>'name','Project'),
   'sourceIds','[]'::jsonb,'nextCursor',null,'capturedAt',statement_timestamp(),'databaseSnapshot',pg_current_snapshot()::text,
   'tables',jsonb_build_object('projects',jsonb_build_array(v_project),'books_payroll_correction_sources','[]'::jsonb));
 end if;
 if v_more then v_next:=jsonb_build_object('preparedAt',v_page->(p_limit-1)->'prepared_at','id',v_page->(p_limit-1)->'id');end if;
 select coalesce(array_agg(p.payroll_import_id),'{}'::uuid[]) into v_imports from public.books_payroll_postings p where p.org_id=p_org_id and p.id=any(v_roots);
 select coalesce(array_agg(distinct (a->>'project_id')::uuid) filter(where a->>'project_id' is not null),'{}'::uuid[]),
        coalesce(array_agg(distinct (a->>'cost_code_id')::uuid) filter(where a->>'cost_code_id' is not null),'{}'::uuid[])
 into v_projects,v_codes from (
  select i.run from public.books_payroll_imports i where i.org_id=p_org_id and i.id=any(v_imports)
  union all select s.run from public.books_payroll_correction_sources s where s.org_id=p_org_id and s.posting_id=any(v_roots)
 ) runs cross join lateral jsonb_array_elements(runs.run->'employees') w cross join lateral jsonb_array_elements(w->'allocations') a;
 v_projects:=array_append(v_projects,p_project_id);
 select coalesce(array_agg(distinct o.job_cost_entry_id),'{}'::uuid[]),coalesce(array_agg(distinct o.journal_id),'{}'::uuid[]),
 coalesce(array_agg(distinct o.fact_id),'{}'::uuid[]),coalesce(array_agg(distinct o.time_entry_id),'{}'::uuid[])
 into v_jobs,v_native_journals,v_native_facts,v_times from public.books_payroll_labor_ownership o where o.org_id=p_org_id and o.posting_id=any(v_roots);
 -- Preserve original IDs even if native ownership has been damaged: proof must fail.
 select v_jobs || coalesce(array_agg((e->>'id')::uuid),'{}'::uuid[]),
 v_native_journals || coalesce(array_agg((e->>'journal_id')::uuid),'{}'::uuid[]),
 v_native_facts || coalesce(array_agg((e->>'fact_id')::uuid),'{}'::uuid[])
 into v_jobs,v_native_journals,v_native_facts
 from public.books_payroll_imports i cross join lateral jsonb_array_elements(i.labor_evidence) e where i.org_id=p_org_id and i.id=any(v_imports);
 -- Full organization liability attribution remains required; both current chart and
 -- frozen original classification select movements. Fetch every balancing line.
 select coalesce(array_agg(distinct l.entry_id),'{}'::uuid[]) into v_liability_journals
 from public.journal_lines l left join public.gl_accounts a on a.org_id=l.org_id and a.id=l.account_id
 left join public.journal_entries j on j.org_id=l.org_id and j.id=l.entry_id
 where l.org_id=p_org_id and j.source_type is distinct from 'labor_cost' and (a.code in('2200','2230') or l.dimensions->'books_account_classification'->>'code' in('2200','2230'));
 select coalesce(array_agg(j.id),'{}'::uuid[]) into v_journals from public.journal_entries j where j.org_id=p_org_id and (
 j.id=any(v_native_journals) or j.id=any(v_liability_journals)
 or (j.source_type='payroll_import' and j.source_id=any(v_imports))
 or (j.source_type='payroll_correction' and j.source_id in(select s.id from public.books_payroll_correction_sources s where s.org_id=p_org_id and s.posting_id=any(v_roots)))
 or j.id in(select (r.result->>'journalId')::uuid from public.books_payroll_correction_postings r where r.org_id=p_org_id and r.posting_id=any(v_roots))
 or j.id in(select (r->>'journalId')::uuid from public.books_payroll_postings p cross join lateral jsonb_array_elements(p.result->'journals') r where p.org_id=p_org_id and p.id=any(v_roots)));
 select coalesce(array_agg(f.id),'{}'::uuid[]) into v_facts from public.accounting_facts f where f.org_id=p_org_id and (
 f.id=any(v_native_facts) or f.id in(select j.fact_id from public.journal_entries j where j.org_id=p_org_id and j.id=any(v_journals))
 or (f.source_type='payroll_import' and f.source_id=any(v_imports))
 or (f.source_type='payroll_correction' and f.source_id in(select s.id from public.books_payroll_correction_sources s where s.org_id=p_org_id and s.posting_id=any(v_roots)))
 or f.id in(select (r.result->>'factId')::uuid from public.books_payroll_correction_postings r where r.org_id=p_org_id and r.posting_id=any(v_roots))
 or f.id in(select (r->>'factId')::uuid from public.books_payroll_postings p cross join lateral jsonb_array_elements(p.result->'journals') r where p.org_id=p_org_id and p.id=any(v_roots)));
  foreach v_table in array array['books_payroll_imports','books_payroll_postings','books_payroll_posting_proposals','books_payroll_payment_reviews','books_payroll_labor_ownership','books_payroll_correction_sources','books_payroll_correction_proposals','books_payroll_correction_postings','projects','cost_codes','gl_accounts','accounting_periods','project_financial_settings','contracts','closings','budgets','budget_lines','billable_costs','job_cost_entries','journal_entries','journal_lines','accounting_facts','books_projection_receipts','time_entries'] loop
  v_predicate:=case v_table
   when 'books_payroll_imports' then 't.id=any($3)'
   when 'books_payroll_postings' then 't.id=any($2)'
   when 'books_payroll_posting_proposals' then 't.payroll_import_id=any($3)'
   when 'books_payroll_payment_reviews' then 't.payroll_import_id=any($3)'
   when 'books_payroll_labor_ownership' then 't.posting_id=any($2)'
   when 'books_payroll_correction_sources' then 't.posting_id=any($2)'
   when 'books_payroll_correction_proposals' then 't.posting_id=any($2)'
   when 'books_payroll_correction_postings' then 't.posting_id=any($2)'
   when 'projects' then 't.id=any($4)'
   when 'cost_codes' then 't.id=any($10)'
   when 'gl_accounts' then 'true'
   when 'accounting_periods' then 'true'
   when 'project_financial_settings' then 't.project_id=any($4)'
   when 'contracts' then 't.project_id=any($4)'
   when 'closings' then 't.project_id=any($4)'
   when 'budgets' then 't.project_id=any($4)'
   when 'budget_lines' then 't.budget_id in(select b.id from public.budgets b where b.org_id=$1 and b.project_id=any($4))
 or t.id::text in(select x->>''id'' from public.books_payroll_imports i cross join lateral jsonb_array_elements(i.reconciliation->''workflowEvidence''->''sourceTables''->''budget_lines'') x where i.org_id=$1 and i.id=any($3))
 or t.id::text in(select x->>''id'' from public.books_payroll_correction_proposals p cross join lateral jsonb_array_elements(p.plan->''context''->''budget_lines'') x where p.org_id=$1 and p.posting_id=any($2))'
   when 'billable_costs' then 't.id::text in(select x #>> ''{}'' from public.books_payroll_postings p cross join lateral jsonb_array_elements(p.result->''billingPreserved'') x where p.org_id=$1 and p.id=any($2))
 or t.id::text in(select x #>> ''{}'' from public.books_payroll_correction_postings p cross join lateral jsonb_array_elements(p.result->''billingPreserved'') x where p.org_id=$1 and p.posting_id=any($2))'
   when 'job_cost_entries' then 't.id=any($5) or (t.source_type=''payroll_import'' and t.metadata->>''payroll_posting_id''=any(select r::text from unnest($2) r))
 or (t.source_type=''payroll_correction'' and (t.metadata->>''payroll_original_posting_id''=any(select r::text from unnest($2) r)
 or t.metadata->>''payroll_correction_posting_id'' in(select r.id::text from public.books_payroll_correction_postings r where r.org_id=$1 and r.posting_id=any($2))))
 or t.id::text in(select x->>''jobCostId'' from public.books_payroll_postings p cross join lateral jsonb_array_elements(p.result->''jobCostCorrections'') x where p.org_id=$1 and p.id=any($2))
 or t.id::text in(select x->>''jobCostId'' from public.books_payroll_correction_postings p cross join lateral jsonb_array_elements(p.result->''jobCosts'') x where p.org_id=$1 and p.posting_id=any($2))'
   when 'journal_entries' then 't.id=any($6)'
   when 'journal_lines' then 't.entry_id=any($6) or t.entry_id=any($11)'
   when 'accounting_facts' then 't.id=any($7)'
   when 'books_projection_receipts' then 't.source_id=any($5) or t.journal_id=any($8)'
   when 'time_entries' then 't.id=any($9) or t.id::text in(select j.source_id from public.job_cost_entries j where j.org_id=$1 and j.id=any($5))'
   else null end;
  execute format('select coalesce(jsonb_agg(to_jsonb(t) order by t.id), ''[]''::jsonb) from public.%I t where t.org_id=$1 and (%s)',v_table,v_predicate)
  into v_rows using p_org_id,v_roots,v_imports,v_projects,v_jobs,v_journals,v_facts,v_native_journals,v_times,v_codes,v_liability_journals;
  v_tables:=v_tables || jsonb_build_object(v_table,v_rows);
 end loop;
 return jsonb_build_object('orgId',p_org_id,'projectId',p_project_id,'projectName',coalesce(v_project->>'name','Project'),
  'sourceIds',to_jsonb(v_ids),'nextCursor',v_next,'capturedAt',statement_timestamp(),'databaseSnapshot',pg_current_snapshot()::text,'tables',v_tables);
end;
$$;
revoke all on function public.capture_books_payroll_workspace_snapshot(uuid,uuid,uuid,timestamptz,uuid,integer) from public,anon,authenticated;
grant execute on function public.capture_books_payroll_workspace_snapshot(uuid,uuid,uuid,timestamptz,uuid,integer) to service_role;
