-- Separate reviewed tax workpapers. No operational facts or GL entries are posted.
create table public.books_tax_adjustment_workpapers (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null references public.orgs(id),
 period_start date not null, period_end date not null,
 status text not null default 'draft' check(status in('draft','approved','superseded','withdrawn')),
 base_digest text not null check(base_digest ~ '^[a-f0-9]{64}$'),
 base_snapshot jsonb not null,
 lines jsonb not null check(jsonb_typeof(lines)='array' and jsonb_array_length(lines) between 1 and 500),
 prepared_by uuid not null references public.app_users(id), prepared_at timestamptz not null default now(),
 reviewed_by uuid references public.app_users(id), reviewed_at timestamptz, review_notes text,
 closed_by uuid references public.app_users(id), closed_at timestamptz, close_reason text,
 supersedes_id uuid, idempotency_key text not null,
 unique(org_id,id), unique(org_id,idempotency_key),
 foreign key(org_id,supersedes_id) references public.books_tax_adjustment_workpapers(org_id,id),
 check(period_start<=period_end and period_end-period_start<=370),
 check(jsonb_typeof(base_snapshot)='object' and base_snapshot->>'basis'='cash' and (base_snapshot->>'version')::int=1 and base_snapshot->>'start_date'=period_start::text and base_snapshot->>'end_date'=period_end::text),
 check((status in('draft','withdrawn') and reviewed_by is null and reviewed_at is null) or (status in('approved','superseded') and reviewed_by is not null and reviewed_by<>prepared_by and reviewed_at is not null and coalesce(length(trim(review_notes)),0)>=10)),
 check((status in('draft','approved') and closed_by is null and closed_at is null) or (status in('withdrawn','superseded') and closed_by is not null and closed_at is not null and coalesce(length(trim(close_reason)),0)>=10))
);
create index books_tax_workpaper_period_idx on public.books_tax_adjustment_workpapers(org_id,period_start,period_end,status);
create unique index books_tax_workpaper_approved_period_idx on public.books_tax_adjustment_workpapers(org_id,period_start,period_end) where status='approved';
alter table public.books_tax_adjustment_workpapers enable row level security;
revoke all on public.books_tax_adjustment_workpapers from public,anon,authenticated;
grant select,insert,update on public.books_tax_adjustment_workpapers to service_role;

