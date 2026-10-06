require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {extractRasterPlanEvidence}=require('../lib/drawings/raster-plan-evidence')
const {planAssemblyRecognition,recognitionAssemblies}=require('../lib/drawings/recognition-assemblies')
const {planUnassignedWallSpans}=require('../lib/drawings/wall-span-recognition-plan')
const {accountsForWallSpans,usableRecognitionAnswer}=require('../lib/drawings/recognition-answer')
const {areaRecognitionPrompt,runAreaEngine}=require('../lib/drawings/area-engine')
const {createAreaReplay,replayAreaDetection}=require('../lib/drawings/area-replay')
const {registerRecognitionImage}=require('../lib/drawings/recognition-overlay')
const {evidencePathBounds}=require('../lib/drawings/area-evidence')
const region={x0:0,y0:0,x1:1,y1:1},capacity={x:.3,y:.3}
function fixture(){
  const width=300,height=240,pixels=new Uint8Array(width*height).fill(255)
  for(let x=10;x<=290;x++)pixels[80*width+x]=0
  for(let x=30;x<=70;x++)pixels[95*width+x]=0
  for(let x=200;x<=250;x++)pixels[100*width+x]=0
  const evidence=extractRasterPlanEvidence({pixels,width,height,feetPerPixel:.04,region})
  evidence.raster.sourceHash='a'.repeat(64)
  return {segments:[],textRuns:[],region,imageWidth:width,imageHeight:height,feetPerImagePx:.04,evidence}
}
function image(r){return {profile:'registered-source-image-1',kind:'original-pdf',fileId:'analytic-source',pageIndex:0,sourceHash:'a'.repeat(64),evidenceHash:'b'.repeat(64),requestedRegion:r,sourceRegion:r,width:Math.round((r.x1-r.x0)*300),height:Math.round((r.y1-r.y0)*240),nativeWidth:300,nativeHeight:240,renderDpi:300,sampling:{profile:'pdf-native-density-1',kind:'native-raster',minimumSourceDpi:300,maximumSourceDpi:300,renderScale:300/72,warnings:[]},nativeDensityPreserved:true,imageSha256:'c'.repeat(64),annotatedSha256:'d'.repeat(64)}}
test('sharing an already assigned parent across batches does not omit a physical span or repeat a whole-path vote',()=>{
  const i=fixture(),width=300,height=240,pixels=new Uint8Array(width*height).fill(255)
  for(let j=0;j<24;j++)for(let x=30;x<=260;x++)pixels[(12+j*9)*width+x]=0
  i.evidence=extractRasterPlanEvidence({pixels,width,height,feetPerPixel:.04,region});i.evidence.raster.sourceHash='a'.repeat(64)
  const candidates=recognitionAssemblies(i).assemblies.filter(a=>a.wallHypothesis),plan=planAssemblyRecognition(i,{x:1,y:1}),ids=plan.requests.flatMap(r=>r.catalogue.map(p=>p.id)),spans=plan.requests.flatMap(r=>r.wallHypotheses?.map(h=>h.binding.id)??[])
  assert.ok(candidates.length>16);assert.ok(plan.requests.some(r=>r.catalogue.length===0));assert.equal(ids.length,new Set(ids).size);assert.equal(spans.length,new Set(spans).size);assert.deepEqual(new Set(spans),new Set(candidates.map(a=>a.wallHypothesis.id)));assert.ok(plan.requests.filter(r=>r.catalogue.length===0).every(r=>r.wallHypotheses.length<=16))
})
test('native measured spans remain scheduled when a shared full parent cannot fit the original-image capacity',()=>{
  const i=fixture(),before=structuredClone(i),candidates=recognitionAssemblies(i).assemblies.filter(a=>a.wallHypothesis),plan=planAssemblyRecognition(i,capacity)
  assert.equal(candidates.length,2);assert.equal(plan.requests.length,2);assert.equal(plan.suppliedPathIds.size,0)
  const supplied=plan.requests.flatMap(r=>r.wallHypotheses.map(h=>h.binding.id));assert.equal(supplied.length,new Set(supplied).size);assert.deepEqual(new Set(supplied),new Set(candidates.map(a=>a.wallHypothesis.id)))
  assert.ok(candidates[0].pathIds.some(id=>candidates[1].pathIds.includes(id)))
  for(const r of plan.requests){assert.deepEqual(r.catalogue,[]);assert.ok(r.region.x1-r.region.x0<=capacity.x+1e-12);assert.ok(r.region.y1-r.region.y0<=capacity.y+1e-12);for(const h of r.wallHypotheses){assert.ok(h.bounds.every(n=>n>=0&&n<=1));assert.ok(h.binding.pathIds.some(id=>{const b=evidencePathBounds(i.evidence.paths.find(p=>p.id===id));return b.x0<r.region.x0||b.x1>r.region.x1}));assert.ok(!areaRecognitionPrompt(r).includes(h.binding.witness));assert.ok(areaRecognitionPrompt(r).includes('Return elements:[] and openings:[]'))}}
  assert.deepEqual(i,before)
})
test('span requests require complete unique target decisions and cannot vote on source parents or openings',()=>{
  const r=planAssemblyRecognition(fixture(),capacity).requests[0],id=r.wallHypotheses[0].binding.id,answer={elements:[],openings:[],wallHypotheses:[{hypothesisId:id,kind:'unknown'}]}
  assert.equal(usableRecognitionAnswer(r,answer),true);assert.equal(accountsForWallSpans(r,answer),true)
  for(const wallHypotheses of [[],undefined,[{hypothesisId:'invented',kind:'wall'}],[...answer.wallHypotheses,...answer.wallHypotheses]])assert.equal(usableRecognitionAnswer(r,{...answer,wallHypotheses}),false)
  assert.equal(usableRecognitionAnswer(r,{...answer,elements:[{kind:'wall',pathIds:r.wallHypotheses[0].binding.pathIds}]}),false)
  assert.equal(usableRecognitionAnswer(r,{...answer,openings:[{}]}),false)
  assert.equal(usableRecognitionAnswer({region,catalogue:[{id:1}]},{elements:[{kind:'unknown',pathIds:[1]}],openings:[]}),true)
})
test('independent scheduling retains exact bindings across registration and bounds source-work without claiming omitted spans complete',()=>{
  const i=fixture(),assemblies=recognitionAssemblies(i).assemblies,args={assemblies,requests:[],region,sx:12,sy:9.6,capacity,remainingWork:2000000},plan=planUnassignedWallSpans(args),r=plan.requests[0],actual={x0:r.region.x0-.001,y0:r.region.y0-.001,x1:r.region.x1+.001,y1:r.region.y1+.001},registered=registerRecognitionImage(r,actual)
  assert.deepEqual(registered.wallHypotheses[0].binding,r.wallHypotheses[0].binding)
  for(let k=0;k<4;k++){const lo=k%2?'y0':'x0',hi=k%2?'y1':'x1';assert.ok(Math.abs(r.region[lo]+r.wallHypotheses[0].bounds[k]*(r.region[hi]-r.region[lo])-actual[lo]-registered.wallHypotheses[0].bounds[k]*(actual[hi]-actual[lo]))<1e-12)}
  assert.equal(planUnassignedWallSpans({...args,requests:plan.requests}).requests.length,0)
  const limited=planUnassignedWallSpans({...args,remainingWork:0});assert.equal(limited.limited,true);assert.equal(limited.requests.length,0);assert.equal(limited.unframedIds.length,2)
  const ambiguous=planUnassignedWallSpans({...args,assemblies:[...assemblies,{...assemblies[0],wallHypothesis:{...assemblies[0].wallHypothesis,witness:'different'}}]});assert.ok(ambiguous.unframedIds.includes(assemblies[0].wallHypothesis.id));assert.ok(ambiguous.requests.every(r=>r.wallHypotheses.every(h=>h.binding.id!==assemblies[0].wallHypothesis.id)))
})
test('span-only answers traverse shared recognition/replay while unobserved whole parents stay unresolved',async()=>{
  const i=fixture(),calls=[],recognize=async r=>{calls.push(r);return {elements:[],openings:[],wallHypotheses:r.wallHypotheses.map(h=>({hypothesisId:h.binding.id,kind:'wall'}))}}
  recognize.windowBudget=async()=>capacity;recognize.sourceImage=r=>image(r.region)
  const run=await runAreaEngine(i,{wholeSheet:false,recognize,maxRecognitionWindows:2})
  assert.equal(calls.length,2);assert.ok(calls.every(r=>r.catalogue.length===0));assert.equal(run.observations.length,2);assert.equal(run.recognitionCoverage.resolvedPaths,0);assert.ok(run.recognitionCoverage.unseenPaths>0);assert.equal(run.recognition,'partial');assert.equal(run.detection.architecture.building.walls.length,2);assert.equal(run.detection.architecture.building.openings.length,0)
  const replay=createAreaReplay({...i,visualObservations:run.observations},false,{},run.recognition),again=await replayAreaDetection(JSON.parse(JSON.stringify(replay)));assert.deepEqual(again.detection.architecture.building,run.detection.architecture.building);assert.deepEqual(again.recognitionCoverage,run.recognitionCoverage)
})
