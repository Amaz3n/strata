const fs=require('node:fs'),test=require('node:test'),assert=require('node:assert/strict')
const {database:base,id}=require('./fixtures/catalog-publication-database')
async function database(t){
 const f=await base(t,{withPrices:true,margin:true})
 await f.db.exec("alter table house_plans add column name text,add column status text default 'active';alter table house_plan_versions add column house_plan_id uuid references house_plans(id),add column status text default 'released',add column version_number integer,add column label text;")
 await f.db.query('insert into house_plans(id,org_id,name) values($1,$2,$3)',[id(30),f.org,'Alpha'])
 await f.db.query('insert into house_plan_versions(id,org_id,house_plan_id,version_number) values($1,$2,$3,1)',[id(31),f.org,id(30)])
 for(const name of ['20261004015201_catalog_price_publication.sql','20261004025518_catalog_publication_reconciliation.sql','20261004033000_catalog_publication_intents.sql','20261004034500_catalog_publication_history.sql','20261004043000_catalog_publication_pending_scopes.sql','20261004050000_catalog_archived_package_queue.sql'])await f.db.exec(fs.readFileSync(`supabase/migrations/${name}`,'utf8'))
 await require('./fixtures/catalog-group-recovery-database').installGroupRecovery(f.db)
 const prices={communityId:null,items:[{optionId:id(50),packageId:null,housePlanVersionId:id(31),priceCents:123,isAvailable:true,expectedPrice:null}]}
 const register=(kind='prices',request=prices,key=id(80),actor=f.actor)=>f.db.query('select register_catalog_publication($1,$2,$3,$4,$5) result',[f.org,actor,kind,key,JSON.stringify(request)])
 const publishPrice=(key=id(80),request=prices,actor=f.actor)=>f.db.query('select publish_catalog_prices_atomic($1,$2,$3,$4) result',[f.org,actor,key,JSON.stringify(request)])
 const cancel=(kind='prices',request=prices,key=id(80))=>f.db.query('select cancel_catalog_publication($1,$2,$3,$4,$5,$6) result',[f.org,f.actor,kind,key,JSON.stringify(request),'Cancelled original registered request'])
 const list=(cursor=null,community=null)=>f.db.query('select list_catalog_publication_history($1,$2,$3,$4) result',[f.org,f.actor,community,cursor?JSON.stringify(cursor):null])
 const read=(intentId,actor=f.actor)=>f.db.query("select read_catalog_publication_request($1,$2,null,'intent',$3) result",[f.org,actor,intentId])
 const publish=(patch={})=>f.db.query('select publish_catalog_package_atomic($1,$2,$3,$4) receipt',[patch.org??f.org,patch.actor??f.actor,patch.key??id(90),JSON.stringify(patch.request??f.request)])
 return {...f,publish,prices,register,publishPrice,cancel,list,read}
}
test('registration is durable, audited, immutable, idempotent and recoverable before any catalog write',async t=>{
 const f=await database(t),revision=await f.revision(),first=(await f.register()).rows[0].result
 assert.equal(first.status,'prepared');assert.ok(first.intentId);assert.equal(await f.count('selection_catalog_prices'),0);assert.equal(await f.revision(),revision)
 assert.equal((await f.register()).rows[0].result.intentId,first.intentId);assert.equal(await f.count('events'),1);assert.equal(await f.count('audit_log'),1);assert.equal(await f.count('catalog_publication_intents'),1)
 const page=(await f.list()).rows[0].result;assert.equal(page.entries.length,1);assert.equal(page.entries[0].type,'intent');assert.equal(page.entries[0].status,'registered');assert.equal(page.pendingRequests.length,1);assert.equal(page.pendingRequests[0].id,first.intentId);assert.ok(!JSON.stringify(page).includes('priceCents'))
 assert.deepEqual((await f.read(first.intentId)).rows[0].result.request,f.prices)
 await assert.rejects(f.read(first.intentId,f.other),/unavailable/)
 await assert.rejects(f.register('prices',{...f.prices,items:[{...f.prices.items[0],priceCents:999}]}),/different reviewed/)
 await assert.rejects(f.register('prices',f.prices,id(80),f.other),/different reviewed/)
 await assert.rejects(f.db.exec('update catalog_publication_intents set request=request'),/immutable/)
 await assert.rejects(f.db.exec('delete from catalog_publication_intents'),/immutable/)
})
test('one unresolved request per actor/kind/scope blocks new dispatch while independent kind and community queues remain available',async t=>{
 const f=await database(t);await f.register()
 await assert.rejects(f.register('prices',f.prices,id(81)),/previous registered/);await assert.rejects(f.publishPrice(id(81)),/Register the original/)
 await f.register('package',f.request,id(90));assert.equal((await f.list()).rows[0].result.pendingRequests.length,2)
 await f.register('prices',{...f.prices,communityId:id(13)},id(82));assert.equal((await f.list(null,id(13))).rows[0].result.pendingRequests.length,1)
 await f.register('prices',f.prices,id(83),f.other)
 await assert.rejects(f.publishPrice(id(80),f.prices,f.other),/different reviewed/)
 assert.equal(await f.count('catalog_publication_claims'),4)
 const committed=(await f.publishPrice()).rows[0].result;assert.ok(committed.receiptId)
 assert.equal((await f.register()).rows[0].result.status,'committed');assert.equal((await f.list()).rows[0].result.pendingRequests.length,1)
 assert.equal(await f.count('catalog_publication_intents'),4,'closing a claim must retain every original intent')
})
test('cancellation atomically closes the claim while fencing delayed copies and allows a new request without deleting history',async t=>{
 const f=await database(t),intent=(await f.register('package',f.request,id(90))).rows[0].result
 await f.cancel('package',f.request,id(90));assert.equal((await f.register('package',f.request,id(90))).rows[0].result.status,'cancelled')
 assert.equal(await f.count('catalog_publication_claims'),0);assert.equal((await f.read(intent.intentId)).rows[0].result.requestKey,id(90))
 await assert.rejects(f.publish(),/was cancelled/)
 await f.register('package',f.request,id(91));assert.equal(await f.count('catalog_publication_intents'),2);assert.equal(await f.count('selection_packages'),0)
})
test('rejected publication retains its registered claim and original body until explicit cancellation',async t=>{
 const f=await database(t);await f.register()
 await f.db.query('insert into selection_catalog_prices(org_id,option_id,house_plan_version_id,price_cents,is_available) values($1,$2,$3,999,true)',[f.org,id(50),id(31)])
 await assert.rejects(f.publishPrice(),/changed/)
 assert.equal(await f.count('catalog_publication_claims'),1);assert.equal((await f.list()).rows[0].result.pendingRequests.length,1)
 await assert.rejects(f.register('prices',f.prices,id(81)),/previous registered/)
 await f.cancel();assert.equal(await f.count('catalog_publication_claims'),0);assert.equal((await f.db.query('select price_cents from selection_catalog_prices')).rows[0].price_cents,999)
})
test('registration and outcome audit failures roll back counters, evidence and pointer transitions as one transaction',async t=>{
 const f=await database(t)
 await f.db.exec("alter table audit_log add constraint fail_intent_audit check(source<>'catalog_publication_intent')")
 await assert.rejects(f.register(),/fail_intent_audit/);for(const table of ['events','audit_log','catalog_publication_intents','catalog_publication_claims','catalog_publication_history_heads'])assert.equal(await f.count(table),0)
 await f.db.exec('alter table audit_log drop constraint fail_intent_audit');await f.register()
 await f.db.exec("alter table audit_log add constraint fail_outcome_audit check(source='catalog_publication_intent')")
 await assert.rejects(f.publishPrice(),/fail_outcome_audit/);await assert.rejects(f.cancel(),/fail_outcome_audit/)
 assert.equal(await f.count('catalog_publication_claims'),1);assert.equal(await f.count('catalog_price_publication_receipts'),0);assert.equal(await f.count('catalog_publication_cancellations'),0);assert.equal(await f.count('selection_catalog_prices'),0)
 assert.equal((await f.list()).rows[0].result.entries[0].sequence,'1')
 await f.db.exec('alter table audit_log drop constraint fail_outcome_audit');await f.publishPrice();assert.equal(await f.count('catalog_publication_claims'),0)
})
test('cost and current scope permissions protect registration/replay and recovery while private metadata stays cost-free',async t=>{
 const f=await database(t),intent=(await f.register('package',f.request,id(90))).rows[0].result
 await f.db.query("insert into membership_permission_overrides(membership_id,permission_key,effect) select id,'financials.margin.read','deny' from memberships where user_id=$1",[f.actor])
 await assert.rejects(f.register('package',f.request,id(90)),/Margin permission/);await assert.rejects(f.read(intent.intentId),/Margin permission/)
 assert.ok(!JSON.stringify((await f.list()).rows[0].result).includes('cost'))
 await f.db.exec('delete from membership_permission_overrides')
 await f.db.query("insert into membership_permission_overrides(membership_id,permission_key,effect) select id,'selections.catalog.manage','deny' from memberships where user_id=$1",[f.actor])
 await assert.rejects(f.register(),/lacks/);await assert.rejects(f.read(intent.intentId),/lacks/)
 await f.db.exec('set role authenticated');await assert.rejects(f.register(),/permission denied/);await f.db.exec('reset role;set role service_role')
 await assert.rejects(f.db.exec('delete from catalog_publication_claims'),/permission denied/);await f.db.exec('reset role')
})
test('intent snapshot stays stable after late outcome closure while the current pending queue updates independently',async t=>{
 const f=await database(t),intent=(await f.register()).rows[0].result
 await f.db.exec('begin')
 for(let n=200;n<213;n++){await f.register('package',f.request,id(n));await f.cancel('package',f.request,id(n))}
 await f.db.exec('commit')
 const first=(await f.list()).rows[0].result;assert.equal(first.entries.length,25);assert.ok(first.nextCursor);assert.equal(first.pendingRequests.length,1)
 await f.publishPrice()
 const next=(await f.list(first.nextCursor)).rows[0].result;assert.equal(next.pendingRequests.length,0);const historical=next.entries.find(row=>row.id===intent.intentId);assert.ok(historical);assert.equal(historical.outcomeRecorded,false)
 let page=(await f.list()).rows[0].result;const all=[...page.entries];while(page.nextCursor){page=(await f.list(page.nextCursor)).rows[0].result;all.push(...page.entries)}
 assert.equal(all.find(row=>row.id===intent.intentId).outcomeRecorded,true);assert.equal(all.length,28)
})
test('public service gateways require registration; private kernels and registration assertions cannot be called by application roles',async t=>{
 const f=await database(t)
 await assert.rejects(f.publishPrice(),/Register the original/);await assert.rejects(f.publish(),/Register the original/)
 assert.equal(await f.count('selection_catalog_prices'),0);assert.equal(await f.count('selection_packages'),0)
 await f.db.exec('set role service_role')
 for(const name of ['publish_catalog_package_contents','publish_catalog_prices_contents'])await assert.rejects(f.db.query(`select ${name}($1,$2,$3,$4)`,[f.org,f.actor,id(80),JSON.stringify(f.prices)]),/permission denied/)
 await assert.rejects(f.db.query("select assert_registered_catalog_publication($1,$2,'prices',$3,$4)",[f.org,f.actor,id(80),JSON.stringify(f.prices)]),/permission denied/)
 await f.register();await f.publishPrice();await f.register('package',f.request,id(90));await f.publish()
 await f.db.exec('reset role');assert.equal(await f.count('catalog_publication_claims'),0)
 for(const role of ['anon','authenticated']){await f.db.exec(`set role ${role}`);await assert.rejects(f.publishPrice(),/permission denied/);await assert.rejects(f.publish(),/permission denied/);await f.db.exec('reset role')}
})
test('historical receipts remain replayable only for their exact original actor/body without creating new intent or catalog records',async t=>{
 const f=await database(t),historical=(await f.db.query('select publish_catalog_prices_contents($1,$2,$3,$4) result',[f.org,f.actor,id(80),JSON.stringify(f.prices)])).rows[0].result
 const registered=(await f.register()).rows[0].result;assert.equal(registered.status,'committed');assert.equal(registered.intentId,null)
 assert.equal((await f.publishPrice()).rows[0].result.receiptId,historical.receiptId);assert.equal(await f.count('catalog_publication_intents'),0);assert.equal(await f.count('catalog_publication_claims'),0);assert.equal(await f.count('catalog_price_publication_receipts'),1)
 await assert.rejects(f.publishPrice(id(80),f.prices,f.other),/Register the original/)
 await f.db.exec('update selection_catalog_prices set price_cents=999');await assert.rejects(f.publishPrice(),/changed/)
 assert.equal((await f.db.query('select price_cents from selection_catalog_prices')).rows[0].price_cents,999)
})

