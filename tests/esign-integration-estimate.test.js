require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript')
function harness({artifact='file',failUpdate=false}={}) {
 const estimate={id:'estimate',org_id:'org',status:'client_signed',is_current_version:true,signature_document_id:'doc',signature_data:{client:{signer_name:'Client'}},metadata:{}}
 const signature={created_at:'2026-01-02T12:00:00Z',signer_name:'Recorded builder',signer_email:'builder@example.test',consent_text:'Recorded consent',values:{estimate_builder_signature:'recorded-image'},audit_data:{source:'estimate_native_builder_signing'}}
 const request={id:'request',status:'signed',envelope_id:'envelope',document:{id:'doc',source_entity_type:'estimate',source_entity_id:'estimate',executed_file_id:artifact}}
 let fail=failUpdate;const rpcCalls=[],writes=[]
 const db={rpc:async(name)=>{rpcCalls.push(name);return {data:null,error:{message:'Execution already in progress'}}},from(table){let patch;const q={select(){return q},eq(){return q},in(){return q},update(p){patch=p;return q},single(){return q},maybeSingle(){return q},then(resolve){if(patch){writes.push({table,patch});if(fail){fail=false;return Promise.resolve({data:null,error:{message:'temporary write failure'}}).then(resolve)}Object.assign(estimate,patch)}const data=table==='estimates'?estimate:table==='document_signatures'?signature:request;return Promise.resolve({data,error:null}).then(resolve)}};return q}}
 const deps={'@/lib/supabase/server':{createServiceSupabaseClient:()=>db},'@/lib/financials/estimate-commercial':{normalizeEstimateCommercial:()=>({purpose:'construction_agreement'})},'@/lib/services/events':{recordEvent:async()=>{}},'@/lib/services/audit':{recordAudit:async()=>{}},crypto:require('node:crypto')}
 const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/services/estimate-portal.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:n=>deps[n]??{},Date,Error,Intl,Buffer,Map,Set})
 return {api:exports,estimate,rpcCalls,writes}
}
test('native estimate retry resumes from persisted artifact and recorded signer after update failure',async()=>{
 const h=harness({failUpdate:true}),input={orgId:'org',requestId:'request'}
 await assert.rejects(h.api.finalizeEstimateBuilderSignature(input),/temporary write failure/)
 assert.equal(h.estimate.status,'client_signed')
 const result=await h.api.finalizeEstimateBuilderSignature(input)
 assert.equal(result.executedFileId,'file');assert.equal(h.estimate.status,'executed')
 assert.equal(h.estimate.signature_data.builder.signer_name,'Recorded builder')
 assert.equal(h.estimate.signature_data.builder.signature_image,'recorded-image')
 assert.equal(h.estimate.executed_at,'2026-01-02T12:00:00Z')
 assert.equal(h.rpcCalls.length,0)
})
test('native finalization respects another workers execution lease without publishing',async()=>{
 const h=harness({artifact:null})
 await assert.rejects(h.api.finalizeEstimateBuilderSignature({orgId:'org',requestId:'request'}),/already in progress/)
 assert.deepEqual(h.rpcCalls,['claim_esign_execution']);assert.equal(h.writes.length,0);assert.equal(h.estimate.status,'client_signed')
})
test('already accepted native signatures resume without revalidating retry payload and report artifact processing',async()=>{
 const source=fs.readFileSync('lib/services/estimate-portal.ts','utf8'),start=source.indexOf('export async function submitEstimateBuilderSignatureBySigningToken'),end=source.indexOf('/** Resume only',start),exports={}
 let accessChecks=0,finalizations=0
 vm.runInNewContext(ts.transpileModule(source.slice(start,end),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,Date,Error,createServiceSupabaseClient:()=>({}),hashSigningToken:()=>'',resolveSigningRequestToken:async()=>({data:{id:'request',org_id:'org',status:'signed',document:{}},error:null}),requireSigningAccess:async()=>{accessChecks++},finalizeEstimateBuilderSignature:async()=>{finalizations++;throw Error('temporary artifact failure')}})
 const result=await exports.submitEstimateBuilderSignatureBySigningToken({token:'valid-token'})
 assert.equal(result.success,true);assert.equal(result.processing,true);assert.equal(accessChecks,1);assert.equal(finalizations,1)
})
test('invalid native signature image is rejected before atomic acceptance',async()=>{
 const source=fs.readFileSync('lib/services/estimate-portal.ts','utf8'),start=source.indexOf('export async function submitEstimateBuilderSignatureBySigningToken'),end=source.indexOf('/** Resume only',start),exports={};let rpcCalls=0
 vm.runInNewContext(ts.transpileModule(source.slice(start,end),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,Date,Error,createServiceSupabaseClient:()=>({rpc(){rpcCalls++}}),hashSigningToken:()=>'',resolveSigningRequestToken:async()=>({data:{id:'request',org_id:'org',status:'sent',document:{}},error:null}),requireSigningAccess:async()=>{},validateSignaturePng:async()=>{throw Error('Invalid signature PNG')}})
 await assert.rejects(exports.submitEstimateBuilderSignatureBySigningToken({token:'valid-token',signerName:'Builder',signerEmail:'builder@example.test',signatureImage:'invalid'}),/Invalid signature PNG/)
 assert.equal(rpcCalls,0)
})
test('legacy direct countersign cannot execute an agreement without signing consent',async()=>{
 const h=harness();await assert.rejects(h.api.countersignEstimate({estimateId:'estimate',signerName:'Builder'}),/Open builder signing/)
 assert.equal(h.estimate.status,'client_signed');assert.equal(h.writes.length,0);assert.equal(h.rpcCalls.length,0)
})
