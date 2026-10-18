require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {cashProfitAndLossFromSnapshot}=require('../lib/services/books/cash-profit-loss')
const {cashTaxWorkpaperBasis:basis,totalTaxAdjustments:total,reconcileTaxWorkpaper:reconcile}=require('../lib/services/books/tax-adjustment-rules')
const {org,fixture}=require('./support/books-cash-profit-loss-fixture')
const id=n=>'99100000-0000-4000-8000-'+String(n).padStart(12,'0')
const line=(n,amount,kind='permanent')=>({id:id(n),kind,amount_cents:amount,description:'Reviewed manual tax difference',evidence_reference:'Accountant workpaper reference',evidence_file_id:null,project_id:null})
function prepared(){const report=cashProfitAndLossFromSnapshot(org,'2026-09-01','2026-09-30',fixture()),proof=basis(report,'a'.repeat(64));return {proof,report,batch:{org_id:org,status:'approved',period_start:'2026-09-01',period_end:'2026-09-30',base_digest:proof.digest,base_snapshot:proof.snapshot,lines:[line(1,500),line(2,-200,'timing')],prepared_by:id(9),reviewed_by:id(10)}}}
test('signed permanent/timing workpapers reconcile exact adjustments without changing book income',()=>{
 const {proof,batch}=prepared(),before=structuredClone(proof),result=reconcile({orgId:org,basis:proof,batch})
 assert.equal(result.bookIncomeCents,-3);assert.equal(result.permanentCents,500);assert.equal(result.timingCents,-200);assert.equal(result.totalCents,300);assert.equal(result.adjustedIncomeCents,297);assert.deepEqual(proof,before)
})
test('workpaper basis ignores capture time and labels but retains economic/source revision changes',()=>{
 const {report,proof}=prepared(),copy=structuredClone(report)
 copy.capturedAt='2027-01-01T00:00:00Z';copy.databaseSnapshot='later';copy.sourceEvidence.directExpenses.capturedAt='later';copy.sourceEvidence.directExpenses.databaseSnapshot='later'
 copy.sourceEvidence.directExpenses.rows.reverse();assert.equal(basis(copy,'a'.repeat(64)).digest,proof.digest)
 copy.netIncomeCents=-4;assert.notEqual(basis(copy,'a'.repeat(64)).digest,proof.digest)
 assert.notEqual(basis(report,'b'.repeat(64)).digest,proof.digest);assert.throws(()=>basis(report,'missing'),/Invalid/)
})
test('only separately approved exact-period workpapers with intact current basis can publish',()=>{
 for(const patch of [{status:'draft'},{org_id:id(99)},{period_start:'2026-09-02'},{reviewed_by:null},{reviewed_by:id(9)}]){const {proof,batch}=prepared();assert.throws(()=>reconcile({orgId:org,basis:proof,batch:{...batch,...patch}}),/approved|separate reviewer/)}
 const changed=prepared();const newProof=basis({...changed.report,netIncomeCents:-4},'a'.repeat(64));assert.throws(()=>reconcile({orgId:org,basis:newProof,batch:changed.batch}),/books changed/)
 const tampered=prepared();tampered.batch.base_snapshot={...tampered.batch.base_snapshot,net_income_cents:0};assert.throws(()=>reconcile({orgId:org,basis:tampered.proof,batch:tampered.batch}),/integrity/)
})
test('fractional/unsafe/duplicate/zero adjustments and unreferenced evidence are rejected',()=>{
 for(const lines of [[line(1,0)],[line(1,0.5)],[line(1,Number.MAX_SAFE_INTEGER+1)],[line(1,1),line(1,2)],[{...line(1,1),evidence_reference:''}]])assert.throws(()=>total(lines))
 assert.throws(()=>total([line(1,Number.MAX_SAFE_INTEGER),line(2,1),line(3,-1,'timing')]),/safe integer/)
 const {proof,batch}=prepared();batch.lines=[line(1,-Number.MAX_SAFE_INTEGER)];assert.throws(()=>reconcile({orgId:org,basis:proof,batch}),/safe integer/)
})
test('preparation and review services authorize before reading or writing, use one captured context and preserve reviewer identity',async()=>{
 const Module=require('node:module'),original=Module._load;let denied=false,captures=0,prepares=0,reviews=0,withdrawals=0,reader=id(9),alterBasis=false,sourceRevision='a'
 const {batch}=prepared(),client={async rpc(name,args){if(name==='capture_books_tax_workpaper_context'){captures++;assert.equal(args.p_period_end,'2026-09-30');const snapshot=fixture(); snapshot.tables.files=[]; snapshot.tables.books_tax_adjustment_workpapers=[{...batch,id:id(20),reviewed_at:'2026-10-01T12:00:00Z',review_notes:'Reviewed complete adjustment evidence',base_snapshot:alterBasis?{...batch.base_snapshot,net_income_cents:900}:batch.base_snapshot}]; return {data:{...snapshot,taxSourceRevision:sourceRevision.repeat(64)},error:null}}if(name==='prepare_books_tax_workpaper'){prepares++;assert.equal(args.p_actor_id,reader);assert.equal(args.p_base_snapshot.net_income_cents,-3);return {data:id(20),error:null}}if(name==='review_books_tax_workpaper'){reviews++;assert.equal(args.p_actor_id,reader);return {data:id(20),error:null}}if(name==='withdraw_books_tax_workpaper'){withdrawals++;assert.equal(args.p_actor_id,reader);assert.equal(args.p_org_id,org);assert.equal(args.p_reason,'Duplicate draft entered in error');return {data:id(20),error:null}}throw new Error(name)},from(){const query={select(){return query},eq(){return query},single:async()=>({data:{...batch,id:id(20)},error:null})};return query}}
 let api
 try{Module._load=function(name,...args){if(name==='@/lib/supabase/server')return {createServiceSupabaseClient:()=>client};if(name==='@/lib/services/context')return {requireOrgContext:async()=>({orgId:org,userId:reader,supabase:client})};if(name==='@/lib/services/books/access')return {requireBooksAuthorization:async args=>{assert.ok(['books.adjust','books.read'].includes(args.permission));if(denied)throw new Error('Denied')}};return original.call(this,name,...args)};api=require('../lib/services/books/tax-adjustments')}finally{Module._load=original}
 denied=true;await assert.rejects(api.prepareTaxWorkpaper({startDate:'2026-09-01',endDate:'2026-09-30',lines:[line(1,1)],idempotencyKey:'unique-retry-key'}),/Denied/);assert.equal(captures,0);assert.equal(prepares,0)
 denied=false;assert.equal(await api.prepareTaxWorkpaper({startDate:'2026-09-01',endDate:'2026-09-30',lines:[line(1,1)],idempotencyKey:'unique-retry-key'}),id(20));assert.equal(captures,1)
 reader=id(10);assert.equal(await api.reviewTaxWorkpaper({id:id(20),notes:'Reviewed evidence and cash basis'}),id(20));assert.equal(captures,2);assert.equal(reviews,1)
 denied=true;await assert.rejects(api.getTaxWorkpaperWorkspace('2026-09-01','2026-09-30'),/Denied/);assert.equal(captures,2)
 denied=false;const workspace=await api.getTaxWorkpaperWorkspace('2026-09-01','2026-09-30');assert.equal(captures,3);assert.equal(workspace.userId,reader);assert.equal(workspace.bookIncomeCents,-3);assert.equal(workspace.workpapers.length,1);assert.equal(workspace.workpapers[0].current,true);assert.equal(workspace.workpapers[0].totalCents,300);assert.equal(workspace.workpapers[0].base_snapshot,undefined)
 const report=await api.buildTaxWorkpaperReport('2026-09-01','2026-09-30');assert.equal(report.adjustedIncomeCents,297);assert.equal(report.workpaperId,id(20));assert.equal(report.reviewedBy,id(10))
 sourceRevision='b';const stale=await api.getTaxWorkpaperWorkspace('2026-09-01','2026-09-30');assert.equal(stale.workpapers[0].current,false);await assert.rejects(api.buildTaxWorkpaperReport('2026-09-01','2026-09-30'),/books changed/)
 denied=true;await assert.rejects(api.withdrawTaxWorkpaper({id:id(20),reason:'Duplicate draft entered in error'}),/Denied/);assert.equal(withdrawals,0)
 denied=false;await assert.rejects(api.withdrawTaxWorkpaper({id:id(20),reason:'short'}));assert.equal(withdrawals,0);assert.equal(await api.withdrawTaxWorkpaper({id:id(20),reason:'Duplicate draft entered in error'}),id(20));assert.equal(withdrawals,1)
 sourceRevision='a';await assert.rejects(api.prepareTaxWorkpaper({startDate:'2026-09-01',endDate:'2026-09-30',lines:[],idempotencyKey:'zero-adjustment-key'}));await api.prepareTaxWorkpaper({startDate:'2026-09-01',endDate:'2026-09-30',lines:[],preparationNotes:'Reviewed all tax differences and no adjustments required',idempotencyKey:'zero-adjustment-key'});assert.equal(prepares,2)
 batch.lines=[];batch.preparation_notes='Reviewed all tax differences using TAX-2026; no adjustments required';const confirmation=await api.buildTaxWorkpaperReport('2026-09-01','2026-09-30');assert.equal(confirmation.adjustedIncomeCents,-3);assert.equal(confirmation.totalCents,0);assert.equal(confirmation.preparationNotes,batch.preparation_notes)
 alterBasis=true;await assert.rejects(api.getTaxWorkpaperWorkspace('2026-09-01','2026-09-30'),/integrity/)
})
test('no-adjustment confirmations need substantive preparation evidence and preserve exact book income',()=>{
 const {taxWorkpaperEvidenceSchema}=require('../lib/services/books/tax-adjustment-lines')
 assert.equal(taxWorkpaperEvidenceSchema.safeParse({lines:[]}).success,false)
 assert.equal(taxWorkpaperEvidenceSchema.safeParse({lines:[],preparation_notes:'ok'}).success,false)
 const {proof,batch}=prepared();batch.lines=[]
 assert.throws(()=>reconcile({orgId:org,basis:proof,batch}))
 batch.preparation_notes='Reviewed tax basis and source workpaper TAX-2026; no differences identified.'
 const report=reconcile({orgId:org,basis:proof,batch});assert.equal(report.totalCents,0);assert.equal(report.adjustedIncomeCents,report.bookIncomeCents);assert.deepEqual(report.lines,[])
 batch.status='withdrawn';assert.throws(()=>reconcile({orgId:org,basis:proof,batch}),/approved/)
})

test('approved attached adjustments cannot reconcile without frozen scoped identity',()=>{
 const {proof,batch}=prepared();batch.lines[0].evidence_file_id=id(70)
 assert.throws(()=>reconcile({orgId:org,basis:proof,batch}),/lacks frozen scoped evidence/)
})
