begin;
select plan(45);
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at,raw_app_meta_data,raw_user_meta_data)
values('17000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','books-bank-cycle@example.test','',now(),now(),'{}','{}');
insert into public.app_users(id,email,full_name)
values('17000000-0000-0000-0000-000000000001','books-bank-cycle@example.test','Bank Cycle Test');
insert into public.orgs(id,name,slug,created_by)
values('27000000-0000-0000-0000-000000000001','Bank Cycle Test','books-bank-cycle-test','17000000-0000-0000-0000-000000000001');

create function pg_temp.bank_cycle(case_name text,factor integer,outstanding bigint) returns setof text language plpgsql as $$
declare
  org uuid := '27000000-0000-0000-0000-000000000001';
  actor uuid := '17000000-0000-0000-0000-000000000001';
  cash uuid := gen_random_uuid(); equity uuid := gen_random_uuid();
  connection uuid := gen_random_uuid(); bank uuid := gen_random_uuid();
  sept uuid := gen_random_uuid(); oct uuid := gen_random_uuid();
  entry uuid; line uuid; deposit_line uuid; outstanding_line uuid;
  txn uuid; amount bigint; money bigint; i integer;
  first_evidence jsonb; second_evidence jsonb;
begin
  insert into public.gl_accounts(id,org_id,code,name,account_type,subtype,normal_balance) values
  (cash,org,case_name||'-BANK','Bank',case when factor=1 then 'asset' else 'liability' end,case when factor=1 then 'cash' else 'credit_card' end,case when factor=1 then 'debit' else 'credit' end),
  (equity,org,case_name||'-EQUITY','Equity','equity','owner_equity','credit');
  insert into public.bank_feed_connections(id,org_id,provider,external_item_id,secret_ref)
  values(connection,org,'manual',case_name,'local-test-only');
  insert into public.bank_accounts(id,org_id,connection_id,provider,external_account_id,name,account_type,gl_account_id)
  values(bank,org,connection,'manual',case_name,case_name,case when factor=1 then 'depository' else 'credit' end,cash);
  for i in 1..3 loop
    amount := case i when 1 then 10000 when 2 then 2000 else outstanding end;
    money := amount*factor;
    entry := public.post_books_journal_entry(org,jsonb_build_object('entry_date','2026-09-15','entry_kind',case when i=1 then 'opening' else 'operational' end,'memo',case_name,'posting_key',case_name||'-'||i,'policy_version',1,'source_type','test'),jsonb_build_array(
      jsonb_build_object('line_no',1,'account_id',cash,'debit_cents',greatest(money,0),'credit_cents',greatest(-money,0)),
      jsonb_build_object('line_no',2,'account_id',equity,'debit_cents',greatest(-money,0),'credit_cents',greatest(money,0))));
    select id into line from public.journal_lines where entry_id=entry and account_id=cash;
    if i=2 then deposit_line:=line; elsif i=3 then outstanding_line:=line; end if;
  end loop;
  txn:=gen_random_uuid();
  insert into public.bank_transactions(id,org_id,bank_account_id,provider,external_transaction_id,lifecycle_status,transaction_date,amount_cents,direction,description)
  values(txn,org,bank,'manual',case_name||'-SEPT','posted','2026-09-20',2000,case when factor=1 then 'inflow' else 'outflow' end,'Original statement description');
  perform public.confirm_books_bank_match_atomic(org,txn,deposit_line,2000,'exact',1,actor);
  insert into public.bank_reconciliations(id,org_id,bank_account_id,statement_start,statement_end,beginning_balance_cents,ending_balance_cents)
  values(sept,org,bank,'2026-09-01','2026-09-30',10000,12000);
  perform public.close_books_bank_reconciliation_atomic(org,sept,actor);
  select evidence into first_evidence from public.bank_reconciliations where id=sept;
  return next is((first_evidence->>'outstanding_balance_cents')::bigint,outstanding,case_name||': September retains outstanding amount');
  return next is(first_evidence->'statement_transactions'->0->>'description','Original statement description',case_name||': close freezes statement description');
  return next throws_matching(format('update public.bank_reconciliations set ending_balance_cents=13000 where id=%L',sept),'Reopen',case_name||': closed totals cannot be edited');
  return next throws_matching(format('update public.bank_transactions set transaction_date=''2026-10-01'' where id=%L',txn),'Reopen',case_name||': closed transactions cannot move to another cycle');
  return next throws_matching(format('insert into public.bank_reconciliations(org_id,bank_account_id,statement_start,statement_end,beginning_balance_cents,ending_balance_cents) values(%L,%L,''2026-09-30'',''2026-10-31'',12000,12000)',org,bank),'overlap',case_name||': overlapping cycles are rejected');
  return next throws_matching(format('insert into public.bank_reconciliations(org_id,bank_account_id,statement_start,statement_end,beginning_balance_cents,ending_balance_cents) values(%L,%L,''2026-10-02'',''2026-10-31'',12000,12000)',org,bank),'continue the previous',case_name||': a missing day is rejected');
  return next throws_matching(format('insert into public.bank_reconciliations(org_id,bank_account_id,statement_start,statement_end,beginning_balance_cents,ending_balance_cents) values(%L,%L,''2026-10-01'',''2026-10-31'',11000,12000)',org,bank),'continue the previous',case_name||': opening must match prior close');
  txn:=gen_random_uuid();
  insert into public.bank_transactions(id,org_id,bank_account_id,provider,external_transaction_id,lifecycle_status,transaction_date,amount_cents,direction,description)
  values(txn,org,bank,'manual',case_name||'-OCT','posted','2026-10-03',1000,case when outstanding*factor>0 then 'inflow' else 'outflow' end,'Prior-month item clears');
  perform public.confirm_books_bank_match_atomic(org,txn,outstanding_line,1000,'exact',1,actor);
  insert into public.bank_reconciliations(id,org_id,bank_account_id,statement_start,statement_end,beginning_balance_cents,ending_balance_cents)
  values(oct,org,bank,'2026-10-01','2026-10-31',12000,12000+outstanding);
  perform public.close_books_bank_reconciliation_atomic(org,oct,actor);
  select evidence into second_evidence from public.bank_reconciliations where id=oct;
  return next is((second_evidence->>'outstanding_balance_cents')::bigint,0::bigint,case_name||': October clears the prior item');
  return next is((second_evidence->>'book_balance_cents')::bigint,12000+outstanding,case_name||': October ties to real GL');
  perform public.close_books_bank_reconciliation_atomic(org,oct,actor);
  return next is((select evidence from public.bank_reconciliations where id=oct),second_evidence,case_name||': close retry preserves evidence');
  return next is((select evidence from public.bank_reconciliations where id=sept),first_evidence,case_name||': later clearing preserves September evidence');
  return next throws_matching(format('select public.reopen_books_bank_reconciliation(%L,%L,%L,%L)',org,sept,'Correction',actor),'later bank statements first',case_name||': earlier reopening is blocked');
  perform public.reopen_books_bank_reconciliation(org,oct,'Correct classification',actor);
  perform public.reopen_books_bank_reconciliation(org,sept,'Correct classification',actor);
  return next is((select evidence_history->0->'evidence' from public.bank_reconciliations where id=sept),first_evidence,case_name||': September reopening archives evidence');
  return next is((select evidence_history->0->'evidence' from public.bank_reconciliations where id=oct),second_evidence,case_name||': October reopening archives evidence');
  perform public.close_books_bank_reconciliation_atomic(org,sept,actor);
  perform public.close_books_bank_reconciliation_atomic(org,oct,actor);
  return next is((select (evidence->>'outstanding_balance_cents')::bigint from public.bank_reconciliations where id=oct),0::bigint,case_name||': ordered reclose ties again');
end;
$$;
select * from pg_temp.bank_cycle('check',1,-1000);
select * from pg_temp.bank_cycle('deposit',1,1000);
select * from pg_temp.bank_cycle('card',-1,-1000);
set constraints all immediate;
select * from finish();
rollback;
