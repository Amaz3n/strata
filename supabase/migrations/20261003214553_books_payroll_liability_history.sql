-- Preserve the original function identity so existing prepared PL/pgSQL callers
-- use the widened dependency vector. Previously prepared runs intentionally
-- become stale and require withdrawal/repreparation; never rewrite their proof.
create function public.books_payroll_labor_source_revision(p_snapshot jsonb,p_run jsonb)
returns text language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
declare basis jsonb; table_name text;
begin
 if p_snapshot->>'orgId' is distinct from p_run->>'org_id' then raise exception 'Payroll snapshot organization mismatch'; end if;
 foreach table_name in array array['time_entries','job_cost_entries','accounting_facts','journal_entries','journal_lines','books_projection_receipts','gl_accounts'] loop
  if jsonb_typeof(p_snapshot->'tables'->table_name) is distinct from 'array' then raise exception 'Missing payroll source table %',table_name; end if;
  if exists(select 1 from jsonb_array_elements(p_snapshot->'tables'->table_name) r where r.value->>'org_id' is distinct from p_run->>'org_id') then raise exception 'Foreign payroll source rows'; end if;
 end loop;
 with workers as(select value->>'worker_id' id from jsonb_array_elements(p_run->'employees')),
 requested as(select e.value#>>'{}' id from jsonb_array_elements(p_run->'employees') w cross join lateral jsonb_array_elements(w.value->'allocations') a cross join lateral jsonb_array_elements(a.value->'labor_evidence_ids') e),
 times as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'time_entries') r where (r.value->>'work_date' between p_run->>'period_start' and p_run->>'period_end') and (r.value->>'worker_user_id' in(select id from workers) or r.value->>'worker_user_id' is null)
  or r.value->>'id' in(select c.value->>'source_id' from jsonb_array_elements(p_snapshot->'tables'->'job_cost_entries') c where c.value->>'id' in(select id from requested))),
 costs as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'job_cost_entries') r where r.value->>'source_type'='time_entry' and (r.value->>'id' in(select id from requested) or r.value->>'source_id' in(select value->>'id' from times) or (r.value->>'incurred_on' between p_run->>'period_start' and p_run->>'period_end') and (r.value#>>'{metadata,worker_user_id}' in(select id from workers) or r.value#>>'{metadata,worker_user_id}' is null))),
 facts as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'accounting_facts') r where r.value->>'source_type'='labor_cost' and (r.value->>'source_id' in(select value->>'id' from costs) or (r.value->>'accounting_date' between p_run->>'period_start' and p_run->>'period_end') and (r.value#>>'{payload,labor_basis,worker_id}' in(select id from workers) or r.value#>>'{payload,labor_basis,worker_id}' is null))),
 entries as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'journal_entries') r where r.value->>'source_type'='labor_cost' and (r.value->>'source_id' in(select value->>'id' from costs) or r.value->>'fact_id' in(select value->>'id' from facts) or (r.value->>'entry_date' between p_run->>'period_start' and p_run->>'period_end') and not exists(select 1 from jsonb_array_elements(p_snapshot->'tables'->'accounting_facts') f where f.value->>'id'=r.value->>'fact_id'))),
 lines as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'journal_lines') r where r.value->>'entry_id' in(select value->>'id' from entries)),
 receipts as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'books_projection_receipts') r where r.value->>'source_type'='labor_cost' and r.value->>'source_id' in(select value->>'id' from costs union select value->>'source_id' from facts)),
 codes as(select '2200' code union select '2230' union select a.value->>'cost_account_code' from jsonb_array_elements(p_run->'employees') w cross join lateral jsonb_array_elements(w.value->'allocations') a),
 accounts as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'gl_accounts') r where r.value->>'code' in(select code from codes) or r.value->>'id' in(select value->>'account_id' from lines))
 select jsonb_build_object('times',coalesce((select jsonb_agg(value order by value->>'id') from times),'[]'), 'costs',coalesce((select jsonb_agg(value order by value->>'id') from costs),'[]'), 'facts',coalesce((select jsonb_agg(value order by value->>'id') from facts),'[]'), 'entries',coalesce((select jsonb_agg(value order by value->>'id') from entries),'[]'), 'lines',coalesce((select jsonb_agg(value order by value->>'id') from lines),'[]'), 'receipts',coalesce((select jsonb_agg(value order by value->>'source_id') from receipts),'[]'), 'accounts',coalesce((select jsonb_agg(value order by value->>'id') from accounts),'[]')) into basis;
 return encode(sha256(convert_to(basis::text,'UTF8')),'hex');
end $$;
revoke all on function public.books_payroll_labor_source_revision(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.books_payroll_labor_source_revision(jsonb,jsonb) to service_role;


create or replace function public.books_payroll_source_revision(p_snapshot jsonb,p_run jsonb)
returns text language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
declare labor_revision text; history jsonb;
begin
 labor_revision:=public.books_payroll_labor_source_revision(p_snapshot,p_run);
 -- Native labor already participates in the worker/source vector above.
 -- Non-labor wage/deduction movements have no reliable worker-period ownership
 -- in legacy/manual settlements. Capture all history, including future-dated
 -- entries and both original/reversal journals, rather than guessing that a
 -- payment outside the work period belongs to a different payroll run.
 with accounts as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'gl_accounts') r where r.value->>'code' in('2200','2230')),
 liability_lines as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'journal_lines') r where r.value->>'account_id' in(select value->>'id' from accounts) or r.value#>>'{dimensions,books_account_classification,code}' in('2200','2230')),
 entries as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'journal_entries') r where r.value->>'status' in('posted','reversed') and r.value->>'source_type' is distinct from 'labor_cost' and r.value->>'id' in(select value->>'entry_id' from liability_lines)),
 lines as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'journal_lines') r where r.value->>'entry_id' in(select value->>'id' from entries))
 select jsonb_build_object('entries',coalesce((select jsonb_agg(value order by value->>'id') from entries),'[]'),'lines',coalesce((select jsonb_agg(value order by value->>'id') from lines),'[]')) into history;
 return encode(sha256(convert_to(jsonb_build_object('version',2,'labor_revision',labor_revision,'liability_history',history)::text,'UTF8')),'hex');
end $$;
revoke all on function public.books_payroll_source_revision(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.books_payroll_source_revision(jsonb,jsonb) to service_role;
