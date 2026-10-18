const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { PGlite } = require('@electric-sql/pglite')
const org='00000000-0000-4000-8000-000000000001',user='00000000-0000-4000-8000-000000000002',project='00000000-0000-4000-8000-000000000003',file='00000000-0000-4000-8000-000000000004',id='00000000-0000-4000-8000-000000000005',attempt='00000000-0000-4000-8000-000000000006'
test('transfer and export migrations preserve transactional job ownership and fenced leases',async t=>{
 const db=new PGlite();t.after(()=>db.close())
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create table orgs(id uuid primary key);create table projects(id uuid primary key);create table app_users(id uuid primary key);
 insert into orgs values('${org}');insert into projects values('${project}');insert into app_users values('${user}');
 create table outbox(id bigint generated always as identity,org_id uuid,job_type text,payload jsonb,run_at timestamptz,dedupe_key text unique);
 create function tg_set_updated_at() returns trigger language plpgsql as $$begin new.updated_at=now();return new;end$$;`)
 for(const path of ['supabase/migrations/20261003004921_document_upload_transfers.sql','supabase/migrations/20261003010150_document_exports.sql'])await db.exec(fs.readFileSync(path,'utf8'))
 const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0]
 for(const table of ['document_upload_transfers','document_exports'])for(const role of ['anon','authenticated'])assert.equal((await scalar(`select has_table_privilege($1,$2,'select') allowed`,[role,`public.${table}`])).allowed,false)
 assert.equal((await scalar("select has_function_privilege('authenticated','claim_document_export(uuid,uuid,uuid)','execute') allowed")).allowed,false)
 await db.query(`insert into document_upload_transfers(id,org_id,project_id,created_by,identity,file_name,content_type,file_size,storage_path,mode) values($1,$2,$3,$4,$5,'x.pdf','application/pdf',1,'path','single')`,[id,org,project,user,`sha256-chain-v1:1:${'a'.repeat(64)}`])
 assert.equal((await scalar("select count(*)::int n from outbox where job_type='cleanup_document_transfer'")).n,1)
 await db.query(`insert into document_exports(id,org_id,created_by,file_ids,manifest) values($1,$2,$3,$4,'[]')`,[id,org,user,[file]])
 assert.equal((await scalar("select count(*)::int n from outbox where payload->>'export_id'=$1",[id])).n,2)
 assert.equal((await db.query('select * from claim_document_export($1,$2,$3)',[org,id,attempt])).rows.length,1)
 assert.equal((await scalar("select count(*)::int n from outbox o join document_exports e on o.payload->>'export_id'=e.id::text where o.job_type='cleanup_document_export' and o.run_at>=e.expires_at+interval '15 minutes'")).n,1)
 assert.equal((await db.query('select * from claim_document_export($1,$2,$3)',[org,id,attempt])).rows.length,0)
 await db.query("update document_exports set lease_until=now()-interval '1 minute' where id=$1",[id])
 assert.equal((await db.query('select * from claim_document_export($1,$2,$3)',[org,id,attempt])).rows.length,1)
 await db.query("update document_exports set status='ready' where id=$1",[id])
 assert.equal((await db.query('select * from claim_document_export($1,$2,$3)',[org,id,attempt])).rows.length,0)
 await db.exec(`create function reject_export_job() returns trigger language plpgsql as $$begin if new.job_type='export_documents' then raise exception 'injected';end if;return new;end$$;
 create trigger reject_export_job before insert on outbox for each row execute function reject_export_job();`)
 await assert.rejects(db.query(`insert into document_exports(id,org_id,created_by,file_ids,manifest) values($1,$2,$3,$4,'[]')`,[attempt,org,user,[file]]),/injected/)
 assert.equal((await scalar('select count(*)::int n from document_exports')).n,1)
})
