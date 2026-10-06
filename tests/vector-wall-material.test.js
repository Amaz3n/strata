require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {wallMaterialFootprints}=require('../lib/drawings/vector-wall-material')
const {interpretArchitecturalElements,visualPathCatalogue}=require('../lib/drawings/area-semantics')
const {runAreaEngine}=require('../lib/drawings/area-engine')
const {reconstructBuilding}=require('../lib/drawings/building-reconstruction')
const {buildingToFloorplan}=require('../lib/drawings/building-floorplan')
const footprint=(id,x0,y0,x1,y1,triangles=true)=>({id,kind:'fill',commands:(triangles?[['M',x0,y0],['L',x1,y0],['L',x1,y1],['Z'],['M',x0,y0],['L',x1,y1],['L',x0,y1],['Z']]:[['M',x0,y0],['L',x1,y0],['L',x1,y1],['L',x0,y1],['Z']]).map(c=>c.length===1?c:[c[0],c[1]/100,c[2]/100]),color:[.72],colorSpace:'DeviceGray',opacity:1,width:0,dashes:[],layer:['A-WALL-HATCH'],groups:[],clips:[],evenOdd:false})
const evidence=paths=>({version:1,paths,truncated:false})
const source=paths=>({evidence:evidence(paths),imageWidth:1000,imageHeight:1000,feetPerImagePx:.1,region:{x0:0,y0:0,x1:1,y1:1},textRuns:[{text:'ROOM',x:.14,y:.14,w:.02,h:.01}],segments:[]})
const architecture={version:1,spaces:[],openings:[],elements:[],finishZones:[],conflicts:[],spacePolicy:'include-fixtures',qualification:'unqualified'}
test('measured complete wall paint refines hatch identity without rewriting source',()=>{
 const paths=[footprint(1,10,10,20,10.5),footprint(2,10,10,10.05,10.05)],e=evidence(paths),before=structuredClone(e),m=wallMaterialFootprints(e,100,100)
 assert.deepEqual([...m.keys()],[1]);assert.equal(m.get(1).ring.length,5);assert.ok(Math.abs(m.get(1).thicknessFt-.5)<1e-9);assert.ok(Math.abs(m.get(1).lengthFt-10)<1e-9)
 assert.deepEqual(e,before);assert.deepEqual(interpretArchitecturalElements(e,[],{sx:100,sy:100}).map(p=>p.kind),['wall','annotation'])
 assert.equal(interpretArchitecturalElements(e)[0].kind,'annotation');assert.equal(visualPathCatalogue(e,{x0:0,y0:0,x1:1,y1:1},160,{sx:100,sy:100})[0].prior,'wall')
})
test('only solid wall material shapes enter; layers cannot promote glyphs, furnishings or hatch strips',()=>{
 const p=footprint(1,10,10,20,10.5)
 for(const change of [{kind:'stroke'},{opacity:.4},{color:[1]},{colorSpace:'DeviceCMYK',color:[0,0,0,1]},{dashes:[1,1]},{layer:[]},{layer:['A-FLOOR-HATCH']},{layer:['A-WALL-HATCH-DIMS']},{layer:['A-WALL-HATCH-FURNITURE']},{layer:['A-WALL-HATCH-DEMO']},{layer:['A-WALL-HATCH-FIXTURE']},{layer:['A-WALL-HATCH-COLUMN']}])assert.equal(wallMaterialFootprints(evidence([{...p,...change}]),100,100).size,0)
 for(const [x1,y1] of [[10.1,10.1],[12,10.5],[20,10.1],[20,12]])assert.equal(wallMaterialFootprints(evidence([footprint(1,10,10,x1,y1)]),100,100).size,0)
 assert.equal(wallMaterialFootprints({...evidence([p]),truncated:true},100,100).size,0);assert.equal(wallMaterialFootprints({...evidence([p]),raster:{}},100,100).size,0)
 for(const sx of [0,NaN,Infinity])assert.equal(wallMaterialFootprints(evidence([p]),sx,100).size,0)
})
test('tessellation must cover one complete rectangle, with no holes, overlapping duplicate triangles or curves',()=>{
 const p=footprint(1,10,10,20,10.5),duplicate={...p,commands:[...p.commands.slice(0,4),...p.commands.slice(0,4)]}
 assert.equal(wallMaterialFootprints(evidence([duplicate]),100,100).size,0)
 const implicit={...p,commands:p.commands.slice(0,-1)};assert.equal(wallMaterialFootprints(evidence([implicit]),100,100).size,1)
 const overlap={...p,commands:[...p.commands.slice(0,4),['M',.1,.1],['L',.2,.1],['L',.1,.105],['Z']]};assert.equal(wallMaterialFootprints(evidence([overlap]),100,100).size,0)
 const broken={...p,commands:p.commands.slice(0,-2)};assert.equal(wallMaterialFootprints(evidence([broken]),100,100).size,0)
 const compound={...p,commands:[...p.commands,['M',.11,.101],['L',.12,.101],['L',.12,.103],['Z']]};assert.equal(wallMaterialFootprints(evidence([compound]),100,100).size,0)
 const curve={...p,commands:[...p.commands,['C',.1,.1,.2,.2,.3,.3]]};assert.equal(wallMaterialFootprints(evidence([curve]),100,100).size,0)
})
test('paint visibility checks later internal masks and unsupported clipping',()=>{
 const p=footprint(2,10,10,20,10.5,false),mask={...footprint(3,14,10.1,15,10.2,false),color:[1]}
 assert.equal(wallMaterialFootprints(evidence([p,mask]),100,100).size,0)
 assert.equal(wallMaterialFootprints(evidence([{...mask,id:1},p]),100,100).size,1)
 assert.equal(wallMaterialFootprints(evidence([{...p,clips:[999]}]),100,100).size,0)
})
test('oblique material retains its measured source ring and unequal-axis calibration',()=>{
 const p=footprint(1,10,10,20,10.5),angle=.4,rotate=c=>{const x=c[1]*100,y=c[2]*100;return[c[0],(30+x*Math.cos(angle)-y*Math.sin(angle))/200,(30+x*Math.sin(angle)+y*Math.cos(angle))/100]}
 const q={...p,commands:p.commands.map(c=>c.length===1?c:rotate(c))},m=wallMaterialFootprints(evidence([q]),200,100).get(1)
 assert.ok(m);assert.ok(Math.abs(m.thicknessFt-.5)<1e-8);assert.ok(Math.abs(m.lengthFt-10)<1e-8)
 const vertices=new Set(q.commands.filter(c=>c.length===3).map(c=>c.slice(1).join(',')));for(const pt of m.ring)assert.ok(vertices.has(pt.join(',')))
})
test('visual disagreement excludes a material hypothesis from 3D instead of overriding the reviewer',()=>{
 const i=source([footprint(1,10,10,20,10.5)]);i.visualObservations=[{id:'review',region:i.region,suppliedPathIds:[1],elements:[{kind:'fixture',pathIds:[1]}],openings:[]}]
 const e=interpretArchitecturalElements(i.evidence,i.visualObservations,{sx:100,sy:100})[0];assert.equal(e.kind,'wall');assert.equal(e.conflict,true)
 assert.equal(reconstructBuilding(i,architecture).walls.length,0)
})
test('takeoff and 3D use the same solid exterior without creating walls on tessellation diagonals',async()=>{
 const paths=[footprint(1,10,10,20,10.5),footprint(2,10,20,20,20.5),footprint(3,10,10.5,10.5,20),footprint(4,19.5,10.5,20,20)],i=source(paths),before=structuredClone(i)
 const r=await runAreaEngine(i,{wholeSheet:true}),b=r.detection.architecture.building
 assert.equal(r.detection.proposals.length,1);assert.ok(Math.abs(r.detection.proposals[0].areaSqft-85.5)<1e-6);assert.equal(b.walls.length,4)
 assert.ok(b.walls.every(w=>Math.abs(w.a[0]-w.b[0])<1e-8||Math.abs(w.a[1]-w.b[1])<1e-8));assert.equal(b.issues.filter(i=>i.code==='wall-material-footprint').length,4)
 const level=buildingToFloorplan({...i,sheetVersionId:'00000000-0000-4000-8000-000000000001',sheetNumber:'A1',sheetTitle:'Floor',name:'Level1',order:0,scaleConfirmed:false},r.detection.architecture)
 assert.equal(level.walls.length,4);assert.equal(level.rooms.length,1);assert.ok(level.walls.every(w=>w.evidence.pathIds.length));assert.deepEqual(i,before)
})
