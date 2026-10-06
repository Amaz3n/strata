-- Independent provider-only correction arithmetic. These helpers authorize no
-- money writes. A reviewed source is documentary evidence, not a posting review.
create function public.books_payroll_apportion_cents(p_amount jsonb,p_capacities jsonb)
returns jsonb language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
declare amount numeric:=public.books_payroll_exact_amount(p_amount); total numeric; result jsonb;
begin
 if jsonb_typeof(p_capacities) is distinct from 'array' or jsonb_array_length(p_capacities)=0
 or exists(select 1 from jsonb_array_elements(p_capacities) x where jsonb_typeof(x.value) is distinct from 'object' or x.value-array['id','cents']<>'{}'::jsonb or (x.value->>'id')::uuid is null)
 or (select count(*) from jsonb_array_elements(p_capacities))<>(select count(distinct (value->>'id')::uuid) from jsonb_array_elements(p_capacities)) then raise exception 'Payroll capacities require unique allocation identities';end if;
 select sum(public.books_payroll_exact_amount(value->'cents')) into total from jsonb_array_elements(p_capacities);
 if total>9007199254740991 or amount>total then raise exception 'Payroll deductions exceed exact gross capacity';end if;
 with shares as (
  select (value->>'id')::uuid::text id,case when total=0 then 0 else div(amount*public.books_payroll_exact_amount(value->'cents'),total) end base,
  case when total=0 then 0 else mod(amount*public.books_payroll_exact_amount(value->'cents'),total) end remainder from jsonb_array_elements(p_capacities)
 ), ranked as(select *,row_number() over(order by remainder desc,id collate "C") rank,sum(base) over() assigned from shares)
 select jsonb_object_agg(id,base+case when rank<=amount-assigned then 1 else 0 end) into result from ranked;
 return result;
end $$;