test('inspection preserves registered public names after catalog renames and confirms current margin access independently of labels',async t=>{
 const f=await database(t)
 await f.db.exec("alter table selection_options add column name text;update selection_options set name='Original upgrade';update house_plan_versions set label='Original release'")
 const prepared=(await f.register()).rows[0].result
 await f.db.exec("update selection_options set name='Current upgrade';update house_plans set name='Current plan';update house_plan_versions set label='Current release'")
 const inspect=()=>f.db.query("select inspect_catalog_publication($1,$2,'prices',$3,$4) result",[f.org,f.actor,id(80),JSON.stringify(f.prices)])
 const snapshot=(await inspect()).rows[0].result
 assert.equal(snapshot.status,'not_found');assert.equal(snapshot.canReadMargin,true);assert.equal(snapshot.reviewLabels.items[0].subjectName,'Original upgrade');assert.equal(snapshot.reviewLabels.items[0].planName,'Alpha');assert.equal(snapshot.reviewLabels.items[0].versionLabel,'Original release')
 await f.db.query("insert into membership_permission_overrides(membership_id,permission_key,effect) select id,'financials.margin.read','deny' from memberships where user_id=$1",[f.actor])
 const publicReview=(await inspect()).rows[0].result;assert.equal(publicReview.canReadMargin,false);assert.equal(publicReview.reviewLabels.items[0].subjectName,'Original upgrade');assert.ok(!JSON.stringify(publicReview.reviewLabels).includes('cost'))
 assert.equal((await f.read(prepared.intentId)).rows[0].result.requestKey,id(80))
 await f.publishPrice();const committed=(await inspect()).rows[0].result;assert.equal(committed.status,'committed');assert.equal(committed.canReadMargin,false);assert.deepEqual(committed.reviewLabels,snapshot.reviewLabels)
 await assert.rejects(f.db.exec("update catalog_publication_intents set review_labels='{}'::jsonb"),/immutable/)
})
test('registration captures only in-scope subject names and private label helper is not application-callable',async t=>{
 const f=await database(t),otherCommunity=id(14)
 await f.db.query('insert into communities(id,org_id,division_id) values($1,$2,$3)',[otherCommunity,f.org,id(999)])
 await f.db.exec('alter table selection_options add column name text')
 await f.db.query("update selection_options set community_id=$1,name='Outside requested scope' where id=$2",[otherCommunity,id(50)])
 await f.register('prices',{...f.prices,communityId:id(13)})
 const snapshot=(await f.db.query("select inspect_catalog_publication($1,$2,'prices',$3,$4) result",[f.org,f.actor,id(80),JSON.stringify({...f.prices,communityId:id(13)})])).rows[0].result
 assert.equal(snapshot.reviewLabels.items[0].subjectName,null);assert.ok(!JSON.stringify(snapshot.reviewLabels).includes('Outside requested scope'))
 await f.db.exec('set role service_role');await assert.rejects(f.db.query("select capture_catalog_publication_review($1,'prices',$2)",[f.org,JSON.stringify(f.prices)]),/permission denied/);await f.db.exec('reset role')
})

