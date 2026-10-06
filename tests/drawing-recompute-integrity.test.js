require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript'),{isDeepStrictEqual}=require('node:util')
const {createFakeSupabase}=require('./support/fake-supabase'),{readAllRowsById}=require('../lib/land/paging'),takeoff=require('../lib/validation/takeoff'),drawings=require('../lib/validation/drawings'),measure=require('../lib/drawings/measure')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const ORG=id(1),FOREIGN=id(2),VERSION=id(3),SHEET=id(4),ACTOR=id(5),CONDITION=id(6),STAMP='2026-10-04T12:00:00.123456+00:00',LATER='2026-10-04T13:00:00.654321+00:00'
const geometry={type:'area',points:[[0.1,0.1],[0.5,0.1],[0.5,0.5],[0.1,0.5]],color:'#FF0000',strokeWidth:2},context={imageSize:{width:400,height:400},feetPerImagePx:0.1}
const row=(n,extra={})=>({id:id(100+n),org_id:ORG,sheet_version_id:VERSION,drawing_sheet_id:SHEET,created_by:ACTOR,condition_id:null,updated_at:STAMP,data:geometry,quantity:1,uom:'sf',...extra})
const condition={id:CONDITION,org_id:ORG,name:'Floor',uom:'sf',depth_in:null,height_ft:null,pitch_rise:null,tons_per_cy:null}
function fixture(options={}){
 const db=createFakeSupabase({drawing_markups:options.rows??[row(0)],takeoff_conditions:options.conditions??[condition]}),calls=[],writes=[],active={now:0,max:0},settled=[]
 const supabase={from:table=>{const q=db.from(table),run=q.run.bind(q)
 q.run=()=>{
  calls.push({table,action:q.action,filters:q.filters.length,payload:q.payload})
  if(q.action==='select'&&table==='drawing_markups'&&options.transportCap)q.limitValue=Math.min(q.limitValue??Infinity,options.transportCap)
  if(q.action==='update'&&options.race){const r=db.store[table].find(r=>r.id===options.raceId||!options.raceId);if(r){if(options.race==='remove')db.store[table].splice(db.store[table].indexOf(r),1);else r.updated_at=LATER}}
  const result=run()
  if(q.action==='select'){
   if(options.errorTable===table)result.error={message:'Unavailable'}
   if(options.nullTable===table)result.data=null
   if(options.overrideTable===table)result.data=options.data
  }
  if(q.action==='update'){
   writes.push(q.payload)
   if(Array.isArray(result.data))result.data=result.data.length===1?{...result.data[0],updated_at:LATER}:null
   if(Object.hasOwn(options,'reply'))result.data=options.reply
   if(options.rewrite&&result.data)result.data={...result.data,...options.rewrite}
   if(options.updateError)result.error={message:'Update unavailable'}
  }
  return result
 }
 if(options.delayed&&table==='drawing_markups'){
  const originalThen=q.then.bind(q)
  q.then=(resolve,reject)=>{
   if(q.action!=='update')return originalThen(resolve,reject)
   active.now++;active.max=Math.max(active.max,active.now)
   return new Promise(done=>setTimeout(done,3)).then(()=>originalThen(value=>{active.now--;settled.push(q.payload);return value},reason=>{active.now--;throw reason})).then(resolve,reject)
  }
 }
 return q}}
 const source=fs.readFileSync('lib/services/drawing-measurements.ts','utf8'),ast=ts.createSourceFile('measurements.ts',source,ts.ScriptTarget.Latest,true),names=['recomputeMarkupQuantitiesForVersion','assertConditionAcceptsUom','measureMarkup'],constants=['RECOMPUTE_PAGE_SIZE','RECOMPUTE_WRITE_CONCURRENCY','RECOMPUTE_VALIDATION_CAP'],selected=ast.statements.filter(n=>(ts.isFunctionDeclaration(n)&&names.includes(n.name?.text))||(ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>constants.includes(d.name.getText(ast))))).map(n=>n.getText(ast)).join('\n'),exports={}
 const js=ts.transpileModule(selected,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
 new Function('exports','loadMeasurementContext','readAllRowsById','drawingMarkupRevisionSchema','markupDataSchema','measureUomSchema','storedMeasurementQuantitySchema','storedConditionMeasurementSchema','isDeepStrictEqual','isMeasuringMarkupType','computeMarkupQuantity','conditionSourceUom','MEASURING_TYPE_UOM','MEASURING_MARKUP_TYPES','MEASURE_UOM_LABELS',js)(exports,async()=>options.context??context,readAllRowsById,drawings.drawingMarkupRevisionSchema,drawings.markupDataSchema,drawings.measureUomSchema,takeoff.storedMeasurementQuantitySchema,takeoff.storedConditionMeasurementSchema,isDeepStrictEqual,measure.isMeasuringMarkupType,measure.computeMarkupQuantity,measure.conditionSourceUom,measure.MEASURING_TYPE_UOM,measure.MEASURING_MARKUP_TYPES,measure.MEASURE_UOM_LABELS)
 return {run:()=>exports.recomputeMarkupQuantitiesForVersion(supabase,ORG,VERSION),calls,writes,store:db.store,active,settled}
}
const measured=measure.computeMarkupQuantity(geometry,context.imageSize,context.feetPerImagePx).quantity
for(const options of [{nullTable:'drawing_markups'},{errorTable:'drawing_markups'},{overrideTable:'drawing_markups',data:[row(0,{org_id:FOREIGN})]},{overrideTable:'drawing_markups',data:[row(0,{sheet_version_id:id(99)})]},{overrideTable:'drawing_markups',data:[row(0),row(0)]}])test('unknown/foreign/stalled recompute reads cannot become complete zero '+JSON.stringify(options),async()=>{const h=fixture(options);await assert.rejects(h.run());assert.deepEqual(h.writes,[])})
test('true empty source completes zero with no writes',async()=>{const h=fixture({rows:[]});assert.equal(await h.run(),0);assert.deepEqual(h.writes,[])})
test('short transport pages exhaust every one of 1500 actual sources before writing',async()=>{const h=fixture({rows:Array.from({length:1500},(_,i)=>row(i)),transportCap:37});assert.equal(await h.run(),1500);assert.equal(h.writes.length,1500);assert.ok(h.store.drawing_markups.every(r=>r.quantity===measured));const firstWrite=h.calls.findIndex(c=>c.action==='update');assert.equal(h.calls.slice(0,firstWrite).filter(c=>c.table==='drawing_markups'&&c.action==='select').length,42)})
for(const extra of [{updated_at:null},{updated_at:'bad'},{data:{type:'area',points:'bad'}},{quantity:'bad'},{quantity:true},{quantity:''},{quantity:'0x10'},{uom:'bad'},{condition_id:undefined}])test('invalid original source blocks all recompute writes '+JSON.stringify(extra),async()=>{const h=fixture({rows:[row(0),row(1,extra)]});await assert.rejects(h.run());assert.deepEqual(h.writes,[])})
test('same original quantity/uom skips updates, and valid SQL decimal strings retained',async()=>{const h=fixture({rows:[row(0,{quantity:String(measured)})]});assert.equal(await h.run(),0);assert.deepEqual(h.writes,[])})
test('deductions retain signed negative quantity and uncalibrated remains null but typed',async()=>{const h=fixture({rows:[row(0,{data:{...geometry,style:{deduction:true}},quantity:'-1'})]});assert.equal(await h.run(),1);assert.equal(h.store.drawing_markups[0].quantity,-measured);const pending=fixture({context:{...context,feetPerImagePx:null}});assert.equal(await pending.run(),1);assert.equal(pending.store.drawing_markups[0].quantity,null);assert.equal(pending.store.drawing_markups[0].uom,'sf')})
for(const conditionExtra of [{height_ft:9},{uom:'invalid'},{uom:'cy',depth_in:null}])test('assigned incompatible original condition blocks every write '+JSON.stringify(conditionExtra),async()=>{const h=fixture({rows:[row(0),row(1,{condition_id:CONDITION})],conditions:[{...condition,...conditionExtra}]});await assert.rejects(h.run());assert.deepEqual(h.writes,[])})
test('unchanged assigned member still validates unit and shared conditions read once',async()=>{const invalid=fixture({rows:[row(0,{condition_id:CONDITION,quantity:measured})],conditions:[{...condition,height_ft:9}]});await assert.rejects(invalid.run());assert.deepEqual(invalid.writes,[]);const h=fixture({rows:Array.from({length:40},(_,i)=>row(i,{condition_id:CONDITION}))});assert.equal(await h.run(),40);assert.equal(h.calls.filter(c=>c.table==='takeoff_conditions').length,1)})
for(const race of ['change','remove'])test('read revision fences '+race+' before original quantity overwrite',async()=>{const h=fixture({race});await assert.rejects(h.run(),/changed during recalibration/);if(race==='change')assert.equal(h.store.drawing_markups[0].quantity,1)})
for(const rewrite of [{id:id(99)},{org_id:FOREIGN},{sheet_version_id:id(99)},{drawing_sheet_id:id(99)},{created_by:id(99)},{condition_id:CONDITION},{quantity:1},{uom:'lf'},{updated_at:'bad'},{data:{...geometry,points:[[0,0],[1,1]]}}])test('saved mismatch cannot become successful recompute count '+JSON.stringify(rewrite),async()=>{const h=fixture({rewrite});await assert.rejects(h.run())})
for(const options of [{reply:null},{updateError:true}])test('missing/error saved response cannot report pending length '+JSON.stringify(options),async()=>{const h=fixture(options);await assert.rejects(h.run())})
test('raw JSON geometry key ordering does not create a false body mismatch',async()=>{const h=fixture({rewrite:{data:{strokeWidth:2,color:'#FF0000',points:geometry.points,type:'area'}}});assert.equal(await h.run(),1)})
test('original writes stay bounded to 20 and all settle before a batch failure returns',async()=>{const h=fixture({rows:Array.from({length:45},(_,i)=>row(i)),delayed:true,updateError:true});await assert.rejects(h.run(),/Update unavailable/);assert.equal(h.active.now,0);assert.equal(h.active.max,20);assert.equal(h.settled.length,20);assert.equal(h.writes.length,20)})
