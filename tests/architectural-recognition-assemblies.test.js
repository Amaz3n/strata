require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {recognitionAssemblies,planAssemblyRecognition}=require('../lib/drawings/recognition-assemblies')
const {runAreaEngine,areaRecognitionPrompt}=require('../lib/drawings/area-engine')
const {registerRecognitionImage}=require('../lib/drawings/recognition-overlay')
const stroke=(id,a,b)=>({id,commands:[['M',a[0]/100,a[1]/100],['L',b[0]/100,b[1]/100]],kind:'stroke',color:[0],colorSpace:'DeviceGray',opacity:1,width:1,dashes:[],layer:[],groups:[],clips:[],evenOdd:false})
const network=()=>[[[10,10],[30,10]],[[10,10.5],[30,10.5]],[[10,20],[30,20]],[[10,20.5],[30,20.5]],[[10,10.5],[10,20]],[[10.5,10.5],[10.5,20]],[[29.5,10.5],[29.5,20]],[[30,10.5],[30,20]],[[19.75,10.5],[19.75,20]],[[20.25,10.5],[20.25,20]]].map(([a,b],i)=>stroke(i,a,b))
const data=paths=>({evidence:{version:1,paths,truncated:false},imageWidth:1000,imageHeight:1000,feetPerImagePx:.1,region:{x0:0,y0:0,x1:1,y1:1},segments:[],textRuns:[{text:'ROOM 1',x:.14,y:.14,w:.02,h:.01}]})
const ids=p=>p.requests.flatMap(r=>r.catalogue.map(p=>p.id))
test('assembly proposals preserve exact source paths, measured depths and deterministic source ordering',()=>{
 const i=data(network()),before=structuredClone(i),a=recognitionAssemblies(i),p=planAssemblyRecognition(i,undefined),reverse=planAssemblyRecognition({...i,evidence:{...i.evidence,paths:[...i.evidence.paths].reverse()}},undefined)
 assert.equal(a.assemblies.length,5);assert.equal(p.suppliedPathIds.size,10);assert.equal(new Set(ids(p)).size,10);assert.deepEqual(ids(p),ids(reverse));assert.deepEqual(i,before)
 for(const r of p.requests)for(const hint of r.assemblies){assert.ok(Math.abs(hint.measuredDepthFt-.5)<1e-9);assert.ok(hint.pathIds.every(id=>r.catalogue.some(p=>p.id===id)));assert.ok(hint.bounds.every(n=>n>=0&&n<=1))}
})
test('atomic assembly batching does not split referenced paths or create redundant source votes',()=>{
 const p=planAssemblyRecognition(data(network()),{x:.4,y:.4},4),all=ids(p)
 assert.equal(all.length,10);assert.equal(new Set(all).size,10)
 for(const r of p.requests){assert.ok(r.catalogue.length<=4);for(const a of r.assemblies)assert.ok(a.pathIds.every(id=>r.catalogue.some(p=>p.id===id)))}
 assert.throws(()=>planAssemblyRecognition(data(network()),undefined,1.5),/Invalid assembly/)
})
test('oversized and selection-crossing source assemblies are not clipped into alternative evidence',()=>{
 const i=data(network()),before=JSON.stringify(i.evidence),p=planAssemblyRecognition(i,{x:.08,y:.08})
 assert.equal(p.requests.length,0);assert.ok(p.unframedAssemblyIds.length>0);assert.equal(JSON.stringify(i.evidence),before)
 const a=recognitionAssemblies({...i,region:{x0:.12,y0:.11,x1:.29,y1:.19}});assert.equal(a.assemblies.length,0)
})
test('CAD/visual fixture roles and truncated evidence cannot be converted into wall candidates',()=>{
 const i=data(network());assert.equal(recognitionAssemblies({...i,evidence:{...i.evidence,paths:i.evidence.paths.map(p=>({...p,layer:['A-FURNITURE']}))}}).assemblies.length,0)
 const review={id:'fixture',region:i.region,suppliedPathIds:[8,9],elements:[{kind:'fixture',pathIds:[8,9]}],openings:[]};assert.equal(recognitionAssemblies({...i,visualObservations:[review]}).assemblies.length,0)
 const p=planAssemblyRecognition({...i,evidence:{...i.evidence,truncated:true}},undefined);assert.equal(p.requests.length,0);assert.equal(p.limited,true)
})
test('bare dense dimension-like parallel vector stacks do not become assembly hypotheses',()=>{
 const i=data(Array.from({length:175},(_,id)=>stroke(id,[20,20+id*.1],[40,20+id*.1])));i.textRuns=[]
 assert.equal(recognitionAssemblies(i).assemblies.length,0)
})
test('registered assembly bounds retain original sheet coordinates after source pixel rounding',()=>{
 const p=planAssemblyRecognition(data(network()),undefined),r=p.requests[0],actual={x0:Math.max(0,r.region.x0-.001),y0:Math.max(0,r.region.y0-.002),x1:r.region.x1+.001,y1:r.region.y1+.002},registered=registerRecognitionImage(r,actual)
 for(let j=0;j<r.assemblies.length;j++)for(let k=0;k<4;k++){
  const axis=k%2,lo=axis?'y0':'x0',hi=axis?'y1':'x1',old=r.region[lo]+r.assemblies[j].bounds[k]*(r.region[hi]-r.region[lo]),now=actual[lo]+registered.assemblies[j].bounds[k]*(actual[hi]-actual[lo]);assert.ok(Math.abs(old-now)<1e-12)
 }
 assert.ok(areaRecognitionPrompt(registered).includes('not accepted object roles'));assert.ok(areaRecognitionPrompt(registered).includes('never assembly IDs'))
})
test('architectural assemblies are reviewed before background primitives while unobserved source remains partial',async()=>{
 const paths=[...network(),...Array.from({length:200},(_,i)=>stroke(100+i,[50,40+i*.01],[50.05,40+i*.01]))],input=data(paths),calls=[]
 const classify=async r=>{calls.push(r);return{elements:[{kind:'annotation',pathIds:r.catalogue.map(p=>p.id)}],openings:[]}}
 const result=await runAreaEngine(input,{wholeSheet:false,recognize:classify,maxRecognitionWindows:1})
 assert.equal(calls.length,1);assert.ok(calls[0].assemblies.length);assert.ok(calls[0].catalogue.every(p=>p.id<10));assert.equal(result.recognition,'partial');assert.equal(result.recognitionCoverage.unseenPaths,200)
 const seen=[];const all=async r=>{seen.push(...r.catalogue.map(p=>p.id));return{elements:[{kind:'annotation',pathIds:r.catalogue.map(p=>p.id)}],openings:[]}}
 all.cached=all;const completed=await runAreaEngine(input,{wholeSheet:false,recognize:all,maxRecognitionWindows:0});assert.equal(new Set(seen).size,210);assert.equal(seen.length,210);assert.equal(completed.recognition,'completed')
})
