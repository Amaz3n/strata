const fs=require('node:fs'),test=require('node:test'),assert=require('node:assert/strict')
const {database:base,id}=require('./fixtures/catalog-publication-database')
async function setup(t){
 const f=await base(t,{withPrices:true,margin:true})
 await f.db.exec("alter table house_plans add column name text,add column status text default 'active';alter table house_plan_versions add column house_plan_id uuid references house_plans(id),add column status text default 'released',add column version_number integer,add column label text;alter table selection_categories add column name text;")
 await f.db.query('insert into house_plans(id,org_id,name) values($1,$2,$3)',[id(30),f.org,'Alpha'])
 await f.db.query('insert into house_plan_versions(id,org_id,house_plan_id,version_number) values($1,$2,$3,1)',[id(31),f.org,id(30)])
 await f.db.query('update selection_categories set name=$1 where id=$2',['Original kitchen',id(40)])
 for(const name of ['20261004015201_catalog_price_publication.sql','20261004025518_catalog_publication_reconciliation.sql','20261004033000_catalog_publication_intents.sql','20261004034500_catalog_publication_history.sql','20261004043000_catalog_publication_pending_scopes.sql'])await f.db.exec(fs.readFileSync(`supabase/migrations/${name}`,'utf8'))
 await require('./fixtures/catalog-group-recovery-database').installGroupRecovery(f.db)
 const versions=(await f.db.query('select catalog_group_category_versions($1,$2::uuid[]) versions',[f.org,[id(40),id(41)]])).rows[0].versions
 const request={id:null,communityId:null,name:'Kitchen cutoff',scheduleTaskKey:'frame',cutoffOffsetDays:-14,cutoffAnchor:'start',sortOrder:0,categoryIds:[id(40),id(41)],expectedGroup:null,expectedCategoryVersions:versions}
 const call=(name,extra=[],patch={})=>f.db.query(`select ${name}(${[f.org,patch.actor??f.actor,...extra].map((_,n)=>'$'+(n+1)).join(',')}) result`,[f.org,patch.actor??f.actor,...extra])
 const register=(key=id(190),body=request,patch={})=>call('register_catalog_publication',['group',key,JSON.stringify(body)],patch)
 const publish=(key=id(190),body=request,patch={})=>call('publish_catalog_group_atomic',[key,JSON.stringify(body)],patch)
 const inspect=(key=id(190),body=request,patch={})=>call('inspect_catalog_publication',['group',key,JSON.stringify(body)],patch)
 const cancel=(key=id(190),body=request,reason='Cancelled original cutoff rule review',patch={})=>call('cancel_catalog_publication',['group',key,JSON.stringify(body),reason],patch)
 const list=(cursor=null,community=null)=>call('list_catalog_publication_history',[community,cursor?JSON.stringify(cursor):null])
 const read=(type,record,community=null,patch={})=>call('read_catalog_publication_request',[community,type,record],patch)
 const acknowledge=(receipt,key=id(290),reason='Reviewed historical cutoff rule outcome')=>call('acknowledge_catalog_publication',['group',id(190),JSON.stringify(request),receipt,key,reason])
 return {...f,request,call,register,publish,inspect,cancel,list,read,acknowledge}
}
test('required durable group registration preserves the exact original review and releases its claim only on atomic commit',async t=>{
 const f=await setup(t),revision=await f.revision();await assert.rejects(f.publish(),/Register the original/)
 const prepared=(await f.register()).rows[0].result;assert.equal(prepared.status,'prepared');assert.equal(await f.revision(),revision);assert.equal(await f.count('selection_groups'),0);assert.equal(await f.count('catalog_publication_claims'),1)
 assert.equal((await f.register()).rows[0].result.intentId,prepared.intentId)
 const history=(await f.list()).rows[0].result;assert.equal(history.pendingRequests.length,1);assert.equal(history.pendingRequests[0].kind,'group');assert.equal(history.pendingRequests[0].itemCount,1);assert.deepEqual((await f.read('intent',prepared.intentId)).rows[0].result.request,f.request)
 const pending=(await f.call('list_pending_catalog_publications',[null])).rows[0].result;assert.equal(pending.entries[0].kind,'group');assert.equal(pending.entries[0].itemCount,1)
 await assert.rejects(f.register(id(191)),/previous registered/);await assert.rejects(f.publish(id(190),{...f.request,name:'Changed body'}),/different reviewed/)
 const receipt=(await f.publish()).rows[0].result;assert.equal(await f.count('catalog_publication_claims'),0);assert.equal(receipt.historySequence,'2');assert.equal((await f.publish()).rows[0].result.receiptId,receipt.receiptId);assert.equal((await f.register()).rows[0].result.status,'committed')
 const after=(await f.list()).rows[0].result;assert.equal(after.pendingRequests.length,0);assert.deepEqual(after.entries.map(x=>x.kind),['group','group']);assert.ok(after.entries.every(x=>x.outcomeRecorded));assert.deepEqual((await f.read('group',receipt.receiptId)).rows[0].result.request,f.request)
})
test('registration captures immutable matching original names and rejects stale, malformed or outside-scope review',async t=>{
 const f=await setup(t);await f.register();const original=(await f.inspect()).rows[0].result;assert.equal(original.reviewLabels.categories[0].definition.name,'Original kitchen')
 await f.db.query('update selection_categories set name=$1 where id=$2',['Later kitchen',id(40)])
 assert.equal((await f.register()).rows[0].result.status,'prepared');assert.equal((await f.inspect()).rows[0].result.reviewLabels.categories[0].definition.name,'Original kitchen')
 await assert.rejects(f.publish(),/definitions changed/);await f.cancel()
 await assert.rejects(f.register(id(191)),/definitions changed/)
 await assert.rejects(f.register(id(192),{...f.request,extra:true}),/Complete reviewed/)
 await f.db.query('update selection_categories set community_id=$1 where id=$2',[id(13),id(40)])
 const changed={...f.request,expectedCategoryVersions:(await f.db.query('select catalog_group_category_versions($1,$2::uuid[]) versions',[f.org,f.request.categoryIds])).rows[0].versions}
 await assert.rejects(f.register(id(193),changed),/outside active original scope/);assert.equal(await f.count('catalog_publication_intents'),1)
})
test('cancellation permanently fences the key, is exact actor/body/reason bound and releases pending recovery',async t=>{
 const f=await setup(t);await f.register();const revision=await f.revision(),first=(await f.cancel()).rows[0].result
 assert.equal(await f.revision(),revision);assert.equal(await f.count('catalog_publication_claims'),0);assert.equal(await f.count('selection_groups'),0);assert.equal((await f.cancel()).rows[0].result.cancellationId,first.cancellationId)
 assert.equal((await f.inspect()).rows[0].result.status,'cancelled');assert.equal((await f.register()).rows[0].result.status,'cancelled')
 await assert.rejects(f.publish(),/cancelled/);await assert.rejects(f.cancel(id(190),f.request,'Another cancellation reason'),/different resolution/);await assert.rejects(f.inspect(id(190),f.request,{actor:f.other}),/different reviewed/)
 await f.register(id(191));await f.publish(id(191));assert.equal(await f.count('catalog_group_publication_receipts'),1)
 const rows=(await f.list()).rows[0].result.entries;assert.ok(rows.some(x=>x.type==='cancellation'&&x.itemCount===1));assert.deepEqual((await f.read('cancellation',first.cancellationId)).rows[0].result.request,f.request)
})
test('historical inspection and acknowledgment reconcile changed contents without reapplying the original rule',async t=>{
 const f=await setup(t);await f.register();const saved=(await f.publish()).rows[0].result;assert.equal((await f.inspect()).rows[0].result.sourceState,'unchanged');await assert.rejects(f.cancel(),/already committed/)
 await f.db.query('update selection_groups set name=$1 where id=$2',['Current rule',saved.group.id]);await f.db.query('delete from selection_group_categories where category_id=$1',[id(41)]);const revision=await f.revision()
 const inspected=(await f.inspect()).rows[0].result;assert.equal(inspected.status,'committed');assert.equal(inspected.sourceState,'changed');assert.equal(inspected.reviewLabels.categories[0].definition.name,'Original kitchen');assert.equal('request' in inspected,false)
 await assert.rejects(f.publish(),/changed; reconcile/);const ack=(await f.acknowledge(saved.receiptId)).rows[0].result;assert.equal((await f.acknowledge(saved.receiptId)).rows[0].result.reconciliationId,ack.reconciliationId)
 assert.equal(await f.revision(),revision);assert.equal(await f.count('selection_group_categories'),1);assert.equal((await f.db.query('select name from selection_groups')).rows[0].name,'Current rule')
 assert.equal((await f.db.query('select group_receipt_id from catalog_publication_reconciliations')).rows[0].group_receipt_id,saved.receiptId)
 await assert.rejects(f.acknowledge(saved.receiptId,id(290),'Different historical outcome reason'),/different reconciliation/)
 await assert.rejects(f.acknowledge(id(999)),/Matching committed/)
})
test('current permissions and actor/scope restrict registration, replay, recovery, cancellation and acknowledgment',async t=>{
 const f=await setup(t);const prepared=(await f.register()).rows[0].result,saved=(await f.publish()).rows[0].result
 await assert.rejects(f.read('intent',prepared.intentId,null,{actor:f.other}),/unavailable/);await assert.rejects(f.read('group',saved.receiptId,id(13)),/unavailable/)
 await f.db.query("insert into membership_permission_overrides select id,'selections.catalog.manage','deny' from memberships where user_id=$1",[f.actor])
 for(const action of [()=>f.register(),()=>f.publish(),()=>f.inspect(),()=>f.cancel(),()=>f.list(),()=>f.read('group',saved.receiptId),()=>f.acknowledge(saved.receiptId)])await assert.rejects(action(),/lacks organization/)
 await f.db.exec('delete from membership_permission_overrides');await f.db.query("update memberships set division_scope='assigned' where user_id=$1",[f.actor]);await assert.rejects(f.inspect(),/division access/)
})
test('registration, cancellation, publication and acknowledgment audit failures roll back their claims, receipts and events',async t=>{
 const f=await setup(t)
 await f.db.exec("alter table audit_log add constraint reject_intent check(source<>'catalog_publication_intent')");await assert.rejects(f.register(),/reject_intent/);assert.equal(await f.count('catalog_publication_intents'),0);assert.equal(await f.count('catalog_publication_claims'),0);assert.equal(await f.count('events'),0)
 await f.db.exec('alter table audit_log drop constraint reject_intent');await f.register()
 await f.db.exec("alter table audit_log add constraint reject_cancel check(source<>'catalog_publication_cancellation') not valid");await assert.rejects(f.cancel(),/reject_cancel/);assert.equal(await f.count('catalog_publication_claims'),1);assert.equal(await f.count('catalog_publication_cancellations'),0);assert.equal(await f.count('events'),1)
 await f.db.exec('alter table audit_log drop constraint reject_cancel');const revision=await f.revision();await f.db.exec("alter table audit_log add constraint reject_publish check(source<>'catalog_group_publication') not valid");await assert.rejects(f.publish(),/reject_publish/);assert.equal(await f.count('catalog_publication_claims'),1);assert.equal(await f.count('selection_groups'),0);assert.equal(await f.revision(),revision)
 await f.db.exec('alter table audit_log drop constraint reject_publish');const saved=(await f.publish()).rows[0].result;await f.db.exec("alter table audit_log add constraint reject_ack check(source<>'catalog_publication_reconciliation') not valid");await assert.rejects(f.acknowledge(saved.receiptId),/reject_ack/);assert.equal(await f.count('catalog_publication_reconciliations'),0);assert.equal(await f.count('events'),2)
})
test('group history pages use the shared immutable watermark and preserve every original request across more than 25 outcomes',async t=>{
 const f=await setup(t),outcomes=[]
 for(let n=200;n<231;n++){await f.register(id(n));outcomes.push((await f.cancel(id(n))).rows[0].result.cancellationId)}
 const first=(await f.list()).rows[0].result;assert.equal(first.entries.length,25);assert.ok(first.nextCursor);await f.register(id(240));const later=(await f.cancel(id(240))).rows[0].result.cancellationId
 const seen=[...first.entries];let cursor=first.nextCursor;while(cursor){const page=(await f.list(cursor)).rows[0].result;seen.push(...page.entries);cursor=page.nextCursor;assert.ok(seen.length<=62)}
 assert.equal(seen.length,62);assert.equal(new Set(seen.map(x=>x.id)).size,62);assert.ok(!seen.some(x=>x.id===later));assert.deepEqual(new Set(seen.filter(x=>x.type==='cancellation').map(x=>x.id)),new Set(outcomes));assert.ok(seen.every(x=>x.kind==='group'&&x.itemCount===1&&x.outcomeRecorded));assert.equal(JSON.stringify(seen).includes('Original kitchen'),false)
})
test('existing package and price registration/publication/history retain their kinds and receipt constraints',async t=>{
 const f=await setup(t),prices={communityId:null,items:[{optionId:id(50),packageId:null,housePlanVersionId:id(31),priceCents:123,isAvailable:true,expectedPrice:null}]}
 await f.call('register_catalog_publication',['package',id(90),JSON.stringify({id:null,communityId:null,name:'Kitchen package',description:null,imageUrl:null,priceCents:12345,costCents:5000,isAvailable:true,sortOrder:0,optionIds:[id(50),id(51)]})])
 const packageRequest=(await f.db.query("select request from catalog_publication_intents where kind='package'")).rows[0].request
 await f.call('publish_catalog_package_atomic',[id(90),JSON.stringify(packageRequest)]);await f.call('register_catalog_publication',['prices',id(80),JSON.stringify(prices)]);await f.call('publish_catalog_prices_atomic',[id(80),JSON.stringify(prices)])
 const rows=(await f.list()).rows[0].result.entries;assert.deepEqual(new Set(rows.map(x=>x.kind)),new Set(['package','prices']));assert.ok(rows.every(x=>x.itemCount===1&&x.outcomeRecorded))
})
test('only service gateways can dispatch registered group writes and private foundation/receipt boundaries remain closed',async t=>{
 const f=await setup(t)
 for(const role of ['anon','authenticated']){await f.db.exec(`set role ${role}`);try{await assert.rejects(f.register(),/permission denied/);await assert.rejects(f.publish(),/permission denied/)}finally{await f.db.exec('reset role')}}
 await f.db.exec('set role service_role');try{await f.register();await f.publish();await assert.rejects(f.db.query('select publish_catalog_group_contents($1,$2,$3,$4)',[f.org,f.actor,id(190),JSON.stringify(f.request)]),/permission denied/);await assert.rejects(f.db.exec('select * from catalog_group_publication_receipts'),/permission denied/)}finally{await f.db.exec('reset role')}
 await assert.rejects(f.db.exec('update catalog_publication_intents set request=request'),/immutable/)
})


