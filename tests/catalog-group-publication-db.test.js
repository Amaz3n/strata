const fs=require('node:fs'),test=require('node:test'),assert=require('node:assert/strict')
const {database,id}=require('./fixtures/catalog-publication-database')
const migration='supabase/migrations/20261004065019_catalog_group_publication.sql'
async function setup(t){
 const f=await database(t),ddl=fs.readFileSync('supabase/migrations/20260718182717_option_catalog_design_studio.sql','utf8')
 for(const table of ['selection_groups','selection_group_categories'])await f.db.exec(ddl.match(new RegExp(`create table public\\.${table} \\([\\s\\S]*?\\n\\);`))[0])
 await f.db.exec(fs.readFileSync(migration,'utf8'))
 const review=async request=>({...request,expectedCategoryVersions:(await f.db.query('select catalog_group_category_versions($1,$2::uuid[]) versions',[f.org,request.categoryIds])).rows[0].versions})
 const request=await review({id:null,communityId:null,name:'Kitchen cutoff',scheduleTaskKey:'frame',cutoffOffsetDays:-14,cutoffAnchor:'start',sortOrder:0,categoryIds:[id(40),id(41)],expectedGroup:null})
 const publish=(patch={})=>f.db.query('select publish_catalog_group_contents($1,$2,$3,$4) receipt',[patch.org??f.org,patch.actor??f.actor,patch.key??id(190),JSON.stringify(patch.request??request)])
 return {...f,request,publish,review}
}
test('atomic group header, full assignments, revision, event, audit and immutable receipt commit once with exact actor replay',async t=>{
 const f=await setup(t),before=await f.revision(),saved=(await f.publish()).rows[0].receipt;assert.deepEqual(saved.group.category_ids,f.request.categoryIds);assert.equal(await f.count('selection_groups'),1);assert.equal(await f.count('selection_group_categories'),2);assert.notEqual(await f.revision(),before)
 const revision=await f.revision(),replayed=(await f.publish()).rows[0].receipt;assert.equal(replayed.created,false);assert.equal(replayed.receiptId,saved.receiptId);assert.equal(replayed.historySequence,saved.historySequence);assert.equal(saved.historySequence,'1');assert.equal(await f.revision(),revision)
 for(const table of ['catalog_group_publication_receipts','audit_log','events'])assert.equal(await f.count(table),1)
 await assert.rejects(f.publish({actor:f.other}),/another actor/);await assert.rejects(f.publish({request:{...f.request,name:'Changed'}}),/reviewed request/)
 await assert.rejects(f.db.exec("update catalog_group_publication_receipts set request='{}'"),/immutable/);await assert.rejects(f.db.exec('delete from catalog_group_publication_receipts'),/immutable/)
})
test('audit failure rolls back all new header/member/revision/event/receipt changes and preserves reviewed replacement on retry',async t=>{
 const f=await setup(t),before=await f.revision();await f.db.exec("alter table audit_log add constraint reject_group_audit check(source<>'catalog_group_publication')")
 await assert.rejects(f.publish(),/reject_group_audit/);assert.equal(await f.revision(),before);for(const table of ['selection_groups','selection_group_categories','events','audit_log','catalog_group_publication_receipts'])assert.equal(await f.count(table),0)
 await f.db.exec('alter table audit_log drop constraint reject_group_audit');const saved=(await f.publish()).rows[0].receipt.group,originalMembers=(await f.db.query('select id from selection_group_categories order by id')).rows
 const request=await f.review({...f.request,id:saved.id,expectedGroup:saved,name:'Reviewed replacement',categoryIds:[id(42)]}),revision=await f.revision()
 await f.db.exec("alter table audit_log add constraint reject_group_replace check(source<>'catalog_group_publication') not valid");await assert.rejects(f.publish({key:id(191),request}),/reject_group_replace/);assert.equal(await f.revision(),revision);assert.deepEqual((await f.db.query('select id from selection_group_categories order by id')).rows,originalMembers)
 await f.db.exec('alter table audit_log drop constraint reject_group_replace');const updated=(await f.publish({key:id(191),request})).rows[0].receipt.group;assert.equal(updated.name,'Reviewed replacement');assert.deepEqual(updated.category_ids,[id(42)]);assert.equal(await f.count('catalog_group_publication_receipts'),2)
 await assert.rejects(f.publish({key:id(192),request}),/changed since/);await assert.rejects(f.publish(),/Published cutoff rule changed/)
})
test('original header, membership and scope reviews cannot overwrite a changed or archived rule',async t=>{
 const f=await setup(t),source=(await f.publish()).rows[0].receipt.group,request={...f.request,id:source.id,expectedGroup:source,name:'Attempted edit'}
 await f.db.query('update selection_groups set name=$1 where id=$2',['Other editor',source.id]);await assert.rejects(f.publish({key:id(191),request}),/changed since/)
 await f.db.query('update selection_groups set name=$1 where id=$2',[source.name,source.id]);await f.db.query('delete from selection_group_categories where category_id=$1',[id(41)]);await assert.rejects(f.publish({key:id(191),request}),/changed since/)
 await assert.rejects(f.publish({key:id(191),request:{...request,communityId:id(13)}}),/scope is unavailable/)
 await f.db.query('update selection_groups set is_archived=true where id=$1',[source.id]);await assert.rejects(f.publish({key:id(191),request}),/scope is unavailable/);assert.equal(await f.count('catalog_group_publication_receipts'),1)
})
test('bad category identities, archive/scope and override ancestry never create a partial rule',async t=>{
 const f=await setup(t)
 for(const categoryIds of [[id(99)],[id(40),id(40)]])await assert.rejects(f.publish({request:{...f.request,categoryIds}}),/active original scope|unique/)
 await f.db.query('update selection_categories set is_archived=true where id=$1',[id(40)]);await assert.rejects(f.publish(),/active original scope/)
 await f.db.query('update selection_categories set is_archived=false,community_id=$1,parent_category_id=$2 where id=$3',[id(13),id(41),id(40)])
 await assert.rejects(f.publish(),/active original scope/);await f.db.query('update selection_categories set is_archived=true where id=$1',[id(41)])
 await assert.rejects(f.publish({request:{...f.request,communityId:id(13),categoryIds:[id(40)]}}),/ancestry/)
 for(const table of ['selection_groups','selection_group_categories','events','audit_log','catalog_group_publication_receipts'])assert.equal(await f.count(table),0)
 await f.db.query('update selection_categories set is_archived=false where id=$1',[id(41)]);const valid=(await f.publish({request:await f.review({...f.request,communityId:id(13),categoryIds:[id(40)]})})).rows[0].receipt;assert.deepEqual(valid.group.category_ids,[id(40)])
})
test('kernel reauthorizes current denies and assigned divisions for both publication and exact replay',async t=>{
 const f=await setup(t),saved=(await f.publish()).rows[0].receipt
 await f.db.query("insert into membership_permission_overrides select id,'selections.catalog.manage','deny' from memberships where user_id=$1",[f.actor]);await assert.rejects(f.publish(),/lacks organization/)
 await f.db.exec('delete from membership_permission_overrides');await f.db.query("update memberships set division_scope='assigned' where user_id=$1",[f.actor]);await assert.rejects(f.publish(),/division access/)
 await f.db.query('insert into membership_divisions select id,$1 from memberships where user_id=$2',[f.division,f.actor]);const request={...f.request,communityId:id(13)};await f.publish({key:id(191),request});await f.db.query('update communities set division_id=$1',[id(99)]);await assert.rejects(f.publish({key:id(191),request}),/division access/);assert.equal(await f.count('catalog_group_publication_receipts'),2);assert.equal(saved.actorId,f.actor)
})
test('owner-only foundation denies application/service access and rejects unknown, excessive or incomplete requests',async t=>{
 const f=await setup(t)
 for(const role of ['anon','authenticated','service_role']){
  await f.db.exec(`set role ${role}`)
  try{await assert.rejects(f.publish(),/permission denied/);await assert.rejects(f.db.exec('select * from catalog_group_publication_receipts'),/permission denied/)}finally{await f.db.exec('reset role')}
 }
 for(const request of [{...f.request,unknown:true},{...f.request,expectedGroup:{}},{...f.request,categoryIds:Array.from({length:101},()=>id(40))},{...f.request,cutoffOffsetDays:366},{...f.request,cutoffAnchor:null}])await assert.rejects(f.publish({request}))
 assert.equal(await f.count('selection_groups'),0);await assert.rejects(f.db.exec('truncate selection_groups cascade'),/Truncating agreement catalog/)
})