test('registration rejects duplicate package UUID identities before creating stranded recovery evidence',async t=>{
 const f=await database(t),option='abcdefab-1234-4000-8000-bbbbbbbbbbbb'
 await assert.rejects(f.register('package',{...f.request,optionIds:[option,option.toUpperCase()]},id(90)),/only once/)
 for(const table of ['catalog_publication_intents','catalog_publication_claims','events','audit_log','catalog_publication_history_heads'])assert.equal(await f.count(table),0)
})

test('cancelled package review keeps immutable original member names after catalog renames',async t=>{
 const f=await database(t);await f.db.exec("alter table selection_options add column name text;update selection_options set name='Original package member'")
 await f.register('package',f.request,id(90));await f.cancel('package',f.request,id(90));await f.db.exec("update selection_options set name='Renamed member'")
 const result=(await f.db.query("select inspect_catalog_publication($1,$2,'package',$3,$4) result",[f.org,f.actor,id(90),JSON.stringify(f.request)])).rows[0].result
 assert.equal(result.status,'cancelled');assert.equal(result.reviewLabels.kind,'package');assert.equal(result.reviewLabels.options.length,f.request.optionIds.length);assert.ok(result.reviewLabels.options.every(row=>row.name==='Original package member'));assert.ok(!JSON.stringify(result.reviewLabels).includes('cost'))
})

