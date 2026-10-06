const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs')
const {PGlite}=require('@electric-sql/pglite')
const ORG='00000000-0000-4000-8000-000000000001',PKG='00000000-0000-4000-8000-000000000002',HOME='00000000-0000-4000-8000-000000000003',OTHER='00000000-0000-4000-8000-000000000004',VERSION='00000000-0000-4000-8000-000000000005',SOURCE='00000000-0000-4000-8000-000000000006',LOT='00000000-0000-4000-8000-000000000007',COMM='00000000-0000-4000-8000-000000000008'
async function setup(t){
 const db=new PGlite();t.after(()=>db.close())
 await db.exec("create role anon;create role authenticated;create role service_role;create table outbox(id bigint generated always as identity primary key,org_id uuid,job_type text,payload jsonb,status text default 'pending',retry_count integer default 0,last_error text,run_at timestamptz default now(),updated_at timestamptz default now(),created_at timestamptz default now(),priority integer default 0);create table orgs(id uuid primary key);create table app_users(id uuid primary key);create table communities(id uuid primary key,org_id uuid);create table projects(id uuid primary key,org_id uuid,metadata jsonb default '{}');create table lots(id uuid primary key,org_id uuid,project_id uuid,community_id uuid,house_plan_version_id uuid);")
 const packages=fs.readFileSync(require.resolve('../supabase/migrations/20260718210910_start_packages.sql'),'utf8');const start=packages.indexOf('create table public.start_packages (');await db.exec(packages.slice(start,packages.indexOf('\n);',start)+4))
 for(const table of ['schedule_items','budgets','inspections'])await db.exec(`create table ${table}(id uuid primary key,org_id uuid,project_id uuid)`)
 await db.exec('create table budget_lines(id uuid,org_id uuid,budget_id uuid);create table inspection_items(id uuid,org_id uuid,inspection_id uuid);create table schedule_assignments(id uuid,org_id uuid,project_id uuid,schedule_item_id uuid);create table schedule_dependencies(id uuid,org_id uuid,project_id uuid,item_id uuid,depends_on_item_id uuid);create table files(id uuid primary key default gen_random_uuid(),org_id uuid,project_id uuid,storage_path text,source text,visibility text,category text,metadata jsonb);create table drawing_sets(id uuid primary key default gen_random_uuid(),org_id uuid,project_id uuid,source_file_id uuid references files(id));create table drawing_revisions(id uuid primary key default gen_random_uuid(),org_id uuid,project_id uuid,source_file_id uuid references files(id),drawing_set_id uuid references drawing_sets(id));create table house_plan_versions(id uuid primary key,org_id uuid,status text,bundle_snapshot jsonb)')
 for(const file of ['20261003023000_starts_job_claim_leases.sql','20261003025000_starts_generated_artifact_fences.sql','20261003033500_starts_release_lot_plan_scope.sql','20261003034000_starts_drawing_record_fences.sql'])await db.exec(fs.readFileSync(require.resolve(`../supabase/migrations/${file}`),'utf8'))
 await db.query('insert into files(id,org_id) values($1,$2)',[SOURCE,ORG])
 await db.query("insert into house_plan_versions values($1,$2,'released',$3)",[VERSION,ORG,{drawing_source_file_id:SOURCE}])
 await db.query('insert into orgs values($1)',[ORG]);await db.query('insert into communities values($1,$2)',[COMM,ORG]);await db.query('insert into projects(id,org_id) values($1,$2)',[HOME,ORG]);await db.query('insert into lots values($1,$2,$3,$4,$5)',[LOT,ORG,HOME,COMM,VERSION])
 await db.query("insert into start_packages(id,org_id,project_id,lot_id,community_id,status) values($1,$2,$3,$4,$5,'releasing')",[PKG,ORG,HOME,LOT,COMM])
 await db.query("insert into outbox(org_id,job_type,payload) values($1,'start_release',$2)",[ORG,{start_package_id:PKG}]);const job=(await db.query('select * from claim_starts_jobs(1)')).rows[0]
 await db.query("update start_packages set metadata=jsonb_build_object('release_lease_token',$1::text,'release_lease_at',clock_timestamp())",[job.claim_token])
 const headers=active=>db.query("select set_config('request.headers',$1,false)",[JSON.stringify(active?{'x-starts-job-id':String(job.job_id),'x-starts-claim-token':job.claim_token}:{})])
 const file=async(project=HOME,path=`${ORG}/projects/${project}/plans/${VERSION}/plan.pdf`,version=VERSION,source=SOURCE)=>(await db.query("insert into files(org_id,project_id,storage_path,source,visibility,category,metadata) values($1,$2,$3,'generated','private','plans',$4) returning id",[ORG,project,path,{source_plan_version_id:version,source_file_id:source}])).rows[0].id
 const set=async(source,project=HOME)=>(await db.query('insert into drawing_sets(org_id,project_id,source_file_id) values($1,$2,$3) returning id',[ORG,project,source])).rows[0].id
 await headers(true);return {db,job,headers,file,set}
}
test('owned snapshot PDF, canonical set and revision writes work under service role',async t=>{
 const h=await setup(t);await h.db.exec('grant all on files,drawing_sets,drawing_revisions,house_plan_versions,outbox,start_packages,lots to service_role;set role service_role')
 const file=await h.file(),set=await h.set(file)
 await h.db.query('insert into drawing_revisions(org_id,project_id,source_file_id,drawing_set_id) values($1,$2,$3,$4)',[ORG,HOME,file,set])
})
test('PDF records reject wrong home, plan, frozen source and destination traversal',async t=>{
 const h=await setup(t)
 await assert.rejects(h.file(OTHER),/home mismatch/)
 await assert.rejects(h.file(HOME,undefined,OTHER),/plan mismatch/)
 await assert.rejects(h.file(HOME,undefined,VERSION,OTHER),/source snapshot mismatch/)
 await assert.rejects(h.file(HOME,`${ORG}/projects/${HOME}/plans/${VERSION}/../wrong.pdf`),/destination mismatch/)
 await assert.rejects(h.file(HOME,`${OTHER}/projects/${HOME}/plans/${VERSION}/plan.pdf`),/destination mismatch/)
 await assert.rejects(h.file(HOME,`${ORG}/projects/${HOME}/plans/${OTHER}/plan.pdf`),/destination mismatch/)
})
test('drawing parent references cannot cross homes or hide old ancestry',async t=>{
 const h=await setup(t),ownFile=await h.file(),ownSet=await h.set(ownFile);await h.headers(false)
 const foreignFile=await h.file(OTHER),foreignSet=await h.set(foreignFile,OTHER)
 const revision=(await h.db.query('insert into drawing_revisions(org_id,project_id,source_file_id,drawing_set_id) values($1,$2,$3,$4) returning id',[ORG,HOME,foreignFile,foreignSet])).rows[0].id
 await h.headers(true)
 await assert.rejects(h.set(foreignFile),/project file mismatch/)
 await assert.rejects(h.db.query('insert into drawing_revisions(org_id,project_id,source_file_id,drawing_set_id) values($1,$2,$3,$4)',[ORG,HOME,ownFile,foreignSet]),/set mismatch/)
 await assert.rejects(h.db.query('update drawing_revisions set source_file_id=$1,drawing_set_id=$2 where id=$3',[ownFile,ownSet,revision]),/project file mismatch/)
 await assert.rejects(h.db.query('update files set project_id=$1 where id=$2',[HOME,foreignFile]),/home mismatch/)
})
test('expired worker changes are rejected and transaction artifacts roll back',async t=>{
 const h=await setup(t);await h.db.exec('begin');const file=await h.file()
 await h.db.exec("update outbox set start_job_lease_expires_at=clock_timestamp()-interval '1 second'")
 await assert.rejects(h.set(file),/worker lease lost/);await h.db.exec('rollback')
 assert.equal((await h.db.query('select count(*)::int n from files where project_id=$1',[HOME])).rows[0].n,0)
})
test('ordinary file writes preserve policy while forged browser worker headers fail',async t=>{
 const h=await setup(t);await h.headers(false);await h.db.exec('grant all on files to authenticated;set role authenticated')
 await h.file(OTHER);await h.headers(true);await assert.rejects(h.file(),/Browser cannot use starts worker headers/)
})
test('canonical set can replace its old home PDF but new sources must match the claimed plan',async t=>{
 const h=await setup(t);await h.headers(false)
 const oldFile=(await h.db.query('insert into files(org_id,project_id) values($1,$2) returning id',[ORG,HOME])).rows[0].id
 const set=await h.set(oldFile),wrongPlan=await h.file(HOME,undefined,OTHER)
 await h.headers(true)
 await assert.rejects(h.set(wrongPlan),/generated source mismatch/)
 const file=await h.file();await h.db.query('update drawing_sets set source_file_id=$1 where id=$2',[file,set])
 assert.equal((await h.db.query('select source_file_id from drawing_sets where id=$1',[set])).rows[0].source_file_id,file)
 await h.db.exec("update outbox set start_job_lease_expires_at=clock_timestamp()-interval '1 second'")
 await assert.rejects(h.db.query('delete from files where id=$1',[file]),/worker lease lost/)
 await assert.rejects(h.db.query("update files set visibility='public' where id=$1",[file]),/worker lease lost/)
})
async function publication(t){
 const h=await setup(t)
 await h.db.exec(` alter table files add column file_name text,add column mime_type text,add column size_bytes bigint,add column checksum text,add column folder_path text,add column uploaded_by uuid;
 alter table house_plan_versions add column version_number integer;
 alter table drawing_sets add column title text,add column status text,add column processing_stage text,add column created_by uuid,add column created_at timestamptz default now();
 alter table drawing_revisions add column revision_label text,add column issuance_type text,add column status text,add column processing_stage text,add column issued_date date,add column created_by uuid;`)
 // Source is a library record; mutate it through its ordinary owning service.
 await h.headers(false);await h.db.query("update files set file_name='plan.pdf',size_bytes=100 where id=$1",[SOURCE]);await h.db.query('update house_plan_versions set version_number=1 where id=$1',[VERSION])
 await h.db.query("update outbox set payload=payload||jsonb_build_object('actor_id',$1::text)",[OTHER]);await h.headers(true)
 await h.db.exec(fs.readFileSync(require.resolve('../supabase/migrations/20261003035000_plan_drawing_publication_transaction.sql'),'utf8'))
 await h.db.exec(fs.readFileSync(require.resolve('../supabase/migrations/20261003036000_plan_drawing_copy_attempt.sql'),'utf8'))
 const reserve=async(evidence={size_bytes:100,source_etag:'source'})=>(await h.db.query('select reserve_plan_drawing_copy($1,$2,$3,$4,$5) result',[ORG,HOME,VERSION,OTHER,evidence])).rows[0].result
 const manifest=await reserve(),copy={attempt_id:manifest.attempt_id,storage_path:manifest.storage_path,size_bytes:100,source_etag:'source',etag:'copy'}
 const publish=async(evidence=copy,actor=OTHER)=>(await h.db.query('select publish_plan_drawing_copy($1,$2,$3,$4,$5) result',[ORG,HOME,VERSION,actor,evidence])).rows[0].result
 return {...h,copy,publish,reserve}
}
test('publication atomically creates file, canonical set, revision and job and replays a lost response',async t=>{
 const h=await publication(t);await h.db.exec('set role service_role')
 const first=await h.publish(),retry=await h.publish();assert.equal(first.replayed,false);assert.equal(retry.replayed,true);assert.equal(first.file_id,retry.file_id);assert.equal(first.job_id,retry.job_id)
 await h.db.exec('reset role')
 for(const table of ['drawing_sets','drawing_revisions'])assert.equal((await h.db.query(`select count(*)::int n from ${table}`)).rows[0].n,1)
 assert.equal((await h.db.query("select count(*)::int n from outbox where job_type='process_drawing_set'")).rows[0].n,1)
 await assert.rejects(h.publish({...h.copy,etag:'different'}),/different evidence/)
})
test('queue persistence failure rolls back every drawing publication record',async t=>{
 const h=await publication(t)
 await h.db.exec(`create function reject_drawing_queue() returns trigger language plpgsql as $$ begin
 if new.job_type='process_drawing_set' then raise exception 'queue unavailable';end if;return new;end $$;
 create trigger reject_drawing_queue before insert on outbox for each row execute function reject_drawing_queue();`)
 await assert.rejects(h.publish(),/queue unavailable/)
 for(const table of ['drawing_sets','drawing_revisions'])assert.equal((await h.db.query(`select count(*)::int n from ${table}`)).rows[0].n,0)
 assert.equal((await h.db.query('select count(*)::int n from files where project_id=$1',[HOME])).rows[0].n,0)
})
test('publication refuses wrong evidence/actor and competing pending work before inserting files',async t=>{
 const h=await publication(t)
 await assert.rejects(h.publish(h.copy,SOURCE),/actor mismatch/)
 await assert.rejects(h.publish({...h.copy,size_bytes:101}),/not reserved/)
 await assert.rejects(h.publish({...h.copy,storage_path:'wrong'}),/not reserved/)
 await h.headers(false);await h.db.query("insert into drawing_revisions(org_id,project_id,status) values($1,$2,'draft')",[ORG,HOME]);await h.headers(true)
 await assert.rejects(h.publish(),/pending review/)
 assert.equal((await h.db.query('select count(*)::int n from files where project_id=$1',[HOME])).rows[0].n,0)
})
test('ownership expiry after queue insertion rolls back the complete publication',async t=>{
 const h=await publication(t)
 await h.db.exec(`create function expire_drawing_publication() returns trigger language plpgsql as $$ begin
 if new.job_type='process_drawing_set' then update outbox set start_job_lease_expires_at=clock_timestamp()-interval '1 second' where job_type='start_release';end if;return new;end $$;
 create trigger expire_drawing_publication after insert on outbox for each row execute function expire_drawing_publication();`)
 await assert.rejects(h.publish(),/worker lease lost/)
 assert.equal((await h.db.query('select count(*)::int n from files where project_id=$1',[HOME])).rows[0].n,0)
 assert.equal((await h.db.query('select count(*)::int n from drawing_revisions')).rows[0].n,0)
 assert.equal((await h.db.query("select count(*)::int n from outbox where job_type='process_drawing_set'")).rows[0].n,0)
})
test('failed processor receipts do not create replacement work and browser execution is denied',async t=>{
 const h=await publication(t),first=await h.publish()
 await h.db.query("update outbox set status='failed' where id=$1",[first.job_id])
 await assert.rejects(h.publish(),/processing failed/)
 await h.db.exec('set role authenticated');await assert.rejects(h.publish(),/permission denied for function publish_plan_drawing_copy/);await h.db.exec('reset role')
 assert.equal((await h.db.query('select count(*)::int n from drawing_revisions')).rows[0].n,1)
})
test('durable drawing reservation reuses destination and advances the shared ledger only for new work',async t=>{
 const h=await publication(t),reserved=await h.reserve();assert.equal(reserved.attempt_id,h.copy.attempt_id);assert.equal(reserved.storage_path,h.copy.storage_path)
 let ledger=(await h.db.query("select metadata->'plan_instantiation' ledger from projects where id=$1",[HOME])).rows[0].ledger
 assert.equal(ledger.seq,1);assert.equal(ledger.drawing_copy_attempt.status,'reserved')
 await h.publish();const recovered=await h.reserve();assert.equal(recovered.status,'published');assert.equal(recovered.attempt_id,reserved.attempt_id)
 ledger=(await h.db.query("select metadata->'plan_instantiation' ledger from projects where id=$1",[HOME])).rows[0].ledger
 assert.equal(ledger.seq,2);assert.equal(ledger.drawing_copy_attempt.receipt.file_id,recovered.receipt.file_id)
 await h.publish();assert.equal((await h.db.query("select metadata->'plan_instantiation'->>'seq' seq from projects where id=$1",[HOME])).rows[0].seq,'2')
})
test('changed source evidence and malformed reservations cannot create another destination',async t=>{
 const h=await publication(t)
 await assert.rejects(h.reserve({size_bytes:100,source_etag:'replacement'}),/differs/)
 await assert.rejects(h.reserve({size_bytes:101,source_etag:'source'}),/differs from file record/)
 await h.db.query("update projects set metadata=jsonb_set(metadata,'{plan_instantiation,drawing_copy_attempt}',(metadata->'plan_instantiation'->'drawing_copy_attempt')-'status') where id=$1",[HOME])
 await assert.rejects(h.reserve(),/differs/);await assert.rejects(h.publish(),/not reserved/)
 assert.equal((await h.db.query('select count(*)::int n from files where project_id=$1',[HOME])).rows[0].n,0)
})
test('publication rollback preserves reservation and other project metadata for a retry',async t=>{
 const h=await publication(t)
 await h.db.query("update projects set metadata=metadata||'{\"unrelated\":\"kept\"}'::jsonb where id=$1",[HOME])
 await h.db.exec(`create function reject_reserved_queue() returns trigger language plpgsql as $$ begin
 if new.job_type='process_drawing_set' then raise exception 'queue unavailable';end if;return new;end $$;
 create trigger reject_reserved_queue before insert on outbox for each row execute function reject_reserved_queue();`)
 await assert.rejects(h.publish(),/queue unavailable/)
 const metadata=(await h.db.query('select metadata from projects where id=$1',[HOME])).rows[0].metadata
 assert.equal(metadata.unrelated,'kept');assert.equal(metadata.plan_instantiation.seq,1);assert.equal(metadata.plan_instantiation.drawing_copy_attempt.status,'reserved')
 await h.db.exec('drop trigger reject_reserved_queue on outbox');await h.publish()
 const next=(await h.db.query('select metadata from projects where id=$1',[HOME])).rows[0].metadata;assert.equal(next.unrelated,'kept');assert.equal(next.plan_instantiation.seq,2)
})
test('reservation sequence fences an old whole-metadata instantiation mark',async t=>{
 const h=await publication(t)
 const result=await h.db.query("update projects set metadata='{}' where id=$1 and metadata->'plan_instantiation'->>'seq' is null returning id",[HOME]);assert.equal(result.rows.length,0)
 await h.db.exec('set role authenticated');await assert.rejects(h.reserve(),/permission denied for function reserve_plan_drawing_copy/)
})
test('a corrupted published manifest is refused instead of manufacturing another publication',async t=>{
 const h=await publication(t);await h.publish()
 await h.db.query("update projects set metadata=jsonb_set(metadata,'{plan_instantiation,drawing_copy_attempt,receipt}','{}') where id=$1",[HOME])
 await assert.rejects(h.reserve(),/receipt requires repair/);await assert.rejects(h.publish(),/manifest is incomplete/)
 assert.equal((await h.db.query('select count(*)::int n from drawing_revisions')).rows[0].n,1)
})
async function fanout(t){
 const h=await publication(t)
 await h.db.exec('create table companies(id uuid primary key,org_id uuid);alter table schedule_assignments add column company_id uuid');await h.db.query('insert into schedule_items(id,org_id,project_id) values($1,$2,$1)',[HOME,ORG]);await h.db.query('insert into schedule_assignments(id,org_id,project_id,schedule_item_id,company_id) values($1,$2,$3,$3,$1)',[OTHER,ORG,HOME]);await h.db.query('insert into companies values($1,$2)',[OTHER,ORG])
 await h.db.exec(fs.readFileSync(require.resolve('../supabase/migrations/20261003037000_starts_worker_outbox_fanout_fences.sql'),'utf8'))
 const notice=async(payload={start_package_id:PKG,actor_id:OTHER,company_id:OTHER})=>h.db.query("insert into outbox(org_id,job_type,payload) values($1,'start_release_trade_notice',$2)",[ORG,payload])
 return {...h,notice}
}
test('fenced release publishes its drawing job and owned vendor notice',async t=>{
 const h=await fanout(t);await h.db.exec('grant all on all tables in schema public to service_role;grant usage on all sequences in schema public to service_role;set role service_role');await h.publish();await h.notice()
 assert.equal((await h.db.query("select count(*)::int n from outbox where job_type in ('process_drawing_set','start_release_trade_notice')")).rows[0].n,2)
 await assert.rejects(h.notice({start_package_id:OTHER,actor_id:OTHER,company_id:OTHER}),/notice scope mismatch/)
 await assert.rejects(h.notice({start_package_id:PKG,actor_id:SOURCE,company_id:OTHER}),/notice scope mismatch/)
 await assert.rejects(h.notice({start_package_id:PKG,actor_id:OTHER,company_id:SOURCE}),/vendor mismatch/)
 await assert.rejects(h.db.query("insert into outbox(org_id,job_type,payload) values($1,'issue_invoice','{}')",[ORG]),/job family/)
})
test('drawing fanout payload must match all persisted file, set and revision ancestry',async t=>{
 const h=await fanout(t),receipt=await h.publish(),job=(await h.db.query('select payload from outbox where id=$1',[receipt.job_id])).rows[0].payload
 for(const [key,value,pattern]of [['projectId',OTHER,/scope mismatch/],['storagePath','wrong',/file mismatch/],['drawingSetId',OTHER,/set mismatch/],['draftRevisionId',OTHER,/revision mismatch/]]){
  await assert.rejects(h.db.query("insert into outbox(org_id,job_type,payload) values($1,'process_drawing_set',$2)",[ORG,{...job,[key]:value}]),pattern)
 }
 await assert.rejects(h.db.query('delete from outbox where id=$1',[receipt.job_id]),/cannot mutate other jobs/)
 await assert.rejects(h.db.query("update outbox set payload='{}' where id=$1",[receipt.job_id]),/cannot mutate other jobs/)
})
test('owned claim heartbeat/completion work after package finalization but payload substitution is denied',async t=>{
 const h=await fanout(t)
 await h.db.query("update start_packages set status='released' where id=$1",[PKG])
 assert.equal((await h.db.query("select transition_starts_job_lease($1,$2,$3,'heartbeat') ok",[ORG,h.job.job_id,h.job.claim_token])).rows[0].ok,true)
 await assert.rejects(h.db.query("update outbox set payload='{}' where id=$1",[h.job.job_id]),/identity or payload/)
 assert.equal((await h.db.query("select transition_starts_job_lease($1,$2,$3,'complete') ok",[ORG,h.job.job_id,h.job.claim_token])).rows[0].ok,true)
 await assert.rejects(h.notice(),/worker lease lost/)
})
test('browser drawing jobs are denied while ordinary server writers preserve behavior',async t=>{
 const h=await fanout(t);await h.headers(false)
 await h.db.exec('grant all on outbox to authenticated;grant usage on sequence outbox_id_seq to authenticated;set role authenticated')
 await assert.rejects(h.db.query("insert into outbox(org_id,job_type,payload) values($1,'process_drawing_set','{}')",[ORG]),/authorized server writers/)
 await h.db.exec('reset role');await h.db.query("insert into outbox(org_id,job_type,payload) values($1,'process_drawing_set','{}')",[ORG])
})
test('an owned-org vendor without a home assignment cannot receive release fanout',async t=>{
 const h=await fanout(t);await h.db.query('insert into companies values($1,$2)',[SOURCE,ORG])
 await assert.rejects(h.notice({start_package_id:PKG,actor_id:OTHER,company_id:SOURCE}),/not assigned to this home/)
 await h.headers(false);await h.db.query('delete from schedule_assignments where company_id=$1',[OTHER]);await h.headers(true)
 await assert.rejects(h.notice(),/not assigned to this home/)
})
test('drawing protections use the real package schema and authoritative lot plan pin',async t=>{
 const h=await setup(t)
 const columns=(await h.db.query("select attname from pg_attribute where attrelid='public.start_packages'::regclass and attnum>0 and not attisdropped")).rows.map(row=>row.attname)
 assert.equal(columns.includes('house_plan_version_id'),false);assert.equal(columns.includes('lot_id'),true)
 await h.db.query('update lots set house_plan_version_id=$1 where id=$2',[OTHER,LOT]);await assert.rejects(h.file(),/plan mismatch/)
 await h.db.query('update lots set house_plan_version_id=null where id=$1',[LOT]);await assert.rejects(h.file(),/pinned plan scope/)
})
test('lot plan lookup rejects reassigned home or community before drawing publication',async t=>{
 const h=await publication(t)
 await h.db.query('update lots set project_id=$1 where id=$2',[OTHER,LOT]);await assert.rejects(h.publish(),/pinned plan scope/)
 await h.db.query('update lots set project_id=$1,community_id=$2 where id=$3',[HOME,OTHER,LOT]);await assert.rejects(h.publish(),/pinned plan scope/)
})
