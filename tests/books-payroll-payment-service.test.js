require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module')
const {setup}=require('./helpers/books-payroll-payment-fixture')
const {id,org}=require('./helpers/books-payroll-register-fixture')
let f,actor=id(50),denied=false,prior=null,lost=false,stale=false,foreign=false,bytesWrong=false,rootReviewed=false,verificationError=false,unconfirmed=false,calls=[]
const notes='Verified original statement and worker allocation',key='original-payment-review-key'
const reviewMetadata={prepared_at:'2026-10-03T12:00:00Z',reviewed_at:'2026-10-03T13:00:00Z',reviewed_by:id(51),review_notes:notes,withdrawn_by:null,withdrawn_at:null,withdrawal_reason:null}
const parent=()=>({...f.evidence,...reviewMetadata,id:f.run.id,org_id:org,status:rootReviewed?'reviewed':'draft',prepared_by:id(50),preparation_notes:notes})
const saved=()=>({id:f.payment.request.id,org_id:org,payroll_import_id:f.run.id,status:'draft',prepared_by:id(50),preparation_notes:notes,idempotency_key:key,request:f.payment.request,evidence:f.payment.evidence,evidence_digest:f.payment.evidenceDigest})
const service={
 from(table){calls.push(['table',table]);const q={select(){return q},eq(k,v){calls.push([k,v]);return q},in(k,v){calls.push(['in',k,v]);return q},
  single:async()=>({data:table==='books_payroll_imports'?parent():prior,error:null}),maybeSingle:async()=>({data:prior,error:null}),
  then(resolve,reject){const rows=table==='doc_versions'?[{id:id(71),...f.proof}]:[{id:id(70),org_id:org}];if(foreign)rows[0].org_id=id(99);return Promise.resolve({data:rows,error:null}).then(resolve,reject)}};return q},
 async rpc(name,args){calls.push([name,args]);if(name==='prepare_books_payroll_payment_review'&&lost){prior=saved();return {data:null,error:{message:'Response lost after commit'}}}return {data:name==='verify_books_payroll_posting_plan'?!unconfirmed:id(72),error:name==='verify_books_payroll_posting_plan'&&verificationError?{message:'Source revision changed'}:null}},
}
const original=Module._load;let api
try{Module._load=function(name,...args){
 if(name==='@/lib/services/context')return {requireOrgContext:async()=>({orgId:org,userId:actor,supabase:service})}
 if(name==='./access')return {requireBooksAuthorization:async input=>{calls.push(['authorize',input]);if(denied)throw new Error('Denied')}}
 if(name==='@/lib/supabase/server')return {createServiceSupabaseClient:()=>service}
 if(name==='./payroll-imports')return {currentPayrollImportEvidence:async()=>{calls.push(['fresh']);if(stale)throw new Error('Payroll source changed');return f.evidence}}
 if(name==='@/lib/storage/files-storage')return {getFilesObjectStream:async()=>{const bytes=Buffer.from(f.paymentBytes);if(bytesWrong)bytes[0]^=1;return {body:new ReadableStream({start(controller){controller.enqueue(new Uint8Array(bytes));controller.close();}})};}}
 if(name==='./tax-attachments'){const actual=original.call(this,name,...args);return {verifyTaxAttachmentBytes:async(service,organization,proof)=>{calls.push(['bytes',organization,proof]);return actual.verifyTaxAttachmentBytes(service,organization,proof);}};}
 return original.call(this,name,...args)
};api=require('../lib/services/books/payroll-payment-reviews')}finally{Module._load=original}
const input=()=>({request:f.request,notes,idempotencyKey:key})
async function reset(t){f=await setup(t);actor=id(50);denied=false;prior=null;lost=false;stale=false;foreign=false;bytesWrong=false;rootReviewed=false;verificationError=false;unconfirmed=false;calls=[]}
test('payment preparation authorizes whole-organization scope before reading private sources, and builds proof from retained versions',async t=>{
 await reset(t);denied=true;await assert.rejects(api.preparePayrollPaymentReview(input()),/Denied/);assert.equal(calls.length,1)
 denied=false;calls=[];assert.equal(await api.preparePayrollPaymentReview(input()),id(72))
 assert.equal(calls[0][1].permission,'books.adjust');assert.equal(calls[0][1].resourceId,org)
 const rpc=calls.find(row=>row[0]==='prepare_books_payroll_payment_review')[1]
 assert.deepEqual(rpc.p_evidence,f.payment.evidence);assert.equal(rpc.p_actor_id,id(50))
 assert.ok(calls.some(row=>row[0]==='bytes'&&row[2].document_version_id===id(71)))
 assert.ok(calls.some(row=>row[0]==='org_id'&&row[1]===org))
})
test('foreign document identity, changed original bytes and stale payroll cannot reach prepare RPC',async t=>{
 await reset(t)
 for(const flag of ['foreign','bytesWrong','stale']){
  foreign=flag==='foreign';bytesWrong=flag==='bytesWrong';stale=flag==='stale';calls=[]
  await assert.rejects(api.preparePayrollPaymentReview(input()),/identity|bytes|source changed/)
  assert.ok(!calls.some(row=>row[0]==='prepare_books_payroll_payment_review'))
 }
})
test('same-key recovery replays original evidence through withdrawal without current source or blob access',async t=>{
 await reset(t);prior=saved();stale=true;bytesWrong=true
 for(const status of ['draft','reviewed','withdrawn']){prior.status=status;calls=[];assert.equal(await api.preparePayrollPaymentReview(input()),id(72));assert.ok(!calls.some(row=>row[0]==='fresh'||row[0]==='bytes'||row[0]==='prepare_books_payroll_payment_review'))}
 prior.preparation_notes='Different original statement review';await assert.rejects(api.preparePayrollPaymentReview(input()),/different intent/)
 prior=saved();prior.evidence_digest='a'.repeat(64);await assert.rejects(api.preparePayrollPaymentReview(input()),/integrity/)
})
test('lost preparation response is corroborated by exact saved request and actor',async t=>{
 await reset(t);lost=true;assert.equal(await api.preparePayrollPaymentReview(input()),id(72));assert.equal(calls.filter(row=>row[0]==='prepare_books_payroll_payment_review').length,1)
 actor=id(51);await assert.rejects(api.preparePayrollPaymentReview(input()),/different intent/)
})
test('payment reviewer is separate from both preparers and rechecks current source and original supporting bytes',async t=>{
 await reset(t);prior={...saved(),prepared_by:id(2)}
 await assert.rejects(api.reviewPayrollPaymentReview({id:id(72),notes}),/separate reviewer/)
 assert.ok(!calls.some(row=>row[0]==='fresh'))
 actor=id(51);calls=[];assert.equal(await api.reviewPayrollPaymentReview({id:id(72),notes}),id(72))
 assert.ok(calls.some(row=>row[0]==='bytes'));assert.ok(calls.some(row=>row[0]==='fresh'))
 bytesWrong=true;calls=[];await assert.rejects(api.reviewPayrollPaymentReview({id:id(72),notes}),/bytes/);assert.ok(!calls.some(row=>row[0]==='review_books_payroll_payment_review'))
})
test('withdrawal uses scoped actor and substantive reason without private source or object reads',async t=>{
 await reset(t);stale=true;bytesWrong=true
 assert.equal(await api.withdrawPayrollPaymentReview({id:id(72),reason:'Superseded payment attribution evidence'}),id(72))
 assert.deepEqual(calls.map(row=>row[0]),['authorize','withdraw_books_payroll_payment_review']);assert.equal(calls[1][1].p_org_id,org)
})
test('posting proposal uses reviewed original ownership and reverified payroll/payment bytes without a write RPC',async t=>{
 await reset(t);rootReviewed=true;prior={...saved(),...reviewMetadata,status:'reviewed'}
 const plan=await api.previewReviewedPayrollPostingPlan({id:f.run.id})
 assert.equal(plan.outstanding.netPayCents,0);assert.equal(plan.ledgerCostDeltaCents,-9000)
 assert.equal(plan.postingImplemented,false);assert.ok(calls.some(row=>row[0]==='fresh'));assert.ok(calls.some(row=>row[0]==='bytes'))
 assert.ok(calls.some(row=>row[0]==='payroll_import_id'&&row[1]===f.run.id));assert.ok(calls.some(row=>row[0]==='status'&&row[1]==='reviewed'))
 assert.ok(!calls.some(row=>row[0].startsWith('prepare_')||row[0].startsWith('review_')))
 const verified=calls.find(row=>row[0]==='verify_books_payroll_posting_plan')[1];assert.deepEqual(verified.p_plan,plan);assert.equal(verified.p_parent_id,f.run.id);assert.equal(verified.p_org_id,org)
 verificationError=true;await assert.rejects(api.previewReviewedPayrollPostingPlan({id:f.run.id}),/Source revision changed/)
 verificationError=false;unconfirmed=true;await assert.rejects(api.previewReviewedPayrollPostingPlan({id:f.run.id}),/not confirmed/);unconfirmed=false
 bytesWrong=true;await assert.rejects(api.previewReviewedPayrollPostingPlan({id:f.run.id}),/bytes/)
 bytesWrong=false;prior=null;await assert.rejects(api.previewReviewedPayrollPostingPlan({id:f.run.id}),/reviewed allocation/)
})

