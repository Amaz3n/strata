require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {windowFloorBoundaries}=require('../lib/drawings/area-windows')
const {measuredWindowHosts}=require('../lib/drawings/building-window-hosts')
const {reconstructBuilding}=require('../lib/drawings/building-reconstruction')
const {acceptedAreaSchema}=require('../lib/validation/area-takeoff')
const {planArchitecturalReinspection,reinspectArchitecture,reinspectionAlternative}=require('../lib/drawings/architectural-reinspection')
const {interpretArchitecturalElements}=require('../lib/drawings/area-semantics')
const {unrepresentedWindows}=require('../lib/drawings/building-window-coverage')
const {alignRasterWallRun}=require('../lib/drawings/raster-wall-alignment')
const {rasterWindowAssemblies}=require('../lib/drawings/raster-window-assemblies')
function fixture(angle=0){
 const c=Math.cos(angle),s=Math.sin(angle),turn=p=>[10+p[0]*c-p[1]*s,10+p[0]*s+p[1]*c]
 const raw=[[[0,-1],[0,0]],[[0,5],[0,6]],[[-.5,0],[0,0]],[[-.5,5],[0,5]],[[-.4,.5],[-.4,4.5]],[[-.3,.7],[-.3,4.4]],[[-.8,-1],[-.8,1]],[[-.8,4],[-.8,6]]]
 const kinds=new Map(raw.map((_,i)=>[i,i<4?'wall':i<6?'window':'column']))
 const edges=raw.map((points,i)=>({a:turn(points[0]),b:turn(points[1]),pathId:i,source:'drawn'}))
 const evidence={version:1,truncated:false,paths:edges.map(e=>({id:e.pathId,kind:'stroke',layer:['A-'+kinds.get(e.pathId).toUpperCase()],groups:[],clips:[],dashes:[],color:[0],colorSpace:'DeviceGray',opacity:1,width:1,evenOdd:false,commands:[['M',e.a[0]/30,e.a[1]/30],['L',e.b[0]/30,e.b[1]/30]]}))}
 const input={segments:[],evidence,imageWidth:1000,imageHeight:1000,feetPerImagePx:.03,textRuns:[],region:{x0:0,y0:0,x1:1,y1:1}}
 const boundary=windowFloorBoundaries(edges,kinds)[0]
 const norm=p=>p.map(n=>n/30)
 const space={id:'room',points:[[0,0],[10,0],[10,5],[0,5]].map(p=>norm(turn(p))),holes:[],labels:[],sourceBoundaries:boundary?[{...boundary,a:norm(boundary.a),b:norm(boundary.b)}]:[]}
 return {edges,kinds,input,architecture:{spaces:[space],openings:[],elements:[],finishZones:[],conflicts:[],version:1,qualification:'unqualified',spacePolicy:'include-fixtures'},turn}
}
test('a window floor boundary requires returning wall ends and paired nearby panes',()=>{
 const f=fixture();assert.equal(windowFloorBoundaries(f.edges,f.kinds).length,1)
 assert.equal(windowFloorBoundaries(f.edges.filter(e=>e.pathId!==5),f.kinds).length,0)
 assert.equal(windowFloorBoundaries(f.edges.filter(e=>e.pathId!==2),f.kinds).length,0)
 assert.equal(windowFloorBoundaries(f.edges,new Map([...f.kinds].map(([id,k])=>[id,k==='window'?'door':k]))).length,0)
 const shifted=f.edges.map(e=>e.pathId===5?{...e,a:[e.a[0]-3,e.a[1]],b:[e.b[0]-3,e.b[1]]}:e)
 assert.equal(windowFloorBoundaries(shifted,f.kinds).length,0)
})
test('window hosts use measured exterior faces at every orientation, with source-backed opening placement',()=>{
 for(const angle of [0,Math.PI/2,.63,Math.PI]){
  const f=fixture(angle),hosts=measuredWindowHosts(f.input,f.architecture)
  assert.equal(hosts.length,1);assert.ok(hosts[0].host)
  const host=hosts[0].host
  assert.ok(Math.abs(host.thicknessFt-.8)<1e-8)
  assert.ok(Math.abs(host.widthFt-4)<1e-8)
  assert.ok(Math.abs(host.offsetFt-.5)<1e-8)
  const midpoint=host.a.map((n,i)=>(n+host.b[i])/2*30),expected=f.turn([-.4,2.5])
  assert.ok(Math.hypot(midpoint[0]-expected[0],midpoint[1]-expected[1])<1e-8)
  const building=reconstructBuilding(f.input,f.architecture)
  const window=building.openings.find(o=>o.kind==='window')
  assert.ok(window);assert.ok(building.issues.some(i=>i.code==='window-host-inferred'))
  assert.equal(window.widthBasis,'pane-span')
  assert.ok(Math.abs(building.walls.find(w=>w.id===window.wallId).thicknessFt-.8)<1e-8)
 }
})
test('missing, unclassified or inconsistent pier faces cannot turn pane depth into wall thickness',()=>{
 for(const change of ['missing','unknown','inconsistent']){
  const f=fixture()
  if(change==='missing')f.input.evidence.paths=f.input.evidence.paths.filter(p=>p.id!==7)
  if(change==='unknown')f.input.evidence.paths.filter(p=>p.id>=6).forEach(p=>p.layer=[])
  if(change==='inconsistent')f.input.evidence.paths.find(p=>p.id===7).commands.forEach(c=>c[1]-=.2/30)
  assert.equal(measuredWindowHosts(f.input,f.architecture)[0].host,null)
  assert.ok(reconstructBuilding(f.input,f.architecture).issues.some(i=>i.code==='window-host-missing'&&i.severity==='error'))
 }
})
function disputedPiers(angle=0){
 const f=fixture(angle)
 f.input.evidence.paths.filter(p=>p.id>=6).forEach(p=>p.layer=[])
 f.input.visualObservations=[{id:'broad',region:f.input.region,suppliedPathIds:[6,7],elements:[{kind:'annotation',pathIds:[6,7]}],openings:[]}]
 return f
}
test('reinspection selects matching unclassified pier faces without making them structural',()=>{
 for(const angle of [0,Math.PI/2,.63,Math.PI]){
  const f=disputedPiers(angle),original=structuredClone(f.input)
  const plan=planArchitecturalReinspection(f.input,f.architecture)
  assert.equal(plan.length,1)
  assert.deepEqual(plan[0].request.catalogue.map(p=>p.id).sort(),[6,7])
  assert.equal(measuredWindowHosts(f.input,f.architecture)[0].host,null)
  assert.deepEqual(f.input,original)
 }
 const f=disputedPiers();f.input.evidence.paths=f.input.evidence.paths.filter(p=>p.id!==7)
 assert.equal(planArchitecturalReinspection(f.input,f.architecture).length,0)
 assert.equal(planArchitecturalReinspection(fixture().input,fixture().architecture).length,0)
})
test('focused repair retains contradictory provenance and only reconstructs an isolated alternative',async()=>{
 const f=disputedPiers(),original=structuredClone(f.input)
 const report=await reinspectArchitecture(f.input,f.architecture,async request=>({elements:[{kind:'column',pathIds:request.catalogue.map(p=>p.id)}]}))
 assert.equal(report.qualification,'unqualified-alternative');assert.equal(report.changes.length,2)
 assert.ok(report.changes.every(c=>c.before==='annotation'&&c.proposed==='column'&&c.contradictsPrior&&c.priorObservationIds[0]==='broad'))
 const merged=interpretArchitecturalElements(f.input.evidence,[...f.input.visualObservations,report.attempts[0].observation])
 assert.ok(merged.filter(e=>e.pathId>=6).every(e=>e.conflict))
 const alternative=reinspectionAlternative(f.input,report)
 assert.ok(measuredWindowHosts(alternative,f.architecture)[0].host)
 assert.equal(measuredWindowHosts(f.input,f.architecture)[0].host,null)
 assert.deepEqual(f.input,original)
})
test('reinspection cannot change CAD, invent paths, or resolve a conflicting or unknown answer',async()=>{
 for(const elements of [[{kind:'column',pathIds:[0,999]}],[{kind:'unknown',pathIds:[6,7]}],[{kind:'column',pathIds:[6,7]},{kind:'annotation',pathIds:[6,7]}]]){
  const f=disputedPiers(),report=await reinspectArchitecture(f.input,f.architecture,async()=>({elements}))
  assert.deepEqual(report.changes,[])
  assert.equal(measuredWindowHosts(reinspectionAlternative(f.input,report),f.architecture)[0].host,null)
 }
})
test('focused reinspection obeys request limits, reuses cached answers and tolerates provider failure',async()=>{
 const f=disputedPiers();let calls=0
 const recognize=async()=>{calls++;throw Error('Unavailable')}
 let report=await reinspectArchitecture(f.input,f.architecture,recognize,0)
 assert.equal(calls,0);assert.equal(report.attempts[0].status,'budget-exhausted')
 report=await reinspectArchitecture(f.input,f.architecture,recognize,1)
 assert.equal(calls,1);assert.equal(report.attempts[0].status,'unavailable');assert.deepEqual(report.changes,[])
 recognize.cached=async()=>({elements:[{kind:'column',pathIds:[6,7]}]})
 report=await reinspectArchitecture(f.input,f.architecture,recognize,0)
 assert.equal(calls,1);assert.equal(report.changes.length,2)
 for(const budget of [-1,1.5,NaN,5])await assert.rejects(()=>reinspectArchitecture(f.input,f.architecture,recognize,budget),/budget/)
})
test('paired pane candidates between returning walls can be reinspected before a room exists',async()=>{
 const f=fixture();f.architecture.spaces=[]
 f.input.evidence.raster={width:1000,height:1000,feetPerPixel:.03,threshold:138,maximumDeviationPixels:2,region:f.input.region}
 f.input.evidence.paths.filter(p=>p.id===4||p.id===5).forEach(p=>p.layer=[])
 f.input.visualObservations=[{id:'broad',region:f.input.region,suppliedPathIds:[4,5],elements:[{kind:'fixture',pathIds:[4,5]}]}]
 const plan=planArchitecturalReinspection(f.input,f.architecture)
 assert.equal(plan.length,1);assert.equal(plan[0].reason,'window-candidate')
 assert.deepEqual(plan[0].request.catalogue.map(p=>p.id).sort(),[4,5])
 const before=structuredClone(f.input)
 const report=await reinspectArchitecture(f.input,f.architecture,async()=>({elements:[{kind:'window',pathIds:[4,5]}]}),1)
 assert.equal(report.changes.length,2);assert.ok(report.changes.every(c=>c.contradictsPrior))
 assert.deepEqual(f.input,before)
 f.input.evidence.paths=f.input.evidence.paths.filter(p=>p.id!==5)
 assert.equal(planArchitecturalReinspection(f.input,f.architecture).length,0,'one unsupported line must not cause an opening repair request')
})
test('reviewed floor quantities preserve inferred window provenance through save validation',()=>{
 const f=fixture(),room=f.architecture.spaces[0]
 const area={id:room.id,label:'Room',points:room.points,originalPoints:room.points,holes:[],boundary:room.sourceBoundaries,source:'vision',edited:false}
 const saved=acceptedAreaSchema.parse(JSON.parse(JSON.stringify(area)))
 assert.equal(saved.boundary[0].source,'window');assert.equal(saved.boundary[0].pathId,4)
 assert.deepEqual(saved.points,room.points)
 assert.equal(acceptedAreaSchema.safeParse({...area,boundary:[{...area.boundary[0],source:'guessed'}]}).success,false)
})
test('nearly vertical duplicate door thresholds do not create overlapping reversed hosts',()=>{
 const path=(id,points)=>({id,kind:'stroke',layer:['A-WALL'],groups:[],clips:[],dashes:[],color:[0],colorSpace:'DeviceGray',opacity:1,width:1,evenOdd:false,commands:points.map((p,i)=>[i?'L':'M',p[0]/20,p[1]/20])})
 const input={segments:[],imageWidth:1000,imageHeight:1000,feetPerImagePx:.02,textRuns:[],region:{x0:0,y0:0,x1:1,y1:1},evidence:{version:1,truncated:false,paths:[path(1,[[5,1],[5,4]]),path(2,[[5.5,1],[5.5,4]]),path(3,[[5,7],[5,10]]),path(4,[[5.5,7],[5.5,10]])]}}
 const architecture={spaces:[],openings:[{id:'a',boundary:{a:[5/20,4/20],b:[5/20,7/20],source:'doorway'},spaceIds:[]},{id:'b',boundary:{a:[5/20,7/20],b:[5.005/20,4/20],source:'doorway'},spaceIds:[]}],elements:[]}
 const building=reconstructBuilding(input,architecture)
 assert.equal(building.openings.filter(o=>o.kind==='door').length,1)
 assert.equal(building.walls.filter(w=>w.basis==='opening-host').length,1)
 assert.ok(Math.abs(building.openings[0].widthFt-3)<.01)
})
test('paired window panes cannot disappear silently when host reconstruction fails',()=>{
 for(const angle of [0,Math.PI/2,.63,Math.PI]){
  const f=fixture(angle);f.input.evidence.paths=f.input.evidence.paths.filter(p=>p.id<6)
  const building=reconstructBuilding(f.input,f.architecture)
  const missing=building.issues.filter(i=>i.code==='unrepresented-window')
  assert.equal(missing.length,1);assert.deepEqual(missing[0].pathIds,[4,5]);assert.ok(missing[0].point)
  const complete=fixture(angle)
  assert.equal(reconstructBuilding(complete.input,complete.architecture).issues.filter(i=>i.code==='unrepresented-window').length,0)
 }
})
test('window omission markers require paired evidence and respect actual opening coverage',()=>{
 const panes=[{a:[0,0],b:[5,0],pathIds:[1]},{a:[0,.1],b:[5,.1],pathIds:[2]}]
 assert.equal(unrepresentedWindows(panes,[]).length,1)
 assert.equal(unrepresentedWindows(panes.slice(0,1),[]).length,0)
 assert.equal(unrepresentedWindows([panes[0],{a:[0,1],b:[5,1],pathIds:[2]}],[]).length,0)
 assert.equal(unrepresentedWindows(panes,[{a:[0,0],b:[5,0],thicknessFt:.8}]).length,0)
 assert.equal(unrepresentedWindows(panes,[{a:[0,0],b:[2,0],thicknessFt:.8}]).length,1)
 assert.equal(unrepresentedWindows(panes,[{a:[0,0],b:[2.5,0],thicknessFt:.8},{a:[2.5,0],b:[5,0],thicknessFt:.8}]).length,0)
 assert.equal(unrepresentedWindows(panes,[{a:[0,3],b:[5,3],thicknessFt:.8}]).length,1)
 const second=panes.map(p=>({...p,a:[p.a[0]+6,p.a[1]],b:[p.b[0]+6,p.b[1]],pathIds:p.pathIds.map(id=>id+2)}))
 assert.equal(unrepresentedWindows([...panes,...second],[]).length,2)
 assert.equal(unrepresentedWindows(panes.map(p=>({...p,a:p.b,b:p.a})),[]).length,1)
})
test('continuous raster wall alignment is pixel bounded, rotation independent and rejects real bends',()=>{
 for(const angle of [0,.63,Math.PI/2,Math.PI]){
  const rotate=([x,y])=>[20+x*Math.cos(angle)-y*Math.sin(angle),10+x*Math.sin(angle)+y*Math.cos(angle)]
  const points=[[0,0],[2,0],[2.02,.03],[2.06,0],[5,0]].map(rotate),original=structuredClone(points)
  const fit=alignRasterWallRun(points,.01)
  assert.ok(fit);assert.ok(Math.abs(fit.maximumDeviationFt-.03)<1e-8)
  assert.ok(fit.points.every((p,i)=>Math.hypot(p[0]-rotate([i*5,0])[0],p[1]-rotate([i*5,0])[1])<1e-8))
  assert.deepEqual(points,original)
  const reverse=alignRasterWallRun([...points].reverse(),.01)
  assert.ok(reverse);assert.ok(Math.hypot(reverse.points[0][0]-fit.points[1][0],reverse.points[0][1]-fit.points[1][1])<1e-8)
 }
 assert.equal(alignRasterWallRun([[0,0],[2,0],[2.02,.06],[5,0]],.01),null)
 assert.equal(alignRasterWallRun([[0,0],[2,0],[2.02,.03],[5,0]],.005),null)
 assert.equal(alignRasterWallRun([[0,0],[2,0],[2,2]],.01),null)
 assert.equal(alignRasterWallRun([[0,0],[5,0],[2,0],[6,0]],.01),null)
 assert.equal(alignRasterWallRun([[0,0],[2,0],[0,0]],.01),null)
})
test('a window can cut an aligned continuous raster wall without joining disconnected source rings',()=>{
 const path=(id,points,kind)=>({id,kind:'stroke',rasterFeature:'linework',layer:[`A-${kind}`],groups:[],clips:[],dashes:[],color:[0],colorSpace:'DeviceGray',opacity:1,width:1,evenOdd:false,commands:points.map((p,i)=>[i?'L':'M',p[0]/20,p[1]/20])})
 const paths=[path(1,[[1,5],[4,5],[4.02,5.03],[4.06,5],[12,5]],'WALL'),path(2,[[1,5.8],[6,5.8],[6.02,5.77],[6.06,5.8],[12,5.8]],'WALL'),path(3,[[3,5.3],[10,5.3]],'WINDOW'),path(4,[[3,5.4],[10,5.4]],'WINDOW')]
 const input={segments:[],imageWidth:1000,imageHeight:1000,feetPerImagePx:.02,textRuns:[],region:{x0:0,y0:0,x1:1,y1:1},evidence:{version:1,paths,truncated:false,raster:{feetPerPixel:.01}}}
 const architecture={spaces:[],openings:[],elements:[]}
 const building=reconstructBuilding(input,architecture)
 assert.equal(building.walls.length,1);assert.equal(building.openings.length,1)
 assert.ok(Math.abs(building.openings[0].widthFt-7)<1e-8)
 assert.ok(building.issues.some(i=>i.code==='raster-wall-alignment'))
 const split=structuredClone(input)
 for(const p of split.evidence.paths.filter(p=>p.id<3)){const y=p.id===1?5:5.8;p.commands=[['M',1/20,y/20],['L',5/20,y/20],['M',7/20,y/20],['L',12/20,y/20]]}
 assert.equal(reconstructBuilding(split,architecture).openings.length,0)
 const vector=structuredClone(input);delete vector.evidence.raster
 assert.equal(reconstructBuilding(vector,architecture).issues.some(i=>i.code==='raster-wall-alignment'),false)
})
function framedRasterWindow(angle=0){
 const c=Math.cos(angle),s=Math.sin(angle),turn=([x,y])=>[10+x*c-y*s,10+x*s+y*c]
 const lines=[[[0,0],[0,.3],[0,.4],[0,.8]],[[6,0],[6,.3],[6,.4],[6,.8]],[[0,0],[6,0]],[[0,.8],[6,.8]],[[0,.3],[2.9,.3]],[[0,.4],[2.9,.4]],[[3.1,.3],[6,.3]],[[3.1,.4],[6,.4]],[[2.9,.3],[2.9,.4],[3.1,.4],[3.1,.3],[2.9,.3]]]
 const paths=lines.map((points,id)=>({id,kind:'stroke',rasterFeature:'linework',layer:['A-WINDOW'],groups:[],clips:[],dashes:[],color:[0],colorSpace:'DeviceGray',opacity:1,width:1,evenOdd:false,commands:points.map((p,i)=>[i?'L':'M',...turn(p).map(n=>n/30)])}))
 return {segments:[],imageWidth:1000,imageHeight:1000,feetPerImagePx:.03,textRuns:[],region:{x0:0,y0:0,x1:1,y1:1},evidence:{version:1,paths,truncated:false,raster:{feetPerPixel:.01}}}
}
test('connected multi-pane raster frames produce one full source-supported window candidate',()=>{
 for(const angle of [0,.63,Math.PI/2,Math.PI]){
  const input=framedRasterWindow(angle),original=structuredClone(input),assemblies=rasterWindowAssemblies(input)
  assert.equal(assemblies.length,1)
  assert.ok(Math.abs(Math.hypot(assemblies[0].b[0]-assemblies[0].a[0],assemblies[0].b[1]-assemblies[0].a[1])-6)<1e-8)
  assert.deepEqual(assemblies[0].pathIds,[0,1,2,3,4,5,6,7,8])
  assert.deepEqual(input,original)
 }
})
test('pane proximity, absent returns, unsupported semantics and incomplete crops cannot create a frame',()=>{
 for(const change of ['no-returns','unknown','clipped','cropped','vector']){
  const input=framedRasterWindow()
  if(change==='no-returns')input.evidence.paths=input.evidence.paths.filter(p=>p.id!==1)
  if(change==='unknown')input.evidence.paths.forEach(p=>p.layer=[])
  if(change==='clipped')input.evidence.paths.forEach(p=>p.clips=[999])
  if(change==='cropped')input.region.x1=.5
  if(change==='vector')delete input.evidence.raster
  assert.equal(rasterWindowAssemblies(input).length,0,change)
 }
 const input=framedRasterWindow(),second=structuredClone(input.evidence.paths).map(p=>({...p,id:p.id+20,commands:p.commands.map(c=>[c[0],c[1]+6.2/30,c[2]])}))
 input.evidence.paths.push(...second)
 assert.equal(rasterWindowAssemblies(input).length,2,'separate nearby complete frames must not merge')
})
test('a full multi-pane assembly cuts its measured host once and cannot create a host from frame ink alone',()=>{
 const input=framedRasterWindow(),architecture={spaces:[],openings:[],elements:[]}
 assert.equal(reconstructBuilding(input,architecture).openings.length,0)
 for(const [id,y]of [[100,10],[101,10.8]])input.evidence.paths.push({...input.evidence.paths[0],id,layer:['A-WALL'],commands:[['M',9/30,y/30],['L',17/30,y/30]]})
 const building=reconstructBuilding(input,architecture)
 assert.equal(building.openings.length,1);assert.equal(building.openings[0].kind,'window')
 assert.equal(building.openings[0].widthBasis,'connected-frame')
 assert.ok(Math.abs(building.openings[0].widthFt-6)<1e-8)
 assert.equal(building.issues.filter(i=>i.code==='window-frame-assembly').length,1)
 assert.equal(building.issues.filter(i=>i.code==='unrepresented-window').length,0)
})
