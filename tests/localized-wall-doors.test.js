require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {fixture}=require('./support/raster-door-fixture')
const {sourceWallNetwork,withDoorCorroboratedFlanks}=require('../lib/drawings/vector-wall-network')
const {bindWallHypothesis}=require('../lib/drawings/wall-hypothesis-semantics')
const {rasterSwingDoors}=require('../lib/drawings/raster-swing-doors')
const {runAreaEngine}=require('../lib/drawings/area-engine')
const {createAreaReplay,replayAreaDetection}=require('../lib/drawings/area-replay')
const {buildingToFloorplan}=require('../lib/drawings/building-floorplan')
const {floorplanModelSchema}=require('../lib/validation/floorplan')
const region={x0:0,y0:0,x1:1,y1:1}
function prepared(options={}){
  const f=fixture({unfilledWalls:true,...options});f.evidence.raster.sourceHash='a'.repeat(64)
  const network=sourceWallNetwork({evidence:f.evidence,sx:12,sy:12,textRuns:[],inspectUnfilledPairs:true}),flanks=network.candidates.filter(b=>Math.abs((b.a[0]+b.b[0])/2-160/600)<.015&&Math.abs(b.a[0]-b.b[0])<.01)
  assert.equal(flanks.length,2)
  const bindings=flanks.map(b=>bindWallHypothesis(f.evidence,b,12,12))
  const sourceImage={profile:'registered-source-image-1',kind:'original-pdf',fileId:'analytic-source',pageIndex:0,sourceHash:'a'.repeat(64),evidenceHash:'b'.repeat(64),requestedRegion:region,sourceRegion:region,width:600,height:600,nativeWidth:600,nativeHeight:600,renderDpi:300,sampling:{profile:'pdf-native-density-1',kind:'native-raster',minimumSourceDpi:300,maximumSourceDpi:300,renderScale:300/72,warnings:[]},nativeDensityPreserved:true,imageSha256:'c'.repeat(64),annotatedSha256:'d'.repeat(64)}
  const observation={id:'local-door-flanks',region,sourceImage,suppliedPathIds:[],elements:[],openings:[],suppliedWallHypotheses:bindings,wallHypotheses:bindings.map(b=>({hypothesisId:b.id,kind:'wall'}))}
  return {f,network,flanks,observation,args:{...f.args,wallBodies:[],candidateWallBodies:network.candidates,visualObservations:[observation]}}
}
test('two individually confirmed outline spans can host a complete observed door while other candidates remain unknown',()=>{
  const p=prepared(),before=structuredClone(p.f.evidence),r=rasterSwingDoors(p.args)
  assert.equal(p.network.bodies.length,0);assert.equal(r.limited,false);assert.equal(r.doors.length,1);assert.equal(r.doors[0].wallSpans.length,2)
  assert.deepEqual(new Set(r.doors[0].wallSpans.flatMap(b=>b.pathIds)),new Set(p.flanks.flatMap(b=>b.pathIds)))
  assert.equal(rasterSwingDoors({...p.args,visualObservations:[]}).doors.length,0)
  const supported=withDoorCorroboratedFlanks(p.network,new Set(r.doors[0].wallPathIds),r.doors[0].wallSpans)
  assert.equal(supported.bodies.length,2);assert.ok(supported.bodies.every(b=>p.flanks.some(f=>JSON.stringify([f.a,f.b,f.pathIds])===JSON.stringify([b.a,b.b,b.pathIds]))));assert.deepEqual(p.f.evidence,before)
})
test('one confirmed flank, unknown/negative/conflicting decisions, stale images and forged caller metadata cannot establish an outline host',()=>{
  const p=prepared(),o=p.observation
  for(const decisions of [o.wallHypotheses.slice(0,1),o.wallHypotheses.map(h=>({...h,kind:'unknown'})),o.wallHypotheses.map(h=>({...h,kind:'not-wall'}))])assert.equal(rasterSwingDoors({...p.args,visualObservations:[{...o,wallHypotheses:decisions}]}).doors.length,0)
  const negative={...o,id:'contradiction',wallHypotheses:[{...o.wallHypotheses[0],kind:'not-wall'}]}
  assert.equal(rasterSwingDoors({...p.args,visualObservations:[o,negative]}).doors.length,0)
  const globallyWall=new Map(p.flanks.flatMap(b=>b.pathIds).map(id=>[id,'wall']))
  assert.equal(rasterSwingDoors({...p.args,pathKinds:globallyWall,visualObservations:[negative]}).doors.length,0)
  assert.equal(rasterSwingDoors({...p.args,visualObservations:[{...o,sourceImage:{...o.sourceImage,sourceHash:'e'.repeat(64)}}]}).doors.length,0)
  assert.equal(rasterSwingDoors({...p.args,visualObservations:[],candidateWallBodies:p.network.candidates.map(b=>({...b,sourceBand:undefined,strokeWidth:9999}))}).doors.length,0)
  const fresh=rasterSwingDoors({...p.args,candidateWallBodies:p.network.candidates.map(b=>({...b,sourceBand:undefined,strokeWidth:9999}))});assert.equal(fresh.doors.length,1);assert.ok(fresh.doors[0].wallSpans.every(b=>b.sourceBand==='unfilled'&&b.strokeWidth!==9999))
})
test('local span meaning cannot replace missing leaf, drawn end cap, jambs, swing or a conflicting source role',()=>{
  for(const option of ['noLeaf','noEndCap','noJamb','noArc']){const p=prepared({[option]:true});assert.equal(rasterSwingDoors(p.args).doors.length,0,option)}
  const p=prepared(),arc=p.f.evidence.paths.find(p=>p.rasterArc)
  assert.equal(rasterSwingDoors({...p.args,pathKinds:new Map([[arc.id,'fixture']])}).doors.length,0)
  assert.equal(rasterSwingDoors({...p.args,pathKinds:new Map([[p.flanks[0].pathIds[0],'fixture']])}).doors.length,0)
})
test('shared takeoff/3D and exact replay preserve measured opening widths without resolving parent roles or unrelated wall candidates',async()=>{
  const p=prepared(),input={...p.f.input,textRuns:[],visualObservations:[p.observation]},run=await runAreaEngine(input,{wholeSheet:true,recordedRecognition:'partial'}),b=run.detection.architecture.building
  assert.equal(b.openings.length,1);assert.equal(b.walls.filter(w=>w.basis!=='opening-host').length,2);assert.equal(run.recognitionCoverage.resolvedPaths,0);assert.ok(run.recognitionCoverage.unseenPaths>0);assert.equal(run.recognition,'partial');assert.equal(run.detection.architecture.spaces.length,0);assert.ok(run.detection.openingEvidence.length>0)
  const opening=b.openings[0];assert.equal(opening.widthBasis,'wall-flank-span');assert.ok(opening.clearWidthFt>0&&opening.leafWidthFt>0)
  const level=buildingToFloorplan({...input,order:0,name:'Native outline door',sheetVersionId:'analytic-source',sheetNumber:null,sheetTitle:null,scaleConfirmed:true},run.detection.architecture),model={version:1,units:'feet',levels:[level],correctionCount:0};assert.equal(floorplanModelSchema.safeParse(model).success,true);assert.equal(level.openings[0].clearWidthFt,opening.clearWidthFt);assert.equal(level.openings[0].leafWidthFt,opening.leafWidthFt)
  const replay=createAreaReplay(input,true,{sourceHash:input.evidence.raster.sourceHash},run.recognition),again=await replayAreaDetection(JSON.parse(JSON.stringify(replay)));assert.deepEqual(again.detection.architecture.building,b);assert.deepEqual(again.recognitionCoverage,run.recognitionCoverage)
})
test('door corroboration admits only the exact supported flanks rather than all candidate pairs among referenced parent IDs',()=>{
  const p=prepared(),span=p.flanks[0],shifted={...span,a:[span.a[0],span.a[1]-.02],b:[span.b[0],span.b[1]-.02]},network={...p.network,candidates:[span,shifted],bodies:[]},ids=new Set(span.pathIds)
  assert.equal(withDoorCorroboratedFlanks(network,ids,[span]).bodies.length,1)
  assert.equal(withDoorCorroboratedFlanks({...network,limited:true},ids,[span]).bodies.length,0)
  assert.equal(withDoorCorroboratedFlanks(network,ids,[]).bodies.length,0)
})
