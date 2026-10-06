const fs=require('node:fs'),test=require('node:test'),assert=require('node:assert/strict')
const {database:base,id}=require('./fixtures/catalog-publication-database')
async function database(t){
 const f=await base(t,{withPrices:true,margin:true})
 await f.db.exec("alter table house_plans add column name text,add column status text default 'active';alter table house_plan_versions add column house_plan_id uuid references house_plans(id),add column status text default 'released',add column version_number integer,add column label text;")
 await f.db.query('insert into house_plans(id,org_id,name) values($1,$2,$3)',[id(30),f.org,'Alpha'])
 await f.db.query('insert into house_plan_versions(id,org_id,house_plan_id,version_number) values($1,$2,$3,1)',[id(31),f.org,id(30)])
 await f.db.exec(fs.readFileSync('supabase/migrations/20261004015201_catalog_price_publication.sql','utf8'))
 await f.db.exec(fs.readFileSync('supabase/migrations/20261004025518_catalog_publication_reconciliation.sql','utf8'))
 await require('./fixtures/catalog-group-recovery-database').installGroupRecovery(f.db)
 const prices={communityId:null,items:[{optionId:id(50),packageId:null,housePlanVersionId:id(31),priceCents:123,isAvailable:true,expectedPrice:null}]}
 const publishPrice=()=>f.db.query('select publish_catalog_prices_contents($1,$2,$3,$4) result',[f.org,f.actor,id(80),JSON.stringify(prices)])
 const inspect=(kind='prices',request=prices,patch={})=>f.db.query('select inspect_catalog_publication($1,$2,$3,$4,$5) result',[patch.org??f.org,patch.actor??f.actor,kind,patch.key??(kind==='prices'?id(80):id(90)),JSON.stringify(request)])
 const acknowledge=(receiptId,kind='prices',request=prices,patch={})=>f.db.query('select acknowledge_catalog_publication($1,$2,$3,$4,$5,$6,$7,$8) result',[patch.org??f.org,patch.actor??f.actor,kind,patch.key??(kind==='prices'?id(80):id(90)),JSON.stringify(request),receiptId,patch.ackKey??receiptId,patch.reason??'Reviewed original committed receipt'])
 const cancel=(kind='prices',request=prices,patch={})=>f.db.query('select cancel_catalog_publication($1,$2,$3,$4,$5,$6) result',[patch.org??f.org,patch.actor??f.actor,kind,patch.key??(kind==='prices'?id(80):id(90)),JSON.stringify(request),patch.reason??'Cancelled original uncommitted request'])
 return {...f,prices,publishPrice,inspect,acknowledge,cancel}
}
test('exact historical price commit can be inspected and audited after current source changes without republishing',async t=>{
 const f=await database(t);assert.equal((await f.inspect()).rows[0].result.status,'not_found')
 const saved=(await f.publishPrice()).rows[0].result,initial=(await f.inspect()).rows[0].result
 assert.equal(initial.receiptId,saved.receiptId);assert.equal(initial.sourceState,'unchanged');assert.equal(initial.entityIds.length,1)
 assert.ok(!JSON.stringify(initial).includes('cost'));assert.ok(!JSON.stringify(initial).includes('priceCents'))
 await f.db.exec('update selection_catalog_prices set price_cents=999')
 assert.equal((await f.inspect()).rows[0].result.sourceState,'changed')
 const revision=await f.revision(),ack=(await f.acknowledge(saved.receiptId)).rows[0].result
 assert.equal(await f.revision(),revision);assert.equal((await f.db.query('select price_cents from selection_catalog_prices')).rows[0].price_cents,999)
 assert.equal(await f.count('catalog_publication_reconciliations'),1);assert.equal(await f.count('catalog_price_publication_receipts'),1)
 assert.equal((await f.acknowledge(saved.receiptId)).rows[0].result.reconciliationId,ack.reconciliationId)
 assert.equal(await f.count('audit_log'),2);assert.equal(await f.count('events'),2)
 await assert.rejects(f.acknowledge(saved.receiptId,'prices',f.prices,{reason:'A different acknowledgment reason'}),/different reconciliation/)
})
test('package member/header changes preserve original receipt and acknowledgment never recreates contents',async t=>{
 const f=await database(t),saved=(await f.publish()).rows[0].receipt
 assert.equal((await f.inspect('package',f.request)).rows[0].result.sourceState,'unchanged')
 await f.db.query('delete from selection_package_items where package_id=$1 and option_id=$2',[saved.package.id,id(50)])
 await f.db.query('update selection_packages set name=$1,is_archived=true where id=$2',['New current package',saved.package.id])
 assert.equal((await f.inspect('package',f.request)).rows[0].result.sourceState,'changed')
 const revision=await f.revision();await f.acknowledge(saved.receiptId,'package',f.request)
 assert.equal(await f.revision(),revision);assert.equal(await f.count('selection_packages'),1);assert.equal(await f.count('selection_package_items'),1)
})
test('missing current price remains historically committed; absent and mismatched receipts cannot be acknowledged',async t=>{
 const f=await database(t);await assert.rejects(f.acknowledge(id(999)),/Matching committed/)
 const saved=(await f.publishPrice()).rows[0].result
 await assert.rejects(f.inspect('prices',{...f.prices,items:[{...f.prices.items[0],priceCents:999}]}),/different reviewed/)
 await assert.rejects(f.acknowledge(id(999)),/Matching committed/)
 await f.db.exec('delete from selection_catalog_prices')
 assert.equal((await f.inspect()).rows[0].result.sourceState,'missing')
 await f.acknowledge(saved.receiptId);assert.equal(await f.count('selection_catalog_prices'),0)
})
test('reconciliation audit failure rolls back acknowledgment and event without altering price/source receipts',async t=>{
 const f=await database(t),saved=(await f.publishPrice()).rows[0].result,revision=await f.revision()
 await f.db.exec("alter table audit_log add constraint reject_reconciliation check(source<>'catalog_publication_reconciliation')")
 await assert.rejects(f.acknowledge(saved.receiptId),/reject_reconciliation/)
 assert.equal(await f.count('catalog_publication_reconciliations'),0);assert.equal(await f.count('events'),1);assert.equal(await f.count('audit_log'),1);assert.equal(await f.revision(),revision)
})
test('current organization permissions, scope and immutable service-only boundaries protect receipt reconciliation',async t=>{
 const f=await database(t),saved=(await f.publishPrice()).rows[0].result
 await f.db.query("insert into membership_permission_overrides(membership_id,permission_key,effect) select id,'selections.catalog.manage','deny' from memberships where user_id=$1",[f.actor])
 await assert.rejects(f.inspect(),/lacks/);await assert.rejects(f.acknowledge(saved.receiptId),/lacks/)
 await f.db.exec('delete from membership_permission_overrides')
 await assert.rejects(f.inspect('prices',f.prices,{org:id(999)}),/lacks/)
 await f.acknowledge(saved.receiptId)
 await assert.rejects(f.db.exec('update catalog_publication_reconciliations set reason=reason'),/immutable/)
 await f.db.exec('set role authenticated')
 await assert.rejects(f.inspect(),/permission denied/)
 await f.db.exec('reset role')
 assert.equal((await f.db.query("select has_table_privilege('service_role','catalog_publication_reconciliations','INSERT') allowed")).rows[0].allowed,false)
})
test('receipt inspection and acknowledgment require access to original and current community scopes',async t=>{
 const f=await database(t),request={...f.prices,communityId:id(13)},key=id(81)
 const saved=(await f.db.query('select publish_catalog_prices_contents($1,$2,$3,$4) result',[f.org,f.actor,key,JSON.stringify(request)])).rows[0].result
 await f.db.query("update memberships set division_scope='assigned' where user_id=$1",[f.actor])
 await f.db.query('insert into membership_divisions select id,$1 from memberships where user_id=$2',[f.division,f.actor])
 assert.equal((await f.inspect('prices',request,{key})).rows[0].result.sourceState,'unchanged')
 await f.db.query('insert into communities(id,org_id,division_id) values($1,$2,$3)',[id(14),f.org,id(999)])
 await f.db.query('update selection_catalog_prices set community_id=$1',[id(14)])
 await assert.rejects(f.inspect('prices',request,{key}),/division access/)
 await assert.rejects(f.acknowledge(saved.receiptId,'prices',request,{key}),/division access/)
 assert.equal(await f.count('catalog_publication_reconciliations'),0)
 assert.equal((await f.inspect('prices',request,{key,actor:f.other})).rows[0].result.sourceState,'changed')
})

