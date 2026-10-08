-- B15.1: a production builder's land and homes come over at cutover. An owned
-- lot opens on 1120 at its basis and the opening becomes its acquisition; a spec
-- home's cost to date opens on 1160 (or 1170 once completed) with the job-cost
-- record that the job-cost control ties to. Plain lines on those accounts are
-- refused, and reversing the opening undoes each while nothing has moved since.

alter table public.opening_balance_lines drop constraint opening_balance_lines_subledger_type_check;
alter table public.opening_balance_lines add constraint opening_balance_lines_subledger_type_check
  check (subledger_type in ('ar','ap','bank','credit_card','loan','fixed_asset','deposit','equity','other','land','home_inventory'));
alter table public.job_cost_entries drop constraint job_cost_entries_source_type_check;
alter table public.job_cost_entries add constraint job_cost_entries_source_type_check check (source_type = any (array[
  'vendor_bill_line','project_expense','project_expense_line','time_entry','bank_transaction','inventory_event','payroll_import','payroll_correction','cost_allocation','opening_balance']));

-- An owned lot's basis is proved by its posted acquisition, or by the posted
-- opening that brought it over at cutover; either way a line names the lot.
create or replace function public.guard_books_land_ownership()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.status='controlled' and new.status in('owned','developed','assigned','started','closed') and new.books_acquisition_entry_id is null and exists(select 1 from public.books_settings where org_id=new.org_id and workspace_enabled and arc_ledger_mode<>'disabled') then raise exception 'Record the actual land acquisition in Books before advancing ownership'; end if;
 if new.books_acquisition_entry_id is not null and not exists(select 1 from public.journal_entries e join public.journal_lines l on l.entry_id=e.id and l.org_id=e.org_id where e.org_id=new.org_id and e.id=new.books_acquisition_entry_id and e.status='posted' and e.source_type in('land_acquisition','opening_balance_batch') and l.dimensions->>'lot_id'=new.id::text) then raise exception 'Land acquisition must reference its posted native journal'; end if;
 return new;
end;
$$;

