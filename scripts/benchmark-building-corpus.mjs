#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'

const [manifestPath, outputDirectory]=process.argv.slice(2)
if(!manifestPath||!outputDirectory)throw new Error('Usage: node scripts/benchmark-building-corpus.mjs CASES_JSON NEW_OUTPUT_DIRECTORY')
if(fs.existsSync(outputDirectory))throw new Error('Use a new output directory to preserve earlier evidence')
const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8')),seen=new Set()
// This runner exposes per-case outputs to the developer. It must never be
// used to inspect reserved holdouts, including derivatives of those projects.
if(!Array.isArray(manifest.cases)||manifest.cases.some(c=>c.split!=='development'))throw new Error('Development diagnostics require explicitly exposed development cases; do not inspect held-out plans here')
const cases=manifest.cases.filter(c=>c.variant==='original'&&!seen.has(c.set)&&seen.add(c.set))
const implementationFiles=[...fs.readdirSync('lib/drawings').filter(f=>f.endsWith('.ts')).map(f=>'lib/drawings/'+f),'lib/services/area-evidence-extract.ts','lib/services/architectural-raster.ts','lib/services/architectural-evidence.ts','lib/services/architectural-recognition.ts','lib/storage/drawings-tiles-storage.ts','lib/services/area-takeoff.ts','lib/services/floorplan-models.ts','lib/services/original-sheet-raster.ts','lib/services/mupdf-loader.ts','lib/services/drawings-sheet-images.ts','lib/services/local-raster-text.ts','lib/services/ocr/raster-text-process.cjs','next.config.mjs','scripts/check-building-pdf.js','lib/validation/floorplan.ts','pnpm-lock.yaml'].sort()
const fingerprint=()=>{const hash=createHash('sha256');for(const file of implementationFiles)hash.update(file+'\0').update(fs.readFileSync(file));return hash.digest('hex')}
const implementationHash=fingerprint(),startedAt=new Date().toISOString()
fs.mkdirSync(outputDirectory,{recursive:true})
const results=[]
let index=0
async function worker(){
  for(;;){
    const item=cases[index++];if(!item)return
    if(!/^[a-z0-9-]+$/.test(item.id))throw new Error('Invalid case identity')
    const sha256=createHash('sha256').update(fs.readFileSync(item.file)).digest('hex')
    if(sha256!==item.sha256)throw new Error(`Source fingerprint changed: ${item.id}`)
    const output=path.join(outputDirectory,item.id+'.json'),log=fs.openSync(output+'.log','w')
    const code=await new Promise(resolve=>{
      const child=spawn(process.execPath,['scripts/check-building-pdf.js',item.file,String(item.page),String(item.feetPerPdfPoint),output],{stdio:['ignore',log,log]})
      const timer=setTimeout(()=>child.kill('SIGKILL'),120000)
      child.on('error',()=>{clearTimeout(timer);resolve('start-failed')})
      child.on('exit',(code,signal)=>{clearTimeout(timer);resolve(signal??code)})
    })
    fs.closeSync(log)
    const report=code===0?JSON.parse(fs.readFileSync(output,'utf8')):null
    const result={id:item.id,file:item.file,page:item.page,sha256,status:report?'completed':String(code),walls:report?.walls,openings:report?.openings,spaces:report?.rooms.length,reviewItems:report?.reconstructionIssues.length,geometryErrors:report?.validationIssues.filter(i=>i.severity==='error').length,elapsedMs:report?.elapsedMs,independentAccuracyQualified:false}
    results.push(result);console.log(JSON.stringify(result))
    fs.writeFileSync(path.join(outputDirectory,'summary.json'),JSON.stringify({qualification:'Development source diagnostics: one original main floor per set. No independent wall/opening truth and no accuracy claim.',startedAt,implementationHash,nodeVersion:process.version,cases:results,releaseReady:false},null,2))
  }
}
await Promise.all([worker(),worker()])
if(fingerprint()!==implementationHash)throw new Error('Implementation changed during the diagnostic run; do not compare these cases as one engine version')
