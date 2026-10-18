require('../scripts/register-ts-node-test')
const test = require('node:test')
const assert = require('node:assert/strict')
const { detectAreas, areaFaces, ringArea, validRing, splitArea, mergeAreas, proposalArea, validateAreaGeometry, areasOverlap } = require('../lib/drawings/area-takeoff')
const { acceptAreasSchema } = require('../lib/validation/area-takeoff')
const rectangle = (x0, y0, x1, y1) => [[x0,y0],[x1,y0],[x1,y1],[x0,y1]]
const segments = (ring) => ring.flatMap((p,i) => [...p, ...ring[(i+1)%ring.length]])
const input = (lines) => ({ segments: lines, textRuns: [], imageWidth: 1000, imageHeight: 1000, feetPerImagePx: .02, region: {x0:0,y0:0,x1:1,y1:1} })
const proposal = (points) => ({id:'room',label:'Room',points,originalPoints:points,holes:[],boundary:[],areaSqft:0,warnings:[],source:'vector',edited:false})
const outer = rectangle(.1,.1,.9,.9)

test('tessellated doorway fits quarter and half swings but rejects furniture ellipses and retracing', () => {
  const { fitOpeningArc } = require('../lib/drawings/area-opening-curves')
  const arc = (sweep, radius = 3) => Array.from({length:25},(_,i)=>[12+radius*Math.cos(i*sweep/24),8+radius*Math.sin(i*sweep/24)])
  for (const sweep of [Math.PI/2,Math.PI,-Math.PI/2]) {
    const result=fitOpeningArc(arc(sweep))
    assert.ok(result)
    assert.ok(Math.hypot(result.center[0]-12,result.center[1]-8)<1e-8)
  }
  assert.equal(fitOpeningArc(arc(Math.PI/2).map(([x,y])=>[x,y*1.3])),null)
  assert.equal(fitOpeningArc(arc(Math.PI/2,8)),null)
  assert.equal(fitOpeningArc([...arc(Math.PI/2),...arc(Math.PI/2).reverse().slice(1)]),null)
  assert.equal(fitOpeningArc([[0,0],[1,0],[2,0],[3,0],[4,0],[5,0],[6,0]]),null)
})

test('floor scope excludes open below and roofs without excluding open above', () => {
  const { floorExclusionLabels } = require('../lib/drawings/area-context')
  const run=(text,x=.2,y=.2)=>({text,x,y,w:.1,h:.01})
  const result=floorExclusionLabels([run('OPEN TO'),run('BELOW',.2,.215),run('OPEN TO ABOVE',.5),run('ROOF BELOW',.7),run('NOT IN SCOPE',.8),run('BEDROOM',.3)])
  assert.deepEqual(result.map(r=>r.text).sort(),['NOT IN SCOPE','OPEN TO BELOW','ROOF BELOW'])
})

test('annotation exclusions require a bounded source frame and preserve nearby plan text', () => {
  const { areaViewExclusions, textOutsideAreaExclusions } = require('../lib/drawings/area-context')
  const path={id:1,kind:'stroke',commands:[['M',.1,.1],['L',.3,.1],['L',.3,.3],['L',.1,.3],['Z']]}
  const runs=[{text:'NOT TO SCALE',x:.12,y:.12,w:.1,h:.01},{text:'BEDROOM',x:.5,y:.5,w:.1,h:.01}]
  const exclusions=areaViewExclusions({paths:[path]},runs)
  assert.equal(exclusions.length,1)
  assert.deepEqual(textOutsideAreaExclusions(runs,exclusions),[runs[1]])
  assert.equal(areaViewExclusions({paths:[]},runs).length,0)
  assert.equal(areaViewExclusions({paths:[{...path,commands:[['M',0,0],['L',1,0],['L',1,1],['L',0,1],['Z']]}]},runs).length,0)
})

