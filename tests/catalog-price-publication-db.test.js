const fs=require('node:fs'),test=require('node:test'),assert=require('node:assert/strict')
const {database:base,id}=require('./fixtures/catalog-publication-database')
async function database(t,{margin=false}={}){
 const f=await base(t,{withPrices:true})
 await f.db.exec("alter table house_plans add column name text,add column status text default 'active';alter table house_plan_versions add column house_plan_id uuid references house_plans(id),add column status text default 'released',add column version_number integer,add column label text;")
 await f.db.query('insert into house_plans(id,org_id,name) values($1,$2,$3)',[id(30),f.org,'Alpha'])
 await f.db.query('insert into house_plan_versions(id,org_id,house_plan_id,version_number) values($1,$2,$3,1)',[id(31),f.org,id(30)])
 await f.db.exec("insert into permissions(key) values('selections.read'),('financials.margin.read') on conflict do nothing")
 await f.db.query("insert into role_permissions values($1,'selections.read')",[f.role])
 if(margin)await f.db.query("insert into role_permissions values($1,'financials.margin.read')",[f.role])
 await f.db.exec(fs.readFileSync('supabase/migrations/20261004015201_catalog_price_publication.sql','utf8'))
 const request={communityId:null,items:[{optionId:id(50),packageId:null,housePlanVersionId:id(31),priceCents:100,isAvailable:true,expectedPrice:null},{optionId:id(51),packageId:null,housePlanVersionId:id(31),priceCents:200,isAvailable:false,expectedPrice:null}]}
 const publish=(patch={})=>f.db.query('select publish_catalog_prices_contents($1,$2,$3,$4) result',[patch.org??f.org,patch.actor??f.actor,patch.key??id(80),JSON.stringify(patch.request??request)])
 const matrix=(options=[id(50),id(51)],page=1,community=null,actor=f.actor,latestOnly=true)=>f.db.query('select read_catalog_price_matrix($1,$2,$3,$4::uuid[],$5,$6) result',[f.org,actor,community,`{${options.join(',')}}`,page,latestOnly])
 return {...f,request,publish,matrix}
}
test('complete reviewed batch commits once; retry retains exact prices and stale reuse requires reconciliation',async t=>{
 const f=await database(t),saved=(await f.publish()).rows[0].result
 assert.equal(saved.orgId,f.org);assert.equal(saved.prices.length,2);assert.ok(saved.prices.every(p=>!Object.hasOwn(p,'cost_cents')))
 const revision=await f.revision(),again=(await f.publish({actor:f.other})).rows[0].result
 assert.equal(again.receiptId,saved.receiptId);assert.equal(again.created,false);assert.equal(await f.revision(),revision)
 assert.equal(await f.count('selection_catalog_prices'),2);assert.equal(await f.count('catalog_price_publication_receipts'),1)
 await assert.rejects(f.publish({request:{...f.request,items:[{...f.request.items[0],priceCents:999}]}}),/different reviewed/)
 await f.db.exec('update selection_catalog_prices set price_cents=999')
 await assert.rejects(f.publish(),/Published prices changed/)
})
test('a later stale cell and audit failure roll back the entire batch and revision',async t=>{
 const f=await database(t),revision=await f.revision()
 const request={...f.request,items:[f.request.items[0],{...f.request.items[1],expectedPrice:{id:id(99),price_cents:123,is_available:true}}]}
 await assert.rejects(f.publish({request}),/Price changed/);assert.equal(await f.count('selection_catalog_prices'),0);assert.equal(await f.revision(),revision)
 await f.db.exec("alter table audit_log add constraint reject_price_audit check(source<>'catalog_price_publication')")
 await assert.rejects(f.publish(),/reject_price_audit/)
 for(const table of ['selection_catalog_prices','catalog_price_publication_receipts','audit_log','events'])assert.equal(await f.count(table),0)
 assert.equal(await f.revision(),revision)
})
test('price-only update preserves undisclosed cost; cost edits require permission and reviewed cost',async t=>{
 const f=await database(t)
 await f.db.query('insert into selection_catalog_prices(org_id,option_id,house_plan_version_id,price_cents,cost_cents,is_available) values($1,$2,$3,100,77,false)',[f.org,id(50),id(31)])
 const old=(await f.db.query('select * from selection_catalog_prices')).rows[0]
 const item={...f.request.items[0],expectedPrice:{id:old.id,price_cents:100,is_available:false},priceCents:200,isAvailable:false}
 const saved=(await f.publish({request:{...f.request,items:[item]}})).rows[0].result
 assert.equal((await f.db.query('select cost_cents from selection_catalog_prices')).rows[0].cost_cents,77)
 assert.ok(!Object.hasOwn(saved.prices[0],'cost_cents'))
 await assert.rejects(f.publish({key:id(81),request:{...f.request,items:[{...item,costCents:null}]}}),/Margin permission/)
 await f.db.query("insert into role_permissions values($1,'financials.margin.read')",[f.role])
 const changed={...item,expectedPrice:{id:old.id,price_cents:200,is_available:false},costCents:88}
 await assert.rejects(f.publish({key:id(81),request:{...f.request,items:[changed]}}),/Review current cost/)
 changed.expectedPrice.cost_cents=77
 assert.equal((await f.publish({key:id(81),request:{...f.request,items:[changed]}})).rows[0].result.prices[0].cost_cents,88)
})
test('matrix selects latest released version, community precedence and scope-specific review baseline without leaking margin',async t=>{
 const f=await database(t);await f.publish()
 await f.db.query('insert into selection_catalog_prices(org_id,option_id,house_plan_version_id,community_id,price_cents,cost_cents,is_available) values($1,$2,$3,$4,500,123,true)',[f.org,id(50),id(31),id(13)])
 const local=(await f.matrix(undefined,1,id(13))).rows[0].result
 const first=local.cells[`${id(50)}:${id(31)}`],fallback=local.cells[`${id(51)}:${id(31)}`]
 assert.equal(first.priceCents,500);assert.ok(first.ownPrice.id);assert.equal(fallback.ownPrice,null)
 assert.ok(Object.values(local.cells).every(cell=>!Object.hasOwn(cell,'costCents')))
 await f.db.query("insert into role_permissions values($1,'financials.margin.read')",[f.role])
 assert.equal((await f.matrix(undefined,1,id(13))).rows[0].result.cells[`${id(50)}:${id(31)}`].costCents,123)
 await f.db.query('insert into house_plan_versions(id,org_id,house_plan_id,version_number) values($1,$2,$3,2)',[id(32),f.org,id(30)])
 const latest=(await f.matrix()).rows[0].result
 assert.equal(latest.plans[0].versionId,id(32));assert.deepEqual(latest.cells,{})
})
test('matrix pages remain reachable beyond 100 versions; a page returns at most 20 columns and 400 cells',async t=>{
 const f=await database(t)
 const plans=Array.from({length:105},(_,n)=>n)
 await f.db.query('insert into house_plans(id,org_id,name) select x.id,$3,x.name from unnest($1::uuid[],$2::text[]) x(id,name)',[plans.map(n=>id(1000+n)),plans.map(n=>`Plan ${String(n).padStart(3,'0')}`),f.org])
 const versions=plans.flatMap(n=>[1,2,3].map(v=>({id:id(2000+n*3+v),plan:id(1000+n),v})))
 await f.db.query('insert into house_plan_versions(id,org_id,house_plan_id,version_number) select x.id,$4,x.plan,x.v from unnest($1::uuid[],$2::uuid[],$3::int[]) x(id,plan,v)',[versions.map(x=>x.id),versions.map(x=>x.plan),versions.map(x=>x.v),f.org])
 // Planner statistics, as production has them; without them the latest-version
 // anti-join seq-scans every version per row (~0.5s per page in PGlite).
 await f.db.exec('analyze')
 const seen=new Set()
 for(let page=1;page<=6;page++){
  const result=(await f.matrix(undefined,page)).rows[0].result
  assert.ok(result.plans.length<=20);assert.equal(result.hasMorePlans,page<6)
  for(const plan of result.plans){assert.ok(!seen.has(plan.planId));seen.add(plan.planId);if(plan.planId!==id(30))assert.equal(plan.versionLabel,'v3')}
 }
 assert.equal(seen.size,106)
 const seenVersions=new Set()
 for(let page=1;page<=16;page++){
  const result=(await f.matrix(undefined,page,null,f.actor,false)).rows[0].result
  assert.equal(result.hasMorePlans,page<16)
  for(const column of result.plans){assert.ok(!seenVersions.has(column.versionId));seenVersions.add(column.versionId)}
 }
 assert.equal(seenVersions.size,316);assert.ok(seenVersions.has(id(2001)),'oldest released version remains reachable')
 await assert.rejects(f.matrix(Array.from({length:21},(_,n)=>id(n+50))),/Bounded pricing/)
})
test('publication and reads enforce actor, role, division, tenant ancestry and immutable receipt permissions',async t=>{
 const f=await database(t)
 await f.db.query("insert into membership_permission_overrides select id,'selections.catalog.manage','deny' from memberships where user_id=$1",[f.actor]);await assert.rejects(f.publish(),/lacks organization/)
 await f.db.exec('delete from membership_permission_overrides')
 await f.db.exec("update house_plan_versions set status='draft'");await assert.rejects(f.publish(),/released plan/)
 await f.db.exec("update house_plan_versions set status='released'")
 await assert.rejects(f.publish({request:{...f.request,items:[f.request.items[0],f.request.items[0]]}}),/Duplicate/)
 for(const role of ['anon','authenticated']){await f.db.exec(`set role ${role}`);await assert.rejects(f.publish(),/permission denied/);await assert.rejects(f.matrix(),/permission denied/);await f.db.exec('reset role')}
 await f.publish();await f.db.exec('set role service_role');await assert.rejects(f.publish(),/permission denied/);await f.matrix();await assert.rejects(f.db.exec('delete from catalog_price_publication_receipts'),/permission denied/);await f.db.exec('reset role')
 await assert.rejects(f.db.exec("update catalog_price_publication_receipts set request='{}'"),/immutable/)
 await f.db.query("update memberships set division_scope='assigned' where user_id=$1",[f.actor]);await assert.rejects(f.publish(),/division access/)
 // Org base catalog is shared read-only; community reads must remain division-bound.
 assert.ok((await f.matrix()).rows[0].result.plans.length)
 await assert.rejects(f.matrix(undefined,1,id(13)),/division access/)
})
