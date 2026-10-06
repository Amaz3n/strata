require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {extractRasterPlanEvidence}=require('../lib/drawings/raster-plan-evidence')
const {planAssemblyRecognition,NATIVE_ASSEMBLY_PATH_LIMIT}=require('../lib/drawings/recognition-assemblies')
const {evidencePathBounds}=require('../lib/drawings/area-evidence')
const {runAreaEngine,areaRecognitionPrompt}=require('../lib/drawings/area-engine')
const {registerRecognitionImage}=require('../lib/drawings/recognition-overlay')
const {createAreaReplay,replayAreaDetection}=require('../lib/drawings/area-replay')
const region={x0:0,y0:0,x1:1,y1:1}
function fixture(ys=[50,65],sourceRegion={x0:.4,y0:.4,x1:.52,y1:.496}){
 const width=300,height=240,feetPerPixel=.04,pixels=new Uint8Array(width*height).fill(255)
 for(const y of ys)for(let x=30;x<=260;x++)pixels[y*width+x]=0
 const evidence=extractRasterPlanEvidence({pixels,width,height,feetPerPixel,region:sourceRegion,sourceHash:'a'.repeat(64)})
 return {segments:[],textRuns:[],imageWidth:2500,imageHeight:2500,feetPerImagePx:.04,region,evidence}
}
function complete(i,p){for(const r of p.requests){assert.ok(r.catalogue.length<=NATIVE_ASSEMBLY_PATH_LIMIT);for(const id of r.catalogue.map(p=>p.id)){const b=evidencePathBounds(i.evidence.paths.find(p=>p.id===id));assert.ok(b.x0>=r.region.x0-1e-12&&b.y0>=r.region.y0-1e-12&&b.x1<=r.region.x1+1e-12&&b.y1<=r.region.y1+1e-12)}for(const a of r.assemblies??[])assert.ok(a.pathIds.every(id=>r.catalogue.some(p=>p.id===id)))}}
test('native assembly frames preserve full original faces with bounded nearby context instead of filling image capacity',()=>{
 const i=fixture(),before=structuredClone(i),p=planAssemblyRecognition(i,{x:.7,y:.7}),r=p.requests[0];assert.equal(p.requests.length,1);assert.ok(Math.abs((r.region.x1-r.region.x0)*100-17.2)<.2);assert.ok(Math.abs((r.region.y1-r.region.y0)*100-12)<1e-8);assert.ok((r.region.x1-r.region.x0)*(r.region.y1-r.region.y0)<.03);complete(i,p);assert.deepEqual(i,before)
 for(const path of r.catalogue){const original=i.evidence.paths.find(p=>p.id===path.id);for(let j=0;j<path.commands.length;j++)for(let n=1;n<path.commands[j].length;n++){const lo=n%2?'x0':'y0',hi=n%2?'x1':'y1';assert.ok(Math.abs(r.region[lo]+path.commands[j][n]*(r.region[hi]-r.region[lo])-original.commands[j][n])<=.000051*(r.region[hi]-r.region[lo]))}}
})
test('local context respects unequal axis scales, selection edges and a smaller native image capacity',()=>{
 const i=fixture([50,65],{x0:.01,y0:.01,x1:.13,y1:.106});i.imageHeight=5000;const p=planAssemblyRecognition(i,{x:.18,y:.07});assert.ok(p.requests.length>0);complete(i,p);for(const r of p.requests){assert.ok(r.region.x0>=0&&r.region.y0>=0);assert.ok(r.region.x1-r.region.x0<=.18+1e-12);assert.ok(r.region.y1-r.region.y0<=.07+1e-12)}
 const before=structuredClone(i);assert.equal(planAssemblyRecognition(i,{x:.05,y:.05}).requests.length,0);assert.deepEqual(i,before)
})
test('native assembly batches keep every competing pair atomic and each primary source ID supplied once',()=>{
 const i=fixture(Array.from({length:24},(_,j)=>12+j*9)),p=planAssemblyRecognition(i,{x:.7,y:.7}),ids=p.requests.flatMap(r=>r.catalogue.map(p=>p.id));assert.ok(p.requests.length>1);assert.equal(ids.length,new Set(ids).size);assert.equal(new Set(ids).size,p.suppliedPathIds.size);complete(i,p)
 const reversed={...i,evidence:{...i.evidence,paths:[...i.evidence.paths].reverse()}};assert.deepEqual(planAssemblyRecognition(reversed,{x:.7,y:.7}),p)
})
test('registered local native requests preserve hint endpoints and command indices after pixel rounding',()=>{
 const i=fixture(),request=planAssemblyRecognition(i,{x:.7,y:.7}).requests[0],actual={x0:request.region.x0-.0001,y0:request.region.y0-.0002,x1:request.region.x1+.0001,y1:request.region.y1+.0002},registered=registerRecognitionImage(request,actual)
 for(let j=0;j<request.catalogue.length;j++){const a=request.catalogue[j],b=registered.catalogue[j];assert.equal(a.id,b.id);for(let k=0;k<a.commands.length;k++){assert.equal(a.commands[k][0],b.commands[k][0]);for(let n=1;n<a.commands[k].length;n++){const lo=n%2?'x0':'y0',hi=n%2?'x1':'y1';assert.ok(Math.abs(request.region[lo]+a.commands[k][n]*(request.region[hi]-request.region[lo])-actual[lo]-b.commands[k][n]*(actual[hi]-actual[lo]))<1e-12)}}}
 for(let j=0;j<request.assemblies.length;j++)for(let n=0;n<4;n++){const lo=n%2?'y0':'x0',hi=n%2?'y1':'x1';assert.ok(Math.abs(request.region[lo]+request.assemblies[j].bounds[n]*(request.region[hi]-request.region[lo])-actual[lo]-registered.assemblies[j].bounds[n]*(actual[hi]-actual[lo]))<1e-12)}
 assert.ok(areaRecognitionPrompt(registered).includes('not wall material or a wall label'))
})
test('smaller tasks keep unseen source unresolved and exact replay does not fabricate wall or room geometry',async()=>{
 const i=fixture(Array.from({length:24},(_,j)=>12+j*9)),calls=[],recognize=async r=>{calls.push(r);return{elements:[{kind:'unknown',pathIds:r.catalogue.map(p=>p.id)}],openings:[]}},run=await runAreaEngine(i,{wholeSheet:false,recognize,maxRecognitionWindows:1});assert.equal(calls.length,1);assert.ok(calls[0].catalogue.length<=16);assert.equal(run.recognition,'partial');assert.equal(run.recognitionCoverage.resolvedPaths,0);assert.ok(run.recognitionCoverage.unseenPaths>0);assert.equal(run.detection.architecture.building.walls.length,0);assert.equal(run.detection.architecture.spaces.length,0)
 const replay=createAreaReplay({...i,visualObservations:run.observations},false,{},run.recognition),again=await replayAreaDetection(JSON.parse(JSON.stringify(replay)));assert.deepEqual(again.recognitionCoverage,run.recognitionCoverage);assert.deepEqual(again.detection.architecture.building,run.detection.architecture.building)
})