test('drawn interior face measures 16 × 16 feet exactly, without centerline inflation', () => {
  const result = detectAreas(input(segments(outer)))
  assert.equal(result.proposals.length, 1)
  assert.ok(Math.abs(result.proposals[0].areaSqft-256)<1e-8)
  assert.equal(result.proposals[0].boundary.length,4)
  assert.ok(result.proposals[0].warnings.length)
})
test('double-line walls produce an interior floor face, not a wall-band area', () => {
  const result = detectAreas(input([...segments(outer),...segments(rectangle(.075,.075,.925,.925))]))
  assert.equal(result.proposals.length,1)
  assert.ok(Math.abs(result.proposals[0].areaSqft-256)<1e-8)
})
test('real T and X junctions subdivide into four rooms', () => {
  const result = detectAreas(input([...segments(outer),.5,.1,.5,.9,.1,.5,.9,.5]))
  assert.equal(result.proposals.length,4)
  assert.ok(result.proposals.every((r)=>Math.abs(r.areaSqft-64)<1e-8))
})
test('collinear overlapping segments do not duplicate boundaries', () => {
  const result = detectAreas(input([...segments(outer),.3,.1,.7,.1]))
  assert.equal(result.proposals.length,1)
  assert.ok(Math.abs(result.proposals[0].areaSqft-256)<1e-8)
})
test('dangling line into a room does not destroy its area', () => {
  const result = detectAreas(input([...segments(outer),.1,.5,.3,.5]))
  assert.equal(result.proposals.length,1)
  assert.ok(Math.abs(result.proposals[0].areaSqft-256)<1e-8)
})
test('a three-foot gap stays open unless a boundary is explicitly added', () => {
  const lines = [...segments(outer).slice(4),.1,.1,.4,.1,.55,.1,.9,.1]
  assert.equal(detectAreas(input(lines)).proposals.length,0)
  const fixed = detectAreas({...input(lines),boundaries:[{a:[.4,.1],b:[.55,.1],source:'user'}]})
  assert.equal(fixed.proposals.length,1)
  assert.ok(fixed.proposals[0].boundary.some((e)=>e.source==='user'))
})
test('region edges never become imaginary walls', () => {
  const result = detectAreas({...input(segments(outer)),region:{x0:0,y0:0,x1:.5,y1:1}})
  assert.equal(result.proposals.length,0)
})
test('rotated plans retain exact area without axis snapping', () => {
  const theta=.2, rotated=outer.map(([x,y])=>[(x-.5)*Math.cos(theta)-(y-.5)*Math.sin(theta)+.5,(x-.5)*Math.sin(theta)+(y-.5)*Math.cos(theta)+.5])
  const result=detectAreas(input(segments(rotated)))
  assert.equal(result.proposals.length,1)
  assert.ok(Math.abs(result.proposals[0].areaSqft-256)<1e-8)
})
test('scale changes square the quantity; uncalibrated input is rejected', () => {
  assert.ok(Math.abs(detectAreas({...input(segments(outer)),feetPerImagePx:.04}).proposals[0].areaSqft-1024)<1e-8)
  assert.throws(()=>detectAreas({...input([]),feetPerImagePx:0}),/Calibrate/)
})
test('nested column is an explicit deduction and never silently included', () => {
  const result=detectAreas(input([...segments(outer),...segments(rectangle(.4,.4,.45,.45))]))
  assert.equal(result.proposals.length,1)
  assert.equal(result.proposals[0].holes.length,1)
  assert.ok(Math.abs(result.proposals[0].areaSqft-255)<1e-8)
})
test('dashed annotations do not split a room', () => {
  const result=detectAreas({...input([...segments(outer),.5,.1,.5,.9]),flags:[0,0,0,0,1]})
  assert.equal(result.proposals.length,1)
})
test('multiple labels are an explicit merge warning, never higher confidence', () => {
  const result=detectAreas({...input(segments(outer)),textRuns:[{text:'KITCHEN',x:.3,y:.3,w:.05,h:.02},{text:'DINING',x:.6,y:.6,w:.05,h:.02}]})
  assert.match(result.proposals[0].label,/KITCHEN \/ DINING/)
  assert.ok(result.proposals[0].warnings.some((w)=>w.includes('Multiple')))
})
test('dense input abstains visibly rather than silently truncating geometry', () => {
  assert.throws(()=>detectAreas(input(Array.from({length:24001},(_,i)=>[.1,.1+i*.00001,.9,.1+i*.00001]).flat())),/smaller region/)
})
test('self-intersecting and nonfinite rings are invalid', () => {
  assert.equal(validRing([[0,0],[1,1],[0,1],[1,0]]),false)
  assert.equal(validRing([[0,0],[NaN,1],[1,0]]),false)
})
test('split conserves area, and merge restores the boundary', () => {
  const parts=splitArea(proposal(outer),[.5,0],[.5,1])
  assert.equal(parts.length,2)
  assert.ok(Math.abs(parts.reduce((s,p)=>s+ringArea(p.points),0)-ringArea(outer))<1e-10)
  const merged=mergeAreas(parts)
  assert.ok(Math.abs(ringArea(merged.points)-ringArea(outer))<1e-10)
})
test('merge rejects disjoint or overlapping selections', () => {
  assert.throws(()=>mergeAreas([proposal(rectangle(.1,.1,.3,.3)),proposal(rectangle(.6,.6,.9,.9))]),/share/)
  assert.throws(()=>mergeAreas([proposal(rectangle(.1,.1,.6,.6)),proposal(rectangle(.4,.4,.9,.9))]),/overlap/)
})
test('overlap detection allows a shared boundary but rejects coincident areas', () => {
  assert.equal(areasOverlap(proposal(rectangle(0,0,.5,1)),proposal(rectangle(.5,0,1,1))),false)
  assert.equal(areasOverlap(proposal(outer),proposal(outer)),true)
})
test('deductions outside, crossing concave boundaries, or overlapping are rejected', () => {
  assert.throws(()=>validateAreaGeometry({...proposal(outer),holes:[rectangle(0,0,.2,.2)]}))
  assert.throws(()=>validateAreaGeometry({...proposal(outer),holes:[rectangle(.2,.2,.5,.5),rectangle(.3,.3,.6,.6)]}))
  const concave=[[.1,.1],[.9,.1],[.9,.9],[.6,.9],[.6,.4],[.4,.4],[.4,.9],[.1,.9]]
  assert.throws(()=>validateAreaGeometry({...proposal(concave),holes:[rectangle(.2,.2,.8,.8)]}))
})
test('acceptance requires explicit review, finite scale and nonoverlapping areas', () => {
  const data={sheet_version_id:'11111111-1111-4111-8111-111111111111',condition_id:'22222222-2222-4222-8222-222222222222',expected_scale:.02,areas:[proposal(outer)],elapsed_ms:100,reviewed:true}
  assert.ok(acceptAreasSchema.safeParse(data).success)
  assert.equal(acceptAreasSchema.safeParse({...data,reviewed:false}).success,false)
  assert.equal(acceptAreasSchema.safeParse({...data,areas:[proposal(outer),proposal(outer)]}).success,false)
  assert.equal(acceptAreasSchema.safeParse({...data,expected_scale:Infinity}).success,false)
})
test('actual PDF extraction preserves curves, layers, clipping and co-registration', async () => {
  const mupdf=await import('mupdf')
  const {PDFDocument,PDFName}=require('pdf-lib')
  const {extractAreaEvidence}=require('../lib/services/area-evidence-extract')
  const doc=await PDFDocument.create();const page=doc.addPage([200,100])
  const stream=doc.context.flateStream('q 0 0 200 100 re W n 2 w 0 0 0 RG 20 10 160 80 re S 30 20 m 40 20 50 30 50 40 c S Q')
  page.node.set(PDFName.of('Contents'),doc.context.register(stream))
  const bytes=await doc.save();const native=mupdf.Document.openDocument(bytes,'application/pdf');const p=native.loadPage(0)
  try {
    const evidence=extractAreaEvidence(mupdf,p,{pageToImageScale:5,imageWidth:1000,imageHeight:500})
    assert.ok(evidence.paths.some((p)=>p.kind==='clip'))
    assert.ok(evidence.paths.some((p)=>p.commands.some((c)=>c[0]==='C')))
    const rectanglePath=evidence.paths.find((p)=>p.kind==='stroke'&&p.commands.length===5)
    assert.ok(rectanglePath.clips.length)
    assert.equal(rectanglePath.width,2)
    assert.deepEqual(rectanglePath.commands[0],['M',.1,.9])
  } finally { p.destroy();native.destroy() }
})
test('decoration cannot exhaust the wall extraction budget and omissions remain explicit', () => {
  const {extractAreaEvidence}=require('../lib/services/area-evidence-extract')
  const {AREA_EXTRACTION_PROFILE}=require('../lib/drawings/area-evidence')
  class Device { constructor(callbacks){this.callbacks=callbacks} close(){} destroy(){} }
  const path={walk(visitor){visitor.moveTo(10,10);visitor.lineTo(90,10)}}
  const page={runPageContents(device){
    const d=device.callbacks,space={getName:()=> 'DeviceGray'},stroke={getLineWidth:()=>1,getDashes:()=>[]},ctm=[1,0,0,1,0,0]
    d.beginLayer('A-FURN');for(let i=0;i<50002;i++)d.strokePath(path,stroke,ctm,space,[0],1);d.endLayer()
    d.beginLayer('A-WALL');d.strokePath(path,stroke,ctm,space,[0],1);d.endLayer()
  }}
  const result=extractAreaEvidence({Device,Matrix:{identity:[1,0,0,1,0,0]}},page,{pageToImageScale:1,imageWidth:100,imageHeight:100})
  assert.equal(result.extractionProfile,AREA_EXTRACTION_PROFILE)
  assert.equal(result.truncated,false)
  assert.equal(result.omittedDecorationPaths,2)
  assert.equal(result.unrepresentedPaint,true)
  assert.deepEqual(result.paths.at(-1).layer,['A-WALL'])
  assert.equal(result.paths.at(-1).id,50000)
})
test('PDF door swing creates a virtual threshold only with aligned jamb evidence', () => {
  const k=.5522847498
  const paths=[
    {commands:[['M',.1,.1],['L',.4,.1]],id:0},
    {commands:[['M',.55,.1],['L',.9,.1],['L',.9,.9],['L',.1,.9],['L',.1,.1]],id:1},
    {commands:[['M',.55,.1],['C',.55,.1+.15*k,.4+.15*k,.25,.4,.25]],id:2},
  ].map((p)=>({...p,kind:'stroke',color:[0],colorSpace:'DeviceGray',opacity:1,width:1,dashes:[],layer:[],groups:[],clips:[],evenOdd:false}))
  const result=detectAreas({...input([]),evidence:{version:1,truncated:false,paths}})
  assert.equal(result.proposals.length,1)
  assert.ok(result.proposals[0].boundary.some((e)=>e.source==='doorway'))
  assert.ok(Math.abs(result.proposals[0].areaSqft-256)<1e-6)
})

// A 16-foot bedroom annotated across both axes, like the user's A4.0 sheet.
const dimTick = (x,y) => [x-.008,y+.008,x+.008,y-.008]
const bedroomDimensions = () => ({
  ...input([...segments(outer),.1,.35,.9,.35,.7,.1,.7,.9,
    ...dimTick(.1,.35),...dimTick(.9,.35),...dimTick(.7,.1),...dimTick(.7,.9)]),
  textRuns:[{text:`16'-0"`,x:.46,y:.325,w:.08,h:.015},{text:`16'-0"`,x:.675,y:.46,w:.015,h:.08}],
})
test('dimension lines across a bedroom do not create four false rooms',()=>{
  const result=detectAreas(bedroomDimensions())
  assert.equal(result.proposals.length,1)
  assert.ok(Math.abs(result.proposals[0].areaSqft-256)<1e-8)
  assert.ok(result.warnings.some(w=>w.includes('Excluded 2 dimension')))
})
test('dimension line interrupted by its label is removed on both sides',()=>{
  const data=bedroomDimensions()
  data.segments=[...segments(outer),.1,.35,.45,.35,.55,.35,.9,.35,...dimTick(.1,.35),...dimTick(.9,.35)]
  data.textRuns=data.textRuns.slice(0,1)
  assert.equal(detectAreas(data).proposals[0].boundary.length,4)
})
test('measurement text near a real partition without marks never removes that partition',()=>{
  const data=bedroomDimensions()
  data.segments=[...segments(outer),.1,.35,.9,.35]
  data.textRuns=data.textRuns.slice(0,1)
  assert.equal(detectAreas(data).proposals.length,2)
})
test('wrong printed span and prose notes cannot classify a wall as a dimension',()=>{
  for(const text of [`8'-0"`,`16'-0" WALL HEIGHT`]) {
    const data=bedroomDimensions()
    data.segments=[...segments(outer),.1,.35,.9,.35,...dimTick(.1,.35),...dimTick(.9,.35)]
    data.textRuns=[{...data.textRuns[0],text}]
    assert.ok(detectAreas(data).proposals.length>=2)
  }
})
test('dimension classification is invariant to rendered image resolution',()=>{
  const data=bedroomDimensions()
  const result=detectAreas({...data,imageWidth:2000,imageHeight:2000,feetPerImagePx:.01})
  assert.equal(result.proposals.length,1)
  assert.ok(Math.abs(result.proposals[0].areaSqft-256)<1e-8)
})
test('dimension ticks and lines batched in a wall PDF path are removed per segment',()=>{
  const data=bedroomDimensions()
  const commands=[]
  for(let i=0;i<data.segments.length;i+=4) commands.push(['M',...data.segments.slice(i,i+2)],['L',...data.segments.slice(i+2,i+4)])
  data.evidence={version:1,truncated:false,paths:[{id:0,commands,kind:'stroke',color:[0],colorSpace:'DeviceGray',opacity:1,width:.2,dashes:[],layer:[],groups:[],clips:[],evenOdd:false}]}
  assert.equal(detectAreas(data).proposals.length,1)
  assert.ok(Math.abs(detectAreas(data).proposals[0].areaSqft-256)<1e-8)
})
test('explicit user finish boundaries survive dimension filtering',()=>{
  const data=bedroomDimensions()
  data.boundaries=[{a:[.1,.5],b:[.9,.5],source:'user'}]
  assert.equal(detectAreas(data).proposals.length,2)
})

