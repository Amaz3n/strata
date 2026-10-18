#!/usr/bin/env node
require('./register-ts-node-test')
const fs = require('node:fs')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const {verifyReferenceReview}=require('./check-area-reference')
const {assertNotHoldout}=require('./holdout-guard')
const {evaluateGeometryQualification,currentEngineFingerprint}=require('./area-release-policy')
const {evaluateEstimatorTrial}=require('./area-estimator-trial')
const {detectSheetAreas}=require('../lib/drawings/area-sheet')
const { AREA_ENGINE_VERSION, detectAreas, containsPoint, proposalArea, validateAreaGeometry } = require('../lib/drawings/area-takeoff')

/** Raster IoU is only a matching metric; quantity error uses exact polygon area. */
function mask(area, size = 192) {
  const result = new Uint8Array(size * size)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const p = [(x + .5) / size, (y + .5) / size]
    if (containsPoint(p, area.points) && !(area.holes ?? []).some((h) => containsPoint(p, h))) result[y * size + x] = 1
  }
  return result
}
function overlap(a, b) {
  let intersection = 0, union = 0, aSize = 0, bSize = 0
  for (let i = 0; i < a.length; i++) { intersection += a[i] && b[i] ? 1 : 0; union += a[i] || b[i] ? 1 : 0; aSize += a[i]; bSize += b[i] }
  return { iou: union ? intersection / union : 0, truthCoverage: bSize ? intersection / bSize : 0, predictionCoverage: aSize ? intersection / aSize : 0 }
}
function boundaryError(prediction, truth, sx, sy) {
  const errors = []
  const edges = (area) => [area.points, ...(area.holes ?? [])].flatMap((ring) => ring.map((a, i) => [a, ring[(i + 1) % ring.length]].map(([x,y])=>[x*sx,y*sy])))
  const measure = (source, target) => {
    for (const [a,b] of source) {
      const steps = Math.max(1, Math.ceil(Math.hypot(a[0]-b[0],a[1]-b[1]) / .25))
      for (let k = 0; k <= steps; k++) {
        const x=a[0]+(b[0]-a[0])*k/steps, y=a[1]+(b[1]-a[1])*k/steps
        errors.push(Math.min(...target.map(([c,d])=>{
          const dx=d[0]-c[0],dy=d[1]-c[1],ls=dx*dx+dy*dy
          const t=ls?Math.max(0,Math.min(1,((x-c[0])*dx+(y-c[1])*dy)/ls)):0
          return Math.hypot(x-c[0]-t*dx,y-c[1]-t*dy)
        })))
      }
    }
  }
  const a=edges(prediction), b=edges(truth); measure(a,b);measure(b,a);errors.sort((a,b)=>a-b)
  return { p95Feet: errors[Math.floor(errors.length*.95)] ?? null, maxFeet: errors.at(-1) ?? null }
}
function scoreFixture(fixture, suppliedPredictions) {
  for(const value of [fixture.input.imageWidth,fixture.input.imageHeight,fixture.input.feetPerImagePx])if(!Number.isFinite(value)||value<=0)throw new Error('Benchmark dimensions and calibration must be positive and finite')
  const started=performance.now()
  const detected=suppliedPredictions ?? (fixture.detectionMode==='whole-sheet'?detectSheetAreas(fixture.input):detectAreas(fixture.input)).proposals
  const elapsedMs=performance.now()-started
  const truth=fixture.truth?.areas ?? []
  for(const area of [...detected,...truth]){
    validateAreaGeometry({...area,holes:area.holes??[]})
    if([area.points,...(area.holes??[])].some(r=>r.some(p=>p.length!==2||p.some(n=>n<0||n>1))))throw new Error('Benchmark geometry must stay on the normalized source sheet')
  }
  // Match in a pair-local frame. A whole-sheet 192px mask can erase a small
  // closet entirely, falsely reporting a miss even for an identical polygon.
  const bounds=area=>({x0:Math.min(...area.points.map(p=>p[0])),y0:Math.min(...area.points.map(p=>p[1])),x1:Math.max(...area.points.map(p=>p[0])),y1:Math.max(...area.points.map(p=>p[1]))})
  const pb=detected.map(bounds),tb=truth.map(bounds)
  const candidates=detected.flatMap((p,i)=>truth.map((t,j)=>{
    const a=pb[i],b=tb[j]
    if(Math.min(a.x1,b.x1)<=Math.max(a.x0,b.x0)||Math.min(a.y1,b.y1)<=Math.max(a.y0,b.y0))return {prediction:i,truth:j,iou:0,truthCoverage:0,predictionCoverage:0}
    const x0=Math.min(a.x0,b.x0),y0=Math.min(a.y0,b.y0),w=Math.max(a.x1,b.x1)-x0,h=Math.max(a.y1,b.y1)-y0
    const local=area=>{const ring=r=>r.map(([x,y])=>[(x-x0)/w,(y-y0)/h]);return {points:ring(area.points),holes:(area.holes??[]).map(ring)}}
    return {prediction:i,truth:j,...overlap(mask(local(p)),mask(local(t)))}
  }))
  const usedP=new Set(),usedT=new Set(),matches=[]
  for (const c of [...candidates].sort((a,b)=>b.iou-a.iou)) {
    if(c.iou<.5||usedP.has(c.prediction)||usedT.has(c.truth))continue
    usedP.add(c.prediction);usedT.add(c.truth)
    const p=detected[c.prediction], t=truth[c.truth], input=fixture.input
    const pa=proposalArea(p,input.imageWidth,input.imageHeight,input.feetPerImagePx)
    // Area and boundary gates must describe the same reference geometry.
    // Printed totals belong in a separate check, never an overriding scalar.
    const ta=proposalArea({...t,holes:t.holes??[]},input.imageWidth,input.imageHeight,input.feetPerImagePx)
    matches.push({...c,label:t.label,areaErrorPct:100*Math.abs(pa-ta)/ta,predictedSqft:pa,truthSqft:ta,
      boundary:boundaryError(p,t,input.imageWidth*input.feetPerImagePx,input.imageHeight*input.feetPerImagePx)})
  }
  return {name:fixture.name,project:fixture.project,kind:fixture.kind,split:fixture.split,annotationStatus:fixture.annotationStatus,sourceCategory:fixture.sourceCategory,source:fixture.source,detectionMode:fixture.detectionMode??'region',elapsedMs,
    truthRooms:truth.length,proposedRooms:detected.length,matched:matches.length,
    unmatchedReferences:truth.flatMap((t,j)=>{
      if(usedT.has(j))return []
      const best=candidates.filter(c=>c.truth===j).sort((a,b)=>b.truthCoverage-a.truthCoverage)[0]
      return [{label:t.label,status:best?.truthCoverage>=.95?'contained-in-larger-zone':best?.truthCoverage>.1?'partial-overlap':'missing',bestProposalLabel:best?.truthCoverage>0?detected[best.prediction].label:null,referenceCoverage:best?.truthCoverage??0}]
    }),
    referenceCompleteness:fixture.annotation?.completeness??(fixture.kind==='original-pdf'?'unspecified':'complete'),
    missed:truth.length-usedT.size,falsePositives:fixture.kind==='original-pdf'&&fixture.annotation?.completeness!=='complete'?null:detected.length-usedP.size,
    merged:detected.filter((_p,i)=>candidates.filter((c)=>c.prediction===i&&c.truthCoverage>.5).length>1).length,
    splitRooms:truth.filter((_t,j)=>candidates.filter((c)=>c.truth===j&&c.predictionCoverage>.5).length>1).length,
    withinTwoPercent:matches.filter((m)=>m.areaErrorPct<=2).length,
    worstAreaErrorPct:matches.length?Math.max(...matches.map((m)=>m.areaErrorPct)):null,matches}
}

