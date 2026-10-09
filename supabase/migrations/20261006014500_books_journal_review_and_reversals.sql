-- Ledger relationship keys, exact reversals, adjustment pairs, journal proposal review and request resolutions, exact export identities and service-only Books privileges (B03, B06, B09).
--
-- Consolidated before deploy (2026-10-09) from 9 unapplied migrations, in their
-- original order; each section is marked with the file it came from.

-- ==== 20261004180803_books_export_lossless_row_identity ====
-- Preserve bigint audit row identities before JSON reaches JavaScript. UUID
-- identities stay identical; retained numeric IDs use exact decimal strings.
-- Native column types and data are unchanged; restoration casts JSON strings.
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
    'books_payroll_posting_proposals','books_payroll_postings','books_payroll_labor_ownership',
    'books_payroll_correction_sources','books_payroll_correction_proposals',
    'books_payroll_correction_postings',
    'books_overhead_budgets',
    'books_overhead_budget_lines',
    'books_legal_entities',
    'books_legal_entity_members',
    'books_legal_entity_access_history',
    'books_legal_entity_profiles',
    'books_legal_entity_profile_reviews',
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
    execute format('select coalesce(jsonb_agg((to_jsonb(t) || jsonb_build_object(''id'', t.id::text)) order by t.id), ''[]''::jsonb) from public.%I t where t.org_id = $1', v_table)
      into v_rows using p_org_id;
    v_tables := v_tables || jsonb_build_object(v_table, v_rows);
  end loop;
  return jsonb_build_object('orgId', p_org_id, 'capturedAt', statement_timestamp(),
    'databaseSnapshot', pg_current_snapshot()::text, 'tables', v_tables);
end;
$$;
revoke all on function public.capture_books_export_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.capture_books_export_snapshot(uuid) to service_role;

-- ==== 20261004193127_books_core_ledger_owner_relationships ====
-- Preserve IDs, cents, posting keys and source payloads. Existing corrupt links
-- must abort this upgrade; they require reviewed correction, never relabeling.
alter table public.gl_accounts add constraint gl_accounts_owner_identity_key unique(org_id,id);
alter table public.accounting_periods add constraint accounting_periods_owner_identity_key unique(org_id,id);
alter table public.accounting_facts add constraint accounting_facts_owner_identity_key unique(org_id,id);
alter table public.journal_entries add constraint journal_entries_owner_identity_key unique(org_id,id);

alter table public.gl_accounts add constraint gl_accounts_parent_owner_fk foreign key(org_id,parent_id) references public.gl_accounts(org_id,id);
alter table public.accounting_facts add constraint accounting_facts_supersedes_owner_fk foreign key(org_id,supersedes_fact_id) references public.accounting_facts(org_id,id);
alter table public.accounting_facts add constraint accounting_facts_reversal_owner_fk foreign key(org_id,reversal_of_fact_id) references public.accounting_facts(org_id,id);
alter table public.journal_entries add constraint journal_entries_fact_owner_fk foreign key(org_id,fact_id) references public.accounting_facts(org_id,id);
alter table public.journal_entries add constraint journal_entries_period_owner_fk foreign key(org_id,period_id) references public.accounting_periods(org_id,id);
alter table public.journal_entries add constraint journal_entries_reversal_owner_fk foreign key(org_id,reversal_of_entry_id) references public.journal_entries(org_id,id);
alter table public.journal_lines add constraint journal_lines_entry_owner_fk foreign key(org_id,entry_id) references public.journal_entries(org_id,id);
alter table public.journal_lines add constraint journal_lines_account_owner_fk foreign key(org_id,account_id) references public.gl_accounts(org_id,id);

-- ==== 20261004194104_books_exact_reversal_posting ====
create function public.books_reversal_line_signature(p_lines jsonb,p_swap boolean default false,p_descriptions boolean default false)
returns jsonb language sql immutable security invoker set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(value order by value::text),'[]'::jsonb) from (
  select jsonb_build_object('account_id',l.account_id,'project_id',l.project_id,'company_id',l.company_id,
   'debit_cents',coalesce(case when p_swap then l.credit_cents else l.debit_cents end,0),
   -- books_account_classification is derived by the posting trigger from the original (or
   -- marked legacy_unknown when the original predates capture), never caller intent.
   'credit_cents',coalesce(case when p_swap then l.debit_cents else l.credit_cents end,0),'dimensions',coalesce(l.dimensions,'{}'::jsonb)-'books_account_classification')
   ||case when p_descriptions then jsonb_build_object('description',nullif(l.description,'')) else '{}'::jsonb end value
  from jsonb_to_recordset(p_lines) l(account_id uuid,project_id uuid,company_id uuid,debit_cents bigint,credit_cents bigint,dimensions jsonb,description text)
 ) normalized;
$$;
-- Validate existing committed chains without rewriting any historical money.
do $$
begin
 if exists(select 1 from public.journal_entries r left join public.journal_entries p on p.org_id=r.org_id and p.id=r.reversal_of_entry_id
  where r.status in('posted','reversed') and (r.entry_kind='reversal' or r.reversal_of_entry_id is not null)
  and (p.id is null or p.id=r.id or p.status<>'reversed' or r.entry_kind<>'reversal' or r.entry_date<p.entry_date
   or public.books_reversal_line_signature((select coalesce(jsonb_agg(to_jsonb(l)),'[]') from public.journal_lines l where l.org_id=r.org_id and l.entry_id=r.id))
    is distinct from public.books_reversal_line_signature((select coalesce(jsonb_agg(to_jsonb(l)),'[]') from public.journal_lines l where l.org_id=p.org_id and l.entry_id=p.id),true)))
  or exists(select 1 from public.journal_entries p where p.status='reversed' and (select count(*) from public.journal_entries r where r.org_id=p.org_id and r.reversal_of_entry_id=p.id and r.status in('posted','reversed'))<>1)
 then raise exception 'Existing reversal history requires reviewed correction before upgrade';end if;
end $$;
create unique index journal_entries_one_committed_reversal_idx on public.journal_entries(org_id,reversal_of_entry_id) where reversal_of_entry_id is not null and status in('posted','reversed');

