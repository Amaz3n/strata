require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {measuredJambWindowHosts}=require('../lib/drawings/window-jamb-hosts')
function fixture(angle=0){
  const turn=([x,y])=>[15+x*Math.cos(angle)-y*Math.sin(angle),10+x*Math.sin(angle)+y*Math.cos(angle)]
  const norm=([x,y])=>[x/60,y/30]
  const source=[[[0,0],[0,.8]],[[4,0],[4,.8]],[[-2,0],[0,0]],[[-2,.8],[0,.8]],[[4,0],[6,0]],[[4,.8],[6,.8]],[[.1,.35],[3.9,.35]],[[.1,.45],[3.9,.45]]]
  const path=(id,points,kind='wall')=>({id,commands:points.map((p,i)=>[i?'L':'M',...norm(turn(p))]),kind:'stroke',layer:[kind==='wall'?'A_WALL':'A_WDW'],opacity:1,dashes:[],clips:[],groups:[],width:1,color:[0],colorSpace:'DeviceGray',evenOdd:false})
  return {input:{segments:[],textRuns:[],imageWidth:1200,imageHeight:600,feetPerImagePx:.05,region:{x0:0,y0:0,x1:1,y1:1},evidence:{version:1,paths:source.map((p,i)=>path(i+1,p,i<6?'wall':'window')),truncated:false}},path,turn,norm}
}
test('two measured jambs and four outward faces recover exact host geometry at every orientation',()=>{
  for(const angle of [0,Math.PI/2,.63,Math.PI]){
    const f=fixture(angle),original=structuredClone(f.input),hosts=measuredJambWindowHosts(f.input)
    assert.equal(hosts.length,1);const h=hosts[0]
    assert.ok(Math.abs(h.widthFt-4)<1e-8);assert.ok(Math.abs(h.thicknessFt-.8)<1e-8);assert.equal(h.ambiguous,false)
    const expected=[f.norm(f.turn([0,.4])),f.norm(f.turn([4,.4]))]
    assert.ok(expected.every(p=>[h.a,h.b].some(q=>Math.hypot(p[0]-q[0],p[1]-q[1])<1e-8)))
    assert.deepEqual(h.pathIds.slice().sort((a,b)=>a-b),[1,2,3,4,5,6,7,8]);assert.deepEqual(f.input,original)
    assert.equal(h.piers.length,2)
    assert.ok(h.piers.every(p=>Math.abs(Math.hypot((p.b[0]-p.a[0])*60,(p.b[1]-p.a[1])*30)-2)<1e-8))
  }
})
test('every pane, jamb and supporting face is necessary; no room or schedule can replace missing source',()=>{
  for(let id=1;id<=8;id++){
    const f=fixture();f.input.evidence.paths=f.input.evidence.paths.filter(p=>p.id!==id)
    assert.equal(measuredJambWindowHosts(f.input).length,0,`missing path ${id}`)
  }
})
test('unknown, conflicting and fixture-classified panes cannot create a host',()=>{
  for(const mode of ['unknown','fixture','conflict']){
    const f=fixture();f.input.evidence.paths.filter(p=>p.id>=7).forEach(p=>p.layer=[])
    if(mode!=='unknown')f.input.visualObservations=[{id:'obs',region:f.input.region,suppliedPathIds:[7,8],openings:[],elements:[{kind:'fixture',pathIds:[7,8]},...(mode==='conflict'?[{kind:'window',pathIds:[7,8]}]:[])]}]
    assert.equal(measuredJambWindowHosts(f.input).length,0,mode)
  }
})
test('a containing rectangular PDF clip is supported; hidden or unknown jambs remain missing',()=>{
  const f=fixture();f.input.evidence.paths.forEach(p=>p.clips=[9])
  const clip={...f.path(9,[[-4,-3],[8,-3],[8,3],[-4,3],[-4,-3]]),kind:'clip',layer:[]}
  f.input.evidence.paths.push(clip);assert.equal(measuredJambWindowHosts(f.input).length,1)
  clip.commands=clip.commands.map(c=>[c[0],Math.min(c[1],17/60),c[2]])
  assert.equal(measuredJambWindowHosts(f.input).length,0)
  f.input.evidence.paths=f.input.evidence.paths.filter(p=>p.id!==9)
  assert.equal(measuredJambWindowHosts(f.input).length,0)
})
test('post, continuous wall and mismatched jamb depth cannot be erased by a window hypothesis',()=>{
  for(const mode of ['post','continuous','depth','backwards-pier']){
    const f=fixture()
    if(mode==='post')f.input.evidence.paths.push(f.path(9,[[2,-1],[2,1.8]]))
    if(mode==='continuous')f.input.evidence.paths.push(f.path(9,[[-2,.2],[6,.2]]))
    if(mode==='depth')f.input.evidence.paths[1]=f.path(2,[[4,0],[4,1.2]])
    if(mode==='backwards-pier')f.input.evidence.paths[2]=f.path(3,[[0,0],[2,0]])
    assert.equal(measuredJambWindowHosts(f.input).length,0,mode)
  }
})
test('clipped region, incomplete extraction and invisible returns cannot produce source-backed hosts',()=>{
  for(const mode of ['region','truncated','white','dashed','faded']){
    const f=fixture()
    if(mode==='region')f.input.region.x0=15.05/60
    if(mode==='truncated')f.input.evidence.truncated=true
    if(mode==='white')f.input.evidence.paths[0].color=[1]
    if(mode==='dashed')f.input.evidence.paths[0].dashes=[1,2]
    if(mode==='faded')f.input.evidence.paths[0].opacity=.1
    assert.equal(measuredJambWindowHosts(f.input).length,0,mode)
  }
})
test('batched pane paths may represent separate windows without making them competing hosts',()=>{
  const f=fixture(),second=fixture();second.input.evidence.paths.forEach(p=>{p.id+=10;p.commands=p.commands.map(c=>[c[0],c[1]+10/60,c[2]])})
  f.input.evidence.paths.push(...second.input.evidence.paths.filter(p=>p.id<17))
  for(const id of [7,8])f.input.evidence.paths.find(p=>p.id===id).commands.push(...second.input.evidence.paths.find(p=>p.id===id+10).commands)
  const hosts=measuredJambWindowHosts(f.input)
  assert.equal(hosts.length,2);assert.ok(hosts.every(h=>!h.ambiguous))
})
test('shared reconstruction uses full measured jamb width and does not create a duplicate pane opening',()=>{
  const {reconstructBuilding}=require('../lib/drawings/building-reconstruction')
  const {buildingToFloorplan}=require('../lib/drawings/building-floorplan')
  const {floorplanModelSchema}=require('../lib/validation/floorplan')
  const {openingWidthNote}=require('../lib/drawings/opening-dimensions')
  const f=fixture(),architecture={version:1,elements:[],spaces:[],openings:[],finishZones:[],conflicts:[],spacePolicy:'include-fixtures',qualification:'unqualified'}
  // The general builder can already place this simple source. Either path
  // must produce exactly one opening, not overlapping frame/pane duplicates.
  const b=reconstructBuilding(f.input,architecture);assert.equal(b.openings.length,1)
  assert.ok(b.openings[0].widthFt>=3.8-1e-8)
  architecture.building=b
  const l=buildingToFloorplan({...f.input,name:'Floor',order:0,sheetVersionId:'source',sheetNumber:null,sheetTitle:null},architecture)
  assert.ok(floorplanModelSchema.safeParse({version:1,units:'feet',levels:[l],correctionCount:0}).success)
  assert.ok(openingWidthNote('jamb-span').includes('jambs'))
})
test('two fully supported but different jamb depths remain ambiguous instead of selecting a thicker wall',()=>{
  const f=fixture(),additional=[[[0,-.2],[0,1]],[[4,-.2],[4,1]],[[-2,-.2],[0,-.2]],[[-2,1],[0,1]],[[4,-.2],[6,-.2]],[[4,1],[6,1]]]
  f.input.evidence.paths.push(...additional.map((p,i)=>f.path(20+i,p)))
  const hosts=measuredJambWindowHosts(f.input)
  assert.equal(hosts.length,2);assert.ok(hosts.every(h=>h.ambiguous))
})

