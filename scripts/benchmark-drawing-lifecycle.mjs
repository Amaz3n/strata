/** Local synthetic handler benchmark. Null stages are explicitly unmeasured, never fabricated. */
import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import os from 'node:os'
const require = createRequire(import.meta.url)
const { createSplitFixture } = require('../tests/fixtures/drawing-lifecycle/split-harness.cjs')
const { syntheticPdf } = require('../tests/fixtures/drawing-lifecycle/synthetic.cjs')
const { loadHandler, database } = require('../tests/fixtures/drawing-lifecycle/harness.cjs')
const { DRAWING_LIFECYCLE_STAGES } = loadHandler('lib/drawings/lifecycle-metrics.ts')
const args = process.argv.slice(2)
if (!args.includes('--synthetic')) throw Error('Only --synthetic is permitted; live backend benchmarks are not authorized')
const output = args[args.indexOf('--output')+1]
if (!args.includes('--output') || !output) throw Error('--output path is required')
globalThis.fetch = async () => { throw Error('Network blocked in synthetic benchmark') }
const mupdf = await import('mupdf')
const pipeline = loadHandler('lib/services/drawings-pipeline.ts',{},['detectPageSheetMetadata','finishPageProgress'])
const report = {schemaVersion:1,workload:'real PDF metadata extraction and durable render-progress reconciliation; no live backend',configuration:{sizes:[1,24,25,300],samples:3,network:'blocked',rendering:'not measured',clock:'performance.now'},hardware:{platform:os.platform(),architecture:os.arch(),cpu:os.cpus()[0]?.model,node:process.version},results:[]}
for (const pages of report.configuration.sizes) {
  const bytes = await syntheticPdf(pages)
  const revision = await syntheticPdf(pages,{changedPage:1})
  const reordered = await syntheticPdf(pages,{reordered:true})
  const samples=[]
  for(let sample=0;sample<report.configuration.samples;sample++) {
    const start=performance.now()
    const doc=mupdf.Document.openDocument(bytes,'application/pdf')
    try {
      assert.equal(doc.countPages(),pages)
      for(let i=0;i<pages;i++) {
        const page=doc.loadPage(i)
        try { assert.ok(pipeline.detectPageSheetMetadata(page,pipeline.extractPageTextLines(page).join('\n'),'Synthetic',i+1).sheetNumber) }
        finally {page.destroy()}
      }
    } finally {doc.destroy()}
    samples.push(performance.now()-start)
  }
  const fixture=database({drawing_revisions:[{id:'revision',status:'processing',total_pages:pages}],drawing_sheet_versions:Array.from({length:pages},(_,i)=>({id:`v${i}`,drawing_revision_id:'revision',tile_manifest:{Image:{}},extracted_metadata:{sheet_detection:{vision_pending:false}}})),outbox:[]},async()=>({data:null}))
  const started=performance.now()
  await pipeline.finishPageProgress(fixture.client,'revision',pages,'org')
  const readiness=performance.now()-started
  samples.sort((a,b)=>a-b)
  const stages=Object.fromEntries(DRAWING_LIFECYCLE_STAGES.map(stage=>[stage,{measured:false,medianMs:null,p95Ms:null,samples:0}]))
  // Readiness now executes a database transaction; local mock time is not a latency measurement.
  const splitSamples=[]
  let splitCounts
  for(let i=0;i<3;i++) {
    const split=await createSplitFixture(pages),start=performance.now()
    await split.run()
    splitSamples.push(performance.now()-start)
    splitCounts=split.counts
    assert.equal(splitCounts.downloads,1)
    assert.equal(splitCounts.opens,1)
    assert.equal(split.tables.outbox.length,pages)
    assert.equal(splitCounts.firstEmittedAfterPuts,1)
  }
  splitSamples.sort((a,b)=>a-b)
  report.results.push({pages,splitSession:{medianMs:splitSamples[1],p95Ms:splitSamples[2],samples:3,sourceDownloads:splitCounts.downloads,sourceOpens:splitCounts.opens,storagePuts:splitCounts.puts,registrationCalls:splitCounts.registrationCalls,firstPageMs:splitCounts.firstPageMs,peakProcessRSSMiB:process.resourceUsage().maxRSS/1024,storage:'in-memory',database:'in-memory'},fixtureBytes:bytes.length,revisionBytes:revision.length,reorderedBytes:reordered.length,metadataExtraction:{medianMs:samples[1],p95Ms:samples[2],samples:3},stages,counts:{attempts:1,bytesTransferred:0,sourceDownloads:0,pagesRendered:0,pagesReused:0,storageDeletions:0,databaseCalls:fixture.counts.databaseCalls}})
}
if(args.includes('--assert')) {
  assert.equal(report.results.length,4)
  for(const result of report.results) {
    assert.ok(result.fixtureBytes>0)
    assert.ok(Number.isFinite(result.metadataExtraction.p95Ms))
    assert.equal(Object.keys(result.stages).length,DRAWING_LIFECYCLE_STAGES.length)
    assert.ok(result.counts.databaseCalls>0)
  }
}
await writeFile(output,JSON.stringify(report,null,2)+'\n')
console.info(`Wrote ${report.results.length} synthetic sizes to ${output}; unmeasured backend stages remain explicitly null.`)
