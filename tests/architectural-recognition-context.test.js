require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {withRecognitionContext,RECOGNITION_CONTEXT_PATH_LIMIT}=require('../lib/drawings/recognition-context')
const {visualPathCatalogue,interpretArchitecturalElements,visualOpeningBoundaries}=require('../lib/drawings/area-semantics')
const {registerRecognitionImage,recognitionOverlaySvg}=require('../lib/drawings/recognition-overlay')
const {runAreaEngine,areaRecognitionPrompt}=require('../lib/drawings/area-engine')
const {createAreaReplay,replayAreaDetection}=require('../lib/drawings/area-replay')
const region={x0:0,y0:0,x1:1,y1:1}
const path=(id,points,layer=[])=>({id,kind:'stroke',commands:points.map((p,i)=>[i?'L':'M',...p]),layer,opacity:1,color:[0],colorSpace:'DeviceGray',width:1,dashes:[],clips:[],groups:[],evenOdd:false})
const input=()=>({segments:[],imageWidth:1000,imageHeight:1000,feetPerImagePx:.02,region,textRuns:[{text:'BEDROOM',x:.3,y:.4,w:.2,h:.02}],evidence:{version:1,truncated:false,paths:[path(1,[[.1,.1],[.4,.1]]),path(2,[[.55,.1],[.9,.1]]),path(3,[[.4,.1],[.55,.18]]),path(4,[[.9,.1],[.9,.9],[.1,.9],[.1,.1]],['A-WALL'])]}})
const requests=i=>{const c=visualPathCatalogue(i.evidence,region,Infinity);return[{region,catalogue:c.filter(p=>p.id===3),assemblies:[{id:'arc-context',hypothesis:'quarter-arc-context',pathIds:[3],bounds:[.4,.1,.55,.18],measuredRadiusFt:3,measuredSpanFt:3}]},{region,catalogue:c.filter(p=>[1,2].includes(p.id)),assemblies:[{id:'wall-context',hypothesis:'paired-wall-faces',pathIds:[1,2],bounds:[.1,.1,.9,.1],measuredDepthFt:.5,measuredSpanFt:6}]}]}
const opening={a:{pathId:1,commandIndex:1},b:{pathId:2,commandIndex:0},doorPathIds:[3]}
const observations=()=>[{id:'walls',region,suppliedPathIds:[1,2],elements:[{kind:'wall',pathIds:[1,2]}],openings:[]},{id:'door',region,suppliedPathIds:[3],contextPathIds:[1,2],elements:[{kind:'door',pathIds:[3]}],openings:[opening]}]
test('cross-batch source context retains complete wall IDs without spending or duplicating target votes',()=>{
 const i=input(),rs=requests(i),before=structuredClone({i,rs}),out=withRecognitionContext(i,rs)
 assert.deepEqual(out[0].contextCatalogue.map(p=>p.id),[1,2]);assert.equal(out[1].contextCatalogue,undefined);assert.deepEqual(out.flatMap(r=>r.catalogue.map(p=>p.id)),rs.flatMap(r=>r.catalogue.map(p=>p.id)));assert.deepEqual({i,rs},before)
 const obs=observations();obs[1].elements.push({kind:'fixture',pathIds:[1,2]});const roles=interpretArchitecturalElements(i.evidence,obs);for(const id of [1,2]){const e=roles.find(e=>e.pathId===id);assert.equal(e.kind,'wall');assert.equal(e.conflict,false);assert.deepEqual(e.observationIds,['walls'])}
 assert.ok(areaRecognitionPrompt(out[0]).includes('Do not classify them in elements'));assert.ok(recognitionOverlaySvg(out[0],1000,1000).includes('C 1</text>'))
})
test('context cannot turn an unclassified source wall into an opening anchor',()=>{
 const i=input(),obs=observations();assert.equal(visualOpeningBoundaries(i.evidence,obs,20,20).length,1)
 assert.equal(visualOpeningBoundaries(i.evidence,[obs[1]],20,20).length,0)
 assert.equal(visualOpeningBoundaries(i.evidence,[obs[0],{...obs[1],contextPathIds:[]}],20,20).length,0)
 assert.equal(visualOpeningBoundaries(i.evidence,[obs[0],{...obs[1],suppliedPathIds:[],contextPathIds:[1,2,3]}],20,20).length,0)
})
test('context anchors still reject fabricated vertices, crop crossings, conflicting roles and thresholds through paint',()=>{
 const i=input(),obs=observations();for(const change of [{openings:[{...opening,a:{pathId:1,commandIndex:99}}]},{region:{x0:.2,y0:0,x1:.8,y1:1}},{contextPathIds:[1,999]}])assert.equal(visualOpeningBoundaries(i.evidence,[obs[0],{...obs[1],...change}],20,20).length,0)
 assert.equal(visualOpeningBoundaries(i.evidence,[...obs,{id:'conflict',region,suppliedPathIds:[1],elements:[{kind:'fixture',pathIds:[1]}]}],20,20).length,0)
 const blocked={...i.evidence,paths:[...i.evidence.paths,path(5,[[.475,.05],[.475,.15]],['A-WALL'])]};assert.equal(visualOpeningBoundaries(blocked,obs,20,20).length,0)
})
test('source-anchored cross-batch threshold restores analytic room geometry and persists through exact replay',async()=>{
 const i=input(),obs=observations(),before=await runAreaEngine({...i,visualObservations:[obs[0],{...obs[1],contextPathIds:undefined}]},{wholeSheet:false});assert.equal(before.detection.proposals.length,0)
 const updated={...i,visualObservations:obs},run=await runAreaEngine(updated,{wholeSheet:false});assert.equal(run.detection.proposals.length,1);assert.ok(Math.abs(run.detection.proposals[0].areaSqft-256)<1e-6);assert.equal(run.detection.architecture.spaces[0].boundary.status,'needs-review')
 const replay=JSON.parse(JSON.stringify(createAreaReplay(updated,false,{},run.recognition))),again=await replayAreaDetection(replay);assert.deepEqual(replay.input.visualObservations[1].contextPathIds,[1,2]);assert.deepEqual(again.detection.proposals,run.detection.proposals);assert.deepEqual(again.detection.architecture.building,run.detection.architecture.building)
})
test('context registration preserves original coordinates and anchor command indices after native image rounding',()=>{
 const i=input(),r=withRecognitionContext(i,requests(i))[0],actual={x0:-.001,y0:-.002,x1:1.001,y1:1.002},registered=registerRecognitionImage(r,actual)
 for(let j=0;j<r.contextCatalogue.length;j++){const a=r.contextCatalogue[j],b=registered.contextCatalogue[j];assert.equal(a.id,b.id);for(let k=0;k<a.commands.length;k++)for(let n=1;n<a.commands[k].length;n++){const x=n%2,lo=x?'x0':'y0',hi=x?'x1':'y1';assert.ok(Math.abs(actual[lo]+b.commands[k][n]*(actual[hi]-actual[lo])-a.commands[k][n])<1e-12)}}
})
test('context is bounded, deterministic and cannot include distant, clipped, overlong or selection-crossing paths',()=>{
 const i=input();i.evidence.paths.push(...Array.from({length:50},(_,j)=>path(10+j,[[.4,.105+j*.00001],[.41,.105+j*.00001]])),path(500,[[.9,.9],[.95,.9]]),path(501,[[.2,.1],[1.1,.1]]),{...path(502,[[.4,.1],[.41,.1]]),kind:'clip'},path(503,Array.from({length:81},(_,j)=>[.4+j*.00001,.1])))
 const rs=requests(i);rs[1].assemblies[0].pathIds.push(...i.evidence.paths.filter(p=>p.id>=10).map(p=>p.id));const result=withRecognitionContext(i,rs)[0].contextCatalogue;assert.equal(result.length,RECOGNITION_CONTEXT_PATH_LIMIT);assert.ok(result.every(p=>p.id<500));const reversed={...i,evidence:{...i.evidence,paths:[...i.evidence.paths].reverse()}};assert.deepEqual(withRecognitionContext(reversed,rs)[0].contextCatalogue,result)
 assert.equal(withRecognitionContext({...i,evidence:{...i.evidence,truncated:true}},rs)[0].contextCatalogue,undefined)
})
test('visible context alone does not resolve or mark unseen paths as supplied',async()=>{
 const i=input();i.textRuns=[];i.evidence.paths=i.evidence.paths.slice(0,3);i.visualObservations=[{id:'door-only',region,suppliedPathIds:[3],contextPathIds:[1,2],elements:[{kind:'door',pathIds:[3]},{kind:'wall',pathIds:[1,2]}],openings:[opening]}];const r=await runAreaEngine(i,{wholeSheet:false});assert.equal(r.recognition,'partial');assert.deepEqual(r.recognitionCoverage,{relevantPaths:3,resolvedPaths:1,unresolvedPaths:2,unseenPaths:2});assert.equal(r.detection.proposals.length,0)
})
