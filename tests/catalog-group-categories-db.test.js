const fs=require('node:fs'),test=require('node:test'),assert=require('node:assert/strict')
const {database,id}=require('./fixtures/catalog-publication-database')
async function setup(t){
 const f=await database(t);const ddl=fs.readFileSync('supabase/migrations/20260718182717_option_catalog_design_studio.sql','utf8');
 for(const table of ['selection_groups','selection_group_categories'])await f.db.exec(ddl.match(new RegExp(`create table public\\.${table} \\([\\s\\S]*?\\n\\);`))[0]);await f.db.exec('alter table selection_categories add column name text,add column cost_cents integer')
 await f.db.query("update selection_categories set name='Category '||id::text,cost_cents=987654")
 await f.db.exec(fs.readFileSync('supabase/migrations/20261004081548_catalog_group_category_discovery.sql','utf8'))
 const discover=(patch={})=>f.db.query('select discover_catalog_group_categories($1,$2,$3,$4,$5,$6::uuid[]) page',[patch.org??f.org,patch.actor??f.actor,patch.community??null,patch.query??'',patch.before??null,patch.ids??null])
 return {...f,discover}
}
test('all categories beyond the bootstrap bound remain reachable through stable 20-row UUID search pages',async t=>{
 const f=await setup(t),ids=Array.from({length:1025},(_,n)=>id(1000+n));await f.db.query("insert into selection_categories(id,org_id,name) select x,$2,'Large category '||x from unnest($1::uuid[]) x",[ids,f.org])
 let before=null,seen=[]
 do{const page=(await f.discover({before})).rows[0].page;assert.ok(page.items.length<=20);seen.push(...page.items);before=page.nextCursor;if(before)assert.equal(before,page.items.at(-1).id)}while(before)
 assert.equal(seen.length,1028);assert.equal(new Set(seen.map(x=>x.id)).size,1028);assert.deepEqual(seen.map(x=>x.id),seen.map(x=>x.id).sort());assert.ok(!JSON.stringify(seen).includes('cost_cents'));assert.ok(!JSON.stringify(seen).includes('987654'))
})
test('selected lookup returns all 100 references and explicit foreign/missing/cross-scope markers without foreign names',async t=>{
 const f=await setup(t),ids=Array.from({length:100},(_,n)=>id(5000+n));await f.db.query("insert into selection_categories(id,org_id,name) select x,$2,'Selected category' from unnest($1::uuid[]) x",[ids,f.org])
 const all=(await f.discover({ids:[...ids].reverse()})).rows[0].page;assert.equal(all.items.length,100);assert.equal(all.nextCursor,null);assert.deepEqual(all.items.map(x=>x.id),ids)
 await f.db.query('update selection_categories set org_id=$1,name=$2 where id=$3',[id(999),'FOREIGN SECRET',ids[0]]);await f.db.query('update selection_categories set community_id=$1,name=$2 where id=$3',[id(13),'OTHER SCOPE SECRET',ids[1]])
 const page=(await f.discover({ids:[ids[0],ids[1],id(9999)]})).rows[0].page;assert.equal(page.items.length,3)
 for(const row of page.items){assert.equal(row.available,false);assert.equal(row.name,null);assert.equal(row.categoryId,null);assert.equal(row.categoryKey,null);assert.equal(row.categoryName,null)}
 assert.deepEqual((await f.discover({ids:[]})).rows[0].page.items,[])
})
test('original scope and active organization-root ancestry govern discovery and archived originals remain removable',async t=>{
 const f=await setup(t);await f.db.query('update selection_categories set community_id=$1,parent_category_id=$2 where id=$3',[id(13),id(41),id(40)])
 assert.ok(!(await f.discover()).rows[0].page.items.some(x=>x.id===id(40)))
 const child=(await f.discover({community:id(13)})).rows[0].page.items.find(x=>x.id===id(40));assert.equal(child.available,true);assert.equal(child.categoryKey,id(41));assert.equal(child.categoryId,id(40))
 await f.db.query('update selection_categories set is_archived=true where id=$1',[id(41)]);assert.ok(!(await f.discover({community:id(13)})).rows[0].page.items.some(x=>x.id===id(40)))
 const unavailable=(await f.discover({community:id(13),ids:[id(40),id(41)]})).rows[0].page.items;assert.ok(unavailable.every(x=>!x.available));assert.ok(unavailable.every(x=>x.name))
})
test('literal wildcard and backslash searches never widen the category query',async t=>{
 const f=await setup(t);await f.db.query('update selection_categories set name=$1 where id=$2',['Contains % _ \\ exactly',id(40)])
 for(const query of ['%','_','\\'])assert.deepEqual((await f.discover({query})).rows[0].page.items.map(x=>x.id),[id(40)])
 assert.equal((await f.discover({query:'  CONTAINS  '})).rows[0].page.query,'contains')
})
test('current management permission/division and service-only ACLs protect every page and selected lookup',async t=>{
 const f=await setup(t);for(const role of ['anon','authenticated']){await f.db.exec(`set role ${role}`);try{await assert.rejects(f.discover(),/permission denied/)}finally{await f.db.exec('reset role')}}
 await f.db.exec('set role service_role');try{assert.ok((await f.discover()).rows[0].page.items.length)}finally{await f.db.exec('reset role')}
 await f.db.query("insert into membership_permission_overrides select id,'selections.catalog.manage','deny' from memberships where user_id=$1",[f.actor]);await assert.rejects(f.discover(),/lacks organization/)
 await f.db.exec('delete from membership_permission_overrides');await f.db.query("update memberships set division_scope='assigned' where user_id=$1",[f.actor]);await assert.rejects(f.discover(),/division access/);await assert.rejects(f.discover({community:id(13)}),/division access/)
})
test('excessive, duplicate, null and mixed selected/search requests reject without catalog mutations',async t=>{
 const f=await setup(t),revision=await f.revision()
 for(const patch of [{ids:Array.from({length:101},()=>id(40))},{ids:[id(40),id(40)]},{ids:[null]},{ids:[id(40)],query:'x'},{ids:[id(40)],before:id(39)},{query:'x'.repeat(201)}])await assert.rejects(f.discover(patch),/Bounded category discovery/)
 assert.equal(await f.revision(),revision);assert.equal(await f.count('events'),0);assert.equal(await f.count('audit_log'),0)
})


