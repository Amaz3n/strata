-- Immutable full payroll posting proposals. Reviewed does not mean posted:
-- construction approvals, period locks and atomic posting are still required.
create table public.books_payroll_posting_proposals(
 id uuid primary key,org_id uuid not null references public.orgs(id),payroll_import_id uuid not null,payment_review_id uuid,
 status text not null default 'draft' check(status in('draft','reviewed','withdrawn')),
 plan jsonb not null check(jsonb_typeof(plan)='object'),plan_digest text not null check(plan_digest~'^[a-f0-9]{64}$'),
 prepared_by uuid not null references public.app_users(id),prepared_at timestamptz not null default now(),preparation_notes text not null check(length(trim(preparation_notes))>=10),
 reviewed_by uuid references public.app_users(id),reviewed_at timestamptz,review_notes text,
 withdrawn_by uuid references public.app_users(id),withdrawn_at timestamptz,withdrawal_reason text,
 idempotency_key text not null,unique(org_id,id),unique(org_id,idempotency_key),
 foreign key(org_id,payroll_import_id) references public.books_payroll_imports(org_id,id),foreign key(org_id,payment_review_id) references public.books_payroll_payment_reviews(org_id,id),
 check((reviewed_by is null and reviewed_at is null and review_notes is null and status<>'reviewed') or(reviewed_by is not null and reviewed_by<>prepared_by and reviewed_at is not null and length(trim(review_notes))>=10)),
 check((status<>'withdrawn' and withdrawn_by is null and withdrawn_at is null and withdrawal_reason is null) or(status='withdrawn' and withdrawn_by is not null and withdrawn_at is not null and length(trim(withdrawal_reason))>=10))
);
create unique index books_payroll_posting_proposal_active_idx on public.books_payroll_posting_proposals(org_id,payroll_import_id) where status<>'withdrawn';
alter table public.books_payroll_posting_proposals enable row level security;
revoke all on public.books_payroll_posting_proposals from public,anon,authenticated;
grant select,insert,update on public.books_payroll_posting_proposals to service_role;

create function public.guard_books_payroll_posting_proposal() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare parent public.books_payroll_imports; payment public.books_payroll_payment_reviews;
begin
 if tg_op='DELETE' then raise exception 'Payroll posting proposal history cannot be deleted';end if;
 if not pg_try_advisory_xact_lock(hashtextextended('payroll-import:'||new.org_id::text,0)) then raise exception 'Payroll posting proposal is changing concurrently; retry' using errcode='40001';end if;
 if tg_op='UPDATE' then
  if to_jsonb(new)-array['status','reviewed_by','reviewed_at','review_notes','withdrawn_by','withdrawn_at','withdrawal_reason'] is distinct from to_jsonb(old)-array['status','reviewed_by','reviewed_at','review_notes','withdrawn_by','withdrawn_at','withdrawal_reason'] then raise exception 'Payroll posting proposal and original evidence are immutable';end if;
  if not((old.status='draft' and new.status='reviewed') or(old.status in('draft','reviewed') and new.status='withdrawn' and new.reviewed_by is not distinct from old.reviewed_by and new.reviewed_at is not distinct from old.reviewed_at and new.review_notes is not distinct from old.review_notes)) then raise exception 'Invalid payroll posting proposal transition';end if;
 else
  if new.status<>'draft' or new.reviewed_by is not null or new.withdrawn_by is not null or not exists(select 1 from public.memberships where org_id=new.org_id and user_id=new.prepared_by and status='active') then raise exception 'Payroll posting proposal requires active preparer and draft';end if;
 end if;
 if new.status='withdrawn' then
  if not exists(select 1 from public.memberships where org_id=new.org_id and user_id=new.withdrawn_by and status='active') or coalesce(length(trim(new.withdrawal_reason)),0)<10 then raise exception 'Payroll posting withdrawal requires active actor and reason';end if;
  return new;
 end if;
 select * into parent from public.books_payroll_imports where org_id=new.org_id and id=new.payroll_import_id for share;
 if not found then raise exception 'Payroll posting parent is unavailable in organization';end if;
 if new.payment_review_id is not null then
  select * into payment from public.books_payroll_payment_reviews where org_id=new.org_id and id=new.payment_review_id and payroll_import_id=parent.id for share;
  if not found or payment.status<>'reviewed' then raise exception 'Payroll posting payment ownership is unavailable or not reviewed';end if;
 end if;
 if new.plan->>'runId' is distinct from new.payroll_import_id::text or new.plan->>'orgId' is distinct from new.org_id::text or new.plan->>'paymentReviewId' is distinct from new.payment_review_id::text or new.plan->>'digest' is distinct from new.plan_digest then raise exception 'Payroll posting proposal identity or digest differs';end if;
 perform public.verify_books_payroll_posting_plan(new.org_id,new.payroll_import_id,new.plan);
 if new.status='reviewed' and(new.reviewed_by=new.prepared_by or new.reviewed_by=parent.prepared_by or new.reviewed_by=payment.prepared_by or not exists(select 1 from public.memberships where org_id=new.org_id and user_id=new.reviewed_by and status='active') or coalesce(length(trim(new.review_notes)),0)<10) then raise exception 'Payroll posting proposal requires separate active reviewer';end if;
 return new;
