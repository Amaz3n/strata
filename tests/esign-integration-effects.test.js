const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript')
test('change order replays unfinished financial effects after its approval is durable',async()=>{
 const source=fs.readFileSync('lib/services/change-orders.ts','utf8'),start=source.indexOf('export async function approveChangeOrderFromEnvelopeExecution'),end=source.indexOf('export async function approveChangeOrderFromPortalSignature',start)
 const existing={id:'co',org_id:'org',project_id:'project',status:'sent',metadata:{}},counts={approval:0,budget:0,sov:0};let fail=true
 const db={from(table){let patch;const q={insert(){counts.approval++;return q},update(p){patch=p;return q},eq(){return q},then(resolve){if(patch)Object.assign(existing,patch);return Promise.resolve({error:null}).then(resolve)}};return q}}
 const exports={};vm.runInNewContext(ts.transpileModule(source.slice(start,end),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,Date,Error,createServiceSupabaseClient:()=>db,fetchChangeOrder:async()=>structuredClone(existing),buildApprovedChangeOrderFinancialMetadata:()=>({}),attachFileWithServiceRole:async()=>{},hasBudgetDistributions:()=>true,postBudgetRevisionForChangeOrder:async()=>{counts.budget++;if(fail){fail=false;throw Error('temporary budget failure')}},applyChangeOrderFinancialImpact:async()=>{},postApprovedChangeOrderToSovIfNeeded:async()=>{counts.sov++},applySelectionChangeFromChangeOrder:async()=>{},recordEvent:async()=>{}})
 const input={orgId:'org',changeOrderId:'co',envelopeId:'env',documentId:'doc',executedFileId:'file'}
 await assert.rejects(exports.approveChangeOrderFromEnvelopeExecution(input),/temporary budget/)
 assert.equal(existing.status,'approved');assert.equal(existing.metadata.envelope_effects_completed,undefined)
 await exports.approveChangeOrderFromEnvelopeExecution(input)
 assert.equal(counts.approval,1);assert.equal(counts.budget,2);assert.equal(counts.sov,1)
 assert.equal(existing.metadata.envelope_effects_completed,true)
 await exports.approveChangeOrderFromEnvelopeExecution(input);assert.equal(counts.budget,2)
})