const SOURCE_CATEGORIES=['layered-vector','flattened-vector','outlined-text','raster']
function validateCorpus(fixtures) {
  const projectSplits=new Map(),sources=new Map(),pages=new Set()
  for(const fixture of fixtures) {
    if(!fixture.project||fixture.project==='REPLACE_WITH_PROJECT_ID'||!['development','holdout'].includes(fixture.split))throw new Error(`${fixture.name}: a real project and split are required`)
    if(projectSplits.has(fixture.project)&&projectSplits.get(fixture.project)!==fixture.split)throw new Error(`Project leakage: ${fixture.project} appears in development and holdout`)
    projectSplits.set(fixture.project,fixture.split)
    if(fixture.kind!=='original-pdf')continue
    if(fixture.annotationStatus==='independently-checked')verifyReferenceReview(fixture)
    const source=fixture.source??{},hash=source.sha256
    if(!/^[a-f0-9]{64}$/.test(hash??'')||!Number.isInteger(source.page)||source.page<1)throw new Error(`${fixture.name}: original PDF hash and page are required`)
    if(sources.has(hash)&&sources.get(hash)!==fixture.project)throw new Error('Source leakage: one PDF is assigned to different projects')
    sources.set(hash,fixture.project)
    const key=`${hash}:${source.page}`
    if(pages.has(key))throw new Error('Duplicate original PDF page in corpus')
    pages.add(key)
    if(fixture.split==='holdout'&&(!SOURCE_CATEGORIES.includes(fixture.sourceCategory)||fixture.detectionMode!=='whole-sheet'))throw new Error(`${fixture.name}: holdouts require a source category and whole-sheet detection`)
  }
}

