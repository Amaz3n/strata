require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module')
const {sources,notes}=require('./helpers/books-payroll-posting-proposal-fixture')
const {id,org}=require('./helpers/books-payroll-register-fixture')
let f,actor=id(2),denied=false,prior=null,lost=false,unavailable=false,changed=false,controlsResponse=null,posted=null,postLost=false,proofValid=true,calls=[]
const key='posting-proposal-service-key'
const saved=()=>({id:id(230),org_id:org,payroll_import_id:id(6),payment_review_id:id(72),status:'draft',plan:f.plan,plan_digest:f.plan.digest,prepared_by:id(2),prepared_at:'2026-10-03T12:00:00Z',preparation_notes:notes,reviewed_by:null,reviewed_at:null,review_notes:null,withdrawn_by:null,withdrawn_at:null,withdrawal_reason:null,idempotency_key:key})
const service={from(table){calls.push(['table',table]);const q={select(){return q},eq(k,v){calls.push([k,v]);return q},single:async()=>({data:table==='books_payroll_imports'?f.parent:table==='books_payroll_payment_reviews'?f.paymentRecord:prior,error:null}),maybeSingle:async()=>({data:table==='books_payroll_postings'?posted:prior,error:null})};return q},rpc:async(name,args)=>{calls.push([name,args]);if(name==='assert_books_payroll_posting_receipt')return {data:proofValid,error:null};if(name==='post_books_payroll_proposal'){posted=postedReceipt();return postLost?{data:null,error:{message:'Lost atomic commit response'}}:{data:posted.result,error:null}}if(name==='lock_books_payroll_posting_context')return {data:controlsResponse,error:null};if(name==='prepare_books_payroll_posting_proposal'&&lost){prior=saved();return {data:null,error:{message:'Response lost after commit'}}}return {data:id(230),error:null}}}
const original=Module._load;let api
try{Module._load=function(name,...args){
 if(name==='@/lib/services/context')return {requireOrgContext:async()=>({orgId:org,userId:actor,supabase:service})}
 if(name==='./access')return {requireBooksAuthorization:async input=>{calls.push(['authorize',input]);if(denied)throw new Error('Denied')}}
 if(name==='@/lib/supabase/server')return {createServiceSupabaseClient:()=>service}
 if(name==='./payroll-payment-reviews')return {previewReviewedPayrollPostingPlan:async input=>{calls.push(['current',input]);if(unavailable)throw new Error('Original sources unavailable');return changed?{...f.plan,digest:'a'.repeat(64)}:f.plan}}
 return original.call(this,name,...args)
};api=require('../lib/services/books/payroll-posting-proposals')}finally{Module._load=original}
const input=()=>({id:id(230),payrollImportId:id(6),notes,idempotencyKey:key})
async function reset(t){f=await sources(t);actor=id(2);denied=false;prior=null;lost=false;unavailable=false;changed=false;controlsResponse=null;posted=null;postLost=false;proofValid=true;calls=[]}
test('proposal service authorizes before private reads and persists only verified server-built current plan',async t=>{
 await reset(t);denied=true;await assert.rejects(api.preparePayrollPostingProposal(input()),/Denied/);assert.equal(calls.length,1)
 denied=false;calls=[];assert.equal(await api.preparePayrollPostingProposal(input()),id(230))
 assert.equal(calls[0][1].permission,'books.adjust');assert.equal(calls[0][1].resourceId,org)
 const rpc=calls.find(row=>row[0]==='prepare_books_payroll_posting_proposal')[1];assert.deepEqual(rpc.p_plan,f.plan);assert.equal(rpc.p_actor_id,id(2));assert.equal(rpc.p_org_id,org)
})
test('exact same intent resolves reviewed and withdrawn original records without requiring current sources',async t=>{
 await reset(t);prior=saved();unavailable=true
 for(const status of ['draft','reviewed','withdrawn']){
  prior=saved();prior.status=status
  if(status!=='draft')Object.assign(prior,{reviewed_by:id(51),reviewed_at:'2026-10-03T13:00:00Z',review_notes:notes})
  if(status==='withdrawn')Object.assign(prior,{withdrawn_by:id(2),withdrawn_at:'2026-10-03T14:00:00Z',withdrawal_reason:'Original proposal superseded'})
  calls=[];assert.equal(await api.preparePayrollPostingProposal(input()),id(230));assert.ok(!calls.some(row=>row[0]==='current'||row[0]==='prepare_books_payroll_posting_proposal'))
 }
 prior=saved();prior.prepared_by=id(50);await assert.rejects(api.preparePayrollPostingProposal(input()),/different intent/)
 prior=saved();prior.plan_digest='a'.repeat(64);await assert.rejects(api.preparePayrollPostingProposal(input()),/differs/)
})
test('lost preparation response is recovered from exact saved evidence without duplicate prepare',async t=>{
 await reset(t);lost=true;assert.equal(await api.preparePayrollPostingProposal(input()),id(230));assert.equal(calls.filter(row=>row[0]==='prepare_books_payroll_posting_proposal').length,1)
})
test('independent proposal review checks all preparers and current full-plan digest before SQL',async t=>{
 await reset(t);prior=saved()
 for(const user of [id(2),id(50)]){actor=user;calls=[];await assert.rejects(api.reviewPayrollPostingProposal({id:id(230),notes}),/separate reviewer/);assert.ok(!calls.some(row=>row[0]==='current'))}
 actor=id(51);calls=[];assert.equal(await api.reviewPayrollPostingProposal({id:id(230),notes}),id(230));assert.deepEqual(calls.find(row=>row[0]==='review_books_payroll_posting_proposal')[1].p_plan,f.plan)
 changed=true;calls=[];await assert.rejects(api.reviewPayrollPostingProposal({id:id(230),notes}),/sources or proposal changed/);assert.ok(!calls.some(row=>row[0]==='review_books_payroll_posting_proposal'))
})
test('stale/unavailable sources do not prevent scoped proposal withdrawal',async t=>{
 await reset(t);unavailable=true;assert.equal(await api.withdrawPayrollPostingProposal({id:id(230),reason:'Withdraw original stale payroll posting proposal'}),id(230))
 assert.deepEqual(calls.map(row=>row[0]),['authorize','withdraw_books_payroll_posting_proposal']);assert.equal(calls[1][1].p_actor_id,id(2))
})

