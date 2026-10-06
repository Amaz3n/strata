-- Explicit placement decisions live in the immutable monetary proposal. The
-- independent monetary reviewer approves all choices with the exact source,
-- signed leg amounts, baseline and current construction/commercial evidence.
create function public.books_payroll_correction_commercial_context(p_org_id uuid,p_source_id uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare result jsonb;context jsonb;project_ids uuid[];leg jsonb;project jsonb;settings jsonb;contract jsonb;cost_blockers jsonb;project_costs jsonb:='[]';settings_count integer;contract_count integer;
begin
 result:=public.books_payroll_correction_base_context(p_org_id,p_source_id);
 context:=result->'context';
 select array_agg((value->>'id')::uuid order by value->>'id') into project_ids from jsonb_array_elements(context->'projects');
 perform 1 from public.project_financial_settings where org_id=p_org_id and project_id=any(project_ids) order by id for share;
 perform 1 from public.contracts where org_id=p_org_id and project_id=any(project_ids) order by id for share;
 perform 1 from public.closings where org_id=p_org_id and project_id=any(project_ids) order by id for share;
 context:=context||jsonb_build_object(
  'project_financial_settings',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from public.project_financial_settings r where org_id=p_org_id and project_id=any(project_ids)),
  'contracts',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from public.contracts r where org_id=p_org_id and project_id=any(project_ids)),
  'closings',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from public.closings r where org_id=p_org_id and project_id=any(project_ids)));
 context:=public.books_payroll_context_canonical(context);
 for leg in select value from jsonb_array_elements(result->'projectCosts') loop
  cost_blockers:=leg->'blockers';
  select value into project from jsonb_array_elements(context->'projects') where value->>'id'=leg->>'projectId';
  if project->>'status' in('completed','cancelled') then cost_blockers:=cost_blockers||jsonb_build_array('review_late_project_cost_policy');
  elsif project->>'status' is null or project->>'status' not in('planning','bidding','active','on_hold') then cost_blockers:=cost_blockers||jsonb_build_array('review_unknown_project_status');end if;
  if exists(select 1 from jsonb_array_elements(context->'closings') where value->>'project_id'=leg->>'projectId' and value->>'status'='closed') then cost_blockers:=cost_blockers||jsonb_build_array('review_closed_home_cost_and_customer_settlement');end if;
  select count(*) into settings_count from jsonb_array_elements(context->'project_financial_settings') where value->>'project_id'=leg->>'projectId';
  select value into settings from jsonb_array_elements(context->'project_financial_settings') where value->>'project_id'=leg->>'projectId' limit 1;
  select count(*) into contract_count from jsonb_array_elements(context->'contracts') where value->>'project_id'=leg->>'projectId' and value->>'status'='active';
  select value into contract from jsonb_array_elements(context->'contracts') where value->>'project_id'=leg->>'projectId' and value->>'status'='active' limit 1;
  if settings_count<>1 or settings->>'setup_completed_at' is null then cost_blockers:=cost_blockers||jsonb_build_array('review_incomplete_project_financial_setup');end if;
  if contract_count<>1 then cost_blockers:=cost_blockers||jsonb_build_array('review_missing_or_ambiguous_active_contract');end if;
  if settings_count=1 and settings->>'billing_model' is distinct from 'time_and_materials' then cost_blockers:=cost_blockers||jsonb_build_array('review_current_customer_billing_policy');end if;
  if contract_count=1 and contract->>'contract_type' is distinct from 'time_materials' then cost_blockers:=cost_blockers||jsonb_build_array('review_current_customer_billing_policy');end if;
  -- Keep the independently reconstructed leg ordering and duplicate semantics.
  project_costs:=project_costs||jsonb_build_array(leg||jsonb_build_object('blockers',cost_blockers));
 end loop;
 return result||jsonb_build_object('version',2,'projectCosts',project_costs,'context',context,'contextHash',encode(sha256(convert_to(context::text,'UTF8')),'hex'),'requiresConstructionReview',exists(select 1 from jsonb_array_elements(project_costs) where jsonb_array_length(value->'blockers')>0));
end $$;
revoke all on function public.books_payroll_correction_commercial_context(uuid,uuid) from public,anon,authenticated;
grant execute on function public.books_payroll_correction_commercial_context(uuid,uuid) to service_role;

