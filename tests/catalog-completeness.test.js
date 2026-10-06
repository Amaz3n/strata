require('../scripts/register-ts-node-test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const test = require('node:test')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const ORG = id(1), COMMUNITY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
function catalog({ rowCap = 3, canReadMargin = false, errorTable = null, categories = null, options = null, divisionAccess = { assignedOnly: false, divisionIds: [] }, communityRows = [{ id: COMMUNITY, org_id: ORG, division_id: id(90) }], accessError = null, communityError = null, permissionError = null, groupRows = null, groupLinks = null } = {}) {
  const categoryRows = categories ?? Array.from({ length: 5 }, (_,i) => ({ id: id(100+i), org_id: ORG, community_id: null, parent_category_id: null, name: `Category ${i}`, sort_order: 5-i, is_archived: false }))
  const optionRows = options ?? Array.from({ length: 12 }, (_,i) => ({ id: id(200+i), org_id: ORG, community_id: null, parent_option_id: null, category_id: id(100), name: `Option ${i}`, price_cents: i*100, cost_cents: i*60, sort_order: 12-i, is_archived: false, is_available: true }))
  const tables = {
    communities: communityRows,
    selection_groups: groupRows ?? [{ id: id(500), org_id: ORG, community_id: null, name: "Group", is_archived: false, sort_order: 0, cutoff_anchor: "start" }],
    selection_group_categories: groupLinks ?? [{ id: id(600), org_id: ORG, group_id: id(500), category_id: id(100) }],
    selection_categories: categoryRows,
    selection_options: optionRows,
    selection_packages: Array.from({ length: 5 }, (_,i) => ({ id: id(300+i), org_id: ORG, community_id: i === 4 ? 'foreign-community' : null, name: `Package ${i}`, cost_cents: 600, price_cents: 1000, sort_order: 5-i, is_archived: i === 3, is_available: true })),
    selection_package_items: Array.from({ length: 15 }, (_,i) => ({ id: id(400+i), org_id: ORG, package_id: id(300+Math.floor(i/3)), option_id: id(200+i%12) })),
  }
  const reads = [], requestedOrgs = [], writes = [], audits = []
  const supabase = { from(table) {
    let rows = tables[table] ?? [], limit = 1000, cursor = null, mutation = null, payload = null
    const filters = []
    const query = {
      select() { return query },
      update(value) { mutation='update';payload=value;return query },
      insert(value) { mutation='insert';payload=value;return query },
      delete() { mutation='delete';return query },
      async single() { if(mutation==='update'&&!rows.length)return {data:null,error:{message:'scope mismatch'}};writes.push({table,mutation,payload,filters});return {data:{...(rows[0]??{id:id(550),is_archived:false}),...payload},error:null} },
      async maybeSingle() { reads.push({ table, cursor, filters }); return { data: rows[0] ?? null, error: communityError ? { message: communityError } : null } },
      eq(key,value) { filters.push([key,value]); rows = rows.filter(row => row[key] === value); return query },
      is(key,value) { rows = rows.filter(row => row[key] === value); return query },
      in(key,values) { rows = rows.filter(row => values.includes(row[key])); return query },
      or(value) { const terms = value.split(','); rows = rows.filter(row => terms.some(term => { const [key,op,val] = term.split('.'); return op === 'is' ? row[key] === null : row[key] === val })); return query },
      order(key) { rows = [...rows].sort((a,b) => a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0); return query },
      limit(value) { limit = value; return query },
      returns() { return query },
      gt(key,value) { cursor = value; rows = rows.filter(row => row[key] > value); return query },
      then(resolve,reject) { if(mutation){writes.push({table,mutation,payload,filters});return Promise.resolve({data:null,error:null}).then(resolve,reject)} reads.push({ table, cursor, filters }); return Promise.resolve({ data: rows.slice(0, Math.min(limit,rowCap)), error: errorTable === table && cursor ? { message: 'late page failed' } : null }).then(resolve,reject) },
    }
    return query
  } }
  const compiled = { exports: {} }
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(require.resolve('../lib/services/option-catalog.ts'),'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports: compiled.exports,
    require(name) {
      if (name === "@/lib/services/audit") return { recordAudit: async entry => audits.push(entry) }
      if (name === "zod") return require("zod")
      if (name === "@/lib/validation/selections") return require("../lib/validation/selections")
      if (name === "@/lib/drawings/model-options") return require("../lib/drawings/model-options")
      if (name === '@/lib/land/paging') return require('../lib/land/paging')
      if (name === '@/lib/services/authorization') return { getDivisionAccessForUser: async () => { if (accessError) throw new Error(accessError); return divisionAccess } }
      if (name === '@/lib/services/context') return { requireOrgContext: async orgId => { requestedOrgs.push(orgId); return { orgId: ORG, userId: id(3), supabase } } }
      if (name === '@/lib/services/permissions') return { requirePermission: async () => { if(permissionError)throw new Error(permissionError) }, hasPermission: async () => canReadMargin }
      return {}
    },
  })
  return { load: (opts,orgId) => compiled.exports.listCatalog(opts,orgId), groups: opts => compiled.exports.listSelectionGroups(opts), page: opts => compiled.exports.listSelectionGroupPage(opts), saveGroup: input => compiled.exports.upsertSelectionGroup(input), writes, audits, reads, requestedOrgs }
}