const reviewedSaved=()=>({...saved(),status:'reviewed',reviewed_by:id(51),reviewed_at:'2026-10-03T13:00:00Z',review_notes:notes})
const controls=()=>({version:1,orgId:org,proposalId:id(230),payrollImportId:id(6),planDigest:f.plan.digest,accountingDates:[{accountingDate:'2026-09-15',periodId:id(250),status:'open'},{accountingDate:'2026-09-18',periodId:id(251),status:'closed'}],calendarBlockers:[{accountingDate:'2026-09-18',code:'accounting_period_closed'}],constructionBlockers:[{allocationId:id(3),code:'review_cost_plus_correction'}],controlsSatisfied:false,postingImplemented:false,locksHeldUntilTransactionEnd:true})
test('payroll readiness checks authority, review and current source evidence before transactional context',async t=>{
 await reset(t);prior=reviewedSaved();controlsResponse=controls();denied=true
 await assert.rejects(api.getPayrollPostingControls({id:id(230)}),/Denied/);assert.equal(calls.length,1)
 denied=false;prior=saved();calls=[];await assert.rejects(api.getPayrollPostingControls({id:id(230)}),/reviewed full proposal/);assert.ok(!calls.some(row=>row[0]==='current'))
 prior=reviewedSaved();changed=true;calls=[];await assert.rejects(api.getPayrollPostingControls({id:id(230)}),/sources or proposal changed/);assert.ok(!calls.some(row=>row[0]==='lock_books_payroll_posting_context'))
 changed=false;unavailable=true;await assert.rejects(api.getPayrollPostingControls({id:id(230)}),/Original sources unavailable/)
})
test('payroll readiness exposes blockers without promising locks or authority to post after RPC',async t=>{
 await reset(t);prior=reviewedSaved();controlsResponse=controls()
 const result=await api.getPayrollPostingControls({id:id(230)})
 assert.equal(result.preflightOnly,true);assert.equal(result.requiresCommitRevalidation,true);assert.equal(result.postingImplemented,false);assert.equal(result.controlsSatisfied,false)
 assert.ok(!Object.hasOwn(result,'locksHeldUntilTransactionEnd'));assert.deepEqual(result.calendarBlockers,controlsResponse.calendarBlockers)
 assert.deepEqual(calls.find(row=>row[0]==='lock_books_payroll_posting_context')[1],{p_org_id:org,p_proposal_id:id(230)})
 controlsResponse={...controls(),postingImplemented:true};assert.equal((await api.getPayrollPostingControls({id:id(230)})).postingImplemented,true)
 for(const patch of [{orgId:id(99)},{proposalId:id(99)},{planDigest:'a'.repeat(64)},{controlsSatisfied:true},{accountingDates:controlsResponse.accountingDates.slice(0,1)},{postingImplemented:'unconfirmed'}]){
  controlsResponse={...controls(),...patch};await assert.rejects(api.getPayrollPostingControls({id:id(230)}))
 }
})