function run(directory, release = false, predictionsDirectory = null, profileName = 'all-sources', trial = null) {
  // Validate the requested profile before loading or executing the corpus.
  evaluateGeometryQualification([],profileName)
  const engineFingerprint=currentEngineFingerprint()
  const files=fs.readdirSync(directory).filter((f)=>f.endsWith('.json')).sort()
  const fixtures=files.map((f)=>JSON.parse(fs.readFileSync(path.join(directory,f),'utf8')))
  validateCorpus(fixtures)
  if(!predictionsDirectory)for(const [i,f] of fixtures.entries())if(f.source?.sha256)assertNotHoldout({sha256:f.source.sha256,label:files[i],script:'benchmark-area-takeoff',gate:process.argv.includes('--gate'),engine:AREA_ENGINE_VERSION})
  const results=fixtures.map((f,i)=>{
    try{
      const predicted=predictionsDirectory?JSON.parse(fs.readFileSync(path.join(predictionsDirectory,files[i]),'utf8')).areas:undefined
      if(predictionsDirectory&&!Array.isArray(predicted))throw new Error('Model output must contain an areas array')
      return scoreFixture(f,predicted)
    }catch(error){return {name:f.name,project:f.project,kind:f.kind,split:f.split,annotationStatus:f.annotationStatus,sourceCategory:f.sourceCategory,source:f.source,error:error.message}}
  })
  const qualification=evaluateGeometryQualification(results,profileName)
  const estimatorTrial=evaluateEstimatorTrial(trial,fixtures,profileName,AREA_ENGINE_VERSION,scoreFixture,engineFingerprint)
  const sourceUnchanged=engineFingerprint===currentEngineFingerprint()
  const report={engine:AREA_ENGINE_VERSION,engineFingerprint,sourceUnchanged,predictionMode:predictionsDirectory?'supplied-diagnostic':'current-engine',matching:'192×192 pair-local raster IoU ≥0.5; exact polygon area; boundary samples every 0.25 ft',
    ...qualification,estimatorTrial,releaseReady:sourceUnchanged&&!predictionsDirectory&&qualification.geometryGatePassed&&estimatorTrial.passed,releaseReason:!sourceUnchanged?'Engine source changed during scoring; rerun from a frozen build.':predictionsDirectory?'Supplied predictions are diagnostic and cannot qualify the current engine.':qualification.geometryGatePassed?(estimatorTrial.passed?'Geometry and corrected-quantity/time trial gates passed for the selected profile.':'Geometry gate passed for the selected profile; estimator trial has not passed'):'Requires ≥50 independently checked held-out original PDF pages across ≥3 projects, ≥10 sheets per supported source category, ≥98% reference-room recall per category (≥95% on every sheet), ≥3 projects per category and ≥95% within 2% area per category, with no false positives, merges or splits and strict boundary-distance limits. Estimator timing trial also required.',results}
  process.stdout.write(JSON.stringify(report,null,2)+'\n')
  if(release&&!report.releaseReady)process.exitCode=1
  return report
}
if(require.main===module){
  const args=process.argv.slice(2), directory=args[0]&&!args[0].startsWith('--')?args[0]:path.join(__dirname,'../tests/fixtures/area-takeoff')
  const modelIndex=args.indexOf('--predictions')
  const profileIndex=args.indexOf('--profile')
  if(profileIndex>=0&&(!args[profileIndex+1]||args[profileIndex+1].startsWith('--')))throw Error('Provide a qualification profile after --profile')
  const trialIndex=args.indexOf('--trial')
  if(trialIndex>=0&&(!args[trialIndex+1]||args[trialIndex+1].startsWith('--')))throw Error('Provide a trial JSON file after --trial')
  const trial=trialIndex>=0?JSON.parse(fs.readFileSync(args[trialIndex+1],'utf8')):null
  run(directory,args.includes('--release'),modelIndex>=0?args[modelIndex+1]:null,profileIndex>=0?args[profileIndex+1]:'all-sources',trial)
}
module.exports={scoreFixture,run,validateCorpus}
