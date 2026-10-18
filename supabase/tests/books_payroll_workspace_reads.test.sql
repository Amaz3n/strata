-- Full application-schema RPC boundary acceptance; populated money proof also
-- runs in tests/books-payroll-workspace-reads.test.js. This fixture rolls back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select plan(11);
insert into auth.users(id,email) values('99410000-0000-4000-8000-000000000002','payroll-workspace-reads@example.test');
insert into public.app_users(id,email,full_name) values('99410000-0000-4000-8000-000000000002','payroll-workspace-reads@example.test','Payroll workspace reads');
insert into public.orgs(id,name,slug,created_by) values
('99410000-0000-4000-8000-000000000001','Payroll workspace reads','payroll-workspace-reads-test','99410000-0000-4000-8000-000000000002'),
('99410000-0000-4000-8000-000000000099','Other payroll workspace','payroll-workspace-other-test','99410000-0000-4000-8000-000000000002');
insert into public.projects(id,org_id,name) values
('99410000-0000-4000-8000-000000000004','99410000-0000-4000-8000-000000000001','Project payroll review'),
('99410000-0000-4000-8000-000000000098','99410000-0000-4000-8000-000000000099','Other payroll review');
select ok(exists(select 1 from pg_proc where oid='public.capture_books_payroll_workspace_snapshot(uuid,uuid,uuid,timestamptz,uuid,integer)'::regprocedure and provolatile='s' and not prosecdef),'workspace read has one stable invoker snapshot');
select ok(has_function_privilege('service_role','public.capture_books_payroll_workspace_snapshot(uuid,uuid,uuid,timestamptz,uuid,integer)','execute'),'private service can read project payroll');
set local role anon;
select throws_like($$select public.capture_books_payroll_workspace_snapshot('99410000-0000-4000-8000-000000000001','99410000-0000-4000-8000-000000000004')$$,'%permission denied%','anonymous callers cannot read salaries');
reset role;
set local role authenticated;
select throws_like($$select public.capture_books_payroll_workspace_snapshot('99410000-0000-4000-8000-000000000001','99410000-0000-4000-8000-000000000004')$$,'%permission denied%','browser callers cannot bypass whole-org Books authorization');
reset role;
set local role service_role;
select is(public.capture_books_payroll_workspace_snapshot('99410000-0000-4000-8000-000000000001','99410000-0000-4000-8000-000000000004')->'sourceIds','[]'::jsonb,'empty project has no invented payroll sources');
select is(public.capture_books_payroll_workspace_snapshot('99410000-0000-4000-8000-000000000001','99410000-0000-4000-8000-000000000004')->'nextCursor','null'::jsonb,'empty project has no phantom continuation');
select is(public.capture_books_payroll_workspace_snapshot('99410000-0000-4000-8000-000000000001','99410000-0000-4000-8000-000000000004')->'tables'->'journal_lines',null::jsonb,'empty review does not transfer organization ledger history');
select throws_like($$select public.capture_books_payroll_workspace_snapshot('99410000-0000-4000-8000-000000000001','99410000-0000-4000-8000-000000000098')$$,'%Project is unavailable%','foreign project cannot enter the private read');
select throws_like($$select public.capture_books_payroll_workspace_snapshot('99410000-0000-4000-8000-000000000001','99410000-0000-4000-8000-000000000004','99410000-0000-4000-8000-000000000007')$$,'%does not affect%','unowned source cannot enter the private read');
select throws_like($$select public.capture_books_payroll_workspace_snapshot('99410000-0000-4000-8000-000000000001','99410000-0000-4000-8000-000000000004',null,null,null,51)$$,'%Invalid payroll workspace%','source page cap is enforced in SQL');
select throws_like($$select public.capture_books_payroll_workspace_snapshot('99410000-0000-4000-8000-000000000001','99410000-0000-4000-8000-000000000004',null,'2026-10-01',null,50)$$,'%Invalid payroll workspace%','half cursor cannot silently skip or repeat history');
reset role;
select * from finish();
rollback;