const postingInput=()=>({id:id(260),proposalId:id(230),planDigest:f.plan.digest,notes:'Post independently reviewed payroll and project corrections',idempotencyKey:'atomic-payroll-posting-key'})
const postedReceipt=()=>({id:id(260),org_id:org,proposal_id:id(230),payroll_import_id:id(6),plan_digest:f.plan.digest,posted_by:id(2),posted_at:'2026-10-04T00:00:00Z',posting_notes:postingInput().notes,idempotency_key:postingInput().idempotencyKey,result:{version:1,postingId:id(260),proposalId:id(230),payrollImportId:id(6),planDigest:f.plan.digest,journals:[],jobCostCorrections:[],billingPreserved:[]}})
test('atomic posting service authorizes and re-verifies exact current independently reviewed plan before commit',async t=>{
 await reset(t);denied=true;await assert.rejects(api.postPayrollPostingProposal(postingInput()),/Denied/);assert.equal(calls.length,1)
 denied=false;prior=saved();calls=[];await assert.rejects(api.postPayrollPostingProposal(postingInput()),/exact independently reviewed/);assert.ok(!calls.some(row=>row[0]==='post_books_payroll_proposal'))
 prior=reviewedSaved();changed=true;calls=[];await assert.rejects(api.postPayrollPostingProposal(postingInput()),/sources or proposal changed/);assert.ok(!calls.some(row=>row[0]==='post_books_payroll_proposal'))
 changed=false;calls=[];const result=await api.postPayrollPostingProposal(postingInput());assert.deepEqual(result,postedReceipt().result)
 const args=calls.find(row=>row[0]==='post_books_payroll_proposal')[1];assert.equal(args.p_org_id,org);assert.equal(args.p_actor_id,id(2));assert.equal(args.p_digest,f.plan.digest);assert.ok(!Object.hasOwn(args,'p_plan'));assert.ok(calls.some(row=>row[0]==='assert_books_payroll_posting_receipt'))
})
test('atomic commit response loss and exact historical retry recover only corroborated recorded money',async t=>{
 await reset(t);prior=reviewedSaved();postLost=true;assert.deepEqual(await api.postPayrollPostingProposal(postingInput()),postedReceipt().result);assert.equal(calls.filter(row=>row[0]==='post_books_payroll_proposal').length,1)
 calls=[];unavailable=true;assert.deepEqual(await api.postPayrollPostingProposal(postingInput()),postedReceipt().result);assert.ok(!calls.some(row=>row[0]==='current'||row[0]==='post_books_payroll_proposal'))
 await assert.rejects(api.postPayrollPostingProposal({...postingInput(),notes:'Changed posting notes cannot reuse key'}),/different intent/)
 proofValid=false;await assert.rejects(api.postPayrollPostingProposal(postingInput()),/lacks confirmed/)
 proofValid=true;posted.result.proposalId=id(99);await assert.rejects(api.postPayrollPostingProposal(postingInput()),/different identity/)
})
