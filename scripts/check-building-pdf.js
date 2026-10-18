#!/usr/bin/env node
/** Original-PDF reconstruction diagnostic. Never infer accuracy from counts. */
require('./register-ts-node-test')
const { assertNotHoldout, fileSha256 } = require('./holdout-guard')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { execFileSync } = require('node:child_process')
const { runAreaEngine } = require('../lib/drawings/area-engine')
const { buildingToFloorplan } = require('../lib/drawings/building-floorplan')
const { validateArchitecturalModel } = require('../lib/drawings/architectural-validation')
const {floorplanModelSchema}=require('../lib/validation/floorplan')
async function main() {
  const [pdfPath, pageArg, scaleArg, output, ...flags] = process.argv.slice(2)
  if (pdfPath) assertNotHoldout({ sha256: fileSha256(pdfPath), label: pdfPath, script: 'check-building-pdf', gate: flags.includes('--gate') })
  const mode=flags.join(' ')
  const rasterRequested=flags.includes('--raster')||flags.includes('--strokes')
  if(flags.includes('--ocr')&&!rasterRequested)throw new Error('Local OCR diagnostics require an explicit raster extraction mode')
  if(flags.includes('--native')&&(!rasterRequested||!flags.includes('--detail')||!process.env.ARC_DIAGNOSTIC_REGION))throw new Error('Native sampling diagnostics require an explicit raster mode and detailed source region')
  const maximumArg=flags.find(f=>f.startsWith('--max-windows=')),maximum=maximumArg?Number(maximumArg.split('=')[1]):undefined
  if(maximum!==undefined&&(!Number.isInteger(maximum)||maximum<1||maximum>8))throw new Error('Diagnostic window budget must be an integer from 1 to 8')
  if (!output) throw new Error('Usage: node scripts/check-building-pdf.js PDF PAGE_1_BASED FEET_PER_PDF_POINT OUTPUT_JSON [--without-layers]')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-building-'))
  try {
    const sourcePath = path.join(dir, 'source.json')
    execFileSync(process.execPath, ['scripts/import-area-pdf.js', pdfPath, pageArg, scaleArg, sourcePath])
    const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'))
    if (flags.includes('--without-layers')) source.input.evidence.paths.forEach(p => { p.layer = [] })
    const mupdf = await import('mupdf'), sharp = require('sharp')
    const {renderPdfRegion}=require('../lib/drawings/pdf-region-raster')
    let imageBytes, sourceSampling
    if(rasterRequested||flags.includes('--hybrid')) {
      const doc=mupdf.Document.openDocument(fs.readFileSync(pdfPath),'application/pdf'),page=doc.loadPage(Number(pageArg)-1)
      let renderScale=Math.min(2,4096/Math.max(source.input.imageWidth,source.input.imageHeight))
      const pix=page.toPixmap(mupdf.Matrix.scale(renderScale,renderScale),mupdf.ColorSpace.DeviceRGB,false)
      try { imageBytes=Buffer.from(pix.asPNG()) } finally {pix.destroy();page.destroy();doc.destroy()}
      if(rasterRequested) {
        const extractRasterEvidence=flags.includes('--strokes')?require('../lib/drawings/raster-strokes').extractRasterStrokeEvidence:flags.includes('--contours')?require('../lib/drawings/raster-evidence').extractRasterEvidence:require('../lib/drawings/raster-plan-evidence').extractRasterPlanEvidence
        let region
        let raster=sharp(imageBytes)
        if(process.env.ARC_DIAGNOSTIC_REGION){
          const [x0,y0,x1,y1]=process.env.ARC_DIAGNOSTIC_REGION.split(',').map(Number)
          if(![x0,y0,x1,y1].every(Number.isFinite)||x0<0||y0<0||x1>1||y1>1||x1<=x0||y1<=y0)throw new Error('Invalid diagnostic region')
          source.input.region={x0,y0,x1,y1}
          if(flags.includes('--detail')){
            const detailDoc=mupdf.Document.openDocument(fs.readFileSync(pdfPath),'application/pdf'),detailPage=detailDoc.loadPage(Number(pageArg)-1)
            try{
              if(flags.includes('--native'))sourceSampling=require('../lib/drawings/pdf-raster-sampling').inspectPdfRasterSampling(mupdf,detailPage,source.input.region)
              const detail=renderPdfRegion(mupdf,detailPage,{region:source.input.region,scale:sourceSampling?.renderScale??Number(scaleArg)/.01})
              raster=sharp(Buffer.from(detail.data));region=detail.region;renderScale=detail.scale
            }finally{detailPage.destroy();detailDoc.destroy()}
          }else{
            const meta=await raster.metadata(),left=Math.floor(x0*meta.width),top=Math.floor(y0*meta.height),width=Math.ceil(x1*meta.width)-left,height=Math.ceil(y1*meta.height)-top
            raster=raster.extract({left,top,width,height})
            region={x0:left/meta.width,y0:top/meta.height,x1:(left+width)/meta.width,y1:(top+height)/meta.height}
          }
        }
        const {data,info}=await raster.greyscale().raw().toBuffer({resolveWithObject:true})
        source.input.evidence=extractRasterEvidence({pixels:data,width:info.width,height:info.height,feetPerPixel:Number(scaleArg)/renderScale,region})
        if(sourceSampling)Object.assign(source.input.evidence.raster,{sourceSampling,sourceHash:source.source.sha256,renderDpi:renderScale*72})
        source.input.textRuns=[]
        if(flags.includes('--ocr')){
          const {recognizeLocalRasterText}=require('../lib/services/local-raster-text'),{rasterTextRuns,RASTER_TEXT_PROFILE}=require('../lib/drawings/raster-text')
          const pixelsImage=await sharp(data,{raw:{width:info.width,height:info.height,channels:1}}).png().toBuffer()
          const lines=await recognizeLocalRasterText(pixelsImage)
          source.input.evidence.rasterText={profile:RASTER_TEXT_PROFILE,status:'processed',runs:rasterTextRuns(lines,info.width,info.height,source.input.evidence.raster.region),windows:1,
            warnings:['Local development OCR of the rendered region. Verify scan text against source pixels; this does not qualify full-plan recognition.',...(sourceSampling?.warnings??[])],
            ...(sourceSampling?{source:{kind:'original-pdf',hash:source.source.sha256,sampling:sourceSampling}}:{})}
        }
      }
    }
    const evidenceFingerprint=require('node:crypto').createHash('sha256').update(JSON.stringify(source.input.evidence)).digest('hex')
    let recognize
    if(flags.includes('--hybrid')) {
      for(const file of ['.env.local','.env'])if(fs.existsSync(file))process.loadEnvFile(file)
      if(!process.env.ARC_RECOGNITION_ORG_ID)throw new Error('Set ARC_RECOGNITION_ORG_ID for an authorized live provider diagnostic')
      const {runDrawingsVisionObject}=require('../lib/services/ai/drawings-vision')
      const {areaRecognitionPrompt}=require('../lib/drawings/area-engine')
      const {visualInterpretationProviderSchema}=require('../lib/drawings/area-semantics')
      const {getAiFeatureTierConfig}=require('../lib/services/ai-config')
      const {createServiceSupabaseClient}=require('../lib/supabase/server')
      const config=await getAiFeatureTierConfig({supabase:createServiceSupabaseClient(),feature:'drawings_vision',tier:'standard'})
      if(config.provider!=='google')throw new Error('This diagnostic is authorized only for the configured Google provider')
      const responseFile=output+'.responses.json',responses=fs.existsSync(responseFile)?JSON.parse(fs.readFileSync(responseFile,'utf8')):{}
      const responseKey=request=>require('node:crypto').createHash('sha256').update(JSON.stringify([6,'regional-pdf-0.01ft',flags.includes('--low-thinking')?'low':'default',source.source.sha256,evidenceFingerprint,request.region,areaRecognitionPrompt(request)])).digest('hex')
      let calls=0
      recognize=async request=>{
        const key=responseKey(request)
        if(responses[key])return responses[key]
        calls++;if(flags.includes('--second-window')&&calls===1)return null;process.stderr.write(`Classification window ${calls} (${request.catalogue.length} source paths)\n`)
        const detailDoc=mupdf.Document.openDocument(fs.readFileSync(pdfPath),'application/pdf'),detailPage=detailDoc.loadPage(Number(pageArg)-1)
        let crop
        try{crop=renderPdfRegion(mupdf,detailPage,{region:request.region,scale:Number(scaleArg)/.01,maximumDimension:2000})}finally{detailPage.destroy();detailDoc.destroy()}
        const data=Buffer.from(crop.data)
        const {recognitionOverlaySvg,registerRecognitionImage}=require('../lib/drawings/recognition-overlay')
        const registered=registerRecognitionImage(request,crop.region)
        const annotated=await sharp(data).composite([{input:Buffer.from(recognitionOverlaySvg(registered,crop.width,crop.height))}]).png().toBuffer()
        const answer=await runDrawingsVisionObject({orgId:process.env.ARC_RECOGNITION_ORG_ID,entityType:'architectural_diagnostic',schema:visualInterpretationProviderSchema,onFailure:error=>{let current=error,issues=[];for(let depth=0;depth<5&&current;depth++){if(current.issues)issues.push(...current.issues);current=current.cause}fs.writeFileSync(output+'.failure-'+calls+'.json',JSON.stringify({issues,finishReason:error?.finishReason,text:error?.text},null,2));process.stderr.write(JSON.stringify({schemaIssues:issues.map(i=>({path:i.path,code:i.code,message:i.message}))})+'\n')},images:[{data,mediaType:'image/png'},{data:annotated,mediaType:'image/png'}],prompt:areaRecognitionPrompt(registered),tier:'standard',reasoningEffort:flags.includes('--low-thinking')?'low':undefined,allowEscalation:false,allowFallback:false,timeoutMs:45000})
        if(answer){responses[key]=answer;fs.writeFileSync(responseFile,JSON.stringify(responses,null,2))}
        return answer
      }
      recognize.cached=async request=>responses[responseKey(request)]??null
    }
    const start = performance.now()
    const run = await runAreaEngine({ ...source.input, finishPolicy: 'include-fixtures' }, { wholeSheet: true, recognize, maxRecognitionWindows:maximum??(flags.includes('--second-window')?2:flags.includes('--one-window')?1:rasterRequested?6:4) })
    const {createAreaReplay}=require('../lib/drawings/area-replay')
    fs.writeFileSync(output+'.replay.json',JSON.stringify(createAreaReplay({...source.input,finishPolicy:'include-fixtures',visualObservations:run.observations},true,{sourceHash:source.source.sha256},run.recognition)))
    const architecture = run.detection.architecture, building = architecture.building
    const level = buildingToFloorplan({ ...source.input, sheetVersionId: '00000000-0000-4000-8000-000000000001', sheetNumber: null, sheetTitle: source.name, name: 'Floor', order: 0, scaleConfirmed: true }, architecture)
    const model = { version: 1, units: 'feet', levels: [level], correctionCount: 0 }
    const schema=floorplanModelSchema.safeParse(model)
    const report = {
      source: source.source, evidenceFingerprint, calibration:source.input.feetPerImagePx, mode: mode || 'source-layers', engine: run.detection.engine, elapsedMs: performance.now() - start,
      qualification: 'Development source diagnostic. No independent full-sheet wall/opening/room truth; counts and invariants are not recognition accuracy.',
      walls: building.walls.length, openings: building.openings.length, rooms: level.rooms.map(r => ({ label: r.label, areaSqft: r.areaSqft })),
      schemaIssues:schema.success?[]:schema.error.issues.map(i=>({path:i.path,message:i.message})),
      sourceCoverage: building.source, reconstructionIssues: building.issues, validationIssues: validateArchitecturalModel(model),
      warnings: run.detection.warnings, recognition:run.recognition, observations:run.observations, releaseReady: false,
    }
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
    const doc = mupdf.Document.openDocument(fs.readFileSync(pdfPath), 'application/pdf'), page = doc.loadPage(Number(pageArg) - 1)
    const pix = page.toPixmap(mupdf.Matrix.scale(.8, .8), mupdf.ColorSpace.DeviceRGB, false)
    try {
      const width = pix.getWidth(), height = pix.getHeight(), sx = source.input.imageWidth * source.input.feetPerImagePx
      const walls = building.walls.map(w => `<line x1="${w.a[0]*width}" y1="${w.a[1]*height}" x2="${w.b[0]*width}" y2="${w.b[1]*height}" stroke="${w.basis === 'opening-host' ? '#db6500' : '#176bc5'}" stroke-width="${Math.max(1,w.thicknessFt*width/sx)}" opacity=".6"/>`).join('')
      const openings=building.openings.map(o=>{
        const host=building.walls.find(w=>w.id===o.wallId),sy=source.input.imageHeight*source.input.feetPerImagePx
        const dx=host.b[0]-host.a[0],dy=host.b[1]-host.a[1],length=Math.hypot(dx*sx,dy*sy),start=o.offsetFt/length,end=(o.offsetFt+o.widthFt)/length
        return `<line x1="${(host.a[0]+dx*start)*width}" y1="${(host.a[1]+dy*start)*height}" x2="${(host.a[0]+dx*end)*width}" y2="${(host.a[1]+dy*end)*height}" stroke="#db6500" stroke-width="${Math.max(2,host.thicknessFt*width/sx)}" opacity=".75"/>`
      }).join('')
      const rings = architecture.spaces.map(s => `<path d="${[s.points,...s.holes].map(r => r.map((p,i)=>`${i?'L':'M'}${p[0]*width} ${p[1]*height}`).join(' ')+' Z').join(' ')}" fill="#16b875" opacity=".12" fill-rule="evenodd"/>`).join('')
      await sharp(pix.asPNG()).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${rings}${walls}${openings}</svg>`) }]).png().toFile(output + '.png')
    } finally { pix.destroy(); page.destroy(); doc.destroy() }
    console.log(JSON.stringify({ output, walls: report.walls, openings: report.openings, rooms: report.rooms.length, issues: report.reconstructionIssues.length, elapsedMs: report.elapsedMs }))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
