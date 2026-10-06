#!/usr/bin/env node
// Offline structural/dependency check only. Never connects to or writes a database.
require('./register-ts-node-test')
const fs=require('node:fs'),{gunzipSync}=require('node:zlib')
const {preflightBooksRestore}=require('../lib/services/books/restore-preflight')
function inspectRestore(bundlePath,catalogPath){
 const bytes=fs.readFileSync(bundlePath)
 const bundle=JSON.parse((bytes[0]===0x1f&&bytes[1]===0x8b?gunzipSync(bytes):bytes).toString('utf8'))
 const catalog=JSON.parse(fs.readFileSync(catalogPath,'utf8'))
 return preflightBooksRestore(bundle,catalog)
}
module.exports={inspectRestore}
if(require.main===module){
 const [bundlePath,catalogPath,reportPath]=process.argv.slice(2)
 try{
  if(!bundlePath||!catalogPath)throw new Error('Usage: node scripts/preflight-books-restore.cjs archive.json.gz target-catalog.json [new-report.json]')
  const report=inspectRestore(bundlePath,catalogPath),output=JSON.stringify(report,null,2)+'\n'
  if(reportPath)fs.writeFileSync(reportPath,output,{flag:'wx',mode:0o600})
  else process.stdout.write(output)
  if(!report.readyForRestoreAttempt)process.exitCode=2
 }catch(error){console.error(error.message);process.exitCode=1}
}
