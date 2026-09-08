-- Imported open items are owned by their approved opening lines. User metadata
-- is not an authority to suppress ordinary source projection.
alter table public.opening_balance_batches add column line_manifest_digest text;
alter table public.opening_balance_lines add column operational_entity_type text, add column operational_entity_id uuid, add column operational_payment_id uuid references public.payments(id) on delete restrict;
create unique index books_opening_entity_owner_idx on public.opening_balance_lines(org_id,operational_entity_type,operational_entity_id) where operational_entity_id is not null;
create index books_opening_payment_owner_idx on public.opening_balance_lines(operational_payment_id) where operational_payment_id is not null;
alter table public.books_fixed_assets add column opening_accumulated_depreciation_cents bigint not null default 0 check(opening_accumulated_depreciation_cents>=0), add column opening_as_of date;

create or replace function public.books_opening_manifest(p_org_id uuid,p_batch_id uuid)
returns text language sql stable security definer set search_path='' as $$
 select encode(extensions.digest(coalesce(jsonb_agg(jsonb_build_object('line_no',line_no,'account_id',account_id,'subledger_type',subledger_type,'source_entity_type',source_entity_type,'source_entity_id',source_entity_id,'project_id',project_id,'company_id',company_id,'description',description,'debit_cents',debit_cents,'credit_cents',credit_cents,'details',details) order by line_no),'[]'::jsonb)::text,'sha256'),'hex') from public.opening_balance_lines where org_id=p_org_id and batch_id=p_batch_id;
$$;
revoke all on function public.books_opening_manifest(uuid,uuid) from public,anon,authenticated;

create or replace function public.approve_books_opening_batch(p_org_id uuid,p_batch_id uuid,p_role text,p_actor_id uuid)
returns integer language plpgsql security definer set search_path='' as $$
declare batch public.opening_balance_batches%rowtype; manifest text; approvals integer;
begin
 select * into batch from public.opening_balance_batches where org_id=p_org_id and id=p_batch_id for update;
 if not found or batch.status not in('validated','approved') or batch.digest is null or p_role not in('owner','accountant') then raise exception 'Opening batch is not ready for approval'; end if;
 if (select count(*) from public.opening_balance_lines where org_id=p_org_id and batch_id=p_batch_id)<2 or (select sum(debit_cents-credit_cents) from public.opening_balance_lines where org_id=p_org_id and batch_id=p_batch_id)<>0 then raise exception 'Opening lines must be complete and balanced'; end if;
 manifest:=public.books_opening_manifest(p_org_id,p_batch_id);
 if batch.line_manifest_digest is not null and batch.line_manifest_digest<>manifest then raise exception 'Opening lines changed after review'; end if;
 insert into public.opening_balance_approvals(org_id,batch_id,approval_role,approved_by,approved_digest) values(p_org_id,p_batch_id,p_role,p_actor_id,batch.digest) on conflict(batch_id,approval_role) do nothing;
 if not exists(select 1 from public.opening_balance_approvals where org_id=p_org_id and batch_id=p_batch_id and approval_role=p_role and approved_by=p_actor_id and approved_digest=batch.digest) then raise exception 'This role has already been approved by another reviewer'; end if;
 select count(*) into approvals from public.opening_balance_approvals where org_id=p_org_id and batch_id=p_batch_id and approved_digest=batch.digest;
 update public.opening_balance_batches set line_manifest_digest=manifest,status=case when approvals=2 then 'approved' else 'validated' end,approved_by=case when approvals=2 then p_actor_id else approved_by end,approved_at=case when approvals=2 then now() else approved_at end where org_id=p_org_id and id=p_batch_id;
 return approvals;
