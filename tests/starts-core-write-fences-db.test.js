const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs")
const {PGlite}=require("@electric-sql/pglite")
const ORG="00000000-0000-4000-8000-000000000001",PKG="00000000-0000-4000-8000-000000000002",PROJECT="00000000-0000-4000-8000-000000000003",LOT="00000000-0000-4000-8000-000000000004"
async function setup(t){
 const db=new PGlite();t.after(()=>db.close())
 await db.exec("create role anon;create role authenticated;create role service_role;create table outbox(id bigint generated always as identity primary key,org_id uuid,job_type text,payload jsonb,status text default 'pending',retry_count integer default 0,last_error text,run_at timestamptz default now(),updated_at timestamptz default now(),created_at timestamptz default now(),priority integer default 0);create table start_packages(id uuid primary key,org_id uuid,project_id uuid,lot_id uuid,status text,metadata jsonb default '{}');create table projects(id uuid primary key,org_id uuid,phase text);create table lots(id uuid primary key,org_id uuid,status text);create table start_release_steps(id uuid primary key,org_id uuid,start_package_id uuid,status text);create table start_package_gates(id uuid primary key,org_id uuid,start_package_id uuid,status text)")
 for(const file of ["20261003023000_starts_job_claim_leases.sql","20261003024000_starts_core_write_fences.sql"])await db.exec(fs.readFileSync(require.resolve(`../supabase/migrations/${file}`),"utf8"))
 await db.query("insert into start_packages(id,org_id,project_id,lot_id,status) values($1,$2,$3,$4,'releasing');",[PKG,ORG,PROJECT,LOT])
 await db.query("insert into projects values($1,$2,'precon')",[PROJECT,ORG]);await db.query("insert into lots values($1,$2,'assigned')",[LOT,ORG])
 await db.query("insert into outbox(org_id,job_type,payload) values($1,'start_release',$2)",[ORG,{start_package_id:PKG}])
 const claim=(await db.query("select * from claim_starts_jobs(1)")).rows[0]
 const headers=job=>db.query("select set_config('request.headers',$1,false)",[JSON.stringify(job?{"x-starts-job-id":String(job.job_id),"x-starts-claim-token":job.claim_token}:{})])
 await headers(claim)
 const acquire=()=>db.query("update start_packages set metadata=jsonb_build_object('release_lease_token',$1::text,'release_lease_at',clock_timestamp()) where id=$2",[claim.claim_token,PKG])
 return {db,claim,headers,acquire}
}
test("core writes require both active job and package ownership",async t=>{
 const h=await setup(t)
 await assert.rejects(h.db.query("update projects set phase='delivery'"),/package lease lost/)
 await h.acquire();await h.db.query("update projects set phase='delivery'")
 await h.headers(null);await h.db.exec("update outbox set start_job_lease_expires_at=now()-interval '1 second'")
 await h.headers(h.claim);await assert.rejects(h.db.query("update lots set status='started'"),/worker lease lost/)
})
test("stale claims and forged browser headers cannot mutate core records",async t=>{
 const h=await setup(t);await h.acquire();await h.headers(null)
 await h.db.exec("update outbox set start_claim_token=gen_random_uuid()")
 await h.headers(h.claim);await assert.rejects(h.db.query("update start_packages set status='released'"),/worker lease lost/)
 await h.db.exec("grant select,update on projects to authenticated;set role authenticated")
 await assert.rejects(h.db.query("update projects set phase='delivery'"),/Browser cannot use/)
})
test("a fresh worker cannot mutate another home or smuggle domain edits during lease acquisition",async t=>{
 const h=await setup(t)
 await assert.rejects(h.db.query("update start_packages set status='released',metadata=jsonb_build_object('release_lease_token',$1::text) where id=$2",[h.claim.claim_token,PKG]),/package lease lost/)
 await h.acquire()
 await h.headers(null);await h.db.query("insert into projects values(gen_random_uuid(),$1,'precon')",[ORG]);await h.headers(h.claim)
 await assert.rejects(h.db.query("update projects set phase='delivery' where id<>$1",[PROJECT]),/project mismatch/)
 await assert.rejects(h.db.query("update lots set org_id=gen_random_uuid()"),/organization mismatch/)
 await assert.rejects(h.db.query("insert into start_release_steps values(gen_random_uuid(),$1,gen_random_uuid(),'completed')",[ORG]),/package mismatch/)
})
test("cancellation invalidates the fence while ordinary non-worker edits remain unchanged",async t=>{
 const h=await setup(t);await h.acquire();await h.headers(null);await h.db.exec("update start_packages set status='ready'")
 await h.headers(h.claim);await assert.rejects(h.db.query("update projects set phase='delivery'"),/no longer releasing/)
 await h.headers(null);await h.db.query("update projects set phase='delivery'")
})

test("ledger and gate writes reject package expiry, null parents and worker deletes",async t=>{
 const h=await setup(t);await h.acquire()
 for(const table of ["start_release_steps","start_package_gates"]){
  await h.db.query(`insert into ${table} values(gen_random_uuid(),$1,$2,'pending')`,[ORG,PKG])
  await assert.rejects(h.db.query(`insert into ${table} values(gen_random_uuid(),$1,null,'pending')`,[ORG]),/package mismatch/)
  await assert.rejects(h.db.query(`delete from ${table}`),/cannot delete/)
 }
 await h.headers(null);await h.db.exec("update start_packages set metadata=jsonb_set(metadata,'{release_lease_at}',to_jsonb('2020-01-01'::text))")
 await h.headers(h.claim)
 for(const table of ["start_release_steps","start_package_gates"])await assert.rejects(h.db.query(`update ${table} set status='completed'`),/package lease lost/)
})
test("direct browser writes to start records are denied even without worker headers",async t=>{
 const h=await setup(t);await h.headers(null)
 await h.db.exec("grant select,insert,update,delete on start_packages,start_release_steps,start_package_gates to authenticated;set role authenticated")
 await assert.rejects(h.db.query("update start_packages set status='released'"),/authorized server actions/)
 for(const table of ["start_release_steps","start_package_gates"])await assert.rejects(h.db.query(`insert into ${table} values(gen_random_uuid(),$1,$2,'completed')`,[ORG,PKG]),/authorized server actions/)
})
