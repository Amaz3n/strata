const { migrationSql } = require("./support/migration-sql")
const test=require('node:test'),assert=require('node:assert/strict')
const {database:base,id}=require('./fixtures/catalog-publication-database')
async function database(t){
 const f=await base(t,{withPrices:true,margin:true})
 await f.db.exec("alter table house_plans add column name text,add column status text default 'active';alter table house_plan_versions add column house_plan_id uuid references house_plans(id),add column status text default 'released',add column version_number integer,add column label text;")
 await f.db.query('insert into house_plans(id,org_id,name) values($1,$2,$3)',[id(30),f.org,'Alpha'])
 await f.db.query('insert into house_plan_versions(id,org_id,house_plan_id,version_number) values($1,$2,$3,1)',[id(31),f.org,id(30)])
 for(const name of ['20261004015201_catalog_price_publication.sql','20261004025518_catalog_publication_reconciliation.sql','20261004034500_catalog_publication_history.sql'])await f.db.exec(migrationSql(name.replace(/\.sql$/, "")))
 await require('./fixtures/catalog-group-recovery-database').installGroupRecovery(f.db)
 const prices={communityId:null,items:[{optionId:id(50),packageId:null,housePlanVersionId:id(31),priceCents:123,isAvailable:true,expectedPrice:null}]}
 const list=(cursor=null,patch={})=>f.db.query('select list_catalog_publication_history($1,$2,$3,$4) result',[patch.org??f.org,patch.actor??f.actor,patch.community??null,cursor?JSON.stringify(cursor):null])
 const read=(type,outcomeId,patch={})=>f.db.query('select read_catalog_publication_request($1,$2,$3,$4,$5) result',[patch.org??f.org,patch.actor??f.actor,patch.community??null,type,outcomeId])
 const cancel=(n,kind='prices',request=prices,actor=f.actor)=>f.db.query('select cancel_catalog_publication($1,$2,$3,$4,$5,$6) result',[f.org,actor,kind,id(n),JSON.stringify(request),'Cancelled original uncommitted request'])
 return {...f,prices,list,read,cancel}
}
test('history keyset merge reaches every own scoped outcome across tied timestamps and excludes later inserts',async t=>{
 const f=await database(t),ids=[]
 await f.db.exec('begin')
 for(let n=100;n<160;n++)ids.push((await f.cancel(n)).rows[0].result.cancellationId)
 ids.push((await f.publish()).rows[0].receipt.receiptId)
 ids.push((await f.db.query('select publish_catalog_prices_contents($1,$2,$3,$4) result',[f.org,f.actor,id(80),JSON.stringify(f.prices)])).rows[0].result.receiptId)
 await f.db.exec('commit')
 await f.cancel(170,'package',f.request,f.other)
 await f.cancel(171,'prices',{...f.prices,communityId:id(13)})
 const first=(await f.list()).rows[0].result;assert.equal(first.entries.length,25);assert.ok(first.nextCursor)
 const later=(await f.cancel(172)).rows[0].result.cancellationId
 const seen=[...first.entries];let cursor=first.nextCursor,pages=1
 while(cursor){const page=(await f.list(cursor)).rows[0].result;assert.ok(page.entries.length<=25);seen.push(...page.entries);cursor=page.nextCursor;pages++;assert.ok(pages<10)}
 assert.equal(pages,3);assert.equal(seen.length,62);assert.equal(new Set(seen.map(x=>x.id)).size,62);assert.deepEqual(new Set(seen.map(x=>x.id)),new Set(ids));assert.ok(!seen.some(x=>x.id===later))
 const newest=(await f.list()).rows[0].result;assert.equal(newest.entries[0].id,later)
 assert.equal((await f.list(null,{community:id(13)})).rows[0].result.entries.length,1)
 assert.equal((await f.list(null,{actor:f.other})).rows[0].result.entries.length,1)
 assert.ok(!JSON.stringify(seen).includes('cost'));assert.ok(!JSON.stringify(seen).includes('Kitchen package'));assert.ok(!JSON.stringify(seen).includes('priceCents'))
})
test('original price and package bodies can be recovered after catalog changes without writes or using current source',async t=>{
 const f=await database(t),pack=(await f.publish()).rows[0].receipt,price=(await f.db.query('select publish_catalog_prices_contents($1,$2,$3,$4) result',[f.org,f.actor,id(80),JSON.stringify(f.prices)])).rows[0].result
 await f.db.exec("update selection_packages set name='New catalog name',cost_cents=999;update selection_catalog_prices set price_cents=999")
 const revision=await f.revision(),events=await f.count('events')
 const recoveredPackage=(await f.read('package',pack.receiptId)).rows[0].result,recoveredPrice=(await f.read('prices',price.receiptId)).rows[0].result
 assert.deepEqual(recoveredPackage.request,f.request);assert.deepEqual(recoveredPrice.request,f.prices)
 assert.equal(recoveredPackage.requestKey,id(90));assert.equal(recoveredPackage.outcomeId,pack.receiptId);assert.equal(recoveredPackage.actorId,f.actor)
 assert.equal(await f.revision(),revision);assert.equal(await f.count('events'),events);assert.equal(await f.count('catalog_publication_reconciliations'),0)
 const cancelled=(await f.cancel(180,'package',f.request)).rows[0].result
 assert.equal((await f.read('cancellation',cancelled.cancellationId)).rows[0].result.status,'cancelled')
})
test('metadata remains cost-free after margin revocation; cost-bearing bodies fail closed while price-only requests remain recoverable',async t=>{
 const f=await database(t),pack=(await f.publish()).rows[0].receipt,price=(await f.db.query('select publish_catalog_prices_contents($1,$2,$3,$4) result',[f.org,f.actor,id(80),JSON.stringify(f.prices)])).rows[0].result
 const cancelled=(await f.cancel(181,'package',f.request)).rows[0].result
 await f.db.query("insert into membership_permission_overrides(membership_id,permission_key,effect) select id,'financials.margin.read','deny' from memberships where user_id=$1",[f.actor])
 const page=(await f.list()).rows[0].result;assert.equal(page.entries.length,3);assert.ok(!JSON.stringify(page).includes('cost'))
 await assert.rejects(f.read('package',pack.receiptId),/Margin permission/);await assert.rejects(f.read('cancellation',cancelled.cancellationId),/Margin permission/)
 assert.deepEqual((await f.read('prices',price.receiptId)).rows[0].result.request,f.prices)
})
test('current actor, tenant, scope and management permission fence both history and original request retrieval',async t=>{
 const f=await database(t),pack=(await f.publish()).rows[0].receipt
 await assert.rejects(f.read('package',pack.receiptId,{actor:f.other}),/unavailable/)
 await assert.rejects(f.read('package',pack.receiptId,{community:id(13)}),/unavailable/)
 await assert.rejects(f.read('package',pack.receiptId,{org:id(999)}),/lacks/)
 await f.db.query("insert into membership_permission_overrides(membership_id,permission_key,effect) select id,'selections.catalog.manage','deny' from memberships where user_id=$1",[f.actor])
 await assert.rejects(f.list(),/lacks/);await assert.rejects(f.read('package',pack.receiptId),/lacks/)
 await f.db.exec('delete from membership_permission_overrides')
 await f.db.query("update memberships set division_scope='assigned' where user_id=$1",[f.actor])
 await assert.rejects(f.list(null,{community:id(13)}),/division access/)
 await f.db.exec('set role authenticated');await assert.rejects(f.list(),/permission denied/);await assert.rejects(f.read('package',pack.receiptId),/permission denied/);await f.db.exec('reset role')
})
test('invalid cursors fail before history can silently restart or omit outcomes; all three source indexes are scoped',async t=>{
 const f=await database(t)
 for(const cursor of [{},{throughSequence:'10',beforeSequence:'0'},{throughSequence:'1',beforeSequence:'2'},{throughSequence:'10',beforeSequence:'bad'},{throughSequence:'999',beforeSequence:'1'}])await assert.rejects(f.list(cursor),/cursor/)
 const indexes=(await f.db.query("select indexdef from pg_indexes where indexname in ('catalog_package_history_idx','catalog_price_history_idx','catalog_cancellation_history_idx')")).rows
 assert.equal(indexes.length,3);for(const row of indexes){assert.match(row.indexdef,/org_id, actor_id/);assert.match(row.indexdef,/communityId/);assert.match(row.indexdef,/history_sequence DESC/)}
})

