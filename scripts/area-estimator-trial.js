/** Evaluate a recorded, paired estimator trial against independently checked
 * references. Geometry is scored here; elapsed times remain human observations. */
const {PROFILES,currentEngineFingerprint}=require('./area-release-policy')
const {referenceDigest,verifyReferenceReview}=require('./check-area-reference')
const median=values=>{const a=[...values].sort((x,y)=>x-y);return a.length?a.length%2?a[Math.floor(a.length/2)]:(a[a.length/2-1]+a[a.length/2])/2:null}
function evaluateEstimatorTrial(trial,fixtures,profileName,engine,score,engineFingerprint=currentEngineFingerprint()){
 const profile=PROFILES[profileName];if(!profile)throw Error('Unknown qualification profile')
 const result={passed:false,minimumSheetsPerCategory:5,maximumMedianTimeRatio:.8,maximumP95TimeRatio:1.25,errors:[],categoryResults:[],samples:[]}
 if(!trial){result.errors.push('No estimator trial supplied.');return result}
 if(trial.engineFingerprint!==engineFingerprint||trial.engine!==engine||trial.profile!==profileName||trial.timingConvention!=='end-to-end-including-review-correction'||!Array.isArray(trial.samples)||trial.samples.length>1000){result.errors.push('Trial engine/build fingerprint, profile, timing convention or samples are invalid.');return result}
 const key=source=>`${source?.sha256}:${source?.page}`
 const references=new Map(fixtures.filter(f=>f.kind==='original-pdf'&&f.split==='holdout'&&f.annotationStatus==='independently-checked'&&profile.categories.includes(f.sourceCategory)).map(f=>[key(f.source),f]))
 const seen=new Set(),operators=new Map()
 for(const [index,s] of trial.samples.entries()){
  try{
   const k=key(s.source),f=references.get(k)
   if(!f||seen.has(k))throw Error('Missing qualified reference or duplicate source page')
   seen.add(k);verifyReferenceReview(f)
   if(s.referenceSha256!==referenceDigest(f))throw Error('Reference source, scope, geometry or calibration changed')
   const names=['manualOperator','assistedOperator','reviewer'].map(field=>typeof s[field]==='string'?s[field].trim().toLowerCase():'')
   if(names.some(n=>!n)||new Set(names).size!==3||s.sourceAndScopeChecked!==true)throw Error('Distinct manual/assisted operators and an independent source/scope reviewer are required')
   for(const t of [s.manualSeconds,s.assistedSeconds])if(!Number.isFinite(t)||t<=0||t>86400)throw Error('Record positive full-workflow elapsed seconds, at most one day')
   for(const field of ['manualAreas','assistedAreas']){
    if(!Array.isArray(s[field])||!s[field].length||s[field].length>1000)throw Error('Both final area sets are required')
    const scored=score(f,s[field])
    if(scored.matched!==scored.truthRooms||scored.withinTwoPercent!==scored.truthRooms||scored.falsePositives!==0||scored.merged||scored.splitRooms||scored.matches.some(m=>m.boundary.p95Feet>.125||m.boundary.maxFeet>.5))throw Error(`${field} does not pass final corrected-quantity checks`)
   }
   for(const [i,mode] of [[0,'manual'],[1,'assisted']]){const roles=operators.get(names[i])??new Set();roles.add(mode);operators.set(names[i],roles)}
   result.samples.push({source:s.source,project:f.project,category:f.sourceCategory,manualSeconds:s.manualSeconds,assistedSeconds:s.assistedSeconds,timeRatio:s.assistedSeconds/s.manualSeconds})
  }catch(error){result.errors.push(`Sample ${index+1}: ${error.message}`)}
 }
 for(const category of profile.categories){
  const rows=result.samples.filter(r=>r.category===category),ratios=rows.map(r=>r.timeRatio).sort((a,b)=>a-b),middle=median(ratios),p95=ratios[Math.max(0,Math.ceil(ratios.length*.95)-1)]??null
  result.categoryResults.push({category,sheets:rows.length,medianTimeRatio:middle,p95TimeRatio:p95,passed:rows.length>=5&&middle<=.8&&p95<=1.25})
 }
 if(new Set(result.samples.map(r=>r.project)).size<3)result.errors.push('Trial needs at least three projects.')
 if(operators.size<2||[...operators.values()].some(roles=>roles.size!==2))result.errors.push('Counterbalance operators across manual and assisted modes on different sheets.')
 result.passed=!result.errors.length&&result.categoryResults.every(c=>c.passed)
 return result
}
module.exports={evaluateEstimatorTrial}