test('a long real partition survives a label directly over its midpoint',()=>{
  const data=bedroomDimensions()
  data.segments=[...segments(outer),.1,.35,.9,.35]
  data.textRuns=[{...data.textRuns[0],y:.34,h:.02}]
  assert.equal(detectAreas(data).proposals.length,2)
})
test('confirmed witness lines are removed without deleting walls',()=>{
  const data=input([...segments(outer),.3,.35,.7,.35,...dimTick(.3,.35),...dimTick(.7,.35),.3,.1,.3,.37,.7,.1,.7,.37])
  data.textRuns=[{text:`8'-0"`,x:.46,y:.325,w:.08,h:.015}]
  const result=detectAreas(data)
  assert.equal(result.proposals.length,1)
  assert.equal(result.proposals[0].boundary.length,4)
  assert.ok(Math.abs(result.proposals[0].areaSqft-256)<1e-8)
})
test('chained dimensions sharing one baseline remove only the supported intervals',()=>{
  const data=input([...segments(outer),.1,.35,.9,.35,...dimTick(.1,.35),...dimTick(.5,.35),...dimTick(.9,.35)])
  data.textRuns=[{text:`8'-0"`,x:.27,y:.325,w:.06,h:.015},{text:`8'-0"`,x:.67,y:.325,w:.06,h:.015}]
  assert.equal(detectAreas(data).proposals.length,1)
  assert.equal(detectAreas(data).proposals[0].boundary.length,4)
})
test('arrowheads support dimension filtering as well as architectural slashes',()=>{
  const data=input([...segments(outer),.1,.35,.9,.35,
    .1,.35,.12,.34,.1,.35,.12,.36,.9,.35,.88,.34,.9,.35,.88,.36])
  data.textRuns=bedroomDimensions().textRuns.slice(0,1)
  const result=detectAreas(data)
  assert.equal(result.proposals.length,1)
  assert.equal(result.proposals[0].boundary.length,4)
})
test('structural line weight overrides nearby dimension-like ticks',()=>{
  const data=bedroomDimensions()
  data.segments=[...segments(outer),.1,.35,.9,.35,...dimTick(.1,.35),...dimTick(.9,.35)]
  data.textRuns=data.textRuns.slice(0,1)
  data.evidence={version:1,truncated:false,paths:[]}
  for(let i=0;i<data.segments.length;i+=4) data.evidence.paths.push({id:i/4,commands:[['M',...data.segments.slice(i,i+2)],['L',...data.segments.slice(i+2,i+4)]],kind:'stroke',color:[0],colorSpace:'DeviceGray',opacity:1,width:i/4<=4?1:.2,dashes:[],layer:[],groups:[],clips:[],evenOdd:false})
  assert.ok(detectAreas(data).proposals.length>=2)
})

test('actual PDF dimension paths and extracted text preserve the complete bedroom',async()=>{
  const {PDFDocument,StandardFonts,rgb}=require('pdf-lib')
  const mupdf=await import('mupdf')
  const {extractAreaEvidence}=require('../lib/services/area-evidence-extract')
  const doc=await PDFDocument.create(),page=doc.addPage([1000,1000])
  page.drawRectangle({x:100,y:100,width:800,height:800,borderWidth:1,borderColor:rgb(0,0,0)})
  const line=(x,y,a,b)=>page.drawLine({start:{x,y},end:{x:a,y:b},thickness:.2,color:rgb(0,0,0)})
  line(100,650,900,650);line(92,642,108,658);line(892,642,908,658)
  const font=await doc.embedFont(StandardFonts.Helvetica),label=`16'-0"`,size=15
  page.drawText(label,{x:500-font.widthOfTextAtSize(label,size)/2,y:660,size,font})
  const pdf=mupdf.Document.openDocument(await doc.save(),'application/pdf'),source=pdf.loadPage(0)
  try {
    const evidence=extractAreaEvidence(mupdf,source,{pageToImageScale:1,imageWidth:1000,imageHeight:1000})
    const structured=source.toStructuredText('preserve-whitespace')
    let textRuns
    try {textRuns=JSON.parse(structured.asJSON()).blocks.flatMap(b=>(b.lines??[]).map(l=>({text:l.text,x:l.bbox.x/1000,y:l.bbox.y/1000,w:l.bbox.w/1000,h:l.bbox.h/1000})))} finally {structured.destroy()}
    const result=detectAreas({...input([]),evidence,textRuns})
    assert.equal(result.proposals.length,1)
    assert.ok(Math.abs(result.proposals[0].areaSqft-256)<1e-8)
    assert.ok(result.warnings.some(w=>w.includes('Excluded 1 dimension')))
  } finally {source.destroy();pdf.destroy()}
})

test('dimensions near room corners must not erase connected perpendicular walls',()=>{
  const data=input([...segments(outer),.1,.12,.9,.12,...dimTick(.1,.12),...dimTick(.9,.12)])
  data.textRuns=[{text:`16'-0"`,x:.46,y:.125,w:.08,h:.015}]
  const result=detectAreas(data)
  assert.equal(result.proposals.length,1)
  assert.ok(Math.abs(result.proposals[0].areaSqft-256)<1e-8)
})
test('after removing dimensions a door threshold can meet a perpendicular return wall',()=>{
  const k=.5522847498, data=bedroomDimensions()
  const raw=[
    [['M',.1,.1],['L',.75,.1]],
    [['M',.9,.1],['L',.9,.9],['L',.1,.9],['L',.1,.1]],
    [['M',.75,.1],['L',.75,.25]],
    [['M',.9,.1],['C',.9,.1+.15*k,.75+.15*k,.25,.75,.25]],
    [['M',.1,.35],['L',.9,.35]],
    [['M',.092,.358],['L',.108,.342]],
    [['M',.892,.358],['L',.908,.342]],
  ]
  data.evidence={version:1,truncated:false,paths:raw.map((commands,id)=>({id,commands,kind:'stroke',color:[0],colorSpace:'DeviceGray',opacity:1,width:.2,dashes:[],layer:[],groups:[],clips:[],evenOdd:false}))}
  data.textRuns=data.textRuns.slice(0,1)
  const result=detectAreas(data)
  assert.equal(result.proposals.length,1)
  assert.ok(Math.abs(result.proposals[0].areaSqft-256)<1e-6)
  assert.ok(result.proposals[0].boundary.some(e=>e.source==='doorway'))
})

test('CAD DIM layers and multi-cubic door swings do not split or open rooms',()=>{
  const data=input([]), k=Math.tan(Math.PI/16)*4/3, r=.15, cx=.75,cy=.1
  const p0=[cx+r,cy],p1=[cx+r/Math.sqrt(2),cy+r/Math.sqrt(2)],p2=[cx,cy+r]
  const raw=[
    {layer:'A_WALL',commands:[['M',.1,.1],['L',.75,.1]]},
    {layer:'A_WALL',commands:[['M',.9,.1],['L',.9,.9],['L',.1,.9],['L',.1,.1]]},
    {layer:'A_DOOR',commands:[['M',cx,cy],['L',...p2]]},
    {layer:'A_DOOR',commands:[['M',...p0],['C',p0[0],p0[1]+k*r,p1[0]+k*r/Math.sqrt(2),p1[1]-k*r/Math.sqrt(2),...p1],['C',p1[0]-k*r/Math.sqrt(2),p1[1]+k*r/Math.sqrt(2),p2[0]+k*r,p2[1],...p2]]},
    // No positioned text is needed when the CAD layer identifies dimensions.
    {layer:'A_DIM_FLR',commands:[['M',.1,.35],['L',.9,.35],['M',.7,.1],['L',.7,.9]]},
    {layer:'A_CLG_FLR',commands:[['M',.1,.6],['L',.9,.6]]},
    {layer:'A_MIL',commands:[['M',.1,.7],['L',.9,.7]]},
  ]
  data.evidence={version:1,truncated:false,paths:raw.map((p,id)=>({...p,id,layer:[p.layer],kind:'stroke',color:[0],colorSpace:'DeviceGray',opacity:1,width:.2,dashes:[],groups:[],clips:[],evenOdd:false}))}
  const result=detectAreas(data)
  assert.equal(result.proposals.length,1)
  assert.ok(Math.abs(result.proposals[0].areaSqft-256)<1e-6)
  assert.ok(result.proposals[0].boundary.some(e=>e.source==='doorway'))
})