const architecture=spaces=>({version:1,elements:[],spaces,openings:[],finishZones:[],conflicts:[],spacePolicy:'include-fixtures',qualification:'unqualified'})
const remoteRoom={id:'remote',points:[[.8,.8],[.9,.8],[.9,.9],[.8,.9]],holes:[]}
test('missing room detection cannot discard measured piers or extend them beyond the shorter finish face',()=>{
  const {reconstructBuilding}=require('../lib/drawings/building-reconstruction')
  for(const angle of [0,Math.PI/2,.63,Math.PI]){
    const f=fixture(angle)
    f.input.evidence.paths[4]=f.path(5,[[4,0],[8,0]])
    f.input.evidence.paths[5]=f.path(6,[[4,.8],[5.5,.8]])
    const host=measuredJambWindowHosts(f.input)[0]
    const lengths=host.piers.map(p=>Math.hypot((p.b[0]-p.a[0])*60,(p.b[1]-p.a[1])*30)).sort((a,b)=>a-b)
    assert.ok(Math.abs(lengths[0]-1.5)<1e-8);assert.ok(Math.abs(lengths[1]-2)<1e-8)
    const result=reconstructBuilding(f.input,architecture([remoteRoom]))
    const piers=result.walls.filter(w=>w.basis==='paired-faces')
    assert.equal(piers.length,2)
    assert.ok(Math.abs(piers.reduce((sum,w)=>sum+Math.hypot((w.b[0]-w.a[0])*60,(w.b[1]-w.a[1])*30),0)-3.5)<1e-8)
    assert.ok(piers.every(w=>Math.abs(w.thicknessFt-.8)<1e-8))
    assert.equal(result.issues.filter(i=>i.code==='window-pier-recovered').length,2)
    assert.equal(result.openings.length,1)
  }
})
test('existing pier bodies stay unchanged and do not acquire duplicate recovery reviews',()=>{
  const {reconstructBuilding}=require('../lib/drawings/building-reconstruction'),f=fixture()
  const result=reconstructBuilding(f.input,architecture([]))
  assert.equal(result.walls.filter(w=>w.basis==='paired-faces').length,2)
  assert.equal(result.issues.filter(i=>i.code==='window-pier-recovered').length,0)
})
test('a room overlapping only the outside of a proposed pier still blocks its recovery',()=>{
  const {reconstructBuilding}=require('../lib/drawings/building-reconstruction'),f=fixture()
  // Keep this room slightly inside the drawn face, so the normal wall-room
  // adjacency probes do not themselves accept the disputed paired span.
  const room={id:'conflict',points:[[-2.1,.7],[.1,.7],[.1,.79],[-2.1,.79]].map(p=>f.norm(f.turn(p))),holes:[]}
  const result=reconstructBuilding(f.input,architecture([room]))
  assert.equal(result.issues.filter(i=>i.code==='window-pier-conflict').length,1)
  assert.equal(result.issues.filter(i=>i.code==='window-pier-recovered').length,1)
})
test('ambiguous jamb depths cannot recover either set of adjoining piers',()=>{
  const {reconstructBuilding}=require('../lib/drawings/building-reconstruction'),f=fixture()
  const additional=[[[0,-.2],[0,1]],[[4,-.2],[4,1]],[[-2,-.2],[0,-.2]],[[-2,1],[0,1]],[[4,-.2],[6,-.2]],[[4,1],[6,1]]]
  f.input.evidence.paths.push(...additional.map((p,i)=>f.path(20+i,p)))
  const result=reconstructBuilding(f.input,architecture([remoteRoom]))
  assert.equal(result.walls.length,0)
  assert.ok(!result.issues.some(i=>i.code==='window-pier-recovered'))
})
test('an existing narrower core subtracts only its covered interval from a measured pier',()=>{
  const {reconstructBuilding}=require('../lib/drawings/building-reconstruction'),f=fixture()
  f.input.evidence.paths[4]=f.path(5,[[4,0],[8,0]])
  f.input.evidence.paths[5]=f.path(6,[[4,.8],[8,.8]])
  f.input.evidence.paths.push(f.path(9,[[6,.3],[8,.3]]))
  const room={id:'core-adjacent',points:[[6,.35],[8,.35],[8,.45],[6,.45]].map(p=>f.norm(f.turn(p))),holes:[]}
  const result=reconstructBuilding(f.input,architecture([room]))
  const right=result.walls.filter(w=>w.basis==='paired-faces'&&Math.min(w.a[0],w.b[0])*60>=19-1e-8)
  assert.equal(right.length,2)
  const recovered=right.find(w=>Math.abs(w.thicknessFt-.8)<1e-8),core=right.find(w=>Math.abs(w.thicknessFt-.3)<1e-8)
  assert.ok(recovered&&core)
  assert.ok(Math.abs(Math.max(recovered.a[0],recovered.b[0])*60-21)<1e-8)
  assert.ok(Math.abs(Math.min(core.a[0],core.b[0])*60-21)<1e-8)
  assert.ok(Math.abs(Math.max(core.a[0],core.b[0])*60-23)<1e-8)
})
