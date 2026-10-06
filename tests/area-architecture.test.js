require('../scripts/register-ts-node-test')
const test = require('node:test'), assert = require('node:assert/strict')
const { interpretArchitecturalElements, visualOpeningBoundaries } = require('../lib/drawings/area-semantics')
const { reconcileAreaCandidates, areaGeometryKey } = require('../lib/drawings/area-candidates')
const { runAreaEngine } = require('../lib/drawings/area-engine')
const { createAreaReplay, replayAreaDetection } = require('../lib/drawings/area-replay')
const { geometricStructureIds } = require('../lib/drawings/area-structure')
const ring = (x0,y0,x1,y1) => [[x0,y0],[x1,y0],[x1,y1],[x0,y1]]
const path = (id, points, layer = [], kind = 'stroke') => ({ id, kind, commands:points.map((p,i)=>[i?'L':'M',...p]), layer, opacity:1, color:[0], colorSpace:'DeviceGray', width:1, dashes:[], clips:[], groups:[], evenOdd:false })
const evidence = paths => ({version:1, paths, truncated:false})
const input = paths => ({segments:[], evidence:evidence(paths), textRuns:[{text:'BEDROOM',x:.3,y:.4,w:.2,h:.02}],imageWidth:1000,imageHeight:1000,feetPerImagePx:.02,region:{x0:0,y0:0,x1:1,y1:1}})
const observation = (elements, openings = []) => ({id:'test',region:{x0:0,y0:0,x1:1,y1:1},suppliedPathIds:[1,2,3,4,5,6],elements,openings})
const proposal = (points, label='Room') => ({id:'room',label,points,originalPoints:points,holes:[],boundary:[],areaSqft:Math.abs(points.reduce((n,p,i)=>n+p[0]*points[(i+1)%points.length][1]-p[1]*points[(i+1)%points.length][0],0))/2*400,warnings:[],source:'vector',edited:false})