test('cross-scope live queue reaches all own active requests with tied timestamps without exposing bodies and with a materialized active-claims path',async t=>{
 const f=await database(t),ids=[]
 await f.db.exec('alter table communities add column name text;begin')
 for(let n=100;n<130;n++){
  await f.db.query('insert into communities(id,org_id,division_id,name) values($1,$2,$3,$4)',[id(n),f.org,f.division,`Community ${n}`])
  ids.push((await f.register('prices',{...f.prices,communityId:id(n)},id(500+n))).rows[0].result.intentId)
 }
 await f.db.exec('commit');await f.register('prices',f.prices,id(700),f.other)
 const list=cursor=>f.db.query('select list_pending_catalog_publications($1,$2,$3) result',[f.org,f.actor,cursor??null])
 await f.db.exec("create table queue_authorization_checks(n integer);insert into queue_authorization_checks values(0);create or replace function can_review_catalog_publication_scope(p_org_id uuid,p_actor_id uuid,p_community_id uuid) returns boolean language plpgsql security definer set search_path='' as $$begin update public.queue_authorization_checks set n=n+1;perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,p_community_id);return true;exception when insufficient_privilege then return false;end $$;")
 const first=(await list()).rows[0].result;assert.equal(first.entries.length,25);assert.equal(first.nextCursor,first.entries.at(-1).id)
 assert.equal((await f.db.query('select n from queue_authorization_checks')).rows[0].n,26,'sorted first-page lookahead must not authorize every pending request')
 const second=(await list(first.nextCursor)).rows[0].result;assert.equal(second.entries.length,5);assert.equal(second.nextCursor,null)
 const seen=[...first.entries,...second.entries];assert.deepEqual(new Set(seen.map(row=>row.id)),new Set(ids));assert.ok(seen.every(row=>row.communityName===`Community ${Number(row.communityId.slice(-12))}`));assert.ok(!JSON.stringify(seen).includes('priceCents'));assert.ok(!JSON.stringify(seen).includes('cost'))
 await f.cancel('prices',{...f.prices,communityId:id(100)},id(600));assert.equal((await list()).rows[0].result.entries.length,25)
 const sql=fs.readFileSync('supabase/migrations/20261004043000_catalog_publication_pending_scopes.sql','utf8');assert.match(sql,/active_claims as materialized/);assert.match(sql,/jsonb_array_length\(rows\)=25/)
})
test('cross-scope queue filters current division access and membership denies, and rechecks continuation authorization',async t=>{
 const f=await database(t),outside=id(14);await f.db.query('insert into communities(id,org_id,division_id) values($1,$2,$3)',[outside,f.org,id(999)])
 await f.register('prices',{...f.prices,communityId:id(13)},id(80));await f.register('prices',{...f.prices,communityId:outside},id(81));await f.register('package',f.request,id(90))
 const list=cursor=>f.db.query('select list_pending_catalog_publications($1,$2,$3) result',[f.org,f.actor,cursor??null])
 const unrestricted=(await list()).rows[0].result;assert.equal(unrestricted.entries.length,3)
 await f.db.query("update memberships set division_scope='assigned' where user_id=$1",[f.actor]);await f.db.query('insert into membership_divisions(membership_id,division_id) select id,$1 from memberships where user_id=$2',[f.division,f.actor])
 const scoped=(await list()).rows[0].result;assert.equal(scoped.entries.length,1);assert.equal(scoped.entries[0].communityId,id(13))
 const forbidden=unrestricted.entries.find(row=>row.communityId===outside);await assert.rejects(list(forbidden.id),/continuation is unavailable/)
 await f.db.query("insert into membership_permission_overrides(membership_id,permission_key,effect) select id,'selections.catalog.manage','deny' from memberships where user_id=$1",[f.actor]);assert.equal((await list()).rows[0].result.entries.length,0)
 await f.db.exec('set role authenticated');await assert.rejects(list(),/permission denied/);await f.db.exec('reset role;set role service_role');assert.equal((await list()).rows[0].result.entries.length,0);await assert.rejects(f.db.query('select can_review_catalog_publication_scope($1,$2,null)',[f.org,f.actor]),/permission denied/);await f.db.exec('reset role')
})

