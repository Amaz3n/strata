require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {reconstructBuilding}=require('../lib/drawings/building-reconstruction')
const {buildingToFloorplan}=require('../lib/drawings/building-floorplan')
const {runAreaEngine}=require('../lib/drawings/area-engine')
const {floorplanModelSchema}=require('../lib/validation/floorplan')
const path=(id,points,layer='A_WALL',extra={})=>({id,commands:points.map((p,i)=>[i?'L':'M',p[0]/100,p[1]/100]),kind:'stroke',color:[0],colorSpace:'DeviceGray',opacity:1,width:.01,dashes:[],layer:[layer],groups:[],clips:[],evenOdd:false,...extra})
const input=paths=>({imageWidth:1000,imageHeight:1000,feetPerImagePx:.1,region:{x0:0,y0:0,x1:1,y1:1},segments:[],textRuns:[],evidence:{version:1,paths,truncated:false}})
const architecture=(spaces=[],openings=[])=>({version:1,elements:[],spaces,openings,finishZones:[],conflicts:[],spacePolicy:'include-fixtures',qualification:'unqualified'})
test('pairs original wall faces; never promotes dimensions, furniture or dashed overheads',()=>{
 const data=input([path(1,[[10,10],[30,10]]),path(2,[[10,10.5],[30,10.5]]),path(3,[[10,20],[30,20]],'A_DIM'),path(4,[[10,20.5],[30,20.5]],'A_DIM'),path(5,[[10,30],[30,30]],'A_FURN'),path(6,[[10,30.5],[30,30.5]],'A_FURN'),path(7,[[10,40],[30,40]],'A_WALL',{dashes:[1,1]}),path(8,[[10,40.5],[30,40.5]],'A_WALL',{dashes:[1,1]})])
 const result=reconstructBuilding(data,architecture())
 assert.equal(result.walls.length,1);assert.deepEqual(result.walls[0].pathIds,[1,2]);assert.equal(result.walls[0].thicknessFt,.5)
})
test('clips crossing wall faces to both source PDF mask and selected region, including mask edge',()=>{
 const clip=path(10,[[10,10],[20,10],[20,20],[10,20],[10,10]],'',{kind:'clip'})
 const data=input([clip,path(1,[[0,10],[30,10]],'A_WALL',{clips:[10]}),path(2,[[0,10.5],[30,10.5]],'A_WALL',{clips:[10]})])
 data.region={x0:.15,y0:0,x1:1,y1:1}
 const result=reconstructBuilding(data,architecture())
 assert.equal(result.walls.length,1);assert.deepEqual(result.walls[0].a,[.15,.1025]);assert.deepEqual(result.walls[0].b,[.2,.1025])
})
test('never pairs two faces across known occupied floor space',()=>{
 const data=input([path(1,[[10,10],[30,10]]),path(2,[[10,10.5],[30,10.5]])])
 const result=reconstructBuilding(data,architecture([{id:'passage',points:[[.09,.099],[.31,.099],[.31,.106],[.09,.106]],holes:[]}]))
 assert.equal(result.walls.length,0)
})
test('an opening requires two supported jambs; a window alias is not a solid wall',()=>{
 const paths=[path(1,[[10,10],[15,10]]),path(2,[[10,10.5],[15,10.5]]),path(3,[[18,10],[25,10]]),path(4,[[18,10.5],[25,10.5]]),path(5,[[15,10.25],[18,10.25]],'A_WDW')]
 const result=reconstructBuilding(input(paths),architecture())
 assert.equal(result.openings.length,1);assert.equal(result.openings[0].kind,'window');assert.equal(result.openings[0].widthFt,3)
 const orphan=reconstructBuilding(input(paths.slice(0,2).concat(paths[4])),architecture())
 assert.equal(orphan.openings.length,0)
})
test('geometry identities survive path ordering and a re-extraction ID change',()=>{
 const paths=[path(1,[[10,10],[30,10]]),path(2,[[10,10.5],[30,10.5]])]
 assert.deepEqual(reconstructBuilding(input(paths),architecture()).walls.map(w=>w.id),reconstructBuilding(input(paths.reverse().map(p=>({...p,id:p.id+100}))),architecture()).walls.map(w=>w.id))
})
test('takeoff and 3D share physical room boundaries and measured area without legacy room retention',async()=>{
 const outer=path(1,[[10,10],[30,10],[30,25],[10,25],[10,10]])
 const inner=path(2,[[10.5,10.5],[29.5,10.5],[29.5,24.5],[10.5,24.5],[10.5,10.5]])
 const data=input([outer,inner]);data.textRuns=[{text:'BATH 2',x:.15,y:.15,w:.04,h:.01}]
 const result=await runAreaEngine({...data,finishPolicy:'include-fixtures'},{wholeSheet:true})
 const level=buildingToFloorplan({...data,name:'Ground floor',order:0,sheetVersionId:'00000000-0000-4000-8000-000000000001',sheetNumber:'A1',sheetTitle:'Floor plan',scaleConfirmed:true},result.detection.architecture)
 assert.ok(level.rooms.length>0)
 assert.equal(level.rooms.length,result.detection.architecture.spaces.length)
 for(const room of level.rooms){const space=result.detection.architecture.spaces.find(s=>s.id===room.id);assert.ok(Math.abs(room.areaSqft-space.areaSqft)<1e-6)}
 assert.ok(level.rooms.every(r=>r.areaSqft<301))
 assert.ok(floorplanModelSchema.safeParse({version:1,units:'feet',levels:[level],correctionCount:0}).success)
})

