// Executes the actual migration in an isolated PostgreSQL engine. No local or remote database changes.
const assert=require("node:assert/strict")
const test=require("node:test")
const fs=require("node:fs")
const path=require("node:path")
let PGlite
try { ({PGlite}=require(process.env.ARC_TEST_PGLITE_MODULE || "@electric-sql/pglite")) } catch {}
const org="20000000-0000-0000-0000-000000000001",pkg="30000000-0000-0000-0000-000000000001",invite="40000000-0000-0000-0000-000000000001",scope="50000000-0000-0000-0000-000000000001"
test("bid pricing snapshots, revision locks, stale offers, and reviewed awards",{skip:!PGlite},async t=>{
 const db=new PGlite();t.after(()=>db.close())
 await db.exec(fs.readFileSync(path.join(__dirname,"fixtures/bid-pricing-schema.sql"),"utf8"))
 await db.exec(fs.readFileSync(path.join(__dirname,"../supabase/migrations/20260921121014_bid_pricing_decisions_and_scope_revisions.sql"),"utf8"))
 await db.query("insert into bid_packages(id,org_id,status,scope) values($1,$2,'draft','Concrete scope')",[pkg,org])
 await db.query("insert into bid_scope_items(id,org_id,bid_package_id,item_type,description) values($1,$2,$3,'base','Concrete')",[scope,org,pkg])
 await db.query("insert into bid_invites(id,org_id,bid_package_id,status) values($1,$2,$3,'sent')",[invite,org,pkg])
 await db.query("update bid_packages set status='open' where id=$1",[pkg])
 const submit=async(revision)=> (await db.query("select create_bid_submission_version($1,$2,$3) result",[org,invite,{total_cents:100000,scope_revision:revision}])).rows[0].result.submission_id
 const first=await submit(1)
 const decision={vendor_total_cents:100000,normalized_total_cents:120000,accepted_alternate_ids:[],gaps:[{description:"Pumping",amount_cents:20000,owner:"GC",disposition:"allowance"}],rationale:"Confirmed scope",snapshot:{}}
 const select=async(id)=> (await db.query("select save_bid_pricing_decision($1,$2,null,$3) result",[org,id,decision])).rows[0].result
 await t.test("issued scope is immutable and selected cost preserves complete scope",async()=>{
  await assert.rejects(db.query("update bid_scope_items set description='Changed' where id=$1",[scope]),/immutable/)
  await assert.rejects(db.query("update bid_packages set scope='Changed' where id=$1",[pkg]),/revision/)
  await select(first)
  const row=(await db.query("select * from bid_pricing_decisions where superseded_at is null")).rows[0]
  assert.equal(row.vendor_total_cents,100000);assert.equal(row.normalized_total_cents,120000)
  assert.equal(row.snapshot.scope[0].description,"Concrete")
 })
 await t.test("revision snapshots scope, retires selection, rejects old browser and old quote",async()=>{
  await db.query("select begin_bid_scope_revision($1,$2,'Revised slab')",[org,pkg])
  assert.equal((await db.query("select count(*)::int n from bid_pricing_decisions where superseded_at is null")).rows[0].n,0)
  await db.query("update bid_scope_items set description='Revised slab' where id=$1",[scope])
  await assert.rejects(submit(2),/not open/)
  await db.query("update bid_packages set status='open' where id=$1",[pkg])
  await assert.rejects(submit(1),/scope changed/)
  await assert.rejects(select(first),/no longer eligible/)
  assert.equal((await db.query("select snapshot->'scope'->0->>'description' description from bid_scope_revisions")).rows[0].description,"Concrete")
 })
 const second=await submit(2)
 await t.test("withdrawal retires pricing and cannot be awarded",async()=>{
  await select(second)
  await db.query("update bid_submissions set status='withdrawn' where id=$1",[second])
  assert.equal((await db.query("select count(*)::int n from bid_pricing_decisions where superseded_at is null")).rows[0].n,0)
  await assert.rejects(db.query("select run_reviewed_bid_award($1,$2,null,null,'{}','Scope','Terms')",[org,second]),/refreshed/)
  assert.equal((await db.query("select count(*)::int n from commitments")).rows[0].n,0)
 })
 const third=await submit(2)
 await t.test("new addendum requires a fresh quote and acknowledgement",async()=>{
  await select(third)
  await db.query("insert into bid_addenda(org_id,bid_package_id,number) values($1,$2,1)",[org,pkg])
  await assert.rejects(select(third),/no longer eligible/)
  const revised=await submit(3)
  await assert.rejects(db.query("select run_reviewed_bid_award($1,$2,null,null,'{}','Scope','Terms')",[org,revised]),/acknowledge/)
  await db.query("insert into bid_addendum_acknowledgements select id,$1 from bid_addenda",[invite])
  await assert.rejects(db.query("select run_reviewed_bid_award($1,$2,null,null,'{}','','Terms')",[org,revised]),/Review scope/)
  await db.query("insert into projects(id,phase) values($1,'precon')",[scope])
  await db.query("update bid_packages set project_id=$1 where id=$2",[scope,pkg])
  await assert.rejects(db.query("select run_reviewed_bid_award($1,$2,null,null,'{}','Scope','Terms')",[org,revised]),/signed owner contract/)
  await db.query("insert into contracts(id,org_id,status) values($1,$2,'active')",[scope,org])
  await db.query("insert into project_precon_handoffs values($1,$2,$3,'awarded')",[org,scope,scope])
  const result=(await db.query("select run_reviewed_bid_award($1,$2,null,null,'{}','Agreed slab and pumping','Net 30; 5% retainage') result",[org,revised])).rows[0].result
  const commitment=(await db.query("select * from commitments where id=$1",[result.commitment_id])).rows[0]
  assert.equal(commitment.scope,"Agreed slab and pumping");assert.equal(commitment.terms,"Net 30; 5% retainage");assert.equal(commitment.metadata.subcontract_review_required,false)
 })
 await t.test("clients cannot write decisions or invoke privileged award RPC",async()=>{
  const row=(await db.query("select has_table_privilege('authenticated','bid_pricing_decisions','select') read,has_table_privilege('authenticated','bid_pricing_decisions','insert') write,has_function_privilege('anon','run_reviewed_bid_award(uuid,uuid,uuid,text,uuid[],text,text,text)','execute') award")).rows[0]
  assert.equal(row.read,false);assert.equal(row.write,false);assert.equal(row.award,false)
 })
})