test('visual classifications cannot invent paths, override CAD, or resolve conflicting votes',()=>{
 const e=evidence([path(1,ring(.1,.1,.9,.9),['A-WALL']),path(2,ring(.2,.2,.3,.3))])
 const result=interpretArchitecturalElements(e,[observation([{pathIds:[1,2,999],kind:'furniture'}]),{...observation([{pathIds:[2],kind:'wall'}]),id:'other'}])
 assert.equal(result.length,2);assert.equal(result[0].kind,'wall');assert.equal(result[0].conflict,true)
 assert.equal(result[1].kind,'unknown');assert.equal(result[1].conflict,true)
})
test('a crop cannot classify a path it did not receive or cannot fully see',()=>{
 const e=evidence([path(1,ring(.1,.1,.9,.9))])
 assert.equal(interpretArchitecturalElements(e,[{...observation([{pathIds:[1],kind:'wall'}]),suppliedPathIds:[]}])[0].kind,'unknown')
 assert.equal(interpretArchitecturalElements(e,[{...observation([{pathIds:[1],kind:'wall'}]),region:{x0:0,y0:0,x1:.5,y1:.5}}])[0].kind,'unknown')
})
test('candidate reconciliation is permutation independent and retains conflicting alternatives',()=>{
 const whole=proposal(ring(.1,.1,.9,.9),'merged'),left=proposal(ring(.1,.1,.5,.9),'left'),right=proposal(ring(.5,.1,.9,.9),'right')
 const candidates=[{area:whole,support:.65,interpretation:'a'},{area:left,support:1,interpretation:'b'},{area:right,support:1,interpretation:'c'}]
 const a=reconcileAreaCandidates(candidates),b=reconcileAreaCandidates([...candidates].reverse())
 assert.deepEqual(a,b);assert.equal(a.proposals.length,2);assert.equal(a.alternatives.length,1);assert.equal(a.conflicts.length,1)
 assert.ok(a.proposals.every(p=>p.warnings.some(w=>w.includes('Competing'))))
})
test('geometry identity includes deductions and ignores winding and start vertex',()=>{
 const p=proposal(ring(.1,.1,.9,.9)),rotated={...p,points:[...p.points.slice(2),...p.points.slice(0,2)].reverse()}
 assert.equal(areaGeometryKey(p),areaGeometryKey(rotated))
 assert.notEqual(areaGeometryKey(p),areaGeometryKey({...p,holes:[ring(.2,.2,.3,.3)]}))
})
test('visual doorway anchors must be real wall vertices with nearby door evidence',()=>{
 const paths=[path(1,[[.1,.1],[.4,.1]],['A-WALL']),path(2,[[.55,.1],[.9,.1]],['A-WALL']),path(3,[[.4,.1],[.55,.18]],['A-DOOR'])]
 const o=observation([],[{a:{pathId:1,commandIndex:1},b:{pathId:2,commandIndex:0},doorPathIds:[3]}])
 const edges=visualOpeningBoundaries(evidence(paths),[o],20,20)
 assert.deepEqual(edges,[{a:[.4,.1],b:[.55,.1],source:'doorway',observationId:'test'}])
 const invented=structuredClone(o);invented.openings[0].a.commandIndex=99
 assert.equal(visualOpeningBoundaries(evidence(paths),[invented],20,20).length,0)
 assert.equal(visualOpeningBoundaries(evidence(paths.map(p=>p.id===3?{...p,layer:[]}:p)),[o],20,20).length,0)
 const blocked=[...paths,path(4,[[.475,.05],[.475,.15]],['A-WALL'])]
 assert.equal(visualOpeningBoundaries(evidence(blocked),[o],20,20).length,0)
})
test('hybrid interpretation closes a supported missed doorway and replay reproduces exact geometry',async()=>{
 const source=input([path(1,[[.1,.1],[.4,.1]],['A-WALL']),path(2,[[.55,.1],[.9,.1]],['A-WALL']),path(3,[[.4,.1],[.55,.18]],['A-DOOR']),path(4,[[.9,.1],[.9,.9],[.1,.9],[.1,.1]],['A-WALL'])])
 const base=await runAreaEngine(source,{wholeSheet:false})
 assert.equal(base.detection.proposals.length,0)
 const result=await runAreaEngine(source,{wholeSheet:false,recognize:async()=>({elements:[],openings:[{a:{pathId:1,commandIndex:1},b:{pathId:2,commandIndex:0},doorPathIds:[3]}]})})
 assert.equal(result.detection.proposals.length,1)
 assert.ok(Math.abs(result.detection.proposals[0].areaSqft-256)<1e-6)
 assert.ok(result.detection.proposals[0].boundary.some(e=>e.observationId))
 assert.equal(result.detection.architecture.spaces[0].boundary.status,'needs-review')
 const replay=createAreaReplay({...source,visualObservations:result.observations},false,{},result.recognition)
 const replayed=await replayAreaDetection(JSON.parse(JSON.stringify(replay)))
 assert.deepEqual(replayed.detection.proposals,result.detection.proposals)
 const corrupt=structuredClone(replay);corrupt.input.feetPerImagePx=.03
 await assert.rejects(()=>replayAreaDetection(corrupt),/corrupt/)
})
test('raster extraction without a classifier reports unavailable recognition and survives replay',async()=>{
 const source=input([path(1,[...ring(.1,.1,.9,.9),[.1,.1]])])
 source.evidence.raster={width:1000,height:1000,feetPerPixel:.02,threshold:140,maximumDeviationPixels:.8,region:source.region}
 const result=await runAreaEngine(source,{wholeSheet:false})
 assert.equal(result.recognition,'unavailable')
 assert.equal(result.observations.length,0)
 assert.ok(result.detection.warnings.some(w=>/no architectural classifier/.test(w)))
 assert.equal(result.detection.architecture.building.walls.length,0)
 assert.ok(result.detection.architecture.building.issues.some(i=>i.code==='recognition-coverage'&&i.severity==='review'))
 const replayed=await replayAreaDetection(createAreaReplay(source,false,{},result.recognition))
 assert.equal(replayed.recognition,'unavailable')
 assert.deepEqual(replayed.detection.architecture.building,result.detection.architecture.building)
})
test('failed recognition preserves vector results and reports the unavailable route',async()=>{
 const source=input([path(1,[...ring(.1,.1,.9,.9),[.1,.1]])])
 const base=await runAreaEngine(source,{wholeSheet:false})
 const result=await runAreaEngine(source,{wholeSheet:false,recognize:async()=>{throw Error('offline')}})
 assert.deepEqual(result.detection.proposals,base.detection.proposals)
 assert.equal(result.recognition,'unavailable')
})
test('mixed named doors do not disable unknown filled wall network inference',()=>{
 const walls=[path(1,[...ring(.1,.1,.9,.125),[.1,.1]],[],'fill'),path(2,[...ring(.1,.1,.125,.9),[.1,.1]],[],'fill'),path(3,[...ring(.1,.875,.9,.9),[.1,.875]],[],'fill')]
 const baseline=geometricStructureIds(evidence(walls),20,20)
 assert.ok(baseline.size>=3)
 assert.deepEqual(geometricStructureIds(evidence([...walls,path(4,[[.3,.3],[.4,.4]],['A-DOOR'])]),20,20),baseline)
})

