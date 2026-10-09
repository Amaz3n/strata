const { migrationSql } = require("../support/migration-sql")
require('../../scripts/register-ts-node-test')
const {PGlite}=require('@electric-sql/pglite')
const {EXPORT_TABLES}=require('../../lib/services/books/export-contract')
const {fixture,id,org}=require('./books-payroll-register-fixture')
const migration=migrationSql("20261003203019_books_payroll_import_drafts")
const liabilityMigration=migrationSql("20261003214553_books_payroll_liability_history")
const workflowMigration=migrationSql("20261003220020_books_payroll_workflow_evidence")
const paymentMigration=migrationSql("20261003223805_books_payroll_payment_reviews")
const postingMigration=migrationSql("20261003231822_books_payroll_posting_verification")
const proposalMigration=migrationSql("20261003233012_books_payroll_posting_proposals")
const fenceMigration=migrationSql("20261003235436_books_period_and_payroll_fences")
async function database(t,options={}){
 const db=new PGlite();t.after(()=>db.close())
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create table orgs(id uuid primary key);create table app_users(id uuid primary key);
 create table memberships(org_id uuid,user_id uuid,status text);
 create table files(id uuid primary key,org_id uuid,current_version_id uuid,storage_path text,file_name text,mime_type text,size_bytes bigint,checksum text);
 create table doc_versions(id uuid primary key,org_id uuid,file_id uuid,storage_path text,file_name text,mime_type text,size_bytes bigint,checksum text,label text,notes text);
 create table job_cost_entries(id uuid primary key,org_id uuid,project_id uuid,status text,source_type text,source_id text,incurred_on date,cost_cents bigint,updated_at timestamptz,metadata jsonb);
 create table accounting_facts(id uuid primary key,org_id uuid,source_type text,source_id uuid,payload jsonb,accounting_date date);
 create table journal_entries(id uuid primary key,org_id uuid,fact_id uuid,status text,source_type text,source_id uuid,entry_date date,period_id uuid,entry_kind text);
 create table books_projection_receipts(id uuid primary key,org_id uuid,source_type text,source_id uuid,fact_id uuid,journal_id uuid,source_observed_at timestamptz);`)
 const existing=new Set(['files','doc_versions','job_cost_entries','accounting_facts','journal_entries','books_projection_receipts','books_payroll_imports','books_payroll_payment_reviews','books_payroll_posting_proposals'])
 for(const name of EXPORT_TABLES)if(!existing.has(name))await db.exec(`create table public.${name}(id uuid primary key,org_id uuid)`)
 await db.exec("alter table time_entries add worker_user_id uuid,add work_date date;alter table gl_accounts add code text;alter table accounting_periods add period_start date,add period_end date,add status text default 'open',add fiscal_year integer,add fiscal_period integer;")
 await db.exec(migration)
 await db.exec(liabilityMigration)
 if(options.workflow!==false)await db.exec(workflowMigration)
 if(options.workflow!==false)await db.exec(paymentMigration)
 if(options.workflow!==false)await db.exec(postingMigration)
 if(options.workflow!==false)await db.exec(proposalMigration)
 if(options.workflow!==false)await db.exec(fenceMigration)
 const atomicSql=migrationSql("20261004031113_books_payroll_correction_atomic_posting")
 const captureStart=atomicSql.indexOf("create or replace function public.capture_books_export_snapshot"),captureEnd=atomicSql.indexOf("\n$$;",captureStart)+"\n$$;".length
 if(options.workflow!==false){await db.exec(atomicSql.slice(captureStart,captureEnd));await require('../fixtures/books-export-snapshot-database').installBooksExportSnapshot(db)}
 await db.query('insert into orgs values($1),($2)',[org,id(99)])
 for(const user of [id(2),id(50),id(51),id(52)])await db.query('insert into app_users values($1)',[user])
 await db.query("insert into memberships values($1,$2,'active'),($1,$3,'active'),($1,$4,'active'),($5,$6,'active')",[org,id(2),id(50),id(51),id(99),id(52)])
 for(const account of fixture().postingAccounts)await db.query('insert into gl_accounts(id,org_id,code) values($1,$2,$3)',[account.id,org,account.code])
 for(const [name,key] of [['projects',id(4)],['cost_codes',id(5)]])await db.query(`insert into ${name} values($1,$2)`,[key,org])
 const proof=fixture().sourceProof
 await db.query('insert into files values($1,$2,$3,$4,$5,$6,$7,$8)',[proof.file_id,org,proof.document_version_id,proof.storage_path,proof.file_name,proof.mime_type,proof.size_bytes,proof.checksum])
 await db.query('insert into doc_versions(id,org_id,file_id,storage_path,file_name,mime_type,size_bytes,checksum) values($1,$2,$3,$4,$5,$6,$7,$8)',[proof.document_version_id,org,proof.file_id,proof.storage_path,proof.file_name,proof.mime_type,proof.size_bytes,proof.checksum])
 const evidence=fixture().evidence
 evidence.source_revision=(await db.query('select books_payroll_source_revision(capture_books_export_snapshot($1),$2::jsonb) revision',[org,JSON.stringify(evidence.run)])).rows[0].revision
 return {db,evidence}
}
const prepare=(db,evidence,key='payroll-retry-one',actor=id(50))=>db.query('select prepare_books_payroll_import($1,$2,$3::jsonb,$4,$5) id',[org,actor,JSON.stringify(evidence),'Reviewed payroll register and project allocations',key])
const review=(db,evidence,actor=id(51),notes='Independent review of original payroll register')=>db.query('select review_books_payroll_import($1,$2,$3,$4::jsonb,$5) id',[org,evidence.run.id,actor,JSON.stringify(evidence),notes])
const withdraw=(db,runId=id(6))=>db.query('select withdraw_books_payroll_import($1,$2,$3,$4)',[org,runId,id(50),'Draft superseded by corrected provider evidence'])
module.exports={database,prepare,review,withdraw}
