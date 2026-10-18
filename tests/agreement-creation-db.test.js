require('../scripts/register-ts-node-test')
const assert=require('node:assert/strict'),fs=require('node:fs'),test=require('node:test')
const {setup,id}=require('./fixtures/agreement-signing-database')
const {installCatalogRevision}=require('./fixtures/agreement-catalog-database')
const {agreementCreationExpected}=require('../lib/services/agreement-creation')
async function database(t){
 const f=await setup(t),db=f.db
 await db.exec("alter table projects add column property_type text default 'production'")
 await db.exec(fs.readFileSync('supabase/migrations/20261003221905_purchase_agreement_open_home_unique.sql','utf8'))
 await db.exec('update lot_reservations set contract_id=null; delete from contracts;')
 await db.exec(`alter table house_plans add column org_id uuid references orgs(id),add column status text;
 alter table house_plan_versions add column org_id uuid references orgs(id),add column house_plan_id uuid references house_plans(id),add column status text;
 alter table house_plan_elevations add column org_id uuid references orgs(id),add column house_plan_id uuid references house_plans(id),add column is_active boolean;`)
 const offering=fs.readFileSync('supabase/migrations/20260718170333_house_plans.sql','utf8').match(/create table public\.community_plan_availability \([\s\S]*?\n\);/)[0]
 await db.exec(offering)
 const plan=id(30),version=id(31),elevation=id(32),reservation=id(12),lot=id(11)
 await db.query("insert into house_plans values($1,$2,'active')",[plan,f.org])
 await db.query("insert into house_plan_versions values($1,$2,$3,'released')",[version,f.org,plan])
 await db.query('insert into house_plan_elevations values($1,$2,$3,true)',[elevation,f.org,plan])
 await db.query('insert into community_plan_availability(org_id,community_id,house_plan_id,elevation_id,base_price_cents) values($1,$2,$3,$4,30000000)',[f.org,id(13),plan,elevation])
 await db.exec(fs.readFileSync('supabase/migrations/20260718220318_lot_reservations_incentives.sql','utf8').match(/create table public\.incentives \([\s\S]*?\n\);/)[0])
 await installCatalogRevision(db)
 await db.exec(fs.readFileSync('supabase/migrations/20261004000100_purchase_agreement_creation_receipts.sql','utf8'))
 await db.exec(fs.readFileSync('supabase/migrations/20261004011501_agreement_incentive_capacity.sql','utf8'))
 const request={reservationId:reservation,lotId:lot,expectedQuoteHash:'a'.repeat(64),housePlanVersionId:version,elevationId:elevation,swing:'left',optionItems:[],incentiveIds:[],terms:'Reviewed terms',effectiveDate:'2026-10-03'}
 const snapshot={purchase_agreement:{version:1,configuration:{lot_id:lot,house_plan_id:plan,house_plan_version_id:version,elevation_id:elevation,swing:'left',option_items:[]},pricing:{catalogRevision:'1',quoteHash:request.expectedQuoteHash,totalCents:30000000,basePriceCents:30000000,lotPremiumCents:0,lotId:lot,communityId:id(13),housePlanId:plan,housePlanVersionId:version,elevationId:elevation,swing:'left'},incentive_ids:[],deposits:[]}}
 const expected=agreementCreationExpected((await db.query('select row_to_json(r) row from lot_reservations r')).rows[0].row,(await db.query('select row_to_json(l) row from lots l')).rows[0].row)
 expected.catalog_revision='1'
 const create=(patch={})=>db.query('select create_purchase_agreement_atomic($1,$2,$3,$4,$5,$6) receipt',[patch.org??f.org,reservation,patch.actor??f.actor,JSON.stringify(patch.request??request),patch.probe?null:JSON.stringify(patch.expected??expected),patch.probe?null:JSON.stringify(patch.snapshot??snapshot)])
 return {...f,plan,version,elevation,reservation,lot,request,snapshot,expected,create}
}
test('agreement, reservation, lot configuration, event, audit and immutable receipt commit once',async t=>{
 const f=await database(t)
 assert.equal((await f.create({probe:true})).rows[0].receipt,null)
 const result=(await f.create()).rows[0].receipt
 assert.equal(result.created,true);assert.equal(result.contract.buyer_contact_id,f.buyer)
 assert.equal((await f.db.query('select contract_id from lot_reservations')).rows[0].contract_id,result.contract.id)
 const lot=(await f.db.query('select * from lots')).rows[0]
 assert.equal(lot.house_plan_version_id,f.version);assert.equal(lot.house_plan_elevation_id,f.elevation)
 const replay=(await f.create({probe:true,actor:f.other})).rows[0].receipt
 assert.equal(replay.contract.id,result.contract.id);assert.equal(replay.receipt_id,result.receipt_id);assert.equal(replay.created,false)
 for(const table of ['contracts','events','audit_log','purchase_agreement_creation_receipts'])assert.equal((await f.db.query(`select count(*)::int n from ${table}`)).rows[0].n,1)
 await assert.rejects(f.db.exec('update purchase_agreement_creation_receipts set request=\'{}\''),/immutable/)
 await assert.rejects(f.db.exec('delete from purchase_agreement_creation_receipts'),/immutable/)
 await assert.rejects(f.db.exec('delete from contracts'),/foreign key/)
})
test('changed retry inputs or changed saved contract source require reconciliation, not another agreement',async t=>{
 const f=await database(t),saved=(await f.create()).rows[0].receipt
 for(const request of [{...f.request,terms:'Different terms'},{...f.request,expectedQuoteHash:'b'.repeat(64)}])await assert.rejects(f.create({request,probe:true}),/different reviewed inputs/)
 await f.db.exec("update contracts set terms='Modified after creation'")
 await assert.rejects(f.create({probe:true}),/source changed/)
 assert.equal((await f.db.query('select count(*)::int n from contracts')).rows[0].n,1)
 assert.equal((await f.db.query('select contract_id from lot_reservations')).rows[0].contract_id,saved.contract.id)
})
test('audit failure rolls back every sale write and allows the same reviewed request to retry',async t=>{
 const f=await database(t)
 await f.db.exec("alter table audit_log add constraint reject_creation check(source<>'purchase_agreement_creation')")
 await assert.rejects(f.create(),/reject_creation/)
 for(const table of ['contracts','events','audit_log','purchase_agreement_creation_receipts'])assert.equal((await f.db.query(`select count(*)::int n from ${table}`)).rows[0].n,0)
 assert.equal((await f.db.query('select contract_id from lot_reservations')).rows[0].contract_id,null)
 assert.equal((await f.db.query('select house_plan_version_id from lots')).rows[0].house_plan_version_id,null)
 await f.db.exec('alter table audit_log drop constraint reject_creation');await f.create()
})
test('revoked permissions and untrusted roles cannot create or recover a receipted agreement',async t=>{
 const f=await database(t);await f.create()
 await f.db.query("update memberships set status='inactive' where user_id=$1",[f.other])
 await assert.rejects(f.create({probe:true,actor:f.other}),/organization write permission/)
 for(const role of ['anon','authenticated']){
  await f.db.exec(`set role ${role}`)
  await assert.rejects(f.create({probe:true}),/permission denied/)
  await assert.rejects(f.db.exec('select * from purchase_agreement_creation_receipts'),/permission denied/)
  await f.db.exec('reset role')
 }
 await f.db.exec('set role service_role');assert.equal((await f.create({probe:true})).rows[0].receipt.created,false);await f.db.exec('reset role')
})
test('stale ownership, current lot facts, plan ancestry, availability and base pricing reject before commit',async t=>{
 const changes=["update lot_reservations set status='released'","update lot_reservations set buyer_contact_id=co_buyer_contact_id","update lots set swing='right'","update lots set status='closed'","update house_plan_versions set status='superseded'","update house_plans set status='retired'","update house_plan_elevations set is_active=false","update community_plan_availability set is_available=false","update community_plan_availability set base_price_cents=30000001"]
 // One database; each stale fact is applied and undone inside a transaction.
 const f=await database(t)
 for(const sql of changes){
  await f.db.exec('begin');await f.db.exec(sql);await f.db.exec('savepoint attempt')
  await assert.rejects(f.create(),undefined,sql);await f.db.exec('rollback to savepoint attempt')
  for(const table of ['contracts','events','audit_log','purchase_agreement_creation_receipts'])assert.equal((await f.db.query(`select count(*)::int n from ${table}`)).rows[0].n,0)
  await f.db.exec('rollback')
 }
 assert.ok((await f.create()).rows[0].receipt.created,'every rejection came from the stale fact, not the fixture')
})
test('malformed snapshots, missing swing, foreign quote identities and altered deposits fail closed',async t=>{
 const f=await database(t)
 const changes=[s=>delete s.purchase_agreement.configuration.swing,s=>s.purchase_agreement.configuration.swing=null,s=>s.purchase_agreement.pricing.totalCents=1.5,s=>s.purchase_agreement.pricing.quoteHash='b'.repeat(64),s=>s.purchase_agreement.pricing.housePlanVersionId=id(99),s=>s.purchase_agreement.deposits=[{invoice_id:id(99),kind:'earnest_deposit'}]]
 for(const alter of changes){const snapshot=structuredClone(f.snapshot);alter(snapshot);await assert.rejects(f.create({snapshot}))}
 assert.equal((await f.db.query('select count(*)::int n from contracts')).rows[0].n,0)
})
test('actual project posture controls creation and recovery, independent of organization defaults',async t=>{
 const f=await database(t)
 for(const posture of ['residential','commercial',null]){
  await f.db.query('update projects set property_type=$1',[posture])
  await assert.rejects(f.create({probe:true}),/actual production home/)
  await assert.rejects(f.create(),/actual production home/)
 }
 await f.db.exec("update projects set property_type='production'");await f.create()
 await f.db.exec("update projects set property_type='commercial'")
 await assert.rejects(f.create({probe:true}),/actual production home/)
 assert.equal((await f.db.query('select count(*)::int n from contracts')).rows[0].n,1)
})
test('catalog edits reject a reviewed proposal while receipt recovery retains its frozen source',async t=>{
 const f=await database(t)
 await f.db.query('insert into selection_options(org_id) values($1)',[f.org])
 await assert.rejects(f.create(),error=>error.detail==='AGREEMENT_QUOTE_CHANGED')
 assert.equal((await f.db.query('select count(*)::int n from contracts')).rows[0].n,0)
 f.expected.catalog_revision='2';f.snapshot.purchase_agreement.pricing.catalogRevision='2'
 const saved=(await f.create()).rows[0].receipt
 await f.db.query('insert into selection_options(org_id) values($1)',[f.org])
 const recovered=(await f.create({probe:true})).rows[0].receipt
 assert.equal(recovered.contract.id,saved.contract.id)
 assert.equal(recovered.contract.snapshot.purchase_agreement.pricing.catalogRevision,'2')
})
test('atomic sale reserves incentive capacity, rolls it back on audit failure, and receipt replay preserves the original claim',async t=>{
 const f=await database(t),incentive=id(70)
 await f.db.query("insert into incentives(id,org_id,name,amount_cents,max_uses) values($1,$2,'Limited offer',0,1)",[incentive,f.org])
 const revision=(await f.db.query('select revision::text revision from agreement_catalog_revisions where org_id=$1',[f.org])).rows[0].revision
 const request={...f.request,incentiveIds:[incentive]},expected={...f.expected,catalog_revision:revision},snapshot=structuredClone(f.snapshot)
 snapshot.purchase_agreement.incentive_ids=[incentive]
 snapshot.purchase_agreement.pricing.catalogRevision=revision
 snapshot.purchase_agreement.pricing.incentives=[{incentiveId:incentive,name:'Limited offer',incentiveType:'fixed_amount',appliesTo:'price',amountCents:0,valueCents:0}]
 const create=()=>f.create({request,expected,snapshot})
 await f.db.exec("alter table audit_log add constraint reject_incentive_creation check(source<>'purchase_agreement_creation')")
 await assert.rejects(create(),/reject_incentive_creation/)
 assert.equal((await f.db.query('select used_count::int n from agreement_incentive_capacity')).rows[0].n,0)
 await f.db.exec('alter table audit_log drop constraint reject_incentive_creation')
 const saved=(await create()).rows[0].receipt
 assert.equal((await f.db.query('select used_count::int n from agreement_incentive_capacity')).rows[0].n,1)
 await f.db.exec("update incentives set status='ended'")
 assert.equal((await f.create({probe:true,request})).rows[0].receipt.contract.id,saved.contract.id)
 assert.equal((await f.db.query('select used_count::int n from agreement_incentive_capacity')).rows[0].n,1)
})
test("a home's own price line is not a community incentive and claims no incentive capacity",async t=>{
 const f=await database(t),disposition=id(71)
 const revision=(await f.db.query('select revision::text revision from agreement_catalog_revisions where org_id=$1',[f.org])).rows[0].revision
 const expected={...f.expected,catalog_revision:revision},snapshot=structuredClone(f.snapshot)
 Object.assign(snapshot.purchase_agreement.pricing,{catalogRevision:revision,totalCents:28000000,incentives:[],incentivesCents:0,homeAdjustmentsCents:-2000000,
  homeAdjustments:[{kind:'disposition',sourceId:disposition,label:'Investor sale price (approved disposition)',amountCents:-2000000}]})
 const saved=(await f.create({expected,snapshot})).rows[0].receipt
 assert.equal(saved.created,true);assert.equal(Number(saved.contract.total_cents),28000000)
 assert.equal((await f.db.query('select count(*)::int n from agreement_incentive_capacity where used_count>0')).rows[0].n,0)
})
test('only a live reservation can create an agreement: a hold, an expired hold or a released reservation cannot',async t=>{
 const f=await database(t)
 for(const sql of ["update lot_reservations set status='hold',expires_at=now()+interval '1 day'","update lot_reservations set status='hold',expires_at=now()-interval '1 day'","update lot_reservations set status='expired',expires_at=null","update lot_reservations set status='released',expires_at=null"]){
  await f.db.exec(sql)
  await assert.rejects(f.create(),undefined,sql)
  for(const table of ['contracts','events','audit_log','purchase_agreement_creation_receipts'])assert.equal((await f.db.query(`select count(*)::int n from ${table}`)).rows[0].n,0,sql)
  assert.equal((await f.db.query('select contract_id from lot_reservations')).rows[0].contract_id,null,sql)
 }
 await f.db.exec("update lot_reservations set status='reserved',expires_at=null")
 assert.ok((await f.create()).rows[0].receipt.created,'every rejection came from the reservation status, not the fixture')
})
