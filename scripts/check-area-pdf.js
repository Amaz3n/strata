#!/usr/bin/env node
/** Original-PDF development diagnostic. Never generates truth from predictions. */
require('./register-ts-node-test')
const { assertNotHoldout, fileSha256 } = require('./holdout-guard')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const {execFileSync} = require('node:child_process'), {createHash} = require('node:crypto')
const {runAreaEngine} = require('../lib/drawings/area-engine')
const {AREA_ENGINE_VERSION, validateAreaGeometry} = require('../lib/drawings/area-takeoff')
const {areaPathRole} = require('../lib/drawings/area-paths')
async function main() {
  const gate = process.argv.includes('--gate')
  const [pdfPath, pageArg, scaleArg, output, variantArg] = process.argv.slice(2).filter((arg) => arg !== '--gate')
  if (pdfPath) assertNotHoldout({ sha256: fileSha256(pdfPath), label: path.basename(pdfPath), script: 'check-area-pdf', gate, engine: AREA_ENGINE_VERSION })
  if (variantArg && variantArg !== '--without-layers') throw Error('Unknown variant; use --without-layers')
  const pageNumber = Number(pageArg), scale = Number(scaleArg)
  if (!output || !Number.isInteger(pageNumber) || pageNumber < 1 || !Number.isFinite(scale) || scale <= 0) throw Error('Usage: node scripts/check-area-pdf.js input.pdf PAGE FEET_PER_PDF_POINT report.json')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-area-source-'))
  try {
    const target = path.join(dir, 'input.json')
    execFileSync(process.execPath, ['scripts/import-area-pdf.js', pdfPath, pageArg, scaleArg, target])
    const {input,sourceCategory} = JSON.parse(fs.readFileSync(target, 'utf8'))
    const variant = variantArg ? 'layer-metadata-removed' : 'original'
    if (variantArg) input.evidence.paths = input.evidence.paths.map(p => ({...p, layer:[]}))
    const start = performance.now(), run = await runAreaEngine({...input,region:{x0:0,y0:0,x1:1,y1:1}},{wholeSheet:true}), detection = run.detection, elapsedMs = performance.now() - start
    const invalid = detection.proposals.flatMap(p => { try {validateAreaGeometry(p); return []} catch(e) {return [{label:p.label,error:e.message}]} })
    const roles = {}
    for (const p of input.evidence.paths) {const role=areaPathRole(p);roles[role]=(roles[role]??0)+1}
    const report = {engine:AREA_ENGINE_VERSION,qualification:'Development diagnostic only; no independent boundary truth or release qualification.',
      source:{file:path.basename(pdfPath),page:pageNumber,sha256:createHash('sha256').update(fs.readFileSync(pdfPath)).digest('hex'),feetPerPdfPoint:scale},
      elapsedMs,recognition:run.recognition,sourceCategory,variant,evidence:{paths:input.evidence.paths.length,truncated:input.evidence.truncated,unrepresentedPaint:input.evidence.unrepresentedPaint,textRuns:input.textRuns.length},pathRoles:roles,invalidGeometry:invalid,detection,releaseReady:false}
    fs.writeFileSync(output, JSON.stringify(report,null,2)+'\n')
    const mupdf=await import('mupdf'),sharp=require('sharp'),doc=mupdf.Document.openDocument(fs.readFileSync(pdfPath),'application/pdf'),page=doc.loadPage(pageNumber-1)
    const [x0,y0,x1,y1]=page.getBounds(),factor=2200/Math.max(x1-x0,y1-y0),pix=page.toPixmap(mupdf.Matrix.scale(factor,factor),mupdf.ColorSpace.DeviceRGB,false)
    try {
      const w=pix.getWidth(),h=pix.getHeight(),ring=points=>points.map((p,i)=>`${i?'L':'M'}${p[0]*w} ${p[1]*h}`).join(' ')+' Z'
      const svg=`<svg width="${w}" height="${h}">${detection.proposals.map(p=>`<path d="${[p.points,...p.holes].map(ring).join(' ')}" fill="#1676d2" fill-opacity=".14" stroke="#07579f" stroke-width="1.2" fill-rule="evenodd"/>`).join('')}</svg>`
      await sharp(pix.asPNG()).composite([{input:Buffer.from(svg)}]).png().toFile(output+'.png')
    } finally {pix.destroy();page.destroy();doc.destroy()}
    console.log(JSON.stringify({engine:report.engine,elapsedMs,zones:detection.proposals.map(p=>[p.label,p.areaSqft]),invalidGeometry:invalid,coverage:detection.coverage,warnings:detection.warnings,report:output},null,2))
    if(invalid.length)process.exitCode=1
  } finally {fs.rmSync(dir,{recursive:true,force:true})}
}
main().catch(error=>{console.error(error);process.exitCode=1})
