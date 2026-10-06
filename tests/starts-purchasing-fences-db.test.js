const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs")
const {PGlite}=require("@electric-sql/pglite")
const ORG="00000000-0000-4000-8000-000000000001",PKG="00000000-0000-4000-8000-000000000002",HOME="00000000-0000-4000-8000-000000000003",LOT="00000000-0000-4000-8000-000000000004",OTHER="00000000-0000-4000-8000-000000000005",VENDOR="00000000-0000-4000-8000-000000000006"
async function setup(t){
 const db=new PGlite();t.after(()=>db.close())
 await db.exec("create role anon;create role authenticated;create role service_role;create table outbox(id bigint generated always as identity primary key,org_id uuid,job_type text,payload jsonb,status text default 'pending',retry_count integer default 0,last_error text,run_at timestamptz default now(),updated_at timestamptz default now(),created_at timestamptz default now(),priority integer default 0);create table start_packages(id uuid primary key,org_id uuid,project_id uuid,lot_id uuid,status text,metadata jsonb default '{}');")
 for(const table of ['schedule_items','budgets','inspections'])await db.exec(`create table ${table}(id uuid primary key default gen_random_uuid(),org_id uuid,project_id uuid)`)
 await db.exec("create table budget_lines(id uuid primary key default gen_random_uuid(),org_id uuid,budget_id uuid);create table inspection_items(id uuid primary key default gen_random_uuid(),org_id uuid,inspection_id uuid);create table schedule_assignments(id uuid primary key default gen_random_uuid(),org_id uuid,project_id uuid,schedule_item_id uuid);create table schedule_dependencies(id uuid primary key default gen_random_uuid(),org_id uuid,project_id uuid,item_id uuid,depends_on_item_id uuid);create table companies(id uuid primary key,org_id uuid);create table commitments(id uuid primary key default gen_random_uuid(),org_id uuid,project_id uuid,company_id uuid,commitment_type text);create table commitment_lines(id uuid primary key default gen_random_uuid(),org_id uuid,commitment_id uuid,budget_line_id uuid);create table po_generation_runs(id uuid primary key default gen_random_uuid(),org_id uuid,project_id uuid,lot_id uuid);create table po_generation_exceptions(id uuid primary key default gen_random_uuid(),org_id uuid,project_id uuid,run_id uuid);create table project_vendors(id uuid primary key default gen_random_uuid(),org_id uuid,project_id uuid,company_id uuid)")
 for(const file of ['20261003023000_starts_job_claim_leases.sql','20261003025000_starts_generated_artifact_fences.sql','20261003031000_starts_purchasing_write_fences.sql'])await db.exec(fs.readFileSync(require.resolve(`../supabase/migrations/${file}`),'utf8'))
 await db.query("insert into companies values($1,$2)",[VENDOR,ORG])
 await db.query("insert into start_packages(id,org_id,project_id,lot_id,status) values($1,$2,$3,$4,'releasing')",[PKG,ORG,HOME,LOT])
 await db.query("insert into outbox(org_id,job_type,payload) values($1,'start_release',$2)",[ORG,{start_package_id:PKG}])
 const job=(await db.query("select * from claim_starts_jobs(1)")).rows[0]
 await db.query("update start_packages set metadata=jsonb_build_object('release_lease_token',$1::text,'release_lease_at',clock_timestamp())",[job.claim_token])
 const headers=active=>db.query("select set_config('request.headers',$1,false)",[JSON.stringify(active?{'x-starts-job-id':String(job.job_id),'x-starts-claim-token':job.claim_token}:{})])
 const po=async(project=HOME,type='purchase_order',vendor=VENDOR)=>(await db.query("insert into commitments(org_id,project_id,company_id,commitment_type) values($1,$2,$3,$4) returning id",[ORG,project,vendor,type])).rows[0].id
 await headers(true);return {db,headers,po,job}
}
test("owned PO, vendor, generation run and exception writes are accepted",async t=>{
 const h=await setup(t),po=await h.po()
 await h.db.query("insert into commitment_lines(org_id,commitment_id) values($1,$2)",[ORG,po])
 const run=(await h.db.query("insert into po_generation_runs(org_id,project_id,lot_id) values($1,$2,$3) returning id",[ORG,HOME,LOT])).rows[0].id
 await h.db.query("insert into po_generation_exceptions(org_id,project_id,run_id) values($1,$2,$3)",[ORG,HOME,run])
 await h.db.query("insert into project_vendors(org_id,project_id,company_id) values($1,$2,$3)",[ORG,HOME,VENDOR])
 await assert.rejects(h.po(HOME,'subcontract'),/non-PO/)
 await assert.rejects(h.po(OTHER),/project mismatch/)
 await assert.rejects(h.db.query("insert into po_generation_runs(org_id,project_id,lot_id) values($1,$2,$3)",[ORG,HOME,OTHER]),/lot mismatch/)
})
test("old purchasing ancestry cannot be laundered by changing parent or home",async t=>{
 const h=await setup(t);await h.headers(false);const foreign=await h.po(OTHER)
 const line=(await h.db.query("insert into commitment_lines(org_id,commitment_id) values($1,$2) returning id",[ORG,foreign])).rows[0].id
 await h.headers(true);const owned=await h.po()
 await assert.rejects(h.db.query("update commitment_lines set commitment_id=$1 where id=$2",[owned,line]),/purchase order mismatch/)
 await assert.rejects(h.db.query("update commitments set project_id=$1 where id=$2",[HOME,foreign]),/project mismatch/)
 await assert.rejects(h.db.query("delete from commitment_lines where id=$1",[line]),/purchase order mismatch/)
})
test("vendors and line budget mappings must be in the owned organization and home",async t=>{
 const h=await setup(t);await h.headers(false)
 await h.db.query("insert into companies values($1,$2)",[OTHER,OTHER])
 const budget=(await h.db.query("insert into budgets(org_id,project_id) values($1,$2) returning id",[ORG,OTHER])).rows[0].id
 const line=(await h.db.query("insert into budget_lines(org_id,budget_id) values($1,$2) returning id",[ORG,budget])).rows[0].id
 await h.headers(true)
 await assert.rejects(h.po(HOME,'purchase_order',OTHER),/vendor mismatch/)
 const po=await h.po()
 await assert.rejects(h.db.query("insert into commitment_lines(org_id,commitment_id,budget_line_id) values($1,$2,$3)",[ORG,po,line]),/budget line mismatch/)
})
test("expiry during a transaction rolls back the PO instead of leaving a partial financial artifact",async t=>{
 const h=await setup(t);await h.db.exec('begin');const po=await h.po()
 await h.db.exec("update outbox set start_job_lease_expires_at=now()-interval '1 second'")
 await assert.rejects(h.db.query("insert into commitment_lines(org_id,commitment_id) values($1,$2)",[ORG,po]),/worker lease lost/)
 await h.db.exec('rollback')
 assert.equal((await h.db.query("select count(*)::int n from commitments")).rows[0].n,0)
})

