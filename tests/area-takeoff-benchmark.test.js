require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {scoreFixture}=require('../scripts/benchmark-area-takeoff')
const rect=(a,b,c,d)=>[[a,b],[c,b],[c,d],[a,d]]
const fixture={name:'metrics',project:'synthetic',kind:'synthetic',split:'development',input:{imageWidth:1000,imageHeight:1000,feetPerImagePx:.02},truth:{areas:[{label:'Left',points:rect(.1,.1,.5,.9),holes:[]},{label:'Right',points:rect(.5,.1,.9,.9),holes:[]}]}}
test('benchmark distinguishes correct rooms, merges, misses, splits and false positives',()=>{
 const perfect=scoreFixture(fixture,fixture.truth.areas)
 assert.equal(perfect.withinTwoPercent,2);assert.equal(perfect.falsePositives,0);assert.equal(perfect.missed,0)
 const merged=scoreFixture(fixture,[{points:rect(.1,.1,.9,.9),holes:[]}])
 assert.equal(merged.merged,1);assert.equal(merged.missed,1)
 const split=scoreFixture({...fixture,truth:{areas:[{label:'Whole',points:rect(.1,.1,.9,.9),holes:[]}]}},fixture.truth.areas)
 assert.equal(split.splitRooms,1)
 const extra=scoreFixture(fixture,[...fixture.truth.areas,{points:rect(.01,.01,.05,.05),holes:[]}])
 assert.equal(extra.falsePositives,1)
})
test('a displaced polygon cannot pass merely because its area is identical',()=>{
 const result=scoreFixture({...fixture,truth:{areas:[fixture.truth.areas[0]]}},[{points:rect(.12,.1,.52,.9),holes:[]}])
 assert.equal(result.withinTwoPercent,1)
 assert.ok(result.matches[0].boundary.maxFeet>.39)
 assert.ok(result.matches[0].iou<1)
})

test('qualification cannot count duplicate PDF pages or relabel a development source as another project',()=>{
 const {validateCorpus}=require('../scripts/benchmark-area-takeoff')
 const original={...fixture,kind:'original-pdf',source:{sha256:'a'.repeat(64),page:1},detectionMode:'whole-sheet',sourceCategory:'layered-vector'}
 assert.doesNotThrow(()=>validateCorpus([original,{...original,source:{...original.source,page:2}}]))
 assert.throws(()=>validateCorpus([original,original]),/Duplicate/)
 assert.throws(()=>validateCorpus([original,{...original,project:'another',split:'holdout'}]),/Source leakage/)
 assert.throws(()=>validateCorpus([{...original,source:{page:1}}]),/hash/)
 assert.throws(()=>validateCorpus([{...original,split:'holdout',detectionMode:'region'}]),/whole-sheet/)
})
test('invalid predicted geometry cannot receive an accuracy score',()=>{
 assert.throws(()=>scoreFixture(fixture,[{points:[[.1,.1],[.9,.9],[.1,.9],[.9,.1]],holes:[]}]),/invalid/)
})

test('independent reference review is bound to source, geometry, scope and calibration',()=>{
 const {attestReference,verifyReferenceReview,validateReference}=require('../scripts/check-area-reference')
 const original={...fixture,kind:'original-pdf',source:{sha256:'c'.repeat(64),page:1},sourceCategory:'layered-vector',detectionMode:'whole-sheet',annotationStatus:'human-annotated',annotation:{annotator:'Annotator',scope:'Net finish faces; fixtures excluded.',method:'manual-source-tracing-without-detector-prefill',completeness:'complete'}}
 assert.doesNotThrow(()=>validateReference(original))
 assert.throws(()=>attestReference(original,'Annotator',true),/self-attested/)
 assert.throws(()=>attestReference(original,'Reviewer',false),/only after/)
 const checked=attestReference(original,'Reviewer',true)
 assert.doesNotThrow(()=>verifyReferenceReview(checked))
 for(const changed of [
  {...checked,input:{...checked.input,feetPerImagePx:.03}},
  {...checked,source:{...checked.source,page:2}},
  {...checked,annotation:{...checked.annotation,scope:'Different finish convention'}},
  {...checked,truth:{areas:[fixture.truth.areas[0]]}},
 ])assert.throws(()=>verifyReferenceReview(changed),/stale/)
 assert.throws(()=>validateReference({...original,truth:{areas:[{label:'Outside',points:rect(-.1,.1,.2,.2),holes:[]}]}}),/normalized/)
 const {validateCorpus}=require('../scripts/benchmark-area-takeoff')
 assert.throws(()=>attestReference({...original,annotation:{...original.annotation,completeness:'partial'}},'Reviewer',true),/partial reference/)
 assert.doesNotThrow(()=>validateCorpus([checked]))
 assert.throws(()=>validateCorpus([{...original,annotationStatus:'independently-checked'}]),/review/)
})

