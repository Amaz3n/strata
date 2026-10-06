/** Frozen qualification thresholds. Detection counts and label coverage are not
 * reference accuracy. Profiles describe a release scope, never infer support. */
const PROFILES = Object.freeze({
  'all-sources':Object.freeze({categories:['layered-vector','flattened-vector','outlined-text','raster'],minimumSheets:50,minimumProjects:3,minimumSheetsPerCategory:10}),
  'vector-plan':Object.freeze({categories:['layered-vector','flattened-vector'],minimumSheets:50,minimumProjects:3,minimumSheetsPerCategory:10}),
})
function evaluateGeometryQualification(results,profileName='all-sources'){
 const profile=PROFILES[profileName]
 if(!profile)throw Error(`Unknown qualification profile: ${profileName}`)
 const originals=results.filter(r=>r.kind==='original-pdf'&&r.split==='holdout'&&r.annotationStatus==='independently-checked'&&profile.categories.includes(r.sourceCategory))
 const validCount=n=>Number.isInteger(n)&&n>=0
 const valid=r=>!r.error&&validCount(r.truthRooms)&&r.truthRooms>0&&validCount(r.matched)&&r.matched<=r.truthRooms&&r.matched/r.truthRooms>=.95&&validCount(r.withinTwoPercent)&&r.withinTwoPercent<=r.matched&&Array.isArray(r.matches)&&r.matches.length===r.matched&&[r.merged,r.splitRooms,r.falsePositives].every(n=>n===0)&&r.matches.every(m=>Number.isFinite(m.boundary?.p95Feet)&&m.boundary.p95Feet>=0&&m.boundary.p95Feet<=.125&&Number.isFinite(m.boundary?.maxFeet)&&m.boundary.maxFeet>=m.boundary.p95Feet&&m.boundary.maxFeet<=.5)
 const summarize=samples=>{
  const truthRooms=samples.reduce((n,r)=>n+(validCount(r.truthRooms)?r.truthRooms:0),0)
  const matched=samples.reduce((n,r)=>n+(validCount(r.matched)?r.matched:0),0)
  const withinTwoPercent=samples.reduce((n,r)=>n+(validCount(r.withinTwoPercent)?r.withinTwoPercent:0),0)
  return {sheets:samples.length,projects:new Set(samples.map(r=>r.project)).size,truthRooms,matched,withinTwoPercent,roomRecall:truthRooms?matched/truthRooms:0,accurateRoomFraction:truthRooms?withinTwoPercent/truthRooms:0}
 }
 const categoryResults=profile.categories.map(category=>{
  const samples=originals.filter(r=>r.sourceCategory===category),stats=summarize(samples)
  return {category,...stats,passed:stats.sheets>=profile.minimumSheetsPerCategory&&stats.projects>=profile.minimumProjects&&stats.roomRecall>=.98&&stats.accurateRoomFraction>=.95&&samples.every(valid)}
 })
 const overall=summarize(originals)
 return {profile:profileName,supportedSourceCategories:[...profile.categories],thresholds:{...profile,minimumRoomRecall:.98,minimumSheetRoomRecall:.95,minimumAccurateRoomFraction:.95,maximumBoundaryP95Feet:.125,maximumBoundaryFeet:.5,maximumFalsePositives:0,maximumMerges:0,maximumSplits:0},overall,categoryResults,
  geometryGatePassed:overall.sheets>=profile.minimumSheets&&overall.projects>=profile.minimumProjects&&overall.roomRecall>=.98&&overall.accurateRoomFraction>=.95&&categoryResults.every(c=>c.passed)&&originals.every(valid)}
}
function currentEngineFingerprint(){
 const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto'),root=path.resolve(__dirname,'..')
 const files=[...fs.readdirSync(path.join(root,'lib/drawings')).filter(f=>f.endsWith('.ts')).map(f=>'lib/drawings/'+f),'lib/services/area-evidence-extract.ts','lib/services/architectural-raster.ts','lib/services/architectural-evidence.ts','lib/services/architectural-recognition.ts','lib/storage/drawings-tiles-storage.ts','lib/services/area-takeoff.ts','lib/services/floorplan-models.ts','lib/services/original-sheet-raster.ts','lib/services/mupdf-loader.ts','lib/services/drawings-sheet-images.ts','lib/services/local-raster-text.ts','lib/services/ocr/raster-text-process.cjs','next.config.mjs','lib/validation/drawings.ts','lib/validation/floorplan.ts','scripts/area-release-policy.js','scripts/register-ts-node-test.js','package.json','pnpm-lock.yaml'].sort()
 return createHash('sha256').update(files.map(file=>file+':'+createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')).join('\n')).digest('hex')
}
module.exports={evaluateGeometryQualification,PROFILES,currentEngineFingerprint}
