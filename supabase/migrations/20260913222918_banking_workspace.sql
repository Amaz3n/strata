-- Draft coding is distinct from accounting. Only server-authorized Books services
-- may access these tables; no browser role receives a policy or table grant.
create table public.bank_transaction_details (
  id uuid not null unique default gen_random_uuid(),
  transaction_id uuid primary key references public.bank_transactions(id) on delete cascade,
  org_id uuid not null references public.orgs(id) on delete cascade,
  coding jsonb not null default '{}'::jsonb,
  version integer not null default 0,
  entry_id uuid references public.journal_entries(id),
  updated_by uuid references public.app_users(id),
  updated_at timestamptz not null default now()
);
create index bank_transaction_details_org_idx on public.bank_transaction_details(org_id);
alter table public.bank_transaction_details enable row level security;
revoke all on public.bank_transaction_details from anon, authenticated;
grant all on public.bank_transaction_details to service_role;

create table public.bank_receipts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  file_id uuid not null references public.files(id),
  transaction_id uuid references public.bank_transactions(id),
  extracted jsonb,
  extraction_error text,
  created_by uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  unique(org_id,file_id)
);
create index bank_receipts_org_transaction_idx on public.bank_receipts(org_id,transaction_id);
alter table public.bank_receipts enable row level security;
revoke all on public.bank_receipts from anon, authenticated;
grant all on public.bank_receipts to service_role;