test("generation exceptions validate prior run ancestry and cannot be reassigned to hide a foreign source",async t=>{
 const h=await setup(t);await h.headers(false)
 const foreign=(await h.db.query("insert into po_generation_runs(org_id,project_id,lot_id) values($1,$2,$3) returning id",[ORG,OTHER,LOT])).rows[0].id
 const exception=(await h.db.query("insert into po_generation_exceptions(org_id,project_id,run_id) values($1,$2,$3) returning id",[ORG,HOME,foreign])).rows[0].id
 await h.headers(true)
 const owned=(await h.db.query("insert into po_generation_runs(org_id,project_id,lot_id) values($1,$2,$3) returning id",[ORG,HOME,LOT])).rows[0].id
 await assert.rejects(h.db.query("update po_generation_exceptions set run_id=$1 where id=$2",[owned,exception]),/generation run mismatch/)
 await assert.rejects(h.db.query("insert into po_generation_exceptions(org_id,project_id,run_id) values($1,$2,$3)",[ORG,HOME,foreign]),/generation run mismatch/)
})
test("service-role execution can create a PO line mapped to its owned budget",async t=>{
 const h=await setup(t)
 await h.db.exec("grant all on outbox,start_packages,companies,commitments,commitment_lines,budgets,budget_lines to service_role;set role service_role")
 const budget=(await h.db.query("insert into budgets(org_id,project_id) values($1,$2) returning id",[ORG,HOME])).rows[0].id
 const line=(await h.db.query("insert into budget_lines(org_id,budget_id) values($1,$2) returning id",[ORG,budget])).rows[0].id
 const po=await h.po()
 await h.db.query("insert into commitment_lines(org_id,commitment_id,budget_line_id) values($1,$2,$3)",[ORG,po,line])
})

