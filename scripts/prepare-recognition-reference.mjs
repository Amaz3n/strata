#!/usr/bin/env node
/** Local source-only annotation packets. Never imports or copies engine output. */
import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {pathToFileURL} from 'node:url'

export function referenceTemplate(item, pageBounds) {
  if (item.split !== 'development') throw Error('Source inspection is restricted to development cases; reserve unseen projects before evaluating holdouts')
  if (!/^[a-z0-9-]+$/.test(item.id) || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isInteger(item.page) || item.page < 1) throw Error('Invalid source identity')
  if (!Array.isArray(pageBounds) || pageBounds.length !== 4 || !pageBounds.every(Number.isFinite) || pageBounds[2] <= pageBounds[0] || pageBounds[3] <= pageBounds[1]) throw Error('Invalid page bounds')
  return {
    version:1, caseId:item.id, projectId:`development-set-${item.set}`, split:'development',
    source:{sha256:item.sha256,page:item.page,file:path.resolve(item.file),pageBounds},
    coordinateSystem:'normalized-page-top-left',
    annotation:{status:'not-started',author:null,reviewer:null,sourceOnlyReviewAttestation:null,complete:false,disagreements:[]},
    // A printed scale is a hint, not a verified dimension calibration.
    calibration:{status:'unverified',printedFeetPerPdfPoint:item.feetPerPdfPoint,dimensionChecks:[]},
    strata:{architect:null,draftingFamily:null,representation:null,buildingType:null,renovation:null},
    eligibleViews:[],excludedViews:[],uncertainRegions:[],walls:[],openings:[],rooms:[],floorVoids:[],
    correctionTrials:[],independentAccuracyQualified:false,releaseReady:false,
  }
}

export async function prepare(manifestFile, outputDirectory, selectedSets) {
  if (fs.existsSync(outputDirectory)) throw Error('Use a new output directory; reference drafts must not be overwritten')
  const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'))
  if (!Array.isArray(manifest.cases)) throw Error('Missing case manifest')
  if (manifest.cases.some(c=>c.split!=='development')) throw Error('This source inspection tool accepts development manifests only')
  if (!selectedSets.length || selectedSets.some(n=>!Number.isInteger(n)||n<1) || new Set(selectedSets).size!==selectedSets.length) throw Error('Specify unique positive set numbers')
  const selected=selectedSets.map(set=>{
    const item=manifest.cases.find(c=>c.set===set&&c.variant==='original')
    if (!item) throw Error(`No original development case for set ${set}`)
    const bytes=fs.readFileSync(item.file)
    if (createHash('sha256').update(bytes).digest('hex')!==item.sha256) throw Error(`Source fingerprint changed: ${item.id}`)
    return {item,bytes}
  })
  const mupdf=await import('mupdf'),packets=[]
  fs.mkdirSync(outputDirectory,{recursive:true})
  for (const {item,bytes} of selected) {
    const doc=mupdf.Document.openDocument(bytes,'application/pdf')
    let page,pix
    try {
      page=doc.loadPage(item.page-1)
      const bounds=page.getBounds(),scale=2400/Math.max(bounds[2]-bounds[0],bounds[3]-bounds[1])
      const reference=referenceTemplate(item,bounds)
      pix=page.toPixmap(mupdf.Matrix.scale(scale,scale),mupdf.ColorSpace.DeviceRGB,false)
      fs.writeFileSync(path.join(outputDirectory,item.id+'.source.png'),Buffer.from(pix.asPNG()))
      fs.writeFileSync(path.join(outputDirectory,item.id+'.reference.json'),JSON.stringify(reference,null,2)+'\n')
      packets.push({caseId:item.id,reference:item.id+'.reference.json',preview:item.id+'.source.png',status:'not-started'})
    } finally {pix?.destroy();page?.destroy();doc.destroy()}
  }
  fs.writeFileSync(path.join(outputDirectory,'index.json'),JSON.stringify({version:1,purpose:'Source-only development annotation; no predictions or generated truth',packets,independentAccuracyQualified:false,releaseReady:false},null,2)+'\n')
  fs.writeFileSync(path.join(outputDirectory,'README.md'),`# Source-only reference packets

These are unannotated source packets, not ground truth. No Arc prediction is
included. Work from each original PDF (path and hash in its reference JSON),
using the PNG only for orientation. Keep normalized original-page coordinates.

1. Record architect, drafting family, source representation and project scope.
2. Outline eligible plan views and excluded diagrams, legends and title blocks.
3. Calibrate each view against at least two drawn dimensions in different
   directions; record dimension endpoints, stated feet and reading uncertainty.
4. Trace wall bodies, jamb-to-jamb openings, finished-floor room boundaries and
   floor voids. Record ambiguous or occluded geometry explicitly; do not guess.
5. Record annotation author and complete scope. A separate source-only blind
   reviewer must verify geometry and adjudicate disagreements against the
   source. AI-reviewed references are correlated, not human-certified or
   independent professional validation. Self-checked drafts remain provisional.
6. Freeze/hash annotations before running predictions. Record actual correction
   time and edits in a separate trial; review-item counts are not user effort.

All ${packets.length} packets are already-exposed development projects. None is a holdout.
See docs/takeoff-evaluation.md for the split and scoring protocol.
`)
  return packets
}

if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const [manifest,output,sets]=process.argv.slice(2)
  if (!manifest||!output||!sets) throw Error('Usage: node scripts/prepare-recognition-reference.mjs CASES_JSON NEW_OUTPUT_DIRECTORY SET_NUMBERS_COMMA_SEPARATED')
  console.log(JSON.stringify(await prepare(manifest,output,sets.split(',').map(Number))))
}
