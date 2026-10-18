#!/usr/bin/env node
// Offline preparation only. Does not connect to a database or enable providers.
require('./register-ts-node-test')
const fs=require('node:fs'),{gunzipSync}=require('node:zlib')
const {prepareBooksRestorePlan}=require('../lib/services/books/restore-plan')
function prepareRestore(archivePath,catalogPath,mappingPath){
 const bytes=fs.readFileSync(archivePath)
 const bundle=JSON.parse((bytes[0]===0x1f&&bytes[1]===0x8b?gunzipSync(bytes):bytes).toString('utf8'))
 const catalog=JSON.parse(fs.readFileSync(catalogPath,'utf8'))
 const mapping=JSON.parse(fs.readFileSync(mappingPath,'utf8'))
 return prepareBooksRestorePlan({bundle,catalog,dependencies:mapping.dependencies,fundingActors:mapping.fundingActors})
}
module.exports={prepareRestore}
if(require.main===module){
 const [archivePath,catalogPath,mappingPath,planPath]=process.argv.slice(2)
 try{
  if(!archivePath||!catalogPath||!mappingPath||!planPath)throw new Error('Usage: node scripts/prepare-books-restore.cjs archive.json.gz target-catalog.json identity-mapping.json new-plan.json')
  const plan=prepareRestore(archivePath,catalogPath,mappingPath)
  fs.writeFileSync(planPath,JSON.stringify(plan,null,2)+'\n',{flag:'wx',mode:0o600})
  console.log(JSON.stringify({planPath,planDigest:plan.planDigest,readyForRestoreAttempt:plan.preflight.readyForRestoreAttempt,blockers:plan.preflight.blockers.length,externalDependencies:plan.preflight.externalDependencies.length}))
  if(!plan.preflight.readyForRestoreAttempt)process.exitCode=2
 }catch(error){console.error(error.message);process.exitCode=1}
}
