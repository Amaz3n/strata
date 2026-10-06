const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs')
const {createBooksLedgerDb}=require('./helpers/books-ledger-db')
const ORG='00000000-0000-4000-8000-000000000001',PKG='00000000-0000-4000-8000-000000000002',HOME='00000000-0000-4000-8000-000000000003',LOT='00000000-0000-4000-8000-000000000004',OTHER='00000000-0000-4000-8000-000000000005',ACTOR='00000000-0000-4000-8000-000000000006'
const read=name=>fs.readFileSync(require.resolve(`../supabase/migrations/${name}`),'utf8')
async function setup(t){
 const db=await createBooksLedgerDb();t.after(()=>db.close())
 await db.exec(`create table outbox(id bigint generated always as identity primary key,org_id uuid,job_type text,payload jsonb,status text default 'pending',retry_count integer default 0,last_error text,run_at timestamptz default now(),updated_at timestamptz default now(),created_at timestamptz default now(),priority integer default 0);
 create table start_packages(id uuid primary key,org_id uuid,project_id uuid,lot_id uuid,scheduled_start_date date,status text,metadata jsonb default '{}');
 create table lots(id uuid primary key,org_id uuid,project_id uuid,community_id uuid,division_id uuid,books_acquisition_entry_id uuid);
 create table project_financial_settings(org_id uuid,project_id uuid,books_inventory_enabled boolean,books_inventory_effective_on date,books_inventory_completed_on date,books_inventory_sold_on date);
 create table books_settings(org_id uuid,active_policy_version integer);
 alter table job_cost_entries alter column id set default gen_random_uuid(),add column source_type text,add column source_id uuid,add column is_billable boolean,add column metadata jsonb;
 `)
 // Generated artifact tables are unrelated fixtures needed to load the shared
 // scope helper migration; the accounting tables/RPC/guards are real SQL.
 for(const table of ['schedule_items','budgets','inspections'])await db.exec(`create table ${table}(id uuid primary key,org_id uuid,project_id uuid)`)
 await db.exec('create table budget_lines(id uuid,org_id uuid,budget_id uuid);create table inspection_items(id uuid,org_id uuid,inspection_id uuid);create table schedule_assignments(id uuid,org_id uuid,project_id uuid,schedule_item_id uuid);create table schedule_dependencies(id uuid,org_id uuid,project_id uuid,item_id uuid,depends_on_item_id uuid)')
 for(const file of ['20261003023000_starts_job_claim_leases.sql','20261003025000_starts_generated_artifact_fences.sql','20261003033000_starts_land_posting_fences.sql'])await db.exec(read(file))
 await db.query('insert into orgs values($1)',[ORG]);await db.query('insert into app_users values($1)',[ACTOR]);await db.query('insert into projects(id,org_id) values($1,$2),($3,$2)',[HOME,ORG,OTHER])
 await db.query("insert into gl_accounts(org_id,code,name,account_type,subtype,normal_balance) values($1,'1120','Land','asset','other_asset','debit'),($1,'1160','CIP','asset','work_in_progress','debit'),($1,'1000','Cash','asset','cash','debit')",[ORG])
 const accounts=(await db.query('select id,code from gl_accounts')).rows,land=accounts.find(a=>a.code==='1120').id,cash=accounts.find(a=>a.code==='1000').id
 const acquisition=(await db.query('select post_books_journal_entry($1,$2,$3) id',[ORG,{entry_date:'2026-10-01',entry_kind:'adjusting',memo:'Acquisition',posting_key:'acq',policy_version:1,source_type:'land_acquisition',created_by:ACTOR},[{line_no:1,account_id:land,debit_cents:5000000,dimensions:{lot_id:LOT}},{line_no:2,account_id:cash,credit_cents:5000000}]] )).rows[0].id
 await db.query('insert into lots(id,org_id,project_id,books_acquisition_entry_id) values($1,$2,$3,$4)',[LOT,ORG,HOME,acquisition])
 await db.query("insert into project_financial_settings values($1,$2,true,'2026-10-01',null,null),($1,$3,true,'2026-10-01',null,null)",[ORG,HOME,OTHER]);await db.query('insert into books_settings values($1,1)',[ORG])
 await db.query("insert into start_packages(id,org_id,project_id,lot_id,scheduled_start_date,status) values($1,$2,$3,$4,'2026-10-03','releasing')",[PKG,ORG,HOME,LOT])
 await db.query("insert into outbox(org_id,job_type,payload) values($1,'start_release',$2)",[ORG,{start_package_id:PKG,actor_id:ACTOR}]);const job=(await db.query('select * from claim_starts_jobs(1)')).rows[0]
 await db.query("update start_packages set metadata=jsonb_build_object('release_lease_token',$1::text,'release_lease_at',clock_timestamp())",[job.claim_token])
 const headers=active=>db.query("select set_config('request.headers',$1,false)",[JSON.stringify(active?{'x-starts-job-id':String(job.job_id),'x-starts-claim-token':job.claim_token}:{})])
 await headers(true)
 const transfer=async(lot=LOT,date='2026-10-03',actor=ACTOR)=>(await db.query('select transfer_books_land_to_start($1,$2,$3,$4) result',[ORG,lot,date,actor])).rows[0].result
 return {db,job,headers,transfer,accounts,acquisition}
}
test('owned land transfer balances the real ledger and retries without duplicate costs',async t=>{
 const h=await setup(t);await h.db.exec('set role service_role')
 const result=await h.transfer(),retry=await h.transfer();assert.equal(result.id,retry.id);assert.equal(result.amount_cents,5000000)
 await h.db.exec('reset role')
 const balance=(await h.db.query('select sum(debit_cents)::text debit,sum(credit_cents)::text credit from journal_lines where entry_id=$1',[result.id])).rows[0];assert.equal(balance.debit,balance.credit)
 assert.equal((await h.db.query('select count(*)::int n from job_cost_entries')).rows[0].n,1)
})
test('stale ownership and wrong lot/date/home/actor cannot post land costs',async t=>{
 const h=await setup(t)
 await assert.rejects(h.transfer(OTHER),/scope mismatch/);await assert.rejects(h.transfer(LOT,'2026-10-04'),/scope mismatch/);await assert.rejects(h.transfer(LOT,'2026-10-03',null),/journal transfer mismatch/)
 await h.db.query('update lots set project_id=$1 where id=$2',[OTHER,LOT]);await assert.rejects(h.transfer(),/home mismatch/)
 await h.db.exec("update outbox set start_job_lease_expires_at=clock_timestamp()-interval '1 second'");await assert.rejects(h.transfer(),/worker lease lost/)
 assert.equal((await h.db.query("select count(*)::int n from journal_entries where source_type='inventory_start'")).rows[0].n,0)
})
test('expiry after journal posting rolls back the journal and job-cost receipt together',async t=>{
 const h=await setup(t)
 await h.db.exec(`create function expire_land_worker() returns trigger language plpgsql as $$ begin
 if new.source_type='inventory_start' and new.status='posted' then update outbox set start_job_lease_expires_at=clock_timestamp()-interval '1 second';end if;return new;end $$;
 create trigger expire_land_worker after update on journal_entries for each row execute function expire_land_worker();`)
 await assert.rejects(h.transfer(),/worker lease lost/)
 assert.equal((await h.db.query("select count(*)::int n from journal_entries where source_type='inventory_start'")).rows[0].n,0);assert.equal((await h.db.query('select count(*)::int n from job_cost_entries')).rows[0].n,0)
})
test('retry detects changed dates/homes and a missing job-cost receipt',async t=>{
 const h=await setup(t),result=await h.transfer();await h.headers(false)
 await assert.rejects(h.transfer(LOT,'2026-10-04'),/does not match/)
 await h.db.query('update lots set project_id=$1 where id=$2',[OTHER,LOT]);await assert.rejects(h.transfer(),/does not match/)
 await h.db.query('update lots set project_id=$1 where id=$2',[HOME,LOT]);await h.db.query('delete from job_cost_entries where source_id=$1',[result.id]);await assert.rejects(h.transfer(),/does not match/)
})
test('worker job costs cannot change amount, source, home or billing treatment',async t=>{
 const h=await setup(t),result=await h.transfer()
 await assert.rejects(h.db.query('delete from job_cost_entries where source_id=$1',[result.id]),/cannot delete land postings/)
 await assert.rejects(h.db.query('update job_cost_entries set cost_cents=1 where source_id=$1',[result.id]),/amount mismatch/)
 await assert.rejects(h.db.query('update job_cost_entries set is_billable=true where source_id=$1',[result.id]),/transfer mismatch/)
 await assert.rejects(h.db.query('update job_cost_entries set project_id=$1 where source_id=$2',[OTHER,result.id]),/transfer mismatch/)
 await assert.rejects(h.db.query('update job_cost_entries set source_id=$1 where source_id=$2',[h.acquisition,result.id]),/transfer mismatch/)
 await h.headers(false);await h.db.query('update job_cost_entries set cost_cents=1 where source_id=$1',[result.id]);await assert.rejects(h.transfer(),/does not match/)
})
test('worker journals cannot route transfer debits to an unrelated account or null home',async t=>{
 const h=await setup(t),land=h.accounts.find(a=>a.code==='1120').id,cip=h.accounts.find(a=>a.code==='1160').id,cash=h.accounts.find(a=>a.code==='1000').id
 const post=async(account,project,dimensions)=>h.db.query('select post_books_journal_entry($1,$2,$3)',[ORG,{entry_date:'2026-10-03',entry_kind:'adjusting',memo:'Start',posting_key:`inventory_start:${LOT}`,policy_version:1,source_type:'inventory_start',source_id:LOT,created_by:ACTOR},[{line_no:1,account_id:account,project_id:project,debit_cents:100,dimensions},{line_no:2,account_id:land,credit_cents:100,dimensions:{lot_id:LOT}}]])
 await assert.rejects(post(cash,HOME,{lot_id:LOT}),/inventory line mismatch/)
 await assert.rejects(post(cip,null,{lot_id:LOT}),/inventory line mismatch/)
 await assert.rejects(post(cip,HOME,{lot_id:OTHER}),/journal lot mismatch/)
 assert.equal((await h.db.query("select count(*)::int n from journal_entries where source_type='inventory_start'")).rows[0].n,0)
})
test('foreign job-cost ancestry cannot be hidden by reassignment to the worker home',async t=>{
 const h=await setup(t),result=await h.transfer();await h.headers(false)
 const id=(await h.db.query("insert into job_cost_entries(org_id,project_id,source_type,source_id,incurred_on,cost_cents,status,is_billable,metadata) values($1,$2,'inventory_event',$3,'2026-10-03',5000000,'posted',false,$4) returning id",[ORG,OTHER,result.id,{lot_id:LOT,journal_entry_id:result.id}])).rows[0].id
 await h.headers(true)
 await assert.rejects(h.db.query('update job_cost_entries set project_id=$1 where id=$2',[HOME,id]),/transfer mismatch/)
 await assert.rejects(h.db.query('delete from job_cost_entries where id=$1',[id]),/transfer mismatch/)
})
