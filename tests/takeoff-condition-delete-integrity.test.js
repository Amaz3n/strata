require('../scripts/register-ts-node-test')
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), ts = require('typescript')
const { createFakeSupabase } = require('./support/fake-supabase')
const validation = require('../lib/validation/takeoff'), measure = require('../lib/drawings/measure')
const { CONDITION_COLORS } = require('../lib/drawings/takeoff-palette')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ORG=id(1), FOREIGN=id(2), ACTOR=id(3), CONDITION=id(4), PROJECT=id(5), VERSION=id(6), PLAN=id(7), DIVISION=id(8), CODE=id(9), CREATOR=id(10)
const SEEN='2026-10-04T12:00:00.123456+00:00', LATER='2026-10-04T13:00:00.654321+00:00'
const original={id:CONDITION,org_id:ORG,project_id:PROJECT,house_plan_version_id:null,name:'Wall',uom:'sf',depth_in:null,height_ft:null,pitch_rise:null,tons_per_cy:null,cost_code_id:CODE,color:CONDITION_COLORS[0],waste_pct:8,unit_cost_cents:12345,share_with_clients:true,notes:'Original',sort_order:4,created_by:CREATOR,created_at:SEEN,updated_at:SEEN}
function fixture(options={}) {
 const source=fs.readFileSync('lib/services/takeoff.ts','utf8')+'\n'+fs.readFileSync('lib/services/takeoff-scope.ts','utf8'), ast=ts.createSourceFile('takeoff.ts',source,ts.ScriptTarget.Latest,true)
 const names=['numericOrNull','mapCondition','deleteTakeoffCondition','markSyncedLinesDetached','requireTakeoffWriteScope','requireTakeoffCostCodes']
 const selected=ast.statements.filter(n=>(ts.isFunctionDeclaration(n)&&names.includes(n.name?.text))||(ts.isVariableStatement(n)&&n.declarationList.declarations.some(v=>['CONDITION_SELECT','STALE_WRITE'].includes(v.name.getText(ast))))).map(n=>n.getText(ast)).join('\n')
 const db=createFakeSupabase({takeoff_conditions:options.rows??[{...original,...options.existing}],cost_codes:options.codes??[{id:CODE,org_id:ORG,is_active:false}],house_plan_versions:options.versions??[{id:VERSION,org_id:ORG,house_plan_id:PLAN}],house_plans:options.plans??[{id:PLAN,org_id:ORG,division_id:DIVISION}],drawing_markups:options.markups??[]}),calls=[],audits=[]
 const supabase={rpc:async(name,args)=>{calls.push({rpc:name,args});return {data:Object.hasOwn(options,'detachCount')?options.detachCount:2,error:options.detachError?{message:'Detach unavailable'}:null}},from:table=>{
  if(table==='drawing_markups'&&options.httpRelease)return options.httpRelease.from(table)
  const q=db.from(table),run=q.run.bind(q),update=q.update.bind(q)
  let mutationOptions
  q.update=(payload,settings)=>{mutationOptions=settings;return update(payload)}
  q.run=()=>{
   calls.push({table,action:q.action,payload:q.payload})
   if(table==='takeoff_conditions'&&q.action==='delete'&&options.race){if(options.race==='removed')db.store[table].splice(0);else db.store[table][0].updated_at=LATER}
   const result=run()
   if(q.action==='select'){
    if(options.errorTable===table)result.error={message:'Unavailable read'}
    if(options.nullTable===table)result.data=null
    if(table==='takeoff_conditions'&&Object.hasOwn(options,'readData'))result.data=options.readData
    if(table==='drawing_markups'&&Object.hasOwn(options,'count'))result.count=options.count
   }
   if(q.action==='update'&&table==='drawing_markups'){
    assert.deepEqual(mutationOptions,{count:'exact'});result.count=Array.isArray(result.data)?result.data.length:null
    if(Object.hasOwn(options,'releaseCount'))result.count=options.releaseCount
    if(Object.hasOwn(options,'releaseReply'))result.data=options.releaseReply
    if(options.releaseError)result.error={message:'Release unavailable'}
   }
   if(q.action==='delete'){
    if(Array.isArray(result.data))result.data=result.data.length===1?result.data[0]:null
    if(Object.hasOwn(options,'reply'))result.data=options.reply
    if(options.rewrite&&result.data)result.data={...result.data,...options.rewrite}
    if(options.writeError)result.error={message:'Delete unavailable'}
   }
   return result
  };return q
 }}
 const exports={},js=ts.transpileModule(selected,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
 new Function('exports','requireOrgContext','requirePermission','requireAuthorization','getDivisionAccessForUser','recordAudit','updateTakeoffConditionSchema','takeoffConditionMutationTargetSchema','takeoffConditionScopeSchema','factorRuleViolation','conditionSourceUom','MEASURE_UOM_LABELS',js)(exports,
 async()=>{calls.push({context:true});return {supabase,orgId:ORG,userId:ACTOR}},async(permission,context)=>{assert.equal(permission,'takeoff.write');assert.equal(context.userId,ACTOR);if(options.denied)throw Error('Forbidden')},async request=>{calls.push({authorization:request});assert.equal(request.orgId,ORG);assert.equal(request.userId,ACTOR);assert.equal(request.permission,'takeoff.write');assert.equal(request.logDecision,true);assert.equal(request.supabase,supabase);if(options.projectDenied||request.projectId!==PROJECT)throw Error('Project unavailable')},async()=>options.divisions??{assignedOnly:false,divisionIds:[]},async args=>audits.push(args),validation.updateTakeoffConditionSchema,validation.takeoffConditionMutationTargetSchema,validation.takeoffConditionScopeSchema,validation.factorRuleViolation,measure.conditionSourceUom,measure.MEASURE_UOM_LABELS)
 return {...exports,calls,audits,store:db.store}
}
function noEffects(h){assert.ok(!h.calls.some(c=>c.action==='update'||c.action==='delete'||c.rpc));assert.deepEqual(h.audits,[])}
for(const [target,stamp] of [['invalid',undefined],[CONDITION,'invalid'],[CONDITION,42]])test('invalid delete target before context '+JSON.stringify([target,stamp]),async()=>{const h=fixture();await assert.rejects(h.deleteTakeoffCondition(target,undefined,stamp));assert.deepEqual(h.calls,[])})
for(const options of [{denied:true},{errorTable:'takeoff_conditions'},{rows:[]},{nullTable:'takeoff_conditions'},{readData:{...original,org_id:FOREIGN}},{readData:{...original,id:id(99)}},{existing:{updated_at:null}},{existing:{updated_at:'invalid'}},{projectDenied:true},{existing:{project_id:id(99)}},{existing:{project_id:null,house_plan_version_id:null}},{existing:{house_plan_version_id:VERSION}}])test('unavailable/unauthorized condition cannot begin detach '+JSON.stringify(options),async()=>{const h=fixture(options);await assert.rejects(h.deleteTakeoffCondition(CONDITION));noEffects(h)})
test('stale confirmation revision refuses before all effects',async()=>{const h=fixture();await assert.rejects(h.deleteTakeoffCondition(CONDITION,undefined,LATER),e=>e.message===h.STALE_WRITE);noEffects(h)})
for(const count of [null,undefined,-1,0.5,'0',NaN,Infinity])test('unknown detach result cannot become successful zero '+String(count),async()=>{const h=fixture({detachCount:count});await assert.rejects(h.deleteTakeoffCondition(CONDITION),/Detached condition lines could not be confirmed/);assert.ok(!h.calls.some(c=>c.action==='update'||c.action==='delete'));assert.deepEqual(h.audits,[])})
test('detach RPC failure surfaces before release/delete',async()=>{const h=fixture({detachError:true});await assert.rejects(h.deleteTakeoffCondition(CONDITION),/Detach unavailable/);assert.ok(!h.calls.some(c=>c.action==='update'||c.action==='delete'));assert.deepEqual(h.audits,[])})
const released={id:id(30),org_id:ORG,condition_id:null}
for(const releaseReply of [null,undefined,[released,released],[{...released,id:''}],[{...released,org_id:FOREIGN}],[{...released,condition_id:CONDITION}]])test('unconfirmed release response cannot authorize final deletion '+JSON.stringify(releaseReply),async()=>{const h=fixture({releaseReply});await assert.rejects(h.deleteTakeoffCondition(CONDITION),/Released condition measurements could not be confirmed/);assert.ok(!h.calls.some(c=>c.action==='delete'));assert.deepEqual(h.audits,[])})
test('release failure surfaces and does not delete condition',async()=>{const h=fixture({releaseError:true});await assert.rejects(h.deleteTakeoffCondition(CONDITION),/Release unavailable/);assert.ok(!h.calls.some(c=>c.action==='delete'));assert.deepEqual(h.audits,[])})
for(const race of ['changed','removed'])for(const stamp of [undefined,SEEN])test('final delete revision fences '+race+' caller '+stamp+' but prior effects still require atomic recovery',async()=>{const h=fixture({race,markups:[{...released,condition_id:CONDITION}]});await assert.rejects(h.deleteTakeoffCondition(CONDITION,undefined,stamp),e=>e.message===h.STALE_WRITE);assert.deepEqual(h.audits,[]);assert.equal(h.store.drawing_markups[0].condition_id,null);if(race==='changed')assert.equal(h.store.takeoff_conditions[0].updated_at,LATER)})
for(const rewrite of [{id:id(99)},{org_id:FOREIGN},{updated_at:LATER}])test('divergent removed row cannot produce success audit '+JSON.stringify(rewrite),async()=>{const h=fixture({rewrite});await assert.rejects(h.deleteTakeoffCondition(CONDITION),/Deleted takeoff condition could not be confirmed/);assert.deepEqual(h.audits,[])})
for(const options of [{reply:null},{writeError:true}])test('missing/failed final delete cannot audit '+JSON.stringify(options),async()=>{const h=fixture(options);await assert.rejects(h.deleteTakeoffCondition(CONDITION));assert.deepEqual(h.audits,[])})
test('confirmed zero detach/empty release reports true zero and current actor',async()=>{const h=fixture({detachCount:0}),result=await h.deleteTakeoffCondition(CONDITION,undefined,SEEN);assert.deepEqual(result,{released_markups:0,detached_lines:0});assert.equal(h.audits[0].actorId,ACTOR);assert.equal(h.audits[0].before.updated_at,SEEN);assert.equal(h.store.takeoff_conditions.length,0)})
test('exact own condition releases own members only, keeps geometry and counts original detachment',async()=>{const h=fixture({markups:[{...released,condition_id:CONDITION,data:{points:[1,2]}},{id:id(31),org_id:FOREIGN,condition_id:CONDITION},{id:id(32),org_id:ORG,condition_id:id(99)}]}),result=await h.deleteTakeoffCondition(CONDITION);assert.deepEqual(result,{released_markups:1,detached_lines:2});assert.deepEqual(h.store.drawing_markups[0].data,{points:[1,2]});assert.equal(h.store.drawing_markups[1].condition_id,CONDITION);assert.equal(h.store.drawing_markups[2].condition_id,id(99));assert.deepEqual(h.calls.find(c=>c.rpc),{rpc:'detach_takeoff_condition_lines',args:{p_org_id:ORG,p_condition_id:CONDITION}})})
for(const options of [{versions:[]},{plans:[{id:PLAN,org_id:FOREIGN,division_id:DIVISION}]},{divisions:{assignedOnly:true,divisionIds:[id(99)]}}])test('plan delete requires own parent/division '+JSON.stringify(options),async()=>{const h=fixture({...options,existing:{project_id:null,house_plan_version_id:VERSION}});await assert.rejects(h.deleteTakeoffCondition(CONDITION),/unavailable/);noEffects(h)})
test('own assigned and original unscoped production plans permit confirmed deletion',async()=>{for(const division_id of [DIVISION,null]){const h=fixture({existing:{project_id:null,house_plan_version_id:VERSION},plans:[{id:PLAN,org_id:ORG,division_id}],divisions:{assignedOnly:true,divisionIds:[DIVISION]}});await h.deleteTakeoffCondition(CONDITION);assert.equal(h.audits[0].before.house_plan_version_id,VERSION)}})
const React=require('react')
function nodes(node){return Array.isArray(node)?node.flatMap(nodes):React.isValidElement(node)?[node,...nodes(node.props.children)]:[]}
for(const [canWrite,busy] of [[true,false],[false,false],[true,true]])test('actual ledger delete confirmation uses reviewed revision and guards readonly/inflight '+JSON.stringify([canWrite,busy]),async()=>{
 let index=0;const states=[null,null,{condition:original,markup_count:0,sync:null},busy,false,false,false],calls=[],modules={react:{...React,useState:()=>[states[index++],()=>{}],useMemo:fn=>fn(),useCallback:fn=>fn},'react/jsx-runtime':require('react/jsx-runtime'),sonner:{toast:{success(){},error(){}}},'@/lib/action-result':{unwrapAction:r=>r.data},'./estimate-handoff':{pendingHandoffCount:()=>0},'@/app/(app)/drawings/takeoff-actions':{deleteTakeoffConditionAction:async(...args)=>{calls.push(args);return {success:true,data:{released_markups:0,detached_lines:0}}}}},leaves=new Proxy({},{get:(_,key)=>String(key)}),exports={}
 const js=ts.transpileModule(fs.readFileSync('components/drawings/workspace/takeoff-ledger.tsx','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText
 new Function('exports','require',js)(exports,key=>modules[key]??leaves)
 const tree=nodes(exports.TakeoffLedger({rollups:[],error:null,onRetry(){},scope:{project_id:PROJECT},canWrite,activeSheetId:id(50),armedId:null,onArm(){},onHover(){},onChanged(){},onNewItem(){},onOpenSheet(){},onSendToEstimate(){}})),action=tree.find(n=>n.type==='AlertDialogAction')
 assert.equal(action.props.disabled,busy||!canWrite);action.props.onClick({preventDefault(){}});await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(calls,canWrite&&!busy?[[CONDITION,SEEN]]:[])
})
test('original thin action forwards revision to same service',async()=>{const source=fs.readFileSync('app/(app)/drawings/takeoff-actions.ts','utf8'),ast=ts.createSourceFile('actions.ts',source,ts.ScriptTarget.Latest,true),selected=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='deleteTakeoffConditionAction'),exports={},calls=[];const js=ts.transpileModule(selected.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;new Function('exports','run','deleteTakeoffCondition',js)(exports,fn=>fn(),async(...args)=>calls.push(args));await exports.deleteTakeoffConditionAction(CONDITION,SEEN);assert.deepEqual(calls,[[CONDITION,undefined,SEEN]])})
for(const releaseCount of [null,undefined,-1,0.5,'0',NaN,Infinity,1])test('unknown or inconsistent exact released count prevents final delete '+String(releaseCount),async()=>{const h=fixture({releaseCount});await assert.rejects(h.deleteTakeoffCondition(CONDITION),/Released condition measurements could not be confirmed/);assert.ok(!h.calls.some(c=>c.action==='delete'));assert.deepEqual(h.audits,[])})
test('truncated returned member list cannot underreport a committed bulk release',async()=>{const markups=Array.from({length:1500},(_,i)=>({id:id(1000+i),org_id:ORG,condition_id:CONDITION})),h=fixture({markups,releaseCount:1500,releaseReply:markups.slice(0,37).map(m=>({...m,condition_id:null}))});await assert.rejects(h.deleteTakeoffCondition(CONDITION),/Released condition measurements could not be confirmed/);assert.ok(!h.calls.some(c=>c.action==='delete'));assert.deepEqual(h.audits,[]);assert.ok(h.store.drawing_markups.every(m=>m.condition_id===null),'committed release still requires original atomic recovery')})
test('complete large response preserves actual released member count',async()=>{const markups=Array.from({length:1500},(_,i)=>({id:id(1000+i),org_id:ORG,condition_id:CONDITION})),h=fixture({markups});assert.equal((await h.deleteTakeoffCondition(CONDITION)).released_markups,1500)})
for(const total of [2,1500,null])test('installed Supabase PATCH transport parses exact release count '+total,async()=>{
 const {createClient}=require('@supabase/supabase-js'),requests=[],httpRelease=createClient('https://release-count.invalid','test-key',{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:async(url,init)=>{requests.push({url:String(url),method:init.method,prefer:new Headers(init.headers).get('prefer'),body:JSON.parse(init.body)});const headers={'content-type':'application/json'};if(total!==null)headers['content-range']=`0-1/${total}`;return new Response(JSON.stringify([{id:id(30),org_id:ORG,condition_id:null},{id:id(31),org_id:ORG,condition_id:null}]),{status:200,headers})}}}),h=fixture({httpRelease})
 if(total===2)assert.equal((await h.deleteTakeoffCondition(CONDITION)).released_markups,2)
 else{await assert.rejects(h.deleteTakeoffCondition(CONDITION),/Released condition measurements could not be confirmed/);assert.ok(!h.calls.some(c=>c.action==='delete'));assert.deepEqual(h.audits,[])}
 assert.equal(requests.length,1);assert.equal(requests[0].method,'PATCH');assert.match(requests[0].prefer,/count=exact/);assert.match(requests[0].prefer,/return=representation/);assert.deepEqual(requests[0].body,{condition_id:null});const url=new URL(requests[0].url);assert.equal(url.searchParams.get('org_id'),`eq.${ORG}`);assert.equal(url.searchParams.get('condition_id'),`eq.${CONDITION}`)
})