test('captured synthetic model observations recover two rooms and conserve analytic floor area',async()=>{
 const fixture=require('./fixtures/area-architecture/synthetic-open-door.json')
 const result=await runAreaEngine(fixture.input,{wholeSheet:true})
 assert.equal(result.detection.proposals.length,2)
 const areas=result.detection.proposals.map(p=>p.areaSqft).sort((a,b)=>a-b)
 areas.forEach((area,i)=>assert.ok(Math.abs(area-fixture.expected.roomAreasSqft[i])<1e-6))
 assert.ok(Math.abs(areas.reduce((a,b)=>a+b,0)-fixture.expected.totalSqft)<1e-6)
 assert.ok(result.detection.architecture.spaces.every(s=>s.boundary.status==='needs-review'))
})

test('a large uncertain candidate cannot displace a smaller equally supported area',()=>{
 const small=proposal(ring(.1,.1,.3,.3),'bath'),large=proposal(ring(.1,.1,.9,.9),'merged')
 const result=reconcileAreaCandidates([{area:large,support:.1,interpretation:'a'},{area:small,support:.1,interpretation:'b'}])
 assert.equal(result.proposals[0].label,'bath');assert.equal(result.conflicts.length,1)
})

test('tied counter-interpretations preserve the primary preview and stronger evidence can replace it',()=>{
 const room=proposal(ring(.1,.1,.9,.9),'whole-context'),fragment=proposal(ring(.1,.1,.3,.3),'tight-context')
 const candidates=[{area:room,support:.8,primary:true,interpretation:'whole'},
   {area:fragment,support:.8,interpretation:'local'}]
 const result=reconcileAreaCandidates(candidates)
 assert.equal(result.proposals[0].label,'whole-context')
 assert.deepEqual(result,reconcileAreaCandidates([...candidates].reverse()))
 assert.equal(result.alternatives.length,1)
 // Additional architectural evidence can still overturn the broad view.
 assert.equal(reconcileAreaCandidates([candidates[0],{...candidates[1],support:1}]).proposals[0].label,'tight-context')
 // Likewise, a larger enclosure cannot absorb the primary small room on a tie.
 assert.equal(reconcileAreaCandidates([{...candidates[0],primary:false},{...candidates[1],primary:true}]).proposals[0].label,'tight-context')
})

test('physical space includes fixture footprints while a separate finish zone can deduct them',async()=>{
 const source=input([path(1,[...ring(.1,.1,.9,.9),[.1,.1]],['A-WALL']),path(2,[...ring(.4,.4,.6,.6),[.4,.4]],['A-PLUMB'])])
 source.textRuns=[{text:'BATHROOM',x:.2,y:.2,w:.1,h:.02}]
 const result=await runAreaEngine(source,{wholeSheet:false})
 assert.equal(result.detection.proposals.length,1)
 assert.ok(Math.abs(result.detection.proposals[0].areaSqft-240)<1e-6)
 const model=result.detection.architecture
 assert.equal(model.spacePolicy,'include-fixtures')
 assert.equal(model.spaces.length,1);assert.ok(Math.abs(model.spaces[0].areaSqft-256)<1e-6)
 assert.equal(model.finishZones[0].areaSqft,240)
 assert.deepEqual(model.finishZones[0].spaceIds,[model.spaces[0].id])
 assert.equal(model.finishZones[0].scope,'needs-review')
})

