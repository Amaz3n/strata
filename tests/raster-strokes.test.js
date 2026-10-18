require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {thinRasterInk,extractRasterStrokeEvidence}=require('../lib/drawings/raster-strokes')
const image=(width=400,height=320)=>({pixels:new Uint8Array(width*height).fill(255),width,height,feetPerPixel:.025})
const fill=(im,x0,y0,x1,y1,value=0)=>{for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++)im.pixels[y*im.width+x]=value}
function components(pixels,width){const seen=new Set(),groups=[];for(let i=0;i<pixels.length;i++){if(!pixels[i]||seen.has(i))continue;const group=[i];seen.add(i);for(let j=0;j<group.length;j++){const n=group[j],x=n%width;for(const dx of [-1,0,1])for(const dy of [-1,0,1]){if(x+dx<0||x+dx>=width)continue;const next=n+dy*width+dx;if(next>=0&&next<pixels.length&&pixels[next]&&!seen.has(next)){seen.add(next);group.push(next)}}}groups.push(group)}return groups}
test('thinning retains thin diagonals and isolated small ink instead of collapsing them',()=>{
 const width=80,height=80,ink=new Uint8Array(width*height)
 for(let i=10;i<60;i++){ink[i*width+i]=1;ink[i*width+i+1]=1}
 const run=thinRasterInk(ink,width,height),groups=components(run.pixels,width)
 assert.equal(run.converged,true);assert.equal(groups.length,1)
 assert.ok(Math.min(...groups[0].map(i=>i%width))<=12)
 assert.ok(Math.max(...groups[0].map(i=>i%width))>=58)
 const small=new Uint8Array(64);for(const i of [27,28,35,36])small[i]=1
 assert.ok(thinRasterInk(small,8,8).pixels.some(Boolean))
})
test('stroke extraction preserves a real gap and does not fabricate semantic roles',()=>{
 const im=image();fill(im,40,40,180,43);fill(im,220,40,360,43)
 const result=extractRasterStrokeEvidence(im)
 assert.equal(result.truncated,false)
 assert.equal(result.paths.length,2)
 assert.ok(result.paths.every(p=>p.commands.every(c=>c[1]*im.width<181)||p.commands.every(c=>c[1]*im.width>219)))
 assert.ok(result.paths.every(p=>p.layer.length===0))
})
test('a junction divides independently classifiable strokes without breaking their shared endpoint',()=>{
 const im=image();fill(im,40,150,360,153);fill(im,199,40,202,153)
 const result=extractRasterStrokeEvidence(im),ends=result.paths.flatMap(p=>[p.commands[0].slice(1),p.commands.at(-1).slice(1)])
 const counts=new Map();for(const p of ends){const k=p.join(',');counts.set(k,(counts.get(k)||0)+1)}
 assert.ok([...counts.values()].some(n=>n===3))
 assert.ok(result.paths.length>=3)
})
test('known wall-face strokes retain the analytic room area in the shared engine',async()=>{
 const {runAreaEngine}=require('../lib/drawings/area-engine')
 const im=image(600,500)
 for(const [a,b,c,d] of [[40,40,440,42],[40,358,440,360],[40,40,42,360],[438,40,440,360],[60,60,420,62],[60,338,420,340],[60,60,62,340],[418,60,420,340]])fill(im,a,b,c,d)
 const evidence=extractRasterStrokeEvidence(im),ids=evidence.paths.map(p=>p.id),region={x0:0,y0:0,x1:1,y1:1}
 const run=await runAreaEngine({segments:[],imageWidth:im.width,imageHeight:im.height,feetPerImagePx:im.feetPerPixel,textRuns:[],evidence,region,visualObservations:[{id:'known-source-wall-strokes',region,suppliedPathIds:ids,elements:[{kind:'wall',pathIds:ids}],openings:[]}]},{wholeSheet:true})
 assert.equal(run.detection.architecture.spaces.length,1)
 assert.ok(Math.abs(run.detection.architecture.spaces[0].areaSqft-62.6)<.6)
 assert.ok(run.detection.architecture.building.walls.length>=4)
})
test('bounded extraction records truncated work',()=>{
 const im=image();fill(im,40,40,360,43);fill(im,40,80,360,83)
 const result=extractRasterStrokeEvidence({...im,maximumPaths:1})
 assert.equal(result.truncated,true);assert.equal(result.paths.length,1)
 assert.throws(()=>extractRasterStrokeEvidence({...im,maximumPaths:-1}),/budget/)
 assert.throws(()=>extractRasterStrokeEvidence({...im,region:{x0:0,y0:0,x1:0,y1:1}}),/budget/)
})
test('a chain of measured sub-tolerance raster steps cannot be dropped out of a structural boundary',()=>{
 const {detectAreas}=require('../lib/drawings/area-takeoff')
 const points=[[1.5,1.5],[8.5,1.5],...Array.from({length:20},(_,i)=>[8.5,1.5+(i+1)*.005]),[8.5,8.5],[1.5,8.5],[1.5,1.5]]
 const path={id:1,kind:'stroke',layer:[],groups:[],clips:[],dashes:[],color:[0],colorSpace:'DeviceGray',opacity:1,width:1,evenOdd:false,commands:points.map((p,i)=>[i?'L':'M',p[0]/10,p[1]/10])}
 const region={x0:0,y0:0,x1:1,y1:1},evidence={version:1,truncated:false,paths:[path],raster:{width:2000,height:2000,feetPerPixel:.005,threshold:128,maximumDeviationPixels:1.1,region}}
 const input={segments:[],textRuns:[],imageWidth:2000,imageHeight:2000,feetPerImagePx:.005,evidence,region,visualObservations:[{id:'known-measured-wall',region,suppliedPathIds:[1],elements:[{kind:'wall',pathIds:[1]}]}]}
 const result=detectAreas(input)
 assert.equal(result.proposals.length,1)
 assert.ok(Math.abs(result.proposals[0].areaSqft-49)<1e-8)
 const broken=structuredClone(input);broken.evidence.paths[0].commands.splice(2,20,['M',.85,.16])
 assert.equal(detectAreas(broken).proposals.length,0,'a genuinely missing source connection stays open')
})