create function public.guard_books_tax_workpaper() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare item jsonb; seen uuid[]:='{}'; line_id uuid; amount numeric;
begin
 if tg_op='DELETE' then raise exception 'Tax workpaper history cannot be deleted'; end if;
 if new.status='approved' and (coalesce(length(trim(new.review_notes)),0)<10 or new.reviewed_by is null or new.reviewed_by=new.prepared_by or not exists(select 1 from public.memberships where org_id=new.org_id and user_id=new.reviewed_by and status='active')) then raise exception 'Tax approval requires substantive notes and a separate active reviewer'; end if;
 if new.status in('withdrawn','superseded') and (coalesce(length(trim(new.close_reason)),0)<10 or not exists(select 1 from public.memberships where org_id=new.org_id and user_id=new.closed_by and status='active')) then raise exception 'Tax workpaper closure requires substantive notes and active organization actor'; end if;
 if tg_op='INSERT' or new.status='approved' then
  if public.books_tax_source_revision(public.capture_books_export_snapshot(new.org_id),new.period_end) is distinct from new.base_snapshot->>'source_revision' then raise exception 'Cash source revision changed before workpaper transition'; end if;
 end if;
 if tg_op='UPDATE' then
  if to_jsonb(new)-array['status','reviewed_by','reviewed_at','review_notes','closed_by','closed_at','close_reason'] is distinct from to_jsonb(old)-array['status','reviewed_by','reviewed_at','review_notes','closed_by','closed_at','close_reason'] then raise exception 'Tax workpaper evidence is immutable'; end if;
  if not ((old.status='draft' and new.status='approved') or (old.status='draft' and new.status='withdrawn') or (old.status='approved' and new.status='superseded' and new.reviewed_by=old.reviewed_by and new.reviewed_at=old.reviewed_at and new.review_notes=old.review_notes)) then raise exception 'Invalid tax workpaper transition'; end if;
 else
  if new.status<>'draft' then raise exception 'Tax workpapers must start as drafts'; end if;
  if not exists(select 1 from public.memberships where org_id=new.org_id and user_id=new.prepared_by and status='active') then raise exception 'Tax preparer must be an active organization member'; end if;
  if new.base_snapshot->>'basis' is distinct from 'cash' or new.base_snapshot->>'version' is distinct from '1' or new.base_snapshot->>'start_date' is distinct from new.period_start::text or new.base_snapshot->>'end_date' is distinct from new.period_end::text or coalesce(new.base_snapshot->>'source_revision','') !~ '^[a-f0-9]{64}$' then raise exception 'Tax workpaper requires exact dated cash basis and source revision'; end if;
  if coalesce(jsonb_typeof(new.base_snapshot->'net_income_cents'),'')<>'number' or abs((new.base_snapshot->>'net_income_cents')::numeric)>9007199254740991 or (new.base_snapshot->>'net_income_cents')::numeric<>trunc((new.base_snapshot->>'net_income_cents')::numeric) then raise exception 'Tax base requires exact safe integer cents'; end if;
  for item in select value from jsonb_array_elements(new.lines) loop
   line_id:=(item->>'id')::uuid;
   if line_id is null or line_id=any(seen) then raise exception 'Missing or duplicate tax adjustment identity'; end if;
   seen:=array_append(seen,line_id);
   amount:=(item->>'amount_cents')::numeric;
   if jsonb_typeof(item->'amount_cents') is distinct from 'number' or amount is null or amount=0 or amount<>trunc(amount) or abs(amount)>9007199254740991 or coalesce(item->>'kind','') not in('permanent','timing') or coalesce(length(trim(item->>'description')),0)<10 or coalesce(length(trim(item->>'evidence_reference')),0)<3 then raise exception 'Tax adjustments require signed exact cents, classification, explanation and evidence'; end if;
   if item->>'project_id' is not null and not exists(select 1 from public.projects where id=(item->>'project_id')::uuid and org_id=new.org_id) then raise exception 'Tax adjustment project is outside organization'; end if;
   if item->>'evidence_file_id' is not null and not exists(select 1 from public.files where id=(item->>'evidence_file_id')::uuid and org_id=new.org_id) then raise exception 'Tax adjustment evidence file is outside organization'; end if;
  end loop;
  if exists(select 1 from jsonb_array_elements(new.lines) group by value->>'kind' having abs(sum((value->>'amount_cents')::numeric))>9007199254740991) then raise exception 'Tax adjustment category exceeds exact safe cents'; end if;
  if abs((select sum((value->>'amount_cents')::numeric) from jsonb_array_elements(new.lines)))>9007199254740991 or abs((new.base_snapshot->>'net_income_cents')::numeric+(select sum((value->>'amount_cents')::numeric) from jsonb_array_elements(new.lines)))>9007199254740991 then raise exception 'Tax workpaper aggregate exceeds exact safe cents'; end if;
 end if;
 return new;
end $$;
create trigger books_tax_workpaper_guard before insert or update or delete on public.books_tax_adjustment_workpapers for each row execute function public.guard_books_tax_workpaper();
revoke all on function public.guard_books_tax_workpaper() from public,anon,authenticated;