test('Burke page 4 source and pipeline page copy recover rooms without dimension subdivisions',{
  skip:!process.env.ARC_BURKE_PDF,
},async()=>{
  const fs=require('node:fs'),mupdf=await import('mupdf')
  const {extractAreaEvidence}=require('../lib/services/area-evidence-extract')
  const original=mupdf.Document.openDocument(fs.readFileSync(process.env.ARC_BURKE_PDF),'application/pdf')
  const copy=new mupdf.PDFDocument();copy.graftPage(0,original,3)
  const reopened=mupdf.Document.openDocument(copy.saveToBuffer('compress').asUint8Array(),'application/pdf')
  const read=(doc,pageIndex)=>{
    const page=doc.loadPage(pageIndex),[x,y,x1,y1]=page.getBounds(),width=x1-x,height=y1-y
    try {
      const evidence=extractAreaEvidence(mupdf,page,{pageToImageScale:1,imageWidth:width,imageHeight:height,pageOriginX:x,pageOriginY:y})
      const st=page.toStructuredText('preserve-whitespace')
      let textRuns
      try {textRuns=JSON.parse(st.asJSON()).blocks.flatMap(b=>(b.lines??[]).map(l=>({text:l.text,x:(l.bbox.x-x)/width,y:(l.bbox.y-y)/height,w:l.bbox.w/width,h:l.bbox.h/height})))} finally {st.destroy()}
      return {segments:[],evidence,textRuns,imageWidth:width,imageHeight:height,feetPerImagePx:4/72,region:{x0:.34,y0:.24,x1:.51,y1:.64}}
    } finally {page.destroy()}
  }
  try {
    const a=read(original,3),b=read(reopened,0)
    assert.deepEqual(b.evidence,a.evidence,'pipeline split must retain original path/layer evidence')
    assert.deepEqual(b.textRuns,a.textRuns,'pipeline split must retain positioned text')
    assert.ok(a.evidence.paths.some(p=>p.layer.includes('A_DIM_FLR')))
    const result=detectAreas(b)
    for(const label of ['BEDROOM 2','BEDROOM 3']) {
      const rooms=result.proposals.filter(p=>p.label===label)
      assert.equal(rooms.length,1)
      // Regression bounds, not independently certified estimating quantities.
      assert.ok(rooms[0].areaSqft>110&&rooms[0].areaSqft<125)
      assert.ok(rooms[0].boundary.some(e=>e.source==='doorway'))
      assert.ok(rooms[0].boundary.every(e=>!b.evidence.paths[e.pathId]?.layer.includes('A_DIM_FLR')))
    }
    assert.equal(result.proposals.filter(p=>p.label==='CLOSET').length,2)
    assert.ok(result.proposals.some(p=>p.label==='BATH 2'))
  } finally {reopened.destroy();copy.destroy();original.destroy()}
})

test('clipped long walls remain usable without manufacturing crop boundaries',()=>{
  const lines=[.1,0,.1,1,.9,0,.9,1,.1,.3,.9,.3,.1,.7,.9,.7]
  const result=detectAreas({...input(lines),region:{x0:.05,y0:.2,x1:.95,y1:.8}})
  assert.equal(result.proposals.length,1)
  assert.ok(Math.abs(result.proposals[0].areaSqft-128)<1e-8)
})
test('an attached interior loop does not discard its enclosing room',()=>{
  const result=detectAreas(input([...segments(outer),...segments(rectangle(.4,.4,.5,.5)),.1,.45,.4,.45]))
  assert.ok(result.proposals.some(p=>Math.abs(p.areaSqft-252)<1e-8))
})
test('whole-sheet detection separates two floor plans and excludes annotation labels',()=>{
  const {detectSheetAreas}=require('../lib/drawings/area-sheet')
  const {areaRoomLabel}=require('../lib/drawings/area-labels')
  assert.equal(areaRoomLabel('GARAGE DOOR OPENER'),null)
  assert.equal(areaRoomLabel('SELECTED BY OWNER'),null)
  const data=input([...segments(rectangle(.1,.1,.3,.3)),...segments(rectangle(.6,.6,.8,.8))])
  data.textRuns=[{text:'BEDROOM 1',x:.16,y:.18,w:.06,h:.02},{text:'OFFICE',x:.66,y:.68,w:.06,h:.02}]
  const result=detectSheetAreas(data)
  assert.equal(result.proposals.length,2)
  assert.ok(result.proposals.every(p=>Math.abs(p.areaSqft-16)<1e-8))
  assert.equal(new Set(result.proposals.map(p=>p.id)).size,2)
})
test('whole-sheet scans without vector room evidence abstain explicitly',()=>{
  const {detectSheetAreas}=require('../lib/drawings/area-sheet')
  const result=detectSheetAreas(input([]))
  assert.equal(result.proposals.length,0)
  assert.ok(result.warnings.some(w=>w.includes('image proposal')))
})
test('rerunning detection keeps edited split zones and suppresses overlapping replacements',()=>{
  const {reconcileAreaProposals}=require('../lib/drawings/area-review')
  const original=proposal(outer),edited={...proposal(rectangle(.1,.1,.5,.9)),edited:true,id:'edit'}
  const result=reconcileAreaProposals([edited],[original])
  assert.deepEqual(result.proposals,[edited]);assert.equal(result.suppressed,1)
  assert.equal(reconcileAreaProposals([original],[original]).preserved,0)
})
test('whole-sheet Burke recovers the master suite and connected open-plan zone', {skip:!process.env.ARC_BURKE_PDF},async()=>{
  const {execFileSync}=require('node:child_process'),fs=require('node:fs'),os=require('node:os'),path=require('node:path')
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arc-whole-'))
  try {
    const target=path.join(dir,'fixture.json')
    execFileSync(process.execPath,['scripts/import-area-pdf.js',process.env.ARC_BURKE_PDF,'4',String(4/72),target])
    const fixture=JSON.parse(fs.readFileSync(target,'utf8'))
    const result=require('../lib/drawings/area-sheet').detectSheetAreas(fixture.input)
    for(const name of ['BEDROOM 2','BEDROOM 3','MASTER BEDROOM','MASTER BATH','GREAT ROOM','KITCHEN','DINING'])assert.ok(result.proposals.some(p=>p.label.includes(name)),name)
    assert.ok(result.proposals.every(p=>!p.label.includes('OPENER')))
    for(let i=0;i<result.proposals.length;i++)for(let j=0;j<i;j++)assert.equal(areasOverlap(result.proposals[i],result.proposals[j]),false)
  } finally {fs.rmSync(dir,{recursive:true,force:true})}
})

test('revision comparison distinguishes changed, unchanged and missing evidence',()=>{
 const {compareAreaRevision}=require('../lib/drawings/area-revision')
 const path={id:1,commands:[['M',.1,.1],['L',.9,.1]],kind:'stroke',color:[0],colorSpace:'DeviceGray',opacity:1,width:1,dashes:[],layer:['A_WALL'],groups:[],clips:[],evenOdd:false}
 const source={evidence:{version:1,truncated:false,unrepresentedPaint:false,paths:[path]},textRuns:[],width:1000,height:1000,scale:.02}
 assert.equal(compareAreaRevision(source,structuredClone(source),outer),'unchanged')
 const changed=structuredClone(source);changed.evidence.paths[0].commands[1][1]=.85
 assert.equal(compareAreaRevision(source,changed,outer),'changed')
 assert.equal(compareAreaRevision(source,{...source,scale:.03},outer),'changed')
 assert.equal(compareAreaRevision(source,null,outer),'unavailable')
 assert.equal(compareAreaRevision({...source,evidence:{...source.evidence,paths:[]}},{...source,evidence:{...source.evidence,paths:[]}},outer),'unavailable')
 const movedText={...source,textRuns:[{text:'NEW FINISH',x:.3,y:.3,w:.2,h:.02}]}
 assert.equal(compareAreaRevision(source,movedText,outer),'changed')
 for(const flag of [undefined,true])assert.equal(compareAreaRevision(source,{...source,evidence:{...source.evidence,unrepresentedPaint:flag}},outer),'unavailable')
 const grouped=structuredClone(source);grouped.evidence.paths[0].groups=[1]
 assert.equal(compareAreaRevision(source,grouped,outer),'unavailable')
})

test('whole-sheet detection excludes a plan whose dimension chains disagree with scale',()=>{
 const {detectSheetAreas}=require('../lib/drawings/area-sheet')
 const data={...input([...segments(rectangle(.1,.1,.3,.3)),...segments(rectangle(.6,.6,.8,.8))]),imageWidth:10000,imageHeight:10000}
 data.textRuns=[{text:'BEDROOM',x:.19,y:.19,w:.01,h:.005},{text:'OFFICE',x:.69,y:.69,w:.01,h:.005}]
 for(let i=0;i<4;i++)data.textRuns.push({text:`4'-0"`,x:.62+i*.04,y:.64,w:.006,h:.003})
 const result=detectSheetAreas(data)
 assert.ok(result.proposals.some(p=>p.label==='BEDROOM'))
 assert.ok(!result.proposals.some(p=>p.label==='OFFICE'))
 assert.ok(result.warnings.some(w=>w.includes('scale')))
})