test('all 100 category assignments and empty repairs publish without truncation and replay without advancing history',async t=>{
 const f=await setup(t),ids=Array.from({length:100},(_,n)=>id(1000+n));await f.db.query('insert into selection_categories(id,org_id) select unnest($1::uuid[]),$2',[ids,f.org])
 const request=await f.review({...f.request,categoryIds:[...ids].reverse()}),saved=(await f.publish({request})).rows[0].receipt;assert.deepEqual(saved.group.category_ids,ids);assert.equal(await f.count('selection_group_categories'),100)
 const repaired=(await f.publish({key:id(191),request:await f.review({...f.request,id:saved.group.id,expectedGroup:saved.group,categoryIds:[]})})).rows[0].receipt;assert.deepEqual(repaired.group.category_ids,[]);assert.equal(repaired.historySequence,'2');assert.equal(await f.count('selection_group_categories'),0)
})
test('expired staff access cannot replay a committed group receipt; current renewed access still requires its exact original body',async t=>{
 const f=await setup(t);await f.publish();await f.db.exec("delete from role_permissions where permission_key='selections.catalog.manage'")
 await f.db.query("insert into platform_memberships(user_id,role_id,status,expires_at) values($1,$2,'active',clock_timestamp()-interval '1 minute')",[f.actor,f.role]);await f.db.query("insert into role_permissions values($1,'platform.org.access')",[f.role])
 // The role is still an org role. Global access is valid only as an unexpired
 // platform membership, rather than treating an org permission as a staff bypass.
 await assert.rejects(f.publish(),/lacks organization/)
 await f.db.query("update platform_memberships set expires_at=clock_timestamp()+interval '1 hour' where user_id=$1",[f.actor]);assert.equal((await f.publish()).rows[0].receipt.created,false)
 await assert.rejects(f.publish({request:{...f.request,scheduleTaskKey:'other'}}),/reviewed request/);assert.equal(await f.count('catalog_group_publication_receipts'),1)
})

