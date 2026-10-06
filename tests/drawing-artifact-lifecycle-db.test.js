const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const runtime=process.env.ARC_TEST_PGLITE_MODULE || "@electric-sql/pglite"
const org='00000000-0000-0000-0000-000000000001',rev='00000000-0000-0000-0000-000000000002',version='00000000-0000-0000-0000-000000000003'
const project='00000000-0000-0000-0000-000000000010',set='00000000-0000-0000-0000-000000000011',source='00000000-0000-0000-0000-000000000012'
const manifest={Image:{Format:'webp',TileSize:512,Size:{Width:100,Height:200}},Levels:9}
async function fixture(){
 const {PGlite}=require(runtime),db=new PGlite()
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create table orgs(id uuid primary key);
 create table outbox(id bigint generated always as identity primary key,org_id uuid,job_type text,payload jsonb,retry_count integer default 0,status text default 'pending',run_at timestamptz default now(),updated_at timestamptz default now(),created_at timestamptz default now(),priority integer default 0,last_error text);
 create table drawing_revisions(id uuid primary key,org_id uuid,status text default 'processing',processing_stage text,error_message text,project_id uuid,drawing_set_id uuid,source_file_id uuid,total_pages integer default 1,processed_pages integer default 0,created_at timestamptz default now());
 create table drawing_sheets(id uuid primary key default gen_random_uuid(),org_id uuid,sheet_number text,project_id uuid,drawing_set_id uuid,sheet_title text,discipline text,current_revision_id uuid,sort_order integer,share_with_clients boolean,share_with_subs boolean,unique(project_id,sheet_number));
 create table drawing_sheet_versions(id uuid primary key default gen_random_uuid(),org_id uuid,drawing_revision_id uuid,drawing_sheet_id uuid,file_id uuid,page_index integer,created_at timestamptz default now(),extracted_metadata jsonb,tile_manifest jsonb,tile_base_url text,tile_levels integer,thumbnail_url text,image_width integer,image_height integer,tile_manifest_path text,tiles_base_path text,page_text text,unique(drawing_sheet_id,drawing_revision_id));
 create table drawing_deleted_pages(org_id uuid,revision_id uuid,page_index integer,sheet_id uuid,primary key(org_id,revision_id,page_index));
 create table drawing_upload_operations(org_id uuid,revision_id uuid);
 `)
 for(const filename of ['20261001121920_drawing_job_leases.sql','20261001123000_drawing_page_artifacts.sql','20261001162622_drawing_artifact_guards.sql','20261001162632_drawing_split_manifest.sql'])await db.exec(fs.readFileSync(path.resolve(__dirname,'../supabase/migrations',filename),'utf8'))
 const publication=fs.readFileSync(path.resolve(__dirname,'../supabase/migrations/20261001124901_drawing_publication_receipts.sql'),'utf8');await db.exec(publication.slice(publication.indexOf('CREATE FUNCTION public.drawing_revision_manifest_complete'),publication.indexOf('GRANT EXECUTE ON FUNCTION public.drawing_revision_manifest_complete'))+'GRANT EXECUTE ON FUNCTION public.drawing_revision_manifest_complete(uuid,uuid) TO service_role;');
 await db.exec(fs.readFileSync(path.resolve(__dirname,'../supabase/migrations/20261001164202_drawing_split_registration.sql'),'utf8'));
 await db.query('insert into orgs values($1)',[org]);await db.query('insert into drawing_revisions(id,org_id) values($1,$2)',[rev,org]);await db.query('insert into drawing_sheet_versions(id,org_id,drawing_revision_id) values($1,$2,$3)',[version,org,rev])
 await db.query('update drawing_revisions set project_id=$1,drawing_set_id=$2,source_file_id=$3 where id=$4',[project,set,source,rev]);
 await db.query('update drawing_sheet_versions set page_index=0');
 return db
}
const rpc=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0].v
const reserve=(db,v=version,key='fingerprint')=>rpc(db,'select reserve_drawing_artifact($1,$2,$3,$4) as v',[org,v,key,'recipe'])
async function activate(db,a,v=version){await db.query('update drawing_sheet_versions set tile_manifest=$1,tiles_base_path=$2,tile_manifest_path=$3,tile_levels=9,image_width=100,image_height=200 where id=$4',[manifest,a.storage_prefix,a.storage_prefix+'/manifest.json',v]);return rpc(db,'select activate_drawing_artifact($1,$2,$3) as v',[org,a.id,v])}
async function job(db,type,payload={},retry=0){await db.query('insert into outbox(org_id,job_type,payload,retry_count) values($1,$2,$3,$4)',[org,type,payload,retry]);return (await db.query('select * from claim_drawing_jobs($1,1)',[[type]])).rows[0]}
const headers=(db,j)=>db.query("select set_config('request.headers',$1,false)",[JSON.stringify(j?{'x-drawing-job-id':String(j.job_id),'x-drawing-claim-token':j.claim_token}:{})])
test('artifact retry renews a live writer; expired generations never overwrite immutable paths',{},async()=>{const db=await fixture();try{
 const a=await reserve(db),again=await reserve(db);assert.equal(a.id,again.id)
 await db.query("update drawing_artifacts set writer_until=now()-interval '1 second' where id=$1",[a.id]);const fresh=await reserve(db);assert.notEqual(fresh.storage_prefix,a.storage_prefix)
 await assert.rejects(rpc(db,'select activate_drawing_artifact($1,$2,$3) as v',[org,a.id,version]),/writer expired/)
 for(const invalid of [{},{Image:{}},{...manifest,Partial:true},{...manifest,Partial:false}]){await db.query('update drawing_sheet_versions set tile_manifest=$1 where id=$2',[invalid,version]);await assert.rejects(rpc(db,'select activate_drawing_artifact($1,$2,$3) as v',[org,fresh.id,version]),/incomplete/)}
 assert.equal(await activate(db,fresh),true)
 // The producing version may disappear before another upload adopts the output.
 await db.query('delete from drawing_sheet_versions where id=$1',[version]);const next='00000000-0000-0000-0000-000000000004';await db.query('insert into drawing_sheet_versions(id,org_id,drawing_revision_id) values($1,$2,$3)',[next,org,rev]);const adopted=await reserve(db,next);assert.equal(adopted.id,fresh.id);assert.deepEqual(adopted.render_output.tile_manifest,manifest)
 assert.equal((await rpc(db,'select retire_drawing_artifact($1,$2) as v',[org,fresh.id])).retired,false)
 await db.query('delete from drawing_sheet_versions where id=$1',[next]);assert.equal((await rpc(db,'select retire_drawing_artifact($1,$2) as v',[org,fresh.id])).retired,true)
 await db.query('insert into drawing_sheet_versions(id,org_id,drawing_revision_id) values($1,$2,$3)',[next,org,rev]);await assert.rejects(db.query('update drawing_sheet_versions set artifact_id=$1 where id=$2',[fresh.id,next]),/unavailable/)
 }finally{await db.close()}})
test('split intent before PUT survives deletion; fanout is idempotent and rejects conflicting paths',{},async()=>{const db=await fixture();try{
 const s=await rpc(db,'select reserve_drawing_split_page($1,$2,$3,0,$4) as v',[org,rev,'source',version]);const same=await rpc(db,'select reserve_drawing_split_page($1,$2,$3,0,$4) as v',[org,rev,'source',version]);assert.equal(s.id,same.id)
 const payload={draftRevisionId:rev,versionId:version,pageIndex:0,pagePdfPath:s.storage_prefix+'/page.pdf'}
 await assert.rejects(rpc(db,'select emit_drawing_split_page($1,$2,$3) as v',[org,s.id,{...payload,pagePdfPath:'elsewhere'}]),/mismatch/)
 const first=await rpc(db,'select emit_drawing_split_page($1,$2,$3) as v',[org,s.id,payload]);assert.equal(await rpc(db,'select emit_drawing_split_page($1,$2,$3) as v',[org,s.id,payload]),first)
 assert.equal((await db.query('select count(*)::integer n from outbox')).rows[0].n,1)
 assert.equal((await rpc(db,'select retire_drawing_split_page($1,$2) as v',[org,s.id])).retired,false)
 await db.exec('delete from drawing_revisions');const retired=await rpc(db,'select retire_drawing_split_page($1,$2) as v',[org,s.id]);assert.equal(retired.retired,true);assert.equal(retired.storage_prefix,s.storage_prefix)
 await rpc(db,'select complete_drawing_split_deletion($1,$2,$3) as v',[org,s.id,s.id]);assert.equal((await db.query('select * from drawing_storage_cleanup_candidates($1,100)',[org])).rows.length,0)
 await db.exec("update drawing_split_pages set last_cleanup_at=now()-interval '2 hours'");assert.equal((await db.query('select * from drawing_storage_cleanup_candidates($1,100)',[org])).rows[0].id,s.id)
 }finally{await db.close()}})
test('third explicit failure and third lease expiry atomically resolve revision and metadata state',{},async()=>{const db=await fixture();try{
 const critical=await job(db,'process_drawing_page',{draftRevisionId:rev},2);await headers(db,critical)
 assert.equal(await rpc(db,"select transition_drawing_job_lease($1,$2,'retry','render failed') as v",[critical.job_id,critical.claim_token]),true)
 assert.equal((await db.query('select processing_stage from drawing_revisions')).rows[0].processing_stage,'failed')
 await headers(db,null);await db.query('update drawing_sheet_versions set extracted_metadata=$1 where id=$2',[{sheet_detection:{vision_pending:true}},version])
 const metadata=await job(db,'enrich_drawing_metadata',{draftRevisionId:rev,sheetVersionId:version},2)
 await db.query("update outbox set drawing_lease_expires_at=now()-interval '1 second' where id=$1",[metadata.job_id]);await rpc(db,"select recover_drawing_job_leases(array['enrich_drawing_metadata']) as v")
 assert.equal((await db.query('select extracted_metadata from drawing_sheet_versions')).rows[0].extracted_metadata.sheet_detection.vision_pending,false)
 }finally{await db.close()}})
test('late AI cannot overwrite reviewed or published version and sheet identities',{},async()=>{const db=await fixture();try{
 await db.query('insert into drawing_sheets(id,org_id,sheet_number) values($1,$2,$3)',[version,org,'A1']);const ai=await job(db,'enrich_drawing_metadata',{draftRevisionId:rev,sheetVersionId:version})
 await db.query('update drawing_sheet_versions set extracted_metadata=$1 where id=$2',[{identity_reviewed:true,proposed:{sheet_number:'A1'}},version]);await headers(db,ai)
 await db.query('update drawing_sheet_versions set extracted_metadata=$1 where id=$2',[{proposed:{sheet_number:'BAD'}},version]);await db.query("update drawing_sheets set sheet_number='BAD' where id=$1",[version])
 assert.equal((await db.query('select sheet_number from drawing_sheets')).rows[0].sheet_number,'A1')
 assert.equal((await db.query('select extracted_metadata from drawing_sheet_versions')).rows[0].extracted_metadata.identity_reviewed,true)
 await headers(db,null);await db.exec("update drawing_revisions set status='published';update drawing_sheet_versions set extracted_metadata='{}'");await headers(db,ai)
 await db.query('update drawing_sheet_versions set extracted_metadata=$1 where id=$2',[{proposed:{sheet_number:'BAD'}},version]);assert.deepEqual((await db.query('select extracted_metadata from drawing_sheet_versions')).rows[0].extracted_metadata,{})
 }finally{await db.close()}})
const splitPage=(i,number='A1')=>({projectId:project,drawingSetId:set,sourceFileId:source,sourceHash:'source',pageIndex:i,pageText:'full text',tentativeSheetNumber:number,metadata:{source_hash:'source',page_index:i,proposed:{sheet_number:number,sheet_title:'PLAN',discipline:'A'},sheet_detection:{vision_pending:true}}})
test('transactional batches preserve sheet collisions, carry calibration, and replay identical page receipts',async()=>{const db=await fixture();try{
 await db.exec('delete from drawing_sheet_versions');await db.query('update drawing_revisions set total_pages=2 where id=$1',[rev])
 const sheet='00000000-0000-0000-0000-000000000015',old='00000000-0000-0000-0000-000000000016'
 await db.query('insert into drawing_sheets(id,org_id,project_id,sheet_number) values($1,$2,$3,$4)',[sheet,org,project,'A1'])
 await db.query('insert into drawing_sheet_versions(id,org_id,drawing_sheet_id,extracted_metadata) values($1,$2,$3,$4)',[old,org,sheet,{calibration:{feet_per_image_px:0.25}}])
 const pages=[splitPage(0),splitPage(1)],call=()=>rpc(db,'select register_drawing_split_batch($1,$2,$3) as v',[org,rev,pages])
 const first=await call();assert.equal(first.length,2);assert.notEqual(first[0].sheetId,first[1].sheetId)
 assert.deepEqual((await db.query('select sheet_number from drawing_sheets order by sheet_number')).rows.map(x=>x.sheet_number),['A1','A1-P2'])
 const metadata=(await db.query('select extracted_metadata from drawing_sheet_versions where id=$1',[first[0].versionId])).rows[0].extracted_metadata
 assert.equal(metadata.calibration.feet_per_image_px,0.25);assert.equal(metadata.calibration.carried_from_version_id,old);assert.equal(metadata.is_new_sheet,false)
 assert.deepEqual((await call()).map(x=>x.versionId),first.map(x=>x.versionId))
 await assert.rejects(rpc(db,'select register_drawing_split_batch($1,$2,$3) as v',[org,rev,Array(9).fill(splitPage(2))]),/batch size/)
 await assert.rejects(rpc(db,'select register_drawing_split_batch($1,$2,$3) as v',[org,rev,[{...splitPage(2),projectId:org}]]),/source mismatch/)
 }finally{await db.close()}})
test('deleted middle page allows review readiness with two surviving complete pages; malformed tiles never count',async()=>{const db=await fixture();try{
 await db.query('update drawing_revisions set total_pages=3 where id=$1',[rev]);await db.query('update drawing_sheet_versions set tile_manifest=$1 where id=$2',[manifest,version]);await db.query('insert into drawing_sheet_versions(org_id,drawing_revision_id,page_index,tile_manifest) values($1,$2,2,$3)',[org,rev,manifest]);await db.query('insert into drawing_deleted_pages(org_id,revision_id,page_index) values($1,$2,1)',[org,rev])
 const progress=()=>rpc(db,'select update_drawing_render_progress($1,$2) as v',[org,rev])
 const ready=await progress();assert.equal(ready.ready,true);assert.equal(ready.rendered_pages,2);assert.equal(ready.deleted_pages,1);assert.equal((await db.query('select status from drawing_revisions')).rows[0].status,'draft')
 await db.query("update drawing_sheet_versions set tile_manifest='{}' where id=$1",[version]);assert.equal((await progress()).rendered_pages,1);assert.equal((await progress()).ready,false)
 const first=await rpc(db,'select mark_drawing_first_viewable($1,$2) as v',[org,rev]);assert.ok(first);assert.equal(await rpc(db,'select mark_drawing_first_viewable($1,$2) as v',[org,rev]),null)
 }finally{await db.close()}})
test('cross-organization artifact references and expired worker writers are rejected',async()=>{const db=await fixture();try{
 const a=await reserve(db);await activate(db,a)
 const other='00000000-0000-0000-0000-000000000099',v='00000000-0000-0000-0000-000000000098'
 await db.query('insert into orgs values($1)',[other]);await db.query('insert into drawing_sheet_versions(id,org_id) values($1,$2)',[v,other]);await assert.rejects(db.query('update drawing_sheet_versions set artifact_id=$1 where id=$2',[a.id,v]),/unavailable|foreign key/)
 const claimed=await job(db,'process_drawing_page',{draftRevisionId:rev});await headers(db,claimed);const building=await reserve(db,version,'other-fingerprint')
 await headers(db,null);await db.query("update outbox set drawing_lease_expires_at=now()-interval '1 second' where id=$1",[claimed.job_id]);await headers(db,claimed)
 await assert.rejects(rpc(db,'select renew_drawing_artifact_writer($1,$2,$3) as v',[org,building.id,version]),/lease lost/)
 }finally{await db.close()}})
test('manual retry resets failed emitted page job and fences its old owner without duplicating page work',async()=>{const db=await fixture();try{
 const s=await rpc(db,'select reserve_drawing_split_page($1,$2,$3,0,$4) as v',[org,rev,'source',version]);const payload={orgId:org,draftRevisionId:rev,versionId:version,pageIndex:0,pagePdfPath:s.storage_prefix+'/page.pdf'}
 const id=await rpc(db,'select emit_drawing_split_page($1,$2,$3) as v',[org,s.id,payload]);const claim=(await db.query("select * from claim_drawing_jobs(array['process_drawing_page'],1)")).rows[0]
 await db.query("update outbox set status='failed',retry_count=3 where id=$1",[id]);assert.equal((await rpc(db,'select retire_drawing_split_page($1,$2) as v',[org,s.id])).retired,false)
 await rpc(db,'select retry_drawing_revision_pipeline($1,$2) as v',[org,rev]);const row=(await db.query('select * from outbox where id=$1',[id])).rows[0];assert.equal(row.status,'pending');assert.equal(row.retry_count,0);assert.equal(row.drawing_claim_token,null)
 assert.equal(await rpc(db,"select transition_drawing_job_lease($1,$2,'complete') as v",[id,claim.claim_token]),false)
 assert.equal((await db.query("select count(*)::integer n from outbox where job_type='process_drawing_page'")).rows[0].n,1)
 assert.equal((await rpc(db,'select reserve_drawing_split_page($1,$2,$3,0,$4) as v',[org,rev,'source',version])).state,'emitted')
 }finally{await db.close()}})
test('single-sheet retry retains targeted coordinator intent and never requeues completed valid pages',async()=>{const db=await fixture();try{
 await db.query('insert into outbox(org_id,job_type,status,payload) values($1,$2,$3,$4)',[org,'process_drawing_set','failed',{draftRevisionId:rev,targetSheetId:version}]);await db.query('update drawing_sheet_versions set tile_manifest=$1 where id=$2',[manifest,version])
 await db.query('insert into outbox(org_id,job_type,status,payload) values($1,$2,$3,$4)',[org,'process_drawing_page','completed',{draftRevisionId:rev,versionId:version,pageIndex:0}]);await rpc(db,'select retry_drawing_revision_pipeline($1,$2) as v',[org,rev])
 const jobs=(await db.query('select * from outbox order by id')).rows;assert.equal(jobs.at(-1).payload.targetSheetId,version);assert.equal(jobs.find(j=>j.job_type==='process_drawing_page').status,'completed')
 }finally{await db.close()}})
