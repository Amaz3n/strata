require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {createFakeSupabase}=require('./support/fake-supabase'),{stubModule,ORG,ACTOR,PROJECT}=require('./support/starts-harness')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const date='2026-10-05T12:00:00+00:00'
const incident=n=>({id:id(100+n),org_id:ORG,project_id:PROJECT,created_at:date,updated_at:date,incident_number:n,occurred_at:date,severity:'near_miss',description:`Incident ${n}`,status:n%2?'open':'closed',location:null,location_id:null})
const observation=n=>({id:id(10000+n),org_id:ORG,project_id:PROJECT,created_at:date,observation_number:n,kind:'safety',description:`Observation ${n}`,status:n%2?'open':'resolved'})
const talk=n=>({id:id(20000+n),org_id:ORG,project_id:PROJECT,created_at:date,held_at:'2026-10-05',topic:`Toolbox ${n}`,attendees:[]})
function harness({count=0,denyRead=false,denyWrite=false,failure,providerCap,moveOnWrite=false}={}) {
 const db=createFakeSupabase({safety_incidents:Array.from({length:count},(_,i)=>incident(i+1)),observations:Array.from({length:count},(_,i)=>observation(i+1)),toolbox_talks:Array.from({length:count},(_,i)=>talk(i+1)),companies:[],files:[]})
 const calls=[],gates=[],events=[],audits=[],from=db.from.bind(db)
 db.from=table=>{const q=from(table),run=q.run.bind(q)
  q.ilike=(column,pattern)=>{const literal=pattern.slice(1,-1).replace(/\\([\\%_])/g,'$1').toLowerCase();return q.addFilter(row=>String(row[column]??'').toLowerCase().includes(literal))}
  q.run=()=>{
   calls.push({table,action:q.action,head:q.head,limit:q.limitValue})
   if(failure===table)return {data:null,error:{message:'Source unavailable'}}
   if(moveOnWrite&&['update','delete'].includes(q.action))db.store[table][0].project_id=id(99)
   const result=run()
   if(q.action==='select'&&Array.isArray(result.data)&&providerCap)result.data=result.data.slice(0,providerCap)
   if(q.action==='update'&&q.cardinality==='single')return result.data?.length===1?{...result,data:result.data[0]}:{data:null,error:{message:'Record changed'}}
   return result
  };return q}
 const context={supabase:db,orgId:ORG,userId:ACTOR}
 stubModule('@/lib/services/context',{requireOrgContext:async()=>context})
 stubModule('@/lib/services/permissions',{requirePermission:async permission=>gates.push({level:'org',permission})})
 stubModule('@/lib/services/authorization',{requireAuthorization:async input=>{gates.push(input);if(input.permission==='safety.read'&&denyRead||input.permission==='safety.write'&&denyWrite)throw Error('Home denied')}})
 stubModule('@/lib/services/events',{recordEvent:async input=>events.push(input)})
 stubModule('@/lib/services/audit',{recordAudit:async input=>audits.push(input)})
 stubModule('@/lib/services/locations',{resolveProjectLocation:async()=>null})
 stubModule('@/lib/services/project-sequence',{insertWithProjectNumberRetry:async input=>{
  const result=await db.from(input.table).insert({id:id(90000+events.length),created_at:date,updated_at:date,status:'open',[input.numberColumn]:1,...input.payload}).select(input.select).single()
  if(result.error)throw Error(result.error.message);return {data:result.data}
 }})
 delete require.cache[require.resolve('../lib/services/safety')]
 return {...require('../lib/services/safety'),db,calls,gates,events,audits,context}
}
const writes=h=>h.calls.filter(c=>c.action!=='select')
test('all original read collections and workspace deny actual-home access before data lookup',async()=>{
 for(const fn of ['listSafetyIncidents','listToolboxTalks','listObservations','getSafetyWorkspace']){const h=harness({denyRead:true});await assert.rejects(h[fn](PROJECT),/Home denied/);assert.equal(h.calls.length,0);assert.equal(h.gates.at(-1).projectId,PROJECT)}
})
test('production workspace reaches all late pages and complete totals with bounded records',async()=>{
 const h=harness({count:117});let cursor,seen=new Set(),pages=0
 do{const page=await h.getSafetyWorkspace(PROJECT,{after:cursor});assert.equal(page.total,351);assert.ok(page.incidents.length<=50&&page.talks.length<=50&&page.observations.length<=50);for(const row of [...page.incidents,...page.observations,...page.talks]){assert.ok(!seen.has(row.id));seen.add(row.id)}cursor=page.nextAfter;pages++}while(cursor)
 assert.equal(seen.size,351);assert.equal(pages,3);assert.equal(writes(h).length,0)
})
test('provider cap below requested page size cannot falsely end discovery',async()=>{
 const h=harness({count:31,providerCap:7});let after,seen=[]
 do{const p=await h.getSafetyWorkspace(PROJECT,{type:'incident',after});seen.push(...p.incidents.map(r=>r.id));after=p.nextAfter}while(after)
 assert.equal(seen.length,31);assert.equal(new Set(seen).size,31)
})
test('server search/type/status affect both records and exact authorized totals',async()=>{
 const h=harness({count:123});h.db.store.safety_incidents.push({...incident(999),org_id:id(99)})
 const p=await h.getSafetyWorkspace(PROJECT,{q:'Incident 11',type:'incident',status:'closed'})
 assert.equal(p.total,5);assert.equal(p.incidents.length,5);assert.equal(p.talks.length,0);assert.equal(p.observations.length,0)
 assert.ok(p.incidents.every(r=>r.status==='closed'&&r.description.includes('Incident 11')))
})
test('changed actor/home/filter rejects stale cursors before any source queries',async()=>{
 const h=harness({count:60}),p=await h.getSafetyWorkspace(PROJECT,{type:'incident'});h.calls.length=0
 await assert.rejects(h.getSafetyWorkspace(id(98),{type:'incident',after:p.nextAfter}),/Restart/)
 await assert.rejects(h.getSafetyWorkspace(PROJECT,{q:'new',type:'incident',after:p.nextAfter}),/Restart/)
 h.context.userId=id(97);await assert.rejects(h.getSafetyWorkspace(PROJECT,{type:'incident',after:p.nextAfter}),/Restart/)
 assert.equal(h.calls.length,0)
})
test('selected incidents and talks remain reachable outside current page but reject another home',async()=>{
 const h=harness({count:80}),p=await h.getSafetyWorkspace(PROJECT)
 assert.ok(!p.incidents.some(r=>r.id===incident(1).id))
 assert.equal((await h.getSafetyRecord(PROJECT,'incident',incident(1).id)).data.id,incident(1).id)
 assert.equal((await h.getSafetyRecord(PROJECT,'talk',talk(1).id)).data.topic,'Toolbox 1')
 assert.equal(await h.getSafetyRecord(id(99),'incident',incident(1).id),null)
})
test('source failure is never an empty page or zero count',async()=>{
 const h=harness({failure:'observations'});await assert.rejects(h.getSafetyWorkspace(PROJECT),/Source unavailable/)
 await assert.rejects(h.listObservations(PROJECT),/Source unavailable/)
 assert.equal(writes(h).length,0)
})
test('legacy reports and mobile reads exhaust source pages beyond old 250/500 ceilings',async()=>{
 const h=harness({count:1007,providerCap:17})
 for(const fn of ['listSafetyIncidents','listToolboxTalks','listObservations'])assert.equal((await h[fn](PROJECT)).length,1007)
 assert.equal(writes(h).length,0)
})
test('create paths deny actual home before inserting or reserving numbers',async()=>{
 const fixtures=[['createSafetyIncident',{project_id:PROJECT,description:'Near miss',severity:'near_miss',occurred_at:date}],['createObservation',{project_id:PROJECT,kind:'safety',description:'Unsafe access'}],['createToolboxTalk',{project_id:PROJECT,topic:'Ladder safety',held_at:'2026-10-05'}]]
 for(const [fn,input] of fixtures){const h=harness({denyWrite:true});await assert.rejects(h[fn](input),/Home denied/);assert.equal(h.calls.length,0);assert.equal(h.events.length,0)}
})
test('create investigation/resolve and talk deletion use original owners and actual home authority',async()=>{
 const h=harness();const i=await h.createSafetyIncident({project_id:PROJECT,occurred_at:date,severity:'lost_time',description:'Incident'});assert.deepEqual(h.events.map(e=>e.eventType),['safety_incident_reported','safety_incident_alert'])
 assert.equal((await h.updateSafetyIncident(i.id,{status:'closed',root_cause:'Investigation recorded'},undefined,PROJECT)).status,'closed')
 const o=await h.createObservation({project_id:PROJECT,kind:'quality',description:'Correction needed'});assert.equal((await h.updateObservation(o.id,{status:'resolved'},undefined,PROJECT)).status,'resolved')
 const t=await h.createToolboxTalk({project_id:PROJECT,held_at:'2026-10-05',topic:'Briefing'});await h.deleteToolboxTalk(t.id,undefined,PROJECT);assert.equal(h.db.store.toolbox_talks.length,0)
 assert.ok(h.audits.some(a=>a.entityType==='toolbox_talk'&&a.action==='delete'))
})
test('wrong expected workbench home, denied writes and parent movement cannot update/delete another home',async()=>{
 for(const operation of ['updateSafetyIncident','updateObservation','deleteToolboxTalk']){
  const h=harness({count:1});const record=operation==='updateSafetyIncident'?incident(1):operation==='updateObservation'?observation(1):talk(1)
  const args=operation==='deleteToolboxTalk'?[record.id,undefined,id(99)]:[record.id,{status:operation==='updateSafetyIncident'?'closed':'resolved'},undefined,id(99)]
  await assert.rejects(h[operation](...args),/another home/);assert.equal(writes(h).length,0)
  const moved=harness({count:1,moveOnWrite:true});const good=operation==='deleteToolboxTalk'?[record.id,undefined,PROJECT]:[record.id,{description:'Unauthorized overwrite'},undefined,PROJECT]
  await assert.rejects(moved[operation](...good),/changed|delete/)
 }
})
test('foreign company and evidence references cannot be recorded',async()=>{
 const h=harness();await assert.rejects(h.createSafetyIncident({project_id:PROJECT,description:'Incident',severity:'near_miss',occurred_at:date,involved_company_id:id(99)}),/company/)
 h.db.store.files=[{id:id(99),org_id:ORG,project_id:id(98)}]
 await assert.rejects(h.createToolboxTalk({project_id:PROJECT,held_at:'2026-10-05',topic:'Briefing',file_id:id(99)}),/home/)
 assert.equal(writes(h).length,0)
})
test('real Supabase transport reapplies actual-home filters to page, totals and exhaustion probe',async()=>{
 const {createClient}=require('@supabase/supabase-js');harness();const calls=[]
 const supabase=createClient('https://safety-fixture.invalid','isolated-key',{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:async(url,options)=>{
  const u=new URL(url),method=options.method??'GET',table=u.pathname.split('/').pop();calls.push({u,method,headers:new Headers(options.headers)})
  if(method==='HEAD')return new Response(null,{status:200,headers:{'content-range':`*/${table==='safety_incidents'?1:0}`}})
  const data=table==='safety_incidents'&&!u.searchParams.has('or')?[incident(1)]:[]
  return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}})
 }}})
 stubModule('@/lib/services/context',{requireOrgContext:async()=>({supabase,orgId:ORG,userId:ACTOR})});delete require.cache[require.resolve('../lib/services/safety')]
 const p=await require('../lib/services/safety').getSafetyWorkspace(PROJECT,{q:'Incident',type:'all',status:'all'})
 assert.equal(p.total,1);assert.equal(p.incidents.length,1);assert.equal(p.nextAfter,null)
 assert.equal(calls.length,7)
 for(const {u,method,headers} of calls){assert.equal(u.hostname,'safety-fixture.invalid');assert.equal(u.searchParams.get('org_id'),`eq.${ORG}`);assert.equal(u.searchParams.get('project_id'),`eq.${PROJECT}`);if(method==='HEAD')assert.match(headers.get('prefer'),/count=exact/)}
 assert.ok(calls.some(c=>c.u.searchParams.get('limit')==='1'&&c.u.searchParams.has('or')))
 assert.equal(calls.filter(c=>c.method==='GET'&&c.u.searchParams.get('limit')==='51').length,3)
})
test('project posture controls production safety in mixed orgs, with consistent web/module/native exposure',()=>{
 const {buildProjectNavGroups}=require('../components/layout/project-nav-items'),{PROJECT_MODULES}=require('../lib/project-modules'),{workspaceModules}=require('../lib/mobile/workspace-catalog')
 const items=(posture,orgTier,overrides={})=>buildProjectNavGroups({projectId:PROJECT,section:'safety',orgTier,project:{id:PROJECT,org_id:ORG,property_type:posture,module_overrides:overrides,financial_settings:{}}}).flatMap(g=>g.items.flatMap(i=>[i,...(i.items??[])]))
 assert.ok(items('production','residential').some(i=>i.moduleKey==='safety'))
 assert.ok(items('commercial','production').some(i=>i.moduleKey==='safety'))
 assert.ok(!items('residential','production').some(i=>i.moduleKey==='safety'))
 assert.ok(!items('production','production',{safety:false}).some(i=>i.moduleKey==='safety'))
 assert.ok(PROJECT_MODULES.find(m=>m.key==='safety').postures.includes('production'))
 const native=workspaceModules.find(m=>m.id==='safety');assert.ok(native.postures.includes('production'));assert.deepEqual(native.titleKeys,['description']);assert.ok(native.fields.some(f=>f.key==='occurred_at'));assert.ok(native.fields.some(f=>f.key==='immediate_action'));assert.ok(native.fields.some(f=>f.key==='root_cause'));assert.ok(!native.fields.some(f=>f.key==='due_date'))
})
test('severity escalation uses the original serious-incident event without repeat alerts on unchanged severity',async()=>{
 const h=harness({count:1});await h.updateSafetyIncident(incident(1).id,{severity:'lost_time'},undefined,PROJECT)
 assert.equal(h.events.length,1);assert.equal(h.events[0].eventType,'safety_incident_alert');assert.equal(h.events[0].payload.project_id,PROJECT)
 await h.updateSafetyIncident(incident(1).id,{severity:'lost_time',root_cause:'Investigated'},undefined,PROJECT)
 assert.equal(h.events.length,1)
})
test('talk list summaries omit large private attendance/note payloads while selected detail retains them',async()=>{
 const h=harness({count:1});h.db.store.toolbox_talks[0].attendees=Array.from({length:500},(_,i)=>({name:`Attendee ${i}`,company:'Trade'}));h.db.store.toolbox_talks[0].notes='Full signed briefing evidence';h.db.store.toolbox_talks[0].attendee_count=500
 const p=await h.getSafetyWorkspace(PROJECT,{type:'talk'})
 assert.equal(p.talks[0].attendee_count,500);assert.ok(!('attendees' in p.talks[0]));assert.ok(!('notes' in p.talks[0]))
 const selected=await h.getSafetyRecord(PROJECT,'talk',talk(1).id);assert.equal(selected.data.attendees.length,500);assert.equal(selected.data.notes,'Full signed briefing evidence')
})
