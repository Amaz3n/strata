-- A card-processor or ACH payout lands net of its fees, so one bank deposit can
-- settle several receipts less a fee. The batch records the fee and posts it to
-- bank fees: Dr bank (net) + Dr 6050 (fee) / Cr 1010 (receipts).
alter table public.books_deposit_batches add column fee_cents bigint not null default 0
  constraint books_deposit_batches_fee_nonnegative check (fee_cents >= 0);

drop function public.create_books_deposit_batch_atomic(uuid,uuid,uuid[],text,uuid);

create or replace function public.create_books_deposit_batch_atomic(
  p_org_id uuid,p_transaction_id uuid,p_payment_ids uuid[],p_reference text,p_actor_id uuid,p_fee_cents bigint
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  txn public.bank_transactions%rowtype;
  bank public.bank_accounts%rowtype;
  batch public.books_deposit_batches%rowtype;
  payment record;
  receipt_cents bigint;
  total_cents bigint:=0;
  clearing_id uuid;
  fee_id uuid;
  fee_cents bigint:=coalesce(p_fee_cents,0);
  deposit_entry_id uuid;
  bank_line_id uuid;
  policy integer;
  receipt_ids uuid[];
begin
  if cardinality(p_payment_ids)=0 or cardinality(p_payment_ids)<>(select count(distinct id) from unnest(p_payment_ids) id) then
    raise exception 'Select distinct customer receipts';
  end if;
  if fee_cents<0 then raise exception 'Processor fees cannot be negative'; end if;
  select * into txn from public.bank_transactions where id=p_transaction_id and org_id=p_org_id;
  if not found then raise exception 'Bank transaction not found'; end if;
  select * into bank from public.bank_accounts where id=txn.bank_account_id and org_id=p_org_id for update;
  select * into txn from public.bank_transactions where id=p_transaction_id and org_id=p_org_id for update;
  if txn.direction<>'inflow' or txn.lifecycle_status<>'posted' or txn.excluded or bank.gl_account_id is null then raise exception 'Choose an included posted deposit into a mapped account'; end if;
  select * into batch from public.books_deposit_batches where org_id=p_org_id and bank_transaction_id=txn.id for update;
  if batch.id is not null then
    select array_agg(payment_id order by payment_id) into receipt_ids from public.books_deposit_batch_items where org_id=p_org_id and batch_id=batch.id;
    if receipt_ids is not null and receipt_ids<>(select array_agg(id order by id) from unnest(p_payment_ids) id) then raise exception 'Retry must use the original receipt membership'; end if;
    if batch.fee_cents<>fee_cents then raise exception 'Retry must use the original processor fee'; end if;
    if batch.status='posted' then return jsonb_build_object('id',batch.id,'duplicate',true); end if;
    if batch.status='void' then raise exception 'A void batch cannot be posted'; end if;
  end if;
  select id into clearing_id from public.gl_accounts where org_id=p_org_id and code='1010' and active;
  if clearing_id is null then raise exception 'Undeposited funds account is missing'; end if;
  if fee_cents>0 then
    select id into fee_id from public.gl_accounts where org_id=p_org_id and code='6050' and active;
    if fee_id is null then raise exception 'Bank fees account is missing'; end if;
  end if;
  -- Lock receipts in UUID order so two deposits cannot consume the same receipt.
  for payment in select * from public.payments where org_id=p_org_id and id=any(p_payment_ids) order by id for update loop
    if payment.invoice_id is null or payment.status not in ('succeeded','completed','paid') then raise exception 'Only settled customer receipts may be deposited'; end if;
    select coalesce(sum(l.debit_cents-l.credit_cents),0) into receipt_cents
      from public.journal_entries e join public.journal_lines l on l.entry_id=e.id and l.org_id=e.org_id
      where e.org_id=p_org_id and e.source_id=payment.id and e.source_type in ('invoice_payment','customer_deposit_receipt')
        and e.status='posted' and l.account_id=clearing_id;
    if receipt_cents<=0 then raise exception 'Receipt has no active undeposited-funds posting'; end if;
    total_cents:=total_cents+receipt_cents;
    if exists(select 1 from public.books_deposit_batch_items where org_id=p_org_id and payment_id=payment.id and batch_id is distinct from batch.id) then raise exception 'Receipt is already assigned to another deposit'; end if;
  end loop;
  if (select count(*) from public.payments where org_id=p_org_id and id=any(p_payment_ids))<>cardinality(p_payment_ids) then raise exception 'Receipt not found'; end if;
  -- A processor payout arrives net of its fees: receipts = deposit + fees.
  if fee_cents>=total_cents then raise exception 'Processor fees must be less than the receipts deposited'; end if;
  if total_cents-fee_cents<>txn.amount_cents then raise exception 'Receipt clearing balances less processor fees must equal the bank deposit'; end if;
  if batch.id is null then
    insert into public.books_deposit_batches(org_id,bank_transaction_id,bank_account_id,deposited_on,total_cents,fee_cents,reference,created_by)
      values(p_org_id,txn.id,bank.id,txn.transaction_date,total_cents,fee_cents,nullif(btrim(p_reference),''),p_actor_id) returning * into batch;
  elsif batch.total_cents<>total_cents then raise exception 'Receipt amounts changed after batch creation'; end if;
  if receipt_ids is null then
    insert into public.books_deposit_batch_items(org_id,batch_id,payment_id,amount_cents)
      select p_org_id,batch.id,p.id,sum(l.debit_cents-l.credit_cents) from public.payments p
      join public.journal_entries e on e.org_id=p.org_id and e.source_id=p.id and e.source_type in ('invoice_payment','customer_deposit_receipt') and e.status='posted'
      join public.journal_lines l on l.entry_id=e.id and l.org_id=e.org_id and l.account_id=clearing_id
      where p.org_id=p_org_id and p.id=any(p_payment_ids) group by p.id;
  end if;
  select active_policy_version into policy from public.books_settings where org_id=p_org_id;
  deposit_entry_id:=public.post_books_journal_entry(p_org_id,jsonb_build_object(
    'entry_date',batch.deposited_on,'entry_kind','operational','memo','Bank deposit'||coalesce(' · '||batch.reference,''),
    'posting_key','deposit_batch:'||batch.id,'projection_version',1,'policy_version',policy,
    'source_type','deposit_batch','source_id',batch.id,'created_by',p_actor_id),jsonb_build_array(
      jsonb_build_object('line_no',1,'account_id',bank.gl_account_id,'debit_cents',total_cents-fee_cents,'credit_cents',0,'description','Bank deposit','dimensions','{}'::jsonb),
      jsonb_build_object('line_no',2,'account_id',clearing_id,'debit_cents',0,'credit_cents',total_cents,'description',cardinality(p_payment_ids)||' customer receipts','dimensions','{}'::jsonb))
      ||case when fee_cents>0 then jsonb_build_array(jsonb_build_object('line_no',3,'account_id',fee_id,'debit_cents',fee_cents,'credit_cents',0,'description','Processor fees withheld from deposit','dimensions','{}'::jsonb)) else '[]'::jsonb end);
  select id into bank_line_id from public.journal_lines where org_id=p_org_id and journal_lines.entry_id=deposit_entry_id and account_id=bank.gl_account_id;
  perform public.confirm_books_bank_match_atomic(p_org_id,txn.id,bank_line_id,total_cents-fee_cents,'exact',1,p_actor_id);
  update public.books_deposit_batches set status='posted',journal_entry_id=deposit_entry_id where org_id=p_org_id and id=batch.id;
  return jsonb_build_object('id',batch.id,'duplicate',false);
end;
$$;
revoke all on function public.create_books_deposit_batch_atomic(uuid,uuid,uuid[],text,uuid,bigint) from public,anon,authenticated;
grant execute on function public.create_books_deposit_batch_atomic(uuid,uuid,uuid[],text,uuid,bigint) to service_role;
