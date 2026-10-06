const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {PGlite}=require('@electric-sql/pglite')
const id=n=>'99700000-0000-4000-8000-'+String(n).padStart(12,'0'),org=id(1),file=id(2),version=id(3)
async function fixture(t){
 const db=new PGlite();t.after(()=>db.close())
 await db.exec(`create role anon; create role authenticated;create role service_role;
 create table files(id uuid primary key,org_id uuid,current_version_id uuid,storage_path text,file_name text,mime_type text,size_bytes bigint,checksum text);
 create table doc_versions(id uuid primary key,org_id uuid,file_id uuid,storage_path text,file_name text,mime_type text,size_bytes bigint,checksum text,label text,notes text);
 create table books_tax_adjustment_workpapers(id uuid primary key default gen_random_uuid(),org_id uuid,lines jsonb,status text default 'draft');`)
 const migrations=path.join(__dirname,'../supabase/migrations')
 await db.exec(fs.readFileSync(path.join(migrations,'20261003175333_books_tax_attachment_evidence.sql'),'utf8'))
 await db.exec(fs.readFileSync(path.join(migrations,'20261003192751_books_tax_attachment_lock_order.sql'),'utf8'))
 await db.query("insert into files values($1,$2,$3,$4,'Original.txt','text/plain',3,repeat('a',64))",[file,org,version,org+'/tax/original.txt'])
 await db.query("insert into doc_versions(id,org_id,file_id,storage_path,file_name,mime_type,size_bytes,checksum) select $1,org_id,id,storage_path,file_name,mime_type,size_bytes,checksum from files where id=$2",[version,file])
 const proof={version:1,org_id:org,file_id:file,document_version_id:version,storage_path:org+'/tax/original.txt',file_name:'Original.txt',mime_type:'text/plain',size_bytes:3,checksum:'a'.repeat(64)}
 const lines=[{evidence_file_id:file,evidence_snapshot:proof}]
 const prepare=value=>db.query('insert into books_tax_adjustment_workpapers(org_id,lines) values($1,$2)',[org,JSON.stringify(value??lines)])
 return {db,proof,lines,prepare}
}
test('actual attachment triggers reject stale preparation and protect original bytes while allowing document advancement',async t=>{
 const {db,proof,lines,prepare}=await fixture(t)
 await assert.rejects(prepare([{evidence_file_id:file,evidence_snapshot:{...proof,size_bytes:4}}]),/metadata changed/)
 await prepare()
 for(const assignment of ["checksum=repeat('b',64)","size_bytes=4"]){await assert.rejects(db.exec(`update files set ${assignment} where id='${file}'`),/original object metadata is immutable/)}
 await assert.rejects(db.query('delete from files where id=$1',[file]),/history cannot be deleted/)
 await assert.rejects(db.query('delete from doc_versions where id=$1',[version]),/version evidence is immutable/)
 await assert.rejects(db.query("update doc_versions set checksum=repeat('b',64) where id=$1",[version]),/version evidence is immutable/)
 await db.query('update doc_versions set label=$1,notes=$2 where id=$3',['Reviewed','Annotations retained',version])
 await db.query("insert into doc_versions(id,org_id,file_id,storage_path,file_name,mime_type,size_bytes,checksum) values($1,$2,$3,$4,'Revised.txt','text/plain',5,repeat('b',64))",[id(4),org,file,org+'/tax/revised.txt'])
 await db.query("update files set current_version_id=$1,storage_path=$2,file_name='Revised.txt',size_bytes=5,checksum=repeat('b',64) where id=$3",[id(4),org+'/tax/revised.txt',file])
 await assert.rejects(prepare(),/metadata changed/)
 assert.deepEqual((await db.query('select lines from books_tax_adjustment_workpapers')).rows[0].lines,lines)
})
test('latest real guard definitions use retryable nonwaiting locks, preserve restricted privileges and execute for unreferenced documents',async t=>{
 const {db}=await fixture(t)
 const functions=(await db.query("select proname,prosrc,prosecdef from pg_proc where proname in('guard_books_tax_attachment_evidence','protect_books_tax_document_evidence')")).rows
 for(const row of functions){assert.match(row.prosrc,/pg_try_advisory_xact_lock/);assert.doesNotMatch(row.prosrc,/\bpg_advisory_xact_lock\s*\(/);assert.match(row.prosrc,/errcode='40001'/)}
 assert.equal(functions.find(row=>row.proname==='protect_books_tax_document_evidence').prosecdef,true)
 const privileges=(await db.query("select has_function_privilege('authenticated','protect_books_tax_document_evidence()','execute') browser,has_function_privilege('anon','protect_books_tax_document_evidence()','execute') anon")).rows[0]
 assert.deepEqual(privileges,{browser:false,anon:false})
 await db.query('delete from doc_versions where id=$1',[version]);await db.query('delete from files where id=$1',[file])
 assert.equal((await db.query('select count(*) count from files')).rows[0].count,0)
 // One PGlite backend executes real SQL but cannot prove cross-session locking.
 // The full-schema pgTAP contract uses a separate dblink session for contention.
})