test('registration refuses unavailable, duplicate or archived-root categories before allocating an intent or active claim',async t=>{
 const f=await setup(t)
 await assert.rejects(f.register(id(191),{...f.request,categoryIds:[id(99)],expectedCategoryVersions:[]}),/outside active original scope/)
 await assert.rejects(f.register(id(192),{...f.request,categoryIds:[id(40),id(40)]}),/must be unique/)
 await f.db.query('update selection_categories set is_archived=true where id=$1',[id(40)])
 const review=async body=>({...body,expectedCategoryVersions:(await f.db.query('select catalog_group_category_versions($1,$2::uuid[]) versions',[f.org,body.categoryIds])).rows[0].versions})
 await assert.rejects(f.register(id(193),await review(f.request)),/outside active original scope/)
 await f.db.query('update selection_categories set is_archived=false,community_id=$1,parent_category_id=$2 where id=$3',[id(13),id(41),id(40)]);await f.db.query('update selection_categories set is_archived=true where id=$1',[id(41)])
 await assert.rejects(f.register(id(194),await review({...f.request,communityId:id(13),categoryIds:[id(40)]})),/ancestry changed/)
 for(const table of ['catalog_publication_intents','catalog_publication_claims','audit_log','events'])assert.equal(await f.count(table),0)
})
test('an orphaned claim requires recovery instead of retrying or silently recreating the active pointer',async t=>{
 const f=await setup(t),registered=(await f.register()).rows[0].result;await f.db.exec('delete from catalog_publication_claims')
 await assert.rejects(f.register(),/administrator recovery/);await assert.rejects(f.publish(),/administrator recovery/)
 assert.deepEqual((await f.read('intent',registered.intentId)).rows[0].result.request,f.request)
 await f.cancel();assert.equal((await f.inspect()).rows[0].result.status,'cancelled');await f.register(id(191));await f.publish(id(191));assert.equal(await f.count('selection_groups'),1)
})

