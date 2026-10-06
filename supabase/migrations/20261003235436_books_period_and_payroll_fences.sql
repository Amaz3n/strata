-- Shared calendar locks preserve concurrent posting; period writers take the
-- exclusive side without waiting after acquiring a row lock. Lock inversion
-- causes a retryable failure, never an unprotected close/post.
create function public.books_lock_period_calendar_write() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare org uuid; organizations uuid[];
begin
 if tg_op='INSERT' then organizations:=array[new.org_id];elsif tg_op='DELETE' then organizations:=array[old.org_id];else organizations:=array[old.org_id,new.org_id];end if;
 for org in select distinct value from unnest(organizations) value order by value loop
  if not pg_try_advisory_xact_lock(hashtextextended('books-period-calendar:'||org::text,0)) then raise exception 'Accounting calendar is in use; retry period change' using errcode='40001';end if;
 end loop;
 if tg_op='DELETE' or tg_op='UPDATE' and(new.id is distinct from old.id or new.org_id is distinct from old.org_id or new.period_start is distinct from old.period_start or new.period_end is distinct from old.period_end) then
  if exists(select 1 from public.journal_entries j where j.org_id=old.org_id and j.status in('posted','reversed') and(j.period_id=old.id or j.entry_date between old.period_start and old.period_end)) then raise exception 'Accounting calendar with recorded journals cannot be deleted or moved';end if;
 end if;
 if tg_op='DELETE' then return old;end if;return new;
end $$;
create trigger accounting_periods_calendar_guard before insert or delete or update of id,org_id,period_start,period_end,status on public.accounting_periods for each row execute function public.books_lock_period_calendar_write();
revoke all on function public.books_lock_period_calendar_write() from public,anon,authenticated;

create or replace function public.books_guard_period_posting() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare period_row public.accounting_periods; close_owned boolean;
begin
 -- A reversal changes the original's lifecycle in its historical period, while
 -- its new reversing journal must pass its own target-date posting guard.
 if tg_op='UPDATE' and old.status='posted' and new.status='reversed' then return new;end if;
 if not pg_try_advisory_xact_lock_shared(hashtextextended('books-period-calendar:'||new.org_id::text,0)) then raise exception 'Accounting calendar is changing; retry journal operation' using errcode='40001';end if;
 if new.period_id is null then
  select * into period_row from public.accounting_periods where org_id=new.org_id and new.entry_date between period_start and period_end order by period_start,id for share;
  if not found then return new;end if;
  new.period_id:=period_row.id;
 else
  select * into period_row from public.accounting_periods where org_id=new.org_id and id=new.period_id for share;
  if not found or new.entry_date not between period_row.period_start and period_row.period_end then raise exception 'Journal entry must belong to its organization and accounting period';end if;
 end if;
 if (select count(*) from public.accounting_periods where org_id=new.org_id and new.entry_date between period_start and period_end)>1 then raise exception 'Accounting periods overlap; reconcile calendar before posting';end if;
 if period_row.status is null or period_row.status not in('open','reopened','reviewing','closed') then raise exception 'Accounting period has invalid status';end if;
 if period_row.status='closed' then raise exception 'Accounting period is closed and cannot accept postings';end if;
 close_owned:=(new.source_type in('revenue_recognition','expected_loss_provision') and new.entry_kind='poc' and new.entry_date=period_row.period_end) or(new.source_type='year_end_close' and new.entry_kind='closing' and new.source_id=period_row.id and new.entry_date=period_row.period_end and period_row.fiscal_period in(12,13));
 if period_row.status='reviewing' and close_owned is not true then raise exception 'Accounting period is reviewing and cannot accept operational postings';end if;
 return new;
end $$;
drop trigger if exists journal_entries_guard_period_posting on public.journal_entries;
create trigger journal_entries_guard_period_posting before insert or update of status,entry_date,period_id,org_id,source_type,source_id,entry_kind on public.journal_entries for each row execute function public.books_guard_period_posting();
revoke all on function public.books_guard_period_posting() from public,anon,authenticated;

