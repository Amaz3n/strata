require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {observedRasterSwings}=require('../lib/drawings/raster-swing-observations')
const {RASTER_ARC_PROFILE}=require('../lib/drawings/raster-arcs')
const {recognitionAssemblies,planAssemblyRecognition}=require('../lib/drawings/recognition-assemblies')
const {rasterSwingDoors}=require('../lib/drawings/raster-swing-doors')
const {runAreaEngine,areaRecognitionPrompt}=require('../lib/drawings/area-engine')
const arc=(id=5,steps=32)=>({id,kind:'stroke',color:[0],colorSpace:'DeviceGray',opacity:1,width:1,dashes:[],layer:[],groups:[],clips:[],evenOdd:false,rasterFeature:'circular-arc',rasterArc:{profile:RASTER_ARC_PROFILE,sampleCount:200,maximumDeviationPixels:1,sweepRadians:Math.PI/2,continuousInk:true,clipped:false},commands:Array.from({length:steps+1},(_,j)=>[j?'L':'M',(12+3*Math.cos(j/steps*Math.PI/2))/100,(18+3*Math.sin(j/steps*Math.PI/2))/50])})
const input=(paths=[arc()])=>({imageWidth:1000,imageHeight:500,feetPerImagePx:.1,region:{x0:0,y0:0,x1:1,y1:1},segments:[],textRuns:[],evidence:{version:1,truncated:false,paths,raster:{feetPerPixel:.02}}})
const observe=i=>observedRasterSwings({evidence:i.evidence,sx:100,sy:50,pathKinds:new Map()})
test('calibrated observed quarter arc is a contextual cue without becoming an accepted opening',async()=>{
 const i=input(),before=structuredClone(i),observed=observe(i);assert.equal(observed.arcs.length,1);assert.ok(Math.abs(observed.arcs[0].radius-3)<1e-8)
 const a=recognitionAssemblies(i).assemblies;assert.equal(a.length,1);assert.equal(a[0].hypothesis,'quarter-arc-context');assert.equal(a[0].measuredDepthFt,undefined);assert.ok(Math.abs(a[0].measuredRadiusFt-3)<1e-8)
 assert.equal(rasterSwingDoors({evidence:i.evidence,sx:100,sy:50,wallBodies:[],pathKinds:new Map()}).doors.length,0)
 const p=planAssemblyRecognition(i,{x:.3,y:.6});assert.equal(p.requests.length,1);assert.deepEqual(p.requests[0].catalogue.map(p=>p.id),[5]);assert.ok(areaRecognitionPrompt(p.requests[0]).includes('neither an opening width nor wall depth'))
 const r=await runAreaEngine(i,{wholeSheet:false});assert.equal(r.detection.architecture.building.openings.length,0);assert.deepEqual(i,before)
})
test('competing fixture, annotation and wall roles exclude curved symbols from swing context',()=>{
 const i=input();for(const kind of ['fixture','furniture','annotation','window','wall'])assert.equal(observedRasterSwings({evidence:i.evidence,sx:100,sy:50,pathKinds:new Map([[5,kind]])}).arcs.length,0)
 const o={id:'fixture',region:i.region,suppliedPathIds:[5],elements:[{kind:'fixture',pathIds:[5]}],openings:[]};assert.equal(recognitionAssemblies({...i,visualObservations:[o]}).assemblies.length,0)
})
test('unobserved, invalid, clipped and nonnative curves cannot gain a swing cue',()=>{
 for(const patch of [{profile:'other'},{continuousInk:false},{clipped:true},{sampleCount:6},{maximumDeviationPixels:Infinity},{maximumDeviationPixels:3},{sweepRadians:NaN},{sweepRadians:Math.PI}]){
  const p=arc();p.rasterArc={...p.rasterArc,...patch};assert.equal(observe(input([p])).arcs.length,0)
 }
 const clipped=arc();clipped.rasterArc.clipped=true;assert.deepEqual(observe(input([clipped])).clippedPathIds,[5])
 for(const patch of [{dashes:[1]},{clips:[9]},{opacity:NaN},{commands:[['M',.1,.2],['C',.1,.2,.2,.3,.3,.4]]}])assert.equal(observe(input([{...arc(),...patch}])).arcs.length,0)
 const i=input();assert.equal(observe({...i,evidence:{...i.evidence,raster:undefined}}).arcs.length,0);assert.equal(observe({...i,evidence:{...i.evidence,truncated:true}}).arcs.length,0)
})
test('selected complete source curves are stable across path order and never clipped to fit a smaller view',()=>{
 const a=arc(9),b=arc(3);b.commands=b.commands.map(([op,x,y])=>[op,x+.2,y]);const i=input([a,b]);assert.deepEqual(observe(i).arcs.map(a=>a.id),[3,9]);assert.deepEqual(observe(input([b,a])),observe(i))
 assert.equal(recognitionAssemblies({...input(),region:{x0:.13,y0:.37,x1:.14,y1:.40}}).assemblies.length,0)
 const p=planAssemblyRecognition(input(),{x:.01,y:.01});assert.equal(p.requests.length,0);assert.equal(p.unframedAssemblyIds.length,1)
})
test('bounded recognition inspects a complete arc before background ink and retains global partial coverage',async()=>{
 const paths=Array.from({length:200},(_,id)=>({...arc(id),rasterFeature:undefined,rasterArc:undefined,commands:[['M',.6,.6+id*.00001],['L',.6001,.6+id*.00001]]}));paths.push(arc(999));const i=input(paths),calls=[]
 const recognize=async r=>{calls.push(r);return{elements:[{kind:'unknown',pathIds:r.catalogue.map(p=>p.id)}],openings:[]}}
 const r=await runAreaEngine(i,{wholeSheet:false,recognize,maxRecognitionWindows:1});assert.equal(calls.length,1);assert.deepEqual(calls[0].catalogue.map(p=>p.id),[999]);assert.equal(r.recognition,'partial');assert.equal(r.recognitionCoverage.unseenPaths,200);assert.equal(r.detection.architecture.building.openings.length,0)
})
test('an oversized arc stays intact for primitive fallback without spending its source ID in a proposal',()=>{
 const i=input([arc(5,100)]),before=structuredClone(i),p=planAssemblyRecognition(i,undefined);assert.equal(observe(i).arcs.length,1);assert.equal(p.candidateAssemblies,1);assert.equal(p.requests.length,0);assert.equal(p.suppliedPathIds.size,0);assert.equal(p.unframedAssemblyIds.length,1);assert.deepEqual(i,before)
})
