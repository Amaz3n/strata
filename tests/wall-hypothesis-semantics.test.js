require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {extractRasterPlanEvidence}=require('../lib/drawings/raster-plan-evidence')
const {sourceWallNetwork}=require('../lib/drawings/vector-wall-network')
const {bindWallHypothesis}=require('../lib/drawings/wall-hypothesis-semantics')
const {runAreaEngine,areaRecognitionPrompt}=require('../lib/drawings/area-engine')
const {planAssemblyRecognition}=require('../lib/drawings/recognition-assemblies')
const {registerRecognitionImage,recognitionOverlaySvg}=require('../lib/drawings/recognition-overlay')
const {interpretArchitecturalElements,visualInterpretationSchema,visualInterpretationProviderSchema,wallHypothesisInterpretationProviderSchema}=require('../lib/drawings/area-semantics')
const {createAreaReplay,replayAreaDetection}=require('../lib/drawings/area-replay')
const {buildingToFloorplan}=require('../lib/drawings/building-floorplan')
const {floorplanModelSchema}=require('../lib/validation/floorplan')
const region={x0:0,y0:0,x1:1,y1:1}
function fixture(extraFace=false){const width=300,height=240,pixels=new Uint8Array(width*height).fill(255);for(let x=30;x<=260;x++)pixels[80*width+x]=0;for(let x=70;x<=160;x++)pixels[95*width+x]=0;if(extraFace)for(let x=170;x<=240;x++)pixels[100*width+x]=0;const evidence=extractRasterPlanEvidence({pixels,width,height,feetPerPixel:.04,region});evidence.raster.sourceHash='a'.repeat(64);return {segments:[],textRuns:[],region,imageWidth:width,imageHeight:height,feetPerImagePx:.04,evidence}}
const net=(i,extra={})=>sourceWallNetwork({evidence:i.evidence,sx:12,sy:9.6,textRuns:[],visualObservations:i.visualObservations,...extra})
const image=(i,r)=>({profile:'registered-source-image-1',kind:'original-pdf',fileId:'analytic-source',pageIndex:0,sourceHash:i.evidence.raster.sourceHash,evidenceHash:'b'.repeat(64),requestedRegion:r,sourceRegion:r,width:Math.round((r.x1-r.x0)*300),height:Math.round((r.y1-r.y0)*240),nativeWidth:300,nativeHeight:240,renderDpi:300,sampling:{profile:'pdf-native-density-1',kind:'native-raster',minimumSourceDpi:300,maximumSourceDpi:300,renderScale:300/72,warnings:[]},nativeDensityPreserved:true,imageSha256:'c'.repeat(64),annotatedSha256:'d'.repeat(64)})
function observation(i,kind='wall'){const body=net(i,{inspectUnfilledPairs:true}).candidates[0],binding=bindWallHypothesis(i.evidence,body,12,9.6),r={x0:.2,y0:.3,x1:.6,y1:.45};return {id:'local-span',region:r,sourceImage:image(i,r),suppliedPathIds:[],elements:[],openings:[],suppliedWallHypotheses:[binding],wallHypotheses:[{hypothesisId:binding.id,kind}]}}
test('a source-bound local wall decision establishes its measured overlap while whole parent roles and tails remain unknown',async()=>{
 const i=fixture(),obs=observation(i),before=structuredClone(i),run=await runAreaEngine({...i,visualObservations:[obs]},{wholeSheet:false}),b=run.detection.architecture.building;assert.equal(b.walls.length,1);assert.ok(b.issues.some(i=>i.code==='localized-wall-decisions'));assert.ok(Math.abs(Math.hypot((b.walls[0].b[0]-b.walls[0].a[0])*12,(b.walls[0].b[1]-b.walls[0].a[1])*9.6)-3.6)<.03);assert.ok(b.walls[0].a[0]>=obs.suppliedWallHypotheses[0].a[0]-1e-8&&b.walls[0].b[0]<=obs.suppliedWallHypotheses[0].b[0]+1e-8);assert.equal(run.recognitionCoverage.resolvedPaths,0);assert.ok(run.recognitionCoverage.unseenPaths>0);assert.equal(run.recognition,'partial');assert.equal(b.openings.length,0);assert.equal(run.detection.architecture.spaces.length,0);assert.ok(interpretArchitecturalElements(i.evidence,[obs]).every(e=>e.kind==='unknown'));assert.deepEqual(i,before)
})
test('unknown, negative, conflicting, duplicate and unsupplied span decisions cannot promote walls',()=>{
 const i=fixture(),yes=observation(i),no=observation(i,'not-wall');assert.equal(net({...i,visualObservations:[no]}).bodies.length,0);assert.equal(net({...i,visualObservations:[observation(i,'unknown')]}).bodies.length,0);assert.equal(net({...i,visualObservations:[yes,no]}).bodies.length,0)
 for(const change of [{suppliedWallHypotheses:[null]},{wallHypotheses:[null]},{suppliedWallHypotheses:[...yes.suppliedWallHypotheses,...yes.suppliedWallHypotheses]},{suppliedWallHypotheses:[]},{wallHypotheses:[...yes.wallHypotheses,...yes.wallHypotheses]},{wallHypotheses:[{hypothesisId:'wall-pair:999:1000',kind:'wall'}]}])assert.equal(net({...i,visualObservations:[{...yes,...change}]}).bodies.length,0)
 const id=yes.suppliedWallHypotheses[0].pathIds[0],fixtureVote={id:'fixture-vote',region,suppliedPathIds:[id],elements:[{kind:'fixture',pathIds:[id]}],openings:[]};assert.equal(net({...i,visualObservations:[yes,fixtureVote]},{excludedPathIds:new Set([id])}).bodies.length,0)
})
test('changed pixel witnesses, source, calibration, binding geometry or incomplete/low-quality images invalidate the decision',()=>{
 const i=fixture(),yes=observation(i)
 for(const change of [{sourceImage:undefined},{sourceImage:{...yes.sourceImage,sourceHash:'e'.repeat(64)}},{sourceImage:{...yes.sourceImage,nativeDensityPreserved:false}},{region:{x0:.25,y0:.3,x1:.4,y1:.45}},{suppliedWallHypotheses:[{...yes.suppliedWallHypotheses[0],thicknessFt:1}]},{suppliedWallHypotheses:[{...yes.suppliedWallHypotheses[0],witness:'fabricated'}]}])assert.equal(net({...i,visualObservations:[{...yes,...change}]}).bodies.length,0)
 const evidence={...i.evidence,rasterPairPaint:i.evidence.rasterPairPaint.map(p=>({...p,inkFraction:p.inkFraction+.001}))};assert.equal(net({...i,evidence,visualObservations:[yes]}).bodies.length,0);assert.equal(sourceWallNetwork({evidence:i.evidence,sx:24,sy:19.2,textRuns:[],visualObservations:[yes]}).bodies.length,0)
})
test('local wall decisions reach the shared floorplan schema and survive immutable exact replay without role inflation',async()=>{
 const i=fixture(),input={...i,visualObservations:[observation(i)]},run=await runAreaEngine(input,{wholeSheet:false}),replay=createAreaReplay(input,false,{sourceHash:i.evidence.raster.sourceHash},run.recognition),again=await replayAreaDetection(JSON.parse(JSON.stringify(replay)));assert.deepEqual(again.detection.architecture.building,run.detection.architecture.building);assert.deepEqual(again.recognitionCoverage,run.recognitionCoverage)
 const level=buildingToFloorplan({...input,order:0,name:'Local source',sheetVersionId:'analytic-source',sheetNumber:null,sheetTitle:null,scaleConfirmed:true},run.detection.architecture);assert.equal(level.walls.length,1);assert.equal(level.walls[0].evidence.reviewed,false);assert.equal(floorplanModelSchema.safeParse({version:1,units:'feet',levels:[level],correctionCount:0}).success,true)
})
test('planning supplies exact source bindings while provider prompts/overlays expose only local spans and registration retains ownership',()=>{
 const i=fixture(),before=structuredClone(i),r=planAssemblyRecognition(i).requests[0];assert.equal(r.wallHypotheses.length,1);const prompt=areaRecognitionPrompt(r);assert.ok(prompt.includes('ONLY to the measured span'));assert.ok(!prompt.includes(r.wallHypotheses[0].binding.witness));assert.ok(recognitionOverlaySvg(r,300,240).includes('W wall-pair:'))
 const actual={x0:r.region.x0-.001,y0:r.region.y0-.001,x1:r.region.x1+.001,y1:r.region.y1+.001},registered=registerRecognitionImage(r,actual);assert.deepEqual(registered.wallHypotheses[0].binding,r.wallHypotheses[0].binding);for(let k=0;k<4;k++){const lo=k%2?'y0':'x0',hi=k%2?'y1':'x1';assert.ok(Math.abs(r.region[lo]+r.wallHypotheses[0].bounds[k]*(r.region[hi]-r.region[lo])-actual[lo]-registered.wallHypotheses[0].bounds[k]*(actual[hi]-actual[lo]))<1e-12)}assert.deepEqual(i,before)
 assert.equal(visualInterpretationSchema.safeParse({elements:[],openings:[]}).success,true);assert.equal(visualInterpretationProviderSchema.safeParse({elements:[],openings:[]}).success,true);assert.equal(wallHypothesisInterpretationProviderSchema.safeParse({elements:[],openings:[]}).success,false)
})

