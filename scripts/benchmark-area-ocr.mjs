// Local outlined-text diagnostic. OCR supplies text positions, never area geometry.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createRequire} from 'node:module'
import {execFileSync} from 'node:child_process'
const require=createRequire(import.meta.url)
require('./register-ts-node-test')
const {detectSheetAreas}=require('../lib/drawings/area-sheet')
const {areaRoomLabel}=require('../lib/drawings/area-labels')
const [pdfPath,pageArg,scaleArg,output]=process.argv.slice(2).filter((arg)=>arg!=='--gate')
if(pdfPath)require('./holdout-guard.js').assertNotHoldout({sha256:require('./holdout-guard.js').fileSha256(pdfPath),label:pdfPath,script:'benchmark-area-ocr',gate:process.argv.includes('--gate')})
if(!output)throw new Error('Usage: node scripts/benchmark-area-ocr.mjs plan.pdf PAGE FEET_PER_PDF_POINT output.json')
const {createWorker}=await import(process.env.ARC_OCR_MODULE ?? 'tesseract.js')
const mupdf=await import('mupdf'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'arc-area-ocr-'))
let worker
try{
 const target=path.join(dir,'fixture.json')
 execFileSync(process.execPath,['scripts/import-area-pdf.js',pdfPath,pageArg,scaleArg,target])
 const fixture=JSON.parse(fs.readFileSync(target,'utf8'))
 const doc=mupdf.Document.openDocument(fs.readFileSync(pdfPath),'application/pdf'),page=doc.loadPage(Number(pageArg)-1)
 const [x0,y0,x1,y1]=page.getBounds(),factor=5200/Math.max(x1-x0,y1-y0)
 const pix=page.toPixmap(mupdf.Matrix.scale(factor,factor),mupdf.ColorSpace.DeviceRGB,false)
 const image=pix.asPNG(),width=pix.getWidth(),height=pix.getHeight()
 pix.destroy();page.destroy();doc.destroy()
 worker=await createWorker('eng',1,{cachePath:os.tmpdir()})
 await worker.setParameters({tessedit_pageseg_mode:'11'})
 const start=performance.now()
 const {data}=await worker.recognize(Buffer.from(image),{}, {blocks:true,text:true})
 const runs=(data.blocks??[]).flatMap(b=>b.paragraphs.flatMap(p=>p.lines)).filter(l=>l.confidence>=70).map(l=>({text:l.text.trim(),x:l.bbox.x0/width,y:l.bbox.y0/height,w:(l.bbox.x1-l.bbox.x0)/width,h:(l.bbox.y1-l.bbox.y0)/height}))
 const detection=detectSheetAreas({...fixture.input,textRuns:runs})
 const report={mode:'Local diagnostic only; OCR is not production-integrated or accuracy-qualified',totalMilliseconds:performance.now()-start,source:{file:path.basename(pdfPath),page:Number(pageArg)},textRuns:runs,recognizedRoomLabels:runs.map(t=>areaRoomLabel(t.text)).filter(Boolean),detection}
 fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n')
 console.log(JSON.stringify({labels:report.recognizedRoomLabels,zones:detection.proposals.map(p=>[p.label,p.areaSqft]),warnings:detection.warnings,totalMilliseconds:report.totalMilliseconds},null,2))
}finally{await worker?.terminate();fs.rmSync(dir,{recursive:true,force:true})}
