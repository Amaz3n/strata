const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { PGlite } = require('@electric-sql/pglite')
const org='20000000-0000-0000-0000-000000000001', actor='10000000-0000-0000-0000-000000000001', project='30000000-0000-0000-0000-000000000001'

test('document commits, version deletion and share admission preserve integrity', async t => {
 const db=new PGlite();t.after(()=>db.close())
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create table orgs(id uuid primary key);create table projects(id uuid primary key,org_id uuid);
 insert into orgs values('${org}');insert into projects values('${project}','${org}');`)
 const baseline=fs.readFileSync('supabase/migrations/20260517092101_remote_schema.sql','utf8')
 for(const table of ['files','doc_versions','project_file_folders','project_file_folder_permissions','file_share_links']){
   const start=baseline.indexOf(`CREATE TABLE IF NOT EXISTS "public"."${table}" (`)
   await db.exec(baseline.slice(start,baseline.indexOf('\n);',start)+3))
   await db.exec(`alter table ${table} add primary key(id)`)
 }
 await db.exec(`alter table doc_versions add unique(file_id,version_number);
 alter table project_file_folders add unique(org_id,project_id,path);
 alter table files add foreign key(current_version_id) references doc_versions(id);
 create table outbox(id bigint generated always as identity,org_id uuid,job_type text,payload jsonb,run_at timestamptz,dedupe_key text unique);
 create table audit_log(org_id uuid,actor_user_id uuid,action text,entity_type text,entity_id uuid,after_data jsonb);
 create table events(org_id uuid,event_type text,entity_type text,entity_id uuid,payload jsonb);`)
 await db.exec(fs.readFileSync('supabase/migrations/20261003004606_documents_integrity.sql','utf8'))
 await db.exec(`create table document_upload_transfers(id uuid primary key,org_id uuid,storage_path text,expires_at timestamptz,cancelled_at timestamptz);`)
 const one=async(sql,args=[]) => (await db.query(sql,args)).rows[0]
 const upload=async(path,name='Drawing.pdf') => (await one('select commit_document_upload($1,$2,$3) value',[org,actor,{project_id:project,file_name:name,storage_path:`${org}/${path}`,mime_type:'application/pdf',size_bytes:5,folder_path:'/A_B'}])).value
 await t.test('commit functions and receipts remain inaccessible to client roles',async()=>{
   for(const role of ['anon','authenticated']) {
     assert.equal((await one("select has_function_privilege($1,'public.commit_document_upload(uuid,uuid,jsonb)','execute') allowed",[role])).allowed,false)
     assert.equal((await one("select has_table_privilege($1,'public.document_upload_commits','select') allowed",[role])).allowed,false)
     assert.equal((await one("select has_function_privilege($1,'public.patch_document_artifact(uuid,uuid,text,text,jsonb,text)','execute') allowed",[role])).allowed,false)
   }
 })
 let file
 await t.test('same storage operation returns one file, initial version and event',async()=>{
   file=await upload('first');assert.equal((await upload('first')).id,file.id)
   assert.equal((await one('select count(*)::int n from files')).n,1)
   assert.equal((await one('select count(*)::int n from doc_versions')).n,1)
   assert.equal((await one('select count(*)::int n from events')).n,1)
 })
 await t.test('initial version failure rolls back file insert',async()=>{
   await db.exec(`create function reject_version() returns trigger language plpgsql as $$begin raise exception 'injected';end$$;create trigger reject_version before insert on doc_versions for each row execute function reject_version();`)
   await assert.rejects(upload('failed'),/injected/)
   assert.equal((await one('select count(*)::int n from files')).n,1)
   await db.exec('drop trigger reject_version on doc_versions')
 })
 let version
 await t.test('version retry does not re-promote an older version',async()=>{
   const commit=async(path)=>(await one('select commit_document_version($1,$2,$3,$4) value',[org,file.id,actor,{storage_path:`${org}/${path}`,file_name:path,size_bytes:8}])).value
   version=await commit('second');const current=await commit('third');const retry=await commit('second')
   assert.equal(retry.id,version.id);assert.equal(retry.is_current,false)
   assert.equal((await upload('first')).id,file.id)
   assert.equal((await one('select count(*)::int n from files')).n,1)
   assert.equal((await one('select current_version_id from files where id=$1',[file.id])).current_version_id,current.id)
   await assert.rejects(db.query('select delete_document_version($1,$2)',[org,current.id]),/current version/)
 })
 await t.test('metadata deletion durably queues cleanup; promote cannot restore deleted version',async()=>{
   await db.query('select delete_document_version($1,$2)',[org,version.id])
   assert.equal((await one("select count(*)::int n from outbox where job_type='delete_file_blob'")).n,1)
   await assert.rejects(db.query('select promote_document_version($1,$2,$3)',[org,file.id,version.id]),/not found/)
   await db.exec("delete from outbox where job_type='delete_file_blob'")
   assert.equal((await upload('second')).id,file.id) // The immutable receipt returns its original owner; it never creates another file.
   await assert.rejects(db.query('select commit_document_version($1,$2,$3,$4)',[org,file.id,actor,{storage_path:version.storage_path,file_name:'retry.pdf'}]),/deleted/)
 })
 await t.test('literal subtree rename leaves wildcard-like siblings untouched',async()=>{
   const sibling=await upload('sibling');await db.query("update files set folder_path='/AxB/child' where id=$1",[sibling.id])
   await db.query("update files set folder_path='/A_B/child' where id=$1",[file.id])
   await db.query("select rename_project_file_folder_paths($1,$2,'/A_B','/Renamed',$3)",[org,project,actor])
   assert.equal((await one('select folder_path from files where id=$1',[file.id])).folder_path,'/Renamed/child')
   assert.equal((await one('select folder_path from files where id=$1',[sibling.id])).folder_path,'/AxB/child')
 })
 await t.test('a reserved version object cannot be rebound to a different file',async()=>{
   const other=await upload('different-owner')
   await assert.rejects(db.query('select commit_document_version($1,$2,$3,$4)',[org,other.id,actor,{storage_path:version.storage_path,file_name:'borrowed.pdf'}]),/another file/)
 })
 await t.test('artifact updates merge independent kinds and ignore superseded source paths',async()=>{
   const current=await one('select storage_path from files where id=$1',[file.id])
   const patch=(kind,path,value)=>db.query('select patch_document_artifact($1,$2,$3,$4,$5) value',[org,file.id,path,kind,value])
   await Promise.all([patch('preview',current.storage_path,{status:'ready'}),patch('search',current.storage_path,{extracted_text:'current'})])
   let row=await one('select metadata from files where id=$1',[file.id])
   assert.equal(row.metadata.preview.status,'ready');assert.equal(row.metadata.search.extracted_text,'current')
   assert.equal((await patch('preview','stale',{status:'failed'})).rows[0].value,false)
   row=await one('select metadata from files where id=$1',[file.id]);assert.equal(row.metadata.preview.status,'ready')
 })
 await t.test('expired orphan transfers are fenced while committed transfers remain recoverable',async()=>{
   const orphan='60000000-0000-0000-0000-000000000001',committed='60000000-0000-0000-0000-000000000002'
   await db.query("insert into document_upload_transfers(id,org_id,storage_path,expires_at) values($1,$2,$3,now()-interval '1 minute'),($4,$2,$5,now()-interval '1 minute')",[orphan,org,`${org}/abandoned`,committed,`${org}/first`])
   assert.equal((await one('select expire_document_transfer($1,$2) removable',[org,committed])).removable,false)
   assert.equal((await one('select expire_document_transfer($1,$2) removable',[org,orphan])).removable,true)
   await assert.rejects(upload('abandoned'),/deleted/)
   assert.ok((await one('select cancelled_at from document_upload_transfers where id=$1',[orphan])).cancelled_at)
   assert.equal((await one("select count(*)::int n from outbox where job_type='cleanup_document_transfer'")).n,1)
 })
 await t.test('last admitted share visit can download; second visit cannot; revocation wins',async()=>{
   await db.query("insert into file_share_links(org_id,file_id,token,max_uses) values($1,$2,'test-token',1)",[org,file.id])
   const claim=(await one("select claim_file_share_visit('test-token') value")).value
   assert.ok(claim.visit_id)
   assert.equal((await one("select claim_file_share_visit('test-token') value")).value,null)
   assert.equal((await one("select claim_file_share_visit('test-token',$1) value",[claim.visit_id])).value.visit_id,claim.visit_id)
   await db.exec("update file_share_links set revoked_at=now()")
   assert.equal((await one("select claim_file_share_visit('test-token',$1) value",[claim.visit_id])).value,null)
 })
})
