-- Independent arithmetic verification only. No journal, cash or construction
-- write and no posting authority is introduced by these service-only helpers.
create function public.books_payroll_posting_plan_math(p_parent jsonb,p_payment jsonb)
returns jsonb language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
declare
 run jsonb:=p_parent->'run'; worker jsonb; allocation jsonb; original jsonb; operational jsonb; decision jsonb; claim jsonb; source_journal jsonb; line jsonb; component jsonb;
 allocation_rows jsonb:='[]'; components jsonb; outstanding jsonb; liability_bridge jsonb; dated jsonb:='{}'; journals jsonb:='[]'; retained jsonb:='[]'; dimensions jsonb; common jsonb; rows jsonb; claims jsonb;
 parent_id text:=p_parent->>'id'; org_id text:=p_parent->>'org_id'; payment_id text:=p_payment->>'id'; date_key text; debit_code text; credit_code text; account_code text;
 gross numeric; burden numeric; native_cost numeric; actual_cost numeric; tax numeric; deduction numeric; prior_gross numeric; prior_tax_cost numeric; prior_benefit_cost numeric; prior_cost numeric;
 net_paid numeric; tax_reclass numeric; deduction_reclass numeric; tax_paid numeric; deduction_paid numeric; employer_tax_paid numeric; employer_benefit_paid numeric;
 wage_original numeric; wage_delta numeric; deductions_original numeric; deductions_delta numeric; ledger_delta numeric; operational_delta numeric; amount numeric; attribution numeric; code text;