end;
$$;
revoke all on function public.approve_books_opening_batch(uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.approve_books_opening_batch(uuid,uuid,text,uuid) to service_role;

create or replace function public.post_books_opening_batch(p_org_id uuid,p_batch_id uuid,p_actor_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare batch public.opening_balance_batches%rowtype; item record; entity_id uuid; payment_id uuid; entity_kind text; customer uuid; amount bigint; document_number text; document_date date; due_date date; journal_id uuid; policy integer; lines jsonb; cash uuid; interest uuid; accumulated uuid; depreciation uuid; funding uuid; opening_asset_number text; existing_amount bigint;
begin
 select * into batch from public.opening_balance_batches where org_id=p_org_id and id=p_batch_id for update;
 if not found then raise exception 'Opening batch not found'; end if;
 if batch.status='posted' and batch.journal_entry_id is not null then return batch.journal_entry_id; end if;
 if batch.status<>'approved' or batch.digest is null or (select count(distinct approved_by) from public.opening_balance_approvals where org_id=p_org_id and batch_id=p_batch_id and approved_digest=batch.digest)<>2 then raise exception 'Opening batch requires owner and accountant approval'; end if;
 if batch.line_manifest_digest is null or batch.line_manifest_digest<>public.books_opening_manifest(p_org_id,p_batch_id) then raise exception 'Revalidate and reapprove this opening batch with the operational import contract'; end if;
 if (select count(*) from public.opening_balance_lines where org_id=p_org_id and batch_id=p_batch_id)<2 or (select sum(debit_cents-credit_cents) from public.opening_balance_lines where org_id=p_org_id and batch_id=p_batch_id)<>0 then raise exception 'Opening journal must balance'; end if;
 select active_policy_version into policy from public.books_settings where org_id=p_org_id and workspace_enabled and arc_ledger_mode<>'disabled';
 if not found then raise exception 'Books posting is not enabled'; end if;
 -- Cost records precede accumulated-depreciation lines regardless of CSV ordering.
 for item in select l.*,a.code,a.subtype from public.opening_balance_lines l join public.gl_accounts a on a.id=l.account_id and a.org_id=l.org_id where l.org_id=p_org_id and l.batch_id=p_batch_id order by case when a.subtype='fixed_assets' then 0 when a.subtype='accumulated_depreciation' then 2 else 1 end,l.line_no loop
   entity_id:=null; payment_id:=null; entity_kind:=null;
   if item.project_id is not null and not exists(select 1 from public.projects where org_id=p_org_id and id=item.project_id) then raise exception 'Opening project is outside the organization'; end if;
   if item.company_id is not null and not exists(select 1 from public.companies where org_id=p_org_id and id=item.company_id) then raise exception 'Opening company is outside the organization'; end if;
   document_number:=coalesce(nullif(item.details->>'document_number',''),nullif(item.source_entity_id,''),'OPEN-'||left(item.id::text,8));
   document_date:=coalesce((item.details->>'document_date')::date,batch.cutover_date);
   due_date:=coalesce((item.details->>'due_date')::date,batch.cutover_date);
   if document_date>batch.cutover_date then raise exception 'Imported documents cannot originate after cutover'; end if;
   if item.details->>'existing_entity_id' is not null then entity_id:=(item.details->>'existing_entity_id')::uuid; end if;
   if item.subledger_type in('ar','deposit') then
     if (item.subledger_type='ar' and item.subtype not in('accounts_receivable','retainage_receivable')) or (item.subledger_type='deposit' and item.subtype<>'customer_deposits') then raise exception 'Receivable and deposit openings require their control accounts'; end if;
     amount:=case when item.subledger_type='ar' then item.debit_cents-item.credit_cents else item.credit_cents-item.debit_cents end;
     if amount<=0 then raise exception 'Import positive outstanding invoices or unapplied deposits; customer credits need a separate supported credit document'; end if;
     customer:=nullif(item.details->>'customer_id','')::uuid;
     if customer is null and item.project_id is not null then select client_id into customer from public.projects where org_id=p_org_id and id=item.project_id; end if;
     if customer is null or not exists(select 1 from public.contacts where org_id=p_org_id and id=customer) then raise exception 'A customer contact is required for collectable opening items'; end if;
     if entity_id is null then
       insert into public.invoices(org_id,project_id,invoice_number,title,status,issue_date,due_date,recipient_contact_id,subtotal_cents,total_cents,balance_due_cents,tax_cents,metadata)
       values(p_org_id,item.project_id,document_number,coalesce(item.description,'Imported outstanding balance'),'draft',document_date,due_date,customer,amount,amount,amount,0,jsonb_build_object('invoice_kind',case when item.subledger_type='deposit' then 'earnest_deposit' else 'standard' end,'opening_batch_id',batch.id,'customer_id',customer,'original_document',item.details)) returning id into entity_id;
       insert into public.invoice_lines(org_id,invoice_id,description,quantity,unit,unit_price_cents,metadata) values(p_org_id,entity_id,coalesce(item.description,'Imported outstanding balance'),1,'ea',amount,jsonb_build_object('opening_balance',true));
       update public.invoices set status='sent',subtotal_cents=amount,total_cents=amount,balance_due_cents=amount where org_id=p_org_id and id=entity_id;
     else
       select balance_due_cents into existing_amount from public.invoices where org_id=p_org_id and id=entity_id and recipient_contact_id=customer and project_id is not distinct from item.project_id and balance_due_cents=total_cents and status in('sent','overdue','partial');
       if not found or existing_amount<>amount then raise exception 'Existing invoice must match the exact imported outstanding balance and customer'; end if;
       if exists(select 1 from public.payments where org_id=p_org_id and invoice_id=entity_id and status in('succeeded','completed','paid')) then raise exception 'Previously paid invoice history must be imported as a residual open item'; end if;
     end if;
     entity_kind:=case when item.subledger_type='deposit' then 'deposit_invoice' else 'invoice' end;
     if exists(select 1 from public.accounting_facts where org_id=p_org_id and source_type='invoice' and source_id=entity_id) then raise exception 'An already projected invoice cannot also belong to an opening batch'; end if;
     if item.subtype='retainage_receivable' then
       if not exists(select 1 from public.contracts where org_id=p_org_id and id=nullif(item.details->>'contract_id','')::uuid and project_id=item.project_id) then raise exception 'Retained receivables require their project contract'; end if;
       if item.details->>'existing_entity_id' is not null then raise exception 'Import held retainage as a separate residual document'; end if;
       update public.invoice_lines set unit_price_cents=0 where org_id=p_org_id and invoice_id=entity_id;
       update public.invoices set subtotal_cents=0,total_cents=0,balance_due_cents=0 where org_id=p_org_id and id=entity_id;
       insert into public.retainage(org_id,project_id,contract_id,invoice_id,amount_cents,status,held_at,metadata) values(p_org_id,item.project_id,(item.details->>'contract_id')::uuid,entity_id,amount,'held',document_date::timestamptz,jsonb_build_object('opening_batch_id',batch.id));
     end if;
     if item.subledger_type='deposit' then
       insert into public.payments(org_id,invoice_id,amount_cents,status,method,received_at,metadata) values(p_org_id,entity_id,amount,'succeeded','imported',document_date::timestamptz,jsonb_build_object('opening_batch_id',batch.id)) returning id into payment_id;
       update public.invoices set balance_due_cents=0,status='paid' where org_id=p_org_id and id=entity_id;
     end if;
   elsif item.subledger_type='ap' then
     if item.subtype not in('accounts_payable','retainage_payable') then raise exception 'AP open items require the accounts-payable control account'; end if;
     amount:=item.credit_cents-item.debit_cents;
     if amount<=0 or item.company_id is null or item.project_id is null then raise exception 'AP openings require a positive unpaid balance, vendor and project'; end if;
     if entity_id is null then
       insert into public.vendor_bills(org_id,project_id,company_id,bill_number,bill_date,due_date,total_cents,paid_cents,retainage_cents,status,metadata)
       values(p_org_id,item.project_id,item.company_id,document_number,document_date,due_date,amount,0,0,'approved',jsonb_build_object('opening_batch_id',batch.id,'original_document',item.details)) returning id into entity_id;
       insert into public.bill_lines(org_id,bill_id,description,quantity,unit_cost_cents) values(p_org_id,entity_id,coalesce(item.description,'Imported unpaid balance'),1,amount);
     else
       select total_cents into existing_amount from public.vendor_bills where org_id=p_org_id and id=entity_id and company_id=item.company_id and project_id=item.project_id and paid_cents=0 and coalesce(retainage_cents,0)=0 and status in('approved','payable');
       if not found or existing_amount<>amount then raise exception 'Existing payable must match the imported unpaid amount, vendor and project'; end if;
     end if;
     if item.subtype='retainage_payable' then
       if item.details->>'existing_entity_id' is not null then raise exception 'Import held payable retainage as a separate residual document'; end if;
       update public.vendor_bills set retainage_cents=amount where org_id=p_org_id and id=entity_id;
     end if;
     entity_kind:='vendor_bill';
     if exists(select 1 from public.accounting_facts where org_id=p_org_id and source_type='vendor_bill' and source_id=entity_id) then raise exception 'An already projected payable cannot also belong to an opening batch'; end if;
   elsif item.subledger_type in('bank','credit_card') then
     if entity_id is null then raise exception 'Create or select the native bank/card account before importing its opening balance'; end if;
     if not exists(select 1 from public.bank_accounts where org_id=p_org_id and id=entity_id and gl_account_id=item.account_id) then raise exception 'Opening bank/card account must map to this control account'; end if;
     entity_kind:='bank_account';
   elsif item.subledger_type='loan' then
     amount:=item.credit_cents-item.debit_cents;
     if amount<=0 or item.subtype not in('current_debt','long_term_debt') then raise exception 'Loan opening must credit a debt account'; end if;
     if entity_id is null then
       cash:=nullif(item.details->>'cash_account_id','')::uuid; interest:=nullif(item.details->>'interest_account_id','')::uuid;
       if not exists(select 1 from public.gl_accounts where org_id=p_org_id and id=cash and subtype='cash' and active) or not exists(select 1 from public.gl_accounts where org_id=p_org_id and id=interest and subtype='interest' and active) then raise exception 'Select the native repayment bank and interest accounts for the loan'; end if;
       insert into public.books_debt_instruments(org_id,name,liability_account_id,cash_account_id,interest_expense_account_id,opened_on,maturity_on,original_principal_cents,annual_interest_bps,payment_frequency,created_by)
       values(p_org_id,coalesce(item.description,document_number),item.account_id,cash,interest,document_date,(item.details->>'maturity_on')::date,amount,coalesce((item.details->>'annual_interest_bps')::integer,0),coalesce(item.details->>'payment_frequency','monthly'),p_actor_id) returning id into entity_id;
     else
       if not exists(select 1 from public.books_debt_instruments where org_id=p_org_id and id=entity_id and liability_account_id=item.account_id and original_principal_cents=amount) or exists(select 1 from public.books_debt_events where org_id=p_org_id and instrument_id=entity_id) then raise exception 'Opening loan must match a register with no posted history'; end if;
     end if;
     entity_kind:='debt_instrument';
   elsif item.subledger_type='fixed_asset' then
     opening_asset_number:=coalesce(nullif(item.details->>'asset_number',''),document_number);
     if item.subtype='fixed_assets' then
       amount:=item.debit_cents-item.credit_cents;
       if amount<=0 then raise exception 'Asset cost opening must be a debit'; end if;
       if entity_id is null then
         accumulated:=nullif(item.details->>'accumulated_depreciation_account_id','')::uuid; depreciation:=nullif(item.details->>'depreciation_expense_account_id','')::uuid; funding:=nullif(item.details->>'funding_account_id','')::uuid;
         if not exists(select 1 from public.gl_accounts where org_id=p_org_id and id=accumulated and subtype='accumulated_depreciation') or not exists(select 1 from public.gl_accounts where org_id=p_org_id and id=depreciation and subtype='depreciation') or not exists(select 1 from public.gl_accounts where org_id=p_org_id and id=funding and subtype in('cash','accounts_payable','current_debt','long_term_debt','owner_contributions','owner_equity')) then raise exception 'Asset register accounts must belong to this organization and match their roles'; end if;
         insert into public.books_fixed_assets(org_id,asset_number,name,project_id,placed_in_service_on,acquisition_cost_cents,salvage_value_cents,useful_life_months,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id,funding_account_id,opening_as_of,created_by)
         values(p_org_id,opening_asset_number,coalesce(item.description,opening_asset_number),item.project_id,coalesce((item.details->>'placed_in_service_on')::date,document_date),amount,coalesce((item.details->>'salvage_value_cents')::bigint,0),(item.details->>'useful_life_months')::integer,item.account_id,accumulated,depreciation,funding,batch.cutover_date,p_actor_id) returning id into entity_id;
       else
         if not exists(select 1 from public.books_fixed_assets where org_id=p_org_id and id=entity_id and acquisition_cost_cents=amount and asset_account_id=item.account_id) or exists(select 1 from public.books_fixed_asset_events where org_id=p_org_id and asset_id=entity_id) then raise exception 'Opening asset must match a register with no posted history'; end if;
         update public.books_fixed_assets set opening_as_of=batch.cutover_date where org_id=p_org_id and id=entity_id;
       end if;
       entity_kind:='fixed_asset';
     elsif item.subtype='accumulated_depreciation' then
       amount:=item.credit_cents-item.debit_cents;
       if amount<=0 then raise exception 'Accumulated depreciation opening must be a credit'; end if;
       if entity_id is null then select id into entity_id from public.books_fixed_assets a where a.org_id=p_org_id and a.asset_number=opening_asset_number; end if;
       if entity_id is null or not exists(select 1 from public.opening_balance_lines where org_id=p_org_id and batch_id=p_batch_id and operational_entity_type='fixed_asset' and operational_entity_id=entity_id) then raise exception 'Import this asset cost in the same batch before its accumulated depreciation'; end if;
       if not exists(select 1 from public.books_fixed_assets where org_id=p_org_id and id=entity_id and accumulated_depreciation_account_id=item.account_id and acquisition_cost_cents-salvage_value_cents>=amount) then raise exception 'Accumulated depreciation exceeds depreciable cost or uses the wrong account'; end if;
       update public.books_fixed_assets set opening_accumulated_depreciation_cents=amount where org_id=p_org_id and id=entity_id;
       entity_kind:='fixed_asset_depreciation';
     else raise exception 'Fixed-asset opening requires cost or accumulated-depreciation accounts'; end if;
   elsif item.subtype in('cash','credit_card','accounts_receivable','accounts_payable','customer_deposits','current_debt','long_term_debt','fixed_assets','accumulated_depreciation','retainage_receivable','retainage_payable') then
     raise exception 'Control accounts require an operational opening subledger type';
   end if;
   if entity_id is not null then
     update public.opening_balance_lines set operational_entity_type=entity_kind,operational_entity_id=entity_id,operational_payment_id=payment_id where org_id=p_org_id and id=item.id;
   end if;
 end loop;
 select jsonb_agg(jsonb_build_object('line_no',line_no,'account_id',account_id,'project_id',project_id,'company_id',company_id,'description',description,'debit_cents',debit_cents,'credit_cents',credit_cents,'dimensions',details||jsonb_build_object('opening_line_id',id)) order by line_no) into lines from public.opening_balance_lines where org_id=p_org_id and batch_id=p_batch_id;
 journal_id:=public.post_books_journal_entry(p_org_id,jsonb_build_object('entry_date',batch.cutover_date,'entry_kind','opening','memo','Opening balances at '||batch.cutover_date,'posting_key','opening:'||batch.id||':'||batch.digest,'projection_version',1,'policy_version',policy,'source_type','opening_balance_batch','source_id',batch.id,'created_by',p_actor_id),lines);
 update public.opening_balance_batches set status='posted',journal_entry_id=journal_id,posted_at=now(),updated_at=now() where org_id=p_org_id and id=p_batch_id;
 return journal_id;
end;
$$;
revoke all on function public.post_books_opening_batch(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.post_books_opening_batch(uuid,uuid,uuid) to service_role;

create or replace function public.guard_books_opening_lines()
returns trigger language plpgsql set search_path='' as $$
declare batch_id_value uuid; org_id_value uuid;
begin
 if tg_op='DELETE' then batch_id_value:=old.batch_id; org_id_value:=old.org_id; else batch_id_value:=new.batch_id; org_id_value:=new.org_id; end if;
 perform 1 from public.opening_balance_batches where org_id=org_id_value and id=batch_id_value for update;
 if tg_op='UPDATE' and (to_jsonb(new)-array['operational_entity_type','operational_entity_id','operational_payment_id'])=(to_jsonb(old)-array['operational_entity_type','operational_entity_id','operational_payment_id']) then
   if current_user not in('postgres','service_role') then raise exception 'Opening source ownership can only be assigned by the import transaction'; end if;
   if old.operational_entity_id is not null and (old.operational_entity_id,old.operational_entity_type,old.operational_payment_id) is distinct from (new.operational_entity_id,new.operational_entity_type,new.operational_payment_id) then raise exception 'Assigned opening source ownership is immutable'; end if;
   return new;
 end if;
 if tg_op='INSERT' and (new.operational_entity_id is not null or new.operational_payment_id is not null) and current_user not in('postgres','service_role') then raise exception 'Opening source ownership requires the import transaction'; end if;
 if exists(select 1 from public.opening_balance_approvals where org_id=org_id_value and batch_id=batch_id_value) then raise exception 'Approved opening lines are frozen; create a corrected batch'; end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end;
$$;
create trigger books_opening_lines_guard before insert or update or delete on public.opening_balance_lines for each row execute function public.guard_books_opening_lines();

create or replace function public.guard_books_opening_batch()
returns trigger language plpgsql set search_path='' as $$
begin
 if current_user not in('postgres','service_role') and (new.status,new.journal_entry_id,new.line_manifest_digest) is distinct from (old.status,old.journal_entry_id,old.line_manifest_digest) then raise exception 'Opening transitions require the authorized Books service'; end if;
 if exists(select 1 from public.opening_balance_approvals where org_id=old.org_id and batch_id=old.id) and (new.org_id,new.cutover_date,new.source_content_hash,new.digest,new.debit_total_cents,new.credit_total_cents) is distinct from (old.org_id,old.cutover_date,old.source_content_hash,old.digest,old.debit_total_cents,old.credit_total_cents) then raise exception 'Approved opening batch identity is immutable'; end if;
 return new;
end;
$$;
create trigger books_opening_batch_guard before update on public.opening_balance_batches for each row execute function public.guard_books_opening_batch();

-- Reverse unused imported documents and their journal in one transaction. Once
-- operational activity exists, corrections belong in the affected subledger.
create or replace function public.reverse_books_opening_batch(p_org_id uuid,p_batch_id uuid,p_date date,p_reason text,p_actor_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare batch public.opening_balance_batches%rowtype; original public.journal_entries%rowtype; item record; lines jsonb; reversal uuid;
begin
 if length(btrim(p_reason))<10 then raise exception 'Explain the opening reversal'; end if;
 select * into batch from public.opening_balance_batches where org_id=p_org_id and id=p_batch_id for update;
 if not found or batch.status<>'posted' or batch.journal_entry_id is null then raise exception 'Only a posted opening batch can be reversed'; end if;
 if p_date<batch.cutover_date then raise exception 'Reversal cannot precede cutover'; end if;
 perform 1 from public.payments where org_id=p_org_id and id in(select operational_payment_id from public.opening_balance_lines where org_id=p_org_id and batch_id=p_batch_id and operational_payment_id is not null) order by id for update;
 for item in select * from public.opening_balance_lines where org_id=p_org_id and batch_id=p_batch_id and operational_entity_id is not null order by operational_entity_id loop
   if item.details->>'existing_entity_id' is not null and item.operational_entity_type<>'bank_account' then raise exception 'Linked pre-existing records require a subledger correction instead of batch reversal'; end if;
   if item.operational_entity_type in('invoice','deposit_invoice') then
     perform 1 from public.invoices where org_id=p_org_id and id=item.operational_entity_id for update;
     if exists(select 1 from public.payments where org_id=p_org_id and (invoice_id=item.operational_entity_id or metadata->>'deposit_payment_id'=item.operational_payment_id::text) and id is distinct from item.operational_payment_id) or exists(select 1 from public.retainage where org_id=p_org_id and invoice_id=item.operational_entity_id and status<>'held') then raise exception 'Opening receivable or deposit has downstream activity; correct it through its subledger'; end if;
   elsif item.operational_entity_type='vendor_bill' then
     perform 1 from public.vendor_bills where org_id=p_org_id and id=item.operational_entity_id for update;
     if exists(select 1 from public.payments where org_id=p_org_id and bill_id=item.operational_entity_id) or exists(select 1 from public.vendor_bills where org_id=p_org_id and id=item.operational_entity_id and (paid_cents<>0 or coalesce(retainage_released_cents,0)<>0)) then raise exception 'Opening payable has downstream activity'; end if;
   elsif item.operational_entity_type='debt_instrument' then
     perform 1 from public.books_debt_instruments where org_id=p_org_id and id=item.operational_entity_id for update;
     if exists(select 1 from public.books_debt_events where org_id=p_org_id and instrument_id=item.operational_entity_id) then raise exception 'Opening loan has downstream activity'; end if;
   elsif item.operational_entity_type='fixed_asset' then
     perform 1 from public.books_fixed_assets where org_id=p_org_id and id=item.operational_entity_id for update;
     if exists(select 1 from public.books_fixed_asset_events where org_id=p_org_id and asset_id=item.operational_entity_id) then raise exception 'Opening asset has downstream activity'; end if;
   end if;
 end loop;
 select * into original from public.journal_entries where org_id=p_org_id and id=batch.journal_entry_id for update;
 select jsonb_agg(jsonb_build_object('line_no',line_no,'account_id',account_id,'project_id',project_id,'company_id',company_id,'description',description,'debit_cents',credit_cents,'credit_cents',debit_cents,'dimensions',dimensions) order by line_no) into lines from public.journal_lines where org_id=p_org_id and entry_id=original.id;
 -- Source guards observe this status only inside the atomic reversal transaction.
 update public.opening_balance_batches set status='reversed',reversed_at=now() where org_id=p_org_id and id=batch.id;
 reversal:=(public.reverse_books_journal_entry(p_org_id,original.id,jsonb_build_object('entry_date',p_date,'entry_kind','reversal','memo',p_reason,'posting_key','reverse_opening:'||batch.id,'projection_version',original.projection_version,'policy_version',original.policy_version,'reversal_of_entry_id',original.id,'created_by',p_actor_id),lines)->>'id')::uuid;
 for item in select * from public.opening_balance_lines where org_id=p_org_id and batch_id=p_batch_id and operational_entity_id is not null loop
   if item.operational_entity_type in('invoice','deposit_invoice') then
     delete from public.retainage where org_id=p_org_id and invoice_id=item.operational_entity_id;
     if item.operational_payment_id is not null then update public.payments set status='canceled' where org_id=p_org_id and id=item.operational_payment_id; end if;
     update public.invoices set status='void',balance_due_cents=0 where org_id=p_org_id and id=item.operational_entity_id;
   elsif item.operational_entity_type='vendor_bill' then update public.vendor_bills set status='void' where org_id=p_org_id and id=item.operational_entity_id;
   elsif item.operational_entity_type='debt_instrument' then delete from public.books_debt_instruments where org_id=p_org_id and id=item.operational_entity_id;
   elsif item.operational_entity_type='fixed_asset' then delete from public.books_fixed_assets where org_id=p_org_id and id=item.operational_entity_id;
   end if;
 end loop;
 return reversal;
end;
$$;
revoke all on function public.reverse_books_opening_batch(uuid,uuid,date,text,uuid) from public,anon,authenticated;
grant execute on function public.reverse_books_opening_batch(uuid,uuid,date,text,uuid) to service_role;

create or replace function public.guard_books_opening_source()
returns trigger language plpgsql set search_path='' as $$
declare owned boolean; frozen_keys text[];
begin
 select exists(select 1 from public.opening_balance_lines l join public.opening_balance_batches b on b.id=l.batch_id and b.org_id=l.org_id where l.org_id=old.org_id and b.status='posted' and l.operational_entity_id=old.id and l.operational_entity_type=any(case tg_table_name when 'invoices' then array['invoice','deposit_invoice'] when 'vendor_bills' then array['vendor_bill'] when 'books_debt_instruments' then array['debt_instrument'] else array['fixed_asset','fixed_asset_depreciation'] end)) into owned;
 if not owned then if tg_op='DELETE' then return old; else return new; end if; end if;
 if tg_op='DELETE' then raise exception 'Reverse the unused opening batch or post a subledger correction'; end if;
 frozen_keys:=case tg_table_name when 'invoices' then array['org_id','project_id','recipient_contact_id','issue_date','total_cents','subtotal_cents','tax_cents'] when 'vendor_bills' then array['org_id','project_id','company_id','bill_date','total_cents','retainage_cents'] when 'books_debt_instruments' then array['org_id','original_principal_cents','opened_on','liability_account_id'] else array['org_id','acquisition_cost_cents','opening_accumulated_depreciation_cents','opening_as_of','asset_account_id','accumulated_depreciation_account_id','project_id'] end;
 if exists(select 1 from unnest(frozen_keys) k where to_jsonb(old)->k is distinct from to_jsonb(new)->k) or (tg_table_name in('invoices','vendor_bills') and to_jsonb(new)->>'status' in('void','voided','cancelled','draft','rejected')) then raise exception 'Imported opening economics are frozen; use the payment, credit, release or batch reversal workflow'; end if;
 return new;
end;
$$;
create trigger books_opening_invoice_guard before update or delete on public.invoices for each row execute function public.guard_books_opening_source();
create trigger books_opening_bill_guard before update or delete on public.vendor_bills for each row execute function public.guard_books_opening_source();
create trigger books_opening_debt_guard before update or delete on public.books_debt_instruments for each row execute function public.guard_books_opening_source();
create trigger books_opening_asset_guard before update or delete on public.books_fixed_assets for each row execute function public.guard_books_opening_source();

-- Register capacity is checked while holding the parent row, including imported
-- depreciation. Application-side estimates cannot authorize an over-depreciation.
create or replace function public.validate_books_asset_capacity()
returns trigger language plpgsql security definer set search_path='' as $$
declare asset public.books_fixed_assets%rowtype; taken bigint;
begin
 select * into asset from public.books_fixed_assets where org_id=new.org_id and id=new.asset_id for update;
 if not found or asset.status='disposed' then raise exception 'Fixed asset is unavailable'; end if;
 if asset.opening_as_of is not null and new.event_date<=asset.opening_as_of then raise exception 'Asset events must follow opening cutover'; end if;
 if asset.opening_as_of is not null and new.event_type='acquisition' then raise exception 'Imported acquisition is already represented by the opening journal'; end if;
 select coalesce(sum(amount_cents),0)+asset.opening_accumulated_depreciation_cents into taken from public.books_fixed_asset_events where org_id=new.org_id and asset_id=new.asset_id and event_type in('depreciation','impairment');
 if new.event_type in('depreciation','impairment') and taken+new.amount_cents>asset.acquisition_cost_cents-asset.salvage_value_cents then raise exception 'Depreciation exceeds remaining depreciable cost'; end if;
 return new;
end;
$$;
create trigger books_asset_capacity_guard before insert on public.books_fixed_asset_events for each row execute function public.validate_books_asset_capacity();

create or replace function public.guard_books_opening_approval_identity()
returns trigger language plpgsql set search_path='' as $$
begin
 if current_user not in('postgres','service_role') then raise exception 'Opening approvals require the authorized review service'; end if;
 if tg_op<>'INSERT' then raise exception 'Opening approvals are immutable'; end if;
 return new;
end;
$$;
create trigger books_opening_approval_identity_guard before insert or update or delete on public.opening_balance_approvals for each row execute function public.guard_books_opening_approval_identity();