create function public.books_payroll_provider_components(p_run jsonb,p_accounts jsonb)
returns jsonb language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
declare w jsonb;a jsonb;ac jsonb;taxes jsonb;deductions jsonb; capacities jsonb;key text;v numeric; component text;debit_code text;credit_code text;code text;sign integer;rows jsonb:='[]';
begin
 if jsonb_typeof(p_run) is distinct from 'object' or (p_run->>'org_id')::uuid is null or jsonb_typeof(p_run->'employees') is distinct from 'array' or jsonb_array_length(p_run->'employees')=0 or jsonb_typeof(p_accounts) is distinct from 'array' then raise exception 'Provider component register/chart is required';end if;
 if exists(select 1 from jsonb_array_elements(p_accounts) ac where ac.value->>'org_id' is distinct from p_run->>'org_id' or (ac.value->>'id')::uuid is null or ac.value->'active' is distinct from 'true'::jsonb)
 or (select count(*) from jsonb_array_elements(p_accounts))<>(select count(distinct (value->>'id')::uuid) from jsonb_array_elements(p_accounts))
 or (select count(*) from jsonb_array_elements(p_accounts))<>(select count(distinct value->>'code') from jsonb_array_elements(p_accounts)) then raise exception 'Provider component account identity/scope differs';end if;
 foreach code in array array['2200','2230'] loop
  if (select count(*) from jsonb_array_elements(p_accounts) ac where ac.value->>'code'=code and ac.value->>'account_type'='liability')<>1 then raise exception 'Provider liability account differs';end if;
 end loop;
 if (select count(*) from jsonb_array_elements(p_run->'employees'))<>(select count(distinct (value->>'worker_id')::uuid) from jsonb_array_elements(p_run->'employees'))
 or (select count(*) from jsonb_array_elements(p_run->'employees') w cross join lateral jsonb_array_elements(w.value->'allocations'))<>(select count(distinct (a.value->>'id')::uuid) from jsonb_array_elements(p_run->'employees') w cross join lateral jsonb_array_elements(w.value->'allocations') a) then raise exception 'Provider worker/allocation identity is duplicated';end if;
 foreach key in array array['gross_cents','net_cents','employee_taxes_cents','employee_deductions_cents','employer_taxes_cents','employer_benefits_cents'] loop
  select sum(public.books_payroll_exact_amount(value->key)) into v from jsonb_array_elements(p_run->'employees');
  if v is distinct from public.books_payroll_exact_amount(p_run->'controls'->key) then raise exception 'Provider component controls differ';end if;
 end loop;
 v:=public.books_payroll_exact_amount(p_run#>'{controls,gross_cents}')+public.books_payroll_exact_amount(p_run#>'{controls,employer_taxes_cents}')+public.books_payroll_exact_amount(p_run#>'{controls,employer_benefits_cents}');
 if v>9007199254740991 or v is distinct from public.books_payroll_exact_amount(p_run#>'{controls,funding_cents}') then raise exception 'Provider component funding differs';end if;
 for w in select value from jsonb_array_elements(p_run->'employees') loop
  if (w->>'worker_id')::uuid is null or public.books_payroll_exact_amount(w->'gross_cents')=0 or public.books_payroll_exact_amount(w->'gross_cents')<>public.books_payroll_exact_amount(w->'net_cents')+public.books_payroll_exact_amount(w->'employee_taxes_cents')+public.books_payroll_exact_amount(w->'employee_deductions_cents') or jsonb_typeof(w->'allocations') is distinct from 'array' or jsonb_array_length(w->'allocations')=0 then raise exception 'Provider component employee amounts differ';end if;
  foreach key in array array['gross_cents','employer_taxes_cents','employer_benefits_cents'] loop
   select sum(public.books_payroll_exact_amount(value->key)) into v from jsonb_array_elements(w->'allocations');
   if v is distinct from public.books_payroll_exact_amount(w->key) then raise exception 'Provider component allocation amounts differ';end if;
  end loop;
  select jsonb_agg(jsonb_build_object('id',value->>'id','cents',value->'gross_cents')) into capacities from jsonb_array_elements(w->'allocations');
  taxes:=public.books_payroll_apportion_cents(w->'employee_taxes_cents',capacities);
  select jsonb_agg(jsonb_build_object('id',value->>'id','cents',public.books_payroll_exact_amount(value->'gross_cents')-(taxes->>((value->>'id')::uuid::text))::numeric)) into capacities from jsonb_array_elements(w->'allocations');
  deductions:=public.books_payroll_apportion_cents(w->'employee_deductions_cents',capacities);
  for a in select value from jsonb_array_elements(w->'allocations') loop
   select value into ac from jsonb_array_elements(p_accounts) where value->>'code'=a->>'cost_account_code';
   if ac is null or not(ac->>'account_type' in('expense','cogs') or(ac->>'account_type'='asset' and ac->>'subtype'='work_in_progress' and a->>'project_id' is not null)) then raise exception 'Provider component requires cost/construction inventory account';end if;
   foreach component in array array['gross_variance','employee_taxes','employee_deductions','employer_taxes','employer_benefits'] loop
    v:=case component when 'gross_variance' then public.books_payroll_exact_amount(a->'gross_cents') when 'employee_taxes' then (taxes->>((a->>'id')::uuid::text))::numeric when 'employee_deductions' then (deductions->>((a->>'id')::uuid::text))::numeric when 'employer_taxes' then public.books_payroll_exact_amount(a->'employer_taxes_cents') else public.books_payroll_exact_amount(a->'employer_benefits_cents') end;
    if v=0 then continue;end if;
    debit_code:=case when component in('employee_taxes','employee_deductions') then '2200' else a->>'cost_account_code' end;
    credit_code:=case when component='gross_variance' then '2200' else '2230' end;
    foreach sign in array array[1,-1] loop
     code:=case when sign=1 then debit_code else credit_code end;
     select value into ac from jsonb_array_elements(p_accounts) where value->>'code'=code;
     rows:=rows||jsonb_build_array(jsonb_build_object('key',jsonb_build_array(w->>'worker_id',a->>'id',a->>'project_id',a->>'cost_code_id',ac->>'id',component),'accountCode',code,'amountCents',v*sign));
    end loop;
   end loop;
  end loop;
 end loop;
 return rows;
end $$;

create function public.books_payroll_provider_delta(p_before jsonb,p_before_accounts jsonb,p_after jsonb,p_after_accounts jsonb,p_request jsonb)
returns jsonb language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
declare before_components jsonb;after_components jsonb;components jsonb;lines jsonb;entry jsonb;v numeric;cost numeric;project_cost numeric;liability_delta jsonb;
begin
 if p_before->>'org_id' is distinct from p_after->>'org_id' or p_request->>'id' is distinct from p_after->>'id' or (p_request->>'postingId')::uuid is null then raise exception 'Provider correction identity differs';end if;
 before_components:=public.books_payroll_provider_components(p_before,p_before_accounts);
 after_components:=public.books_payroll_provider_components(p_after,p_after_accounts);
 components:=before_components||after_components;
 if exists(select 1 from jsonb_array_elements(components) group by value->'key' having count(distinct value->>'accountCode')<>1) then raise exception 'Provider correction account classification differs';end if;
 with movements as (
  select value,-1 sign from jsonb_array_elements(before_components)
  union all select value,1 from jsonb_array_elements(after_components)
 ), buckets as(select value->'key' key,min(value->>'accountCode') code,sum((value->>'amountCents')::numeric*sign) amount from movements group by value->'key'), drafts as(
  select key,amount,code,jsonb_build_object('accountCode',code,'debitCents',greatest(amount,0),'creditCents',greatest(-amount,0),'description','Payroll correction '||(key->>5),'dimensions',jsonb_build_object('payroll_run_id',p_before->>'id','payroll_worker_id',key->>0,'payroll_allocation_id',key->>1,'payroll_component',key->>5,'payroll_correction_id',p_request->>'id','payroll_original_posting_id',p_request->>'postingId','books_correction_account_id',key->>4)||case when key->>3 is null then '{}'::jsonb else jsonb_build_object('cost_code_id',key->>3) end)||case when key->>2 is null then '{}'::jsonb else jsonb_build_object('projectId',key->>2) end line from buckets where amount<>0
 ) select coalesce(jsonb_agg(line order by key::text collate "C"),'[]'::jsonb),coalesce(sum(amount),0),coalesce(sum(amount) filter(where code not in('2200','2230')),0),coalesce(sum(amount) filter(where code not in('2200','2230') and key->>2 is not null),0) into lines,v,cost,project_cost from drafts;
 if v<>0 or abs(cost)>9007199254740991 or abs(project_cost)>9007199254740991 or abs(cost-project_cost)>9007199254740991 or exists(select 1 from jsonb_array_elements(lines) where greatest((value->>'debitCents')::numeric,(value->>'creditCents')::numeric)>9007199254740991) then raise exception 'Provider correction delta is unbalanced or exceeds exact cents';end if;
 if jsonb_array_length(lines)>0 then
  entry:=jsonb_build_object('entryDate',p_request->>'accountingDate','entryKind','adjusting','memo','Correct payroll '||(p_after->>'provider')||' '||(p_after->>'provider_run_id')||': '||(p_request->>'reason'),'postingKey','payroll_correction:'||(p_request->>'id')||':s1:v1','projectionVersion',1,'policyVersion',1,'sourceType','payroll_correction','sourceId',p_request->>'id','lines',lines);
 end if;
 select jsonb_object_agg(label,public.books_payroll_exact_amount(p_after->'controls'->field)-public.books_payroll_exact_amount(p_before->'controls'->field)) into liability_delta
 from(values('netPayCents','net_cents'),('employeeTaxesCents','employee_taxes_cents'),('employeeDeductionsCents','employee_deductions_cents'),('employerTaxesCents','employer_taxes_cents'),('employerBenefitsCents','employer_benefits_cents')) amounts(label,field);
 return jsonb_build_object('journalDraft',entry,'costDeltaCents',cost,'projectCostDeltaCents',project_cost,'overheadCostDeltaCents',cost-project_cost,'liabilityDelta',liability_delta,'cashDeltaCents',0,'customerAmountDeltaCents',0,'nativeLaborReconciledAgain',false);
end $$;

-- First correction baseline only: this proves provider arithmetic against the
-- original posted receipt. A future money transaction must also resolve the
-- latest actual posted correction and independently reviewed business decisions,
-- hold source/calendar fences, and atomically own every GL/fact/job-cost row.
create function public.reviewed_books_payroll_correction_delta(p_org uuid,p_source uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare source public.books_payroll_correction_sources;posting public.books_payroll_postings;parent public.books_payroll_imports;
begin
 select * into source from public.books_payroll_correction_sources where org_id=p_org and id=p_source for share;
 if source.id is null or source.status<>'reviewed' or source.evidence_hash is distinct from public.books_payroll_correction_source_hash(to_jsonb(source)) then raise exception 'Provider correction requires immutable reviewed source';end if;
 perform public.validate_books_payroll_correction_source(p_org,p_source,source.posting_id,to_jsonb(source));
 select * into posting from public.books_payroll_postings where org_id=p_org and id=source.posting_id for share;
 select * into parent from public.books_payroll_imports where org_id=p_org and id=posting.payroll_import_id for share;
 return public.books_payroll_provider_delta(parent.run,parent.reconciliation->'postingAccounts',source.run,source.account_snapshot,source.request);
end $$;

revoke all on function public.books_payroll_apportion_cents(jsonb,jsonb),public.books_payroll_provider_components(jsonb,jsonb),public.books_payroll_provider_delta(jsonb,jsonb,jsonb,jsonb,jsonb),public.reviewed_books_payroll_correction_delta(uuid,uuid) from public,anon,authenticated;
grant execute on function public.books_payroll_apportion_cents(jsonb,jsonb),public.books_payroll_provider_components(jsonb,jsonb),public.books_payroll_provider_delta(jsonb,jsonb,jsonb,jsonb,jsonb),public.reviewed_books_payroll_correction_delta(uuid,uuid) to service_role;