test('editing a shared model recomputes finished faces without reverting to centreline room areas',()=>{
 const {recomputeRooms,applyFloorplanEdit}=require('../lib/drawings/floorplan-model')
 const level={id:'L0',name:'Floor',order:0,ceilingHeightFt:9,source:{imageWidth:1000,imageHeight:1000,feetPerImagePx:.1,originPxX:0,originPxY:0,scaleConfirmed:true},walls:[[10,10,30,10],[30,10,30,25],[30,25,10,25],[10,25,10,10]].map(([x0,y0,x1,y1],i)=>({id:'w'+i,x0,y0,x1,y1,thicknessFt:.5,source:'paired',confidence:.8})),rooms:[{id:'bath',polygon:[[10.25,10.25],[29.75,10.25],[29.75,24.75],[10.25,24.75]],label:'BATH',areaSqft:282.75,confidence:.7}],openings:[],reconstruction:{version:1,issues:[],source:{},status:'needs-review'}}
 assert.ok(Math.abs(recomputeRooms(level)[0].areaSqft-282.75)<1e-6)
 const next=applyFloorplanEdit({version:1,units:'feet',levels:[level],correctionCount:0},{type:'wall.update',levelId:'L0',wallId:'w0',changes:{thicknessFt:.75}})
 assert.ok(Math.abs(next.levels[0].rooms[0].areaSqft-280.3125)<1e-6)
 assert.equal(next.levels[0].rooms[0].id,'bath')
})
test('a floor-wide review cannot silently dismiss unresolved source discrepancies',()=>{
 const {applyFloorplanEdit}=require('../lib/drawings/floorplan-model')
 const level={id:'L0',walls:[],openings:[],rooms:[],reconstruction:{version:1,issues:[{id:'face-1',code:'unpaired-wall',severity:'review',message:'Source face missing',pathIds:[1]}],source:{},status:'needs-review'}}
 const model={version:1,units:'feet',levels:[level],correctionCount:0}
 assert.equal(applyFloorplanEdit(model,{type:'level.review',levelId:'L0',reviewed:true}),model)
 const corrected=applyFloorplanEdit(model,{type:'reconstruction.resolve',levelId:'L0',issueId:'face-1',note:'Verified this line is window trim.'})
 assert.equal(corrected.levels[0].reconstruction.resolutions.length,1)
 assert.equal(applyFloorplanEdit(corrected,{type:'level.review',levelId:'L0',reviewed:true}).levels[0].reviewed,true)
})