test('payment preview verifies original documents without writing, and pinned preparation rejects a different preview while exact committed retry still recovers',async t=>{
 await reset(t);calls=[];const preview=await api.previewPayrollPaymentReview({request:f.request});
 assert.deepEqual(preview,f.payment);assert.ok(calls.some(row=>row[0]==='bytes'));
 assert.ok(!calls.some(row=>row[0].startsWith('prepare_')||row[0].startsWith('review_')));
 calls=[];await assert.rejects(api.preparePayrollPaymentReview({...input(),expectedEvidenceDigest:'a'.repeat(64)}),/changed since preview/);
 assert.ok(!calls.some(row=>row[0]==='prepare_books_payroll_payment_review'));
 calls=[];assert.equal(await api.preparePayrollPaymentReview({...input(),expectedEvidenceDigest:preview.evidenceDigest}),id(72));
 assert.equal(calls.filter(row=>row[0]==='prepare_books_payroll_payment_review').length,1);
 prior=saved();stale=true;bytesWrong=true;calls=[];
 assert.equal(await api.preparePayrollPaymentReview({...input(),expectedEvidenceDigest:preview.evidenceDigest}),id(72));
 assert.ok(!calls.some(row=>row[0]==='fresh'||row[0]==='bytes'||row[0]==='prepare_books_payroll_payment_review'));
});
test('payment preview denies access before source reads and rejects foreign supporting versions, changed bytes and stale source evidence',async t=>{
 await reset(t);denied=true;calls=[];await assert.rejects(api.previewPayrollPaymentReview({request:f.request}),/Denied/);assert.equal(calls.length,1);denied=false;
 for(const flag of ['foreign','bytesWrong','stale']){foreign=flag==='foreign';bytesWrong=flag==='bytesWrong';stale=flag==='stale';calls=[];await assert.rejects(api.previewPayrollPaymentReview({request:f.request}),/identity|bytes|source changed/);assert.ok(!calls.some(row=>row[0].startsWith('prepare_')));}
});

test('confirmed attribution approval retry recovers exact historical reviewer intent through withdrawal without source or byte reads',async t=>{
 await reset(t);actor=id(51);prior={...saved(),...reviewMetadata,status:'reviewed'};stale=true;bytesWrong=true;
 for(const status of ['reviewed','withdrawn']){prior.status=status;calls=[];assert.equal(await api.reviewPayrollPaymentReview({id:id(72),notes}),id(72));assert.ok(!calls.some(row=>row[0]==='fresh'||row[0]==='bytes'||row[0]==='review_books_payroll_payment_review'))}
 calls=[];await assert.rejects(api.reviewPayrollPaymentReview({id:id(72),notes:'Different historical review intent'}),/source changed/);
 prior.evidence_digest='a'.repeat(64);await assert.rejects(api.reviewPayrollPaymentReview({id:id(72),notes}),/integrity/);
});