create function public.mutate_books_banking_atomic(p_org_id uuid,p_transaction_id uuid,p_actor_id uuid,p_action text,p_version integer,p_coding jsonb default null,p_matches jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  bank public.bank_accounts%rowtype; txn public.bank_transactions%rowtype; detail public.bank_transaction_details%rowtype;
  category public.gl_accounts%rowtype; original public.journal_entries%rowtype;
  item jsonb; lines jsonb := '[]'::jsonb; posted_entry_id uuid; cash_line_id uuid;
  project_id uuid; cost_code_id uuid; line_id uuid; total bigint:=0; amount bigint; debit bigint; credit bigint; policy integer; line_no integer:=0;
begin
  if p_action not in ('save','post','match','exclude','undo') then raise exception 'Unknown banking action'; end if;
  select b.* into bank from public.bank_accounts b join public.bank_transactions t on t.bank_account_id=b.id and t.org_id=b.org_id where t.id=p_transaction_id and t.org_id=p_org_id for update of b;
  if not found then raise exception 'Bank account not found'; end if;
  select * into txn from public.bank_transactions where org_id=p_org_id and id=p_transaction_id for update;
  insert into public.bank_transaction_details(transaction_id,org_id) values(txn.id,p_org_id) on conflict do nothing;
  select * into detail from public.bank_transaction_details where transaction_id=txn.id and org_id=p_org_id for update;
  if detail.version<>p_version then raise exception 'This transaction changed. Refresh it before trying again.'; end if;
  if p_action<>'save' then
    if txn.lifecycle_status<>'posted' then raise exception 'Wait for the bank to settle this transaction'; end if;
    if exists(select 1 from public.bank_reconciliations r where r.org_id=p_org_id and r.bank_account_id=bank.id and r.status='closed' and txn.transaction_date<=r.statement_end) then raise exception 'Reopen the bank reconciliation before changing this transaction'; end if;
    if exists(select 1 from public.accounting_periods p where p.org_id=p_org_id and txn.transaction_date between p.period_start and p.period_end and p.status='closed') then raise exception 'Reopen the accounting period before changing this transaction'; end if;
  end if;
  if p_action in ('save','post') and p_coding is not null then
    if jsonb_typeof(p_coding->'lines')<>'array' or jsonb_array_length(p_coding->'lines') not between 1 and 50 then raise exception 'Provide 1 to 50 coding lines'; end if;
    if nullif(p_coding->>'vendorId','') is not null and not exists(select 1 from public.companies c where c.org_id=p_org_id and c.id=(p_coding->>'vendorId')::uuid) then raise exception 'Vendor not found in organization'; end if;
    for item in select value from jsonb_array_elements(p_coding->'lines') loop
      if nullif(item->>'accountId','') is not null and not exists(select 1 from public.gl_accounts a where a.org_id=p_org_id and a.id=(item->>'accountId')::uuid and a.active) then raise exception 'Category not found'; end if;
      if nullif(item->>'projectId','') is not null and not exists(select 1 from public.projects p where p.org_id=p_org_id and p.id=(item->>'projectId')::uuid) then raise exception 'Project not found'; end if;
      if nullif(item->>'costCodeId','') is not null and not exists(select 1 from public.cost_codes c where c.org_id=p_org_id and c.id=(item->>'costCodeId')::uuid) then raise exception 'Cost code not found'; end if;
    end loop;
    if p_action='post' or not exists(select 1 from public.bank_transaction_matches m where m.org_id=p_org_id and m.bank_transaction_id=txn.id and m.status='confirmed') then
      detail.coding:=p_coding;
    else
      -- Posted entries retain their original coding; documentation can advance.
      detail.coding:=jsonb_set(detail.coding,'{receiptStatus}',coalesce(p_coding->'receiptStatus','"missing"'::jsonb));
    end if;
  end if;
  if p_action in ('post','exclude') and exists(select 1 from public.bank_transaction_matches m where m.org_id=p_org_id and m.bank_transaction_id=txn.id and m.status='confirmed') then raise exception 'Undo existing matches before changing this transaction'; end if;
  if p_action in ('post','match') and not exists(select 1 from public.books_settings bs where bs.org_id=p_org_id and lower(bs.functional_currency)=lower(txn.currency)) then raise exception 'This account needs currency conversion before posting'; end if;
  if p_action='post' then
    if txn.excluded or bank.gl_account_id is null then raise exception 'Restore and map this account before posting'; end if;
    select active_policy_version into policy from public.books_settings where org_id=p_org_id and workspace_enabled and arc_ledger_mode<>'disabled';
    if not found then raise exception 'Books posting is not enabled'; end if;
    for item in select value from jsonb_array_elements(detail.coding->'lines') loop
      amount:=(item->>'amountCents')::bigint;
      if amount is null or amount<=0 then raise exception 'Every split needs a positive amount'; end if;
      select * into category from public.gl_accounts where org_id=p_org_id and id=(item->>'accountId')::uuid and active;
      if not found or category.id=bank.gl_account_id then raise exception 'Choose a different active category'; end if;
      project_id:=nullif(item->>'projectId','')::uuid; cost_code_id:=nullif(item->>'costCodeId','')::uuid;
      if category.account_type='cogs' and project_id is null then raise exception 'Direct job costs require a project'; end if;
      if category.account_type='expense' and project_id is not null then raise exception 'Use direct cost categories for project spending'; end if;
      if cost_code_id is not null and project_id is null then raise exception 'A cost code requires a project'; end if;
      total:=total+amount; line_no:=line_no+1;
      debit:=case when txn.direction='outflow' then amount else 0 end; credit:=case when txn.direction='inflow' then amount else 0 end;
      lines:=lines||jsonb_build_array(jsonb_build_object('line_no',line_no,'account_id',category.id,'project_id',project_id,'company_id',nullif(detail.coding->>'vendorId','')::uuid,'description',detail.coding->>'memo','debit_cents',debit,'credit_cents',credit,'dimensions',jsonb_build_object('cost_code_id',cost_code_id)));
    end loop;
    if total<>txn.amount_cents then raise exception 'Splits must equal the transaction total'; end if;
    lines:=lines||jsonb_build_array(jsonb_build_object('line_no',line_no+1,'account_id',bank.gl_account_id,'description',txn.description,'debit_cents',case when txn.direction='inflow' then total else 0 end,'credit_cents',case when txn.direction='outflow' then total else 0 end,'dimensions','{}'::jsonb));
    posted_entry_id:=public.post_books_journal_entry(p_org_id,jsonb_build_object('entry_date',txn.transaction_date,'entry_kind','adjusting','memo',coalesce(nullif(detail.coding->>'memo',''),txn.description),'posting_key','bank_workspace:'||txn.id||':'||detail.version,'projection_version',1,'policy_version',policy,'source_type','bank_transaction','source_id',txn.id,'created_by',p_actor_id),lines);
    -- Each split owns its own actual, linked to the journal for reversal.
    for item in select value from jsonb_array_elements(detail.coding->'lines') loop
      if exists(select 1 from public.gl_accounts where id=(item->>'accountId')::uuid and org_id=p_org_id and account_type='cogs') then
        insert into public.job_cost_entries(org_id,project_id,cost_code_id,source_type,source_id,incurred_on,cost_cents,status,is_billable,metadata)
        values(p_org_id,(item->>'projectId')::uuid,nullif(item->>'costCodeId','')::uuid,'bank_transaction',gen_random_uuid(),txn.transaction_date,(item->>'amountCents')::bigint*case when txn.direction='outflow' then 1 else -1 end,'posted',false,jsonb_build_object('journal_entry_id',posted_entry_id,'bank_transaction_id',txn.id,'billing_review_required',true));
      end if;
    end loop;
    select l.id into cash_line_id from public.journal_lines l where l.org_id=p_org_id and l.entry_id=posted_entry_id and l.account_id=bank.gl_account_id;
    perform public.confirm_books_bank_match_atomic(p_org_id,txn.id,cash_line_id,txn.amount_cents,'exact',1,p_actor_id);
    detail.entry_id:=posted_entry_id;
    if coalesce((detail.coding->>'learn')::boolean,false) and jsonb_array_length(detail.coding->'lines')=1 and nullif(trim(txn.merchant_name),'') is not null then
      item:=detail.coding->'lines'->0;
      insert into public.bank_rules(org_id,match_kind,match_value,direction,bank_account_id,gl_account_id,project_id,cost_code_id,confidence,hit_count,active,created_by,updated_by)
      values(p_org_id,'merchant_exact',lower(regexp_replace(trim(txn.merchant_name),'\s+',' ','g')),txn.direction,bank.id,(item->>'accountId')::uuid,nullif(item->>'projectId','')::uuid,nullif(item->>'costCodeId','')::uuid,0.9,1,true,p_actor_id,p_actor_id)
      on conflict(org_id,match_kind,match_value,bank_account_id,direction) do update set gl_account_id=excluded.gl_account_id,project_id=excluded.project_id,cost_code_id=excluded.cost_code_id,confidence=0.9,active=true,updated_by=p_actor_id;
    end if;

  elsif p_action='match' then
    if jsonb_array_length(p_matches)=0 then raise exception 'Choose a match'; end if;
    for item in select value from jsonb_array_elements(p_matches) loop
      perform public.confirm_books_bank_match_atomic(p_org_id,txn.id,(item->>'journalLineId')::uuid,(item->>'amountCents')::bigint,'manual_split',null,p_actor_id);
    end loop;
  elsif p_action='exclude' then
    update public.bank_transactions set excluded=true,updated_at=now() where org_id=p_org_id and id=txn.id;
  elsif p_action='undo' then
    -- Only reverse an entry owned by this workspace; external matches are unlinked.
    if detail.entry_id is not null then
      select * into original from public.journal_entries where org_id=p_org_id and id=detail.entry_id and status='posted';
      if found then
        select jsonb_agg(jsonb_build_object('line_no',l.line_no,'account_id',l.account_id,'project_id',l.project_id,'company_id',l.company_id,'description',l.description,'debit_cents',l.credit_cents,'credit_cents',l.debit_cents,'dimensions',l.dimensions)) into lines from public.journal_lines l where l.org_id=p_org_id and l.entry_id=original.id;
        perform public.reverse_books_journal_entry(p_org_id,original.id,jsonb_build_object('entry_date',txn.transaction_date,'entry_kind','reversal','memo','Undo banking review','posting_key','bank_workspace_undo:'||original.id,'projection_version',1,'policy_version',original.policy_version,'reversal_of_entry_id',original.id,'created_by',p_actor_id),lines);
        update public.job_cost_entries set status='voided',updated_at=now() where org_id=p_org_id and source_type='bank_transaction' and metadata->>'journal_entry_id'=original.id::text;
      end if;
      detail.entry_id:=null;
    elsif exists(select 1 from public.journal_entries e where e.org_id=p_org_id and e.source_type='bank_transaction' and e.source_id=txn.id and e.status='posted' and e.entry_kind<>'reversal') then
      raise exception 'This entry was posted outside this workspace. Reverse it in the ledger before undoing its match.';
    end if;
    update public.bank_transaction_matches set status='reversed',reversed_at=now(),updated_at=now() where org_id=p_org_id and bank_transaction_id=txn.id and status='confirmed';
    update public.bank_transactions set excluded=false where org_id=p_org_id and id=txn.id;
  end if;
  update public.bank_transaction_details set coding=detail.coding,version=version+1,entry_id=detail.entry_id,updated_by=p_actor_id,updated_at=now() where transaction_id=txn.id and org_id=p_org_id;
  return jsonb_build_object('version',detail.version+1,'entryId',detail.entry_id);
end;
$$;
revoke all on function public.mutate_books_banking_atomic(uuid,uuid,uuid,text,integer,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.mutate_books_banking_atomic(uuid,uuid,uuid,text,integer,jsonb,jsonb) to service_role;

create view public.banking_workspace_rows with (security_invoker=true) as
select t.*, coalesce(d.coding,'{}'::jsonb) as coding,coalesce(d.version,0) as version,d.entry_id,
  coalesce(m.matched_cents,0) as matched_cents,
  coalesce(r.receipt_count,0) as receipt_count,
  case when t.excluded then 'excluded' when t.lifecycle_status='pending' then 'pending' when coalesce(m.matched_cents,0)>=t.amount_cents then 'posted' else 'review' end as review_status
from public.bank_transactions t
left join public.bank_transaction_details d on d.transaction_id=t.id and d.org_id=t.org_id
left join lateral (select sum(matched_amount_cents) as matched_cents from public.bank_transaction_matches where org_id=t.org_id and bank_transaction_id=t.id and status='confirmed' and match_type<>'excluded') m on true
left join lateral (select count(*) as receipt_count from public.bank_receipts where org_id=t.org_id and transaction_id=t.id) r on true
where t.lifecycle_status in ('posted','pending');
revoke all on public.banking_workspace_rows from anon,authenticated;
grant select on public.banking_workspace_rows to service_role;

-- Ledger-originated reversals must also retire every split actual.
create or replace function public.reverse_books_bank_job_cost()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.status='posted' and new.status='reversed' and old.source_type='bank_transaction' then
   update public.job_cost_entries set status='voided',updated_at=now()
   where org_id=old.org_id and source_type='bank_transaction'
     and (source_id=old.source_id or metadata->>'journal_entry_id'=old.id::text);
 end if;
 return new;
end;
$$;
revoke all on function public.reverse_books_bank_job_cost() from public,anon,authenticated;

-- Aggregate on the server; never download an entire bank history to count cards.
create view public.banking_workspace_counts with (security_invoker=true) as
select org_id,bank_account_id,review_status,count(*)::integer as transaction_count
from public.banking_workspace_rows group by org_id,bank_account_id,review_status;
revoke all on public.banking_workspace_counts from anon,authenticated;
grant select on public.banking_workspace_counts to service_role;