test('visible rule label lookup follows original scope and inherited names without scanning unrelated category headers',async t=>{
 const f=await setup(t);await f.db.exec("insert into permissions(key) values('selections.read') on conflict do nothing");await f.db.query("insert into role_permissions values($1,'selections.read') on conflict do nothing",[f.role])
 await f.db.query("insert into selection_groups(id,org_id,name,schedule_task_key) values($1,$2,'Rule','frame')",[id(80),f.org]);await f.db.query('insert into selection_group_categories(org_id,group_id,category_id) values($1,$2,$3)',[f.org,id(80),id(41)])
 await f.db.query('update selection_categories set community_id=$1,parent_category_id=$2,name=$3 where id=$4',[id(13),id(41),'Inherited kitchen',id(40)])
 const labels=async(community=null,groups=[id(80)])=>(await f.db.query('select read_catalog_group_category_labels($1,$2,$3,$4::uuid[]) reply',[f.org,f.actor,community,groups])).rows[0].reply
 const local=await labels(id(13));assert.deepEqual(local.labels,[{id:id(41),name:'Inherited kitchen'}]);assert.ok(!JSON.stringify(local).includes('cost_cents'));assert.ok(!JSON.stringify(local).includes('987654'))
 assert.match((await labels()).labels[0].name,/Category/);assert.deepEqual((await labels(null,[])).labels,[])
 await f.db.query('update selection_categories set org_id=$1,name=$2 where id=$3',[id(999),'FOREIGN SECRET',id(41)]);assert.deepEqual((await labels()).labels,[{id:id(41),name:null}])
 await assert.rejects(labels(null,Array.from({length:26},()=>id(80))),/bounded rule/);await assert.rejects(labels(null,[id(80),id(80)]),/bounded rule/)
})
