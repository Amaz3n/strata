begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select plan(8);
insert into orgs(id,name,slug) values('99a00000-0000-4000-8000-000000000001','Time cost policy acceptance','time-cost-policy-acceptance');
insert into projects(id,org_id,name) values('99a00000-0000-4000-8000-000000000002','99a00000-0000-4000-8000-000000000001','Time cost acceptance');
insert into time_entries(id,org_id,project_id,worker_name,work_date,hours,base_rate_cents,burden_multiplier,is_overtime,is_double_time)
values
 ('99a00000-0000-4000-8000-000000000010','99a00000-0000-4000-8000-000000000001','99a00000-0000-4000-8000-000000000002','Worker','2026-09-10',8,3000,1.5,false,false),
 ('99a00000-0000-4000-8000-000000000011','99a00000-0000-4000-8000-000000000001','99a00000-0000-4000-8000-000000000002','Worker','2026-09-10',8,3000,1.5,true,false),
 ('99a00000-0000-4000-8000-000000000012','99a00000-0000-4000-8000-000000000001','99a00000-0000-4000-8000-000000000002','Worker','2026-09-10',8,3000,1.5,false,true),
 ('99a00000-0000-4000-8000-000000000014','99a00000-0000-4000-8000-000000000001','99a00000-0000-4000-8000-000000000002','Worker','2026-09-10',0.03,1150,1.5,false,false);
insert into time_entries(id,org_id,project_id,worker_name,work_date,hours,base_rate_cents,burden_multiplier,is_overtime,is_double_time,labor_cost_policy_version)
values('99a00000-0000-4000-8000-000000000013','99a00000-0000-4000-8000-000000000001','99a00000-0000-4000-8000-000000000002','Archived worker','2026-09-10',8,3000,1.5,false,true,0);
select is((select cost_cents from time_entries where id='99a00000-0000-4000-8000-000000000010'),36000,'new regular time cost includes burden');
select is((select cost_cents from time_entries where id='99a00000-0000-4000-8000-000000000011'),54000,'new overtime cost includes premium and burden');
select is((select cost_cents from time_entries where id='99a00000-0000-4000-8000-000000000012'),72000,'new double-time cost includes premium and burden');
select is((select cost_cents from time_entries where id='99a00000-0000-4000-8000-000000000013'),36000,'explicit archival policy preserves original double-time underestimate for reviewed correction');
select is((select cost_cents from time_entries where id='99a00000-0000-4000-8000-000000000014'),52,'generated numeric half-cent cost agrees with captured payroll basis');
select is((select labor_cost_policy_version from time_entries where id='99a00000-0000-4000-8000-000000000012'),1::smallint,'new entries use the corrected policy by default');
select throws_like($$update time_entries set labor_cost_policy_version=2 where id='99a00000-0000-4000-8000-000000000010'$$,'%check constraint%','unknown cost formula is rejected');
select throws_like($$update time_entries set is_overtime=true where id='99a00000-0000-4000-8000-000000000012'$$,'%check constraint%','overtime and double time cannot both apply');
select * from finish();
rollback;
