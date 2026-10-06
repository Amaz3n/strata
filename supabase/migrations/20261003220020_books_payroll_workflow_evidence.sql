-- Frozen construction/payment source witnesses inside versioned reconciliation
-- JSON. No new columns, posting transition or money movement. Older ledger-only
-- evidence remains retained/readable and is not a complete posting approval.
create function public.books_payroll_liability_source_revision(p_snapshot jsonb,p_run jsonb)
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
revoke all on function public.books_payroll_liability_source_revision(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.books_payroll_liability_source_revision(jsonb,jsonb) to service_role;

create function public.books_payroll_workflow_sources(p_snapshot jsonb,p_run jsonb)
returns jsonb language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
declare result jsonb; name text;
begin
 if p_snapshot->>'orgId' is distinct from p_run->>'org_id' then raise exception 'Payroll workflow organization mismatch'; end if;
 foreach name in array array['job_cost_entries','budgets','budget_lines','billable_costs','journal_entries','journal_lines','gl_accounts'] loop
  if jsonb_typeof(p_snapshot->'tables'->name) is distinct from 'array' then raise exception 'Missing payroll workflow population %',name; end if;
  if exists(select 1 from jsonb_array_elements(p_snapshot->'tables'->name) r where r.value->>'org_id' is distinct from p_run->>'org_id') then raise exception 'Foreign payroll workflow source'; end if;
 end loop;
 with requested as(select e.value#>>'{}' id from jsonb_array_elements(p_run->'employees') w cross join lateral jsonb_array_elements(w.value->'allocations') a cross join lateral jsonb_array_elements(a.value->'labor_evidence_ids') e),
 jobs as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'job_cost_entries') r where r.value->>'id' in(select id from requested)),
 budget_lines as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'budget_lines') r where r.value->>'id' in(select value->>'budget_line_id' from jobs)),
 budgets as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'budgets') r where r.value->>'id' in(select value->>'budget_id' from budget_lines)),
 billables as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'billable_costs') r where r.value->>'source_type'='time_entry' and r.value->>'source_id' in(select value->>'source_id' from jobs) or r.value->>'id' in(select value->>'billable_cost_id' from jobs)),
 liability_accounts as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'gl_accounts') r where r.value->>'code' in('2200','2230')),
 liability_lines as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'journal_lines') r where r.value->>'account_id' in(select value->>'id' from liability_accounts) or r.value#>>'{dimensions,books_account_classification,code}' in('2200','2230')),
 entries as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'journal_entries') r where r.value->>'id' in(select value->>'entry_id' from liability_lines) and r.value->>'status' in('posted','reversed') and r.value->>'source_type' is distinct from 'labor_cost'),
 lines as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'journal_lines') r where r.value->>'entry_id' in(select value->>'id' from entries)),
 codes as(select '2200' code union select '2230' union select a.value->>'cost_account_code' from jsonb_array_elements(p_run->'employees') w cross join lateral jsonb_array_elements(w.value->'allocations') a),
 accounts as(select r.value from jsonb_array_elements(p_snapshot->'tables'->'gl_accounts') r where r.value->>'code' in(select code from codes) or r.value->>'id' in(select value->>'account_id' from lines))
 select jsonb_build_object('job_cost_entries',coalesce((select jsonb_agg(value order by value->>'id') from jobs),'[]'),'budget_lines',coalesce((select jsonb_agg(value order by value->>'id') from budget_lines),'[]'),'budgets',coalesce((select jsonb_agg(value order by value->>'id') from budgets),'[]'),'billable_costs',coalesce((select jsonb_agg(value order by value->>'id') from billables),'[]'),'journal_entries',coalesce((select jsonb_agg(value order by value->>'id') from entries),'[]'),'journal_lines',coalesce((select jsonb_agg(value order by value->>'id') from lines),'[]'),'gl_accounts',coalesce((select jsonb_agg(value order by value->>'id') from accounts),'[]')) into result;
 return result;
