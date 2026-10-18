require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {vectorWallNetwork}=require('../lib/drawings/vector-wall-network')
const {areaRoomLabel}=require('../lib/drawings/area-labels')
const {reconstructBuilding}=require('../lib/drawings/building-reconstruction')
const stroke=(id,a,b)=>({id,commands:[['M',a[0]/100,a[1]/100],['L',b[0]/100,b[1]/100]],kind:'stroke',color:[0],colorSpace:'DeviceGray',opacity:1,width:1,dashes:[],layer:[],groups:[],clips:[],evenOdd:false})
const network=()=>[[[0,0],[20,0]],[[0,.5],[20,.5]],[[0,10],[20,10]],[[0,10.5],[20,10.5]],[[0,.5],[0,10]],[[.5,.5],[.5,10]],[[19.5,.5],[19.5,10]],[[20,.5],[20,10]],[[9.75,.5],[9.75,10]],[[10.25,.5],[10.25,10]]].map(([a,b],i)=>stroke(i,a,b))
const data=paths=>({evidence:{version:1,paths,truncated:false},sx:100,sy:100,textRuns:[{text:'ROOM 1',x:.04,y:.04,w:.02,h:.01}]})
test('source paired network recognizes measured walls before any room polygon exists',()=>{
 const input=data(network()),r=vectorWallNetwork(input);assert.equal(r.pathIds.size,10);assert.equal(r.bodies.length,5);assert.equal(r.limited,false)
 for(const b of r.bodies){assert.ok(Math.abs(b.thicknessFt-.5)<1e-9);assert.equal(b.pathIds.length,2);assert.equal(b.strokeWidth,1)}
 const source={imageWidth:1000,imageHeight:1000,feetPerImagePx:.1,region:{x0:0,y0:0,x1:1,y1:1},segments:[],textRuns:input.textRuns,evidence:input.evidence}
 const building=reconstructBuilding(source,{version:1,spaces:[],openings:[],elements:[],finishZones:[],conflicts:[],spacePolicy:'include-fixtures',qualification:'unqualified'})
 assert.equal(building.walls.length,5);assert.ok(building.issues.some(i=>i.code==='independent-wall-network'))
})
test('isolated double boxes, fixture layers, dashes and paint/clip failures are not promoted',()=>{
 const paths=network();assert.equal(vectorWallNetwork(data(paths.slice(0,8))).pathIds.size,0)
 for(const changes of [{layer:['A-FURNITURE']},{dashes:[1,1]},{opacity:.4},{color:[1]},{clips:[999]}])assert.equal(vectorWallNetwork(data(paths.map(p=>({...p,...changes})))).pathIds.size,0)
 assert.equal(vectorWallNetwork({...data(paths),evidence:{...data(paths).evidence,truncated:true}}).pathIds.size,0)
 assert.equal(vectorWallNetwork({...data(paths),evidence:{...data(paths).evidence,raster:{}}}).pathIds.size,0)
})
test('source classifications override geometry and a room tag inside wall paint is insufficient',()=>{
 const d=data(network());assert.equal(vectorWallNetwork({...d,excludedPathIds:new Set([8,9])}).pathIds.size,0)
 d.textRuns=[{text:'ROOM 1',x:.099,y:.04,w:.002,h:.01}];assert.equal(vectorWallNetwork(d).pathIds.size,0)
 d.textRuns=[{text:'ROOM SHALL RECEIVE NEW FINISH',x:.04,y:.04,w:.02,h:.01}];assert.equal(vectorWallNetwork(d).pathIds.size,0)
})
test('rotated networks preserve source overlap instead of snapping axes or stretching endpoints',()=>{
 const angle=.37,rotate=p=>[30+p[0]*Math.cos(angle)-p[1]*Math.sin(angle),20+p[0]*Math.sin(angle)+p[1]*Math.cos(angle)]
 const paths=network().map(p=>({...p,commands:p.commands.map(c=>{const q=rotate([c[1]*100,c[2]*100]);return[c[0],q[0]/100,q[1]/100]})})),center=rotate([5,5]),d=data(paths);d.textRuns=[{text:'ROOM 1',x:center[0]/100,y:center[1]/100,w:0,h:0}]
 const r=vectorWallNetwork(d);assert.equal(r.pathIds.size,10);assert.equal(r.bodies.length,5);for(const b of r.bodies)assert.ok(Math.abs(b.thicknessFt-.5)<1e-9)
 const north=r.bodies.find(b=>b.pathIds.includes(0));assert.ok(Math.abs(Math.hypot((north.b[0]-north.a[0])*100,(north.b[1]-north.a[1])*100)-20)<1e-8)
})
test('semantic possessive tags retain identity without admitting keynote prose',()=>{
 assert.equal(areaRoomLabel('HIS WIC'),'HIS WIC');assert.equal(areaRoomLabel('HERS CLOSET'),'HERS CLOSET');assert.equal(areaRoomLabel('HIS BATH'),'HIS BATH')
 for(const s of ['HIS WIC SHALL HAVE TILE','HERS FINISH','HIS LIVING ROOM','HIS WIC 3/16 = 1 ft'])assert.equal(areaRoomLabel(s),null)
})
test('later opaque white paint can invalidate a source network; background paint cannot',()=>{
 const mask={...stroke(100,[0,0],[0,0]),kind:'fill',color:[1],commands:[['M',-.01,-.01],['L',.21,-.01],['L',.21,.12],['L',-.01,.12],['L',-.01,-.01]]}
 assert.equal(vectorWallNetwork(data([...network(),mask])).pathIds.size,0)
 assert.equal(vectorWallNetwork(data([{...mask,id:-1},...network()])).pathIds.size,10)
 assert.equal(vectorWallNetwork(data([...network(),{...mask,opacity:.4}])).pathIds.size,10)
})
test('independent walls expose conflicting room topology instead of being erased by it',()=>{
 const d=data(network()),source={imageWidth:1000,imageHeight:1000,feetPerImagePx:.1,region:{x0:0,y0:0,x1:1,y1:1},segments:[],textRuns:d.textRuns,evidence:d.evidence},space={id:'bad-floor',points:[[-.01,-.01],[.21,-.01],[.21,.12],[-.01,.12]],holes:[],sourceBoundaries:[]}
 const building=reconstructBuilding(source,{version:1,spaces:[space],openings:[],elements:[],finishZones:[],conflicts:[],spacePolicy:'include-fixtures',qualification:'unqualified'})
 assert.equal(building.walls.length,5);assert.ok(building.issues.some(i=>i.code==='wall-network-floor-conflict'&&i.severity==='error'));assert.equal(building.status,'incomplete')
})
test('visual fixture classifications take precedence over paired geometric hypotheses',()=>{
 const d=data(network()),source={imageWidth:1000,imageHeight:1000,feetPerImagePx:.1,region:{x0:0,y0:0,x1:1,y1:1},segments:[],textRuns:d.textRuns,evidence:d.evidence,visualObservations:[{id:'fixture-review',region:{x0:0,y0:0,x1:1,y1:1},suppliedPathIds:[8,9],elements:[{kind:'fixture',pathIds:[8,9]}],openings:[]}]}
 const building=reconstructBuilding(source,{version:1,spaces:[],openings:[],elements:[],finishZones:[],conflicts:[],spacePolicy:'include-fixtures',qualification:'unqualified'})
 assert.equal(building.walls.length,0)
})
test('a finish-face contact remains reviewable without being mislabeled as a wall-center conflict',()=>{
 const d=data(network()),source={imageWidth:1000,imageHeight:1000,feetPerImagePx:.1,region:{x0:0,y0:0,x1:1,y1:1},segments:[],textRuns:d.textRuns,evidence:d.evidence},space={id:'face-contact',points:[[.005,.005],[.0979,.005],[.0979,.1],[.005,.1]],holes:[],sourceBoundaries:[]}
 const building=reconstructBuilding(source,{version:1,spaces:[space],openings:[],elements:[],finishZones:[],conflicts:[],spacePolicy:'include-fixtures',qualification:'unqualified'})
 assert.equal(building.walls.length,5);assert.ok(building.issues.some(i=>i.code==='wall-network-floor-contact'&&i.severity==='review'));assert.equal(building.issues.filter(i=>i.code==='wall-network-floor-conflict').length,0);assert.equal(building.status,'needs-review')
})
test('short measured T returns connect long wall arms without adding source geometry',()=>{
 const pairs=[[[10,10],[19.75,10]],[[10.5,10.5],[19.75,10.5]],[[20.25,10],[30,10]],[[20.25,10.5],[29.5,10.5]],[[10,10.5],[10,20]],[[10.5,10.5],[10.5,20]],[[29.5,10.5],[29.5,20]],[[30,10.5],[30,20]],[[10,20],[30,20]],[[10,20.5],[30,20.5]],[[19.75,9.4],[19.75,10]],[[20.25,9.4],[20.25,10]]]
 const paths=pairs.map(([a,b],id)=>stroke(id,a,b)),d=data(paths);d.textRuns=[{text:'ROOM 1',x:.14,y:.14,w:.02,h:.01}]
 const r=vectorWallNetwork(d);assert.equal(r.pathIds.size,12)
 const stem=r.bodies.find(b=>b.pathIds.includes(10));assert.ok(stem);assert.ok(Math.abs(stem.thicknessFt-.5)<1e-9);assert.deepEqual(stem.a,[.2,.094]);assert.deepEqual(stem.b,[.2,.1])
 assert.equal(vectorWallNetwork({...d,evidence:{...d.evidence,paths:paths.slice(0,10)}}).pathIds.size,0)
 const distant=paths.map(p=>p.id<10?p:{...p,commands:p.commands.map(c=>[c[0],c[1],c[2]-.02])});assert.equal(vectorWallNetwork({...d,evidence:{...d.evidence,paths:distant}}).pathIds.size,0)
 const changedStyle=paths.map(p=>p.id<10?p:{...p,width:.5});assert.equal(vectorWallNetwork({...d,evidence:{...d.evidence,paths:changedStyle}}).pathIds.size,0)
})
test('a measured exposed T-return cap is not a second horizontal wall face',()=>{
 const pairs=[[[10,10],[19.75,10]],[[10.5,10.5],[29.5,10.5]],[[20.25,10],[30,10]],[[10,10],[10,20.5]],[[10.5,10.5],[10.5,20]],[[30,10],[30,20.5]],[[29.5,10.5],[29.5,20]],[[10,20.5],[30,20.5]],[[10.5,20],[29.5,20]],[[19.75,9.4],[19.75,10]],[[20.25,9.4],[20.25,10]],[[19.75,9.4],[20.25,9.4]]],paths=pairs.map(([a,b],id)=>stroke(id,a,b)),d=data(paths);d.textRuns=[{text:'ROOM 1',x:.14,y:.14,w:.02,h:.01}]
 const n=vectorWallNetwork(d);assert.equal(n.caps.length,1);assert.equal(n.caps[0].pathId,11);assert.deepEqual(n.caps[0].ownerPathIds,[9,10]);assert.ok(n.bodies.some(b=>b.pathIds.includes(9)&&b.pathIds.includes(10)));assert.ok(!n.bodies.some(b=>b.pathIds.includes(11)))
 const source={imageWidth:1000,imageHeight:1000,feetPerImagePx:.1,region:{x0:0,y0:0,x1:1,y1:1},segments:[],textRuns:d.textRuns,evidence:{...d.evidence,paths:[...paths,{...paths[11],id:12,width:.7}]}},space={id:'floor',points:[[.105,.105],[.295,.105],[.295,.2],[.105,.2]],holes:[],sourceBoundaries:[{a:[.105,.105],b:[.295,.105],source:'drawn',pathId:1}]},building=reconstructBuilding(source,{version:1,spaces:[space],openings:[],elements:[],finishZones:[],conflicts:[],spacePolicy:'include-fixtures',qualification:'unqualified'});
 assert.ok(building.issues.some(i=>i.code==='measured-wall-cap'));assert.ok(!building.walls.some(w=>w.pathIds.includes(11)||w.pathIds.includes(12)))
 const moved=paths.map(p=>p.id===11?{...p,commands:p.commands.map(c=>[c[0],c[1],c[2]-.001])}:p),unmatched=vectorWallNetwork({...d,evidence:{...d.evidence,paths:moved}});assert.equal(unmatched.caps.length,0)
 const unproven=vectorWallNetwork({...d,excludedPathIds:new Set([9])});assert.ok(!unproven.caps.some(c=>c.pathId===11))
 const bridged=[...paths,stroke(12,[10,8.9],[30,8.9]),stroke(13,[10.5,9.4],[19.75,9.4]),stroke(14,[20.25,9.4],[29.5,9.4])],bothJunctions=vectorWallNetwork({...d,evidence:{...d.evidence,paths:bridged}});assert.ok(!bothJunctions.caps.some(c=>c.pathId===11));assert.ok(bothJunctions.bodies.some(b=>b.pathIds.includes(11)))
 const angle=.41,rotate=p=>[.4+p[0]*Math.cos(angle)-p[1]*Math.sin(angle),.3+p[0]*Math.sin(angle)+p[1]*Math.cos(angle)],rotated=paths.map(p=>({...p,commands:p.commands.map(c=>[c[0],...rotate([c[1],c[2]])])})),label=rotate([.15,.145]),rn=vectorWallNetwork({...d,evidence:{...d.evidence,paths:rotated},textRuns:[{text:'ROOM 1',x:label[0],y:label[1],w:0,h:0}]});assert.ok(rn.caps.some(c=>c.pathId===11));assert.ok(!rn.bodies.some(b=>b.pathIds.includes(11)))
})
test('dense crossing networks without closing caps do not spend the cap budget on arm combinations',()=>{
 const paths=[];let id=0
 for(let k=0;k<120;k++)for(const offset of [0,.5]){
  paths.push(stroke(id++,[0,3*k+offset],[360,3*k+offset]))
  paths.push(stroke(id++,[3*k+offset,0],[3*k+offset,360]))
 }
 const n=vectorWallNetwork(data(paths));assert.equal(n.limited,false);assert.equal(n.caps.length,0);assert.equal(n.diagnostics.pairs,240);assert.equal(n.diagnostics.capOperations,36*240)
})
test('fused core paint tails cannot remove independent support from a complete measured face pair',()=>{
 const pairs=[[[0,0],[20,0]],[[.5,.5],[19.5,.5]],[[0,10.5],[20,10.5]],[[.5,10],[19.5,10]],[[0,0],[0,10.5]],[[.5,.5],[.5,10]],[[20,0],[20,10.5]],[[19.5,.5],[19.5,10]],[[9.75,.5],[9.75,10]],[[10.25,.5],[10.25,10]]],paths=pairs.map(([a,b],id)=>stroke(id,a,b));
 const fill=(id,x0,y0,x1,y1)=>({...stroke(id,[0,0],[0,0]),kind:'fill',color:[.75],width:0,commands:[['M',x0/100,y0/100],['L',x1/100,y0/100],['L',x1/100,y1/100],['L',x0/100,y1/100],['Z']]});paths.push(fill(10,.0417,.0417,19.9583,.4583),fill(11,.4583,.4583,19.5417,.5));
 const d=data(paths),source={imageWidth:1000,imageHeight:1000,feetPerImagePx:.1,region:{x0:0,y0:0,x1:1,y1:1},segments:[],textRuns:d.textRuns,evidence:d.evidence},space={id:'floor',points:[[.005,.005],[.195,.005],[.195,.1],[.005,.1]],holes:[],sourceBoundaries:[{a:[.005,.005],b:[.195,.005],source:'drawn',pathId:1},{a:[.005,.005],b:[.005,.1],source:'drawn',pathId:5},{a:[.195,.005],b:[.195,.1],source:'drawn',pathId:7},{a:[.005,.1],b:[.195,.1],source:'drawn',pathId:3}]},architecture={version:1,spaces:[space],openings:[],elements:[],finishZones:[],conflicts:[],spacePolicy:'include-fixtures',qualification:'unqualified'};
 const b=reconstructBuilding(source,architecture),north=b.walls.find(w=>w.pathIds.includes(0)&&w.pathIds.includes(1)&&Math.abs(w.a[1]-.0025)<1e-8);assert.ok(north);assert.ok(Math.abs(north.thicknessFt-.5)<1e-8);assert.deepEqual(north.a,[.005,.0025]);assert.deepEqual(north.b,[.195,.0025]);assert.ok(b.issues.some(i=>i.pathIds.includes(0)&&i.code==='independent-wall-network'));
 assert.ok(!b.walls.some(w=>w!==north&&Math.abs(w.a[1]-north.a[1])<.0025&&Math.abs(w.b[1]-w.a[1])<1e-8&&Math.min(w.b[0],north.b[0])-Math.max(w.a[0],north.a[0])>.001));assert.ok(b.issues.some(i=>i.code==='wall-pair-small-span'));
 for(const angle of [.41,-.7]){
  const rotate=p=>[.4+p[0]*Math.cos(angle)-p[1]*Math.sin(angle),.3+p[0]*Math.sin(angle)+p[1]*Math.cos(angle)],rotatedPaths=paths.map(p=>({...p,commands:p.commands.map(c=>c.length<3?c:[c[0],...rotate([c[1],c[2]])])})),label=rotate([.05,.045]),rotatedSpace={...space,points:space.points.map(rotate),sourceBoundaries:space.sourceBoundaries.map(c=>({...c,a:rotate(c.a),b:rotate(c.b)}))},r=reconstructBuilding({...source,evidence:{...source.evidence,paths:rotatedPaths},textRuns:[{text:'ROOM 1',x:label[0],y:label[1],w:0,h:0}]},{...architecture,spaces:[rotatedSpace]}),a=rotate([.005,.0025]),end=rotate([.195,.0025]),wall=r.walls.find(w=>w.pathIds.includes(0)&&w.pathIds.includes(1)&&Math.abs(w.thicknessFt-.5)<1e-8);
  assert.ok(wall);assert.ok((Math.hypot(wall.a[0]-a[0],wall.a[1]-a[1])<1e-8&&Math.hypot(wall.b[0]-end[0],wall.b[1]-end[1])<1e-8)||(Math.hypot(wall.b[0]-a[0],wall.b[1]-a[1])<1e-8&&Math.hypot(wall.a[0]-end[0],wall.a[1]-end[1])<1e-8));
 }
})
