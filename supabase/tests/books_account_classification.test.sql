begin;
select plan(9);
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at,raw_app_meta_data,raw_user_meta_data)
values('19000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','books-account-classification@example.test','',now(),now(),'{}','{}');
insert into app_users(id,email,full_name) values('19000000-0000-0000-0000-000000000001','books-account-classification@example.test','Classification Test');
insert into orgs(id,name,slug,created_by) values('29000000-0000-0000-0000-000000000001','Classification Test','books-account-classification-test','19000000-0000-0000-0000-000000000001');
insert into gl_accounts(id,org_id,code,name,account_type,subtype,normal_balance) values
('39000000-0000-0000-0000-000000000001','29000000-0000-0000-0000-000000000001','1850','Asset','asset','fixed_assets','debit'),
('39000000-0000-0000-0000-000000000002','29000000-0000-0000-0000-000000000001','6990','Expense','expense','other_expense','debit'),
('39000000-0000-0000-0000-000000000003','29000000-0000-0000-0000-000000000001','1000','Cash','asset','cash','debit');
create temporary table original_posting as select post_books_journal_entry('29000000-0000-0000-0000-000000000001',
'{"entry_date":"2026-09-01","entry_kind":"operational","memo":"Classification","posting_key":"classification-original","policy_version":1}',
'[{"line_no":1,"account_id":"39000000-0000-0000-0000-000000000001","debit_cents":100,"credit_cents":0,"dimensions":{"books_account_classification":{"account_type":"income"}}},{"line_no":2,"account_id":"39000000-0000-0000-0000-000000000002","debit_cents":200,"credit_cents":0},{"line_no":3,"account_id":"39000000-0000-0000-0000-000000000003","debit_cents":0,"credit_cents":100},{"line_no":4,"account_id":"39000000-0000-0000-0000-000000000003","debit_cents":0,"credit_cents":200}]') id;
select is((select dimensions->'books_account_classification'->>'account_type' from journal_lines where entry_id=(select id from original_posting) and line_no=1),'asset','posting overwrites a forged classification with its scoped chart type');
update gl_accounts set code='6999',account_type='expense',subtype='other_expense' where id='39000000-0000-0000-0000-000000000001';
select is((select dimensions->'books_account_classification'->>'code' from journal_lines where entry_id=(select id from original_posting) and line_no=1),'1850','old posting keeps its original code after chart recoding');
set constraints all immediate;
set constraints all deferred;
create function pg_temp.reverse_classification(subset boolean default false,wrong boolean default false) returns uuid language plpgsql as $$
declare result jsonb; items jsonb;
begin
 select jsonb_agg(jsonb_build_object('line_no',line_no,'account_id',account_id,'project_id',project_id,'company_id',company_id,'debit_cents',credit_cents,'credit_cents',debit_cents,'dimensions',jsonb_build_object('books_account_classification',jsonb_build_object('account_type','income')) ) order by line_no) into items from journal_lines where entry_id=(select id from original_posting) and (not subset or line_no in (1,3));
 if wrong then items:=jsonb_set(items,'{0,account_id}','"39000000-0000-0000-0000-000000000002"'::jsonb); end if;
 result:=reverse_books_journal_entry('29000000-0000-0000-0000-000000000001',(select id from original_posting),jsonb_build_object('entry_date','2026-09-02','entry_kind','reversal','memo','Classification reversal','posting_key','classification-reversal','policy_version',1,'reversal_of_entry_id',(select id from original_posting)),items);
 set constraints all immediate;
 return (result->>'id')::uuid;
end;
$$;
select throws_matching($$select pg_temp.reverse_classification(false,true)$$,'exactly reverse','a balanced reversal cannot substitute another account');
select throws_matching($$select pg_temp.reverse_classification(true,false)$$,'exactly mirror','a balanced subset cannot retire the whole original entry');
create temporary table reversal_posting as select pg_temp.reverse_classification() id;
select is((select dimensions->'books_account_classification'->>'account_type' from journal_lines where entry_id=(select id from reversal_posting) and line_no=1),'asset','reversal inherits original asset classification despite current expense coding');
select is((select count(*)::integer from journal_lines where entry_id=(select id from reversal_posting)),4,'complete reversal preserves every line');
select ok(not has_function_privilege('authenticated','public.books_capture_account_classification()','execute') and not has_function_privilege('authenticated','public.books_validate_complete_reversal()','execute'),'browser cannot invoke accounting trigger functions');
-- Model a genuinely pre-capture posting; no historical classification is guessed.
alter table journal_lines disable trigger zz_books_capture_account_classification;
create temporary table legacy_posting as select post_books_journal_entry('29000000-0000-0000-0000-000000000001',
'{"entry_date":"2026-09-03","entry_kind":"operational","memo":"Legacy","posting_key":"classification-legacy","policy_version":1}',
'[{"line_no":1,"account_id":"39000000-0000-0000-0000-000000000001","debit_cents":50,"credit_cents":0},{"line_no":2,"account_id":"39000000-0000-0000-0000-000000000003","debit_cents":0,"credit_cents":50}]') id;
alter table journal_lines enable trigger zz_books_capture_account_classification;
create temporary table legacy_reversal as select reverse_books_journal_entry('29000000-0000-0000-0000-000000000001',(select id from legacy_posting),
jsonb_build_object('entry_date','2026-09-04','entry_kind','reversal','memo','Legacy reversal','posting_key','classification-legacy-reversal','policy_version',1,'reversal_of_entry_id',(select id from legacy_posting)),
'[{"line_no":1,"account_id":"39000000-0000-0000-0000-000000000001","debit_cents":0,"credit_cents":50},{"line_no":2,"account_id":"39000000-0000-0000-0000-000000000003","debit_cents":50,"credit_cents":0}]') result;
select is((select dimensions->'books_account_classification'->>'legacy_unknown' from journal_lines where entry_id=(select (result->>'id')::uuid from legacy_reversal) and line_no=1),'true','legacy reversal explicitly marks classification as unknown');
select ok((select not (dimensions->'books_account_classification' ? 'account_type') from journal_lines where entry_id=(select (result->>'id')::uuid from legacy_reversal) and line_no=1),'legacy reversal does not claim current expense type as historical');
set constraints all immediate;
select * from finish();
rollback;
