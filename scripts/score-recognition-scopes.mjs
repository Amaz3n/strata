#!/usr/bin/env node
/** Local, development-only, frozen-region diagnostic. Never a release gate. */
import fs from 'node:fs'
import path from 'node:path'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {loadFrozenReference,adaptReference,adaptPrediction,scoreScopedRoomGeometry,scoreScopedOpeningGeometry,sha256} from './recognition-reference-adapter.mjs'
import {scoreWalls} from './recognition-metrics.mjs'
const require=createRequire(import.meta.url)
require('./register-ts-node-test.js')
const {replayAreaDetection}=require('../lib/drawings/area-replay')
const {buildingToFloorplan}=require('../lib/drawings/building-floorplan')
const {currentEngineFingerprint}=require('./area-release-policy.js')
const {AREA_ENGINE_VERSION}=require('../lib/drawings/area-takeoff')
const toolingFiles=['scripts/recognition-reference-adapter.mjs','scripts/recognition-metrics.mjs','scripts/score-recognition-scopes.mjs','docs/takeoff-evaluation.md']
const toolingFingerprint=()=>sha256(toolingFiles.map(f=>`${f}:${sha256(fs.readFileSync(new URL('../'+f,import.meta.url)))}`).join('\n'))
export function validateManifest(manifest){
  if(manifest.protocolVersion!=='1.0.0'||!Array.isArray(manifest.cases)||!manifest.cases.length)throw Error('Protocol 1.0.0 and nonempty cases required')
  // Check every split before reading ANY source or creating output.
  if(manifest.cases.some(c=>c.split!=='development'))throw Error('Scoped diagnostic accepts development manifests only; do not expose holdouts')
  const ids=new Set()
  for(const c of manifest.cases){if(!/^[a-z0-9-]+$/.test(c.id)||ids.has(c.id)||typeof c.projectId!=='string'||!c.projectId||typeof c.regionId!=='string'||typeof c.sourceCategory!=='string'||![c.referenceSha256,c.replaySha256,c.diagnosticSha256].every(h=>/^[a-f0-9]{64}$/.test(h)))throw Error('Invalid frozen case identity');ids.add(c.id)}
}
export async function score(manifestFile,outputDirectory){
  const manifestBytes=fs.readFileSync(manifestFile),manifest=JSON.parse(manifestBytes)
  validateManifest(manifest)
  if(fs.existsSync(outputDirectory))throw Error('Use a new output directory; preserve immutable score reports')
  const engineFingerprint=currentEngineFingerprint(),scorerFingerprint=toolingFingerprint()
  const frozen=manifest.cases.map(item=>{
    const raw=loadFrozenReference(item),reference=adaptReference(raw,item.regionId),bytes=fs.readFileSync(item.replayFile)
    if(sha256(bytes)!==item.replaySha256)throw Error(`Frozen replay changed: ${item.id}`)
    const replay=JSON.parse(bytes),diagnosticBytes=fs.readFileSync(item.diagnosticFile)
    if(sha256(diagnosticBytes)!==item.diagnosticSha256)throw Error(`Frozen diagnostic changed: ${item.id}`)
    const diagnostic=JSON.parse(diagnosticBytes)
    if(diagnostic.source?.page!==raw.source.page||diagnostic.source?.sha256!==raw.source.sha256||diagnostic.evidenceFingerprint!==sha256(JSON.stringify(replay.input.evidence))||diagnostic.calibration!==replay.input.feetPerImagePx)throw Error('Replay page/evidence/calibration must match the frozen source diagnostic')
    if(replay.source?.sourceHash!==raw.source.sha256||!replay.wholeSheet)throw Error('Replay must identify the frozen source and preserve whole-sheet context')
    return{item,raw,reference,replay,diagnostic}
  })
  fs.mkdirSync(outputDirectory,{recursive:true})
  fs.writeFileSync(path.join(outputDirectory,'manifest.json'),manifestBytes,{flag:'wx'})
  const tooling=toolingFiles.map(file=>({file,sha256:sha256(fs.readFileSync(new URL('../'+file,import.meta.url)))}))
  for(const entry of tooling){const target=path.join(outputDirectory,'tooling',entry.file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,fs.readFileSync(new URL('../'+entry.file,import.meta.url)),{flag:'wx'})}
  fs.writeFileSync(path.join(outputDirectory,'tooling-sha256.json'),JSON.stringify(tooling,null,2)+'\n',{flag:'wx'})
  const results=[]
  for(const {item,raw,reference,replay,diagnostic} of frozen){
    const start=performance.now()
    const base={caseId:item.id,projectId:item.projectId,split:item.split,sourceCategory:item.sourceCategory,source:raw.source,referenceSha256:item.referenceSha256,replaySha256:item.replaySha256,diagnosticSha256:item.diagnosticSha256,
      protocolVersion:manifest.protocolVersion,engine:AREA_ENGINE_VERSION,engineFingerprint,scorerFingerprint,scopeId:reference.scopeId,provenance:raw.provenance,
      strictPhysicalQualification:reference.strictPhysicalQualification,referenceUncertainty:reference.referenceUncertainty,externalContext:reference.externalContext,releaseReady:false,
      qualifiedProjects:0,wholeProjectQualified:false,interpretation:'Partial source-only AI-adjudicated development regions; nominal geometry diagnostics are not physical accuracy certification or held-out release qualification'}
    let result
    try{
      const run=await replayAreaDetection(replay,{compareCurrentEngine:true}),level=buildingToFloorplan({...replay.input,sheetVersionId:'00000000-0000-4000-8000-000000000001',sheetNumber:raw.source.sheet,sheetTitle:raw.source.sheet,name:'Diagnostic',order:0,scaleConfirmed:false},run.detection.architecture)
      const prediction=adaptPrediction(level,reference)
      result={...base,status:'nominal-scored',elapsedMs:performance.now()-start,route:{recordedMode:diagnostic.mode,recordedRecognition:replay.recognition,currentRecognition:run.recognition,evidenceKind:replay.input.evidence?.raster?'raster':replay.input.evidence?'vector':null,
        extractionProfile:replay.input.evidence?.extractionProfile??null,rasterEvidence:!!replay.input.evidence?.raster,recognitionRegion:replay.input.region,
        liveProviderUsed:false,productionRasterPathQualified:false,notes:replay.input.evidence?.raster?'Local raster evidence replay; any recorded semantic observations are reused, with no live provider calls. A development crop does not qualify whole-plan scan recognition.':item.sourceCategory==='native-raster'?'Stored vector-only diagnostic does not exercise production native-raster recognition':'Local replay; no provider calls or source upload'},
        calibration:prediction.calibration,scopePolicy:prediction.scopePolicy,excludedCounts:prediction.excludedCounts,
        nominalWalls:scoreWalls(reference.walls,prediction.walls),nominalOpenings:scoreScopedOpeningGeometry(reference,prediction),nominalRoomGeometry:scoreScopedRoomGeometry(reference.rooms,prediction.rooms),
        reconstructionStatus:level.reconstruction.status,reconstructionIssues:level.reconstruction.issues,referenceGeometry:reference,predictionGeometry:prediction}
      fs.writeFileSync(path.join(outputDirectory,item.id+'.model.json'),JSON.stringify({version:1,units:'feet',levels:[level],correctionCount:0},null,2)+'\n',{flag:'wx'})
    }catch(error){result={...base,status:'failed',error:error.message,elapsedMs:performance.now()-start}}
    fs.writeFileSync(path.join(outputDirectory,item.id+'.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});results.push(result)
  }
  const unchanged=currentEngineFingerprint()===engineFingerprint&&toolingFingerprint()===scorerFingerprint
  const summary={protocolVersion:manifest.protocolVersion,manifestSha256:sha256(manifestBytes),engine:AREA_ENGINE_VERSION,engineFingerprint,scorerFingerprint,fingerprintsUnchanged:unchanged,
    qualifiedProjects:0,lockedHoldoutProjects:0,releaseReady:false,strictPhysicalQualification:'unverified',confidenceIntervals:null,
    reason:'Partial development regions cannot establish project distributions or release gates; uncertainty and external adjacency remain unverified',
    results:results.map(r=>({caseId:r.caseId,projectId:r.projectId,status:r.status,error:r.error,route:r.route,calibration:r.calibration,wallPrecision:r.nominalWalls?.precision,wallRecall:r.nominalWalls?.recall,openingPrecision:r.nominalOpenings?.precision,openingRecall:r.nominalOpenings?.recall,roomGeometryRecall:r.nominalRoomGeometry?.nominalGeometryRecall,roomAdjacency:r.nominalRoomGeometry?.adjacencyStatus,strictPhysicalQualification:r.strictPhysicalQualification,elapsedMs:r.elapsedMs}))}
  fs.writeFileSync(path.join(outputDirectory,'summary.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'})
  if(!unchanged)throw Error('Engine or scoring protocol changed during execution; results are invalid')
  return summary
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){const [, ,manifest,output]=process.argv;if(!manifest||!output)throw Error('Usage: node scripts/score-recognition-scopes.mjs MANIFEST OUTPUT_DIRECTORY');score(manifest,output).then(r=>{console.log(JSON.stringify(r,null,2));if(r.results.some(r=>r.status==='failed'))process.exitCode=1}).catch(e=>{console.error(e);process.exitCode=1})}
