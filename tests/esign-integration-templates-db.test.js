const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs')
const {PGlite}=require(process.env.ARC_TEST_PGLITE_MODULE||'@electric-sql/pglite')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
test('actual bulk reservation migration creates document and fields once and rolls back invalid templates',async t=>{
 const db=new PGlite();t.after(()=>db.close());await db.exec(fs.readFileSync('tests/fixtures/esign-schema.sql','utf8'))
 await db.exec(`create table public.projects(id uuid primary key,org_id uuid not null);create table public.app_users(id uuid primary key);
 create table public.esign_templates(id uuid primary key,org_id uuid not null,project_id uuid,name text,document_type text,source_file_id uuid,fields jsonb,recipients jsonb,reminder_settings jsonb);`)
 await db.exec(fs.readFileSync('supabase/migrations/20261003010417_esign_template_reservations.sql','utf8'))
 await db.query('insert into public.orgs(id) values($1)',[id(1)]);await db.query('insert into public.app_users(id) values($1)',[id(2)]);await db.query('insert into public.projects(id,org_id) values($1,$2)',[id(3),id(1)])
 await db.query("insert into public.files(id,org_id,file_name,storage_path,mime_type,size_bytes,visibility,category,source) values($1,$2,'template.pdf','template.pdf','application/pdf',10,'private','contracts','upload')",[id(4),id(1)])
 const field={page_index:0,field_type:'signature',signer_role:'buyer',x:.1,y:.2,w:.3,h:.1}
 await db.query("insert into public.esign_templates values($1,$2,$3,'Template','contract',$4,$5,$6,'{}',null)",[id(5),id(1),id(3),id(4),JSON.stringify([field]),JSON.stringify([{role:'signer',signer_role:'buyer'}])])
 const reserve=(email='BUYER@example.test')=>db.query('select public.reserve_esign_bulk_document($1,$2,$3,$4,$5,$6) document',[id(1),id(2),id(5),id(3),id(6),JSON.stringify({email})])
 const first=(await reserve()).rows[0].document,second=(await reserve('buyer@example.test')).rows[0].document
 assert.equal(first.id,second.id);assert.equal(first.status,'draft');assert.equal((await db.query('select signer_role from public.document_fields')).rows[0].signer_role,'signer_1')
 await db.query('update public.esign_templates set fields=$1 where id=$2',[JSON.stringify([field,{...field,signer_role:'builder'}]),id(5)])
 await assert.rejects(reserve('other@example.test'),/one signer role/)
 assert.equal(Number((await db.query('select count(*) n from public.documents')).rows[0].n),1)
 await db.query('update public.esign_templates set archived_at=now() where id=$1',[id(5)])
 assert.equal((await reserve()).rows[0].document.id,first.id)
 await assert.rejects(reserve('new@example.test'),/Active template not found/)
})
