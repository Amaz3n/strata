const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs")
const {PGlite}=require("@electric-sql/pglite")
const ORG="00000000-0000-4000-8000-000000000001",PKG="00000000-0000-4000-8000-000000000002",OTHER="00000000-0000-4000-8000-000000000003"
async function setup(t){
 const db=new PGlite();t.after(()=>db.close())
 await db.exec("create role anon;create role authenticated;create role service_role;create table outbox(id bigint generated always as identity primary key,org_id uuid,job_type text,payload jsonb,status text default 'pending',retry_count integer default 0,last_error text,run_at timestamptz default now(),updated_at timestamptz default now(),created_at timestamptz default now(),priority integer default 0);create table start_packages(id uuid primary key,org_id uuid,project_id uuid,lot_id uuid,status text,metadata jsonb default '{}');create table projects(id uuid primary key,org_id uuid);create table lots(id uuid primary key,org_id uuid);create table start_release_steps(id uuid primary key,org_id uuid,start_package_id uuid);create table start_package_gates(id uuid primary key,org_id uuid,start_package_id uuid);")
 for(const file of ['20261003023000_starts_job_claim_leases.sql','20261003024000_starts_core_write_fences.sql','20261003030000_starts_package_lease_rpc.sql'])await db.exec(fs.readFileSync(require.resolve(`../supabase/migrations/${file}`),'utf8'))
 await db.query("insert into start_packages(id,org_id,status,metadata) values($1,$2,'releasing',$3)",[PKG,ORG,{preserved:{note:'keep'}}])
 await db.query("insert into outbox(org_id,job_type,payload) values($1,'start_release',$2)",[ORG,{start_package_id:PKG}])
 const job=(await db.query("select * from claim_starts_jobs(1)")).rows[0]
 const headers={'x-starts-job-id':String(job.job_id),'x-starts-claim-token':job.claim_token,'extra':'preserve'}
 await db.query("select set_config('request.headers',$1,false)",[JSON.stringify(headers)])
 const transition=async(action,org=ORG,token=job.claim_token)=>(await db.query("select transition_starts_package_lease($1,$2,$3,$4) ok",[org,job.job_id,token,action])).rows[0].ok
 const row=async()=>(await db.query("select * from start_packages")).rows[0]
 const control=async sql=>{await db.query("select set_config('request.headers','{}',false)");await db.exec(sql);await db.query("select set_config('request.headers',$1,false)",[JSON.stringify(headers)])}
 return {db,job,headers,transition,row,control}
}
test("atomic acquire, renewal and cleanup preserve metadata and restore worker headers",async t=>{
 const h=await setup(t);assert.equal(await h.transition('acquire'),true)
 assert.equal((await h.row()).metadata.release_lease_token,h.job.claim_token)
 assert.deepEqual((await h.row()).metadata.preserved,{note:'keep'})
 assert.equal(await h.transition('heartbeat'),true)
 await h.control("update start_packages set status='released'")
 assert.equal(await h.transition('clear'),true)
 assert.equal((await h.row()).metadata.release_lease_token,null)
 assert.deepEqual((await h.row()).metadata.preserved,{note:'keep'})
 assert.deepEqual((await h.db.query("select current_setting('request.headers') headers")).rows.map(row=>JSON.parse(row.headers)),[h.headers])
})
test("wrong organization, token, expired job and terminal package transitions cannot change a lease",async t=>{
 const h=await setup(t)
 assert.equal(await h.transition('acquire',OTHER),false)
 assert.equal(await h.transition('acquire',ORG,OTHER),false)
 await h.control("update start_packages set status='ready'");assert.equal(await h.transition('acquire'),false)
 await h.control("update start_packages set status='releasing';update outbox set start_job_lease_expires_at=now()-interval '1 second'")
 for(const action of ['acquire','heartbeat','clear'])assert.equal(await h.transition(action),false)
 assert.equal((await h.row()).metadata.release_lease_token,undefined)
})
test("acquisition defers to a live owner and permits stale-owner takeover without reviving expired renewal",async t=>{
 const h=await setup(t)
 await h.control(`update start_packages set metadata=metadata||jsonb_build_object('release_lease_token','${OTHER}','release_lease_at',clock_timestamp())`)
 assert.equal(await h.transition('acquire'),false);assert.equal(await h.transition('clear'),false)
 await h.control("update start_packages set metadata=jsonb_set(metadata,'{release_lease_at}',to_jsonb('2020-01-01'::text))")
 assert.equal(await h.transition('acquire'),true)
 await h.control("update start_packages set metadata=jsonb_set(metadata,'{release_lease_at}',to_jsonb('2020-01-01'::text))")
 assert.equal(await h.transition('heartbeat'),false)
 assert.equal(await h.transition('acquire'),true)
})
test("service-role control is permitted and browser RPC callers are refused",async t=>{
 const h=await setup(t)
 await h.db.exec("grant all on outbox,start_packages to service_role;set role service_role")
 assert.equal(await h.transition('acquire'),true)
 await h.db.exec("reset role;set role authenticated")
 await assert.rejects(h.transition('clear'),/permission denied/)
 await h.db.exec("reset role;grant execute on function transition_starts_package_lease(uuid,bigint,uuid,text) to authenticated;set role authenticated")
 await assert.rejects(h.transition('clear'),/requires service role/)
})

test("malformed metadata is preserved for repair and invalid lease dates cannot wedge acquisition",async t=>{
 const h=await setup(t)
 await h.control("update start_packages set metadata='[]'::jsonb")
 await assert.rejects(h.transition('acquire'),/Invalid package metadata/)
 assert.deepEqual((await h.row()).metadata,[])
 await h.control(`update start_packages set metadata=jsonb_build_object('preserved','keep','release_lease_token','${OTHER}','release_lease_at','not-a-date')`)
 assert.equal(await h.transition('acquire'),true)
 assert.equal((await h.row()).metadata.preserved,'keep')
})