test('archived package queue reaches complete bounded pages, enforces actor scope and redacts hidden costs',async t=>{
 const f=await database(t)
 for(let n=200;n<230;n++)await f.db.query("insert into selection_packages(id,org_id,name,price_cents,cost_cents,is_archived) values($1,$2,$3,100,900,true)",[id(n),f.org,`Retired ${n}`])
 await f.db.query('insert into selection_package_items(org_id,package_id,option_id) select org_id,id,$1 from selection_packages',[id(50)])
 const list=cursor=>f.db.query('select list_archived_catalog_packages($1,$2,null,$3) result',[f.org,f.actor,cursor??null])
 const first=(await list()).rows[0].result;assert.equal(first.packages.length,25);assert.equal(first.nextCursor,first.packages.at(-1).id);assert.ok(first.packages.every(row=>row.cost_cents===900))
 const second=(await list(first.nextCursor)).rows[0].result;assert.equal(second.packages.length,5);assert.equal(second.nextCursor,null);assert.equal(new Set([...first.packages,...second.packages].map(row=>row.id)).size,30)
 await f.db.query("insert into membership_permission_overrides(membership_id,permission_key,effect) select id,'financials.margin.read','deny' from memberships where user_id=$1",[f.actor]);const hidden=(await list()).rows[0].result;assert.equal(hidden.canReadMargin,false);assert.ok(hidden.packages.every(row=>!Object.hasOwn(row,'cost_cents')))
 await f.db.query("update memberships set division_scope='assigned' where user_id=$1",[f.actor]);await assert.rejects(list(),/division access/)
 await f.db.exec('set role authenticated');await assert.rejects(list(),/permission denied/);await f.db.exec('reset role')
})

