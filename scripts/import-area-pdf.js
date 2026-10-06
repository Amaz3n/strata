#!/usr/bin/env node
/** Local-only: export evidence for annotation. Never fabricate ground truth. */
require('./register-ts-node-test')
const fs=require('node:fs')
const path=require('node:path')
const {createHash}=require('node:crypto')
async function main() {
  const [pdfPath,pageArg,feetPerPageUnitArg,output]=process.argv.slice(2)
  if(!pdfPath||!output)throw new Error('Usage: node scripts/import-area-pdf.js plan.pdf PAGE_1_BASED FEET_PER_PDF_POINT output.json')
  const mupdf=await import('mupdf')
  const {extractAreaEvidence}=require('../lib/services/area-evidence-extract')
  const pageNumber=Number(pageArg),feetPerUnit=Number(feetPerPageUnitArg)
  if(!Number.isInteger(pageNumber)||pageNumber<1||!Number.isFinite(feetPerUnit)||!(feetPerUnit>0))throw new Error('Page and scale must be positive; scale is feet per PDF point, not feet per pixel')
  const doc=mupdf.Document.openDocument(fs.readFileSync(pdfPath),'application/pdf')
  if(pageNumber>doc.countPages())throw new Error('Page is outside the document')
  const page=doc.loadPage(pageNumber-1)
  try {
    const [x0,y0,x1,y1]=page.getBounds(),width=x1-x0,height=y1-y0
    const evidence=extractAreaEvidence(mupdf,page,{pageToImageScale:1,imageWidth:width,imageHeight:height,pageOriginX:x0,pageOriginY:y0})
    const structured=page.toStructuredText('preserve-whitespace')
    let textRuns=[]
    try {
      const text=JSON.parse(structured.asJSON())
      textRuns=(text.blocks??[]).flatMap((b)=>(b.lines??[]).map((l)=>({text:l.text??'',x:(l.bbox.x-x0)/width,y:(l.bbox.y-y0)/height,w:l.bbox.w/width,h:l.bbox.h/height}))).filter((r)=>r.text)
    } finally {structured.destroy()}
    fs.writeFileSync(output,JSON.stringify({name:`${path.basename(pdfPath)} page ${pageNumber}`,project:'REPLACE_WITH_PROJECT_ID',kind:'original-pdf',split:'development',
      annotationStatus:'unreviewed',detectionMode:'whole-sheet',sourceCategory:!evidence.paths.some(p=>p.kind!=='clip')?'raster':!textRuns.length?'outlined-text':evidence.paths.some(p=>p.layer.length)?'layered-vector':'flattened-vector',source:{file:path.basename(pdfPath),page:pageNumber,sha256:createHash('sha256').update(fs.readFileSync(pdfPath)).digest('hex'),license:'USER_MUST_CONFIRM'},
      input:{segments:[],evidence,textRuns,imageWidth:width,imageHeight:height,feetPerImagePx:feetPerUnit,region:{x0:0,y0:0,x1:1,y1:1}},
      truth:{areas:[]}},null,2))
    console.log(`Exported ${evidence.paths.length} paths. Add independently checked truth areas before benchmarking.`)
  } finally {page.destroy();doc.destroy()}
}
main().catch((e)=>{console.error(e.message);process.exitCode=1})