test('changed category definitions reject a new publication while exact committed replay keeps its original versions',async t=>{
 const f=await setup(t);await f.db.exec('alter table selection_categories add column name text');await f.db.query('update selection_categories set name=$1 where id=$2',['Original kitchen',id(40)])
 const request=await f.review(f.request);await f.db.query('update selection_categories set name=$1 where id=$2',['Different kitchen',id(40)]);const revision=await f.revision()
 await assert.rejects(f.publish({request}),/definitions changed/);assert.equal(await f.count('selection_groups'),0);assert.equal(await f.revision(),revision)
 const reviewed=await f.review(request),saved=(await f.publish({key:id(191),request:reviewed})).rows[0].receipt;await f.db.query('update selection_categories set name=$1 where id=$2',['Later name',id(40)]);const afterRename=await f.revision()
 const replay=(await f.publish({key:id(191),request:reviewed})).rows[0].receipt;assert.equal(replay.created,false);assert.equal(replay.receiptId,saved.receiptId);assert.equal(await f.revision(),afterRename)
 await assert.rejects(f.publish({key:id(192),request:reviewed}),/definitions changed/);assert.equal(await f.count('catalog_group_publication_receipts'),1)
})
test('override root definitions are reviewed too, without invalidating unrelated categories or exposing private columns',async t=>{
 const f=await setup(t);await f.db.exec('alter table selection_categories add column name text,add column cost_cents integer')
 await f.db.query('update selection_categories set community_id=$1,parent_category_id=$2 where id=$3',[id(13),id(41),id(40)])
 const request=await f.review({...f.request,communityId:id(13),categoryIds:[id(40)]});assert.equal(request.expectedCategoryVersions.length,2)
 await f.db.query('update selection_categories set name=$1 where id=$2',['Root renamed',id(41)]);await assert.rejects(f.publish({request}),/definitions changed/)
 const renewed=await f.review(request);await f.db.query('update selection_categories set name=$1 where id=$2',['Unrelated renamed',id(42)]);await f.db.query('update selection_categories set cost_cents=12345 where id=$1',[id(40)])
 assert.deepEqual((await f.review(renewed)).expectedCategoryVersions,renewed.expectedCategoryVersions);await f.publish({key:id(191),request:renewed})
 for(const role of ['anon','authenticated','service_role']){await f.db.exec(`set role ${role}`);try{await assert.rejects(f.db.query('select catalog_group_category_versions($1,$2::uuid[])',[f.org,[id(40)]]),/permission denied/)}finally{await f.db.exec('reset role')}}
})
test('review versions must cover exactly the selected and root definitions with canonical hashes',async t=>{
 const f=await setup(t),versions=f.request.expectedCategoryVersions
 for(const expectedCategoryVersions of [[],[versions[0]],[...versions,versions[0]],[...versions,{id:id(42),definitionHash:'0'.repeat(64)}],[{...versions[0],definitionHash:'bad'},versions[1]],[{...versions[0],privateCost:100},versions[1]],[{...versions[0],id:'not-a-uuid'},versions[1]]])await assert.rejects(f.publish({request:{...f.request,expectedCategoryVersions}}),/versions required|definitions changed/)
 assert.equal(await f.count('selection_groups'),0)
})

