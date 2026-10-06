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
 const names=['numericOrNull','mapCondition','updateTakeoffCondition','repaintConditionMarkups','requireTakeoffWriteScope','requireTakeoffCostCodes']
 const selected=ast.statements.filter(n=>(ts.isFunctionDeclaration(n)&&names.includes(n.name?.text))||(ts.isVariableStatement(n)&&n.declarationList.declarations.some(v=>['CONDITION_SELECT','STALE_WRITE'].includes(v.name.getText(ast))))).map(n=>n.getText(ast)).join('\n')
 const db=createFakeSupabase({takeoff_conditions:options.rows??[{...original,...options.existing}],cost_codes:options.codes??[{id:CODE,org_id:ORG,is_active:false}],house_plan_versions:options.versions??[{id:VERSION,org_id:ORG,house_plan_id:PLAN}],house_plans:options.plans??[{id:PLAN,org_id:ORG,division_id:DIVISION}],drawing_markups:options.markups??[]}),calls=[],audits=[]
 const supabase={rpc:async(name,args)=>{calls.push({rpc:name,args});return {error:options.repaintError?{message:'Repaint unavailable'}:null}},from:table=>{
  const q=db.from(table),run=q.run.bind(q)
  q.run=()=>{
   calls.push({table,action:q.action,payload:q.payload})
   if(table==='takeoff_conditions'&&q.action==='update'&&options.race){if(options.race==='removed')db.store[table].splice(0);else db.store[table][0].updated_at=LATER}
   const result=run()
   if(q.action==='select'){
    if(options.errorTable===table)result.error={message:'Unavailable read'}
    if(options.nullTable===table)result.data=null
    if(table==='takeoff_conditions'&&Object.hasOwn(options,'readData'))result.data=options.readData
    if(table==='drawing_markups'&&Object.hasOwn(options,'count'))result.count=options.count
   }
   if(q.action==='update'){
    if(Array.isArray(result.data))result.data=result.data.length===1?{...result.data[0],updated_at:LATER}:null
    if(Object.hasOwn(options,'reply'))result.data=options.reply
    if(options.rewrite&&result.data)result.data={...result.data,...options.rewrite}
    if(options.writeError)result.error={message:'Write unavailable'}
   }
   return result
  };return q
 }}
 const exports={},js=ts.transpileModule(selected,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
 new Function('exports','requireOrgContext','requirePermission','requireAuthorization','getDivisionAccessForUser','recordAudit','updateTakeoffConditionSchema','takeoffConditionMutationTargetSchema','takeoffConditionScopeSchema','factorRuleViolation','conditionSourceUom','MEASURE_UOM_LABELS',js)(exports,
 async()=>{calls.push({context:true});return {supabase,orgId:ORG,userId:ACTOR}},async(permission,context)=>{assert.equal(permission,'takeoff.write');assert.equal(context.userId,ACTOR);if(options.denied)throw Error('Forbidden')},async request=>{calls.push({authorization:request});assert.equal(request.orgId,ORG);assert.equal(request.userId,ACTOR);assert.equal(request.permission,'takeoff.write');assert.equal(request.logDecision,true);assert.equal(request.supabase,supabase);if(options.projectDenied||request.projectId!==PROJECT)throw Error('Project unavailable')},async()=>options.divisions??{assignedOnly:false,divisionIds:[]},async args=>audits.push(args),validation.updateTakeoffConditionSchema,validation.takeoffConditionMutationTargetSchema,validation.takeoffConditionScopeSchema,validation.factorRuleViolation,measure.conditionSourceUom,measure.MEASURE_UOM_LABELS)
 return {...exports,calls,audits,store:db.store}
}
function noWrites(h){assert.ok(!h.calls.some(c=>c.action==='update'||c.rpc));assert.deepEqual(h.audits,[])}
for(const [target,stamp,patch] of [['invalid',undefined,{}],[CONDITION,'invalid',{}],[CONDITION,42,{}],[CONDITION,undefined,{unit_cost_cents:1.5}]])test('invalid mutation input before current context '+JSON.stringify([target,stamp,patch]),async()=>{const h=fixture();await assert.rejects(h.updateTakeoffCondition(target,patch,undefined,stamp));assert.deepEqual(h.calls,[])})
for(const options of [{denied:true},{errorTable:'takeoff_conditions'},{rows:[]},{nullTable:'takeoff_conditions'},{readData:{...original,org_id:FOREIGN}},{readData:{...original,id:id(99)}},{existing:{updated_at:null}},{existing:{updated_at:'invalid'}},{projectDenied:true},{existing:{project_id:id(99)}},{existing:{project_id:null,house_plan_version_id:null}},{existing:{house_plan_version_id:VERSION}}])test('unavailable/unauthorized original condition cannot update '+JSON.stringify(options),async()=>{const h=fixture(options);await assert.rejects(h.updateTakeoffCondition(CONDITION,{notes:'Changed'}));noWrites(h)})
test('stale rendered revision rejects an empty patch too',async()=>{const h=fixture();await assert.rejects(h.updateTakeoffCondition(CONDITION,{},undefined,LATER),e=>e.message===h.STALE_WRITE);noWrites(h)})
for(const race of ['changed','removed'])for(const stamp of [undefined,SEEN])test('read revision fences '+race+' caller '+stamp,async()=>{const h=fixture({race});await assert.rejects(h.updateTakeoffCondition(CONDITION,{notes:'Changed'},undefined,stamp),e=>e.message===h.STALE_WRITE);assert.deepEqual(h.audits,[]);if(race==='changed')assert.equal(h.store.takeoff_conditions[0].notes,'Original')})
for(const options of [{codes:[]},{codes:[{id:CODE,org_id:FOREIGN}]},{errorTable:'cost_codes'},{nullTable:'cost_codes'}])test('existing unavailable/foreign cost-code fails before update '+JSON.stringify(options),async()=>{const h=fixture(options);await assert.rejects(h.updateTakeoffCondition(CONDITION,{notes:'Changed'}),/cost codes unavailable/);noWrites(h)})
test('new foreign reference fails while explicit null repairs a broken reference',async()=>{const h=fixture({codes:[]});await assert.rejects(h.updateTakeoffCondition(CONDITION,{cost_code_id:id(99)}),/cost codes unavailable/);noWrites(h);const saved=await h.updateTakeoffCondition(CONDITION,{cost_code_id:null});assert.equal(saved.cost_code_id,null)})
for(const options of [{count:null},{count:undefined},{count:-1},{count:0.5},{count:'0'},{errorTable:'drawing_markups'}])test('unknown member count cannot authorize a unit transition '+JSON.stringify(options),async()=>{const h=fixture(options);await assert.rejects(h.updateTakeoffCondition(CONDITION,{height_ft:9}),/verify condition measurements/);noWrites(h)})
test('existing members refuse wall unit transition with original actionable message',async()=>{const h=fixture({markups:[{id:id(30),org_id:ORG,condition_id:CONDITION}]});await assert.rejects(h.updateTakeoffCondition(CONDITION,{height_ft:9}),/Release its 1 measurement first/);noWrites(h)})
test('confirmed zero members permits wall factors while ordinary price changes need no member count',async()=>{const h=fixture();assert.equal((await h.updateTakeoffCondition(CONDITION,{height_ft:9})).height_ft,9);const p=fixture({errorTable:'drawing_markups'});assert.equal((await p.updateTakeoffCondition(CONDITION,{unit_cost_cents:23456})).unit_cost_cents,23456);assert.ok(!p.calls.some(c=>c.table==='drawing_markups'))})
test('factor rules use stored uom and preserve required depth',async()=>{const h=fixture({existing:{uom:'cy',depth_in:6}});await assert.rejects(h.updateTakeoffCondition(CONDITION,{depth_in:null}),/needs a depth/);noWrites(h)})
for(const change of [{id:id(99)},{org_id:FOREIGN},{project_id:id(99)},{house_plan_version_id:VERSION},{name:'Different'},{uom:'ea'},{unit_cost_cents:1},{cost_code_id:id(99)},{color:CONDITION_COLORS[2]},{share_with_clients:false},{notes:'Different'},{sort_order:99},{created_by:ACTOR},{created_at:LATER},{updated_at:'invalid'}])test('divergent saved update cannot audit or repaint '+JSON.stringify(change),async()=>{const h=fixture({rewrite:change});await assert.rejects(h.updateTakeoffCondition(CONDITION,{color:CONDITION_COLORS[1]}),/could not be confirmed/);assert.deepEqual(h.audits,[]);assert.ok(!h.calls.some(c=>c.rpc))})
for(const options of [{reply:null},{writeError:true}])test('missing/failed update reply cannot repaint or audit '+JSON.stringify(options),async()=>{const h=fixture(options);await assert.rejects(h.updateTakeoffCondition(CONDITION,{color:CONDITION_COLORS[1]}));assert.deepEqual(h.audits,[]);assert.ok(!h.calls.some(c=>c.rpc))})
test('confirmed color update calls original set-based repaint before current-actor audit',async()=>{const h=fixture(),saved=await h.updateTakeoffCondition(CONDITION,{color:CONDITION_COLORS[1],unit_cost_cents:23456},undefined,SEEN);assert.equal(saved.created_by,CREATOR);assert.equal(saved.unit_cost_cents,23456);assert.equal(saved.updated_at,LATER);assert.deepEqual(h.calls.find(c=>c.rpc),{rpc:'repaint_condition_markups',args:{p_org_id:ORG,p_condition_id:CONDITION,p_color:CONDITION_COLORS[1]}});assert.equal(h.audits[0].actorId,ACTOR)})
test('repaint failure surfaces without a successful audit; separate committed body remains an open recovery gap',async()=>{const h=fixture({repaintError:true});await assert.rejects(h.updateTakeoffCondition(CONDITION,{color:CONDITION_COLORS[1]}),/Repaint unavailable/);assert.equal(h.store.takeoff_conditions[0].color,CONDITION_COLORS[1]);assert.deepEqual(h.audits,[])})
for(const options of [{versions:[]},{plans:[{id:PLAN,org_id:FOREIGN,division_id:DIVISION}]},{divisions:{assignedOnly:true,divisionIds:[id(99)]}}])test('plan update needs exact own parent/division '+JSON.stringify(options),async()=>{const h=fixture({...options,existing:{project_id:null,house_plan_version_id:VERSION}});await assert.rejects(h.updateTakeoffCondition(CONDITION,{notes:'Changed'}),/unavailable/);noWrites(h)})
test('authorized own production plan updates and original unscoped plan visibility survives',async()=>{for(const division_id of [DIVISION,null]){const h=fixture({existing:{project_id:null,house_plan_version_id:VERSION},plans:[{id:PLAN,org_id:ORG,division_id}],divisions:{assignedOnly:true,divisionIds:[DIVISION]}});assert.equal((await h.updateTakeoffCondition(CONDITION,{notes:'Changed'})).house_plan_version_id,VERSION)}})
test('verified no-op checks scope and reference without emitting a mutation audit',async()=>{const h=fixture();assert.equal((await h.updateTakeoffCondition(CONDITION,{})).updated_at,SEEN);assert.ok(h.calls.some(c=>c.authorization));noWrites(h)})
