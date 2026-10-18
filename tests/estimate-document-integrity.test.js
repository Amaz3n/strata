require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript')
function load(file,dependencies){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(require.resolve(file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports,require:name=>dependencies[name]??{},Map,Set,Date});return exports}
function database(records){return {from(table){const q={select(){return q},eq(){return q},is(){return q},in(){return q},order(){return q},limit(){return q},maybeSingle:async()=>({data:records[table]??null}),then:resolve=>resolve({data:records[table]??[]})};return q}}}
function authorization({allowed=true,status='pricing',project='restricted',linked='restricted',phase='precon'}={}){
 const records={estimates:{id:'doc',org_id:'org',project_id:project,prospect_id:'lead',status:'draft'},prospects:{id:'lead',status},projects:linked?{id:linked,phase}:null},service=database(records),checks=[]
 const deps={'server-only':{},'./context':{requireOrgContext:async()=>({supabase:service,orgId:'org',userId:'member'})},'./permissions':{requirePermission:async()=>{}},'./authorization':{requireAuthorization:async input=>{checks.push(input);if(!allowed)throw Error('Forbidden')}},'@/lib/supabase/server':{createServiceSupabaseClient:()=>service}}
 return {...load('../lib/services/estimate-document-authorization',deps),checks,records}
}
test('draft authorization resolves project with privileged lookup but rejects members without project management',async()=>{const h=authorization({allowed:false});await assert.rejects(h.authorizeEstimateDocumentWrite('doc'),/Forbidden/);assert.equal(h.checks[0].projectId,'restricted');assert.equal(h.checks[0].permission,'project.manage')})
test('draft authorization rejects closed, delivery and mismatched deal parents before granting mutation access',async()=>{for(const options of [{status:'lost'},{status:'won'},{phase:'delivery'},{linked:'different'}]){const h=authorization(options);await assert.rejects(h.authorizeEstimateDocumentWrite('doc'));assert.equal(h.checks.length,0)}})
test('unlinked document still requires management permission and resolves later linked project',async()=>{const h=authorization({project:null});await h.authorizeEstimateDocumentWrite('doc');assert.equal(h.checks[0].projectId,'restricted')})
const commercial=require('../lib/financials/estimate-commercial')
function issuance(records={},quotes=[]){const service=database({precon_workspaces:{brief:{pricing_revision:2},version:7},files:[],drawing_revisions:[],...records}),checks=[]
 const deps={'server-only':{},'@/lib/financials/estimate-commercial':commercial,'@/lib/precon/pricing-basis':require('../lib/precon/pricing-basis'),'@/lib/precon/brief-revision':require('../lib/precon/brief-revision'),'./estimate-document-authorization':{authorizeEstimateDocumentWrite:async()=>({service,orgId:'org',projectId:'project'})},'./precon-workspace':{assertPreconDecisionGate:async()=>checks.push('conditions')},'./bids':{listProspectBidQuotes:async()=>quotes}}
 return {...load('../lib/services/estimate-issuance',deps),checks}
}
const document=(extra={})=>({id:'doc',status:'draft',prospect_id:'lead',is_current_version:true,metadata:{precon:{...commercial.DEFAULT_ESTIMATE_COMMERCIAL,purpose:'budget',brief_version:2}},items:[],...extra})
test('first issuance rejects changed brief, missing governing file, new drawings and retired trade quote',async()=>{
 const stale=document();stale.metadata.precon.brief_version=1;await assert.rejects(issuance().assertEstimateIssuable(stale),/pricing basis/)
 const file=document();file.metadata.precon.governing_documents=[{id:'file',name:'Plans',version_id:'v1'}];await assert.rejects(issuance().assertEstimateIssuable(file),/unavailable/)
 const drawing=document();drawing.metadata.precon.drawing_revisions=[];await assert.rejects(issuance({drawing_revisions:[{id:'revision',drawing_set_id:'set',revision_label:'R2'}]}).assertEstimateIssuable(drawing),/drawing issuance/)
 await assert.rejects(issuance().assertEstimateIssuable(document({items:[{metadata:{source_bid_submission_id:'quote',bid_pricing_basis:{pricing_decision_id:'decision'}}}]})),/trade quote changed/)
})
test('issued immutable snapshot can be resent after pricing changes but signed or superseded documents cannot',async()=>{
 const h=issuance({precon_workspaces:{brief:{pricing_revision:99},version:99}})
 await h.assertEstimateIssuable(document({status:'sent',sent_at:'2026-10-01'}))
 for(const extra of [{status:'executed'},{status:'client_signed'},{is_current_version:false}])await assert.rejects(h.assertEstimateIssuable(document(extra)),/current unsigned/)
})
test('first issuance accepts current quote decision and all reference versions',async()=>{
 const h=issuance({},[{submission_id:'quote',pricing_decision_id:'decision',normalized_total_cents:123}]);await h.assertEstimateIssuable(document({items:[{metadata:{source_bid_submission_id:'quote',bid_pricing_basis:{pricing_decision_id:'decision',normalized_total_cents:123}}}]}))
})
