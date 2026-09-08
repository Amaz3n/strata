-- A categorized project cost owns one job-cost actual. It is never projected again.
alter table public.job_cost_entries drop constraint job_cost_entries_source_type_check;
alter table public.job_cost_entries add constraint job_cost_entries_source_type_check check(source_type in ('vendor_bill_line','project_expense','project_expense_line','time_entry','bank_transaction'));

create or replace function public.categorize_books_bank_transaction_atomic(
 p_org_id uuid,p_transaction_id uuid,p_account_id uuid,p_project_id uuid,p_cost_code_id uuid,p_memo text,p_actor_id uuid
) returns uuid language plpgsql security definer set search_path='' as $$
declare
 bank public.bank_accounts%rowtype; txn public.bank_transactions%rowtype; category public.gl_accounts%rowtype;
 category_entry_id uuid; cash_line_id uuid; policy integer; debit bigint; credit bigint;
begin
 select b.* into bank from public.bank_accounts b join public.bank_transactions t on t.bank_account_id=b.id and t.org_id=b.org_id where t.id=p_transaction_id and t.org_id=p_org_id for update of b;
 if not found or bank.gl_account_id is null then raise exception 'Map the bank account before categorizing'; end if;
 select * into txn from public.bank_transactions where org_id=p_org_id and id=p_transaction_id for update;
 if txn.lifecycle_status<>'posted' or txn.excluded then raise exception 'Only posted, included bank transactions can be categorized'; end if;
 select * into category from public.gl_accounts where org_id=p_org_id and id=p_account_id and active;
 if not found or category.id=bank.gl_account_id then raise exception 'Choose a different active category account in this organization'; end if;
 if p_project_id is not null and not exists(select 1 from public.projects where org_id=p_org_id and id=p_project_id) then raise exception 'Project not found in organization'; end if;
 if p_cost_code_id is not null and not exists(select 1 from public.cost_codes where org_id=p_org_id and id=p_cost_code_id) then raise exception 'Cost code not found in organization'; end if;
 if p_project_id is null and p_cost_code_id is not null then raise exception 'A cost code requires a project'; end if;
 if category.account_type='cogs' and p_project_id is null then raise exception 'Direct job costs require a project'; end if;
 if category.account_type='expense' and p_project_id is not null then raise exception 'Use a direct cost account for project spending, or leave overhead unassigned'; end if;
 select active_policy_version into policy from public.books_settings where org_id=p_org_id and workspace_enabled and arc_ledger_mode<>'disabled';
 if not found then raise exception 'Books posting is not enabled'; end if;
 debit:=case when txn.direction='outflow' then txn.amount_cents else 0 end;
 credit:=case when txn.direction='inflow' then txn.amount_cents else 0 end;
 select e.id into category_entry_id from public.journal_entries e where e.org_id=p_org_id and e.posting_key='bank_categorization:'||txn.id;
 if category_entry_id is not null then
   if not exists(select 1 from public.journal_entries e where e.id=category_entry_id and e.org_id=p_org_id and e.status='posted') then raise exception 'This categorization was reversed; review its correction before reposting'; end if;
   if not exists(select 1 from public.journal_lines l where l.org_id=p_org_id and l.entry_id=category_entry_id and l.account_id=category.id and l.project_id is not distinct from p_project_id and l.debit_cents=debit and l.credit_cents=credit) then raise exception 'Existing categorization differs; reverse it before changing the coding'; end if;
 else
   category_entry_id:=public.post_books_journal_entry(p_org_id,jsonb_build_object('entry_date',txn.transaction_date,'entry_kind','adjusting','memo',p_memo,'posting_key','bank_categorization:'||txn.id,'projection_version',1,'policy_version',policy,'source_type','bank_transaction','source_id',txn.id,'created_by',p_actor_id),
     jsonb_build_array(jsonb_build_object('line_no',1,'account_id',category.id,'project_id',p_project_id,'description',p_memo,'debit_cents',debit,'credit_cents',credit,'dimensions',jsonb_build_object('cost_code_id',p_cost_code_id)),
       jsonb_build_object('line_no',2,'account_id',bank.gl_account_id,'description',p_memo,'debit_cents',credit,'credit_cents',debit,'dimensions','{}'::jsonb)));
 end if;
 if category.account_type='cogs' then
   if exists(select 1 from public.job_cost_entries j where j.org_id=p_org_id and j.source_type='bank_transaction' and j.source_id=txn.id and (j.project_id is distinct from p_project_id or j.cost_code_id is distinct from p_cost_code_id or j.cost_cents<>debit-credit or j.status<>'posted')) then raise exception 'Existing job cost differs from this categorization'; end if;
   insert into public.job_cost_entries(org_id,project_id,cost_code_id,source_type,source_id,incurred_on,cost_cents,status,is_billable,metadata)
   values(p_org_id,p_project_id,p_cost_code_id,'bank_transaction',txn.id,txn.transaction_date,debit-credit,'posted',false,jsonb_build_object('journal_entry_id',category_entry_id,'funding','bank_feed','billing_review_required',true))
   on conflict(org_id,source_type,source_id) do nothing;
 end if;
 select l.id into cash_line_id from public.journal_lines l where l.org_id=p_org_id and l.entry_id=category_entry_id and l.account_id=bank.gl_account_id;
 perform public.confirm_books_bank_match_atomic(p_org_id,txn.id,cash_line_id,txn.amount_cents,'exact',1,p_actor_id);
 return category_entry_id;
end;
$$;
revoke all on function public.categorize_books_bank_transaction_atomic(uuid,uuid,uuid,uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.categorize_books_bank_transaction_atomic(uuid,uuid,uuid,uuid,uuid,text,uuid) to service_role;

create or replace function public.reverse_books_bank_job_cost()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.status='posted' and new.status='reversed' and old.source_type='bank_transaction' then
   update public.job_cost_entries set status='voided',updated_at=now() where org_id=old.org_id and source_type='bank_transaction' and source_id=old.source_id;
 end if;
 return new;
end;
$$;
revoke all on function public.reverse_books_bank_job_cost() from public,anon,authenticated;
create trigger books_bank_job_cost_reversal after update of status on public.journal_entries for each row execute function public.reverse_books_bank_job_cost();