end $$;
create trigger books_payroll_posting_proposal_guard before insert or update or delete on public.books_payroll_posting_proposals for each row execute function public.guard_books_payroll_posting_proposal();
revoke all on function public.guard_books_payroll_posting_proposal() from public,anon,authenticated;

create function public.prepare_books_payroll_posting_proposal(p_org_id uuid,p_id uuid,p_parent_id uuid,p_actor_id uuid,p_plan jsonb,p_digest text,p_notes text,p_key text)
returns uuid language plpgsql security invoker set search_path=pg_catalog,public as $$
declare previous public.books_payroll_posting_proposals; result uuid;
begin
 if not exists(select 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active') or coalesce(length(trim(p_notes)),0)<10 or coalesce(length(trim(p_key)),0)<10 then raise exception 'Payroll posting proposal requires active actor, substantive notes and retry identity';end if;
 perform pg_advisory_xact_lock(hashtextextended('payroll-import:'||p_org_id::text,0));
 select * into previous from public.books_payroll_posting_proposals where org_id=p_org_id and idempotency_key=p_key;
 if found then
  if previous.id<>p_id or previous.payroll_import_id<>p_parent_id or previous.prepared_by<>p_actor_id or previous.plan is distinct from p_plan or previous.plan_digest is distinct from p_digest or previous.preparation_notes is distinct from p_notes then raise exception 'Payroll posting retry key has different intent or evidence';end if;
  return previous.id;
 end if;
 insert into public.books_payroll_posting_proposals(id,org_id,payroll_import_id,payment_review_id,plan,plan_digest,prepared_by,preparation_notes,idempotency_key) values(p_id,p_org_id,p_parent_id,(p_plan->>'paymentReviewId')::uuid,p_plan,p_digest,p_actor_id,p_notes,p_key) returning id into result;
 return result;
end $$;
revoke all on function public.prepare_books_payroll_posting_proposal(uuid,uuid,uuid,uuid,jsonb,text,text,text) from public,anon,authenticated;
grant execute on function public.prepare_books_payroll_posting_proposal(uuid,uuid,uuid,uuid,jsonb,text,text,text) to service_role;

create function public.review_books_payroll_posting_proposal(p_org_id uuid,p_id uuid,p_actor_id uuid,p_plan jsonb,p_digest text,p_notes text)
returns uuid language plpgsql security invoker set search_path=pg_catalog,public as $$
declare item public.books_payroll_posting_proposals; parent public.books_payroll_imports; payment public.books_payroll_payment_reviews;
begin
 perform pg_advisory_xact_lock(hashtextextended('payroll-import:'||p_org_id::text,0));
 select p.* into parent from public.books_payroll_imports p join public.books_payroll_posting_proposals r on r.org_id=p.org_id and r.payroll_import_id=p.id where r.org_id=p_org_id and r.id=p_id for share of p;
 select * into item from public.books_payroll_posting_proposals where org_id=p_org_id and id=p_id for update;
 if not found then raise exception 'Payroll posting proposal is unavailable in organization';end if;
 select * into payment from public.books_payroll_payment_reviews where org_id=p_org_id and id=item.payment_review_id for share;
 if p_actor_id=item.prepared_by or p_actor_id=parent.prepared_by or p_actor_id=payment.prepared_by or not exists(select 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active') or coalesce(length(trim(p_notes)),0)<10 then raise exception 'Payroll posting proposal requires separate active reviewer';end if;
 if item.plan is distinct from p_plan or item.plan_digest is distinct from p_digest then raise exception 'Payroll posting proposal changed before review';end if;
 perform public.verify_books_payroll_posting_plan(p_org_id,item.payroll_import_id,p_plan);
 if item.status='reviewed' and item.reviewed_by=p_actor_id and item.review_notes=p_notes then return item.id;end if;
 if item.status<>'draft' then raise exception 'Payroll posting review requires draft';end if;
 update public.books_payroll_posting_proposals set status='reviewed',reviewed_by=p_actor_id,reviewed_at=now(),review_notes=p_notes where org_id=p_org_id and id=p_id;
 return item.id;
end $$;
revoke all on function public.review_books_payroll_posting_proposal(uuid,uuid,uuid,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.review_books_payroll_posting_proposal(uuid,uuid,uuid,jsonb,text,text) to service_role;

create function public.withdraw_books_payroll_posting_proposal(p_org_id uuid,p_id uuid,p_actor_id uuid,p_reason text)
returns uuid language plpgsql security invoker set search_path=pg_catalog,public as $$
declare item public.books_payroll_posting_proposals;
begin
 if not exists(select 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active') or coalesce(length(trim(p_reason)),0)<10 then raise exception 'Payroll posting withdrawal requires active actor and reason';end if;
 perform pg_advisory_xact_lock(hashtextextended('payroll-import:'||p_org_id::text,0));
 select * into item from public.books_payroll_posting_proposals where org_id=p_org_id and id=p_id for update;
 if not found then raise exception 'Payroll posting proposal is unavailable in organization';end if;
 if item.status='withdrawn' and item.withdrawn_by=p_actor_id and item.withdrawal_reason=p_reason then return item.id;end if;
 if item.status not in('draft','reviewed') then raise exception 'Payroll posting proposal cannot be withdrawn';end if;
 update public.books_payroll_posting_proposals set status='withdrawn',withdrawn_by=p_actor_id,withdrawn_at=now(),withdrawal_reason=p_reason where org_id=p_org_id and id=p_id;
 return item.id;
end $$;
revoke all on function public.withdraw_books_payroll_posting_proposal(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.withdraw_books_payroll_posting_proposal(uuid,uuid,uuid,text) to service_role;

create function public.withdraw_payroll_proposals_with_source() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if new.status='withdrawn' and old.status<>'withdrawn' then
  if tg_table_name='books_payroll_imports' then
   update public.books_payroll_posting_proposals set status='withdrawn',withdrawn_by=new.withdrawn_by,withdrawn_at=new.withdrawn_at,withdrawal_reason='Payroll parent withdrawn: '||new.withdrawal_reason where org_id=new.org_id and payroll_import_id=new.id and status<>'withdrawn';
  else
   update public.books_payroll_posting_proposals set status='withdrawn',withdrawn_by=new.withdrawn_by,withdrawn_at=new.withdrawn_at,withdrawal_reason='Payroll payment ownership withdrawn: '||new.withdrawal_reason where org_id=new.org_id and payment_review_id=new.id and status<>'withdrawn';
  end if;
 end if;
 return new;
end $$;
create trigger payroll_posting_parent_withdrawal before update of status on public.books_payroll_imports for each row execute function public.withdraw_payroll_proposals_with_source();
create trigger payroll_posting_payment_withdrawal before update of status on public.books_payroll_payment_reviews for each row execute function public.withdraw_payroll_proposals_with_source();
revoke all on function public.withdraw_payroll_proposals_with_source() from public,anon,authenticated;

create or replace function public.capture_books_export_snapshot(p_org_id uuid)
returns jsonb language plpgsql stable security invoker
set search_path = pg_catalog, public
as $$
declare
  v_table text;
  v_rows jsonb;
  v_tables jsonb := '{}'::jsonb;
begin
  if p_org_id is null then raise exception 'Export organization is required'; end if;
  foreach v_table in array array[
    'closings',
    'closing_checklist_items',
    'lot_takedowns',
    'lot_reservations',
    'budgets',
    'budget_lines',
    'commitments',
    'commitment_lines',
    'change_orders',
    'file_links',
    'project_financial_settings',
    'divisions',
    'communities',
    'community_phases',
    'lots',
    'contracts',
    'cost_codes',
    'time_entries',
    'warranty_requests',
    'warranty_service_visits',
    'warranty_backcharges',
    'org_funding_sources',
    'disbursements',
    'payment_runs',
    'payment_run_items',
    'payment_run_fee_charges',
    'receivable_adjustments',
    'books_deposit_batches',
    'books_deposit_batch_items',
    'receivable_payment_groups',
    'receivable_payment_group_items',
    'books_tax_adjustment_workpapers',
    'books_payroll_imports',
    'books_payroll_payment_reviews',
    'books_payroll_posting_proposals',
    'books_overhead_budgets',
    'books_overhead_budget_lines',
    'books_settings',
    'accounting_policies',
    'accounting_account_mappings',
    'gl_accounts',
    'books_projection_receipts',
    'accounting_facts',
    'journal_entries',
    'journal_lines',
    'accounting_periods',
    'accounting_reconciliation_runs',
    'accounting_reconciliation_items',
    'poc_snapshots',
    'books_comparison_runs',
    'books_comparison_items',
    'opening_balance_batches',
    'opening_balance_lines',
    'opening_balance_approvals',
    'bank_accounts',
    'bank_transactions',
    'bank_transaction_details',
    'bank_receipts',
    'bank_transaction_revisions',
    'bank_transaction_matches',
    'bank_reconciliations',
    'bank_reconciliation_items',
    'bank_rules',
    'coding_rules',
    'books_debt_instruments',
    'books_debt_events',
    'books_fixed_assets',
    'books_fixed_asset_events',
    'books_tax_jurisdictions',
    'books_tax_filings',
    'books_greenfield_launches',
    'books_journal_proposals',
    'books_cutover_runs',
    'books_cutover_approvals',
    'books_close_items',
    'recurring_posting_templates',
    'recurring_posting_lines',
    'financial_statement_snapshots',
    'tax_policy_versions',
    'companies',
    'contacts',
    'projects',
    'invoices',
    'invoice_lines',
    'payments',
    'payment_allocations',
    'payment_reversals',
    'vendor_bills',
    'bill_lines',
    'project_expenses',
    'project_expense_lines',
    'job_cost_entries',
    'billable_costs',
    'retainage',
    'doc_versions',
    'files',
    'audit_log'
  ] loop
    execute format('select coalesce(jsonb_agg(to_jsonb(t) order by t.id), ''[]''::jsonb) from public.%I t where t.org_id = $1', v_table)
      into v_rows using p_org_id;
    v_tables := v_tables || jsonb_build_object(v_table, v_rows);
  end loop;
  return jsonb_build_object('orgId', p_org_id, 'capturedAt', statement_timestamp(),
    'databaseSnapshot', pg_current_snapshot()::text, 'tables', v_tables);
end;
$$;
revoke all on function public.capture_books_export_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.capture_books_export_snapshot(uuid) to service_role;