-- Ordinary source writers share this fence and remain concurrent. Payroll
-- commit takes its exclusive side before inspecting current native/accounting/
-- construction sources. No salary table read or elevated trigger privileges.
create function public.books_lock_payroll_source_write() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare org uuid; organizations uuid[];
begin
 if tg_op='INSERT' then organizations:=array[new.org_id];elsif tg_op='DELETE' then organizations:=array[old.org_id];else organizations:=array[old.org_id,new.org_id];end if;
 for org in select distinct value from unnest(organizations) value order by value loop
  if not pg_try_advisory_xact_lock_shared(hashtextextended('books-payroll-source:'||org::text,0)) then raise exception 'Payroll source evidence is frozen by a transaction; retry source change' using errcode='40001';end if;
 end loop;
 if tg_op='DELETE' then return old;end if;return new;
end $$;
revoke all on function public.books_lock_payroll_source_write() from public,anon,authenticated;
do $$declare table_name text;begin
 foreach table_name in array array['time_entries','job_cost_entries','accounting_facts','journal_entries','journal_lines','books_projection_receipts','budgets','budget_lines','billable_costs','gl_accounts'] loop
  execute format('create trigger books_payroll_source_fence before insert or update or delete on public.%I for each row execute function public.books_lock_payroll_source_write()',table_name);
 end loop;
end $$;

