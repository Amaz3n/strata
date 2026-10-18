#!/usr/bin/env node
/** Development diagnostic using printed dimensions; not an independent holdout.
 * Original customer PDF stays local. Output includes a visual-review overlay. */
require('./register-ts-node-test')
const fs=require('node:fs'),os=require('node:os'),path=require('node:path')
const {execFileSync}=require('node:child_process'),{createHash}=require('node:crypto')
const {detectSheetAreas,}=require('../lib/drawings/area-sheet')
const {AREA_ENGINE_VERSION}=require('../lib/drawings/area-takeoff')
async function main(){
 const [pdfPath,output]=process.argv.slice(2)
 if(!pdfPath||!output)throw new Error('Usage: node scripts/check-burke-area-takeoff.js Burke.pdf report.json')
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arc-burke-check-'))
 try{
  const fixture=path.join(dir,'source.json')
  execFileSync(process.execPath,['scripts/import-area-pdf.js',pdfPath,'4',String(4/72),fixture])
  const {input}=JSON.parse(fs.readFileSync(fixture,'utf8'))
  const start=performance.now(),result=detectSheetAreas(input),elapsedMs=performance.now()-start
  // Bedrooms 2/3: 10'8 × 10'4 + 2'4 × 3'4. Master bedroom: 12' × 15'.
  // These references were read from the development drawing, not fitted to output.
  const cases=[['BEDROOM 2',118],['BEDROOM 3',118],['MASTER BEDROOM',180]].map(([label,expectedSqft])=>{
   const matches=result.proposals.filter(p=>p.label===label)
   const predictedSqft=matches.length===1?matches[0].areaSqft:null
   return {label,expectedSqft,predictedSqft,areaErrorPct:predictedSqft===null?null:100*Math.abs(predictedSqft-expectedSqft)/expectedSqft}
  })
  const report={engine:AREA_ENGINE_VERSION,source:{file:path.basename(pdfPath),page:4,sha256:createHash('sha256').update(fs.readFileSync(pdfPath)).digest('hex')},
   qualification:'Development diagnostic: three printed-dimension area checks; no independently checked boundary truth, full-sheet accuracy or holdout claim.',
   elapsedMs,proposedZones:result.proposals.length,warnings:result.warnings,cases,withinTwoPercent:cases.filter(c=>c.areaErrorPct!==null&&c.areaErrorPct<=2).length,
   zones:result.proposals.map(p=>({label:p.label,areaSqft:p.areaSqft,warnings:p.warnings})),releaseReady:false}
  fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n')
  const mupdf=await import('mupdf'),sharp=require('sharp'),doc=mupdf.Document.openDocument(fs.readFileSync(pdfPath),'application/pdf'),page=doc.loadPage(3)
  const renderScale=.65,pix=page.toPixmap(mupdf.Matrix.scale(renderScale,renderScale),mupdf.ColorSpace.DeviceRGB,false)
  try{
   const w=pix.getWidth(),h=pix.getHeight()
   const ring=points=>points.map((p,i)=>`${i?'L':'M'}${p[0]*w} ${p[1]*h}`).join(' ')+' Z'
   const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${result.proposals.map(p=>`<path d="${[p.points,...p.holes].map(ring).join(' ')}" fill="#1676d2" fill-opacity=".14" stroke="#07579f" stroke-width="1.2" fill-rule="evenodd"/>`).join('')}</svg>`
   await sharp(pix.asPNG()).composite([{input:Buffer.from(svg)}]).png().toFile(output+'.png')
  }finally{pix.destroy();page.destroy();doc.destroy()}
  console.log(JSON.stringify({proposedZones:report.proposedZones,elapsedMs,cases,warnings:report.warnings,report:output,overlay:output+'.png'},null,2))
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
}
main().catch(e=>{console.error(e);process.exitCode=1})