test('sliding thresholds require explicit panels, wall faces and both jambs',()=>{
 const {slidingDoorThresholds}=require('../lib/drawings/area-doorways')
 const edge=(a,b,pathId)=>({a,b,pathId,source:'drawn'})
 const walls=[edge([0,0],[4,0],1),edge([7,0],[10,0],1),edge([4,0],[4,.33],1),edge([7,0],[7,.33],1)]
 const panel=edge([4,.2],[6,.2],2)
 const evidence={paths:[{id:1,layer:['A_WALL']},{id:2,layer:['A_DOOR']}]}
 assert.equal(slidingDoorThresholds([...walls,panel],evidence).length,1)
 assert.equal(slidingDoorThresholds(walls,evidence).length,0)
 assert.equal(slidingDoorThresholds([...walls.slice(0,3),panel],evidence).length,0)
 assert.equal(slidingDoorThresholds([...walls,edge([4,2],[6,2],2)],evidence).length,0)
 assert.equal(slidingDoorThresholds([...walls,panel,edge([4,0],[7,0],1)],evidence).length,0)
 assert.equal(slidingDoorThresholds([...walls,panel],{paths:[{id:1,layer:['A_WALL']},{id:2,layer:['A_DOOR_IDEN']}]}).length,0)
})

test('coverage reports missing labels, shared zones and labels inside deductions',()=>{
 const {assessAreaCoverage}=require('../lib/drawings/area-coverage')
 const runs=[{text:'BEDROOM',x:.2,y:.2,w:.02,h:.02},{text:'CLOSET',x:.3,y:.3,w:.02,h:.02},{text:'BATH',x:.6,y:.6,w:.02,h:.02},{text:'OFFICE',x:.95,y:.95,w:.01,h:.01}]
 const area={...proposal(outer),holes:[rectangle(.55,.55,.7,.7)]}
 const result=assessAreaCoverage(runs,[area])
 assert.deepEqual(result.labels.map(l=>l.status),['shared-zone','shared-zone','unresolved','unresolved'])
 const conflict=assessAreaCoverage(runs,[area,{...area,id:'duplicate'}])
 assert.ok(conflict.labels.every(l=>l.status==='unresolved'))
})

test('fixture policy changes fixture outlines without deleting structural walls',()=>{
 const style={kind:'stroke',color:[0],colorSpace:'DeviceGray',opacity:1,width:1,dashes:[],groups:[],clips:[],evenOdd:false}
 const commands=r=>[['M',...r[0]],...r.slice(1).map(p=>['L',...p]),['Z']]
 const data={...input([]),evidence:{version:1,truncated:false,paths:[{...style,id:0,layer:['A_WALL'],commands:commands(outer)},{...style,id:1,layer:['A_PLUMB'],commands:commands(rectangle(.4,.4,.5,.5))}]},textRuns:[{text:'BATH',x:.2,y:.2,w:.05,h:.02}]}
 const drawn=detectAreas(data),included=detectAreas({...data,finishPolicy:'include-fixtures'})
 assert.equal(drawn.proposals[0].holes.length,1);assert.equal(included.proposals[0].holes.length,0)
 assert.ok(Math.abs(included.proposals[0].areaSqft-256)<1e-8)
 assert.equal(included.proposals[0].finishPolicy,'include-fixtures')
 for(const alias of ['A_PFIX','A_PLUMBING','A_FIXTURES']){
  data.evidence.paths[1].layer=[alias]
  assert.equal(detectAreas(data).proposals[0].holes.length,1)
  assert.equal(detectAreas({...data,finishPolicy:'include-fixtures'}).proposals[0].holes.length,0)
 }
 data.evidence.paths[1].layer=['A_WALL','A_PLUMB']
 assert.equal(detectAreas({...data,finishPolicy:'include-fixtures'}).proposals[0].holes.length,1)
})

test('fractional architectural dimensions retain their full calibrated value',()=>{
 const {parseFeetInches}=require('../lib/validation/drawings')
 const {extractDimensionTokens}=require('../lib/drawings/scale')
 for(const [text,expected] of [[`5'-6 1/2"`,5+6.5/12],[`5 1/2"`,5.5/12],[`1/2"`,.5/12],[`5′6½″`,5+6.5/12],[`24 ft 6 in`,24.5]])assert.ok(Math.abs(parseFeetInches(text)-expected)<1e-10,text)
 for(const text of [`5'-1/0"`,`6-8"`,'0','negative 5'])assert.equal(parseFeetInches(text),null)
 const tokens=extractDimensionTokens(`12' 8' 5'-6 1/2"`,{x0:0,y0:0,x1:240,y1:20})
 assert.deepEqual(tokens.map(t=>parseFeetInches(t.text)),[12,8,5+6.5/12])
})
test('dimension-only hyphen notation still requires tick and physical-span evidence',()=>{
 const data=bedroomDimensions();data.textRuns=data.textRuns.map(t=>({...t,text:'16-0"'}))
 assert.equal(detectAreas(data).proposals.length,1)
 data.textRuns=data.textRuns.map(t=>({...t,text:'6-8"'}))
 assert.equal(detectAreas(data).proposals.length,4,'a plausible-looking OCR string cannot erase a mismatched boundary')
})

test('PDF filled subpaths close implicitly while stroked open paths remain open',()=>{
 const {flattenEvidencePath}=require('../lib/drawings/area-evidence')
 const commands=[['M',.1,.1],['L',.9,.1],['L',.9,.9],['L',.1,.9]]
 assert.deepEqual(flattenEvidencePath({commands,kind:'fill'})[0].at(-1),[.1,.1])
 assert.deepEqual(flattenEvidencePath({commands,kind:'stroke'})[0].at(-1),[.1,.9])
})