test('dense crop classification pages every eligible path and marks a bounded run partial',async()=>{
 const source=input(Array.from({length:175},(_,i)=>path(i,[[.2,.2+i*.001],[.4,.2+i*.001]])))
 source.textRuns=[]
 const seen=[]
 const recognize=async request=>{seen.push(...request.catalogue.map(p=>p.id));assert.ok(request.catalogue.length<=64);return {elements:[{kind:'annotation',pathIds:request.catalogue.map(p=>p.id)}],openings:[]}}
 const complete=await runAreaEngine(source,{wholeSheet:false,recognize,maxRecognitionWindows:3})
 assert.equal(new Set(seen).size,175)
 assert.equal(complete.recognition,'completed')
 const bounded=await runAreaEngine(source,{wholeSheet:false,recognize,maxRecognitionWindows:1})
 assert.equal(bounded.recognition,'partial')
 assert.ok(bounded.detection.architecture.building.issues.some(i=>i.code==='recognition-coverage'))
})
test('omitted or unknown path classifications cannot claim completion',async()=>{
 const source=input([path(1,[[.1,.1],[.9,.1]]),path(2,[[.1,.2],[.9,.2]])]);source.textRuns=[]
 const run=await runAreaEngine(source,{wholeSheet:false,recognize:async()=>({elements:[{kind:'annotation',pathIds:[1]}],openings:[]})})
 assert.equal(run.recognition,'partial')
})
test('bounded recognition advances beyond persisted batches and a cached-only replay makes no new requests',async()=>{
 const source=input(Array.from({length:175},(_,i)=>path(i,[[.2,.2+i*.001],[.4,.2+i*.001]])));source.textRuns=[]
 const saved=new Map(),calls=[],key=r=>JSON.stringify(r)
 const recognize=async r=>{calls.push(r.catalogue.map(p=>p.id));const answer={elements:[{kind:'annotation',pathIds:r.catalogue.map(p=>p.id)}],openings:[]};saved.set(key(r),answer);return answer}
 recognize.cached=async r=>saved.get(key(r))??null
 for(let run=1;run<=3;run++){
  const result=await runAreaEngine(source,{wholeSheet:false,recognize,maxRecognitionWindows:1})
  assert.equal(calls.length,run)
  assert.equal(result.observations.length,run)
  assert.equal(new Set(result.observations.map(o=>o.id)).size,run)
  assert.equal(result.recognition,run===3?'completed':'partial')
 }
 assert.equal(new Set(calls.flat()).size,175)
 const replay=await runAreaEngine(source,{wholeSheet:false,recognize,maxRecognitionWindows:0})
 assert.equal(replay.recognition,'completed');assert.equal(calls.length,3)
})
test('saved classifications after a failed or corrupt batch remain available without exceeding the request allowance',async()=>{
 const source=input(Array.from({length:175},(_,i)=>path(i,[[.2,.2+i*.001],[.4,.2+i*.001]])));source.textRuns=[]
 let calls=0
 const recognize=async()=>{calls++;throw Error('unavailable')}
 recognize.cached=async r=>r.catalogue[0].id===0?{elements:'corrupt'}:{elements:[{kind:'annotation',pathIds:r.catalogue.map(p=>p.id)}],openings:[]}
 const result=await runAreaEngine(source,{wholeSheet:false,recognize,maxRecognitionWindows:1})
 assert.equal(calls,1);assert.equal(result.recognition,'partial');assert.equal(result.observations.length,2)
 assert.deepEqual(result.observations.map(o=>o.id),['visual-2','visual-3'])
})
test('cached conflicting labels retain the coverage review requirement',async()=>{
 const source=input([path(1,[[.1,.1],[.9,.1]])]);source.textRuns=[]
 const recognize=async()=>{throw Error('No live request expected')}
 recognize.cached=async()=>({elements:[{kind:'wall',pathIds:[1]},{kind:'annotation',pathIds:[1]}],openings:[]})
 const result=await runAreaEngine(source,{wholeSheet:false,recognize,maxRecognitionWindows:0})
 assert.equal(result.recognition,'partial')
 assert.ok(result.detection.architecture.building.issues.some(i=>i.code==='recognition-coverage'))
})

