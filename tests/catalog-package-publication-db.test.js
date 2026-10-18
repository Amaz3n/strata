const test=require('node:test'),assert=require('node:assert/strict')
const {database,id}=require('./fixtures/catalog-publication-database')
test('package header, members, revision, event, audit and receipt commit once and recover exactly',async t=>{
 const f=await database(t),saved=(await f.publish()).rows[0].receipt
 assert.deepEqual(saved.package.option_ids,f.request.optionIds)
 assert.equal(saved.package.price_cents,12345);const revision=await f.revision()
 const replay=(await f.publish({actor:f.other})).rows[0].receipt
 assert.equal(replay.created,false);assert.equal(replay.receiptId,saved.receiptId);assert.equal(await f.revision(),revision)
 assert.equal(await f.count('selection_packages'),1);assert.equal(await f.count('selection_package_items'),2)
 for(const table of ['catalog_package_publication_receipts','audit_log','events'])assert.equal(await f.count(table),1)
 await assert.rejects(f.db.exec('update catalog_package_publication_receipts set request=\'{}\''),/immutable/)
 await assert.rejects(f.publish({request:{...f.request,name:'Different'}}),/different reviewed/)
})
test('audit failure rolls back header, member changes, catalog revision and receipt',async t=>{
 const f=await database(t),revision=await f.revision()
 await f.db.exec("alter table audit_log add constraint reject_catalog_audit check(source<>'catalog_package_publication')")
 await assert.rejects(f.publish(),/reject_catalog_audit/)
 for(const table of ['selection_packages','selection_package_items','catalog_package_publication_receipts','audit_log','events'])assert.equal(await f.count(table),0)
 assert.equal(await f.revision(),revision)
 await f.db.exec('alter table audit_log drop constraint reject_catalog_audit');await f.publish()
})
test('replacement compares reviewed contents; failed replacement retains every original member',async t=>{
 const f=await database(t),saved=(await f.publish()).rows[0].receipt
 await assert.rejects(f.publish({key:id(91),request:{...f.request,expectedPackage:saved.package}}),/original package identity/)
 const request={...f.request,id:saved.package.id,expectedPackage:saved.package,name:'Updated package',optionIds:[id(52)],priceCents:54321}
 await f.db.exec("alter table audit_log add constraint reject_catalog_replace check(source<>'catalog_package_publication') not valid")
 await assert.rejects(f.publish({key:id(91),request}),/reject_catalog_replace/)
 assert.deepEqual((await f.publish()).rows[0].receipt.package,saved.package)
 await f.db.exec('alter table audit_log drop constraint reject_catalog_replace')
 const updated=(await f.publish({key:id(91),request})).rows[0].receipt.package
 assert.deepEqual(updated.option_ids,[id(52)]);assert.equal(updated.price_cents,54321)
 await assert.rejects(f.publish(),/Published package changed/)
 await assert.rejects(f.publish({key:id(92),request}),/Package changed/)
 assert.equal(await f.count('catalog_package_publication_receipts'),2)
})
test('foreign, unavailable, duplicate and same-category options never publish partial packages',async t=>{
 const f=await database(t)
 for(const optionIds of [[],[id(99)],[id(50),id(50)]])await assert.rejects(f.publish({request:{...f.request,optionIds}}))
 await f.db.query('update selection_options set category_id=$1 where id=$2',[id(40),id(51)])
 await assert.rejects(f.publish(),/one option per category/)
 await f.db.query('update selection_options set category_id=$1,is_archived=true where id=$2',[id(41),id(51)])
 await assert.rejects(f.publish(),/available options/)
 await f.db.query('update selection_options set is_archived=false where id=$1',[id(51)])
 await f.db.query('update selection_categories set community_id=$1 where id=$2',[id(13),id(40)])
 await assert.rejects(f.publish(),/category is unavailable/)
 assert.equal(await f.count('selection_packages'),0)
})
test('publication and recovery reauthorize current permissions, explicit denies and division scope',async t=>{
 const f=await database(t)
 await f.db.query("update memberships set division_scope='assigned' where user_id=$1",[f.actor])
 await assert.rejects(f.publish(),/division access/)
 await f.db.query('insert into membership_divisions select id,$1 from memberships where user_id=$2',[f.division,f.actor])
 const request={...f.request,communityId:id(13)};await f.publish({request})
 await f.db.query('update communities set division_id=$1',[id(99)])
 await assert.rejects(f.publish({request}),/division access/)
 await f.db.query('update communities set division_id=$1',[f.division])
 await f.db.query("insert into membership_permission_overrides select id,'selections.catalog.manage','deny' from memberships where user_id=$1",[f.actor])
 await assert.rejects(f.publish({request}),/lacks organization/)
 await f.db.query('delete from membership_permission_overrides')
 await f.db.query("update memberships set status='inactive' where user_id=$1",[f.actor]);await assert.rejects(f.publish({request}),/lacks organization/)
})
test('untrusted and service roles cannot bypass the registered gateway through private publication contents',async t=>{
 const f=await database(t)
 for(const role of ['anon','authenticated']){
  await f.db.exec(`set role ${role}`);await assert.rejects(f.publish(),/permission denied/);await assert.rejects(f.db.exec('select * from catalog_package_publication_receipts'),/permission denied/);await f.db.exec('reset role')
 }
 await f.publish();await f.db.exec('set role service_role');await assert.rejects(f.publish(),/permission denied/)
 await assert.rejects(f.db.exec("insert into catalog_package_publication_receipts(org_id) values(null)"),/permission denied/)
 await f.db.exec('reset role')
})