test('annotation filtering preserves unrelated short finish returns',()=>{
 const {filterAreaDimensions}=require('../lib/drawings/area-dimensions')
 const tiny={a:[1,1],b:[1,1.04],source:'drawn'}
 assert.deepEqual(filterAreaDimensions([tiny],[],20,20).edges,[tiny])
 const data=input(segments([[.1,.1],[.5,.1],[.5,.102],[.9,.102],[.9,.9],[.1,.9]]))
 data.textRuns=[{text:'OFFICE',x:.4,y:.4,w:.08,h:.02}]
 const detected=detectAreas(data)
 assert.equal(detected.proposals.length,1)
 assert.ok(Math.abs(detected.proposals[0].areaSqft-255.68)<1e-7)
})
test('CAD classification protects structure and excludes floor/landscape/annotation patterns',()=>{
 const {areaPathRole}=require('../lib/drawings/area-paths')
 for(const layer of ['A - WALL - INTERIOR','A - WALL - EXTERIOR','A-FLOOR-WALL','A-DOOR','A-COLUMN'])assert.equal(areaPathRole({layer:[layer]}),'structure',layer)
 for(const layer of ['L - DRIVEWAY','A - FLOOR','A - ANNO - KEYNOTE','A-WALL-HATCH','A - WOODWORK','A - KITCHEN'])assert.equal(areaPathRole({layer:[layer]}),'decoration',layer)
 assert.equal(areaPathRole({layer:[]}),'unknown')
 assert.equal(areaPathRole({layer:['A - BATH FIXTURE']}),'fixture')
 const data=input([]),base={kind:'stroke',color:[0],colorSpace:'DeviceGray',opacity:1,width:.2,dashes:[],groups:[],clips:[],evenOdd:false}
 data.evidence={version:1,truncated:false,paths:[{...base,id:0,layer:['A-WALL'],commands:[['M',.1,.1],['L',.9,.1],['L',.9,.9],['L',.1,.9],['Z']]},...Array.from({length:100},(_,i)=>({...base,id:i+1,layer:['A - FLOOR'],commands:[['M',.1,.11+i*.007],['L',.9,.11+i*.007]]}))]}
 data.textRuns=[{text:'OFFICE',x:.4,y:.4,w:.08,h:.02}]
 const detected=detectAreas(data)
 assert.equal(detected.proposals.length,1)
 assert.equal(detected.proposals[0].areaSqft,256)
})
test('standalone numbered closet and powder abbreviations are recognized without keynote prose',()=>{
 const {areaRoomLabel}=require('../lib/drawings/area-labels')
 assert.equal(areaRoomLabel('CL 2'),'CLOSET 2')
 assert.equal(areaRoomLabel('CL. 3'),'CLOSET 3')
 assert.equal(areaRoomLabel('PWDR'),'POWDER')
 assert.equal(areaRoomLabel('CL 2 SHELVING BY OWNER'),null)
})
test('Tornincaso original PDF recovers bedrooms, office, closets and powder without decorative subdivisions',{skip:!process.env.ARC_TORNINCASO_PDF},()=>{
 const {execFileSync}=require('node:child_process'),fs=require('node:fs'),os=require('node:os'),path=require('node:path')
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arc-torn-test-'))
 try {
  const target=path.join(dir,'fixture.json')
  execFileSync(process.execPath,['scripts/import-area-pdf.js',process.env.ARC_TORNINCASO_PDF,'4',String(4/72),target])
  const {input}=JSON.parse(fs.readFileSync(target,'utf8'))
  const result=require('../lib/drawings/area-sheet').detectSheetAreas(input)
  for(const name of ['BEDROOM 1','BEDROOM 2','BEDROOM 3','OFFICE','CLOSET 2','CLOSET 3','POWDER','PANTRY','LAUNDRY'])assert.equal(result.proposals.filter(p=>p.label===name).length,1,name)
  for(const p of result.proposals)validateAreaGeometry(p)
  const office=result.proposals.find(p=>p.label==='OFFICE')
  assert.ok(office.areaSqft>130&&office.areaSqft<155,'broad regression bounds, not ground truth')
  const outdoor=result.proposals.find(p=>p.label==='OUTDOOR LIVING / OUTDOOR KITCHEN')
  assert.ok(outdoor?.warnings.some(w=>/exterior floor outline/.test(w)))
  assert.equal(result.coverage.labels.filter(l=>l.status==='unresolved').length,0)
  assert.ok(Math.abs(result.proposals.find(p=>p.label==='CLOSET').areaSqft-129.37375)<.01,'exterior recovery must not cut interiors along floor/cabinet fills')
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
})

test('deductions may share edges but overlapping or duplicate interiors are rejected',()=>{
 const a=rectangle(.2,.2,.3,.3),b=rectangle(.3,.2,.4,.3)
 assert.doesNotThrow(()=>validateAreaGeometry({...proposal(outer),holes:[a,b]}))
 assert.throws(()=>validateAreaGeometry({...proposal(outer),holes:[a,a]}),/overlap/)
 assert.throws(()=>validateAreaGeometry({...proposal(outer),holes:[a,rectangle(.25,.2,.4,.3)]}),/overlap/)
})
test('whole-sheet structural enclosures do not require room tags',()=>{
 const data=input([]),base={kind:'stroke',color:[0],colorSpace:'DeviceGray',opacity:1,width:.2,dashes:[],groups:[],clips:[],evenOdd:false,layer:['A-WALL']}
 const rings=[rectangle(.1,.1,.4,.4),rectangle(.08,.08,.42,.42),rectangle(.6,.6,.9,.9),rectangle(.58,.58,.92,.92)]
 data.evidence={version:1,truncated:false,paths:rings.flatMap(r=>r.map((a,i)=>({...base,id:rings.indexOf(r)*4+i,commands:[['M',...a],['L',...r[(i+1)%r.length]]]})))}
 const result=require('../lib/drawings/area-sheet').detectSheetAreas(data)
 assert.equal(result.proposals.length,2)
 assert.ok(result.proposals.every(p=>Math.abs(p.areaSqft-36)<1e-7))
 assert.ok(result.warnings.some(w=>/Unlabeled enclosures/.test(w)))
 assert.equal(new Set(result.proposals.map(p=>p.label)).size,2)
})
test('room quantities survive rotation, rendering resolution and fragmented finish returns',()=>{
 for(const degrees of [0,15,30,45,75,90])for(const pixels of [1000,3000]) {
  const angle=degrees*Math.PI/180,rotate=([x,y])=>[.5+(x-.5)*Math.cos(angle)-(y-.5)*Math.sin(angle),.5+(x-.5)*Math.sin(angle)+(y-.5)*Math.cos(angle)]
  const ring=[[.2,.2],[.499,.2],[.5,.2],[.8,.2],[.8,.8],[.2,.8]].map(rotate)
  const data={...input(segments(ring)),imageWidth:pixels,imageHeight:pixels,feetPerImagePx:20/pixels,textRuns:[{text:'OFFICE',x:.48,y:.48,w:.04,h:.02}]}
  const r=detectAreas(data)
  assert.equal(r.proposals.length,1,`${degrees}° at ${pixels}px`)
  assert.ok(Math.abs(r.proposals[0].areaSqft-144)<1e-6)
 }
})

test('Tornincaso dimensioned sheet detects unlabeled structural enclosures without furniture subdivisions',{skip:!process.env.ARC_TORNINCASO_PDF},()=>{
 const {execFileSync}=require('node:child_process'),fs=require('node:fs'),os=require('node:os'),path=require('node:path')
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arc-torn-dimensions-'))
 try {
  const target=path.join(dir,'fixture.json')
  execFileSync(process.execPath,['scripts/import-area-pdf.js',process.env.ARC_TORNINCASO_PDF,'5',String(4/72),target])
  const fixture=JSON.parse(fs.readFileSync(target,'utf8'))
  assert.match(fixture.source.sha256,/^[a-f0-9]{64}$/)
  assert.equal(fixture.detectionMode,'whole-sheet')
  const result=require('../lib/drawings/area-sheet').detectSheetAreas(fixture.input)
  assert.equal(result.coverage.labels.length,0)
  assert.ok(result.proposals.length>=10&&result.proposals.length<=25,'substantial rooms rather than hundreds of furniture/pattern faces')
  assert.ok(result.proposals.some(p=>p.areaSqft>140&&p.areaSqft<143),'office consistency across differently annotated sheets; not independent ground truth')
  for(let i=0;i<result.proposals.length;i++) {
   validateAreaGeometry(result.proposals[i])
   for(let j=0;j<i;j++)assert.equal(areasOverlap(result.proposals[i],result.proposals[j]),false)
  }
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
})

test('aligned multi-line room tags preserve outdoor context without merging notes',()=>{
 const {areaTextRuns,areaRoomLabel}=require('../lib/drawings/area-labels')
 const runs=[{text:'OUTDOOR',x:.4,y:.3,w:.02,h:.008},{text:'LIVING',x:.402,y:.306,w:.016,h:.008},{text:'LIVING',x:.6,y:.5,w:.02,h:.008}]
 const normalized=areaTextRuns(runs)
 assert.equal(normalized.length,2)
 assert.equal(normalized[0].text,'OUTDOOR LIVING')
 assert.equal(areaRoomLabel(normalized[0].text),'OUTDOOR LIVING')
 assert.equal(normalized[1].text,'LIVING')
 assert.deepEqual(areaTextRuns(normalized),normalized)
 assert.equal(areaTextRuns([{...runs[0],text:'OUTDOOR COUNTER BY OWNER'},runs[1]]).length,2)
 assert.equal(areaTextRuns([runs[0],{...runs[1],y:.4}]).length,2)
})

test('exterior floor fills recover a finish zone and its pool void without admitting hatch strokes',()=>{
 const base={kind:'fill',color:[1],colorSpace:'DeviceGray',opacity:1,width:0,dashes:[],groups:[],clips:[],evenOdd:true,layer:['A-FLOOR']}
 const commands=r=>[['M',...r[0]],...r.slice(1).map(p=>['L',...p]),['Z']]
 const pool=rectangle(.2,.2,.4,.8)
 const data={...input([]),textRuns:[{text:'OUTDOOR LIVING',x:.6,y:.4,w:.08,h:.02}],evidence:{version:1,truncated:false,paths:[{...base,id:0,commands:[...commands(outer),...commands(pool)]},{...base,id:1,kind:'stroke',commands:[['M',.5,.1],['L',.5,.9]]}]}}
 const result=detectAreas(data),area=result.proposals.find(p=>p.label==='OUTDOOR LIVING')
 assert.ok(area);assert.equal(area.holes.length,1)
 assert.ok(Math.abs(area.areaSqft-208)<1e-8)
 assert.ok(area.warnings.some(w=>/exterior floor outline/.test(w)))
 assert.equal(area.boundary.some(e=>e.pathId===1),false)
 const whole=require('../lib/drawings/area-sheet').detectSheetAreas(data)
 assert.equal(whole.coverage.labels[0].status,'covered')
 // Interior cabinetry/floor fills and unsupported decorative layers stay out.
 for(const text of ['CLOSET','KITCHEN','OFFICE'])assert.equal(detectAreas({...data,textRuns:[{...data.textRuns[0],text}]}).proposals.length,0)
 for(const layer of ['A-FLOOR-HATCH','A-FLOOR-ANNOTATION'])assert.equal(detectAreas({...data,evidence:{...data.evidence,paths:[{...data.evidence.paths[0],layer:[layer]}]}}).proposals.length,0)
 const {exteriorFloorPathIds}=require('../lib/drawings/area-takeoff')
 assert.equal(exteriorFloorPathIds({...data,textRuns:[...data.textRuns,{text:'BEDROOM',x:.5,y:.5,w:.05,h:.02}]}).size,0,'a fill spanning indoor and outdoor tags is ambiguous')
 assert.equal(exteriorFloorPathIds({...data,textRuns:[{text:'OUTDOOR LIVING',x:.25,y:.4,w:.05,h:.02}]}).size,0,'a tag inside a pool void does not support the floor')
 const solidNested={...data,evidence:{...data.evidence,paths:[{...data.evidence.paths[0],evenOdd:false}]}}
 assert.equal(exteriorFloorPathIds(solidNested).size,0,'same-winding nonzero loops are not pool voids')
 const masked={...data,evidence:{...data.evidence,paths:[{...data.evidence.paths[0],clips:[999]}]}}
 assert.equal(detectAreas(masked).proposals.length,0,'unsupported clips cannot become finish outlines')
})

test('generic room and corridor tags contribute coverage without matching keynote prose',()=>{
 const {areaRoomLabel}=require('../lib/drawings/area-labels')
 assert.equal(areaRoomLabel('Room'),'ROOM');assert.equal(areaRoomLabel('CORRIDOR 102A'),'CORRIDOR 102A')
 assert.equal(areaRoomLabel('ROOM FINISH SCHEDULE'),null);assert.equal(areaRoomLabel('CORRIDOR WALL BY OWNER'),null)
})
test('path search bounds include cubic control hulls and preserve paths enclosing a region',()=>{
 const {evidencePathBounds}=require('../lib/drawings/area-evidence')
 assert.deepEqual(evidencePathBounds({commands:[['M',.1,.2],['C',.9,-.1,.8,1.1,.1,.8],['Z']]}),{x0:.1,y0:-.1,x1:.9,y1:1.1})
 assert.equal(evidencePathBounds({commands:[]}),null)
})

test('unlayered connected solid wall fills support whole-sheet detection at different rotations',()=>{
 const {geometricStructureIds}=require('../lib/drawings/area-structure')
 const {detectSheetAreas}=require('../lib/drawings/area-sheet')
 for(const angle of [0,.3,.7]){
  const rotate=([x,y])=>[.5+(x-.5)*Math.cos(angle)-(y-.5)*Math.sin(angle),.5+(x-.5)*Math.sin(angle)+(y-.5)*Math.cos(angle)]
  const rings=[rectangle(.2,.2,.8,.225),rectangle(.2,.775,.8,.8),rectangle(.2,.225,.225,.775),rectangle(.775,.225,.8,.775)]
  const paths=rings.map((r,id)=>{r=r.map(rotate);return {id,kind:'fill',layer:[],color:[.5],colorSpace:'DeviceGray',opacity:1,width:0,dashes:[],clips:[],groups:[],evenOdd:false,commands:[['M',...r[0]],...r.slice(1).map(p=>['L',...p]),['Z']]}})
  const data={...input([]),evidence:{version:1,truncated:false,paths}}
  assert.equal(geometricStructureIds(data.evidence,20,20).size,4)
  const triangles=paths.flatMap((p,i)=>{const r=p.commands.slice(0,4).map(c=>[c[1],c[2]]);return [[r[0],r[1],r[2]],[r[0],r[2],r[3]]].map((t,j)=>({...p,id:100+i*2+j,commands:[['M',...t[0]],['L',...t[1]],['L',...t[2]],['Z']]}))})
  assert.equal(geometricStructureIds({...data.evidence,paths:triangles},20,20).size,8,'tessellated rectangles retain their original triangle path IDs')
  const triangulated=detectSheetAreas({...data,evidence:{...data.evidence,paths:triangles}})
  assert.equal(triangulated.proposals.length,1)
  assert.ok(Math.abs(triangulated.proposals[0].areaSqft-121)<1e-7)
  const result=detectSheetAreas(data)
  assert.equal(result.proposals.length,1)
  assert.ok(Math.abs(result.proposals[0].areaSqft-121)<1e-7)
  assert.ok(result.proposals[0].warnings.some(w=>/inferred from connected solid fills/.test(w)))
  for(const changed of [paths.slice(0,1),paths.map(p=>({...p,color:[1]})),paths.map(p=>({...p,clips:[999]})),paths.map(p=>({...p,layer:['A-FURNITURE']}))])assert.equal(geometricStructureIds({...data.evidence,paths:changed},20,20).size,0)
 }
})

test('annotation leaders require an arrow, aligned shaft and non-room text',()=>{
 const {annotationLeaderIds}=require('../lib/drawings/area-leaders')
 const base={kind:'stroke',layer:[],color:[0],colorSpace:'DeviceGray',opacity:1,width:.24,dashes:[],clips:[],groups:[],evenOdd:false}
 const arrow={...base,id:1,kind:'fill',commands:[['M',.2,.2],['L',.22,.195],['L',.22,.205],['Z']]}
 const shaft={...base,id:2,commands:[['M',.2,.2],['L',.4,.2]]}
 const wall={...base,id:3,width:1.5,commands:[['M',.2,.1],['L',.2,.5]]}
 const evidence={version:1,truncated:false,paths:[arrow,shaft,wall]},runs=[{text:'BLACKOUT SHADES',x:.405,y:.19,w:.2,h:.02}]
 assert.deepEqual([...annotationLeaderIds(evidence,runs,20,20)].sort(),[1,2])
 assert.equal(annotationLeaderIds(evidence,[],20,20).size,0)
 assert.equal(annotationLeaderIds({...evidence,paths:[shaft,wall]},runs,20,20).size,0)
 assert.equal(annotationLeaderIds({...evidence,paths:evidence.paths.map(p=>({...p,layer:['A-WALL']}))},runs,20,20).size,0)
 assert.equal(annotationLeaderIds({...evidence,paths:evidence.paths.map(p=>({...p,clips:[999]}))},runs,20,20).size,0)
 assert.equal(annotationLeaderIds(evidence,[{...runs[0],text:'BEDROOM'}],20,20).size,0)
})

test('paired semicircular door swings close at their supported hinges without a middle jamb',()=>{
 const base={kind:'stroke',layer:[],color:[0],colorSpace:'DeviceGray',opacity:1,width:1,dashes:[],clips:[],groups:[],evenOdd:false}
 const wall={...base,id:1,commands:[['M',.35,.1],['L',.1,.1],['L',.1,.9],['L',.9,.9],['L',.9,.1],['L',.65,.1]]}
 const swing=(cx,id)=>({...base,id,commands:Array.from({length:25},(_,i)=>[i?'L':'M',cx+.15*Math.cos(Math.PI*i/24),.1+.15*Math.sin(Math.PI*i/24)])})
 const left=swing(.35,2),right=swing(.65,3),data={...input([]),evidence:{version:1,truncated:false,paths:[wall,left,right]}}
 const result=detectAreas(data)
 assert.equal(result.proposals.length,1)
 assert.ok(Math.abs(result.proposals[0].areaSqft-256)<1e-7)
 assert.ok(result.proposals[0].boundary.some(e=>e.source==='doorway'))
 assert.equal(detectAreas({...data,evidence:{...data.evidence,paths:[wall,left]}}).proposals.length,0)
})

test('whole-sheet windows share source annotation interpretation while retaining local geometric inference',()=>{
 const structure=require('../lib/drawings/area-structure'),leaders=require('../lib/drawings/area-leaders')
 const originalStructure=structure.geometricStructureIds,originalLeaders=leaders.annotationLeaderIds
 let structureCalls=0,leaderCalls=0
 structure.geometricStructureIds=(...args)=>{structureCalls++;return originalStructure(...args)}
 leaders.annotationLeaderIds=(...args)=>{leaderCalls++;return originalLeaders(...args)}
 try{
  const {detectSheetAreas}=require('../lib/drawings/area-sheet')
  const data={...input([]),imageWidth:5000,imageHeight:5000,evidence:{version:1,truncated:false,paths:[]},textRuns:[.2,.5,.8].map((x,i)=>({text:'BEDROOM '+i,x,y:x,w:.03,h:.01}))}
  const result=detectSheetAreas(data)
  assert.equal(result.coverage.labels.length,3)
  assert.ok(result.coverage.labels.every(l=>l.status==='unresolved'))
  assert.ok(structureCalls>1,'unqualified global wall inference must not replace local evidence')
  assert.equal(leaderCalls,1)
 }finally{structure.geometricStructureIds=originalStructure;leaders.annotationLeaderIds=originalLeaders}
})


test('duplicate paint does not spend the structural edge budget', () => {
  const result=detectAreas(input(Array.from({length:9000},()=>segments(outer)).flat()))
  assert.equal(result.proposals.length,1)
  assert.equal(result.segmentCount,4)
})

test('closed door symbols are excluded even when a room tag overlaps them', () => {
  const commands=[['M',.2,.2],['L',.4,.2],['L',.4,.4],['L',.2,.4],['Z']]
  const data={...input([]),textRuns:[{text:'BATH',x:.25,y:.25,w:.05,h:.02}],evidence:{version:1,truncated:false,paths:[{id:1,commands,kind:'stroke',layer:['A_DOOR'],opacity:1,width:.2,dashes:[],clips:[],groups:[],color:[0],colorSpace:'DeviceGray',evenOdd:false}]}}
  assert.equal(detectAreas(data).proposals.length,0)
  data.evidence.paths[0].layer=['A_WALL']
  assert.equal(detectAreas(data).proposals.length,1)
})

test('elevation notes cannot exclude a floorplan as a different scale', () => {
  const {detectSheetAreas}=require('../lib/drawings/area-sheet')
  const data={...input(segments(rectangle(.6,.6,.8,.8))),imageWidth:10000,imageHeight:10000}
  data.textRuns=[{text:'OFFICE',x:.69,y:.69,w:.01,h:.005}]
  for(let i=0;i<4;i++)data.textRuns.push({text:`4'-0" NAVD`,x:.62+i*.04,y:.64,w:.006,h:.003})
  const result=detectSheetAreas(data)
  assert.ok(result.proposals.some(p=>p.label==='OFFICE'))
  assert.ok(!result.warnings.some(w=>w.includes('calibrated scale')))
})

test('swing-supported jamb closures require a CAD door arc and both wall returns', () => {
  const {slidingDoorThresholds}=require('../lib/drawings/area-doorways')
  const edge=(a,b,pathId=1)=>({a,b,pathId,source:'drawn'})
  const walls=[edge([0,0],[4,0]),edge([7,0],[10,0]),edge([4,0],[4,.33]),edge([7,0],[7,.33])]
  const evidence={paths:[{id:1,layer:['A_WALL']},{id:2,layer:['A_DOOR']}]}
  const swing={pathId:2,center:[4,.2],ends:[[7,.2],[4,3.2]]}
  assert.equal(slidingDoorThresholds(walls,evidence,[swing]).length,1)
  assert.equal(slidingDoorThresholds(walls,evidence,[{...swing,pathId:3}]).length,0)
  assert.equal(slidingDoorThresholds(walls.slice(0,3),evidence,[swing]).length,0)
  assert.equal(slidingDoorThresholds(walls,evidence,[{...swing,center:[4,1]}]).length,0)
})

test('parked pocket leaves require paired panel faces bracketed by wall pockets', () => {
  const {slidingDoorThresholds}=require('../lib/drawings/area-doorways')
  const edge=(a,b,pathId=1)=>({a,b,pathId,source:'drawn'})
  const walls=[edge([0,0],[4,0]),edge([7,0],[10,0]),edge([4,0],[4,.3]),edge([7,0],[7,.3]),edge([0,.3],[4,.3])]
  const panels=[edge([1.5,.1],[4.5,.1],2),edge([1.5,.2],[4.5,.2],2)]
  const evidence={paths:[{id:1,layer:['A_WALL']},{id:2,layer:['A_DOOR']}]}
  assert.ok(slidingDoorThresholds([...walls,...panels],evidence).some(e=>Math.abs(Math.hypot(e.b[0]-e.a[0],e.b[1]-e.a[1])-3)<1e-8))
  assert.equal(slidingDoorThresholds([...walls,panels[0]],evidence).length,0)
  assert.equal(slidingDoorThresholds([...walls.slice(0,4),...panels],evidence).length,0)
})

test('door tags overlapping CAD wall returns cannot erase the room boundary', () => {
  const path={id:1,kind:'stroke',layer:['A_WALL'],opacity:1,width:.2,dashes:[],clips:[],groups:[],color:[0],colorSpace:'DeviceGray',evenOdd:false,
    commands:[['M',.1,.1],['L',.9,.1],['L',.9,.9],['L',.1,.9],['L',.1,.12],['L',.1,.1]]}
  const data={...input([]),evidence:{version:1,truncated:false,paths:[path]},textRuns:[{text:'ID1',x:.09,y:.09,w:.04,h:.04}]}
  const result=detectAreas(data)
  assert.equal(result.proposals.length,1)
  assert.ok(Math.abs(result.proposals[0].areaSqft-256)<1e-8)
})

test('1544 original first-floor sheet retains jambs, pocket doors and the main plan envelope', {skip:!process.env.ARC_MHK_PDF}, () => {
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process')
  const {detectSheetAreas}=require('../lib/drawings/area-sheet')
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arc-mhk-regression-'))
  try {
    const target=path.join(dir,'input.json')
    execFileSync(process.execPath,['scripts/import-area-pdf.js',process.env.ARC_MHK_PDF,'4',String(16/3/72),target])
    const {input}=JSON.parse(fs.readFileSync(target,'utf8')),result=detectSheetAreas(input)
    // Source topology regression, not independently checked quantity truth.
    for(const label of ['garage #1','laundry','master bath']) assert.ok(result.proposals.some(p=>p.label===label),label)
    assert.ok(result.proposals.some(p=>/great room/.test(p.label)))
    assert.ok(!result.proposals.some(p=>/master bath/.test(p.label)&&/master bedroom/.test(p.label)))
    assert.ok(!result.proposals.some(p=>/laundry/.test(p.label)&&/pantry/.test(p.label)))
    assert.ok(!result.warnings.some(w=>/processing limit|disagree with the calibrated scale/.test(w)))
    assert.ok(result.warnings.filter(w=>/lacked supported|without supported/.test(w)).length<=1)
    for(const proposal of result.proposals)validateAreaGeometry(proposal)
  } finally {fs.rmSync(dir,{recursive:true,force:true})}
})

test('explicit CAD doors support 45-degree swings without guessing from unclassified arcs',()=>{
  const r=.15,cx=.75,cy=.1,k=Math.tan(Math.PI/16)*4/3
  const p0=[cx+r,cy],p1=[cx+r/Math.sqrt(2),cy+r/Math.sqrt(2)]
  const style={kind:'stroke',color:[0],colorSpace:'DeviceGray',opacity:1,width:.2,dashes:[],groups:[],clips:[],evenOdd:false}
  const data={...input([]),evidence:{version:1,truncated:false,paths:[
    {...style,id:0,layer:['A_WALL'],commands:[['M',.1,.1],['L',cx,cy]]},
    {...style,id:1,layer:['A_WALL'],commands:[['M',.9,.1],['L',.9,.9],['L',.1,.9],['L',.1,.1]]},
    {...style,id:2,layer:['A_DOOR'],commands:[['M',cx,cy],['L',...p1]]},
    {...style,id:3,layer:['A_DOOR'],commands:[['M',...p0],['C',p0[0],p0[1]+k*r,p1[0]+k*r/Math.sqrt(2),p1[1]-k*r/Math.sqrt(2),...p1]]},
  ]}}
  const detected=detectAreas(data)
  assert.ok(detected.proposals.some(p=>Math.abs(p.areaSqft-256)<1e-6))
  data.evidence.paths[3].layer=[]
  assert.ok(!detectAreas(data).proposals.some(p=>Math.abs(p.areaSqft-256)<1e-6))
})

test('CAD swing support retains the existing tolerance at segment tips',()=>{
  const r=.15,cx=.7501,cy=.1,k=.5522847498307936
  const style={kind:'stroke',color:[0],colorSpace:'DeviceGray',opacity:1,width:.2,dashes:[],groups:[],clips:[],evenOdd:false}
  const data={...input([]),evidence:{version:1,truncated:false,paths:[
    {...style,id:0,layer:['A_WALL'],commands:[['M',.1,.1],['L',.75,.1]]},
    {...style,id:1,layer:['A_WALL'],commands:[['M',.9,.1],['L',.9,.9],['L',.1,.9],['L',.1,.1]]},
    {...style,id:2,layer:['A_DOOR'],commands:[['M',cx,cy],['L',cx,cy+r]]},
    {...style,id:3,layer:['A_DOOR'],commands:[['M',cx+r,cy],['C',cx+r,cy+k*r,cx+k*r,cy+r,cx,cy+r]]},
  ]}}
  assert.ok(detectAreas(data).proposals.some(p=>Math.abs(p.areaSqft-256)<.01))
})

test('an interior face too long to trace is reported, while the outer face is not', () => {
  const sides = 1200
  const ring = Array.from({length:sides},(_,i)=>[50+40*Math.cos(2*Math.PI*i/sides),50+40*Math.sin(2*Math.PI*i/sides)])
  const edges = ring.map((p,i)=>({a:p,b:ring[(i+1)%sides],source:'drawn'}))
  let oversized = 0
  const faces = areaFaces(edges, undefined, () => { oversized++ })
  assert.equal(faces.length, 0)
  assert.equal(oversized, 1)
})

test('a labelled room above the area cap is excluded with a warning instead of silently', () => {
  const labelled = { ...input(segments(outer)), textRuns: [{text:'BEDROOM',x:.45,y:.5,w:.1,h:.01}] }
  assert.equal(detectAreas(labelled).proposals.length, 1)
  const capped = detectAreas({ ...labelled, maxAreaSqft: 100 })
  assert.equal(capped.proposals.length, 0)
  assert.ok(capped.warnings.some(w => /larger than 100 SF/.test(w)), capped.warnings.join(' | '))
  const unlabelled = detectAreas({ ...input(segments(outer)), maxAreaSqft: 100 })
  assert.ok(!unlabelled.warnings.some(w => /larger than/.test(w)))
})