test('source-connected swing fragments survive dimension crossings without bridging an absent stroke',()=>{
 const {joinOpeningStrokes}=require('../lib/drawings/area-opening-curves')
 const points=Array.from({length:81},(_,i)=>[10-3*Math.cos(Math.PI/2*i/80),2+3*Math.sin(Math.PI/2*i/80)])
 const strokes=[{pathId:1,kind:'door',points:points.slice(0,27)},{pathId:2,kind:'unknown',points:points.slice(26,28)},{pathId:3,kind:'door',points:points.slice(27,55)},{pathId:4,kind:'door',points:points.slice(54)}]
 // The one-pixel junction here is represented by a smaller angular interval.
 strokes[1].points[1]=[points[26][0]+(points[27][0]-points[26][0])*.4,points[26][1]+(points[27][1]-points[26][1])*.4]
 strokes[2].points.unshift(strokes[1].points[1])
 const arcs=joinOpeningStrokes(strokes,.021)
 assert.equal(arcs.length,1);assert.ok(Math.hypot(arcs[0].center[0]-10,arcs[0].center[1]-2)<.01)
 assert.deepEqual(arcs[0].pathIds.sort((a,b)=>a-b),[1,2,3,4])
 assert.equal(joinOpeningStrokes(strokes.filter(s=>s.pathId!==2),.021).length,0)
 assert.equal(joinOpeningStrokes(strokes.map(s=>s.pathId===2?{...s,kind:'annotation'}:s),.021).length,0)
 assert.equal(joinOpeningStrokes(strokes.map(s=>({...s,kind:'unknown'})),.021).length,0)
})

test('split scanned door swing closes a measured room only with structural jamb support',async()=>{
 const {runAreaEngine}=require('../lib/drawings/area-engine')
 const {RASTER_STROKE_PROFILE}=require('../lib/drawings/raster-strokes')
 const region={x0:0,y0:0,x1:1,y1:1},scale=20
 const path=(id,points)=>({id,kind:'stroke',layer:[],groups:[],clips:[],dashes:[],color:[0],colorSpace:'DeviceGray',opacity:1,width:1,evenOdd:false,commands:points.map((p,i)=>[i?'L':'M',p[0]/scale,p[1]/scale])})
 const pts=Array.from({length:61},(_,i)=>[12.005-3*Math.cos(Math.PI/2*i/60),4.005+3*Math.sin(Math.PI/2*i/60)])
 const paths=[path(1,[[12,4],[12,2],[2,2],[2,12],[12,12],[12,7]]),path(2,pts.slice(0,31)),path(3,pts.slice(30))]
 const input={segments:[],imageWidth:2000,imageHeight:2000,feetPerImagePx:.01,textRuns:[],region,evidence:{version:1,truncated:false,extractionProfile:RASTER_STROKE_PROFILE,paths,raster:{width:2000,height:2000,feetPerPixel:.01,threshold:128,maximumDeviationPixels:1.1,region}},visualObservations:[{id:'analytic-door',region,suppliedPathIds:[1,2,3],elements:[{kind:'wall',pathIds:[1]},{kind:'door',pathIds:[2,3]}],openings:[]}]}
 const run=await runAreaEngine(input,{wholeSheet:false})
 assert.equal(run.detection.architecture.spaces.length,1)
 assert.ok(Math.abs(run.detection.architecture.spaces[0].areaSqft-100)<.1)
 assert.ok(run.detection.architecture.openings.length>0)
 const withoutJamb=structuredClone(input);withoutJamb.evidence.paths[0]=path(1,[[12,3],[12,2],[2,2],[2,12],[12,12],[12,7]])
 assert.equal((await runAreaEngine(withoutJamb,{wholeSheet:false})).detection.architecture.spaces.length,0)
})

test('arc-seed production traversal skips unusable straight hatch branches without changing general observed strokes',()=>{
 const {extractRasterStrokeEvidence}=require('../lib/drawings/raster-strokes');
 const width=160,height=160,pixels=new Uint8Array(width*height).fill(255);
 for(let x=10;x<150;x++)pixels[40*width+x]=0;
 for(let i=0;i<=400;i++){const angle=i/400*Math.PI/2,x=Math.round(70+55*Math.cos(angle)),y=Math.round(75+55*Math.sin(angle));pixels[y*width+x]=0;}
 const input={pixels,width,height,feetPerPixel:.05,region:{x0:0,y0:0,x1:1,y1:1}};
 const all=extractRasterStrokeEvidence(input),seeds=extractRasterStrokeEvidence({...input,purpose:'arc-seeds'});
 assert.equal(seeds.truncated,false);assert.ok(seeds.paths.length>0);assert.ok(seeds.paths.length<all.paths.length);assert.ok(seeds.paths.every(p=>p.commands.length>=7));
 const {extractRasterArcEvidence}=require('../lib/drawings/raster-arcs');assert.ok(extractRasterArcEvidence({...input,strokes:seeds}).paths.length>0);
});