test('catalog exhausts short provider pages, restores display order and scopes package membership', async () => {
  const h = catalog(); const result = await h.load({ communityId: COMMUNITY })
  assert.equal(result.categories.length,5)
  assert.equal(result.categories.flatMap(row => row.options).length,12)
  assert.equal(result.categories[0].name,'Category 4')
  assert.equal(result.categories.find(row => row.id === id(100)).options[0].name,'Option 11')
  assert.equal(result.packages.length,3)
  assert.ok(result.packages.every(row => row.option_ids.length === 3))
  assert.ok(h.reads.filter(row => row.table === 'selection_options').length >= 5)
  assert.ok(h.reads.every(row => row.filters.some(([key,value]) => key === 'org_id' && value === ORG)))
})

test('catalog costs are omitted completely unless the caller may read margin', async () => {
  for (const canReadMargin of [false,true]) {
    const result = await catalog({ canReadMargin }).load()
    for (const row of [...result.categories.flatMap(row => row.options), ...result.packages]) {
      assert.equal(Object.hasOwn(row,'cost_cents'),canReadMargin)
    }
  }
})

test('community overrides remain effective across pages and archived overrides suppress their base', async () => {
  const base = { id: id(200), org_id: ORG, community_id: null, parent_option_id: null, category_id: id(100), name: 'Base', price_cents: 100, cost_cents: 50, sort_order: 1, is_archived: false }
  const options = [base,...Array.from({ length: 5 }, (_,i) => ({ ...base,id: id(201+i),name: `Other ${i}` })), { ...base,id: id(210),community_id: COMMUNITY,parent_option_id: base.id,is_archived: true }]
  const result = await catalog({ options }).load({ communityId: COMMUNITY })
  const rows = result.categories.flatMap(row => row.options)
  assert.equal(rows.length,5)
  assert.ok(!rows.some(row => row.id === base.id || row.id === id(210)))
})

test('late-page failures and catalog capacity overflow cannot masquerade as an empty or partial catalog', async () => {
  for (const errorTable of ['selection_categories','selection_options','selection_packages','selection_package_items']) {
    await assert.rejects(catalog({ errorTable, rowCap: 1 }).load(), /late page failed/)
  }
  const categories = Array.from({ length: 2001 }, (_,i) => ({ id: id(1000+i), org_id: ORG, community_id: null, parent_category_id: null, sort_order: i }))
  await assert.rejects(catalog({ categories, rowCap: 500 }).load(), /Catalog categories: Validation limit exceeded/)
})

test('catalog resolves an explicitly supplied organization instead of silently using the ambient one', async () => {
  const h = catalog()
  await h.load({},ORG)
  assert.deepEqual(h.requestedOrgs,[ORG])
})

test('category/package bootstrap omits every option read while retaining scoped package members and margin redaction',async()=>{
 const options=Array.from({length:10001},(_,n)=>({id:id(20000+n),org_id:ORG,community_id:null,category_id:id(100)}))
 const h=catalog({options,errorTable:'selection_options'}),result=await h.load({communityId:COMMUNITY,includeOptions:false})
 assert.equal(h.reads.filter(row=>row.table==='selection_options').length,0);assert.equal(result.categories.length,5);assert.ok(result.categories.every(row=>row.options.length===0));assert.equal(result.packages.length,3);assert.ok(result.packages.every(row=>row.option_ids.length===3&&!Object.hasOwn(row,'cost_cents')))
 await assert.rejects(catalog({options,rowCap:500}).load(),/Catalog options: Validation limit exceeded/)
})
test('catalog and cutoff groups reject inaccessible, missing, foreign and failed community scope before catalog reads',async()=>{
 for(const method of ['load','groups'])for(const change of [
  {divisionAccess:{assignedOnly:true,divisionIds:[]}},
  {divisionAccess:{assignedOnly:true,divisionIds:[id(91)]}},
  {communityRows:[]},
  {communityRows:[{id:COMMUNITY,org_id:id(99),division_id:id(90)}]},
  {communityError:'query failed'},
  {accessError:'assignment failed'},
 ]){
  const h=catalog(change);await assert.rejects(h[method]({communityId:COMMUNITY}),/division access|assignment failed/)
  assert.ok(h.reads.every(row=>row.table==='communities'));assert.ok(h.reads.every(row=>row.filters.some(([k,v])=>k==='org_id'&&v===ORG)))
 }
})
test('catalog and groups allow assigned communities and normalize UUIDs before scoped filters',async()=>{
 for(const method of ['load','groups']){
  const h=catalog({divisionAccess:{assignedOnly:true,divisionIds:[id(90)]}});const result=await h[method]({communityId:COMMUNITY.toUpperCase()});assert.ok(result)
  assert.ok(h.reads.some(row=>row.table==='communities'&&row.filters.some(([k,v])=>k==='id'&&v===COMMUNITY)))
 }
})
test('invalid community filter expressions are rejected before either reader touches the database',async()=>{
 for(const method of ['load','groups'])for(const communityId of ['not-a-uuid',`${COMMUNITY},community_id.not.is.null`]){
  const h=catalog();await assert.rejects(h[method]({communityId}));assert.equal(h.reads.length,0)
 }
})


