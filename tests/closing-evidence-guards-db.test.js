require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {PGlite}=require('@electric-sql/pglite')
const ORG='00000000-0000-4000-8000-000000000001',HOME='00000000-0000-4000-8000-000000000002',CLOSING='00000000-0000-4000-8000-000000000003',ACTOR='00000000-0000-4000-8000-000000000004',FILE='00000000-0000-4000-8000-000000000005'
async function fixture(t){
 const db=new PGlite();t.after(()=>db.close())
 await db.exec(`create table closings(id uuid primary key,org_id uuid,project_id uuid,lot_id uuid,community_id uuid,status text,scheduled_date date,actual_date date,settlement jsonb,closing_invoice_id uuid,cancel_reason text,metadata jsonb,notes text);
 create table closing_checklist_items(id uuid primary key,org_id uuid,closing_id uuid,title text,status text,is_gate boolean,notes text,file_id uuid,completed_at timestamptz,completed_by uuid);
 create table files(id uuid primary key,org_id uuid,project_id uuid,archived_at timestamptz);
 create table invoices(id uuid primary key,org_id uuid,project_id uuid,total_cents bigint);`)
 await db.query("insert into closings(id,org_id,project_id,status,scheduled_date,settlement,closing_invoice_id,metadata) values($1,$2,$3,'cleared_to_close','2026-10-03','{}',$4,'{}')",[CLOSING,ORG,HOME,FILE])
 await db.query('insert into invoices values($1,$2,$3,100000)',[FILE,ORG,HOME]);await db.query('insert into files values($1,$2,$3,null)',[FILE,ORG,HOME])
 await db.query("insert into closing_checklist_items values($1,$2,$3,'Occupancy','complete',true,null,$4,now(),$5)",[ACTOR,ORG,CLOSING,FILE,ACTOR])
 await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261003050000_closing_evidence_guards.sql'),'utf8'))
 await db.exec("alter table closing_checklist_items add constraint checklist_parent_fk foreign key(closing_id) references closings(id) on delete cascade")
 const close=()=>db.exec("update closings set status='closed',actual_date='2026-10-03',settlement='{\"finalPriceCents\":100000}'")
 return {db,close}
}
test('closed settlement core cannot change or disappear but completion metadata remains writable',async t=>{
 const h=await fixture(t);await h.close()
 for(const set of ["status='scheduled'","actual_date='2026-10-04'","settlement='{}'","closing_invoice_id=null","metadata='{\"adjustments\":[]}'"])
  await assert.rejects(h.db.exec(`update closings set ${set}`),/settlement evidence is immutable/)
 await assert.rejects(h.db.exec('delete from closings'),/cannot be deleted/)
 await h.db.exec("update closings set metadata='{\"settlement_statement_file_id\":\"file\"}',notes='Recovery note'")
 assert.equal((await h.db.query('select status from closings')).rows[0].status,'closed')
})
test('closed or cancelled checklist insert/update/delete and identity moves are rejected',async t=>{
 const h=await fixture(t)
 await assert.rejects(h.db.query('update closing_checklist_items set closing_id=$1',[FILE]),/identity cannot change/)
 await h.close()
 for(const sql of ["update closing_checklist_items set status='open'","delete from closing_checklist_items","insert into closing_checklist_items select gen_random_uuid(),org_id,closing_id,title,status,is_gate,notes,file_id,completed_at,completed_by from closing_checklist_items"])
  await assert.rejects(h.db.exec(sql),/checklist evidence is immutable/)
 const cancelled=await fixture(t);await cancelled.db.exec("update closings set status='cancelled',cancel_reason='Buyer cancelled'")
 await assert.rejects(cancelled.db.exec("update closing_checklist_items set status='open'"),/checklist evidence is immutable/)
})
test('completion attribution, waiver reasons and actual home files are enforced at write boundary',async t=>{
 const h=await fixture(t)
 await assert.rejects(h.db.exec('update closing_checklist_items set completed_by=null'),/attribution/)
 await assert.rejects(h.db.exec("update closing_checklist_items set status='waived',notes='ok'"),/waiver reason/)
 await h.db.query('update files set project_id=$1',[ACTOR])
 await assert.rejects(h.db.exec("update closing_checklist_items set notes='Reviewed'"),/belongs to another home/)
 await h.db.query('update files set project_id=$1',[HOME]);await h.db.exec("update closing_checklist_items set status='waived',notes='Documented approved exception'")
 await h.close()
})
test('final transition checks current gates and invoice home scope',async t=>{
 const h=await fixture(t);await h.db.exec("update closing_checklist_items set status='open'")
 await assert.rejects(h.close(),/gate evidence is incomplete/)
 await h.db.exec("update closing_checklist_items set status='complete'")
 await h.db.query('update invoices set project_id=$1',[ACTOR]);await assert.rejects(h.close(),/invoice belongs to another home/)
 await h.db.query('update invoices set project_id=$1',[HOME]);await h.db.exec('delete from closing_checklist_items');await assert.rejects(h.close(),/gates are missing/)
})
test('a failed close rolls back earlier checklist evidence in the transaction',async t=>{
 const h=await fixture(t);await h.db.exec('begin');await h.db.exec("update closing_checklist_items set status='open'")
 await assert.rejects(h.close(),/gate evidence is incomplete/);await h.db.exec('rollback')
 assert.equal((await h.db.query('select status from closing_checklist_items')).rows[0].status,'complete')
 await h.close()
})

test('recorded file/invoice source identity and invoice total remain intact',async t=>{
 const h=await fixture(t);await h.close()
 await assert.rejects(h.db.exec('delete from files'),/source cannot be deleted/)
 await assert.rejects(h.db.exec('update files set archived_at=now()'),/cannot be archived/)
 await assert.rejects(h.db.query('update files set project_id=$1',[ACTOR]),/home cannot change/)
 await assert.rejects(h.db.exec('update invoices set total_cents=200000'),/amount cannot change/)
 await assert.rejects(h.db.query('update invoices set org_id=$1',[ACTOR]),/home cannot change/)
 await assert.rejects(h.db.exec('delete from invoices'),/source cannot be deleted/)
})

test('final invoice amount must match valid safe integer settlement cents',async t=>{
 const h=await fixture(t)
 for(const settlement of ['{}','{"finalPriceCents":100001}','{"finalPriceCents":1.5}','{"finalPriceCents":9007199254740992}']) {
  await assert.rejects(h.db.query("update closings set status='closed',actual_date='2026-10-03',settlement=$1::jsonb",[settlement]))
  assert.equal((await h.db.query('select status from closings')).rows[0].status,'cleared_to_close')
 }
 await h.close()
})

test('unfinished parent deletion retains valid foreign-key cascade behavior',async t=>{
 const h=await fixture(t);await h.db.exec('delete from closings')
 assert.equal((await h.db.query('select count(*)::int n from closing_checklist_items')).rows[0].n,0)
})