test('authorized original review is bounded, current-actor/scope checked and separate from unchanged original request registration',async t=>{
 const f=await setup(t),review=ids=>f.call('review_catalog_group_categories',[null,ids])
 const snapshot=(await review(f.request.categoryIds)).rows[0].result;assert.equal(snapshot.orgId,f.org);assert.equal(snapshot.actorId,f.actor);assert.equal(snapshot.communityId,null)
 assert.equal(snapshot.categories[0].definition.name,'Original kitchen');assert.deepEqual(snapshot.categories.map(({id,definitionHash})=>({id,definitionHash})),f.request.expectedCategoryVersions)
 assert.deepEqual((await review([])).rows[0].result.categories,[])
 for(const ids of [[id(40),id(40)],[null],Array.from({length:101},()=>id(40))])await assert.rejects(review(ids),/100 unique/)
 await assert.rejects(review([id(99)]),/outside active original scope/)
 await f.db.query('update selection_categories set community_id=$1 where id=$2',[id(13),id(40)]);await assert.rejects(review([id(40)]),/outside active original scope/)
 await f.db.query('update selection_categories set community_id=null where id=$1',[id(40)]);await f.db.query("insert into membership_permission_overrides select id,'selections.catalog.manage','deny' from memberships where user_id=$1",[f.actor]);await assert.rejects(review(f.request.categoryIds),/lacks organization/)
 await f.db.exec('delete from membership_permission_overrides');await f.db.exec('set role authenticated');try{await assert.rejects(review(f.request.categoryIds),/permission denied/)}finally{await f.db.exec('reset role')}
 await f.db.exec('set role service_role');try{assert.equal((await review(f.request.categoryIds)).rows[0].result.categories.length,2)}finally{await f.db.exec('reset role')}
 await f.db.query('update selection_categories set name=$1 where id=$2',['Changed after human review',id(40)]);await assert.rejects(f.register(),/definitions changed/);assert.equal(snapshot.categories[0].definition.name,'Original kitchen');assert.equal(await f.count('catalog_publication_intents'),0)
})
test('maximum selected and root definitions flow through authorized review, durable registration, commit, history and original restore',async t=>{
 const f=await setup(t),roots=Array.from({length:100},(_,n)=>id(2000+n)),children=Array.from({length:100},(_,n)=>id(3000+n))
 await f.db.query('insert into selection_categories(id,org_id) select unnest($1::uuid[]),$2',[roots,f.org]);await f.db.query('insert into selection_categories(id,org_id,community_id,parent_category_id) select child,$3,$4,parent from unnest($1::uuid[],$2::uuid[]) pair(child,parent)',[children,roots,f.org,id(13)])
 const snapshot=(await f.call('review_catalog_group_categories',[id(13),children])).rows[0].result;assert.equal(snapshot.categories.length,200)
 const body={...f.request,communityId:id(13),categoryIds:children,expectedCategoryVersions:snapshot.categories.map(({id,definitionHash})=>({id,definitionHash}))}
 const registered=(await f.register(id(190),body)).rows[0].result;assert.deepEqual((await f.read('intent',registered.intentId,id(13))).rows[0].result.request,body)
 const saved=(await f.publish(id(190),body)).rows[0].result;assert.equal(saved.group.category_ids.length,100);assert.equal((await f.list(null,id(13))).rows[0].result.pendingRequests.length,0)
 const inspected=(await f.inspect(id(190),body)).rows[0].result;assert.equal(inspected.reviewLabels.categories.length,200);assert.deepEqual((await f.read('group',saved.receiptId,id(13))).rows[0].result.request,body)
})