CREATE OR REPLACE FUNCTION public.post_books_opening_batch(p_org_id uuid, p_batch_id uuid, p_actor_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $$
declare batch public.opening_balance_batches%rowtype; v_lot public.lots%rowtype; v_settings public.project_financial_settings%rowtype; completed date; cost_code uuid; item record; entity_id uuid; payment_id uuid; entity_kind text; customer uuid; amount bigint; document_number text; document_date date; due_date date; journal_id uuid; policy integer; lines jsonb; cash uuid; interest uuid; accumulated uuid; depreciation uuid; funding uuid; opening_asset_number text; existing_amount bigint;
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
   -- No due date stays no due date; aging shows it as such rather than as due at cutover.
   due_date:=(item.details->>'due_date')::date;
   if document_date>batch.cutover_date then raise exception 'Imported documents cannot originate after cutover'; end if;
   if item.details->>'existing_entity_id' is not null then entity_id:=(item.details->>'existing_entity_id')::uuid; end if;
   if item.subledger_type in('ar','deposit') then
     if (item.subledger_type='ar' and item.subtype not in('accounts_receivable','retainage_receivable')) or (item.subledger_type='deposit' and item.subtype<>'customer_deposits') then raise exception 'Receivable and deposit openings require their control accounts'; end if;
     amount:=case when item.subledger_type='ar' then item.debit_cents-item.credit_cents else item.credit_cents-item.debit_cents end;
     if amount<=0 then raise exception 'Import positive outstanding invoices or unapplied deposits; customer credits need a separate supported credit document'; end if;
     customer:=nullif(item.details->>'customer_id','')::uuid;
     if customer is null or not exists(select 1 from public.contacts where org_id=p_org_id and id=customer) then raise exception 'Opening line %: name the customer who owes this item', item.line_no; end if;
     if entity_id is null then
       if nullif(item.details->>'document_number','') is null and nullif(item.source_entity_id,'') is null then raise exception 'Opening line %: give the original invoice number', item.line_no; end if;
       if item.details->>'document_date' is null then raise exception 'Opening line %: give the original invoice date', item.line_no; end if;
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
       if nullif(item.details->>'document_number','') is null and nullif(item.source_entity_id,'') is null then raise exception 'Opening line %: give the vendor''s bill number', item.line_no; end if;
       if item.details->>'document_date' is null then raise exception 'Opening line %: give the original bill date', item.line_no; end if;
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
     -- A check or deposit uncleared at cutover rides on the account's opening as
     -- its own line; the statement-balance line remains the account's one owner.
     if item.details->>'bank_opening_role'='outstanding_item' then
       if nullif(btrim(item.details->>'reference'),'') is null then raise exception 'An outstanding bank item needs its check or deposit reference'; end if;
       entity_id:=null; entity_kind:=null;
     elsif item.details ? 'bank_opening_role' then raise exception 'Unknown bank opening role';
     end if;
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
   elsif item.subledger_type='land' then
     -- An owned lot comes over at its basis, and the opening is its acquisition.
     if item.code<>'1120' then raise exception 'Opening line %: owned land opens on 1120 Owned land', item.line_no; end if;
     amount:=item.debit_cents-item.credit_cents;
     if amount<=0 then raise exception 'Opening line %: owned land opens as a debit at its basis', item.line_no; end if;
     select * into v_lot from public.lots where org_id=p_org_id and id=nullif(item.details->>'lot_id','')::uuid for update;
     if not found then raise exception 'Opening line %: name the lot this land is', item.line_no; end if;
     if v_lot.status<>'controlled' or v_lot.books_acquisition_entry_id is not null then raise exception 'Opening line %: lot % already has recorded land basis or has moved past ownership', item.line_no, coalesce(v_lot.lot_number, v_lot.id::text); end if;
     if (select count(*) from public.opening_balance_lines o where o.org_id=p_org_id and o.batch_id=p_batch_id and o.details->>'lot_id'=v_lot.id::text)>1 then raise exception 'Opening line %: a lot opens on one line', item.line_no; end if;
     entity_id:=v_lot.id; entity_kind:='lot';
   elsif item.subledger_type='home_inventory' then
     -- A spec home's cost to date comes over with its job-cost record, so the
     -- job-cost ledger and the books agree from the first day.
     if item.code not in('1160','1170') then raise exception 'Opening line %: home inventory opens on 1160 or 1170', item.line_no; end if;
     amount:=item.debit_cents-item.credit_cents;
     if amount<=0 or item.project_id is null then raise exception 'Opening line %: home inventory opens as a debit on its home''s job', item.line_no; end if;
     if (select count(*) from public.opening_balance_lines o where o.org_id=p_org_id and o.batch_id=p_batch_id and o.subledger_type='home_inventory' and o.project_id=item.project_id)>1 then raise exception 'Opening line %: a home opens on one line', item.line_no; end if;
     select * into v_settings from public.project_financial_settings where org_id=p_org_id and project_id=item.project_id for update;
     if not found or not v_settings.books_inventory_enabled or v_settings.books_inventory_effective_on>batch.cutover_date or v_settings.books_inventory_sold_on is not null or v_settings.books_inventory_completed_on is not null then
       raise exception 'Opening line %: adopt the home''s inventory policy before cutover; a sold or already completed home has no opening inventory', item.line_no; end if;
     cost_code:=nullif(item.details->>'cost_code_id','')::uuid;
     if cost_code is not null and not exists(select 1 from public.cost_codes where org_id=p_org_id and id=cost_code) then raise exception 'Opening line %: cost code is outside the organization', item.line_no; end if;
     if item.code='1170' then
       completed:=(item.details->>'completed_on')::date;
       if completed is null or completed>batch.cutover_date then raise exception 'Opening line %: a completed home needs its completion date, on or before cutover', item.line_no; end if;
       if completed<v_settings.books_inventory_effective_on then raise exception 'Opening line %: the home''s inventory policy must take effect on or before its completion date', item.line_no; end if;
       update public.project_financial_settings set books_inventory_completed_on=completed where org_id=p_org_id and project_id=item.project_id;
     end if;
     insert into public.job_cost_entries(org_id,project_id,cost_code_id,source_type,source_id,incurred_on,cost_cents,status,is_billable,metadata)
     values(p_org_id,item.project_id,cost_code,'opening_balance',item.id::text,batch.cutover_date,amount,'posted',false,jsonb_build_object('opening_batch_id',batch.id,'opening_line_id',item.id,'account_code',item.code))
     returning id into entity_id;
     entity_kind:=case when item.code='1170' then 'completed_home' else 'home_in_progress' end;
   elsif item.code='1120' or (item.code in('1160','1170') and item.project_id is not null) then
     raise exception 'Opening line %: land and home inventory need their lot or home (land / home_inventory)', item.line_no;
   elsif item.subtype in('cash','credit_card','accounts_receivable','accounts_payable','customer_deposits','current_debt','long_term_debt','fixed_assets','accumulated_depreciation','retainage_receivable','retainage_payable') then
     raise exception 'Control accounts require an operational opening subledger type';
   end if;
   if entity_id is not null then
     update public.opening_balance_lines set operational_entity_type=entity_kind,operational_entity_id=entity_id,operational_payment_id=payment_id where org_id=p_org_id and id=item.id;
   end if;
 end loop;
 select jsonb_agg(jsonb_build_object('line_no',line_no,'account_id',account_id,'project_id',project_id,'company_id',company_id,'description',description,'debit_cents',debit_cents,'credit_cents',credit_cents,'dimensions',details||coalesce((select jsonb_build_object('community_id',lo.community_id,'division_id',lo.division_id) from public.lots lo where lo.org_id=p_org_id and lo.id::text=details->>'lot_id' and subledger_type='land'),'{}'::jsonb)||jsonb_build_object('opening_line_id',id)) order by line_no) into lines from public.opening_balance_lines where org_id=p_org_id and batch_id=p_batch_id;
 journal_id:=public.post_books_journal_entry(p_org_id,jsonb_build_object('entry_date',batch.cutover_date,'entry_kind','opening','memo','Opening balances at '||batch.cutover_date,'posting_key','opening:'||batch.id||':'||batch.digest,'projection_version',1,'policy_version',policy,'source_type','opening_balance_batch','source_id',batch.id,'created_by',p_actor_id,'legal_entity_id',batch.legal_entity_id),lines);
 -- One company's opening position at a time: lines that resolve to another
 -- company (its job, its account) would invent what the companies owe each other.
 if exists(select 1 from public.journal_lines where org_id=p_org_id and entry_id=journal_id and dimensions->>'intercompany'='true') then
   raise exception 'These opening lines belong to more than one company; post each company''s opening position as its own batch';
 end if;
 update public.lots lo set status='owned',acquired_date=coalesce((o.details->>'document_date')::date,batch.cutover_date),cost_basis_cents=o.debit_cents,books_acquisition_entry_id=journal_id,updated_at=now()
   from public.opening_balance_lines o where o.org_id=p_org_id and o.batch_id=p_batch_id and o.operational_entity_type='lot' and lo.org_id=p_org_id and lo.id=o.operational_entity_id;
 update public.job_cost_entries j set metadata=j.metadata||jsonb_build_object('journal_entry_id',journal_id)
   from public.opening_balance_lines o where o.org_id=p_org_id and o.batch_id=p_batch_id and o.operational_entity_type in('home_in_progress','completed_home') and j.org_id=p_org_id and j.id=o.operational_entity_id;
 update public.opening_balance_batches set status='posted',journal_entry_id=journal_id,posted_at=now(),updated_at=now() where org_id=p_org_id and id=p_batch_id;
 return journal_id;
end;
$$;

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
   elsif item.operational_entity_type='lot' then
     perform 1 from public.lots where org_id=p_org_id and id=item.operational_entity_id for update;
     if exists(select 1 from public.lots where org_id=p_org_id and id=item.operational_entity_id and status<>'owned')
       or exists(select 1 from public.journal_entries where org_id=p_org_id and source_id=item.operational_entity_id and source_type='inventory_start' and status='posted')
       or exists(select 1 from public.books_intercompany_sales where org_id=p_org_id and lot_id=item.operational_entity_id) then raise exception 'Opening land has downstream activity'; end if;
   elsif item.operational_entity_type in('home_in_progress','completed_home') then
     perform 1 from public.project_financial_settings where org_id=p_org_id and project_id=item.project_id for update;
     if exists(select 1 from public.project_financial_settings where org_id=p_org_id and project_id=item.project_id and (books_inventory_sold_on is not null or (item.operational_entity_type='home_in_progress' and books_inventory_completed_on is not null))) then raise exception 'Opening home has since completed or sold'; end if;
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
   elsif item.operational_entity_type='lot' then
     update public.lots set status='controlled',acquired_date=null,cost_basis_cents=null,books_acquisition_entry_id=null,updated_at=now() where org_id=p_org_id and id=item.operational_entity_id;
   elsif item.operational_entity_type in('home_in_progress','completed_home') then
     update public.job_cost_entries set status='voided' where org_id=p_org_id and id=item.operational_entity_id;
     if item.operational_entity_type='completed_home' then update public.project_financial_settings set books_inventory_completed_on=null where org_id=p_org_id and project_id=item.project_id; end if;
   elsif item.operational_entity_type='fixed_asset' then delete from public.books_fixed_assets where org_id=p_org_id and id=item.operational_entity_id;
   end if;
 end loop;
 return reversal;
end;
$$;
