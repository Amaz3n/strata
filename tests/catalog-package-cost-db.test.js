const { migrationSql } = require("./support/migration-sql")
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs')
const {database,id}=require('./fixtures/catalog-publication-database')
test('unprivileged package create omits cost; price/member edit preserves undisclosed cost and redacts commit/replay replies',async t=>{
 const f=await database(t,{margin:false}),request={...f.request};delete request.costCents
 const saved=(await f.publish({request})).rows[0].receipt;assert.equal(saved.canReadMargin,false);assert.ok(!Object.hasOwn(saved.package,'cost_cents'))
 await f.db.query('update selection_packages set cost_cents=5000 where id=$1',[saved.package.id])
 const baseline={...saved.package},edit={...request,id:saved.package.id,expectedPackage:baseline,priceCents:54321,optionIds:[id(52)]}
 const changed=(await f.publish({key:id(91),request:edit})).rows[0].receipt
 assert.ok(!Object.hasOwn(changed.package,'cost_cents'));assert.equal((await f.db.query('select cost_cents from selection_packages')).rows[0].cost_cents,5000)
 const again=(await f.publish({key:id(91),request:edit})).rows[0].receipt;assert.equal(again.receiptId,changed.receiptId);assert.ok(!Object.hasOwn(again.package,'cost_cents'))
 const receipt=(await f.db.query('select package_source from catalog_package_publication_receipts where request_key=$1',[id(91)])).rows[0].package_source;assert.equal(receipt.cost_cents,5000)
})
test('current margin permission is required before cost requests or guessed baselines can reach commit or replay',async t=>{
 const f=await database(t,{margin:false})
 for(const cost of [null,0,12345])await assert.rejects(f.publish({request:{...f.request,costCents:cost}}),/Margin permission/)
 assert.equal(await f.count('selection_packages'),0)
 const request={...f.request};delete request.costCents;const saved=(await f.publish({request})).rows[0].receipt
 for(const guess of [null,0,999])await assert.rejects(f.publish({key:id(91),request:{...request,id:saved.package.id,expectedPackage:{...saved.package,cost_cents:guess}}}),/Margin permission/)
 await assert.rejects(f.publish({request:{...request,costCents:999}}),/Margin permission/)
 assert.equal(await f.count('catalog_package_publication_receipts'),1)
})
test('privileged cost edits need a reviewed cost baseline; stale reviewed cost rejects and omitted cost is preserved',async t=>{
 const f=await database(t);await assert.rejects(f.publish({request:{...f.request,costCents:'5000'}}),/Valid catalog package/);assert.equal(await f.count('selection_packages'),0)
 const saved=(await f.publish()).rows[0].receipt,baseline={...saved.package};delete baseline.cost_cents
 const edit={...f.request,id:saved.package.id,expectedPackage:baseline,costCents:6000}
 await assert.rejects(f.publish({key:id(91),request:edit}),/Review current package cost/)
 await assert.rejects(f.publish({key:id(91),request:{...edit,expectedPackage:{...saved.package,cost_cents:1}}}),/Package changed/)
 const changed=(await f.publish({key:id(91),request:{...edit,expectedPackage:saved.package}})).rows[0].receipt;assert.equal(changed.package.cost_cents,6000)
 const omit={...f.request,id:saved.package.id,expectedPackage:changed.package,priceCents:7777};delete omit.costCents
 const priceOnly=(await f.publish({key:id(92),request:omit})).rows[0].receipt;assert.equal(priceOnly.package.cost_cents,6000)
 const clear={...f.request,id:saved.package.id,expectedPackage:priceOnly.package,costCents:null}
 assert.equal((await f.publish({key:id(93),request:clear})).rows[0].receipt.package.cost_cents,null)
})
test('margin revocation fences cost-bearing replay and receipt matching without leaking a cost guess',async t=>{
 const f=await database(t,{withPrices:true,margin:true}),saved=(await f.publish()).rows[0].receipt
 await f.db.query("delete from role_permissions where role_id=$1 and permission_key='financials.margin.read'",[f.role])
 await assert.rejects(f.publish(),/Margin permission/)
 await assert.rejects(f.publish({request:{...f.request,costCents:1}}),/Margin permission/)
 // Inspector itself exposes metadata only, and must not be a private-input equality oracle.
 await f.db.exec("alter table house_plans add column name text,add column status text default 'active';alter table house_plan_versions add column house_plan_id uuid references house_plans(id),add column status text default 'released',add column version_number integer,add column label text;")
 await f.db.exec(fs.readFileSync('supabase/migrations/20261004015201_catalog_price_publication.sql','utf8'))
 await f.db.exec(migrationSql("20261004025518_catalog_publication_reconciliation"))
 await assert.rejects(f.db.query('select inspect_catalog_publication($1,$2,$3,$4,$5)',[f.org,f.actor,'package',id(90),JSON.stringify(f.request)]),/Margin permission/)
 assert.equal(await f.count('catalog_package_publication_receipts'),1);assert.equal(saved.package.cost_cents,5000)
})