test('visual door and wall classifications support the same source-anchored pocket thresholds as CAD',()=>{
 const {slidingDoorThresholds}=require('../lib/drawings/area-doorways')
 const edge=(a,b,pathId)=>({a,b,pathId,source:'drawn'})
 const walls=[edge([0,0],[4,0],1),edge([7,0],[10,0],1),edge([4,0],[4,.33],1),edge([7,0],[7,.33],1)]
 const panel=edge([4,.2],[6,.2],2)
 const named={paths:[{id:1,layer:['A_WALL']},{id:2,layer:['A_DOOR']}]},plain={paths:named.paths.map(p=>({...p,layer:[]}))}
 const classified=new Map([[1,'wall'],[2,'door']])
 assert.deepEqual(slidingDoorThresholds([...walls,panel],plain,[],classified),slidingDoorThresholds([...walls,panel],named))
 assert.equal(slidingDoorThresholds([...walls,panel],plain).length,0)
 assert.equal(slidingDoorThresholds([...walls,panel],plain,[],new Map([[1,'wall'],[2,'unknown']])).length,0)
})
test('raster jamb drift and an offset sliding panel do not suppress the actual finish-face doorway',()=>{
 const {slidingDoorThresholds}=require('../lib/drawings/area-doorways')
 const make=(angle=0)=>{
  const turn=p=>[p[0]*Math.cos(angle)-p[1]*Math.sin(angle),p[0]*Math.sin(angle)+p[1]*Math.cos(angle)]
  return [[[0,0],[4,0],1],[[9,0],[12,0],1],[[4,0],[4.01,.33],1],[[9,0],[8.99,.33],1],[[4.065,.065],[6.6,.065],2],[[6.5,.17],[8.985,.17],2]].map(([a,b,pathId])=>({a:turn(a),b:turn(b),pathId,source:'drawn'}))
 }
 const evidence={paths:[{id:1,layer:['A_WALL']},{id:2,layer:['A_DOOR']}],raster:{feetPerPixel:.01}}
 for(const angle of [0,.63,Math.PI/2]){
  const result=slidingDoorThresholds(make(angle),evidence,[],undefined,.1)
  assert.equal(result.length,1)
  assert.ok(Math.abs(Math.hypot(result[0].a[0]-result[0].b[0],result[0].a[1]-result[0].b[1])-5)<1e-9)
 }
 assert.equal(slidingDoorThresholds(make(),{paths:evidence.paths},[],undefined,.1).length,0,'raster uncertainty must not weaken exact vector jamb checks')
 assert.equal(slidingDoorThresholds(make().filter((_,i)=>i!==2),evidence,[],undefined,.1).length,0)
 assert.equal(slidingDoorThresholds(make().filter(e=>e.pathId===1),evidence,[],undefined,.1).length,0)
})
test('a drawn midpoint suppresses a sliding threshold only when the entire finish-face span is already closed',()=>{
 const {slidingDoorThresholds}=require('../lib/drawings/area-doorways')
 const edge=(a,b,pathId)=>({a,b,pathId,source:'drawn'})
 const base=[edge([0,0],[4,0],1),edge([9,0],[12,0],1),edge([4,0],[4,.33],1),edge([9,0],[9,.33],1),edge([4,0],[6.6,0],2),edge([6.5,.17],[9,.17],2)]
 const evidence={paths:[{id:1,layer:['A_WALL']},{id:2,layer:['A_DOOR']}]}
 assert.equal(slidingDoorThresholds(base,evidence).length,1)
 assert.equal(slidingDoorThresholds([...base,edge([6.6,0],[9,0],1)],evidence).length,0)
})
test('raster curve fitting accounts for measured pixel uncertainty without accepting distorted door swings',()=>{
 const {fitOpeningArc}=require('../lib/drawings/area-opening-curves')
 const curve=Array.from({length:17},(_,i)=>{const angle=i*Math.PI/32,radius=3+(i%2?.04:0);return [radius*Math.cos(angle),radius*Math.sin(angle)]})
 assert.equal(fitOpeningArc(curve),null)
 assert.ok(fitOpeningArc(curve,.065))
 const damaged=curve.map((p,i)=>i===5?[p[0]+.5,p[1]]:p)
 assert.equal(fitOpeningArc(damaged,.065),null)
 assert.equal(fitOpeningArc(damaged,5),null,'source uncertainty cannot expand into an arbitrary architectural gap')
})

test('replaying a partial recognition run preserves its missing-coverage review requirement',async()=>{
 const source=input([path(1,[[.1,.1],[.9,.1],[.9,.9],[.1,.9],[.1,.1]],['A-WALL'])])
 source.visualObservations=[{id:'saved-crop',region:source.region,suppliedPathIds:[1],elements:[{kind:'wall',pathIds:[1]}],openings:[]}]
 const record=createAreaReplay(source,false,{},'partial')
 const replay=await replayAreaDetection(JSON.parse(JSON.stringify(record)))
 assert.equal(replay.recognition,'partial')
 assert.ok(replay.detection.architecture.building.issues.some(i=>i.code==='recognition-coverage'))
 source.visualObservations=[]
 const unavailable=await replayAreaDetection(createAreaReplay(source,false,{},'unavailable'))
 assert.equal(unavailable.recognition,'unavailable')
 assert.ok(unavailable.detection.architecture.building.issues.some(i=>i.code==='recognition-coverage'))
})