test('a takeoff finish boundary does not become a new physical room or a 3D wall',async()=>{
 const data=input([path(1,[[10,10],[30,10],[30,25],[10,25],[10,10]])])
 data.textRuns=[{text:'LIVING',x:.14,y:.16,w:.02,h:.01},{text:'DINING',x:.24,y:.16,w:.02,h:.01}]
 data.boundaries=[{a:[.2,.1],b:[.2,.25],source:'user'}]
 const result=await runAreaEngine(data,{wholeSheet:false})
 assert.equal(result.detection.proposals.length,2)
 assert.equal(result.detection.architecture.spaces.length,1)
 assert.equal(result.detection.architecture.finishZones.length,2)
 assert.equal(result.detection.architecture.building.walls.length,0)
})

test('provider schema accepts a complete catalogue group while retaining source-ID validation',()=>{
 const {visualInterpretationProviderSchema,interpretArchitecturalElements}=require('../lib/drawings/area-semantics')
 const answer={elements:[{kind:'annotation',pathIds:Array.from({length:160},(_,i)=>i)}],openings:[]}
 assert.equal(visualInterpretationProviderSchema.safeParse(answer).success,true)
 assert.equal(visualInterpretationProviderSchema.safeParse({elements:[]}).success,false)
 const data=input([path(1,[[10,10],[30,10]],'')]);const interpreted=interpretArchitecturalElements(data.evidence,[{id:'answer',region:data.region,suppliedPathIds:[1],elements:answer.elements,openings:[]}])
 assert.equal(interpreted.length,1);assert.equal(interpreted[0].pathId,1)
})

test('recovers unlayered paired source spans beside drawn floor boundaries, with explicit review',()=>{
 const data=input([path(1,[[10,10],[30,10]],''),path(2,[[10,10.5],[30,10.5]],''),path(3,[[40,10],[50,10]],''),path(4,[[40,10.5],[50,10.5]],'')])
 const space={id:'room',points:[[.1,.105],[.3,.105],[.3,.2],[.1,.2]],holes:[],sourceBoundaries:[{a:[.1,.105],b:[.3,.105],source:'drawn',pathId:2}]}
 const result=reconstructBuilding(data,architecture([space]))
 assert.equal(result.walls.length,1);assert.deepEqual(result.walls[0].pathIds,[1,2]);assert.ok(result.issues.some(i=>i.code==='inferred-wall'&&i.objectId===result.walls[0].id))
 space.sourceBoundaries[0].source='user'
 assert.equal(reconstructBuilding(data,architecture([space])).walls.length,0)
})
test('source finish expansion cannot chain beyond the maximum furring allowance',()=>{
 const paths=[path(1,[[10,10],[30,10]]),path(2,[[10,10.5],[30,10.5]])]
 const boundaries=[9.75,9.5,9.25].map((y,i)=>({a:[.1,y/100],b:[.3,y/100],source:'drawn',pathId:i+3}))
 paths.push(...boundaries.map((b,i)=>path(i+3,[[10,b.a[1]*100],[30,b.a[1]*100]],'A_WALL')))
 const space={id:'room',points:[[.1,.085],[.3,.085],[.3,.0976],[.1,.0976]],holes:[],sourceBoundaries:boundaries}
 const result=reconstructBuilding(input(paths),architecture([space]))
 assert.ok(result.walls.every(w=>w.thicknessFt<=1.1))
})
test('small source voids remain valid and retain their exact area in the mesh',()=>{
 const {validArchitecturalRing,validateArchitecturalModel}=require('../lib/drawings/architectural-validation')
 const hole=[[2,2],[2.05,2],[2.05,2.05],[2,2.05]]
 assert.equal(validArchitecturalRing(hole),true)
 assert.equal(validArchitecturalRing([[1,1],[1,1],[1,1]]),false)
 const result=validateArchitecturalModel({version:1,units:'feet',levels:[{id:'L',source:{scaleConfirmed:true},walls:[],openings:[],rooms:[{id:'room',polygon:[[0,0],[10,0],[10,10],[0,10]],holes:[hole]}]}]})
 assert.ok(!result.some(i=>i.id.endsWith(':polygon')||i.id.endsWith(':mesh')))
})
test('segment broad phase retains boundary, negative-coordinate and long-segment neighbours',()=>{
 const {segmentIndex}=require('../lib/drawings/segment-index')
 const segments=[{a:[-4,0],b:[0,0]},{a:[0,.5],b:[4,.5]},{a:[-1000,-1000],b:[1000,1000]}]
 const near=segmentIndex(segments)
 assert.deepEqual(new Set(near(segments[0],1)),new Set([0,1,2]))
})