test('benchmark recomputes reference quantity and rejects off-sheet geometry or invalid calibration',()=>{
 const misleading={...fixture,truth:{areas:fixture.truth.areas.map(a=>({...a,areaSqft:-100}))}}
 const result=scoreFixture(misleading,fixture.truth.areas)
 assert.equal(result.withinTwoPercent,2)
 assert.ok(result.matches.every(m=>m.truthSqft>0&&m.areaErrorPct===0))
 assert.throws(()=>scoreFixture({...fixture,input:{...fixture.input,feetPerImagePx:0}},fixture.truth.areas),/positive/)
 assert.throws(()=>scoreFixture(fixture,[{points:rect(-.1,.1,.2,.2),holes:[]}]),/normalized/)
})

test('vector release requires fresh checked references in both vector categories and cannot qualify scans',()=>{
 const {evaluateGeometryQualification}=require('../scripts/area-release-policy')
 const samples=Array.from({length:50},(_,i)=>({kind:'original-pdf',split:'holdout',annotationStatus:'independently-checked',project:'project-'+i%3,sourceCategory:i%2?'layered-vector':'flattened-vector',truthRooms:10,matched:10,withinTwoPercent:10,merged:0,splitRooms:0,falsePositives:0,matches:Array.from({length:10},()=>({boundary:{p95Feet:.05,maxFeet:.1}}))}))
 assert.equal(evaluateGeometryQualification(samples,'vector-plan').geometryGatePassed,true)
 assert.equal(evaluateGeometryQualification(samples,'all-sources').geometryGatePassed,false)
 assert.equal(evaluateGeometryQualification(samples.map(r=>({...r,split:'development'})),'vector-plan').geometryGatePassed,false)
 assert.equal(evaluateGeometryQualification(samples.map(r=>({...r,annotationStatus:'human-annotated'})),'vector-plan').geometryGatePassed,false)
 assert.equal(evaluateGeometryQualification(samples.map(r=>({...r,sourceCategory:'layered-vector'})),'vector-plan').geometryGatePassed,false)
 const missingSmallSheet=samples.map(r=>({...r}));missingSmallSheet[0]={...missingSmallSheet[0],truthRooms:1,matched:0,withinTwoPercent:0,matches:[]}
 assert.equal(evaluateGeometryQualification(missingSmallSheet,'vector-plan').geometryGatePassed,false,'a wholly missed small sheet cannot hide behind larger successful sheets')
 const oneSource=samples.map(r=>({...r,project:r.sourceCategory==='layered-vector'?'one-project':r.project}))
 assert.equal(evaluateGeometryQualification(oneSource,'vector-plan').geometryGatePassed,false)
 assert.throws(()=>evaluateGeometryQualification(samples,'easy'),/Unknown/)
})

test('qualification cannot hide abstention, bad boundaries or false areas behind aggregate area accuracy',()=>{
 const {evaluateGeometryQualification}=require('../scripts/area-release-policy')
 const base={kind:'original-pdf',split:'holdout',annotationStatus:'independently-checked',project:'a',sourceCategory:'layered-vector',truthRooms:100,matched:97,withinTwoPercent:97,merged:0,splitRooms:0,falsePositives:0,matches:Array.from({length:97},()=>({boundary:{p95Feet:.05,maxFeet:.1}}))}
 const samples=Array.from({length:50},(_,i)=>({...base,project:'p'+i%3,sourceCategory:i%2?'layered-vector':'flattened-vector'}))
 const result=evaluateGeometryQualification(samples,'vector-plan')
 assert.equal(result.overall.accurateRoomFraction,.97)
 assert.equal(result.geometryGatePassed,false,'97% accurate is insufficient if 3% of rooms are missing')
 for(const mutation of [{falsePositives:1},{merged:1},{splitRooms:1},{matches:[{boundary:{p95Feet:NaN,maxFeet:0}}]}]){
  const valid=samples.map(r=>({...r,matched:100,withinTwoPercent:100,matches:Array.from({length:100},()=>({boundary:{p95Feet:0,maxFeet:0}}))}))
  valid[0]={...valid[0],...mutation}
  assert.equal(evaluateGeometryQualification(valid,'vector-plan').geometryGatePassed,false)
 }
})