// Replay the repository RPC, rather than a hand-written approximation. This
// fixture adds its columns and hot FK actions; it is not the full schema chain.
async function setupCommit(t,patched=true){
 const h=await setup(t)
 await h.db.exec(`
 create type public.cost_type as enum ('labor','material','equipment','other');
 alter table budgets add column version integer,add column status text,add column total_cents integer,add column metadata jsonb;
 alter table budget_lines add column cost_code_id uuid,add column description text,add column amount_cents integer,add column sort_order integer,add column cost_type cost_type,add column metadata jsonb,
 add foreign key(budget_id) references budgets(id) on delete cascade;
 alter table commitments add column title text,add column status text,add column total_cents integer,add column currency text,add column contract_number text,add column scope text,add column issued_at timestamptz,add column metadata jsonb;
 alter table commitment_lines add column cost_code_id uuid,add column description text,add column quantity numeric,add column unit text,add column unit_cost_cents integer,add column scheduled_value_cents integer,add column sort_order integer,add column metadata jsonb,
 add foreign key(commitment_id) references commitments(id) on delete cascade,
 add foreign key(budget_line_id) references budget_lines(id) on delete set null;
 alter table po_generation_runs add column mode text default 'commit',add column status text default 'running',add column input_fingerprint text,add column summary jsonb,add column completed_at timestamptz;
 alter table po_generation_exceptions add column cost_code_id uuid,add column source_kind text,add column source_ref jsonb,add column description text,add column quantity numeric,add column uom text,add column reason text,add column candidates jsonb;
 alter table project_vendors add column role text,add column scope text,add column status text,add column notes text,add unique(project_id,company_id);
 create table vendor_bills(id uuid primary key default gen_random_uuid(),org_id uuid,commitment_id uuid references commitments(id));
 `)
 await h.db.exec(fs.readFileSync(require.resolve('../supabase/migrations/20260817120100_po_generation_serialization.sql'),'utf8'))
 if(patched)await h.db.exec(fs.readFileSync(require.resolve('../supabase/migrations/20261003032000_po_regeneration_fenced_children.sql'),'utf8'))
 const run=async()=> (await h.db.query("insert into po_generation_runs(org_id,project_id,lot_id,input_fingerprint) values($1,$2,$3,replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','')) returning id",[ORG,HOME,LOT])).rows[0].id
 const payload={total_cents:100,budget_lines:[{description:'Framing',amount_cents:100,cost_type:'labor'}],purchase_orders:[{company_id:VENDOR,title:'Framing',total_cents:100,lines:[{description:'Framing',quantity:1,unit:'ea',unit_cost_cents:100,total_cents:100,cost_type:'labor'}]}],exceptions:[{source_kind:'option',source_ref:{option_id:'missing'},description:'Unpriced option',reason:'no_agreement'}],summary:{exception_count:1}}
 const commit=async(id,prior=null,overrides={})=>(await h.db.query("select run_po_generation_commit($1,$2,$3) result",[ORG,id,{...payload,...overrides,prior_run_id:prior}])).rows[0].result
 return {...h,run,commit,payload}
}
test("repository PO RPC exposes parent-first cascade failure with staged fences",async t=>{
 const h=await setupCommit(t,false),first=await h.run();await h.commit(first)
 const second=await h.run()
 await assert.rejects(h.commit(second,first),/purchase order mismatch/)
 assert.equal((await h.db.query('select count(*)::int n from commitments')).rows[0].n,1)
 assert.equal((await h.db.query('select count(*)::int n from commitment_lines')).rows[0].n,1)
})
test("staged PO RPC regenerates fenced children and mappings atomically as service role",async t=>{
 const h=await setupCommit(t),first=await h.run(),initial=await h.commit(first),second=await h.run()
 await h.db.exec('set role service_role')
 const result=await h.commit(second,first)
 await h.db.exec('reset role')
 assert.notEqual(result.budget_id,initial.budget_id)
 assert.equal((await h.db.query('select count(*)::int n from commitments')).rows[0].n,1)
 assert.equal((await h.db.query('select count(*)::int n from budgets')).rows[0].n,1)
 assert.equal((await h.db.query('select count(*)::int n from commitment_lines cl join budget_lines bl on bl.id=cl.budget_line_id join budgets b on b.id=bl.budget_id where b.id=$1',[result.budget_id])).rows[0].n,1)
 assert.equal((await h.db.query('select status from po_generation_runs where id=$1',[first])).rows[0].status,'superseded')
 await assert.rejects(h.commit(await h.run(),first),/not replaceable/)
})
test("regeneration preserves progressed or billed POs and refuses foreign prior runs",async t=>{
 const h=await setupCommit(t),first=await h.run(),initial=await h.commit(first)
 await h.db.query("update commitments set status='approved' where id=$1",[initial.commitment_ids[0]])
 await assert.rejects(h.commit(await h.run(),first),/progressed/)
 await h.db.query("update commitments set status='draft' where id=$1",[initial.commitment_ids[0]])
 await h.db.query('insert into vendor_bills(org_id,commitment_id) values($1,$2)',[ORG,initial.commitment_ids[0]])
 await assert.rejects(h.commit(await h.run(),first),/progressed/)
 await h.headers(false)
 await h.db.query('update po_generation_runs set project_id=$1 where id=$2',[OTHER,first])
 await h.headers(true)
 await assert.rejects(h.commit(await h.run(),first),/not replaceable/)
 assert.equal((await h.db.query('select count(*)::int n from commitment_lines')).rows[0].n,1)
})
test("late invalid vendor rolls back all regeneration deletes and prior status",async t=>{
 const h=await setupCommit(t),first=await h.run(),initial=await h.commit(first),second=await h.run()
 await assert.rejects(h.commit(second,first,{purchase_orders:[{...h.payload.purchase_orders[0],company_id:OTHER}]}),/vendor mismatch/)
 assert.equal((await h.db.query('select id from budgets')).rows[0].id,initial.budget_id)
 assert.equal((await h.db.query('select id from commitments')).rows[0].id,initial.commitment_ids[0])
 assert.equal((await h.db.query('select count(*)::int n from commitment_lines')).rows[0].n,1)
 assert.equal((await h.db.query('select status from po_generation_runs where id=$1',[first])).rows[0].status,'succeeded_with_exceptions')
 assert.equal((await h.db.query('select status from po_generation_runs where id=$1',[second])).rows[0].status,'running')
})
test("ordinary service-role generation remains compatible without worker headers",async t=>{
 const h=await setupCommit(t);await h.headers(false)
 const first=await h.run();await h.commit(first)
 const second=await h.run();await h.db.exec('set role service_role')
 const result=await h.commit(second,first)
 assert.equal(result.commitment_ids.length,1)
 await h.db.exec('set role authenticated')
 await assert.rejects(h.commit(first),/permission denied for function run_po_generation_commit/)
})
test("duplicate successful fingerprint fails atomically without replacing the prior set",async t=>{
 const h=await setupCommit(t),first=await h.run(),initial=await h.commit(first),second=await h.run()
 await h.db.query('update po_generation_runs set input_fingerprint=(select input_fingerprint from po_generation_runs where id=$1) where id=$2',[first,second])
 await assert.rejects(h.commit(second),/po_generation_runs_commit_fingerprint_uidx/)
 assert.equal((await h.db.query('select count(*)::int n from commitments')).rows[0].n,1)
 assert.equal((await h.db.query('select id from budgets')).rows[0].id,initial.budget_id)
})
test("PO commit refuses expired ownership before creating any domain artifacts",async t=>{
 const h=await setupCommit(t),run=await h.run()
 await h.db.exec("update outbox set start_job_lease_expires_at=clock_timestamp()-interval '1 second'")
 await assert.rejects(h.commit(run),/worker lease lost/)
 for(const table of ['budgets','budget_lines','commitments','commitment_lines','project_vendors','po_generation_exceptions']){
  assert.equal((await h.db.query(`select count(*)::int n from ${table}`)).rows[0].n,0,table)
 }
 assert.equal((await h.db.query('select status from po_generation_runs where id=$1',[run])).rows[0].status,'running')
})
test("ownership expiry after budget creation rolls back the actual PO RPC",async t=>{
 const h=await setupCommit(t),first=await h.run(),initial=await h.commit(first),second=await h.run()
 await h.db.exec(`create function expire_po_worker() returns trigger language plpgsql as $$ begin
 update outbox set start_job_lease_expires_at=clock_timestamp()-interval '1 second';return new;end $$;
 create trigger expire_po_worker after insert on budgets for each row execute function expire_po_worker();`)
 await assert.rejects(h.commit(second,first),/worker lease lost/)
 assert.equal((await h.db.query('select id from budgets')).rows[0].id,initial.budget_id)
 assert.equal((await h.db.query('select id from commitments')).rows[0].id,initial.commitment_ids[0])
 assert.equal((await h.db.query('select status from po_generation_runs where id=$1',[first])).rows[0].status,'succeeded_with_exceptions')
 assert.equal((await h.db.query('select start_job_lease_expires_at>clock_timestamp() active from outbox')).rows[0].active,true)
})
test("worker commit rejects a run for a different home or lot before domain writes",async t=>{
 const h=await setupCommit(t);await h.headers(false)
 const wrongHome=(await h.db.query('insert into po_generation_runs(org_id,project_id,lot_id) values($1,$2,$3) returning id',[ORG,OTHER,LOT])).rows[0].id
 const wrongLot=(await h.db.query('insert into po_generation_runs(org_id,project_id,lot_id) values($1,$2,$3) returning id',[ORG,HOME,OTHER])).rows[0].id
 await h.headers(true)
 await assert.rejects(h.commit(wrongHome),/project mismatch/)
 await assert.rejects(h.commit(wrongLot),/lot mismatch/)
 assert.equal((await h.db.query('select count(*)::int n from budgets')).rows[0].n,0)
})
test("source-run probes use staged indexes among ten thousand unrelated artifacts",async t=>{
 const h=await setupCommit(t),run=await h.run();await h.commit(run);await h.headers(false)
 for(const table of ['commitments','budgets']){
  await h.db.query(`insert into ${table}(org_id,project_id,metadata) select $1::uuid,$2::uuid,jsonb_build_object('source_generation_run_id',$3::text) from generate_series(1,10000)`,[ORG,OTHER,OTHER])
  await h.db.exec(`analyze ${table}`)
  const plan=(await h.db.query(`explain select id from ${table} where org_id=$1 and metadata->>'source_generation_run_id'=$2 order by id for update`,[ORG,run])).rows.map(row=>row['QUERY PLAN']).join('\n')
  assert.match(plan,new RegExp(`${table}_generation_run_idx`),plan)
 }
})