create function public.prepare_books_tax_workpaper(p_org_id uuid,p_actor_id uuid,p_period_start date,p_period_end date,p_base_digest text,p_base_snapshot jsonb,p_lines jsonb,p_idempotency_key text,p_supersedes_id uuid default null)
returns uuid language plpgsql security invoker set search_path=pg_catalog,public as $$
declare existing public.books_tax_adjustment_workpapers; result uuid;
begin
 if not exists(select 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active') then raise exception 'Tax preparer must be an active organization member'; end if;
 if p_org_id is null or p_actor_id is null or coalesce(length(trim(p_idempotency_key)),0)<10 then raise exception 'Tax workpaper scope, actor and retry key are required'; end if;
 perform pg_advisory_xact_lock(hashtextextended('tax-workpaper:'||p_org_id::text,0));
 select * into existing from public.books_tax_adjustment_workpapers where org_id=p_org_id and idempotency_key=p_idempotency_key;
 if found then
  if existing.prepared_by<>p_actor_id or existing.period_start<>p_period_start or existing.period_end<>p_period_end or existing.base_digest<>p_base_digest or existing.base_snapshot<>p_base_snapshot or existing.lines<>p_lines or existing.supersedes_id is distinct from p_supersedes_id then raise exception 'Tax workpaper retry key has different evidence'; end if;
  return existing.id;
 end if;
 if public.books_tax_source_revision(public.capture_books_export_snapshot(p_org_id),p_period_end) is distinct from p_base_snapshot->>'source_revision' then raise exception 'Cash source revision changed before preparation'; end if;
 if p_supersedes_id is not null and not exists(select 1 from public.books_tax_adjustment_workpapers where org_id=p_org_id and id=p_supersedes_id and status='approved' and period_start=p_period_start and period_end=p_period_end) then raise exception 'Replacement requires an approved workpaper for the same exact period'; end if;
 insert into public.books_tax_adjustment_workpapers(org_id,period_start,period_end,base_digest,base_snapshot,lines,prepared_by,idempotency_key,supersedes_id) values(p_org_id,p_period_start,p_period_end,p_base_digest,p_base_snapshot,p_lines,p_actor_id,p_idempotency_key,p_supersedes_id) returning id into result;
 return result;
end $$;
revoke all on function public.prepare_books_tax_workpaper(uuid,uuid,date,date,text,jsonb,jsonb,text,uuid) from public,anon,authenticated;
grant execute on function public.prepare_books_tax_workpaper(uuid,uuid,date,date,text,jsonb,jsonb,text,uuid) to service_role;

create function public.review_books_tax_workpaper(p_org_id uuid,p_id uuid,p_actor_id uuid,p_current_base_digest text,p_notes text)
returns uuid language plpgsql security invoker set search_path=pg_catalog,public as $$
declare item public.books_tax_adjustment_workpapers;
begin
 perform pg_advisory_xact_lock(hashtextextended('tax-workpaper:'||p_org_id::text,0));
 select * into item from public.books_tax_adjustment_workpapers where org_id=p_org_id and id=p_id for update;
 if not found then raise exception 'Tax workpaper not found in organization'; end if;
 if not exists(select 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active') or p_actor_id=item.prepared_by then raise exception 'Tax workpaper requires a different active organization reviewer'; end if;
 if public.books_tax_source_revision(public.capture_books_export_snapshot(p_org_id),item.period_end) is distinct from item.base_snapshot->>'source_revision' then raise exception 'Cash source revision changed before review'; end if;
 if p_current_base_digest is distinct from item.base_digest then raise exception 'Cash books changed since preparation; prepare a replacement'; end if;
 if coalesce(length(trim(p_notes)),0)<10 then raise exception 'Substantive tax review notes required'; end if;
 if item.status='approved' and item.reviewed_by=p_actor_id and item.review_notes=p_notes then return item.id; end if;
 if item.status<>'draft' then raise exception 'Only draft tax workpapers can be reviewed'; end if;
 if item.supersedes_id is not null then
  update public.books_tax_adjustment_workpapers set status='superseded',closed_by=p_actor_id,closed_at=now(),close_reason=p_notes where org_id=p_org_id and id=item.supersedes_id and status='approved' and period_start=item.period_start and period_end=item.period_end;
  if not found then raise exception 'Replacement target is no longer approved'; end if;
 end if;
 if exists(select 1 from public.books_tax_adjustment_workpapers where org_id=p_org_id and status='approved' and period_start=item.period_start and period_end=item.period_end) then raise exception 'Only one workpaper may be approved for an exact period'; end if;
 update public.books_tax_adjustment_workpapers set status='approved',reviewed_by=p_actor_id,reviewed_at=now(),review_notes=p_notes where id=item.id;
 return item.id;
end $$;
revoke all on function public.review_books_tax_workpaper(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.review_books_tax_workpaper(uuid,uuid,uuid,text,text) to service_role;

-- Only the posted history through cutoff and its current operational sources
-- contribute to this revision. New future-period transactions and workpaper
-- writes must not invalidate an already reviewed prior-period basis.
create function public.books_tax_source_revision(p_snapshot jsonb,p_end date)
returns text language plpgsql immutable security invoker set search_path=pg_catalog,public,extensions as $$
declare entries jsonb; facts jsonb; proof jsonb; t text; source_ids text[]; rows jsonb;
begin
 select coalesce(jsonb_agg(value order by value->>'id'),'[]') into entries from jsonb_array_elements(p_snapshot->'tables'->'journal_entries') where value->>'status' in('posted','reversed') and (value->>'entry_date')::date<=p_end;
 select coalesce(jsonb_agg(value order by value->>'id'),'[]') into facts from jsonb_array_elements(p_snapshot->'tables'->'accounting_facts') f where exists(select 1 from jsonb_array_elements(entries) e where e->>'fact_id'=f.value->>'id');
 proof:=jsonb_build_object('entries',entries,'facts',facts);
 select array_agg(value->>'source_id') into source_ids from jsonb_array_elements(facts);
 select coalesce(jsonb_agg(value order by value->>'id'),'[]') into rows from jsonb_array_elements(p_snapshot->'tables'->'journal_lines') l where exists(select 1 from jsonb_array_elements(entries) e where e->>'id'=l.value->>'entry_id');
 proof:=proof||jsonb_build_object('lines',rows);
 select coalesce(jsonb_agg(value order by value->>'source_type',value->>'source_id'),'[]') into rows from jsonb_array_elements(p_snapshot->'tables'->'books_projection_receipts') r where exists(select 1 from jsonb_array_elements(facts) f where f->>'source_type'=r.value->>'source_type' and f->>'source_id'=r.value->>'source_id');
 proof:=proof||jsonb_build_object('receipts',rows);
 foreach t in array array['invoices','vendor_bills','payments','project_expenses','payment_reversals','payment_run_fee_charges'] loop
  select coalesce(jsonb_agg(value order by value->>'id'),'[]') into rows from jsonb_array_elements(p_snapshot->'tables'->t) r where exists(select 1 from jsonb_array_elements(facts) f where f->>'source_id'=r.value->>'id' and f->>'source_type'=any(case t when 'invoices' then array['invoice'] when 'vendor_bills' then array['vendor_bill'] when 'payments' then array['invoice_payment','bill_payment'] when 'project_expenses' then array['expense'] when 'payment_reversals' then array['payment_reversal'] else array['ap_fee_charge'] end))
   or (t='payments' and r.value->>'status' in('completed','succeeded','paid','refunded') and substring(r.value->>'received_at',1,10)::date<=p_end)
   or (t='project_expenses' and r.value->>'status' in('approved','locked') and (r.value->>'expense_date')::date<=p_end)
   or (t='payment_reversals' and r.value->>'status'='succeeded' and substring(r.value->>'occurred_at',1,10)::date<=p_end)
   or (t='payment_run_fee_charges' and r.value->>'status'='succeeded' and substring(r.value->>'settled_at',1,10)::date<=p_end);
  select coalesce(source_ids,'{}')||coalesce(array_agg(value->>'id'),'{}') into source_ids from jsonb_array_elements(rows);
  proof:=proof||jsonb_build_object(t,rows);
 end loop;
 foreach t in array array['invoice_lines','bill_lines','project_expense_lines','payment_allocations'] loop
  select coalesce(jsonb_agg(value order by value->>'id'),'[]') into rows from jsonb_array_elements(p_snapshot->'tables'->t) r where (case t when 'invoice_lines' then r.value->>'invoice_id' when 'bill_lines' then r.value->>'bill_id' when 'project_expense_lines' then r.value->>'expense_id' else r.value->>'payment_id' end)=any(source_ids);
  proof:=proof||jsonb_build_object(t,rows);
 end loop;
 select coalesce(jsonb_agg(value order by value->>'id'),'[]') into rows from jsonb_array_elements(p_snapshot->'tables'->'receivable_adjustments') r where r.value->>'invoice_id'=any(source_ids) and (r.value->>'effective_date')::date<=p_end;
 proof:=proof||jsonb_build_object('receivable_adjustments',rows);
 return encode(digest(proof::text,'sha256'),'hex');
end $$;
revoke all on function public.books_tax_source_revision(jsonb,date) from public,anon,authenticated;
grant execute on function public.books_tax_source_revision(jsonb,date) to service_role;

create function public.capture_books_tax_workpaper_context(p_org_id uuid,p_period_end date)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare snapshot jsonb;
begin
 if p_period_end is null then raise exception 'Tax workpaper cutoff required'; end if;
 snapshot:=public.capture_books_export_snapshot(p_org_id);
 return snapshot||jsonb_build_object('taxSourceRevision',public.books_tax_source_revision(snapshot,p_period_end));
end $$;
revoke all on function public.capture_books_tax_workpaper_context(uuid,date) from public,anon,authenticated;
grant execute on function public.capture_books_tax_workpaper_context(uuid,date) to service_role;

-- Include separately collected Arc Pay fees in the same MVCC recovery/report snapshot.
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