test('maximum 100 overridden categories retain all 200 selected/root versions through create and reviewed replacement',async t=>{
 const f=await setup(t),roots=Array.from({length:100},(_,n)=>id(2000+n)),children=Array.from({length:100},(_,n)=>id(3000+n))
 await f.db.query('insert into selection_categories(id,org_id) select unnest($1::uuid[]),$2',[roots,f.org]);await f.db.query('insert into selection_categories(id,org_id,community_id,parent_category_id) select child,$3,$4,parent from unnest($1::uuid[],$2::uuid[]) pair(child,parent)',[children,roots,f.org,id(13)])
 const request=await f.review({...f.request,communityId:id(13),categoryIds:children});assert.equal(request.expectedCategoryVersions.length,200)
 const saved=(await f.publish({request})).rows[0].receipt.group;assert.equal(saved.category_ids.length,100)
 const updated=(await f.publish({key:id(191),request:{...request,id:saved.id,expectedGroup:saved,name:'Reviewed large rule'}})).rows[0].receipt;assert.equal(updated.group.category_ids.length,100);assert.equal(updated.historySequence,'2');assert.equal(await f.count('catalog_group_publication_receipts'),2)
})


test('original category review captures public definitions and matching hashes in one snapshot without foreign or financial fields',async t=>{
 const f=await setup(t);await f.db.exec('alter table selection_categories add column name text,add column description text,add column image_url text,add column sort_order integer,add column cost_cents integer')
 await f.db.query('update selection_categories set name=$1,description=$2,image_url=$3,sort_order=7,cost_cents=98765 where id=$4',['Original name','Original explanation','/original.png',id(40)])
 await f.db.query('update selection_categories set community_id=$1,parent_category_id=$2 where id=$3',[id(13),id(41),id(40)])
 const capture=async ids=>(await f.db.query('select catalog_group_category_review($1,$2::uuid[]) review',[f.org,ids])).rows[0].review
 const original=await capture([id(40)]);assert.deepEqual(original.map(x=>x.id),[id(40),id(41)])
 assert.deepEqual(original[0].definition,{id:id(40),community_id:id(13),parent_category_id:id(41),name:'Original name',description:'Original explanation',image_url:'/original.png',sort_order:7,is_archived:false})
 const versions=original.map(({id,definitionHash})=>({id,definitionHash}));assert.deepEqual(versions,(await f.review({...f.request,categoryIds:[id(40)]})).expectedCategoryVersions)
 for(const entry of original)assert.equal(entry.definitionHash,(await f.db.query("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') hash",[JSON.stringify(entry.definition)])).rows[0].hash)
 assert.equal(JSON.stringify(original).includes('98765'),false);assert.equal(JSON.stringify(original).includes('cost_cents'),false)
 await f.db.query('update selection_categories set name=$1 where id=$2',['Renamed after review',id(40)]);assert.equal(original[0].definition.name,'Original name');assert.notEqual((await capture([id(40)]))[0].definitionHash,original[0].definitionHash)
 await f.db.query('update selection_categories set org_id=$1 where id=$2',[id(999),id(42)])
 assert.deepEqual(await capture([id(42),id(99)]),[]);assert.deepEqual(await capture([]),[])
 for(const role of ['anon','authenticated','service_role']){await f.db.exec(`set role ${role}`);try{await assert.rejects(capture([id(40)]),/permission denied/)}finally{await f.db.exec('reset role')}}
})