-- PAYROLL CONTEXT: callers must keep this transaction open through all posting
-- writes. Calling it as a standalone preflight releases locks on RPC completion.
create function public.lock_books_payroll_posting_context(p_org_id uuid,p_proposal_id uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare proposal public.books_payroll_posting_proposals; parent public.books_payroll_imports; payment public.books_payroll_payment_reviews;
 parent_id uuid; period public.accounting_periods; date_key date; date_rows jsonb:='[]'; calendar_blockers jsonb:='[]'; allocation_blockers jsonb:='[]'; allocation jsonb; reason jsonb; sources jsonb; journal_ids uuid[];
begin
 perform pg_advisory_xact_lock(hashtextextended('payroll-import:'||p_org_id::text,0));
 if not pg_try_advisory_xact_lock(hashtextextended('books-payroll-source:'||p_org_id::text,0)) then raise exception 'Payroll sources are changing; retry payroll transaction' using errcode='40001';end if;
 if not pg_try_advisory_xact_lock_shared(hashtextextended('books-period-calendar:'||p_org_id::text,0)) then raise exception 'Accounting calendar is changing; retry payroll transaction' using errcode='40001';end if;
 select payroll_import_id into parent_id from public.books_payroll_posting_proposals where org_id=p_org_id and id=p_proposal_id;
 if not found then raise exception 'Payroll posting proposal is unavailable in organization';end if;
 select * into parent from public.books_payroll_imports where org_id=p_org_id and id=parent_id for share;
 select * into payment from public.books_payroll_payment_reviews where org_id=p_org_id and payroll_import_id=parent_id and status<>'withdrawn' for share;
 select * into proposal from public.books_payroll_posting_proposals where org_id=p_org_id and id=p_proposal_id for update;
 if proposal.status<>'reviewed' then raise exception 'Payroll posting requires independently reviewed full proposal';end if;
 perform public.verify_books_payroll_posting_plan(p_org_id,parent_id,proposal.plan);
 sources:=parent.reconciliation#>'{workflowEvidence,sourceTables}';
 -- Exclusive org source fence already blocks mutations/inserts and phantom
 -- dependent sources. Explicit row locks also coordinate original FK writers.
 perform 1 from public.time_entries where org_id=p_org_id and id in(select (value->>'source_id')::uuid from jsonb_array_elements(sources->'job_cost_entries')) order by id for share;
 perform 1 from public.job_cost_entries where org_id=p_org_id and id in(select (value->>'id')::uuid from jsonb_array_elements(sources->'job_cost_entries')) order by id for share;
 perform 1 from public.accounting_facts where org_id=p_org_id and id in(select (value->>'fact_id')::uuid from jsonb_array_elements(parent.labor_evidence)) order by id for share;
 select array_agg(distinct identifier order by identifier) into journal_ids from(select (value->>'id')::uuid identifier from jsonb_array_elements(sources->'journal_entries') union select (value->>'journal_id')::uuid from jsonb_array_elements(parent.labor_evidence)) j;
 perform 1 from public.journal_entries where org_id=p_org_id and id=any(journal_ids) order by id for share;
 perform 1 from public.journal_lines where org_id=p_org_id and entry_id=any(journal_ids) order by id for share;
 perform 1 from public.books_projection_receipts where org_id=p_org_id and journal_id=any(journal_ids) order by id for share;
 perform 1 from public.budgets where org_id=p_org_id and id in(select (value->>'id')::uuid from jsonb_array_elements(sources->'budgets')) order by id for share;
 perform 1 from public.budget_lines where org_id=p_org_id and id in(select (value->>'id')::uuid from jsonb_array_elements(sources->'budget_lines')) order by id for share;
 perform 1 from public.billable_costs where org_id=p_org_id and id in(select (value->>'id')::uuid from jsonb_array_elements(sources->'billable_costs')) order by id for share;
 perform 1 from public.gl_accounts where org_id=p_org_id and id in(select (value->>'id')::uuid from jsonb_array_elements(sources->'gl_accounts')) order by id for share;
 for date_key in select distinct accounting_date from(select (value->>'entryDate')::date accounting_date from jsonb_array_elements(proposal.plan->'journalDrafts') union select (value#>>'{construction,incurredOn}')::date from jsonb_array_elements(proposal.plan->'allocations') where value#>'{construction,jobCostCorrections}'<>'[]'::jsonb) dates order by accounting_date loop
  select * into period from public.accounting_periods where org_id=p_org_id and date_key between period_start and period_end order by id for share;
  if (select count(*) from public.accounting_periods where org_id=p_org_id and date_key between period_start and period_end)>1 then
   calendar_blockers:=calendar_blockers||jsonb_build_array(jsonb_build_object('accountingDate',date_key,'code','ambiguous_accounting_period'));date_rows:=date_rows||jsonb_build_array(jsonb_build_object('accountingDate',date_key,'periodId',null,'status',null));
  elsif period.id is null then
   calendar_blockers:=calendar_blockers||jsonb_build_array(jsonb_build_object('accountingDate',date_key,'code','missing_accounting_period'));date_rows:=date_rows||jsonb_build_array(jsonb_build_object('accountingDate',date_key,'periodId',null,'status',null));
  else
   date_rows:=date_rows||jsonb_build_array(jsonb_build_object('accountingDate',date_key,'periodId',period.id,'status',period.status));
   if period.status is null or period.status not in('open','reopened') then calendar_blockers:=calendar_blockers||jsonb_build_array(jsonb_build_object('accountingDate',date_key,'code','accounting_period_'||coalesce(period.status,'invalid')));end if;
  end if;
 end loop;
 for allocation in select value from jsonb_array_elements(proposal.plan->'allocations') loop
  for reason in select value from jsonb_array_elements(allocation#>'{construction,blockers}') loop
   allocation_blockers:=allocation_blockers||jsonb_build_array(jsonb_build_object('allocationId',allocation->>'allocationId','code',reason#>>'{}'));
  end loop;
  if allocation#>'{construction,billing,requiresReview}'='true'::jsonb then allocation_blockers:=allocation_blockers||jsonb_build_array(jsonb_build_object('allocationId',allocation->>'allocationId','code',allocation#>>'{construction,billing,action}'));end if;
 end loop;
 return jsonb_build_object('version',1,'orgId',p_org_id,'proposalId',proposal.id,'payrollImportId',parent_id,'planDigest',proposal.plan_digest,'accountingDates',date_rows,'calendarBlockers',calendar_blockers,'constructionBlockers',allocation_blockers,'controlsSatisfied',jsonb_array_length(calendar_blockers)=0 and jsonb_array_length(allocation_blockers)=0,'postingImplemented',false,'locksHeldUntilTransactionEnd',true);
end $$;
revoke all on function public.lock_books_payroll_posting_context(uuid,uuid) from public,anon,authenticated;
grant execute on function public.lock_books_payroll_posting_context(uuid,uuid) to service_role;
