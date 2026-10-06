require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {extractRasterPlanEvidence}=require('../lib/drawings/raster-plan-evidence')
const {sourceWallNetwork}=require('../lib/drawings/vector-wall-network')
const {recognitionAssemblies,planAssemblyRecognition}=require('../lib/drawings/recognition-assemblies')
const {runAreaEngine,areaRecognitionPrompt}=require('../lib/drawings/area-engine')
const {createAreaReplay,replayAreaDetection}=require('../lib/drawings/area-replay')
const {rasterSwingDoors}=require('../lib/drawings/raster-swing-doors')
const {RASTER_ARC_PROFILE}=require('../lib/drawings/raster-arcs')
const region={x0:0,y0:0,x1:1,y1:1}
function fixture(ys=[80,95],sourceRegion=region){
 const width=300,height=240,feetPerPixel=.04,pixels=new Uint8Array(width*height).fill(255)
 for(const y of ys)for(let x=30;x<=260;x++)pixels[y*width+x]=0
 const evidence=extractRasterPlanEvidence({pixels,width,height,feetPerPixel,region:sourceRegion,sourceHash:'a'.repeat(64)})
 return {segments:[],imageWidth:width,imageHeight:height,feetPerImagePx:feetPerPixel,region,textRuns:[],evidence}
}
const net=(i,extra={})=>sourceWallNetwork({evidence:i.evidence,sx:i.imageWidth*i.feetPerImagePx,sy:i.imageHeight*i.feetPerImagePx,textRuns:i.textRuns,...extra})
const observation=(ids,kind='wall')=>({id:kind,region,suppliedPathIds:ids,elements:[{kind,pathIds:ids}],openings:[]})
test('actual measured unfilled bands are inspection evidence only, even beside a room label',()=>{
 const i=fixture(),before=structuredClone(i),normal=net(i),inspected=net(i,{inspectUnfilledPairs:true});assert.equal(normal.candidates.length,0);assert.equal(normal.bodies.length,0);assert.equal(inspected.candidates.length,1);assert.equal(inspected.candidates[0].sourceBand,'unfilled');assert.equal(inspected.pathIds.size,0);assert.equal(inspected.bodies.length,0);assert.ok(inspected.candidates[0].thicknessFt>.59&&inspected.candidates[0].thicknessFt<.61);assert.deepEqual(i,before)
 assert.equal(net({...i,textRuns:[{text:'BATH',x:.4,y:.36,w:.1,h:.01}]},{inspectUnfilledPairs:true}).bodies.length,0)
})
test('unfilled faces need both resolved primary wall roles, and remain provisional through shared replay',async()=>{
 const i=fixture(),ids=net(i,{inspectUnfilledPairs:true}).candidates[0].pathIds
 for(const obs of [[observation([ids[0]])],[{...observation([ids[0]]),contextPathIds:[ids[1]],elements:[{kind:'wall',pathIds:ids}]}],[observation(ids),observation([ids[1]],'fixture')]]){const run=await runAreaEngine({...i,visualObservations:obs},{wholeSheet:false});assert.equal(run.detection.architecture.building.walls.length,0)}
 const input={...i,visualObservations:[observation(ids)]},run=await runAreaEngine(input,{wholeSheet:false});assert.equal(run.detection.architecture.building.walls.length,1);assert.equal(run.detection.architecture.building.openings.length,0);assert.equal(run.detection.architecture.spaces.length,0);assert.ok(run.detection.architecture.building.issues.some(i=>i.code==='classified-wall-pairs'&&i.severity==='review'));assert.equal(run.recognition,'partial');assert.equal(run.recognitionCoverage.resolvedPaths,2)
 const replay=createAreaReplay(input,false,{sourceHash:i.evidence.raster.sourceHash},run.recognition),again=await replayAreaDetection(JSON.parse(JSON.stringify(replay)));assert.deepEqual(again.detection.architecture.building,run.detection.architecture.building);assert.deepEqual(again.recognitionCoverage,run.recognitionCoverage)
})
test('source measurement metadata and continuous faces cannot be replaced by arbitrary parallel lines',()=>{
 const i=fixture(),extra={inspectUnfilledPairs:true,classifiedWallPathIds:new Set(i.evidence.paths.map(p=>p.id))}
 for(const change of [null,{pathIds:'bad'},{profile:'measured-pair-paint-3'},{sections:11},{sections:Infinity},{normalDepthPixels:[1,-1]},{normalDepthPixels:[NaN,1]},{inkFraction:2},{fullSections:9000},{separatedBands:9000}]){const bad={...i,evidence:{...i.evidence,rasterPairPaint:change===null?[null]:i.evidence.rasterPairPaint.map(p=>({...p,...change}))}};assert.equal(net(bad,extra).candidates.length,0);assert.equal(net(bad,extra).bodies.length,0)}
 for(const change of [{dashes:[1]},{opacity:.4},{clips:[999]},{rasterLine:undefined},{rasterLine:{...i.evidence.paths[0].rasterLine,boundaryFraction:.2}}]){const bad={...i,evidence:{...i.evidence,paths:i.evidence.paths.map(p=>({...p,...change}))}};assert.equal(net(bad,extra).candidates.length,0)}
 assert.equal(net({...i,evidence:{...i.evidence,truncated:true}},extra).candidates.length,0);assert.equal(net({...i,evidence:{...i.evidence,rasterPairPaint:[]}},extra).candidates.length,0)
})
test('a long internal face separates unfilled bands instead of manufacturing their combined depth',()=>{
 const i=fixture([80,90,100]),r=net(i,{inspectUnfilledPairs:true});assert.equal(r.candidates.length,2);assert.ok(r.candidates.every(c=>c.thicknessFt<.5));assert.equal(r.bodies.length,0);assert.equal(r.pathIds.size,0)
})
test('outline inspection retains complete source IDs and unknown roles, without quantity or doorway promotion',async()=>{
 const i=fixture(),before=structuredClone(i),a=recognitionAssemblies(i);assert.equal(a.assemblies.length,1);assert.equal(a.assemblies[0].hypothesis,'unfilled-pair-context');const p=planAssemblyRecognition(i);assert.equal(p.requests.length,1);assert.ok(areaRecognitionPrompt(p.requests[0]).includes('not wall material or a wall label'));assert.ok(p.requests[0].catalogue.every(p=>p.prior==='unknown'))
 const recognize=async r=>({elements:[{kind:'unknown',pathIds:r.catalogue.map(p=>p.id)}],openings:[]}),run=await runAreaEngine(i,{wholeSheet:false,recognize,maxRecognitionWindows:1});assert.equal(run.recognitionCoverage.resolvedPaths,0);assert.equal(run.detection.architecture.building.walls.length,0);assert.equal(run.detection.architecture.building.openings.length,0);assert.equal(run.detection.proposals.length,0);assert.equal(run.recognition,'partial');assert.deepEqual(i,before)
 const measured=net(i,{inspectUnfilledPairs:true});assert.equal(rasterSwingDoors({evidence:i.evidence,sx:12,sy:9.6,wallBodies:measured.candidates,candidateWallBodies:measured.candidates,pathKinds:new Map()}).doors.length,0)
})
test('cross-view swing inspection precedes unrelated outline batches without duplicate source votes',()=>{
 const pieces=[.05,.65].map(x=>fixture(Array.from({length:12},(_,j)=>40+j*15),{x0:x,y0:.1,x1:x+.12,y1:.196}));const paths=[],paint=[];for(let j=0;j<pieces.length;j++){const offset=j*1000;paths.push(...pieces[j].evidence.paths.map(p=>({...p,id:p.id+offset})));paint.push(...pieces[j].evidence.rasterPairPaint.map(p=>({...p,pathIds:p.pathIds.map(id=>id+offset)})))}
 for(const [j,x] of [.05,.65].entries())paths.push({id:9000+j,kind:'stroke',color:[0],colorSpace:'DeviceGray',opacity:1,width:1,dashes:[],layer:[],groups:[],clips:[],evenOdd:false,rasterFeature:'circular-arc',rasterArc:{profile:RASTER_ARC_PROFILE,sampleCount:200,maximumDeviationPixels:1,sweepRadians:Math.PI/2,continuousInk:true,clipped:false},commands:Array.from({length:33},(_,n)=>[n?'L':'M',x+.04+.03*Math.cos(n/32*Math.PI/2),.13+.03*Math.sin(n/32*Math.PI/2)])})
 const i={segments:[],textRuns:[],imageWidth:2500,imageHeight:2500,feetPerImagePx:.04,region,evidence:{...pieces[0].evidence,paths,rasterPairPaint:paint,raster:{...pieces[0].evidence.raster,feetPerPixel:.04,region}}},before=structuredClone(i),p=planAssemblyRecognition(i,{x:.3,y:.3},2);assert.ok(p.requests.length>4);assert.ok(p.requests.slice(0,2).every(r=>r.assemblies.some(h=>h.hypothesis==='quarter-arc-context')));assert.ok(p.requests.slice(2).some(r=>r.assemblies.some(h=>h.hypothesis==='unfilled-pair-context')));const ids=p.requests.flatMap(r=>r.catalogue.map(p=>p.id));assert.equal(ids.length,new Set(ids).size);assert.ok(p.requests.every(r=>r.catalogue.length<=2));assert.deepEqual(i,before)
})
