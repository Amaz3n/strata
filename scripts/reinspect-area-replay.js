#!/usr/bin/env node
/** Local, review-only diagnosis of a recorded architectural interpretation.
 * Network use requires --live-google and authorization for the supplied PDF. */
require('./register-ts-node-test')
const { assertNotHoldout } = require('./holdout-guard')
const fs = require('node:fs'), { createHash } = require('node:crypto')
const { replayAreaDetection, createAreaReplay } = require('../lib/drawings/area-replay')
const { runAreaEngine, areaRecognitionPrompt } = require('../lib/drawings/area-engine')
const { planArchitecturalReinspection, reinspectArchitecture, reinspectionAlternative } = require('../lib/drawings/architectural-reinspection')
const { buildingToFloorplan } = require('../lib/drawings/building-floorplan')
const { validateArchitecturalModel } = require('../lib/drawings/architectural-validation')
const { floorplanModelSchema } = require('../lib/validation/floorplan')
const hash = value => createHash('sha256').update(value).digest('hex')
async function main() {
  const [replayPath, pdfPath, pageArg, output, ...flags] = process.argv.slice(2)
  if (!output) throw Error('Usage: node scripts/reinspect-area-replay.js REPLAY PDF PAGE_1_BASED OUTPUT [--live-google] [--max-requests=1]')
  const pageNumber = Number(pageArg), budgetArg = flags.find(f => f.startsWith('--max-requests=')), budget = budgetArg ? Number(budgetArg.split('=')[1]) : 1
  if (!Number.isInteger(pageNumber) || pageNumber < 1) throw Error('Invalid page number')
  if (!Number.isInteger(budget) || budget < 0 || budget > 4) throw Error('Request budget must be an integer from 0 to 4')
  const record = JSON.parse(fs.readFileSync(replayPath, 'utf8')), pdfBytes = fs.readFileSync(pdfPath), pdfHash = hash(pdfBytes)
  assertNotHoldout({ sha256: pdfHash, label: pdfPath, script: 'reinspect-area-replay', gate: flags.includes('--gate') })
  if (!record.source.sourceHash || record.source.sourceHash !== pdfHash) throw Error('The PDF does not match the recorded source hash')
  const baseline = await replayAreaDetection(record, { compareCurrentEngine: true })
  const architecture = baseline.detection.architecture
  if (!architecture) throw Error('No architectural reconstruction available')
  const plan = planArchitecturalReinspection(record.input, architecture)
  const qualification = 'Development diagnostic. Proposed reclassifications are unqualified alternatives, not independent truth or approved corrections.'
  if (!flags.includes('--live-google')) {
    fs.writeFileSync(output, JSON.stringify({ qualification, source: record.source, plan }, null, 2))
    console.log(JSON.stringify({ output, targets: plan.length, networkCalls: 0 }))
    return
  }
  for (const file of ['.env.local', '.env']) if (fs.existsSync(file)) process.loadEnvFile(file)
  if (!process.env.ARC_RECOGNITION_ORG_ID) throw Error('Set ARC_RECOGNITION_ORG_ID for an authorized live diagnostic')
  const { getAiFeatureTierConfig } = require('../lib/services/ai-config'), { createServiceSupabaseClient } = require('../lib/supabase/server')
  const config = await getAiFeatureTierConfig({ supabase: createServiceSupabaseClient(), feature: 'drawings_vision', tier: 'standard' })
  if (config.provider !== 'google') throw Error('Only the configured Google provider is authorized for this diagnostic')
  const { runDrawingsVisionObject } = require('../lib/services/ai/drawings-vision')
  const { visualInterpretationProviderSchema } = require('../lib/drawings/area-semantics')
  const { renderPdfRegion } = require('../lib/drawings/pdf-region-raster')
  const { registerRecognitionImage, recognitionOverlaySvg } = require('../lib/drawings/recognition-overlay')
  const mupdf = await import('mupdf'), sharp = require('sharp')
  const doc = mupdf.Document.openDocument(pdfBytes, 'application/pdf')
  if (pageNumber > doc.countPages()) { doc.destroy(); throw Error('Page exceeds document length') }
  const page = doc.loadPage(pageNumber - 1)
  const responsePath = output + '.responses.json', responses = fs.existsSync(responsePath) ? JSON.parse(fs.readFileSync(responsePath, 'utf8')) : {}
  const responseKey = request => hash(JSON.stringify([1, pdfHash, pageNumber, record.inputHash, 'low', request.region, areaRecognitionPrompt(request)]))
  let calls = 0
  const recognize = async request => {
    calls++
    const pageBounds = page.getBounds(), pageWidth = pageBounds[2] - pageBounds[0]
    const scale = record.input.imageWidth * record.input.feetPerImagePx / pageWidth / .01
    const crop = renderPdfRegion(mupdf, page, { region: request.region, scale, maximumDimension: 2000 })
    const registered = registerRecognitionImage(request, crop.region), data = Buffer.from(crop.data)
    const annotated = await sharp(data).composite([{ input: Buffer.from(recognitionOverlaySvg(registered, crop.width, crop.height)) }]).png().toBuffer()
    fs.writeFileSync(output + `.crop-${calls}.png`, annotated)
    const answer = await runDrawingsVisionObject({
      orgId: process.env.ARC_RECOGNITION_ORG_ID, entityType: 'architectural_diagnostic', schema: visualInterpretationProviderSchema,
      images: [{ data, mediaType: 'image/png' }, { data: annotated, mediaType: 'image/png' }], prompt: areaRecognitionPrompt(registered),
      tier: 'standard', reasoningEffort: 'low', allowFallback: false, allowEscalation: false, timeoutMs: 45000,
    })
    if (answer) { responses[responseKey(request)] = answer; fs.writeFileSync(responsePath, JSON.stringify(responses, null, 2)) }
    return answer
  }
  recognize.cached = async request => responses[responseKey(request)] ?? null
  let report
  const started = Date.now()
  try { report = await reinspectArchitecture(record.input, architecture, recognize, budget) }
  finally { page.destroy(); doc.destroy() }
  const alternativeInput = reinspectionAlternative(record.input, report)
  // Never upgrade incomplete source coverage because a local repair succeeded.
  const alternative = await runAreaEngine(alternativeInput, { wholeSheet: record.wholeSheet, recordedRecognition: baseline.recognition === 'partial' || baseline.recognition === 'unavailable' ? baseline.recognition : undefined })
  const summarize = result => {
    const architecture = result.detection.architecture, building = architecture.building
    const level = buildingToFloorplan({ ...record.input, sheetVersionId: '00000000-0000-4000-8000-000000000001', sheetNumber: null, sheetTitle: 'Reinspection diagnostic', name: 'Floor', order: 0, scaleConfirmed: true }, architecture)
    const model = { version: 1, units: 'feet', levels: [level], correctionCount: 0 }, schema = floorplanModelSchema.safeParse(model)
    return { walls: building.walls.length, openings: building.openings, rooms: level.rooms.map(r => ({ label: r.label, areaSqft: r.areaSqft })), recognition: result.recognition, reconstructionIssues: building.issues, schemaIssues: schema.success ? [] : schema.error.issues, validationIssues: validateArchitecturalModel(model) }
  }
  fs.writeFileSync(output, JSON.stringify({ qualification, source: record.source, sourceReplayHash: record.inputHash, elapsedMs: Date.now() - started, networkCalls: calls, report, baseline: summarize(baseline), alternative: summarize(alternative), releaseReady: false }, null, 2))
  fs.writeFileSync(output + '.alternative-replay.json', JSON.stringify(createAreaReplay(alternativeInput, record.wholeSheet, record.source, alternative.recognition)))
  console.log(JSON.stringify({ output, targets: report.attempts.length, changes: report.changes.length, networkCalls: calls, elapsedMs: Date.now() - started }))
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