test('catalog and cutoff-group read permission failures stop before community or catalog reads',async()=>{
 for(const method of ['load','groups']){
  const h=catalog({permissionError:'Missing permission: selections.read'});await assert.rejects(h[method]({communityId:COMMUNITY}),/Missing permission/);assert.equal(h.reads.length,0)
 }
})

const groupRows=count=>Array.from({length:count},(_,n)=>({id:id(500+n),org_id:ORG,community_id:null,name:`Rule ${n}`,schedule_task_key:'frame',cutoff_offset_days:-14,cutoff_anchor:'start',is_archived:false,sort_order:count-n}))
test('all cutoff rules are reachable over bounded seek pages even under short provider limits',async()=>{
 const rows=groupRows(131),h=catalog({groupRows:rows,rowCap:3}),seen=new Set();let cursor=null
 do{
  const page=await h.page({communityId:COMMUNITY,cursor});assert.ok(page.groups.length<=25);for(const group of page.groups){assert.ok(!seen.has(group.id));seen.add(group.id)}
  if(page.nextCursor)assert.equal(page.nextCursor,page.groups.at(-1).id);cursor=page.nextCursor
 }while(cursor)
 assert.equal(seen.size,131);assert.ok(h.reads.filter(row=>row.table==='selection_groups').length>44);assert.ok(h.reads.every(row=>row.filters.some(([k,v])=>k==='org_id'&&v===ORG)))
 const all=await h.groups({communityId:COMMUNITY});assert.equal(all.length,131);assert.equal(all[0].sort_order,1)
})
test('cutoff rule pages retain all 100 assigned category references and reject late-page read failures',async()=>{
 const links=Array.from({length:100},(_,n)=>({id:id(3000+n),org_id:ORG,group_id:id(500),category_id:id(4000+n)}))
 const h=catalog({groupRows:groupRows(1),groupLinks:links,rowCap:3}),page=await h.page();assert.equal(page.groups[0].category_ids.length,100);assert.equal(page.groups[0].category_ids.at(-1),id(4099))
 for(const errorTable of ['selection_groups','selection_group_categories'])await assert.rejects(catalog({groupRows:groupRows(40),groupLinks:links,rowCap:1,errorTable}).page(),/late page failed/)
 await assert.rejects(catalog({groupRows:groupRows(1),groupLinks:[...links,{...links[0],id:id(3999),category_id:id(4999)}]}).page(),/Validation limit exceeded|editable bound/)
})
test('cutoff group continuations reject malformed identifiers before any database call',async()=>{
 const h=catalog();await assert.rejects(h.page({cursor:'not-a-uuid'}));assert.equal(h.reads.length,0)
})

const groupInput={id:id(500),name:'Reviewed rule',scheduleTaskKey:'frame',cutoffOffsetDays:-14,categoryIds:[]}
test('cutoff rule edits cannot relocate an org rule into a community or mutate archived targets',async()=>{
 for(const change of [{communityId:COMMUNITY},{communityId:null,archived:true}]){
  const rows=groupRows(1);if(change.archived)rows[0].is_archived=true;const h=catalog({groupRows:rows});await assert.rejects(h.saveGroup({...groupInput,communityId:change.communityId}),/scope mismatch/);assert.equal(h.writes.length,0);assert.equal(h.audits.length,0)
 }
 const h=catalog({groupRows:groupRows(1)}),saved=await h.saveGroup({...groupInput,communityId:null});assert.equal(saved.community_id,null);assert.ok(!Object.hasOwn(h.writes[0].payload,'community_id'));assert.ok(h.writes[0].filters.some(([k,v])=>k==='is_archived'&&v===false));assert.equal(h.audits.length,1)
})
test('cutoff rule writes enforce current division scope before every create/update or category replacement',async()=>{
 for(const existing of [true,false]){
  const h=catalog({divisionAccess:{assignedOnly:true,divisionIds:[]}});await assert.rejects(h.saveGroup({...groupInput,id:existing?id(500):null,communityId:COMMUNITY}),/division access/);assert.equal(h.writes.length,0);assert.equal(h.audits.length,0)
 }
 const rows=groupRows(1);rows[0].community_id=COMMUNITY;const h=catalog({groupRows:rows,divisionAccess:{assignedOnly:true,divisionIds:[id(90)]}});const saved=await h.saveGroup({...groupInput,communityId:COMMUNITY.toUpperCase()});assert.equal(saved.community_id,COMMUNITY);assert.equal(h.writes[0].filters.find(([k])=>k==='community_id')[1],COMMUNITY)
})