begin
 if p_parent->>'status' is distinct from 'reviewed' or run->>'id' is distinct from parent_id or run->>'org_id' is distinct from org_id or p_parent#>'{reconciliation,evidenceVersion}' is distinct from '2'::jsonb or p_parent->>'reviewed_by' is null or p_parent->>'reviewed_by'=p_parent->>'prepared_by' then raise exception 'Payroll posting requires independently reviewed v2 parent'; end if;
 if p_payment is not null and (p_payment->>'status' is distinct from 'reviewed' or p_payment->>'org_id' is distinct from org_id or p_payment->>'payroll_import_id' is distinct from parent_id or p_payment->>'reviewed_by' is null or p_payment->>'reviewed_by'=p_payment->>'prepared_by' or p_payment->>'reviewed_by'=p_parent->>'prepared_by' or p_payment#>>'{evidence,payroll_reconciliation_digest}' is distinct from p_parent->>'reconciliation_digest') then raise exception 'Payroll posting requires separate reviewed payment ownership'; end if;
 if p_payment is null and jsonb_array_length(p_parent#>'{reconciliation,workflowEvidence,sourceTables,journal_entries}')<>0 then raise exception 'Payroll posting requires reviewed payment decisions'; end if;
 select coalesce(jsonb_agg(c.value),'[]') into claims from jsonb_array_elements(coalesce(p_payment#>'{request,decisions}','[]')) d cross join lateral jsonb_array_elements(d.value->'claims') c;
 for worker in select value from jsonb_array_elements(run->'employees') order by value->>'worker_id' loop
  for allocation in select value from jsonb_array_elements(worker->'allocations') order by value->>'id' loop
   select coalesce(sum((e.value->>'gross_cents')::numeric),0),coalesce(sum((e.value->>'estimated_burden_cents')::numeric),0) into gross,burden from jsonb_array_elements(p_parent->'labor_evidence') e where allocation->'labor_evidence_ids' @> jsonb_build_array(e.value->>'id');
   native_cost:=gross+burden; actual_cost:=(allocation->>'gross_cents')::numeric+(allocation->>'employer_taxes_cents')::numeric+(allocation->>'employer_benefits_cents')::numeric;
   tax:=public.books_payroll_payment_component_limit(run,(allocation->>'id')::uuid,'employee_taxes_payment');deduction:=public.books_payroll_payment_component_limit(run,(allocation->>'id')::uuid,'employee_deductions_payment');
   select coalesce(sum((c.value->>'signed_cents')::numeric) filter(where c.value->>'component'='gross_wages_recognition'),0),
    coalesce(sum((c.value->>'signed_cents')::numeric) filter(where c.value->>'component'='employer_taxes_recognition'),0),coalesce(sum((c.value->>'signed_cents')::numeric) filter(where c.value->>'component'='employer_benefits_recognition'),0),
    coalesce(sum((c.value->>'signed_cents')::numeric) filter(where c.value->>'component'='net_pay_payment'),0),coalesce(sum((c.value->>'signed_cents')::numeric) filter(where c.value->>'component'='employee_taxes_reclassification'),0),coalesce(sum((c.value->>'signed_cents')::numeric) filter(where c.value->>'component'='employee_deductions_reclassification'),0),
    coalesce(sum((c.value->>'signed_cents')::numeric) filter(where c.value->>'component'='employee_taxes_payment'),0),coalesce(sum((c.value->>'signed_cents')::numeric) filter(where c.value->>'component'='employee_deductions_payment'),0),coalesce(sum((c.value->>'signed_cents')::numeric) filter(where c.value->>'component'='employer_taxes_payment'),0),coalesce(sum((c.value->>'signed_cents')::numeric) filter(where c.value->>'component'='employer_benefits_payment'),0)
   into prior_gross,prior_tax_cost,prior_benefit_cost,net_paid,tax_reclass,deduction_reclass,tax_paid,deduction_paid,employer_tax_paid,employer_benefit_paid from jsonb_array_elements(claims) c where c.value->>'allocation_id'=allocation->>'id' and c.value->>'worker_id'=worker->>'worker_id';
   prior_cost:=prior_gross+prior_tax_cost+prior_benefit_cost;operational_delta:=actual_cost-native_cost;ledger_delta:=operational_delta-prior_cost;
   select value into operational from jsonb_array_elements(p_parent#>'{reconciliation,workflowEvidence,constructionImpact,allocations}') a where a.value->>'allocationId'=allocation->>'id';
   if operational is null or operational->'originalCostCents' is distinct from to_jsonb(native_cost) or operational->'costDeltaCents' is distinct from to_jsonb(operational_delta) or operational->'actualCostCents' is distinct from to_jsonb(actual_cost) then raise exception 'Payroll native/project cost bridge differs'; end if;
   dimensions:=jsonb_build_object('payroll_run_id',parent_id,'payroll_worker_id',worker->>'worker_id','payroll_allocation_id',allocation->>'id');
   if allocation->>'cost_code_id' is not null then dimensions:=dimensions||jsonb_build_object('cost_code_id',allocation->>'cost_code_id');end if;
   if payment_id is not null then dimensions:=dimensions||jsonb_build_object('payroll_payment_review_id',payment_id);end if;
   account_code:=allocation->>'cost_account_code';
   -- Accrual pairs are recomputed from provider amounts and native basis, not
   -- copied from the application journal or stored reconciliation draft.
   components:=jsonb_build_array(
    jsonb_build_object('component','gross_variance','debit',account_code,'credit','2200','amount',(allocation->>'gross_cents')::numeric-gross),
    jsonb_build_object('component','estimated_burden_release','debit','2200','credit',account_code,'amount',burden),
    jsonb_build_object('component','employee_taxes','debit','2200','credit','2230','amount',tax),jsonb_build_object('component','employee_deductions','debit','2200','credit','2230','amount',deduction),
    jsonb_build_object('component','employer_taxes','debit',account_code,'credit','2230','amount',(allocation->>'employer_taxes_cents')::numeric),jsonb_build_object('component','employer_benefits','debit',account_code,'credit','2230','amount',(allocation->>'employer_benefits_cents')::numeric));
   date_key:=run->>'accrual_date';rows:=coalesce(dated->date_key,'[]');
   for component in select value from jsonb_array_elements(components) loop
    amount:=(component->>'amount')::numeric;if amount=0 then continue;end if;
    common:=jsonb_build_object('dimensions',dimensions||jsonb_build_object('payroll_component',component->>'component'),'description','Payroll '||(component->>'component'));
    if allocation->>'project_id' is not null then common:=common||jsonb_build_object('projectId',allocation->>'project_id');end if;
    rows:=rows||jsonb_build_array(common||jsonb_build_object('accountCode',component->>'debit','debitCents',greatest(amount,0),'creditCents',greatest(-amount,0)),common||jsonb_build_object('accountCode',component->>'credit','debitCents',greatest(-amount,0),'creditCents',greatest(amount,0)));
   end loop;
   if jsonb_array_length(rows)>0 then dated:=dated||jsonb_build_object(date_key,rows);end if;
   components:=jsonb_build_array(jsonb_build_object('component','gross_variance','signedCents',(allocation->>'gross_cents')::numeric-gross-prior_gross),jsonb_build_object('component','estimated_burden_release','signedCents',burden),jsonb_build_object('component','employee_taxes','signedCents',tax-tax_reclass),jsonb_build_object('component','employee_deductions','signedCents',deduction-deduction_reclass),jsonb_build_object('component','employer_taxes','signedCents',(allocation->>'employer_taxes_cents')::numeric-prior_tax_cost),jsonb_build_object('component','employer_benefits','signedCents',(allocation->>'employer_benefits_cents')::numeric-prior_benefit_cost));
   outstanding:=jsonb_build_object('netPayCents',(allocation->>'gross_cents')::numeric-tax-deduction-net_paid,'employeeTaxesCents',tax-tax_paid,'employeeDeductionsCents',deduction-deduction_paid,'employerTaxesCents',(allocation->>'employer_taxes_cents')::numeric-employer_tax_paid,'employerBenefitsCents',(allocation->>'employer_benefits_cents')::numeric-employer_benefit_paid);
   if exists(select 1 from jsonb_each_text(outstanding) o where o.value::numeric<0) then raise exception 'Payroll recorded claims exceed remaining obligations';end if;
   wage_original:=native_cost+prior_gross-net_paid-tax_reclass-deduction_reclass;wage_delta:=(allocation->>'gross_cents')::numeric-gross-prior_gross-burden-tax+tax_reclass-deduction+deduction_reclass;
   deductions_original:=tax_reclass+deduction_reclass+prior_tax_cost+prior_benefit_cost-tax_paid-deduction_paid-employer_tax_paid-employer_benefit_paid;
   deductions_delta:=tax-tax_reclass+deduction-deduction_reclass+(allocation->>'employer_taxes_cents')::numeric-prior_tax_cost+(allocation->>'employer_benefits_cents')::numeric-prior_benefit_cost;
   if wage_original+wage_delta<>(outstanding->>'netPayCents')::numeric or deductions_original+deductions_delta<>(outstanding->>'employeeTaxesCents')::numeric+(outstanding->>'employeeDeductionsCents')::numeric+(outstanding->>'employerTaxesCents')::numeric+(outstanding->>'employerBenefitsCents')::numeric then raise exception 'Payroll owned liability bridge differs';end if;
   liability_bridge:=jsonb_build_object('wages',jsonb_build_object('originalCents',wage_original,'deltaCents',wage_delta,'remainingCents',wage_original+wage_delta),'deductions',jsonb_build_object('originalCents',deductions_original,'deltaCents',deductions_delta,'remainingCents',deductions_original+deductions_delta));
   allocation_rows:=allocation_rows||jsonb_build_array(jsonb_build_object('workerId',worker->>'worker_id','allocationId',allocation->>'id','projectId',allocation->'project_id','costCodeId',allocation->'cost_code_id','accountCode',account_code,'originalLedgerCostCents',native_cost+prior_cost,'priorNonNativeLedgerCostCents',prior_cost,'ledgerCostDeltaCents',ledger_delta,'originalOperationalCostCents',native_cost,'operationalCostDeltaCents',operational_delta,'actualCostCents',actual_cost,'ledgerOperationalBridgeCents',prior_cost,'components',components,'outstanding',outstanding,'liabilityBridge',liability_bridge,'construction',operational));
  end loop;
 end loop;
 for decision in select value from jsonb_array_elements(coalesce(p_payment#>'{request,decisions}','[]')) order by value->>'journal_id' loop
  select value into source_journal from jsonb_array_elements(p_parent#>'{reconciliation,workflowEvidence,sourceTables,journal_entries}') j where j.value->>'id'=decision->>'journal_id';
  if source_journal is null then raise exception 'Payroll prior claim original journal is missing';end if;
  for claim in select value from jsonb_array_elements(decision->'claims') order by value->>'id' loop
   if claim->>'component' not like '%_recognition' and claim->>'component' not like '%_reclassification' then continue;end if;
   select a.value into allocation from jsonb_array_elements(run->'employees') w cross join lateral jsonb_array_elements(w.value->'allocations') a where w.value->>'worker_id'=claim->>'worker_id' and a.value->>'id'=claim->>'allocation_id';
   if allocation is null then raise exception 'Payroll prior claim allocation is missing';end if;
   date_key:=greatest((run->>'accrual_date')::date,(source_journal->>'entry_date')::date)::text;
   debit_code:=case when claim->>'component'='gross_wages_recognition' then '2200' else '2230' end;
   credit_code:=case when claim->>'component' like '%_reclassification' then '2200' else allocation->>'cost_account_code' end;
   amount:=(claim->>'signed_cents')::numeric;
   dimensions:=jsonb_build_object('payroll_run_id',parent_id,'payroll_worker_id',claim->>'worker_id','payroll_allocation_id',allocation->>'id','payroll_payment_review_id',payment_id,'payroll_prior_claim_id',claim->>'id','payroll_original_journal_id',decision->>'journal_id','payroll_component','prior_'||(claim->>'component')||'_offset');
   if allocation->>'cost_code_id' is not null then dimensions:=dimensions||jsonb_build_object('cost_code_id',allocation->>'cost_code_id');end if;
   common:=jsonb_build_object('dimensions',dimensions,'description','Offset recorded payroll '||(claim->>'component'));
   if allocation->>'project_id' is not null then common:=common||jsonb_build_object('projectId',allocation->>'project_id');end if;
   rows:=coalesce(dated->date_key,'[]')||jsonb_build_array(common||jsonb_build_object('accountCode',debit_code,'debitCents',greatest(amount,0),'creditCents',greatest(-amount,0)),common||jsonb_build_object('accountCode',credit_code,'debitCents',greatest(-amount,0),'creditCents',greatest(amount,0)));
   dated:=dated||jsonb_build_object(date_key,rows);
  end loop;
 end loop;
 for date_key,rows in select key,value from jsonb_each(dated) order by key loop
  if exists(select 1 from jsonb_array_elements(rows) l where jsonb_typeof(l.value->'debitCents') is distinct from 'number' or jsonb_typeof(l.value->'creditCents') is distinct from 'number' or greatest((l.value->>'debitCents')::numeric,(l.value->>'creditCents')::numeric)>9007199254740991) or (select sum((l.value->>'debitCents')::numeric-(l.value->>'creditCents')::numeric) from jsonb_array_elements(rows) l)<>0 then raise exception 'Payroll dated journal is unbalanced or unsafe';end if;
  journals:=journals||jsonb_build_array(jsonb_build_object('entryDate',date_key,'entryKind','adjusting','memo','Reviewed payroll reconciliation '||(run->>'provider')||' '||(run->>'provider_run_id'),'postingKey','payroll_import:'||parent_id||':'||date_key||':s1:v2','projectionVersion',2,'policyVersion',1,'sourceType','payroll_import','sourceId',parent_id,'lines',rows));
 end loop;
 -- Preserve movement/line order from the independently retained history.
 for original in select value from jsonb_array_elements(p_parent#>'{reconciliation,workflowEvidence,liabilityHistory,movements}') loop
  for line in select value from jsonb_array_elements(original->'lines') loop
   code:=line->>'accountCode';if code not in('2200','2230') then continue;end if;
   select coalesce(sum((c.value->>'claimed_cents')::numeric),0) into attribution from jsonb_array_elements(coalesce(p_payment#>'{evidence,source_line_claims}','[]')) c where c.value->>'line_id'=line->>'id';
   select value into decision from jsonb_array_elements(coalesce(p_payment#>'{request,decisions}','[]')) d where d.value->>'journal_id'=original#>>'{journal,id}';
   retained:=retained||jsonb_build_array(jsonb_build_object('lineId',line->>'id','journalId',original#>>'{journal,id}','accountCode',code,'recordedDebitCents',line->'debit_cents','recordedCreditCents',line->'credit_cents','attributedCents',attribution,'unclaimedCents',(line->>'debit_cents')::numeric+(line->>'credit_cents')::numeric-attribution,'disposition',decision->>'disposition'));
  end loop;
 end loop;
 select jsonb_build_object('netPayCents',coalesce(sum((a.value#>>'{outstanding,netPayCents}')::numeric),0),'employeeTaxesCents',coalesce(sum((a.value#>>'{outstanding,employeeTaxesCents}')::numeric),0),'employeeDeductionsCents',coalesce(sum((a.value#>>'{outstanding,employeeDeductionsCents}')::numeric),0),'employerTaxesCents',coalesce(sum((a.value#>>'{outstanding,employerTaxesCents}')::numeric),0),'employerBenefitsCents',coalesce(sum((a.value#>>'{outstanding,employerBenefitsCents}')::numeric),0)) into outstanding from jsonb_array_elements(allocation_rows) a;
 return jsonb_build_object('version',1,'runId',parent_id,'orgId',org_id,'parentReconciliationDigest',p_parent->>'reconciliation_digest','sourceRevision',p_parent->>'source_revision','paymentReviewId',payment_id,'paymentEvidenceDigest',p_payment->>'evidence_digest','allocations',allocation_rows,'journalDrafts',journals,'retainedLiabilityLines',retained,
 'ledgerCostDeltaCents',(select coalesce(sum((a.value->>'ledgerCostDeltaCents')::numeric),0) from jsonb_array_elements(allocation_rows) a),'operationalCostDeltaCents',(select coalesce(sum((a.value->>'operationalCostDeltaCents')::numeric),0) from jsonb_array_elements(allocation_rows) a),'priorNonNativeLedgerCostCents',(select coalesce(sum((a.value->>'priorNonNativeLedgerCostCents')::numeric),0) from jsonb_array_elements(allocation_rows) a),'outstanding',outstanding,
 'requiresAllocationReview',p_parent#>'{reconciliation,workflowEvidence,constructionImpact,requiresAllocationReview}','requiresBillingReview',p_parent#>'{reconciliation,workflowEvidence,constructionImpact,requiresBillingReview}','runOwnedBalancesOnly',true,'organizationBalancesProven',false,'requiresCommitRevalidation',true,'previewOnly',true,'postingImplemented',false);
end $$;
revoke all on function public.books_payroll_posting_plan_math(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.books_payroll_posting_plan_math(jsonb,jsonb) to service_role;

create function public.verify_books_payroll_posting_plan(p_org_id uuid,p_parent_id uuid,p_plan jsonb)
returns boolean language plpgsql security invoker set search_path=pg_catalog,public as $$
declare parent public.books_payroll_imports; payment public.books_payroll_payment_reviews; expected jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('payroll-import:'||p_org_id::text,0));
 select * into parent from public.books_payroll_imports where org_id=p_org_id and id=p_parent_id for share;
 if not found then raise exception 'Payroll posting parent is unavailable in organization';end if;
 select * into payment from public.books_payroll_payment_reviews where org_id=p_org_id and payroll_import_id=p_parent_id and status<>'withdrawn' for share;
 if public.books_payroll_source_revision(public.capture_books_export_snapshot(p_org_id),parent.run) is distinct from parent.source_revision then raise exception 'Payroll posting source revision changed';end if;
 expected:=public.books_payroll_posting_plan_math(to_jsonb(parent),case when payment.id is null then null else to_jsonb(payment) end);
 if jsonb_typeof(p_plan) is distinct from 'object' or p_plan-'digest' is distinct from expected then raise exception 'Payroll posting proposal differs from independently reconstructed dated journals and allocation balances';end if;
 return true;
end $$;
revoke all on function public.verify_books_payroll_posting_plan(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.verify_books_payroll_posting_plan(uuid,uuid,jsonb) to service_role;