test('overlapping first-pass crops schedule each complete source path only once',async()=>{
 const source=input([.2,.35,.5,.65].map((x,i)=>path(i+1,[[x,.3],[x+.02,.3]])));
 source.feetPerImagePx=.1;source.textRuns=[];
 const seen=[],recognize=async()=>{throw Error('Cache-only planning diagnostic')};
 recognize.cached=async r=>{seen.push(...r.catalogue.map(p=>p.id));return {elements:[{kind:'annotation',pathIds:r.catalogue.map(p=>p.id)}],openings:[]}};
 const run=await runAreaEngine(source,{wholeSheet:false,recognize,maxRecognitionWindows:0});
 assert.equal(run.recognition,'completed');assert.equal(seen.length,4);assert.equal(new Set(seen).size,4);
 assert.deepEqual(run.recognitionCoverage,{relevantPaths:4,resolvedPaths:4,unresolvedPaths:0,unseenPaths:0});
});

test('long source paths omitted by every crop keep whole-selection recognition incomplete',async()=>{
 const source=input([path(1,[[.2,.3],[.22,.3]]),path(2,[[.5,.3],[.52,.3]]),path(3,[[.01,.6],[.99,.6]])]);
 source.feetPerImagePx=.1;source.textRuns=[];
 const recognize=async()=>{throw Error('No live calls')};
 recognize.cached=async r=>({elements:[{kind:'annotation',pathIds:r.catalogue.map(p=>p.id)}],openings:[]});
 const run=await runAreaEngine(source,{wholeSheet:false,recognize,maxRecognitionWindows:0});
 assert.equal(run.recognition,'partial');assert.equal(run.recognitionCoverage.unseenPaths,1);
 assert.equal(run.recognitionCoverage.unresolvedPaths,1);
 assert.ok(run.detection.warnings.some(w=>w.includes('never supplied in a complete classification crop')));
 assert.ok(run.detection.architecture.building.issues.some(i=>i.code==='recognition-coverage'&&i.message.includes('1 of 3')));
});

test('recorded observations cannot certify source paths absent from their catalogue',async()=>{
 const source=input([path(1,[[.2,.3],[.22,.3]]),path(2,[[.01,.6],[.99,.6]])]);
 source.feetPerImagePx=.1;source.textRuns=[];
 source.visualObservations=[{id:'recorded',region:source.region,suppliedPathIds:[1],elements:[{kind:'annotation',pathIds:[1]}],openings:[]}];
 const run=await runAreaEngine(source,{wholeSheet:false});
 assert.equal(run.recognition,'partial');assert.equal(run.recognitionCoverage.unseenPaths,1);
 assert.ok(run.detection.architecture.building.issues.some(i=>i.code==='recognition-coverage'));
});

test('catalogue complexity limits do not erase unresolved source coverage',async()=>{
 const compound=path(3,Array.from({length:81},(_,i)=>[.2+i*.0001,.25+i*.0001]));
 const source=input([path(1,[[.2,.3],[.22,.3]]),compound]);source.textRuns=[];
 const recognize=async()=>{throw Error('No live calls')};
 recognize.cached=async r=>({elements:[{kind:'annotation',pathIds:r.catalogue.map(p=>p.id)}],openings:[]});
 const run=await runAreaEngine(source,{wholeSheet:false,recognize,maxRecognitionWindows:0});
 assert.equal(run.recognition,'partial');assert.equal(run.recognitionCoverage.unseenPaths,1);
});

test('a supplied unknown role is unresolved but not an unseen source path',async()=>{
 const source=input([path(1,[[.2,.3],[.22,.3]])]);source.textRuns=[];
 const recognize=async r=>({elements:[{kind:'unknown',pathIds:r.catalogue.map(p=>p.id)}],openings:[]});
 const run=await runAreaEngine(source,{wholeSheet:false,recognize});
 assert.equal(run.recognition,'partial');
 assert.deepEqual(run.recognitionCoverage,{relevantPaths:1,resolvedPaths:0,unresolvedPaths:1,unseenPaths:0});
});