test('price cancellation is audited once, inspectable and permanently fences original and changed-body delayed publication',async t=>{
 const f=await database(t),revision=await f.revision(),first=(await f.cancel()).rows[0].result
 assert.ok(first.cancellationId);assert.ok(first.cancelledAt)
 assert.equal((await f.cancel()).rows[0].result.cancellationId,first.cancellationId)
 const metadata=(await f.inspect()).rows[0].result
 assert.equal(metadata.status,'cancelled');assert.equal(metadata.cancellationId,first.cancellationId)
 assert.equal(metadata.receiptId,null);assert.deepEqual(metadata.entityIds,[]);assert.ok(!JSON.stringify(metadata).includes('cost'))
 await assert.rejects(f.publishPrice(),/was cancelled/)
 await assert.rejects(f.db.query('select publish_catalog_prices_contents($1,$2,$3,$4)',[f.org,f.other,id(80),JSON.stringify({...f.prices,items:[{...f.prices.items[0],priceCents:999}]})]),/was cancelled/)
 await assert.rejects(f.inspect('prices',{...f.prices,items:[{...f.prices.items[0],priceCents:999}]}),/different reviewed/)
 await assert.rejects(f.cancel('prices',f.prices,{reason:'Another cancellation reason'}),/different resolution/)
 await assert.rejects(f.cancel('prices',f.prices,{actor:f.other}),/different resolution/)
 assert.equal(await f.count('catalog_publication_cancellations'),1);assert.equal(await f.count('catalog_price_publication_receipts'),0)
 assert.equal(await f.count('selection_catalog_prices'),0);assert.equal(await f.count('audit_log'),1);assert.equal(await f.count('events'),1);assert.equal(await f.revision(),revision)
 // A new reviewed key can publish; the tombstone continues fencing only its original key.
 await f.db.query('select publish_catalog_prices_contents($1,$2,$3,$4)',[f.org,f.actor,id(81),JSON.stringify(f.prices)])
 await assert.rejects(f.publishPrice(),/was cancelled/)
})
test('package cancellation fences header/member mutation; kinds sharing a UUID remain independent',async t=>{
 const f=await database(t),revision=await f.revision()
 await f.cancel('package',f.request)
 await assert.rejects(f.publish(),/was cancelled/)
 assert.equal(await f.count('selection_packages'),0);assert.equal(await f.count('selection_package_items'),0);assert.equal(await f.revision(),revision)
 await f.db.query('select publish_catalog_prices_contents($1,$2,$3,$4)',[f.org,f.actor,id(90),JSON.stringify(f.prices)])
 assert.equal(await f.count('catalog_price_publication_receipts'),1)
})
test('publication committing before cancellation is retained for acknowledgment, even after its source changes',async t=>{
 const f=await database(t),price=(await f.publishPrice()).rows[0].result,pack=(await f.publish()).rows[0].receipt
 await f.db.exec("update selection_catalog_prices set price_cents=999;update selection_packages set name='Updated package'")
 const revision=await f.revision()
 await assert.rejects(f.cancel(),/already committed/);await assert.rejects(f.cancel('package',f.request),/already committed/)
 assert.equal(await f.count('catalog_publication_cancellations'),0);assert.equal(await f.revision(),revision)
 await f.acknowledge(price.receiptId);await f.acknowledge(pack.receiptId,'package',f.request)
 assert.equal(await f.count('catalog_publication_reconciliations'),2)
})
test('audit failure rolls back cancellation fence and event so the original publication remains possible',async t=>{
 const f=await database(t),revision=await f.revision()
 await f.db.exec("alter table audit_log add constraint reject_cancellation check(source<>'catalog_publication_cancellation')")
 await assert.rejects(f.cancel(),/reject_cancellation/)
 assert.equal(await f.count('catalog_publication_cancellations'),0);assert.equal(await f.count('audit_log'),0);assert.equal(await f.count('events'),0);assert.equal(await f.revision(),revision)
 assert.equal((await f.inspect()).rows[0].result.status,'not_found');await f.publishPrice()
})
test('cancellation checks current permission, tenant and division before recording a fence or replaying it',async t=>{
 const f=await database(t),request={...f.prices,communityId:id(13)}
 await f.cancel('prices',request)
 await f.db.query("insert into membership_permission_overrides(membership_id,permission_key,effect) select id,'selections.catalog.manage','deny' from memberships where user_id=$1",[f.actor])
 await assert.rejects(f.cancel('prices',request),/lacks/)
 await f.db.exec('delete from membership_permission_overrides')
 await assert.rejects(f.cancel('prices',request,{org:id(999)}),/lacks|another organization/)
 await f.db.query("update memberships set division_scope='assigned' where user_id=$1",[f.actor])
 await assert.rejects(f.cancel('prices',request),/division access/)
 assert.equal(await f.count('catalog_publication_cancellations'),1)
})
test('cost-bearing cancellation and inspection require current margin access; public events never expose private request',async t=>{
 const f=await database(t);await f.cancel('package',f.request)
 const serialized=JSON.stringify((await f.db.query('select payload from events')).rows)
 assert.ok(!serialized.includes('cost'));assert.ok(!serialized.includes('Kitchen package'))
 await f.db.query("insert into membership_permission_overrides(membership_id,permission_key,effect) select id,'financials.margin.read','deny' from memberships where user_id=$1",[f.actor])
 await assert.rejects(f.cancel('package',f.request),/Margin permission/);await assert.rejects(f.inspect('package',f.request),/Margin permission/)
 const priceOnly={...f.request};delete priceOnly.costCents
 await f.cancel('package',priceOnly,{key:id(91)});assert.equal(await f.count('catalog_publication_cancellations'),2)
})
test('cancellation tombstones are immutable and cannot be forged by authenticated or service table writes',async t=>{
 const f=await database(t);await f.cancel()
 await assert.rejects(f.db.exec('update catalog_publication_cancellations set reason=reason'),/immutable/)
 await assert.rejects(f.db.exec('delete from catalog_publication_cancellations'),/immutable/)
 for(const role of ['authenticated','service_role']){
  const grants=(await f.db.query("select has_table_privilege($1,'catalog_publication_cancellations','INSERT') i,has_table_privilege($1,'catalog_publication_cancellations','UPDATE') u,has_table_privilege($1,'catalog_publication_cancellations','DELETE') d",[role])).rows[0]
  assert.deepEqual(grants,{i:false,u:false,d:false})
 }
 await f.db.exec('set role authenticated');await assert.rejects(f.cancel(),/permission denied/);await f.db.exec('reset role')
})
