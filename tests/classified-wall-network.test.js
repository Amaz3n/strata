require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {sourceWallNetwork,withClassifiedWallPairs}=require('../lib/drawings/vector-wall-network')
const {prepareAreaInterpretation}=require('../lib/drawings/area-takeoff')
const {runAreaEngine}=require('../lib/drawings/area-engine')
const {createAreaReplay,replayAreaDetection}=require('../lib/drawings/area-replay')
const {floorplanModelSchema}=require('../lib/validation/floorplan')
const {buildingToFloorplan}=require('../lib/drawings/building-floorplan')
const {extractRasterPlanEvidence}=require('../lib/drawings/raster-plan-evidence')
const region={x0:0,y0:0,x1:1,y1:1}
const stroke=(id,a,b)=>({id,commands:[['M',a[0]/40,a[1]/40],['L',b[0]/40,b[1]/40]],kind:'stroke',color:[0],colorSpace:'DeviceGray',opacity:1,width:1,dashes:[],layer:[],groups:[],clips:[],evenOdd:false})
const fixture=()=>({segments:[],imageWidth:1000,imageHeight:1000,feetPerImagePx:.04,region,textRuns:[],evidence:{version:1,truncated:false,paths:[stroke(1,[5,5],[20,5]),stroke(2,[6,5.5],[19,5.5]),stroke(3,[5,12],[20,12]),stroke(4,[5,12.5],[20,12.5]),stroke(5,[15,5.5],[15,12]),stroke(6,[15.5,5.5],[15.5,12])]}})
const network=(i,ids=[],extra={})=>sourceWallNetwork({evidence:i.evidence,sx:i.imageWidth*i.feetPerImagePx,sy:i.imageHeight*i.feetPerImagePx,textRuns:[],classifiedWallPathIds:new Set(ids),...extra})
const observation=(ids=[1,2])=>({id:'primary-wall-vote',region,suppliedPathIds:ids,elements:[{kind:'wall',pathIds:ids}],openings:[]})
test('resolved meaning admits only individually measured source pairs, without promoting their unknown component',()=>{
 const i=fixture(),before=structuredClone(i),unclassified=network(i),r=network(i,[1,2]);assert.equal(unclassified.bodies.length,0);assert.ok(unclassified.candidates.length>=3);assert.equal(r.bodies.length,1);assert.deepEqual(r.bodies[0].a,[6/40,5.25/40]);assert.deepEqual(r.bodies[0].b,[19/40,5.25/40]);assert.equal(r.bodies[0].thicknessFt,.5);assert.deepEqual([...r.pathIds],[1,2]);assert.equal(r.diagnostics.classifiedPairs,1);assert.deepEqual(i,before)
 assert.equal(withClassifiedWallPairs(r,new Set([1,2])).bodies.length,1);assert.equal(withClassifiedWallPairs({...unclassified,limited:true},new Set([1,2])).bodies.length,0)
})
test('wall votes cannot override visibility, paint style, source truncation or unsupported pair depth',()=>{
 for(const change of [{dashes:[1,1]},{opacity:.4},{color:[1]},{clips:[999]},{layer:['A-FURNITURE']}]){const i=fixture();i.evidence.paths=i.evidence.paths.map(p=>({...p,...change}));assert.equal(network(i,[1,2,3,4,5,6]).bodies.length,0)}
 const i=fixture();assert.equal(network({...i,evidence:{...i.evidence,truncated:true}},[1,2]).bodies.length,0);i.evidence.paths=i.evidence.paths.slice(0,2);i.evidence.paths[1].commands=[['M',6/40,8/40],['L',19/40,8/40]];assert.equal(network(i,[1,2]).bodies.length,0)
})
test('one face, context-only wall roles and conflicting votes cannot corroborate measured pairs',()=>{
 const i=fixture();assert.equal(network(i,[1]).bodies.length,0);assert.equal(network(i,[1,2],{excludedPathIds:new Set([2])}).bodies.length,0)
 for(const obs of [[{...observation([1]),contextPathIds:[2],elements:[{kind:'wall',pathIds:[1,2]}]}],[observation(),{id:'conflict',region,suppliedPathIds:[2],elements:[{kind:'fixture',pathIds:[2]}]}]]){const context=prepareAreaInterpretation({...i,visualObservations:obs});assert.equal(context.independentStructure.size,0)}
 const context=prepareAreaInterpretation({...i,visualObservations:[observation()]});assert.deepEqual([...context.independentStructure],[1,2])
})
test('classified wall geometry reaches shared takeoff and3D, stays partial and survives exact replay',async()=>{
 const i=fixture(),empty=await runAreaEngine(i,{wholeSheet:false});assert.equal(empty.detection.architecture.building.walls.length,0)
 i.visualObservations=[observation()];const run=await runAreaEngine(i,{wholeSheet:false}),building=run.detection.architecture.building;assert.equal(building.walls.length,1);assert.ok(building.issues.some(i=>i.code==='classified-wall-pairs'&&i.severity==='review'));assert.equal(building.status,'incomplete');assert.equal(run.detection.architecture.spaces.length,0);assert.equal(run.recognition,'partial');assert.deepEqual(run.recognitionCoverage,{relevantPaths:6,resolvedPaths:2,unresolvedPaths:4,unseenPaths:4})
 const level=buildingToFloorplan({...i,order:0,name:'Untitled level',sheetVersionId:'source',sheetNumber:null,sheetTitle:null,scaleConfirmed:true},run.detection.architecture);assert.equal(level.walls.length,1);assert.ok(Math.abs(level.walls[0].thicknessFt-.5)<1e-9);assert.equal(level.rooms.length,0);assert.equal(floorplanModelSchema.safeParse({version:1,units:'feet',levels:[level],correctionCount:0}).success,true)
 const replay=createAreaReplay(i,false,{},run.recognition),again=await replayAreaDetection(JSON.parse(JSON.stringify(replay)));assert.deepEqual(again.detection.architecture.building,building);assert.deepEqual(again.recognitionCoverage,run.recognitionCoverage)
})
test('classified native faces remain tied to directly measured source bands',()=>{
 const width=300,height=240,fpp=.04;
 const extract=solid=>{const pixels=new Uint8Array(width*height).fill(255);for(let x=30;x<=260;x++)for(let y=80;y<=95;y++)if(solid||y===80||y===95)pixels[y*width+x]=0;return extractRasterPlanEvidence({pixels,width,height,feetPerPixel:fpp,region,sourceHash:'a'.repeat(64)})}
 const evidence=extract(true),i={evidence,imageWidth:width,imageHeight:height,feetPerImagePx:fpp};const r=network(i);assert.ok(r.candidates.length>0);const ids=r.candidates[0].pathIds,admitted=network(i,ids);assert.equal(admitted.bodies.length,1);assert.deepEqual(admitted.bodies[0],r.candidates[0]);assert.ok(admitted.bodies[0].thicknessFt>=.2&&admitted.bodies[0].thicknessFt<=1.5)
 const rails=extract(false);assert.equal(network({...i,evidence:rails}).bodies.length,0);const outlined=network({...i,evidence:rails},rails.paths.map(p=>p.id));assert.equal(outlined.bodies.length,1);assert.equal(outlined.bodies[0].sourceBand,'unfilled')
})
test('classified geometry preserves unequal-axis and rotated physical coordinates instead of snapping',()=>{
 const i=fixture(),angle=.31;const rotate=p=>[4+p[0]*Math.cos(angle)-p[1]*Math.sin(angle),3+p[0]*Math.sin(angle)+p[1]*Math.cos(angle)];i.imageHeight=500;i.evidence.paths=i.evidence.paths.map(p=>({...p,commands:p.commands.map(c=>{const q=rotate([c[1]*40,c[2]*40]);return[c[0],q[0]/40,q[1]/20]})}));const r=network(i,[1,2]);assert.equal(r.bodies.length,1);assert.ok(Math.abs(r.bodies[0].thicknessFt-.5)<1e-9);const a=rotate([6,5.25]),b=rotate([19,5.25]);for(let k=0;k<2;k++){assert.ok(Math.abs(r.bodies[0].a[k]*[40,20][k]-a[k])<1e-9);assert.ok(Math.abs(r.bodies[0].b[k]*[40,20][k]-b[k])<1e-9)}
})