test('a confirmed local span cannot lend its parent tail to a separately classified neighboring face',async()=>{
 const i=fixture(true),local=observation(i),third=i.evidence.paths.find(p=>p.rasterFeature==='linework'&&p.commands.length===2&&Math.abs(p.commands[0][2]*240-100.5)<1)
 assert.ok(third);assert.ok(!local.suppliedWallHypotheses[0].pathIds.includes(third.id));const orphan={id:'orphan-wall-face',region,suppliedPathIds:[third.id],elements:[{kind:'wall',pathIds:[third.id]}],openings:[]},run=await runAreaEngine({...i,visualObservations:[local,orphan]},{wholeSheet:false}),walls=run.detection.architecture.building.walls
 assert.equal(walls.length,1);assert.ok(walls.every(w=>Math.max(w.a[0],w.b[0])<=local.suppliedWallHypotheses[0].b[0]+1e-8));assert.equal(run.recognitionCoverage.resolvedPaths,1);assert.equal(run.recognition,'partial')
})

test('a negative local span decision contradicting global wall votes remains an explicit critical defect',async()=>{
 const i=fixture(),local=observation(i,'not-wall'),ids=local.suppliedWallHypotheses[0].pathIds,whole={id:'whole-parent-wall-votes',region,suppliedPathIds:ids,elements:[{kind:'wall',pathIds:ids}],openings:[]},run=await runAreaEngine({...i,visualObservations:[whole,local]},{wholeSheet:false}),b=run.detection.architecture.building
 assert.ok(b.issues.some(i=>i.code==='wall-hypothesis-conflict'&&i.severity==='error'));assert.equal(b.status,'incomplete');assert.equal(run.recognitionCoverage.resolvedPaths,2);assert.ok(b.walls.length>0)
})