test('small reference rooms remain matchable regardless of their size on the sheet',()=>{
 const tiny={label:'Closet',points:rect(.501,.501,.5011,.5011),holes:[]}
 const result=scoreFixture({...fixture,truth:{areas:[tiny]}},[tiny])
 assert.equal(result.matched,1)
 assert.equal(result.matches[0].iou,1)
 assert.equal(result.matches[0].areaErrorPct,0)
})

test('partial original references do not label every untraced proposal a false positive',()=>{
 const result=scoreFixture({...fixture,kind:'original-pdf',annotation:{completeness:'partial'},truth:{areas:[fixture.truth.areas[0]]}},fixture.truth.areas)
 assert.equal(result.referenceCompleteness,'partial')
 assert.equal(result.falsePositives,null)
 assert.equal(result.matched,1)
})

test('estimator qualification requires corrected geometry, binding to references and counterbalanced observed times',()=>{
 const {evaluateEstimatorTrial}=require('../scripts/area-estimator-trial')
 const {attestReference,referenceDigest}=require('../scripts/check-area-reference')
 const fixtures=Array.from({length:10},(_,i)=>attestReference({...fixture,kind:'original-pdf',project:'p'+i%3,split:'holdout',detectionMode:'whole-sheet',source:{sha256:String(i%3).repeat(64),page:i+1},sourceCategory:i<5?'layered-vector':'flattened-vector',annotation:{annotator:'Reference author',scope:'Net floor faces.',method:'manual-source-tracing-without-detector-prefill',completeness:'complete'}},'Reference reviewer',true))
 const trial={engine:12,engineFingerprint:'a'.repeat(64),profile:'vector-plan',timingConvention:'end-to-end-including-review-correction',samples:fixtures.map((f,i)=>({source:f.source,referenceSha256:referenceDigest(f),manualOperator:i%2?'A':'B',assistedOperator:i%2?'B':'A',reviewer:'Trial observer',sourceAndScopeChecked:true,manualSeconds:120,assistedSeconds:60,manualAreas:f.truth.areas,assistedAreas:f.truth.areas}))}
 const evaluate=t=>evaluateEstimatorTrial(t,fixtures,'vector-plan',12,scoreFixture,'a'.repeat(64))
 assert.equal(evaluate(trial).passed,true)
 assert.equal(evaluate(null).passed,false)
 assert.equal(evaluate({...trial,engine:11}).passed,false)
 assert.equal(evaluate({...trial,engineFingerprint:'b'.repeat(64)}).passed,false)
 assert.equal(evaluate({...trial,samples:[...trial.samples,trial.samples[0]]}).passed,false)
 for(const changed of [{assistedSeconds:110},{referenceSha256:'stale'},{manualOperator:'Same',assistedOperator:'Same'},{assistedAreas:[{label:'Wrong',points:rect(.7,.7,.9,.9),holes:[]}]}]){
  assert.equal(evaluate({...trial,samples:trial.samples.map(s=>({...s,...changed}))}).passed,false)
 }
 assert.equal(evaluate({...trial,samples:trial.samples.map(s=>({...s,manualOperator:'Always manual',assistedOperator:'Always assisted'}))}).passed,false)
})

test('a reference inside a larger finish zone is distinguished from missing floor coverage',()=>{
 const closet={label:'Closet',points:rect(.2,.2,.3,.3),holes:[]}
 const combined={label:'Bath / Closet',points:rect(.1,.1,.9,.9),holes:[]}
 const f={...fixture,kind:'original-pdf',annotation:{completeness:'partial'},truth:{areas:[closet]}}
 const grouped=scoreFixture(f,[combined]),missing=scoreFixture(f,[])
 assert.equal(grouped.matched,0)
 assert.equal(grouped.unmatchedReferences[0].status,'contained-in-larger-zone')
 assert.equal(grouped.unmatchedReferences[0].referenceCoverage,1)
 assert.equal(missing.unmatchedReferences[0].status,'missing')
 assert.equal(grouped.falsePositives,null)
})