end $$;
revoke all on function public.books_payroll_workflow_sources(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.books_payroll_workflow_sources(jsonb,jsonb) to service_role;

-- Keep the existing function OID so prepared SQL callers receive v3 too.
create or replace function public.books_payroll_source_revision(p_snapshot jsonb,p_run jsonb)
returns text language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
begin
 return encode(sha256(convert_to(jsonb_build_object('version',3,'previous_revision',public.books_payroll_liability_source_revision(p_snapshot,p_run),'workflow_sources',public.books_payroll_workflow_sources(p_snapshot,p_run))::text,'UTF8')),'hex');
end $$;
revoke all on function public.books_payroll_source_revision(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.books_payroll_source_revision(jsonb,jsonb) to service_role;

create function public.guard_books_payroll_workflow_evidence() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare proof jsonb; sources jsonb; construction jsonb; worker jsonb; allocation jsonb; item jsonb; expected_components jsonb; corrections jsonb;
 native_gross numeric; native_burden numeric; native_cost numeric; actual_cost numeric; delta numeric; project_delta numeric:=0; overhead_delta numeric:=0;
 count_expected integer:=0; count_observed integer; budget_id text; gmp text; wages numeric; deductions numeric; amount_key text;
begin
 if tg_op='UPDATE' and new.status='withdrawn' then return new; end if;
 -- Legacy evidence remains immutable/readable. Any future posting transition
 -- must require v2 evidence plus resolved attribution, never this legacy branch.
 if not(new.reconciliation ? 'evidenceVersion') and not(new.reconciliation ? 'workflowEvidence') then return new; end if;
 if new.reconciliation->'evidenceVersion' is distinct from '2'::jsonb then raise exception 'Unsupported payroll workflow evidence version'; end if;
 proof:=new.reconciliation->'workflowEvidence'; construction:=proof->'constructionImpact';
 if proof->'version' is distinct from '1'::jsonb or construction->>'runId' is distinct from new.id::text or construction->'previewOnly' is distinct from 'true'::jsonb or construction->'postingImplemented' is distinct from 'false'::jsonb or proof#>>'{liabilityHistory,orgId}' is distinct from new.org_id::text or proof#>'{liabilityHistory,unpaidStatusProven}' is distinct from 'false'::jsonb then raise exception 'Payroll workflow requires scoped advisory construction and liability evidence'; end if;
 sources:=public.books_payroll_workflow_sources(public.capture_books_export_snapshot(new.org_id),new.run);
 if proof->'sourceTables' is distinct from sources then raise exception 'Payroll workflow source records changed or are incomplete'; end if;
 for worker in select value from jsonb_array_elements(new.run->'employees') loop
  for allocation in select value from jsonb_array_elements(worker->'allocations') loop
   count_expected:=count_expected+1;
   select count(*) into count_observed from jsonb_array_elements(construction->'allocations') r where r.value->>'allocationId'=allocation->>'id';
   if count_observed<>1 then raise exception 'Payroll workflow requires every allocation exactly once'; end if;
   select value into item from jsonb_array_elements(construction->'allocations') r where r.value->>'allocationId'=allocation->>'id';
   foreach amount_key in array array['originalCostCents','actualCostCents','costDeltaCents'] loop
    if jsonb_typeof(item->amount_key) is distinct from 'number' then raise exception 'Payroll workflow costs require JSON integer cents'; end if;
   end loop;
   if item->>'workerId' is distinct from worker->>'worker_id' or item->>'projectId' is distinct from allocation->>'project_id' or item->>'costCodeId' is distinct from allocation->>'cost_code_id' or item->>'accountCode' is distinct from allocation->>'cost_account_code' or item->>'incurredOn' is distinct from new.run->>'accrual_date' then raise exception 'Payroll workflow allocation identity differs'; end if;
   select coalesce(sum((e.value->>'gross_cents')::numeric),0),coalesce(sum((e.value->>'estimated_burden_cents')::numeric),0),coalesce(sum((e.value->>'cost_cents')::numeric),0) into native_gross,native_burden,native_cost from jsonb_array_elements(new.labor_evidence) e where e.value->>'id' in(select value#>>'{}' from jsonb_array_elements(allocation->'labor_evidence_ids'));
   actual_cost:=public.books_payroll_exact_amount(allocation->'gross_cents')+public.books_payroll_exact_amount(allocation->'employer_taxes_cents')+public.books_payroll_exact_amount(allocation->'employer_benefits_cents'); delta:=actual_cost-native_cost;
   if (item->>'originalCostCents')::numeric is distinct from native_cost or (item->>'actualCostCents')::numeric is distinct from actual_cost or (item->>'costDeltaCents')::numeric is distinct from delta then raise exception 'Payroll workflow costs differ from original and actual wages'; end if;
   select coalesce(jsonb_agg(jsonb_build_object('component',component,'costCents',amount) order by position),'[]') into expected_components from(values
    (1,'gross_variance',public.books_payroll_exact_amount(allocation->'gross_cents')-native_gross),(2,'estimated_burden_release',-native_burden),(3,'employer_taxes',public.books_payroll_exact_amount(allocation->'employer_taxes_cents')),(4,'employer_benefits',public.books_payroll_exact_amount(allocation->'employer_benefits_cents'))) c(position,component,amount) where amount<>0;
   if item->'components' is distinct from expected_components then raise exception 'Payroll workflow signed components differ'; end if;
   corrections:='[]';
   if allocation->>'project_id' is not null then
    project_delta:=project_delta+delta;
    select coalesce(jsonb_agg(value||jsonb_build_object('sourceType','payroll_import','sourceKey',new.id::text||':'||(allocation->>'id')||':'||(value->>'component')) order by ordinality),'[]') into corrections from jsonb_array_elements(expected_components) with ordinality;
   else overhead_delta:=overhead_delta+delta; end if;
   if item->'jobCostCorrections' is distinct from corrections then raise exception 'Payroll workflow project corrections differ'; end if;
   budget_id:=null;gmp:=null;
   if allocation->>'project_id' is not null and jsonb_array_length(expected_components)>0 then
    select case when count(distinct coalesce(r.value->>'budget_line_id','~'))=1 then max(r.value->>'budget_line_id') end,case when count(distinct coalesce(r.value->>'gmp_classification','~'))=1 then max(r.value->>'gmp_classification') end into budget_id,gmp from jsonb_array_elements(sources->'job_cost_entries') r where r.value->>'id' in(select value#>>'{}' from jsonb_array_elements(allocation->'labor_evidence_ids'));
   end if;
   if item->>'budgetLineId' is distinct from budget_id or item->>'gmpClassification' is distinct from gmp then raise exception 'Payroll workflow original budget or GMP attribution differs'; end if;
  end loop;
 end loop;
 if jsonb_typeof(construction->'projectCostDeltaCents') is distinct from 'number' or jsonb_typeof(construction->'overheadCostDeltaCents') is distinct from 'number' then raise exception 'Payroll workflow totals require JSON integer cents'; end if;
 if jsonb_array_length(construction->'allocations') is distinct from count_expected or (construction->>'projectCostDeltaCents')::numeric is distinct from project_delta or (construction->>'overheadCostDeltaCents')::numeric is distinct from overhead_delta then raise exception 'Payroll workflow cost totals or allocation population differ'; end if;
 if jsonb_typeof(proof#>'{liabilityHistory,organizationWagesMovementCents}') is distinct from 'number' or jsonb_typeof(proof#>'{liabilityHistory,organizationDeductionsMovementCents}') is distinct from 'number' then raise exception 'Payroll workflow liabilities require JSON integer cents'; end if;
 select coalesce(sum(case when code='2200' then movement else 0 end),0),coalesce(sum(case when code='2230' then movement else 0 end),0) into wages,deductions from(select coalesce(l.value#>>'{dimensions,books_account_classification,code}',(select a.value->>'code' from jsonb_array_elements(sources->'gl_accounts') a where a.value->>'id'=l.value->>'account_id')) code,(l.value->>'credit_cents')::numeric-(l.value->>'debit_cents')::numeric movement from jsonb_array_elements(sources->'journal_lines') l) movements;
 if jsonb_array_length(proof#>'{liabilityHistory,movements}') is distinct from jsonb_array_length(sources->'journal_entries') or (proof#>>'{liabilityHistory,organizationWagesMovementCents}')::numeric is distinct from wages or (proof#>>'{liabilityHistory,organizationDeductionsMovementCents}')::numeric is distinct from deductions or proof#>'{liabilityHistory,requiresSettlementAttribution}' is distinct from to_jsonb(jsonb_array_length(sources->'journal_entries')>0) then raise exception 'Payroll workflow liability history differs from recorded payments'; end if;
 return new;
end $$;
create trigger books_payroll_workflow_guard before insert or update on public.books_payroll_imports for each row execute function public.guard_books_payroll_workflow_evidence();
revoke all on function public.guard_books_payroll_workflow_evidence() from public,anon,authenticated;
