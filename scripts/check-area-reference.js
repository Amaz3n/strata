#!/usr/bin/env node
/** Validate a human reference and record an explicit, separate review attestation.
 * This command cannot establish that someone actually checked the drawing. */
require('./register-ts-node-test')
const fs=require('node:fs'),{createHash}=require('node:crypto')
const {validateAreaGeometry,areasOverlap}=require('../lib/drawings/area-takeoff')
const categories=['layered-vector','flattened-vector','outlined-text','raster']
function referenceDigest(fixture){
 const {source,input,truth,sourceCategory,annotation}=fixture
 return createHash('sha256').update(JSON.stringify({source:{sha256:source?.sha256,page:source?.page},scale:{width:input?.imageWidth,height:input?.imageHeight,feetPerImagePx:input?.feetPerImagePx},sourceCategory,scope:annotation?.scope,completeness:annotation?.completeness,truth})).digest('hex')
}
function validateReference(fixture){
 if(fixture.kind!=='original-pdf'||!/^[a-f0-9]{64}$/.test(fixture.source?.sha256??'')||!Number.isInteger(fixture.source?.page)||fixture.source.page<1)throw Error('Original PDF source hash and page are required.')
 if(!fixture.project||fixture.project==='REPLACE_WITH_PROJECT_ID'||fixture.detectionMode!=='whole-sheet')throw Error('A project and whole-sheet detection are required.')
 if(!categories.includes(fixture.sourceCategory))throw Error('A checked source category is required.')
 if(!fixture.annotation?.annotator?.trim()||!fixture.annotation?.scope?.trim()||fixture.annotation?.method!=='manual-source-tracing-without-detector-prefill')throw Error('Human source annotation and an explicit finish convention are required.')
 for(const n of [fixture.input?.imageWidth,fixture.input?.imageHeight,fixture.input?.feetPerImagePx])if(!Number.isFinite(n)||n<=0)throw Error('Valid source dimensions and calibration are required.')
 const areas=fixture.truth?.areas
 if(!Array.isArray(areas)||!areas.length)throw Error('Reference areas are required.')
 for(let i=0;i<areas.length;i++){
  const a=areas[i]
  if(typeof a.label!=='string'||!a.label.trim()||!Array.isArray(a.points)||!Array.isArray(a.holes))throw Error('Each reference needs a label, perimeter and deductions.')
  if([a.points,...a.holes].some(r=>r.some(p=>!Array.isArray(p)||p.length!==2||p.some(n=>!Number.isFinite(n)||n<0||n>1))))throw Error('Reference points must be normalized to the source sheet.')
  validateAreaGeometry(a)
  for(let j=0;j<i;j++)if(areasOverlap(a,areas[j]))throw Error('Reference floor areas overlap.')
 }
}
function verifyReferenceReview(fixture){
 validateReference(fixture)
 if(fixture.annotation.completeness!=='complete')throw Error('A partial reference cannot qualify whole-sheet completeness or false-positive rates.')
 const review=fixture.annotation.review
 if(!review||typeof review.reviewer!=='string'||!review.reviewer.trim()||review.reviewer.trim().toLowerCase()===fixture.annotation.annotator.trim().toLowerCase()||review.sourceAndScopeChecked!==true||!Number.isFinite(Date.parse(review.checkedAt))||review.referenceSha256!==referenceDigest(fixture))throw Error('Independent source/scope review is missing, self-attested, or stale after a reference change.')
}
function attestReference(fixture,reviewer,confirmed){
 validateReference(fixture)
 if(!confirmed)throw Error('Pass --source-and-scope-checked only after checking the original drawing, calibration, completeness, boundaries and finish convention.')
 const result={...fixture,annotationStatus:'independently-checked',annotation:{...fixture.annotation,review:{reviewer,checkedAt:new Date().toISOString(),sourceAndScopeChecked:true,referenceSha256:referenceDigest(fixture)}}}
 verifyReferenceReview(result)
 return result
}
if(require.main===module){
 try{
  const [source,...args]=process.argv.slice(2),reviewerIndex=args.indexOf('--reviewer'),outputIndex=args.indexOf('--output')
  if(!source)throw Error('Usage: node scripts/check-area-reference.js annotation.json [--reviewer NAME --source-and-scope-checked --output checked.json]')
  const fixture=JSON.parse(fs.readFileSync(source,'utf8'));validateReference(fixture)
  if(reviewerIndex>=0){
   if(outputIndex<0||!args[outputIndex+1]||args[outputIndex+1]===source)throw Error('Provide a distinct --output file; the original annotation is retained.')
   const result=attestReference(fixture,args[reviewerIndex+1],args.includes('--source-and-scope-checked'))
   fs.writeFileSync(args[outputIndex+1],JSON.stringify(result,null,2)+'\n',{flag:'wx'})
   console.log('Recorded review; development/holdout designation was not changed.')
  }else{if(fixture.annotationStatus==='independently-checked')verifyReferenceReview(fixture);console.log('Reference structure is valid. This is not an accuracy sign-off.')}
 }catch(error){console.error(error.message);process.exitCode=1}
}
module.exports={referenceDigest,validateReference,verifyReferenceReview,attestReference}