test('scope counters roll back with failed receipt insertion and cannot be changed or allocated through service table access',async t=>{
 const f=await database(t)
 await f.db.exec("create function reject_history_receipt() returns trigger language plpgsql as $$begin raise exception 'Receipt unavailable';end $$;create trigger fail_history_receipt before insert on catalog_price_publication_receipts for each row execute function reject_history_receipt();")
 await assert.rejects(f.db.query('select publish_catalog_prices_contents($1,$2,$3,$4)',[f.org,f.actor,id(80),JSON.stringify(f.prices)]),/Receipt unavailable/)
 assert.equal(await f.count('catalog_publication_history_heads'),0);assert.equal(await f.count('events'),0);assert.equal(await f.count('audit_log'),0);assert.equal(await f.count('selection_catalog_prices'),0)
 await f.db.exec('drop trigger fail_history_receipt on catalog_price_publication_receipts')
 await f.db.query('select publish_catalog_prices_contents($1,$2,$3,$4)',[f.org,f.actor,id(80),JSON.stringify(f.prices)])
 assert.equal((await f.list()).rows[0].result.entries[0].sequence,'1')
 await f.cancel(183,'package',f.request,f.other);assert.equal((await f.list(null,{actor:f.other})).rows[0].result.entries[0].sequence,'1')
 const before=(await f.db.query("select last_sequence::text n from catalog_publication_history_heads where org_id=$1 and actor_id=$2 and scope_key='org'",[f.org,f.actor])).rows[0].n
 await f.db.query('select publish_catalog_prices_contents($1,$2,$3,$4)',[f.org,f.actor,id(80),JSON.stringify(f.prices)])
 assert.equal((await f.list()).rows[0].result.entries[0].sequence,before,'idempotent publication must not allocate another outcome')
 await f.db.exec('set role service_role')
 await assert.rejects(f.db.query('select allocate_catalog_publication_history($1,$2,null)',[f.org,f.actor]),/permission denied/)
 await assert.rejects(f.db.exec('update catalog_publication_history_heads set last_sequence=1000'),/permission denied/)
 await f.db.exec('reset role')
})

test('history scope matches uppercase UUIDs while preserving the exact original package request',async t=>{
 const f=await database(t),community='abcdefab-1234-4000-8000-aaaaaaaaaaaa',request={...f.request,communityId:community.toUpperCase()}
 await f.db.query('insert into communities(id,org_id,division_id) values($1,$2,$3)',[community,f.org,f.division])
 const saved=(await f.publish({key:id(192),request})).rows[0].receipt
 const history=(await f.list(null,{community})).rows[0].result;assert.equal(history.entries.length,1);assert.equal(history.entries[0].id,saved.receiptId)
 assert.deepEqual((await f.read('package',saved.receiptId,{community})).rows[0].result.request,request)
})
