require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {extractRasterEvidence}=require('../lib/drawings/raster-evidence')
const image=(width=240,height=200)=>({pixels:new Uint8Array(width*height).fill(255),width,height,feetPerPixel:.1})
const fill=(im,x0,y0,x1,y1,value=0)=>{for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++)im.pixels[y*im.width+x]=value}
test('scan contours preserve measured dark boundaries and both sides of a wall',()=>{
 const im=image();fill(im,20,20,200,25)
 const e=extractRasterEvidence(im)
 assert.equal(e.truncated,false);assert.ok(e.raster);assert.ok(e.paths.length)
 const points=e.paths.flatMap(p=>p.commands.map(c=>[c[1]*im.width,c[2]*im.height]))
 for(const [x,y] of points)assert.ok((Math.abs(y-20)<.01||Math.abs(y-25)<.01)&&(x>=20&&x<=200))
 assert.ok(points.some(p=>p[1]===20));assert.ok(points.some(p=>p[1]===25))
 assert.ok(e.paths.every(p=>p.layer.length===0),'pixels must not fabricate a wall classification')
})
test('blank scans do not fabricate structure',()=>{assert.equal(extractRasterEvidence(image()).paths.length,0)})
test('text-sized marks are excluded without joining gaps between lines',()=>{
 const im=image();fill(im,20,20,25,25);fill(im,40,30,100,31);fill(im,140,30,200,31)
 const e=extractRasterEvidence(im)
 assert.equal(e.paths.length,2)
 assert.ok(e.paths.every(p=>p.commands.every(c=>c[1]*im.width<=100)||p.commands.every(c=>c[1]*im.width>=140)))
})
test('crop coordinates remain registered to the original sheet',()=>{
 const im=image();fill(im,20,20,200,25)
 const e=extractRasterEvidence({...im,region:{x0:.5,y0:.25,x1:1,y1:.75}})
 assert.ok(e.paths.every(p=>p.commands.every(c=>c[1]>=.5&&c[1]<=1&&c[2]>=.25&&c[2]<=.75)))
})
test('path limits explicitly mark incomplete evidence',()=>{
 const im=image();fill(im,20,20,200,25);fill(im,20,50,200,55)
 const e=extractRasterEvidence({...im,maximumPaths:1})
 assert.equal(e.paths.length,1);assert.equal(e.truncated,true)
})

test('classified scan contours reconstruct the measured interior through the shared engine',async()=>{
 const {runAreaEngine}=require('../lib/drawings/area-engine')
 const im=image(600,500);im.feetPerPixel=.025
 fill(im,40,40,440,360);fill(im,60,60,420,340,255)
 const evidence=extractRasterEvidence(im),ids=evidence.paths.map(p=>p.id),region={x0:0,y0:0,x1:1,y1:1}
 // Controlled source annotations test geometry after classification. This is
 // deliberately not a claim that a provider recognized an unseen scan.
 const run=await runAreaEngine({segments:[],imageWidth:im.width,imageHeight:im.height,feetPerImagePx:im.feetPerPixel,textRuns:[],evidence,region,
   visualObservations:[{id:'annotated-wall-contours',region,suppliedPathIds:ids,elements:[{pathIds:ids,kind:'wall'}],openings:[]}]},{wholeSheet:true})
 assert.equal(run.detection.architecture.spaces.length,1)
 assert.ok(Math.abs(run.detection.architecture.spaces[0].areaSqft-63)<.1)
 assert.equal(run.detection.architecture.building.walls.length,4)
})

test('vector page frames and title blocks do not suppress scan fallback for an interior plan crop',()=>{
 const {hasVectorGeometryInRegion}=require('../lib/drawings/area-evidence')
 const path=(id,commands,extra={})=>({id,commands,kind:'stroke',opacity:1,color:[0],colorSpace:'DeviceGray',width:1,dashes:[],clips:[],groups:[],layer:[],evenOdd:false,...extra})
 const frame=path(1,[['M',.01,.01],['L',.99,.01],['L',.99,.99],['L',.01,.99],['Z']])
 const title=path(2,[['M',.8,.3],['L',.98,.3]])
 const white=path(3,frame.commands,{kind:'fill',color:[1]})
 const region={x0:.2,y0:.2,x1:.7,y1:.7}
 assert.equal(hasVectorGeometryInRegion({paths:[frame,title,white]},region),false)
 assert.equal(hasVectorGeometryInRegion({paths:[frame,title,white]}),true)
 const crossing=path(4,[['M',0,.4],['L',1,.4]])
 assert.equal(hasVectorGeometryInRegion({paths:[crossing]},region),true)
 const solid=path(5,frame.commands,{kind:'fill'})
 assert.equal(hasVectorGeometryInRegion({paths:[solid]},region),true)
 const hollow=path(6,[...frame.commands,['M',.1,.1],['L',.9,.1],['L',.9,.9],['L',.1,.9],['Z']],{kind:'fill',evenOdd:true})
 assert.equal(hasVectorGeometryInRegion({paths:[hollow]},region),false)
})
