const { migrationSql } = require("./support/migration-sql")
const test=require("node:test"),assert=require("node:assert/strict")
const {PGlite}=require("@electric-sql/pglite")
const ORG="00000000-0000-4000-8000-000000000001",PKG="00000000-0000-4000-8000-000000000002",HOME="00000000-0000-4000-8000-000000000003",OTHER="00000000-0000-4000-8000-000000000004"
async function setup(t){
 const db=new PGlite();t.after(()=>db.close())
 await db.exec("create role anon;create role authenticated;create role service_role;create table outbox(id bigint generated always as identity primary key,org_id uuid,job_type text,payload jsonb,status text default 'pending',retry_count integer default 0,last_error text,run_at timestamptz default now(),updated_at timestamptz default now(),created_at timestamptz default now(),priority integer default 0);create table start_packages(id uuid primary key,org_id uuid,project_id uuid,status text,metadata jsonb default '{}');")
 for(const table of ['schedule_items','budgets','inspections'])await db.exec(`create table ${table}(id uuid primary key default gen_random_uuid(),org_id uuid,project_id uuid,name text)`)
 await db.exec("create table budget_lines(id uuid primary key default gen_random_uuid(),org_id uuid,budget_id uuid,name text);create table inspection_items(id uuid primary key default gen_random_uuid(),org_id uuid,inspection_id uuid,name text);create table schedule_assignments(id uuid primary key default gen_random_uuid(),org_id uuid,project_id uuid,schedule_item_id uuid);create table schedule_dependencies(id uuid primary key default gen_random_uuid(),org_id uuid,project_id uuid,item_id uuid,depends_on_item_id uuid);")
 for(const file of ['20261003023000_starts_job_claim_leases.sql','20261003025000_starts_generated_artifact_fences.sql'])await db.exec(migrationSql(file.replace(/\.sql$/, "")))
 await db.query("insert into start_packages(id,org_id,project_id,status) values($1,$2,$3,'releasing')",[PKG,ORG,HOME])
 await db.query("insert into outbox(org_id,job_type,payload) values($1,'start_release',$2)",[ORG,{start_package_id:PKG}])
 const job=(await db.query("select * from claim_starts_jobs(1)")).rows[0]
 await db.query("update start_packages set metadata=jsonb_build_object('release_lease_token',$1::text,'release_lease_at',clock_timestamp())",[job.claim_token])
 const headers=active=>db.query("select set_config('request.headers',$1,false)",[JSON.stringify(active?{'x-starts-job-id':String(job.job_id),'x-starts-claim-token':job.claim_token}:{})])
 const parents={}
 for(const table of ['schedule_items','budgets','inspections'])for(const [key,project]of [['own',HOME],['foreign',OTHER]])parents[`${table}_${key}`]=(await db.query(`insert into ${table}(org_id,project_id,name) values($1,$2,$3) returning id`,[ORG,project,key])).rows[0].id
 await headers(true)
 return {db,job,headers,parents}
}
test("generated roots and child rows must belong to the claimed home",async t=>{
 const h=await setup(t)
 for(const table of ['schedule_items','budgets','inspections']){
  await h.db.query(`insert into ${table}(org_id,project_id) values($1,$2)`,[ORG,HOME])
  await assert.rejects(h.db.query(`insert into ${table}(org_id,project_id) values($1,$2)`,[ORG,OTHER]),/project mismatch/)
 }
 for(const [table,column,parent]of [['budget_lines','budget_id','budgets'],['inspection_items','inspection_id','inspections']]){
  await h.db.query(`insert into ${table}(org_id,${column}) values($1,$2)`,[ORG,h.parents[`${parent}_own`]])
  await assert.rejects(h.db.query(`insert into ${table}(org_id,${column}) values($1,$2)`,[ORG,h.parents[`${parent}_foreign`]]),/mismatch/)
 }
})
test("updates validate old ancestry so foreign rows cannot be moved into the worker scope",async t=>{
 const h=await setup(t);await h.headers(false)
 const line=(await h.db.query("insert into budget_lines(org_id,budget_id) values($1,$2) returning id",[ORG,h.parents.budgets_foreign])).rows[0].id
 await h.headers(true)
 await assert.rejects(h.db.query("update budget_lines set budget_id=$1 where id=$2",[h.parents.budgets_own,line]),/budget mismatch/)
 await assert.rejects(h.db.query("update budgets set project_id=$1 where id=$2",[HOME,h.parents.budgets_foreign]),/project mismatch/)
 await assert.rejects(h.db.query("delete from budget_lines where id=$1",[line]),/budget mismatch/)
})
test("schedule assignment and both dependency endpoints must match the home",async t=>{
 const h=await setup(t),own=h.parents.schedule_items_own,foreign=h.parents.schedule_items_foreign
 await h.db.query("insert into schedule_assignments(org_id,project_id,schedule_item_id) values($1,$2,$3)",[ORG,HOME,own])
 await assert.rejects(h.db.query("insert into schedule_assignments(org_id,project_id,schedule_item_id) values($1,$2,$3)",[ORG,HOME,foreign]),/schedule mismatch/)
 for(const [a,b]of [[own,foreign],[foreign,own]])await assert.rejects(h.db.query("insert into schedule_dependencies(org_id,project_id,item_id,depends_on_item_id) values($1,$2,$3,$4)",[ORG,HOME,a,b]),/dependency mismatch/)
})
test("expired owners cannot update or delete artifacts and ordinary services remain unaffected",async t=>{
 const h=await setup(t);await h.headers(false);await h.db.exec("update outbox set start_job_lease_expires_at=now()-interval '1 second'")
 await h.headers(true)
 await assert.rejects(h.db.query("update inspections set name='changed'"),/worker lease lost/)
 await assert.rejects(h.db.query("delete from schedule_items"),/worker lease lost/)
 await h.headers(false);await h.db.query("update inspections set name='ordinary'")
})

test("service-role worker calls have required helper privileges and ordinary browser writes keep their prior path",async t=>{
 const h=await setup(t)
 await h.db.exec("grant all on outbox,start_packages,schedule_items,schedule_assignments,schedule_dependencies,budgets,budget_lines,inspections,inspection_items to service_role;set role service_role")
 await h.db.query("insert into budget_lines(org_id,budget_id) values($1,$2)",[ORG,h.parents.budgets_own])
 await assert.rejects(h.db.query("insert into inspection_items(org_id,inspection_id) values($1,$2)",[ORG,h.parents.inspections_foreign]),/inspection mismatch/)
 await h.db.exec("reset role;grant all on budgets to authenticated")
 await h.headers(false);await h.db.exec("set role authenticated")
 await h.db.query("insert into budgets(org_id,project_id) values($1,$2)",[ORG,HOME])
 await h.headers(true)
 await assert.rejects(h.db.query("insert into budgets(org_id,project_id) values($1,$2)",[ORG,HOME]),/Browser cannot use/)
})