create function public.books_guard_exact_reversal() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare parent public.journal_entries; actual jsonb; expected jsonb;
begin
 if new.status<>'posted' or (tg_op='UPDATE' and old.status='posted') then return new;end if;
 if new.entry_kind<>'reversal' and new.reversal_of_entry_id is null then return new;end if;
 if new.entry_kind<>'reversal' or new.reversal_of_entry_id is null or new.reversal_of_entry_id=new.id then raise exception 'Reversal must identify its original journal';end if;
 select * into parent from public.journal_entries where org_id=new.org_id and id=new.reversal_of_entry_id for update;
 if parent.id is null or parent.status<>'posted' or new.entry_date<parent.entry_date then raise exception 'Reversal requires a posted original and a date on or after its accounting date';end if;
 select public.books_reversal_line_signature(coalesce(jsonb_agg(to_jsonb(l)),'[]')) into actual from public.journal_lines l where l.org_id=new.org_id and l.entry_id=new.id;
 select public.books_reversal_line_signature(coalesce(jsonb_agg(to_jsonb(l)),'[]'),true) into expected from public.journal_lines l where l.org_id=parent.org_id and l.entry_id=parent.id;
 if jsonb_array_length(actual)<2 or actual is distinct from expected then raise exception 'Reversal must exactly mirror original accounts, amounts and dimensions';end if;
 return new;
end $$;
create trigger journal_entries_exact_reversal_guard before insert or update of status on public.journal_entries for each row execute function public.books_guard_exact_reversal();
create function public.books_complete_exact_reversal() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if new.status='posted' and new.reversal_of_entry_id is not null and (tg_op='INSERT' or old.status<>'posted') then
  update public.journal_entries set status='reversed' where org_id=new.org_id and id=new.reversal_of_entry_id and status='posted';
 end if;
 return new;
