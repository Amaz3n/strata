require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),sharp=require('sharp')
const {renderPdfRegion}=require('../lib/drawings/pdf-region-raster')

test('regional rendering preserves source registration, including crop origins and rotation',async()=>{
 const {PDFDocument,rgb,degrees}=require('pdf-lib'),mupdf=await import('mupdf')
 for(const rotation of [0,90]){
  const pdf=await PDFDocument.create(),p=pdf.addPage([600,400])
  p.setCropBox(20,30,540,320);p.setRotation(degrees(rotation))
  p.drawRectangle({x:110,y:160,width:180,height:70,color:rgb(0,0,0)})
  p.drawLine({start:{x:20,y:40},end:{x:500,y:300},thickness:1.3,color:rgb(0,0,0)})
  const doc=mupdf.Document.openDocument(await pdf.save(),'application/pdf'),page=doc.loadPage(0)
  try{
   const region={x0:.103,y0:.207,x1:.701,y1:.809},scale=2
   const crop=renderPdfRegion(mupdf,page,{region,scale})
   const full=page.toPixmap(mupdf.Matrix.scale(scale,scale),mupdf.ColorSpace.DeviceRGB,false)
   try{
    const [ox,oy,ex,ey]=page.getBounds(),w=ex-ox,h=ey-oy
    const expected=await sharp(Buffer.from(full.asPNG())).extract({left:Math.floor(region.x0*w*scale),top:Math.floor(region.y0*h*scale),width:crop.width,height:crop.height}).raw().toBuffer()
    const actual=await sharp(Buffer.from(crop.data)).raw().toBuffer()
    assert.equal(actual.length,expected.length)
    // MuPDF's regional scissor changes diagonal edge antialiasing slightly;
    // displacement or missing paint must still fail this pixel comparison.
    let total=0,max=0
    for(let i=0;i<actual.length;i++){const d=Math.abs(actual[i]-expected[i]);total+=d;max=Math.max(max,d)}
    assert.ok(total/actual.length<.05,'Mean pixel error must stay below 0.05/255')
    assert.ok(max<32,'No pixel may differ by more than antialiasing uncertainty')
    assert.ok(crop.region.x0<=region.x0&&crop.region.x1>=region.x1)
    assert.ok(Math.abs((crop.region.x1-crop.region.x0)*w*scale-crop.width)<1e-9)
   }finally{full.destroy()}
   const limited=renderPdfRegion(mupdf,page,{region,scale:100,maximumDimension:128})
   assert.ok(limited.width<=128&&limited.height<=128)
   assert.throws(()=>renderPdfRegion(mupdf,page,{region:{...region,x1:2},scale}),/Invalid/)
  }finally{page.destroy();doc.destroy()}
 }
})