test('server member discovery paginates complete scoped public options, escapes search and redacts unavailable selected references',async t=>{
 const f=await database(t);await f.db.exec("alter table selection_options add column name text,add column parent_option_id uuid;alter table selection_categories add column name text;update selection_categories set name='Kitchen';update selection_options set name='Original option'")
 await f.db.exec(fs.readFileSync('supabase/migrations/20261004060000_catalog_package_member_discovery.sql','utf8'))
 for(let n=200;n<230;n++)await f.db.query("insert into selection_options(id,org_id,category_id,name) values($1,$2,$3,$4)",[id(n),f.org,id(40),`Upgrade ${n}`])
 const discover=(query='',cursor=null,ids=null,community=null)=>f.db.query('select discover_catalog_package_members($1,$2,$3,$4,$5,$6) result',[f.org,f.actor,community,query,cursor,ids])
 const first=(await discover('Upgrade')).rows[0].result;assert.equal(first.items.length,20);assert.equal(first.nextCursor,first.items.at(-1).id);const second=(await discover('Upgrade',first.nextCursor)).rows[0].result;assert.equal(second.items.length,10);assert.equal(second.nextCursor,null);assert.equal(new Set([...first.items,...second.items].map(row=>row.id)).size,30);assert.ok(!JSON.stringify(first).includes('cost'))
 assert.equal((await discover('%')).rows[0].result.items.length,0);await f.db.query("update selection_options set name='Literal %_ sign' where id=$1",[id(200)]);assert.equal((await discover('%_')).rows[0].result.items.length,1)
 await f.db.query('update selection_options set community_id=$1 where id=$2',[id(13),id(201)]);const selected=(await discover('',null,[id(201),id(999)])).rows[0].result;assert.equal(selected.items.length,2);assert.ok(selected.items.every(row=>row.name===null&&!row.available));assert.equal(selected.nextCursor,null)
 await assert.rejects(discover('',null,[id(200),id(200)]),/Bounded/);await f.db.exec('set role authenticated');await assert.rejects(discover(),/permission denied/);await f.db.exec('reset role')
})
test('server discovery applies community option/category override precedence without falling back to archived overrides',async t=>{
 const f=await database(t);await f.db.exec("alter table selection_options add column name text,add column parent_option_id uuid;alter table selection_categories add column name text;update selection_categories set name='Base category';update selection_options set name='Base option'")
 await f.db.exec(fs.readFileSync('supabase/migrations/20261004060000_catalog_package_member_discovery.sql','utf8'))
 await f.db.query("insert into selection_categories(id,org_id,community_id,parent_category_id,name) values($1,$2,$3,$4,'Community category')",[id(70),f.org,id(13),id(40)])
 await f.db.query("insert into selection_options(id,org_id,category_id,community_id,parent_option_id,name) values($1,$2,$3,$4,$5,'Community option')",[id(71),f.org,id(70),id(13),id(50)])
 const list=()=>f.db.query("select discover_catalog_package_members($1,$2,$3,'',null,null) result",[f.org,f.actor,id(13)])
 const first=(await list()).rows[0].result;assert.ok(!first.items.some(row=>row.id===id(50)));assert.ok(first.items.some(row=>row.id===id(71)&&row.categoryKey===id(40)&&row.categoryName==='Community category'))
 await f.db.query('update selection_options set is_archived=true where id=$1',[id(71)]);const hidden=(await list()).rows[0].result;assert.ok(!hidden.items.some(row=>row.id===id(50)||row.id===id(71)))
 await f.db.query("insert into membership_permission_overrides(membership_id,permission_key,effect) select id,'selections.catalog.manage','deny' from memberships where user_id=$1",[f.actor]);await assert.rejects(list(),/lacks organization/)
})
