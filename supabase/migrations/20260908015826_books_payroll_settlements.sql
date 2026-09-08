-- Settlements are reviewed adjusting journals: no second payroll-cost source.
insert into public.gl_accounts(org_id,code,name,account_type,subtype,normal_balance,cash_flow_category,is_system,active)
select org_id,'2230','Payroll deductions payable','liability','other_liability','credit','operating',true,true
from public.books_settings on conflict(org_id,code) do nothing;

create or replace function public.post_books_clearing_settlement(
 p_org_id uuid,p_clearing_code text,p_cash_account_id uuid,p_date date,p_gross_cents bigint,p_withheld_cents bigint,p_reference text,p_evidence_url text,p_actor_id uuid
) returns uuid language plpgsql security definer set search_path='' as $$
declare
 clearing uuid; withholding uuid; available bigint; policy integer; settlement_id uuid; settlement_key text; fingerprint text; lines jsonb;
begin
 if p_clearing_code not in ('2200','2220','2230') or p_gross_cents<=0 or p_withheld_cents<0 or p_withheld_cents>=p_gross_cents or (p_clearing_code<>'2200' and p_withheld_cents<>0) then raise exception 'Invalid payroll or reimbursement settlement amounts'; end if;
 if length(btrim(p_reference))<3 or p_evidence_url not like 'https://%' then raise exception 'Payment reference and supporting document are required'; end if;
 -- Same bank-first lock order as reconciliation and deposit posting.
 perform 1 from public.bank_accounts where org_id=p_org_id and gl_account_id=p_cash_account_id order by id for update;
 perform 1 from public.gl_accounts where org_id=p_org_id and id=p_cash_account_id and active and account_type='asset' and subtype='cash';
 if not found then raise exception 'Choose an active cash account in this organization'; end if;
 select id into clearing from public.gl_accounts where org_id=p_org_id and code=p_clearing_code and active for update;
 if not found then raise exception 'Clearing account is missing'; end if;
 select active_policy_version into policy from public.books_settings where org_id=p_org_id and workspace_enabled and arc_ledger_mode<>'disabled';
 if not found then raise exception 'Books posting is not enabled'; end if;
 settlement_key:='clearing_settlement:'||p_clearing_code||':'||lower(btrim(p_reference));
 fingerprint:=encode(extensions.digest(jsonb_build_array(p_cash_account_id,p_date,p_gross_cents,p_withheld_cents,p_evidence_url)::text,'sha256'),'hex');
 select e.id into settlement_id from public.journal_entries e where e.org_id=p_org_id and e.posting_key=settlement_key;
 if settlement_id is not null then
   if not exists(select 1 from public.journal_entries e join public.journal_lines l on l.entry_id=e.id and l.org_id=e.org_id where e.org_id=p_org_id and e.id=settlement_id and e.status='posted' and l.dimensions->>'settlement_hash'=fingerprint) then raise exception 'Payment reference was already used for different or reversed settlement details'; end if;
   return settlement_id;
 end if;
 select coalesce(sum(l.credit_cents-l.debit_cents),0) into available from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id where l.org_id=p_org_id and l.account_id=clearing and e.status in ('posted','reversed') and e.entry_date<=p_date;
 if p_gross_cents>available then raise exception 'Settlement exceeds the recorded payable balance on the payment date'; end if;
 lines:=jsonb_build_array(jsonb_build_object('line_no',1,'account_id',clearing,'debit_cents',p_gross_cents,'credit_cents',0,'description',p_reference,'dimensions',jsonb_build_object('payment_reference',p_reference,'evidence_url',p_evidence_url,'settlement_hash',fingerprint)),
   jsonb_build_object('line_no',2,'account_id',p_cash_account_id,'debit_cents',0,'credit_cents',p_gross_cents-p_withheld_cents,'description',p_reference,'dimensions','{}'::jsonb));
 if p_withheld_cents>0 then
   select id into withholding from public.gl_accounts where org_id=p_org_id and code='2230' and active;
   if not found then raise exception 'Payroll deductions account is missing'; end if;
   lines:=lines||jsonb_build_array(jsonb_build_object('line_no',3,'account_id',withholding,'debit_cents',0,'credit_cents',p_withheld_cents,'description','Payroll deductions: '||p_reference,'dimensions','{}'::jsonb));
 end if;
 settlement_id:=public.post_books_journal_entry(p_org_id,jsonb_build_object('entry_date',p_date,'entry_kind','adjusting','memo','Clearing settlement: '||p_reference,'posting_key',settlement_key,'projection_version',1,'policy_version',policy,'source_type','payroll_settlement','created_by',p_actor_id),lines);
 return settlement_id;
end;
$$;
revoke all on function public.post_books_clearing_settlement(uuid,text,uuid,date,bigint,bigint,text,text,uuid) from public,anon,authenticated;
grant execute on function public.post_books_clearing_settlement(uuid,text,uuid,date,bigint,bigint,text,text,uuid) to service_role;