create function public.lock_books_payroll_correction_decisions(p_org_id uuid,p_source_id uuid,p_decisions jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare result jsonb;context jsonb;choice jsonb;leg jsonb;costs jsonb:='[]';chosen jsonb;selected uuid[];budget_line public.budget_lines;budget public.budgets;needed integer;matches integer;key text;
begin
 result:=public.books_payroll_correction_commercial_context(p_org_id,p_source_id);
 if p_decisions is null then return result;end if;
 if jsonb_typeof(p_decisions)<>'array' or jsonb_array_length(p_decisions)=0 then raise exception 'Construction decisions require nonempty complete leg choices';end if;
 select count(*) into needed from jsonb_array_elements(result->'projectCosts') where value->'blockers' ? 'review_new_or_reallocated_budget_and_gmp';
 if needed<>jsonb_array_length(p_decisions) then raise exception 'Construction decisions must cover each new or reallocated cost leg exactly once';end if;
 for choice in select value from jsonb_array_elements(p_decisions) loop
  if jsonb_typeof(choice)<>'object' or (select count(*) from jsonb_object_keys(choice))<>10 or not(choice ?& array['workerId','allocationId','projectId','costCodeId','accountId','component','budgetLineId','gmpClassification','billingTreatment','reason']) then raise exception 'Construction decision fields differ';end if;
  foreach key in array array['workerId','allocationId','projectId','accountId'] loop
   if jsonb_typeof(choice->key)<>'string' or choice->>key is distinct from (choice->>key)::uuid::text then raise exception 'Construction decision identity differs';end if;
  end loop;
  foreach key in array array['costCodeId','budgetLineId'] loop
   if choice->key<>'null'::jsonb and (jsonb_typeof(choice->key)<>'string' or choice->>key is distinct from (choice->>key)::uuid::text) then raise exception 'Construction decision nullable identity differs';end if;
  end loop;
  foreach key in array array['component','gmpClassification','billingTreatment','reason'] loop
   if jsonb_typeof(choice->key) is distinct from 'string' then raise exception 'Construction decision requires explicit GMP, billing and explanation';end if;
  end loop;
  if choice->>'component' not in('gross_variance','employer_taxes','employer_benefits') or choice->>'gmpClassification' not in('inside_gmp','outside_gmp') or choice->>'billingTreatment'<>'preserve_time_and_materials_rates' or jsonb_typeof(choice->'reason')<>'string' or length(btrim(choice->>'reason')) not between 20 and 4000 or choice->>'reason'<>btrim(choice->>'reason') then raise exception 'Construction decision requires explicit GMP, billing and explanation';end if;
  select count(*) into matches from jsonb_array_elements(result->'projectCosts') where value->'blockers' ? 'review_new_or_reallocated_budget_and_gmp' and value->>'workerId'=choice->>'workerId' and value->>'allocationId'=choice->>'allocationId' and value->>'projectId'=choice->>'projectId' and value->>'costCodeId' is not distinct from choice->>'costCodeId' and value->>'accountId'=choice->>'accountId' and value->>'component'=choice->>'component';
  if matches<>1 or (select count(*) from jsonb_array_elements(p_decisions) where value-array['budgetLineId','gmpClassification','billingTreatment','reason']=choice-array['budgetLineId','gmpClassification','billingTreatment','reason'])<>1 then raise exception 'Construction decisions must cover each new or reallocated cost leg exactly once';end if;
 end loop;
 select array_agg(distinct (value->>'budgetLineId')::uuid order by (value->>'budgetLineId')::uuid) into selected from jsonb_array_elements(p_decisions) where value->>'budgetLineId' is not null;
 perform 1 from public.budget_lines where org_id=p_org_id and id=any(selected) order by id for share;
 context:=result->'context';
 context:=context||jsonb_build_object('budget_lines',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from public.budget_lines r where org_id=p_org_id and (id=any(selected) or exists(select 1 from jsonb_array_elements(context->'budget_lines') where value->>'id'=r.id::text))));
 context:=public.books_payroll_context_canonical(context);
 for leg in select value from jsonb_array_elements(result->'projectCosts') loop
  select value into chosen from jsonb_array_elements(p_decisions) where value->>'workerId'=leg->>'workerId' and value->>'allocationId'=leg->>'allocationId' and value->>'projectId'=leg->>'projectId' and value->>'costCodeId' is not distinct from leg->>'costCodeId' and value->>'accountId'=leg->>'accountId' and value->>'component'=leg->>'component';
  if chosen is not null then
   if chosen->>'budgetLineId' is not null then
    select * into budget_line from public.budget_lines where org_id=p_org_id and id=(chosen->>'budgetLineId')::uuid;
    select * into budget from public.budgets where org_id=p_org_id and id=budget_line.budget_id;
    if budget_line.id is null or budget.id is null or budget.project_id::text is distinct from chosen->>'projectId' or budget_line.cost_code_id::text is distinct from chosen->>'costCodeId' then raise exception 'Construction decision budget is outside the corrective project and cost code';end if;
   end if;
   leg:=leg||jsonb_build_object('budgetLineId',chosen->'budgetLineId','gmpClassification',chosen->'gmpClassification','blockers',(select coalesce(jsonb_agg(value order by ordinal),'[]') from jsonb_array_elements(leg->'blockers') with ordinality a(value,ordinal) where value#>>'{}' not in('review_new_or_reallocated_budget_and_gmp','review_customer_billing_basis')));
  end if;
  costs:=costs||jsonb_build_array(leg);
 end loop;
 return result||jsonb_build_object('version',3,'constructionDecisions',p_decisions,'projectCosts',costs,'context',context,'contextHash',encode(sha256(convert_to(context::text,'UTF8')),'hex'),'requiresConstructionReview',exists(select 1 from jsonb_array_elements(costs) where jsonb_array_length(value->'blockers')>0));
end $$;
revoke all on function public.lock_books_payroll_correction_decisions(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.lock_books_payroll_correction_decisions(uuid,uuid,jsonb) to service_role;

create or replace function public.lock_books_payroll_correction_context(p_org_id uuid,p_source_id uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare chosen jsonb;
begin
 -- Acquire the same org/source/calendar fences before selecting the active
 -- proposal; a reviewed choice is never a session-local setting or bypass flag.
 perform public.books_payroll_correction_commercial_context(p_org_id,p_source_id);
 select plan->'constructionDecisions' into chosen from public.books_payroll_correction_proposals where org_id=p_org_id and source_id=p_source_id and status<>'withdrawn' and (posted_receipt_id is null or not exists(select 1 from public.books_payroll_correction_postings r where r.org_id=p_org_id and r.id=posted_receipt_id));
 return public.lock_books_payroll_correction_decisions(p_org_id,p_source_id,chosen);
end $$;
create or replace function public.guard_books_payroll_correction_proposal() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare source public.books_payroll_correction_sources;posting public.books_payroll_postings;parent public.books_payroll_imports;original public.books_payroll_posting_proposals;payment public.books_payroll_payment_reviews;actor uuid;expected jsonb;
begin
 if tg_op='DELETE' then raise exception 'Correction proposal history cannot be deleted';end if;
 if not pg_try_advisory_xact_lock(hashtextextended('payroll-import:'||new.org_id::text,0)) then raise exception 'Correction proposal history is changing; retry' using errcode='40001';end if;
 if tg_op='UPDATE' and new.posted_receipt_id is distinct from old.posted_receipt_id then
  if old.posted_receipt_id is not null or new.posted_receipt_id is null or old.status<>'reviewed' or to_jsonb(new)-'posted_receipt_id' is distinct from to_jsonb(old)-'posted_receipt_id' then raise exception 'Correction proposal posted ownership is immutable';end if;
  -- Receipt FK and deferred proof below must both succeed before commit. The
  -- money transaction claims this back-reference before inserting its receipt.
  return new;
 end if;
 if tg_op='INSERT' and new.posted_receipt_id is not null then raise exception 'Correction proposal cannot start with posted authority';end if;
 if tg_op='UPDATE' then
  if to_jsonb(new)-array['status','reviewed_by','reviewed_at','review_notes','withdrawn_by','withdrawn_at','withdrawal_reason'] is distinct from to_jsonb(old)-array['status','reviewed_by','reviewed_at','review_notes','withdrawn_by','withdrawn_at','withdrawal_reason'] then raise exception 'Correction proposal evidence and preparation are immutable';end if;
  if not((old.status='draft' and new.status='reviewed') or(old.status in('draft','reviewed') and new.status='withdrawn' and new.reviewed_by is not distinct from old.reviewed_by and new.reviewed_at is not distinct from old.reviewed_at and new.review_notes is not distinct from old.review_notes)) then raise exception 'Invalid correction proposal transition';end if;
 else
  if new.status<>'draft' or new.reviewed_by is not null or new.reviewed_at is not null or new.review_notes is not null or new.withdrawn_by is not null or new.withdrawn_at is not null or new.withdrawal_reason is not null then raise exception 'Correction proposal must start as unreviewed draft';end if;
 end if;
 actor:=case new.status when 'reviewed' then new.reviewed_by when 'withdrawn' then new.withdrawn_by else new.prepared_by end;
 perform 1 from public.memberships where org_id=new.org_id and user_id=actor and status='active' for share;
 if not found then raise exception 'Correction proposal requires active organization actor';end if;
 if new.status='withdrawn' then return new;end if;
 expected:=public.lock_books_payroll_correction_decisions(new.org_id,new.source_id,new.plan->'constructionDecisions')-'locksHeldUntilTransactionEnd';
 if new.plan is distinct from expected or new.posting_id::text is distinct from expected->>'originalPostingId' then raise exception 'Correction proposal differs from independently computed current context';end if;
 select * into source from public.books_payroll_correction_sources where org_id=new.org_id and id=new.source_id for share;
 select * into posting from public.books_payroll_postings where org_id=new.org_id and id=new.posting_id;
 select * into parent from public.books_payroll_imports where org_id=new.org_id and id=posting.payroll_import_id for share;
 select * into original from public.books_payroll_posting_proposals where org_id=new.org_id and id=posting.proposal_id for share;
 select * into payment from public.books_payroll_payment_reviews where org_id=new.org_id and id=original.payment_review_id for share;
 if new.status='reviewed' then
  if new.reviewed_by=new.prepared_by or new.reviewed_by=source.prepared_by or new.reviewed_by=parent.prepared_by or new.reviewed_by=original.prepared_by or new.reviewed_by=payment.prepared_by then raise exception 'Correction monetary review must be separate from all preparers';end if;
  if new.plan->'blockers'<>'[]'::jsonb or new.plan->'requiresConstructionReview' is distinct from 'false'::jsonb then raise exception 'Correction proposal has unresolved business or accounting decisions';end if;
 end if;
 return new;
end $$;
create or replace function public.prepare_books_payroll_correction_proposal(p_org_id uuid,p_id uuid,p_source_id uuid,p_actor_id uuid,p_plan jsonb,p_notes text,p_key text)
returns uuid language plpgsql security invoker set search_path=pg_catalog,public as $$
declare previous public.books_payroll_correction_proposals;expected jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('payroll-import:'||p_org_id::text,0));
 perform 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active' for share;
 if not found then raise exception 'Correction proposal requires active preparer';end if;
 select * into previous from public.books_payroll_correction_proposals where org_id=p_org_id and idempotency_key=p_key;
 if found then
  if previous.id is distinct from p_id or previous.source_id is distinct from p_source_id or previous.prepared_by is distinct from p_actor_id or previous.preparation_notes is distinct from p_notes or previous.plan is distinct from p_plan then raise exception 'Correction proposal retry has different intent';end if;
  return previous.id;
 end if;
 expected:=public.lock_books_payroll_correction_decisions(p_org_id,p_source_id,p_plan->'constructionDecisions')-'locksHeldUntilTransactionEnd';
 if expected is distinct from p_plan then raise exception 'Correction context changed before preparation';end if;
 insert into public.books_payroll_correction_proposals(id,org_id,source_id,posting_id,plan,plan_text,context_text,plan_digest,prepared_by,preparation_notes,idempotency_key)
 values(p_id,p_org_id,p_source_id,(expected->>'originalPostingId')::uuid,expected,expected::text,(expected->'context')::text,encode(sha256(convert_to(expected::text,'UTF8')),'hex'),p_actor_id,p_notes,p_key);
 return p_id;
end $$;