test('rule category validation rejects foreign, missing, archived and wrong-scope references before any write',async()=>{
 const base={id:id(100),org_id:ORG,community_id:null,parent_category_id:null,is_archived:false}
 for(const category of [null,{...base,org_id:id(99)},{...base,is_archived:true},{...base,community_id:id(99)},{...base,parent_category_id:id(200)}]){
  const h=catalog({groupRows:groupRows(1),categories:category?[category]:[]});await assert.rejects(h.saveGroup({...groupInput,categoryIds:[id(100)]}),/original organization\/community scope/);assert.equal(h.writes.length,0);assert.equal(h.audits.length,0)
 }
 const h=catalog({categories:[base]});await assert.rejects(h.saveGroup({...groupInput,categoryIds:[id(100),id(100)]}),/unique/);assert.equal(h.reads.length,0)
})
test('rule category ancestry must resolve an active org root and short provider pages retain all selected references',async()=>{
 const base={id:id(100),org_id:ORG,community_id:null,parent_category_id:null,is_archived:false},child={...base,id:id(101),community_id:COMMUNITY,parent_category_id:id(100)}
 for(const root of [null,{...base,org_id:id(99)},{...base,community_id:COMMUNITY},{...base,parent_category_id:id(300)},{...base,is_archived:true}]){
  const h=catalog({categories:[child,...(root?[root]:[])]});await assert.rejects(h.saveGroup({...groupInput,id:null,communityId:COMMUNITY,categoryIds:[id(101)]}),/ancestry/);assert.equal(h.writes.length,0)
 }
 const rows=Array.from({length:100},(_,n)=>({...base,id:id(1000+n)})),h=catalog({categories:rows,rowCap:3});const saved=await h.saveGroup({...groupInput,categoryIds:rows.map(r=>r.id)});assert.equal(saved.category_ids.length,100);assert.equal(h.writes.find(w=>w.table==='selection_group_categories'&&w.mutation==='insert').payload.length,100)
 const valid=catalog({categories:[base,child]});assert.equal((await valid.saveGroup({...groupInput,id:null,communityId:COMMUNITY,categoryIds:[id(101)]})).category_ids[0],id(101))
})


test('rule requests carrying a changed org or actor cannot create headers or replace categories',async()=>{
 for(const identity of [{expectedOrgId:id(99)},{expectedActorId:id(99)}]){
  const h=catalog();await assert.rejects(h.saveGroup({...groupInput,id:null,...identity}),/organization or actor changed/);assert.equal(h.writes.length,0);assert.equal(h.reads.length,0)
 }
})


test('public rule action requires original actor/org identities before dispatching its service',async()=>{
 const compiled={exports:{}},calls=[]
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('app/(app)/design-studio/actions.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:compiled.exports,require(name){
  if(name==='zod')return require('zod');if(name==='@/lib/validation/selections')return require('../lib/validation/selections');if(name==='@/lib/action-result')return require('../lib/action-result');if(name==='next/cache')return {revalidatePath(){}};if(name==='@/lib/services/option-catalog')return {upsertSelectionGroup:async input=>{calls.push(input);return {community_id:null}}};return {}
 }})
 for(const identity of [{},{expectedOrgId:ORG},{expectedActorId:id(3)},{expectedOrgId:null,expectedActorId:id(3)}])assert.equal((await compiled.exports.upsertSelectionGroupAction({...groupInput,...identity})).success,false)
 assert.equal(calls.length,0);assert.equal((await compiled.exports.upsertSelectionGroupAction({...groupInput,expectedOrgId:ORG,expectedActorId:id(3)})).success,true);assert.equal(calls.length,1)
})

test('atomic rule bootstrap skips both category and option scans while retaining package references',async()=>{
 const categories=Array.from({length:2001},(_,i)=>({id:id(1000+i),org_id:ORG,community_id:null,parent_category_id:null,sort_order:i}));const h=catalog({categories});const result=await h.load({includeCategories:false,includeOptions:false})
 assert.equal(result.categories.length,0);assert.equal(result.packages.length,3);assert.ok(!h.reads.some(row=>['selection_categories','selection_options'].includes(row.table)));assert.ok(h.reads.some(row=>row.table==='selection_package_items'))
})