end $$;
create trigger journal_entries_exact_reversal_complete after insert or update of status on public.journal_entries for each row execute function public.books_complete_exact_reversal();
create or replace function public.reverse_books_journal_entry(p_org_id uuid,p_original_entry_id uuid,p_entry jsonb,p_lines jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare original public.journal_entries; reversal public.journal_entries; reversal_id uuid; saved_lines jsonb;
begin
 if jsonb_typeof(p_entry) is distinct from 'object' or jsonb_typeof(p_lines) is distinct from 'array' then raise exception 'Reversal requires entry and lines';end if;
 select * into original from public.journal_entries where org_id=p_org_id and id=p_original_entry_id for update;
 if original.id is null then raise exception 'Original journal entry not found';end if;
 if p_entry->>'entry_kind' is distinct from 'reversal' or nullif(p_entry->>'reversal_of_entry_id','')::uuid is distinct from original.id then raise exception 'Reversal payload does not identify original';end if;
 select * into reversal from public.journal_entries where org_id=p_org_id and reversal_of_entry_id=original.id and status in('posted','reversed');
 if reversal.id is not null then
  select coalesce(jsonb_agg(to_jsonb(l)),'[]') into saved_lines from public.journal_lines l where l.org_id=p_org_id and l.entry_id=reversal.id;
  if original.status<>'reversed' or reversal.entry_date is distinct from (p_entry->>'entry_date')::date
   or reversal.memo is distinct from p_entry->>'memo' or reversal.posting_key is distinct from p_entry->>'posting_key'
   or reversal.projection_version is distinct from coalesce((p_entry->>'projection_version')::integer,1)
   or reversal.policy_version is distinct from (p_entry->>'policy_version')::integer
   or reversal.fact_id is distinct from nullif(p_entry->>'fact_id','')::uuid
   or reversal.source_type is distinct from nullif(p_entry->>'source_type','')
   or reversal.source_id is distinct from nullif(p_entry->>'source_id','')::uuid
   or reversal.created_by is distinct from nullif(p_entry->>'created_by','')::uuid
   or public.books_reversal_line_signature(saved_lines,false,true) is distinct from public.books_reversal_line_signature(p_lines,false,true)
  then raise exception 'Reversal retry differs from committed intent';end if;
  return jsonb_build_object('id',reversal.id,'created',false);
 end if;
 if original.status<>'posted' then raise exception 'Only a posted journal entry can be reversed';end if;
 reversal_id:=public.post_books_journal_entry(p_org_id,p_entry,p_lines);
 return jsonb_build_object('id',reversal_id,'created',true);
end $$;
revoke all on function public.books_reversal_line_signature(jsonb,boolean,boolean),public.books_guard_exact_reversal(),public.books_complete_exact_reversal(),public.reverse_books_journal_entry(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.books_reversal_line_signature(jsonb,boolean,boolean),public.books_guard_exact_reversal(),public.books_complete_exact_reversal(),public.reverse_books_journal_entry(uuid,uuid,jsonb,jsonb) to service_role;

-- ==== 20261004195905_books_atomic_adjustment_pair ====
-- One direct manual intent; existing IDs/posting keys survive legacy recovery.
create function public.post_books_adjustment_pair(p_org uuid,p_actor uuid,p_date date,p_memo text,p_key text,p_policy integer,p_lines jsonb,p_reversing_on date default null)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare original public.journal_entries; child public.journal_entries; saved jsonb; reversal_lines jsonb; result jsonb; created boolean:=false; recovered boolean:=false; reversal_created boolean:=false; reversal_id uuid;
begin
 if p_actor is null or p_date is null or length(btrim(coalesce(p_memo,'')))<4 or p_key is null or p_key!~'^adjustment:[a-f0-9]{64}$' or p_policy is null or p_policy<1 or jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines)<2 or(p_reversing_on is not null and p_reversing_on<p_date) then raise exception 'Invalid manual adjustment intent';end if;
 perform 1 from public.memberships where org_id=p_org and user_id=p_actor and status='active' for share;
 if not found then raise exception 'Active organization membership is required';end if;
 perform pg_advisory_xact_lock(hashtextextended('books-manual-adjustment:'||p_org::text||':'||p_key,0));
 select * into original from public.journal_entries where org_id=p_org and posting_key=p_key for update;
 if original.id is not null then
  select coalesce(jsonb_agg(to_jsonb(l)),'[]') into saved from public.journal_lines l where l.org_id=p_org and l.entry_id=original.id;
  if original.status not in('posted','reversed') or original.entry_kind<>'adjusting' or original.entry_date is distinct from p_date or original.memo is distinct from btrim(p_memo) or original.policy_version is distinct from p_policy or original.projection_version<>1 or original.created_by is distinct from p_actor or original.fact_id is not null or original.source_id is not null or original.reversal_of_entry_id is not null or coalesce(original.source_type,'') not in('','manual_adjustment','manual_adjustment_pair') or public.books_reversal_line_signature(saved,false,true) is distinct from public.books_reversal_line_signature(p_lines,false,true) then raise exception 'Manual adjustment retry differs from retained original';end if;
  select * into child from public.journal_entries where org_id=p_org and reversal_of_entry_id=original.id and status in('posted','reversed');
  if original.source_type='manual_adjustment' and p_reversing_on is not null then raise exception 'Manual adjustment retry changes its reversal schedule';end if;
  if original.source_type='manual_adjustment_pair' and p_reversing_on is null then raise exception 'Manual adjustment retry changes its reversal schedule';end if;
  if p_reversing_on is null and original.source_type is distinct from 'manual_adjustment' and child.posting_key like 'scheduled_reversal:'||original.id::text||':%' then raise exception 'Manual adjustment retry omits retained reversal schedule';end if;
  if p_reversing_on is not null and child.id is null then
   if original.source_type is not null or original.status<>'posted' then raise exception 'Retained scheduled pair is incomplete; reviewed recovery is required';end if;
   recovered:=true;
  end if;
 else
  -- Original account deactivation cannot prevent a committed retry, but a new
  -- adjustment must still use currently active scoped accounts.
  perform 1 from public.gl_accounts a where a.org_id=p_org and a.id in(select l.account_id from jsonb_to_recordset(p_lines) l(account_id uuid)) for share;
  if exists(select 1 from jsonb_to_recordset(p_lines) l(account_id uuid) where not exists(select 1 from public.gl_accounts a where a.org_id=p_org and a.id=l.account_id and a.active)) then raise exception 'New adjustment accounts must be active and scoped';end if;
  original.id:=public.post_books_journal_entry(p_org,jsonb_build_object('entry_date',p_date,'entry_kind','adjusting','memo',btrim(p_memo),'posting_key',p_key,'projection_version',1,'policy_version',p_policy,'source_type',case when p_reversing_on is null then 'manual_adjustment' else 'manual_adjustment_pair' end,'created_by',p_actor),p_lines);
  created:=true;
 end if;
 if p_reversing_on is not null then
  select jsonb_agg(item||jsonb_build_object('debit_cents',coalesce(item->'credit_cents','0'::jsonb),'credit_cents',coalesce(item->'debit_cents','0'::jsonb)) order by(item->>'line_no')::integer) into reversal_lines from jsonb_array_elements(p_lines) item;
  result:=public.reverse_books_journal_entry(p_org,original.id,jsonb_build_object('entry_date',p_reversing_on,'entry_kind','reversal','memo','Automatic reversal: '||btrim(p_memo),'posting_key','scheduled_reversal:'||original.id::text||':'||p_reversing_on::text,'projection_version',1,'policy_version',p_policy,'created_by',p_actor,'reversal_of_entry_id',original.id),reversal_lines);
  reversal_id:=(result->>'id')::uuid;reversal_created:=(result->>'created')::boolean;
 end if;
 return jsonb_build_object('orgId',p_org,'actorId',p_actor,'postingKey',p_key,'id',original.id,'reversalId',reversal_id,'created',created,'reversalCreated',reversal_created,'legacyRecovered',recovered);
end $$;
revoke all on function public.post_books_adjustment_pair(uuid,uuid,date,text,text,integer,jsonb,date) from public,anon,authenticated;
grant execute on function public.post_books_adjustment_pair(uuid,uuid,date,text,text,integer,jsonb,date) to service_role;

-- ==== 20261004201613_books_journal_proposal_review_receipts ====
-- Freeze the complete submitted intent and retain exact independent review receipts.
create function public.books_validate_proposal_receipt(p public.books_journal_proposals)
returns void language plpgsql security invoker set search_path=pg_catalog,public as $$
declare j public.journal_entries; r public.journal_entries; saved jsonb;
begin
 if p.status='pending' then
  if p.reviewed_by is not null or p.reviewed_at is not null or p.review_note is not null or p.journal_entry_id is not null or p.reversal_entry_id is not null then raise exception 'Pending proposal has review evidence';end if;
  return;
 end if;
 if p.reviewed_by is null or p.reviewed_by=p.proposed_by or p.reviewed_at is null then raise exception 'Independent review evidence is required';end if;
 if p.status='rejected' then
  if length(btrim(coalesce(p.review_note,'')))<4 or p.journal_entry_id is not null or p.reversal_entry_id is not null then raise exception 'Invalid rejection receipt';end if;
  return;
 end if;
 select * into j from public.journal_entries where org_id=p.org_id and id=p.journal_entry_id;
 select coalesce(jsonb_agg(to_jsonb(l)),'[]') into saved from public.journal_lines l where org_id=p.org_id and entry_id=p.journal_entry_id;
 if j.id is null or j.status not in('posted','reversed') or j.entry_kind<>'adjusting' or j.entry_date is distinct from p.entry_date or j.memo is distinct from p.memo or j.posting_key is distinct from p.posting_key or j.policy_version is distinct from p.policy_version or j.projection_version<>1 or j.created_by is distinct from p.proposed_by or j.fact_id is not null or j.source_type is not null or j.source_id is not null or j.reversal_of_entry_id is not null or public.books_reversal_line_signature(saved,false,true) is distinct from public.books_reversal_line_signature(p.lines,false,true) then raise exception 'Proposal approval differs from retained journal';end if;
 if p.reversing_on is null then
  if p.reversal_entry_id is not null then raise exception 'Unscheduled proposal has a scheduled reversal receipt';end if;
 else
  select * into r from public.journal_entries where org_id=p.org_id and id=p.reversal_entry_id;
  select coalesce(jsonb_agg(to_jsonb(l)),'[]') into saved from public.journal_lines l where org_id=p.org_id and entry_id=p.reversal_entry_id;
  if r.id is null or r.status not in('posted','reversed') or r.entry_kind<>'reversal' or r.reversal_of_entry_id is distinct from j.id or r.entry_date is distinct from p.reversing_on or r.memo is distinct from 'Automatic reversal: '||p.memo or r.posting_key is distinct from 'scheduled_reversal:'||j.id::text||':'||p.reversing_on::text or r.created_by is distinct from p.proposed_by or r.policy_version is distinct from p.policy_version or r.projection_version<>1 or r.fact_id is not null or r.source_id is not null or public.books_reversal_line_signature(saved,false,true) is distinct from public.books_reversal_line_signature(p.lines,true,true) then raise exception 'Proposal approval differs from retained reversal';end if;
 end if;
end;
$$;
-- Validate history; corruption aborts the upgrade rather than inventing review evidence.
do $$ declare p public.books_journal_proposals;begin for p in select * from public.books_journal_proposals loop perform public.books_validate_proposal_receipt(p);end loop;end $$;
alter table public.books_journal_proposals
 add constraint books_proposal_journal_owner foreign key(org_id,journal_entry_id) references public.journal_entries(org_id,id),
 add constraint books_proposal_reversal_owner foreign key(org_id,reversal_entry_id) references public.journal_entries(org_id,id);
create or replace function public.books_guard_journal_proposal()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if tg_op='DELETE' then raise exception 'Journal proposals cannot be deleted';end if;
 if tg_op='INSERT' then
  if new.status<>'pending' or (new.reversing_on is not null and new.reversing_on<new.entry_date) then raise exception 'A new proposal must be pending with a valid reversal date';end if;
  perform 1 from public.memberships where org_id=new.org_id and user_id=new.proposed_by and status='active' for share;
  if not found then raise exception 'Active maker membership is required';end if;
 else
  if old.status<>'pending' then raise exception 'Reviewed journal proposals are immutable';end if;
  if (to_jsonb(new)-array['status','reviewed_by','reviewed_at','review_note','journal_entry_id','reversal_entry_id']) is distinct from (to_jsonb(old)-array['status','reviewed_by','reviewed_at','review_note','journal_entry_id','reversal_entry_id']) then raise exception 'Journal proposal intent is immutable';end if;
  if new.status not in('posted','rejected') then raise exception 'A pending proposal may only transition through review';end if;
  perform 1 from public.memberships where org_id=new.org_id and user_id=new.reviewed_by and status='active' for share;
  if not found then raise exception 'Active reviewer membership is required';end if;
 end if;
 perform public.books_validate_proposal_receipt(new);
 return new;
end;
$$;
drop trigger books_journal_proposals_guard on public.books_journal_proposals;
create trigger books_journal_proposals_guard before insert or update or delete on public.books_journal_proposals for each row execute function public.books_guard_journal_proposal();
create or replace function public.review_books_journal_proposal_atomic(p_org_id uuid,p_proposal_id uuid,p_reviewer_id uuid,p_decision text,p_note text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare p public.books_journal_proposals; j uuid; r uuid; created boolean:=false; note text:=nullif(btrim(coalesce(p_note,'')),'');
begin
 if p_decision is null or p_decision not in('approve','reject') or length(coalesce(note,''))>1000 then raise exception 'Invalid review decision or note';end if;
 perform 1 from public.memberships where org_id=p_org_id and user_id=p_reviewer_id and status='active' for share;
 if not found then raise exception 'Active reviewer membership is required';end if;
 select * into p from public.books_journal_proposals where org_id=p_org_id and id=p_proposal_id for update;
 if not found then raise exception 'Journal proposal not found';end if;
 if p.proposed_by=p_reviewer_id then raise exception 'The proposal maker cannot review their own entry';end if;
 if p.status<>'pending' then
  if p.status is distinct from (case when p_decision='approve' then 'posted' else 'rejected' end) or p.reviewed_by is distinct from p_reviewer_id or nullif(btrim(coalesce(p.review_note,'')),'') is distinct from note then raise exception 'Review retry differs from retained approval or rejection';end if;
  perform public.books_validate_proposal_receipt(p);
 else
  if p_decision='reject' then
   if length(coalesce(note,''))<4 then raise exception 'A rejection note is required';end if;
  else
   perform 1 from public.memberships where org_id=p_org_id and user_id=p.proposed_by and status='active' for share;
   if not found then raise exception 'Active maker membership is required for new approval';end if;
   perform 1 from public.gl_accounts a where org_id=p_org_id and a.id in(select l.account_id from jsonb_to_recordset(p.lines) l(account_id uuid)) for share;
   if exists(select 1 from jsonb_to_recordset(p.lines) l(account_id uuid) where not exists(select 1 from public.gl_accounts a where a.org_id=p_org_id and a.id=l.account_id and a.active)) then raise exception 'New approval accounts must be active and scoped';end if;
   if exists(select 1 from public.journal_entries where org_id=p_org_id and posting_key=p.posting_key) then raise exception 'Pending proposal posting key is already occupied; reviewed recovery is required';end if;
   j:=public.post_books_journal_entry(p_org_id,jsonb_build_object('entry_date',p.entry_date,'entry_kind','adjusting','memo',p.memo,'posting_key',p.posting_key,'projection_version',1,'policy_version',p.policy_version,'created_by',p.proposed_by),p.lines);
   if p.reversing_on is not null then
    r:=public.post_books_journal_entry(p_org_id,jsonb_build_object('entry_date',p.reversing_on,'entry_kind','reversal','memo','Automatic reversal: '||p.memo,'posting_key','scheduled_reversal:'||j::text||':'||p.reversing_on::text,'projection_version',1,'policy_version',p.policy_version,'reversal_of_entry_id',j,'created_by',p.proposed_by),(select jsonb_agg(item||jsonb_build_object('debit_cents',item->'credit_cents','credit_cents',item->'debit_cents') order by(item->>'line_no')::integer) from jsonb_array_elements(p.lines) item));
   end if;
  end if;
  update public.books_journal_proposals set status=case when p_decision='approve' then 'posted' else 'rejected' end,reviewed_by=p_reviewer_id,reviewed_at=now(),review_note=note,journal_entry_id=j,reversal_entry_id=r where id=p.id returning * into p;
  created:=true;
 end if;
 return jsonb_build_object('orgId',p.org_id,'proposalId',p.id,'reviewerId',p.reviewed_by,'status',p.status,'journal_entry_id',p.journal_entry_id,'reversal_entry_id',p.reversal_entry_id,'created',created);
end;
$$;
revoke all on function public.books_validate_proposal_receipt(public.books_journal_proposals),public.books_guard_journal_proposal(),public.review_books_journal_proposal_atomic(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.books_validate_proposal_receipt(public.books_journal_proposals),public.books_guard_journal_proposal(),public.review_books_journal_proposal_atomic(uuid,uuid,uuid,text,text) to service_role;

-- ==== 20261004203909_books_journal_preparation_intents ====
-- A fresh UUID identifies each legitimate preparation; retained receipts survive
-- subsequent chart/policy/review changes without resolving the original anew.
create function public.prepare_books_journal_proposal_atomic(p_org uuid,p_actor uuid,p_intent uuid,p_date date,p_memo text,p_reversing date,p_lines jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare p public.books_journal_proposals; item jsonb; idx bigint; account uuid; prepared jsonb:='[]'; retained jsonb; policy integer; debit numeric; credit numeric; total_debit numeric:=0;total_credit numeric:=0; created boolean:=false; key text:='adjustment-intent:'||p_intent::text;
begin
 if p_intent is null or p_date is null or length(btrim(coalesce(p_memo,'')))<4 or(p_reversing is not null and p_reversing<p_date) or jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) not between 2 and 1000 then raise exception 'Invalid journal preparation intent';end if;
 perform 1 from public.memberships where org_id=p_org and user_id=p_actor and status='active' for share;
 if not found then raise exception 'Active maker membership is required';end if;
 for item,idx in select value,ordinality from jsonb_array_elements(p_lines) with ordinality loop
  if jsonb_typeof(item) is distinct from 'object' or(item-array['line_no','account_code','project_id','company_id','description','debit_cents','credit_cents','dimensions'])<>'{}'::jsonb or(item->>'line_no')::integer is distinct from idx or length(coalesce(item->>'account_code',''))=0 or jsonb_typeof(item->'debit_cents') is distinct from 'number' or jsonb_typeof(item->'credit_cents') is distinct from 'number' or jsonb_typeof(item->'dimensions') is distinct from 'object' then raise exception 'Invalid submitted journal line';end if;
  debit:=(item->>'debit_cents')::numeric;credit:=(item->>'credit_cents')::numeric;
  if debit<>trunc(debit) or credit<>trunc(credit) or debit not between 0 and 9007199254740991 or credit not between 0 and 9007199254740991 or not((debit>0 and credit=0)or(credit>0 and debit=0)) then raise exception 'Journal lines require safe integer cents and one positive side';end if;
  total_debit:=total_debit+debit;total_credit:=total_credit+credit;
 end loop;
 if total_debit<>total_credit or total_debit>9007199254740991 then raise exception 'Submitted journal is unbalanced or exceeds safe integer cents';end if;
 perform pg_advisory_xact_lock(hashtextextended('books-journal-preparation:'||p_org::text||':'||p_intent::text,0));
 select * into p from public.books_journal_proposals where org_id=p_org and posting_key=key for update;
 if p.id is not null then
  select jsonb_agg(value-'account_id' order by ordinality) into retained from jsonb_array_elements(p.lines) with ordinality;
  if p.proposed_by is distinct from p_actor or p.entry_date is distinct from p_date or p.memo is distinct from btrim(p_memo) or p.reversing_on is distinct from p_reversing or retained is distinct from p_lines then raise exception 'Preparation retry differs from retained submitted intent';end if;
  perform public.books_validate_proposal_receipt(p);
 else
  select active_policy_version into policy from public.books_settings where org_id=p_org for share;
  if policy is null or policy<1 then raise exception 'Books policy must be initialized before preparation';end if;
  for item in select value from jsonb_array_elements(p_lines) loop
   select id into account from public.gl_accounts where org_id=p_org and code=item->>'account_code' and active for share;
   if account is null then raise exception 'Submitted account must be active and scoped';end if;
   if item->>'project_id' is not null then
    perform 1 from public.projects where org_id=p_org and id=(item->>'project_id')::uuid for share;
    if not found then raise exception 'Submitted project belongs to another organization';end if;
   end if;
   if item->>'company_id' is not null then
    perform 1 from public.companies where org_id=p_org and id=(item->>'company_id')::uuid for share;
    if not found then raise exception 'Submitted company belongs to another organization';end if;
   end if;
   prepared:=prepared||jsonb_build_array(item||jsonb_build_object('account_id',account));
  end loop;
  insert into public.books_journal_proposals(org_id,entry_date,memo,reversing_on,posting_key,policy_version,proposed_by,lines) values(p_org,p_date,btrim(p_memo),p_reversing,key,policy,p_actor,prepared) returning * into p;
  created:=true;
 end if;
 return jsonb_build_object('orgId',p.org_id,'actorId',p.proposed_by,'intentId',p_intent,'id',p.id,'status',p.status,'policyVersion',p.policy_version,'created',created);
end;
$$;
revoke all on function public.prepare_books_journal_proposal_atomic(uuid,uuid,uuid,date,text,date,jsonb) from public,anon,authenticated;
grant execute on function public.prepare_books_journal_proposal_atomic(uuid,uuid,uuid,date,text,date,jsonb) to service_role;

-- ==== 20261004211129_books_journal_request_resolutions ====
-- Append-only recovery decisions. Cancellation fences use the same lock as the
-- original writer, so an absent receipt cannot subsequently arrive unnoticed.
alter table public.books_journal_proposals add constraint books_journal_proposal_org_identity unique(org_id,id);
create table public.books_journal_request_resolutions(
 id uuid primary key,org_id uuid not null references public.orgs(id),actor_id uuid not null references public.app_users(id),
 kind text not null check(kind in('prepare','review')),request_key text not null,
 request_text text not null check(octet_length(request_text)<=4194304),request_sha256 text not null check(request_sha256 ~ '^[a-f0-9]{64}$'),
 resolution text not null check(resolution in('cancelled_preparation','cancelled_review','acknowledged_original_review','acknowledged_superseded_review')),
 observed_proposal_id uuid,observed_review jsonb,reason text not null check(length(btrim(reason)) between 4 and 1000),resolved_at timestamptz not null,
 unique(org_id,actor_id,kind,request_key),unique(org_id,id),
 foreign key(org_id,observed_proposal_id) references public.books_journal_proposals(org_id,id)
);
-- The existing proposal key is organization-wide; its receipt identity also
-- needs a composite reference for a retained recovery observation.
-- Operational coordination only: generations carry no accounting meaning and
-- can be rebuilt after restore. Updating a common tuple makes a stale higher-
-- isolation writer serialize/fail instead of reading an old cancellation view.
create table public.books_journal_request_fences(
 org_id uuid not null references public.orgs(id),actor_id uuid not null references public.app_users(id),kind text not null check(kind in('prepare','review')),request_key text not null,generation bigint not null check(generation>0),primary key(org_id,actor_id,kind,request_key)
);
alter table public.books_journal_request_fences enable row level security;
revoke all on table public.books_journal_request_fences from public,anon,authenticated;
grant all on table public.books_journal_request_fences to service_role;
create function public.books_lock_journal_request_fence(p_org uuid,p_actor uuid,p_kind text,p_key text)
returns void language sql volatile security invoker set search_path=pg_catalog,public as $$
 insert into public.books_journal_request_fences(org_id,actor_id,kind,request_key,generation) values(p_org,p_actor,p_kind,p_key,1) on conflict(org_id,actor_id,kind,request_key) do update set generation=public.books_journal_request_fences.generation+1;
$$;
revoke all on function public.books_lock_journal_request_fence(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.books_lock_journal_request_fence(uuid,uuid,text,text) to service_role;
create function public.books_journal_review_request_sha(p_org uuid,p_actor uuid,p_proposal uuid,p_decision text,p_note text)
returns text language sql immutable security invoker set search_path=pg_catalog,public as $$
 select encode(sha256(convert_to(jsonb_build_object('expectedOrgId',p_org,'expectedActorId',p_actor,'proposalId',p_proposal,'decision',p_decision,'note',btrim(coalesce(p_note,'')))::text,'UTF8')),'hex');
$$;
create function public.books_journal_resolution_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare r jsonb;target uuid;p public.books_journal_proposals;wanted text;
begin
 r:=new.request_text::jsonb;
 if jsonb_typeof(r) is distinct from 'object' or r->>'expectedOrgId' is distinct from new.org_id::text or r->>'expectedActorId' is distinct from new.actor_id::text then raise exception 'Resolution request belongs to another organization or actor';end if;
 perform 1 from public.memberships where org_id=new.org_id and user_id=new.actor_id and status='active' for share;
 if not found then raise exception 'Active resolution actor membership is required';end if;
 new.request_text:=r::text;new.request_sha256:=encode(sha256(convert_to(new.request_text,'UTF8')),'hex');
 new.observed_proposal_id:=null;new.observed_review:=null;
 if new.kind='prepare' then
  target:=(r->>'intentId')::uuid;
  if target is null or target::text is distinct from r->>'intentId' then raise exception 'Canonical preparation intent is required';end if;
  new.request_key:=target::text;
  perform pg_advisory_xact_lock(hashtextextended('books-journal-preparation:'||new.org_id::text||':'||target::text,0));
  perform public.books_lock_journal_request_fence(new.org_id,new.actor_id,'prepare',new.request_key);
  if exists(select 1 from public.books_journal_proposals where org_id=new.org_id and posting_key='adjustment-intent:'||target::text) then raise exception 'Original preparation already committed; recover its receipt';end if;
  new.resolution:='cancelled_preparation';
 elsif new.kind='review' then
  target:=(r->>'proposalId')::uuid;
  if target is null or target::text is distinct from r->>'proposalId' or r-array['expectedOrgId','expectedActorId','proposalId','decision','note']<>'{}' or r->>'decision' is null or r->>'decision' not in('approve','reject') or jsonb_typeof(r->'note') is distinct from 'string' or r->>'note' is distinct from btrim(r->>'note') or new.request_sha256 is distinct from public.books_journal_review_request_sha(new.org_id,new.actor_id,target,r->>'decision',r->>'note') then raise exception 'Canonical independent review request is required';end if;
  new.request_key:=target::text||':'||new.request_sha256;
  -- Serialize two absent-row cancellations as well as a concurrent review of
  -- an existing row. The normal writer itself locks that same proposal row.
  perform pg_advisory_xact_lock(hashtextextended('books-journal-review-resolution:'||new.org_id::text||':'||target::text,0));
  perform public.books_lock_journal_request_fence(new.org_id,new.actor_id,'review',new.request_key);
  select * into p from public.books_journal_proposals where org_id=new.org_id and id=target for update;
  new.observed_proposal_id:=p.id;
  if p.id is null or p.status='pending' then new.resolution:='cancelled_review';
  else
   perform public.books_validate_proposal_receipt(p);
   wanted:=case when r->>'decision'='approve' then 'posted' else 'rejected' end;
   new.resolution:=case when p.status=wanted and p.reviewed_by=new.actor_id and btrim(coalesce(p.review_note,''))=r->>'note' then 'acknowledged_original_review' else 'acknowledged_superseded_review' end;
   new.observed_review:=jsonb_build_object('status',p.status,'reviewedBy',p.reviewed_by,'reviewedAt',p.reviewed_at,'note',p.review_note,'journalEntryId',p.journal_entry_id,'reversalEntryId',p.reversal_entry_id);
  end if;
 else raise exception 'Unknown journal recovery kind';end if;
 new.reason:=btrim(new.reason);new.resolved_at:=clock_timestamp();return new;
end;
$$;
create trigger books_journal_resolution_guard before insert on public.books_journal_request_resolutions for each row execute function public.books_journal_resolution_guard();
create trigger books_journal_resolutions_immutable before update or delete on public.books_journal_request_resolutions for each row execute function public.books_reject_mutation();
create function public.books_journal_resolution_writer_fence()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare intent uuid;signature text;
begin
 if tg_op='INSERT' and new.posting_key like 'adjustment-intent:%' then
  intent:=substring(new.posting_key from length('adjustment-intent:')+1)::uuid;
  perform pg_advisory_xact_lock(hashtextextended('books-journal-preparation:'||new.org_id::text||':'||intent::text,0));
  perform public.books_lock_journal_request_fence(new.org_id,new.proposed_by,'prepare',intent::text);
  if exists(select 1 from public.books_journal_request_resolutions where org_id=new.org_id and actor_id=new.proposed_by and kind='prepare' and request_key=intent::text and resolution='cancelled_preparation') then raise exception 'Original journal preparation was cancelled; use a new intent';end if;
 elsif tg_op='UPDATE' and old.status='pending' and new.status in('posted','rejected') then
  signature:=public.books_journal_review_request_sha(new.org_id,new.reviewed_by,new.id,case when new.status='posted' then 'approve' else 'reject' end,new.review_note);
  perform public.books_lock_journal_request_fence(new.org_id,new.reviewed_by,'review',new.id::text||':'||signature);
  if exists(select 1 from public.books_journal_request_resolutions where org_id=new.org_id and actor_id=new.reviewed_by and kind='review' and request_key=new.id::text||':'||signature and resolution='cancelled_review') then raise exception 'Original independent journal review was cancelled; submit a new review intent';end if;
 end if;
 return new;
end;
$$;
create trigger books_journal_resolution_writer_fence before insert or update on public.books_journal_proposals for each row execute function public.books_journal_resolution_writer_fence();
create function public.resolve_books_journal_request_atomic(p_org uuid,p_actor uuid,p_id uuid,p_kind text,p_request jsonb,p_reason text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare previous public.books_journal_request_resolutions;key text;signature text;created boolean:=false;
begin
 if p_id is null or p_request is null or jsonb_typeof(p_request) is distinct from 'object' or length(btrim(coalesce(p_reason,''))) not between 4 and 1000 then raise exception 'Resolution identity, original request and explanation are required';end if;
 perform 1 from public.memberships where org_id=p_org and user_id=p_actor and status='active' for share;
 if not found then raise exception 'Active resolution actor membership is required';end if;
 signature:=encode(sha256(convert_to(p_request::text,'UTF8')),'hex');
 if p_kind='prepare' then key:=(p_request->>'intentId')::uuid::text;
 elsif p_kind='review' then key:=(p_request->>'proposalId')::uuid::text||':'||signature;
 else raise exception 'Unknown journal recovery kind';end if;
 perform pg_advisory_xact_lock(hashtextextended('books-journal-resolution-receipt:'||p_org::text||':'||p_actor::text||':'||p_kind||':'||key,0));
 select * into previous from public.books_journal_request_resolutions where org_id=p_org and actor_id=p_actor and kind=p_kind and request_key=key for update;
 if previous.id is not null then
  if previous.id is distinct from p_id or previous.request_text::jsonb is distinct from p_request or previous.reason is distinct from btrim(p_reason) then raise exception 'Resolution retry differs from retained decision';end if;
 else
  insert into public.books_journal_request_resolutions(id,org_id,actor_id,kind,request_key,request_text,request_sha256,resolution,reason,resolved_at) values(p_id,p_org,p_actor,p_kind,key,p_request::text,signature,'cancelled_review',btrim(p_reason),clock_timestamp()) returning * into previous;
  created:=true;
 end if;
 return jsonb_build_object('orgId',previous.org_id,'actorId',previous.actor_id,'id',previous.id,'kind',previous.kind,'requestText',previous.request_text,'requestSha256',previous.request_sha256,'resolution',previous.resolution,'observedProposalId',previous.observed_proposal_id,'observedReview',previous.observed_review,'created',created);
end;
$$;
alter table public.books_journal_request_resolutions enable row level security;
revoke all on table public.books_journal_request_resolutions from public,anon,authenticated;
grant all on table public.books_journal_request_resolutions to service_role;
revoke all on function public.books_journal_review_request_sha(uuid,uuid,uuid,text,text),public.books_journal_resolution_guard(),public.books_journal_resolution_writer_fence(),public.resolve_books_journal_request_atomic(uuid,uuid,uuid,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.books_journal_review_request_sha(uuid,uuid,uuid,text,text),public.books_journal_resolution_guard(),public.books_journal_resolution_writer_fence(),public.resolve_books_journal_request_atomic(uuid,uuid,uuid,text,jsonb,text) to service_role;
create or replace function public.review_books_journal_proposal_atomic(p_org_id uuid,p_proposal_id uuid,p_reviewer_id uuid,p_decision text,p_note text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare p public.books_journal_proposals; j uuid; r uuid; created boolean:=false; note text:=nullif(btrim(coalesce(p_note,'')),'');
begin
 if p_decision is null or p_decision not in('approve','reject') or length(coalesce(note,''))>1000 then raise exception 'Invalid review decision or note';end if;
 perform 1 from public.memberships where org_id=p_org_id and user_id=p_reviewer_id and status='active' for share;
 if not found then raise exception 'Active reviewer membership is required';end if;
 perform public.books_lock_journal_request_fence(p_org_id,p_reviewer_id,'review',p_proposal_id::text||':'||public.books_journal_review_request_sha(p_org_id,p_reviewer_id,p_proposal_id,p_decision,p_note));
 select * into p from public.books_journal_proposals where org_id=p_org_id and id=p_proposal_id for update;
 if not found then raise exception 'Journal proposal not found';end if;
 if p.proposed_by=p_reviewer_id then raise exception 'The proposal maker cannot review their own entry';end if;
 if p.status<>'pending' then
  if p.status is distinct from (case when p_decision='approve' then 'posted' else 'rejected' end) or p.reviewed_by is distinct from p_reviewer_id or nullif(btrim(coalesce(p.review_note,'')),'') is distinct from note then raise exception 'Review retry differs from retained approval or rejection';end if;
  perform public.books_validate_proposal_receipt(p);
 else
  if p_decision='reject' then
   if length(coalesce(note,''))<4 then raise exception 'A rejection note is required';end if;
  else
   perform 1 from public.memberships where org_id=p_org_id and user_id=p.proposed_by and status='active' for share;
   if not found then raise exception 'Active maker membership is required for new approval';end if;
   perform 1 from public.gl_accounts a where org_id=p_org_id and a.id in(select l.account_id from jsonb_to_recordset(p.lines) l(account_id uuid)) for share;
   if exists(select 1 from jsonb_to_recordset(p.lines) l(account_id uuid) where not exists(select 1 from public.gl_accounts a where a.org_id=p_org_id and a.id=l.account_id and a.active)) then raise exception 'New approval accounts must be active and scoped';end if;
   if exists(select 1 from public.journal_entries where org_id=p_org_id and posting_key=p.posting_key) then raise exception 'Pending proposal posting key is already occupied; reviewed recovery is required';end if;
   j:=public.post_books_journal_entry(p_org_id,jsonb_build_object('entry_date',p.entry_date,'entry_kind','adjusting','memo',p.memo,'posting_key',p.posting_key,'projection_version',1,'policy_version',p.policy_version,'created_by',p.proposed_by),p.lines);
   if p.reversing_on is not null then
    r:=public.post_books_journal_entry(p_org_id,jsonb_build_object('entry_date',p.reversing_on,'entry_kind','reversal','memo','Automatic reversal: '||p.memo,'posting_key','scheduled_reversal:'||j::text||':'||p.reversing_on::text,'projection_version',1,'policy_version',p.policy_version,'reversal_of_entry_id',j,'created_by',p.proposed_by),(select jsonb_agg(item||jsonb_build_object('debit_cents',item->'credit_cents','credit_cents',item->'debit_cents') order by(item->>'line_no')::integer) from jsonb_array_elements(p.lines) item));
   end if;
  end if;
  update public.books_journal_proposals set status=case when p_decision='approve' then 'posted' else 'rejected' end,reviewed_by=p_reviewer_id,reviewed_at=now(),review_note=note,journal_entry_id=j,reversal_entry_id=r where id=p.id returning * into p;
  created:=true;
 end if;
 return jsonb_build_object('orgId',p.org_id,'proposalId',p.id,'reviewerId',p.reviewed_by,'status',p.status,'journal_entry_id',p.journal_entry_id,'reversal_entry_id',p.reversal_entry_id,'created',created);
end;
$$;
-- Keep the complete export capture in one stable database snapshot. Recovery
-- decisions are not source ownership changes and do not invalidate historical
-- legacy-entity ownership populations merely by recording acknowledgement.
alter function public.capture_books_export_snapshot(uuid) rename to capture_books_export_snapshot_before_journal_resolutions;
create function public.capture_books_export_snapshot(p_org_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare snapshot jsonb;rows jsonb;
begin
 snapshot:=public.capture_books_export_snapshot_before_journal_resolutions(p_org_id);
 select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]') into rows from public.books_journal_request_resolutions r where org_id=p_org_id;
 return jsonb_set(snapshot,'{tables,books_journal_request_resolutions}',rows);
end;
$$;
revoke all on function public.capture_books_export_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.capture_books_export_snapshot(uuid) to service_role;
create or replace function public.capture_books_legacy_ownership_evidence(p_org uuid,p_actor uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_snapshot jsonb;v_tables jsonb;v_rows jsonb;
begin
 v_snapshot:=public.capture_books_entity_authorized_export(p_org,p_actor);
 v_tables:=(v_snapshot->'tables')-'books_legacy_entity_proposals'-'books_legacy_entity_reviews'-'books_journal_request_resolutions';
 select coalesce(jsonb_agg(row-'tax_id'-'ein'-'ssn' order by row->>'id'),'[]'::jsonb) into v_rows from jsonb_array_elements(v_tables->'companies') row;
 v_tables:=jsonb_set(v_tables,'{companies}',v_rows);
 select coalesce(jsonb_agg((select jsonb_object_agg(key,value) from jsonb_each(row) where key=any(array['id','org_id','provider','bank_name','account_type','last4','status','books_gl_account_id','created_at','updated_at'])) order by row->>'id'),'[]'::jsonb) into v_rows from jsonb_array_elements(v_tables->'org_funding_sources') row;
 v_tables:=jsonb_set(v_tables,'{org_funding_sources}',v_rows);
 return jsonb_build_object('populationText',v_tables::text,'capturedAt',v_snapshot->'capturedAt','databaseSnapshot',v_snapshot->'databaseSnapshot');
end;
$$;

-- ==== 20261005121818_books_invoice_quantity_export_text ====
-- Preserve the authoritative decimal before JSON crosses a JavaScript boundary.
-- Exact strings restore into numeric columns without an IEEE-754 round trip.
alter function public.capture_books_export_snapshot(uuid) rename to capture_books_export_snapshot_before_exact_invoice_quantity;
create function public.capture_books_export_snapshot(p_org_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare s jsonb;rows jsonb;
begin
 s:=public.capture_books_export_snapshot_before_exact_invoice_quantity(p_org_id);
 select coalesce(jsonb_agg(case when to_jsonb(r)?'quantity' then to_jsonb(r)||jsonb_build_object('quantity',to_jsonb(r)->>'quantity') else to_jsonb(r) end order by id),'[]') into rows
 from public.invoice_lines r where org_id=p_org_id;
 return jsonb_set(s,'{tables,invoice_lines}',rows);
end $$;
revoke all on function public.capture_books_export_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.capture_books_export_snapshot(uuid) to service_role;
revoke all on function public.capture_books_export_snapshot_before_exact_invoice_quantity(uuid) from public,anon,authenticated;
grant execute on function public.capture_books_export_snapshot_before_exact_invoice_quantity(uuid) to service_role;
-- Ownership approvals retain their original SQL JSON population protocol.
-- Transport encoding must not invalidate an unchanged frozen review.
alter function public.capture_books_legacy_ownership_evidence(uuid,uuid) rename to capture_books_legacy_ownership_before_exact_invoice_quantity;
create function public.capture_books_legacy_ownership_evidence(p_org uuid,p_actor uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare s jsonb;t jsonb;rows jsonb;
begin
 s:=public.capture_books_legacy_ownership_before_exact_invoice_quantity(p_org,p_actor);
 t:=(s->>'populationText')::jsonb;
 if not(t?'invoice_lines') then return s;end if;
 select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') into rows from public.invoice_lines r where org_id=p_org;
 t:=jsonb_set(t,'{invoice_lines}',rows);
 return jsonb_set(s,'{populationText}',to_jsonb(t::text));
end $$;
revoke all on function public.capture_books_legacy_ownership_evidence(uuid,uuid) from public,anon,authenticated;
grant execute on function public.capture_books_legacy_ownership_evidence(uuid,uuid) to service_role;
revoke all on function public.capture_books_legacy_ownership_before_exact_invoice_quantity(uuid,uuid) from public,anon,authenticated;
grant execute on function public.capture_books_legacy_ownership_before_exact_invoice_quantity(uuid,uuid) to service_role;

-- ==== 20261006014500_books_immutable_service_role_privileges ====
-- Supabase's default privileges give service_role ALL on new public tables.
-- Tables guarded by books_entity_immutable reject row UPDATE/DELETE, but
-- TRUNCATE bypasses row triggers, so the history was erasable by the server
-- role. Revoke DELETE and TRUNCATE; UPDATE stays because SELECT ... FOR UPDATE
-- (the entity and scope locks) requires it, and the trigger still rejects
-- every actual row update.
do $$
declare t regclass;
begin
 for t in
  select distinct tg.tgrelid::regclass from pg_trigger tg join pg_proc p on p.oid=tg.tgfoid
  where not tg.tgisinternal and p.proname='books_entity_immutable' and p.pronamespace='public'::regnamespace
 loop
  execute format('revoke delete,truncate on %s from service_role',t);
 end loop;
end $$;