test('closed garage panels create measured openings only between two structural jambs',()=>{
 const paths=[path(1,[[10,10],[12,10]]),path(2,[[10,10.5],[12,10.5]]),path(3,[[28,10],[30,10]]),path(4,[[28,10.5],[30,10.5]]),path(5,[[12,10.125],[28,10.125],[28,10.375],[12,10.375],[12,10.125]],'A_DOOR')]
 const result=reconstructBuilding(input(paths),architecture())
 assert.equal(result.openings.length,1);assert.equal(result.openings[0].kind,'door');assert.ok(Math.abs(result.openings[0].widthFt-16)<1e-6)
 const orphan=reconstructBuilding(input(paths.filter(p=>p.id!==3&&p.id!==4)),architecture())
 assert.equal(orphan.openings.length,0)
 const swingLeaf=reconstructBuilding(input(paths.map(p=>p.id===5?path(5,[[12,10],[12,13]],'A_DOOR'):p)),architecture())
 assert.equal(swingLeaf.openings.length,0)
})

test('recessed door frames use clear source jambs rather than their oversized frame width',()=>{
 const paths=[path(1,[[10,10],[30,10]]),path(2,[[10,10.5],[30,10.5]]),path(3,[[12,10],[12,10.5]]),path(4,[[28,10],[28,10.5]]),path(5,[[11.84,9.6],[28.16,9.6],[28.16,9.85],[11.84,9.85],[11.84,9.6]],'A_DOOR')]
 const room={id:'garage',labels:['GARAGE'],points:[[.1,0],[.3,0],[.3,.1],[.1,.1]],holes:[]}
 const result=reconstructBuilding(input(paths),architecture([room]))
 assert.equal(result.openings.length,1)
 assert.ok(Math.abs(result.openings[0].widthFt-16)<1e-6)
 assert.equal(result.openings[0].style,'garage')
 assert.ok(result.issues.some(i=>i.code==='opening-operation'))
})

test('a near-vertical opening cannot bypass occupied source walls by reversing its projection axis',()=>{
 const flanks=[path(1,[[50,45],[50,50]]),path(2,[[50.5,45],[50.5,50]]),path(3,[[50,53],[50,60]]),path(4,[[50.5,53],[50.5,60]])];
 const occupied=[path(5,[[50,50.2],[50,52.8]]),path(6,[[50.5,50.2],[50.5,52.8]])];
 // A tiny source-coordinate difference puts the candidate and wall in opposite
 // canonical directions. Scalar intervals from those axes are not comparable.
 for(const endpoints of [[[.5025001,.5],[.5025,.53]],[[.5025,.53],[.5025001,.5]],[[.5025,.5],[.5025,.53]]]){
  const arch=architecture([], [{boundary:{a:endpoints[0],b:endpoints[1]},spaceIds:[]}]);
  assert.equal(reconstructBuilding(input(flanks),arch).openings.length,1);
  assert.equal(reconstructBuilding(input([...flanks,...occupied]),arch).openings.length,0);
 }
});