test('base and community override categories are one effective category in a package',async t=>{
 const f=await database(t)
 await f.db.query('update selection_categories set parent_category_id=$1,community_id=$2 where id=$3',[id(40),id(13),id(41)])
 await assert.rejects(f.publish({request:{...f.request,communityId:id(13)}}),/one option per effective category/)
 assert.equal(await f.count('selection_packages'),0)
})
test('moving a package requires access to both its reviewed old scope and proposed new scope',async t=>{
 const f=await database(t),saved=(await f.publish({actor:f.other})).rows[0].receipt
 await f.db.query("update memberships set division_scope='assigned' where user_id=$1",[f.actor])
 await f.db.query('insert into membership_divisions select id,$1 from memberships where user_id=$2',[f.division,f.actor])
 const request={...f.request,id:saved.package.id,expectedPackage:saved.package,communityId:id(13)}
 await assert.rejects(f.publish({key:id(91),request}),/division access/)
 assert.equal((await f.publish({actor:f.other})).rows[0].receipt.package.community_id,null)
})
test('expired platform access cannot publish or recover a package',async t=>{
 const f=await database(t),actor=id(70),role=id(71)
 await f.db.query('insert into app_users(id) values($1)',[actor]);await f.db.query('insert into roles values($1)',[role]);await f.db.exec("insert into permissions(key) values('*') on conflict do nothing")
 await f.db.query("insert into role_permissions values($1,'*')",[role]);await f.db.query("insert into platform_memberships(user_id,role_id,status,expires_at) values($1,$2,'active','2099-01-01')",[actor,role])
 await f.publish({actor})
 await f.db.query("update platform_memberships set expires_at='2000-01-01' where user_id=$1",[actor]);await assert.rejects(f.publish({actor}),/lacks organization/)
})

test('archive preserves obsolete members and hidden cost while restore rechecks eligibility and requires unchanged reviewed contents',async t=>{
 const f=await database(t),saved=(await f.publish()).rows[0].receipt.package
 const baseline={...saved};delete baseline.cost_cents
 const lifecycle={...f.request,id:saved.id,expectedPackage:baseline,isArchived:true};delete lifecycle.costCents
 const members=(await f.db.query('select id from selection_package_items order by id')).rows.map(row=>row.id)
 await f.db.exec('update selection_options set is_available=false;update selection_categories set is_archived=true')
 const archived=(await f.publish({key:id(91),request:lifecycle})).rows[0].receipt.package;assert.equal(archived.is_archived,true);assert.equal(archived.cost_cents,5000);assert.deepEqual((await f.db.query('select id from selection_package_items order by id')).rows.map(row=>row.id),members)
 const archivedReview={...archived};delete archivedReview.cost_cents
 const restore={...lifecycle,isArchived:false,expectedPackage:archivedReview}
 await assert.rejects(f.publish({key:id(92),request:restore}),/available options/)
 await assert.rejects(f.publish({key:id(93),request:{...lifecycle,name:'Changed',expectedPackage:archivedReview}}),/preserve/)
 await f.db.exec('update selection_options set is_available=true;update selection_categories set is_archived=false')
 const restored=(await f.publish({key:id(94),request:restore})).rows[0].receipt.package;assert.equal(restored.is_archived,false);assert.equal(restored.cost_cents,5000);assert.deepEqual((await f.db.query('select id from selection_package_items order by id')).rows.map(row=>row.id),members)
 await assert.rejects(f.publish({key:id(95),request:restore}),/changed/)
})

test('retirement without margin access preserves database cost while receipts omit it',async t=>{
 const f=await database(t),saved=(await f.publish()).rows[0].receipt.package,baseline={...saved};delete baseline.cost_cents
 await f.db.exec("delete from role_permissions where permission_key='financials.margin.read'")
 const request={...f.request,id:saved.id,expectedPackage:baseline,isArchived:true};delete request.costCents
 const result=(await f.publish({key:id(96),request})).rows[0].receipt
 assert.equal(result.canReadMargin,false);assert.equal(Object.hasOwn(result.package,'cost_cents'),false);assert.equal(result.package.is_archived,true);assert.equal((await f.db.query('select cost_cents from selection_packages where id=$1',[saved.id])).rows[0].cost_cents,5000)
})

test('reviewed remediation replaces obsolete members atomically while preserving archived state and hidden cost before a separate restore',async t=>{
 const f=await database(t),saved=(await f.publish()).rows[0].receipt.package,baseline={...saved};delete baseline.cost_cents
 const archive={...f.request,id:saved.id,expectedPackage:baseline,isArchived:true};delete archive.costCents
 await f.db.query('update selection_options set is_available=false where id=$1',[id(50)])
 const archived=(await f.publish({key:id(91),request:archive})).rows[0].receipt.package,review={...archived};delete review.cost_cents
 const repair={...f.request,id:saved.id,expectedPackage:review,editArchived:true,name:'Repaired bundle',optionIds:[id(51),id(52)]};delete repair.costCents
 const repaired=(await f.publish({key:id(92),request:repair})).rows[0].receipt.package;assert.equal(repaired.is_archived,true);assert.equal(repaired.cost_cents,5000);assert.equal(repaired.name,'Repaired bundle');assert.deepEqual(repaired.option_ids,[id(51),id(52)])
 await assert.rejects(f.publish({key:id(93),request:repair}),/changed/)
 const repairedReview={...repaired};delete repairedReview.cost_cents
 const restore={...repair,expectedPackage:repairedReview,isArchived:false};delete restore.editArchived
 const restored=(await f.publish({key:id(94),request:restore})).rows[0].receipt.package;assert.equal(restored.is_archived,false);assert.deepEqual(restored.option_ids,[id(51),id(52)])
 await assert.rejects(f.publish({key:id(95),request:{...repair,expectedPackage:{...restored,cost_cents:undefined}}}))
})
