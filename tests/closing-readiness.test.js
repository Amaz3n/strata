require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {createFakeSupabase}=require('./support/fake-supabase')
const {stubModule,ORG,ACTOR,PACKAGE,PROJECT}=require('./support/starts-harness')
// Modules keep the server client they imported first, so the stub delegates to
// whichever home the current test built.
const service={db:null}
stubModule('@/lib/supabase/server',{createServiceSupabaseClient:()=>service.db})
function harness(){
 const gate={id:PACKAGE,org_id:ORG,closing_id:PACKAGE,title:'Occupancy clearance',is_gate:true,evidence_required:false,status:'complete',notes:null,file_id:null,completed_at:'2026-10-03T00:00:00Z',completed_by:ACTOR}
 const inspections={result:{data:{ready:true},error:null},calls:0}
 const db=createFakeSupabase({closing_checklist_items:[gate],punch_items:[],files:[]},{read_inspection_closing_readiness:async()=>{inspections.calls++;return inspections.result}}),calls=[]
 service.db=db
 let executed=true,waivers={ready:true,missing:[]},denied=false
 const milestones=[]
 const {gateBlockers,gateRefusal}=require('../lib/sales/agreement-milestones')
 stubModule('@/lib/services/agreement-milestones',{assertAgreementMilestonesClear:async(_supabase,_org,projectId,gate)=>{
  assert.equal(projectId,PROJECT)
  const [blocker]=gateBlockers(milestones,gate);if(blocker)throw new Error(gateRefusal(blocker,gate))
 }})
 stubModule('@/lib/services/authorization',{requireAuthorization:async input=>{calls.push(input);if(denied)throw new Error('Project denied')}})
 stubModule('@/lib/services/community-sales',{hasExecutedPurchaseAgreement:async()=>executed})
 stubModule('@/lib/services/waiver-register',{getProjectWaiverReadiness:async()=>waivers})
 delete require.cache[require.resolve('../lib/services/closing-readiness')]
 const {assertClosingReadiness}=require('../lib/services/closing-readiness')
 return {db,gate:db.store.closing_checklist_items[0],calls,inspections,milestones,check:()=>assertClosingReadiness({supabase:db,orgId:ORG,userId:ACTOR,projectId:PROJECT,closingId:PACKAGE}),setExecuted:value=>{executed=value},setWaivers:value=>{waivers=value},deny:()=>{denied=true}}
}
/** The agreement's commission terms, declared none (which stands without a second approver). */
const noCommissions=(status='approved')=>({id:'00000000-0000-4000-8000-0000000000cc',org_id:ORG,project_id:PROJECT,contract_id:PACKAGE,revision:1,status,coop_broker:'none',line_count:0,proposed_by:ACTOR,proposed_at:'2026-09-01T00:00:00Z',approved_by:status==='approved'?ACTOR:null,approved_at:status==='approved'?'2026-09-01T00:00:00Z':null,approval_note:null})
/** The signed agreement's original version, as the database writes it on signing. */
const signedOriginal=()=>({id:'00000000-0000-4000-8000-0000000000aa',org_id:ORG,project_id:PROJECT,contract_id:PACKAGE,version_number:1,kind:'original',change_order_id:null,price_delta_cents:100000,authorized_total_cents:100000,executed_at:'2026-09-01T00:00:00Z',change_order:null})
test('ready closings require current project-scoped closing authorization',async()=>{
 const h=harness();await h.check();assert.equal(h.calls[0].projectId,PROJECT);assert.equal(h.calls[0].permission,'closing.manage')
 h.deny();await assert.rejects(h.check(),/Project denied/)
})
test('reopened gates, revoked agreement, open punch and new final waiver gaps block a previously ready closing',async()=>{
 const h=harness();await h.check()
 h.gate.status='open';await assert.rejects(h.check(),/Complete or waive/);h.gate.status='complete'
 h.setExecuted(false);await assert.rejects(h.check(),/executed purchase agreement/);h.setExecuted(true)
 h.db.store.punch_items.push({id:ACTOR,org_id:ORG,project_id:PROJECT,status:'open'});await assert.rejects(h.check(),/Open punch/)
 h.db.store.punch_items=[];h.setWaivers({ready:false,missing:['Final contractor waiver']});await assert.rejects(h.check(),/Final contractor waiver/)
})
test('a resolved or closed punch item that still needs verification blocks the closing',async()=>{
 const h=harness()
 const item=(overrides)=>({id:ACTOR,org_id:ORG,project_id:PROJECT,verification_required:true,verified_at:null,...overrides})
 for(const status of ['resolved','closed']){
  h.db.store.punch_items=[item({status})]
  await assert.rejects(h.check(),/Open punch/,status)
 }
 h.db.store.punch_items=[item({status:'closed',verified_at:'2026-10-09T00:00:00Z'}),item({status:'closed',verification_required:false})]
 await h.check()
})
test('punch read failures and unavailable counts fail closed',async()=>{
 for(const error of [{message:'punch_items unavailable'},null]){
  const h=harness(),from=h.db.from.bind(h.db)
  h.db.from=table=>{const q=from(table);if(table==='punch_items')q.run=()=>({data:null,error,count:null});return q}
  await assert.rejects(h.check(),/punch_items unavailable|count is unavailable/)
 }
})
test('completed or waived gates need attribution, timestamp and a meaningful waiver reason',async()=>{
 const h=harness();h.gate.completed_by=null;await assert.rejects(h.check(),/completion evidence/)
 h.gate.completed_by=ACTOR;h.gate.completed_at='invalid';await assert.rejects(h.check(),/completion evidence/)
 h.gate.completed_at='2026-10-03T00:00:00Z';h.gate.status='waived';h.gate.notes='ok';await assert.rejects(h.check(),/waiver reason/)
 h.gate.notes='Documented exception approved';await h.check()
})
test('foreign home files and absent or overflowing gate sets cannot establish readiness',async()=>{
 const h=harness();h.gate.file_id=ACTOR;h.db.store.files=[{id:ACTOR,org_id:ORG,project_id:'another-home'}]
 await assert.rejects(h.check(),/another home/)
 h.db.store.files[0].project_id=PROJECT;await h.check()
 h.db.store.closing_checklist_items=[];await assert.rejects(h.check(),/gates are missing/)
 h.db.store.closing_checklist_items=Array.from({length:1001},()=>({...h.gate}));await assert.rejects(h.check(),/exceeds the supported limit/)
})
test('waiver input validation rejects empty and abbreviated reasons',()=>{
 const {updateClosingChecklistItemSchema}=require('../lib/validation/closings')
 assert.equal(updateClosingChecklistItemSchema.safeParse({itemId:PACKAGE,status:'waived',notes:'ok'}).success,false)
 assert.equal(updateClosingChecklistItemSchema.safeParse({itemId:PACKAGE,status:'waived',notes:'Documented exception approved'}).success,true)
})
test('settlement rechecks readiness before any money write and denied clearance cannot seed another home',async()=>{
 const h=harness();h.db.store.closings=[{id:PACKAGE,org_id:ORG,project_id:PROJECT,status:'cleared_to_close'}]
 const context={supabase:h.db,orgId:ORG,userId:ACTOR};let financial=0
 const money=async()=>{financial++;throw new Error('Money write reached')}
 stubModule('@/lib/services/context',{requireOrgContext:async()=>context})
 stubModule('@/lib/services/permissions',{requirePermission:async()=>{}})
 stubModule('@/lib/services/books/warranty-accounting',{provisionWarrantyAtClosingForService:money})
 stubModule('@/lib/services/books/inventory',{transitionInventoryForService:money})
 stubModule('@/lib/services/receivables-writer',{receivablesWriter:()=>h.db})
 stubModule('@/lib/services/invoices',{createInvoice:money})
 stubModule('@/lib/services/payments',{recordPayment:money})
 stubModule('@/lib/services/books/projector',{projectJournal:money})
 stubModule('@/lib/services/books/customer-deposits',{applyCustomerDepositWithContext:money})
 stubModule('@/lib/services/events',{recordEvent:async()=>{}})
 stubModule('@/lib/services/audit',{recordAudit:async()=>{}})
 delete require.cache[require.resolve('../lib/services/closings')]
 const {settleClosing,markClearedToClose}=require('../lib/services/closings')
 h.gate.status='open'
 await assert.rejects(settleClosing({closingId:PACKAGE,actualDate:'2026-10-03',paymentReference:'Receipt reference'}),/Complete or waive/)
 assert.equal(financial,0);assert.equal(h.db.store.closings[0].status,'cleared_to_close')
 h.db.store.closings[0].status='scheduled';h.db.store.closing_checklist_items=[];h.deny()
 await assert.rejects(markClearedToClose(PACKAGE),/Project denied/)
 assert.equal(h.db.store.closing_checklist_items.length,0)
})
test('settlement reads complete change and payment sets beyond the first PostgREST page',async()=>{
 const h=harness(),context={supabase:h.db,orgId:ORG,userId:ACTOR}
 stubModule('@/lib/services/context',{requireOrgContext:async()=>context})
 h.db.store.closings=[{id:PACKAGE,org_id:ORG,project_id:PROJECT,status:'scheduled',metadata:{}}]
 h.db.store.contracts=[{id:PACKAGE,org_id:ORG,project_id:PROJECT,contract_type:'purchase_agreement',status:'active',total_cents:100000,snapshot:{}}]
 h.db.store.purchase_agreement_versions??=[signedOriginal()]
 h.db.store.invoices=[{id:ACTOR,org_id:ORG,project_id:PROJECT,title:'Deposit',metadata:{invoice_kind:'earnest_deposit'}}]
 const id=i=>`00000000-0000-4000-8000-${i.toString(16).padStart(12,'0')}`
 h.db.store.purchase_agreement_versions=[signedOriginal(),...Array.from({length:1100},(_,i)=>({id:id(5000+i),org_id:ORG,project_id:PROJECT,contract_id:PACKAGE,version_number:i+2,kind:'amendment',change_order_id:id(i+1),price_delta_cents:10,authorized_total_cents:100000+10*(i+1),executed_at:'2026-10-03T00:00:00Z',change_order:null}))]
 h.db.store.payments=Array.from({length:1100},(_,i)=>({id:id(i+1),org_id:ORG,invoice_id:ACTOR,status:'succeeded',amount_cents:5,created_at:'2026-10-03T00:00:00Z'}))
 delete require.cache[require.resolve('../lib/services/closings')]
 const {buildSettlement}=require('../lib/services/closings')
 const settlement=await buildSettlement(PACKAGE)
  assert.equal(settlement.finalPriceCents,111000);assert.equal(settlement.balanceDueCents,105500)
  h.db.store.contracts[0].snapshot={terms:'Revised contract terms'}
  const revised=await buildSettlement(PACKAGE)
  assert.equal(revised.finalPriceCents,settlement.finalPriceCents);assert.notEqual(revised.agreementEvidenceDigest,settlement.agreementEvidenceDigest)
 h.db.store.contracts.push({...h.db.store.contracts[0],id:ACTOR})
 await assert.rejects(buildSettlement(PACKAGE),/Exactly one active/)
 h.db.store.contracts.pop()
 const from=h.db.from.bind(h.db);h.db.from=table=>{const q=from(table);if(table==='purchase_agreement_versions')q.run=()=>({data:null,error:{message:'Changes unavailable'}});return q}
 await assert.rejects(buildSettlement(PACKAGE),/Changes unavailable/)
})
test('invoice retry verifies persisted economic evidence, ignores preview time, and fails closed on lookup errors',async()=>{
 const h=harness(),context={supabase:h.db,orgId:ORG,userId:ACTOR}
 stubModule('@/lib/services/context',{requireOrgContext:async()=>context})
 const {composePurchaseAgreementPricing}=require('../lib/financials/purchase-agreement-pricing')
 const pricing=composePurchaseAgreementPricing({basePriceCents:100000,lotPremiumCents:0})
 h.db.store.closings=[{id:PACKAGE,org_id:ORG,project_id:PROJECT,status:'cleared_to_close',metadata:{},project:{name:'Home',client_id:ACTOR},lot:{lot_number:'1'}}]
 h.db.store.contracts=[{id:PACKAGE,org_id:ORG,project_id:PROJECT,contract_type:'purchase_agreement',status:'active',total_cents:100000,snapshot:{purchase_agreement:{pricing}}}]
 h.db.store.purchase_agreement_versions??=[signedOriginal()]
 h.db.store.sales_commission_plans=[noCommissions()]
 let payments=0
 stubModule('@/lib/services/payments',{recordPayment:async()=>{payments++;throw new Error('Payment boundary')}})
 delete require.cache[require.resolve('../lib/services/closings')]
 const {buildSettlement,settleClosing}=require('../lib/services/closings')
 const saved=JSON.parse(JSON.stringify(await buildSettlement(PACKAGE)));saved.builtAt='2000-01-01T00:00:00Z'
 const invoice={id:ACTOR,org_id:ORG,project_id:PROJECT,total_cents:100000,metadata:{invoice_kind:'closing',source_closing_id:PACKAGE,settlement:saved}}
 h.db.store.invoices=[invoice]
 const input={closingId:PACKAGE,actualDate:'2026-10-03',paymentReference:'Receipt reference'}
 await assert.rejects(settleClosing(input),/Payment boundary/);assert.equal(payments,1)
 h.db.store.contracts[0].snapshot.terms='Changed terms, identical price'
 await assert.rejects(settleClosing(input),/settlement evidence differs/);assert.equal(payments,1)
 delete h.db.store.invoices[0].metadata.settlement
 await assert.rejects(settleClosing(input),/settlement evidence differs or is missing/);assert.equal(payments,1)
 const from=h.db.from.bind(h.db);h.db.from=table=>{const q=from(table);if(table==='invoices')q.run=()=>({data:null,error:{message:'Invoice lookup unavailable'}});return q}
 await assert.rejects(settleClosing(input),/Invoice lookup unavailable/);assert.equal(payments,1)
})
test('a gate reopened while funds are recorded prevents final closed state',async()=>{
 const h=harness(),context={supabase:h.db,orgId:ORG,userId:ACTOR}
 stubModule('@/lib/services/context',{requireOrgContext:async()=>context})
 const {composePurchaseAgreementPricing}=require('../lib/financials/purchase-agreement-pricing')
 const pricing=composePurchaseAgreementPricing({basePriceCents:100000,lotPremiumCents:0})
 h.db.store.closings=[{id:PACKAGE,org_id:ORG,project_id:PROJECT,status:'cleared_to_close',metadata:{},project:{name:'Home',client_id:ACTOR},lot:{lot_number:'1'}}]
 h.db.store.contracts=[{id:PACKAGE,org_id:ORG,project_id:PROJECT,contract_type:'purchase_agreement',status:'active',total_cents:100000,snapshot:{purchase_agreement:{pricing}}}]
 h.db.store.purchase_agreement_versions??=[signedOriginal()]
 h.db.store.sales_commission_plans=[noCommissions()]
 let payments=0
 stubModule('@/lib/services/payments',{recordPayment:async()=>{payments++;h.gate.status='open'}})
 stubModule('@/lib/services/books/projector',{projectJournal:async()=>({failures:[]})})
 delete require.cache[require.resolve('../lib/services/closings')]
 const {buildSettlement,settleClosing}=require('../lib/services/closings')
 const saved=JSON.parse(JSON.stringify(await buildSettlement(PACKAGE)))
 h.db.store.invoices=[{id:ACTOR,org_id:ORG,project_id:PROJECT,total_cents:100000,metadata:{invoice_kind:'closing',source_closing_id:PACKAGE,settlement:saved}}]
 await assert.rejects(settleClosing({closingId:PACKAGE,actualDate:'2026-10-03',paymentReference:'Receipt reference'}),/funds are recorded; resolve readiness.*Complete or waive/)
 assert.equal(payments,1);assert.equal(h.db.store.closings[0].status,'cleared_to_close')
})
test('closed homes preserve original settlement despite edited or missing live sources and reject corrupt history',async()=>{
 const h=harness(),context={supabase:h.db,orgId:ORG,userId:ACTOR}
 stubModule('@/lib/services/context',{requireOrgContext:async()=>context})
 const {composePurchaseAgreementPricing}=require('../lib/financials/purchase-agreement-pricing')
 const pricing=composePurchaseAgreementPricing({basePriceCents:100000,lotPremiumCents:0})
 h.db.store.closings=[{id:PACKAGE,org_id:ORG,project_id:PROJECT,status:'cleared_to_close',metadata:{}}]
 h.db.store.contracts=[{id:PACKAGE,org_id:ORG,project_id:PROJECT,contract_type:'purchase_agreement',number:'PA-1',signed_at:'2026-09-01T00:00:00Z',status:'active',total_cents:100000,snapshot:{purchase_agreement:{pricing}}}]
 h.db.store.purchase_agreement_versions??=[signedOriginal()]
 h.db.store.invoices=[{id:ACTOR,org_id:ORG,project_id:PROJECT,title:'Earnest money',metadata:{invoice_kind:'earnest_deposit'}}]
 h.db.store.payments=[{id:PROJECT,org_id:ORG,invoice_id:ACTOR,status:'succeeded',amount_cents:1000,created_at:'2026-09-02T00:00:00Z'}]
 delete require.cache[require.resolve('../lib/services/closings')]
 const {buildSettlement}=require('../lib/services/closings')
 const original=JSON.parse(JSON.stringify(await buildSettlement(PACKAGE)))
 h.db.store.closings[0].status='closed';h.db.store.closings[0].settlement=original
 h.db.store.contracts=[];h.db.store.payments=[]
 h.db.store.change_orders=[{id:ACTOR,org_id:ORG,project_id:PROJECT,status:'approved',total_cents:20000}]
 const from=h.db.from.bind(h.db),reads=[];h.db.from=table=>{reads.push(table);return from(table)}
 const final=await buildSettlement(PACKAGE)
 assert.equal(final.finalPriceCents,100000);assert.equal(final.balanceDueCents,99000)
 assert.equal(final.agreement.number,'PA-1');assert.equal(final.agreement.signed_at,'2026-09-01T00:00:00Z')
 assert.equal(reads.some(table=>['contracts','payments','change_orders','invoices'].includes(table)),false)
 h.db.store.closings[0].settlement.balanceDueCents=1
 await assert.rejects(buildSettlement(PACKAGE),/does not reconcile/)
 h.db.store.closings[0].settlement={}
 await assert.rejects(buildSettlement(PACKAGE),/evidence is missing or invalid/)
})
test('closed completion recovers checked home handoff without money writes and surfaces queue or attachment failures',async()=>{
 const h=harness(),context={supabase:h.db,orgId:ORG,userId:ACTOR}
 stubModule('@/lib/services/context',{requireOrgContext:async()=>context})
 const {composePurchaseAgreementPricing}=require('../lib/financials/purchase-agreement-pricing')
 const pricing=composePurchaseAgreementPricing({basePriceCents:100000,lotPremiumCents:0})
 h.db.store.closings=[{id:PACKAGE,org_id:ORG,project_id:PROJECT,status:'cleared_to_close',metadata:{}}]
 h.db.store.contracts=[{id:PACKAGE,org_id:ORG,project_id:PROJECT,contract_type:'purchase_agreement',status:'active',total_cents:100000,snapshot:{purchase_agreement:{pricing}}}]
 h.db.store.purchase_agreement_versions??=[signedOriginal()]
 let queues=0,money=0,result={enqueued:false,reason:'error'}
 stubModule('@/lib/services/outbox',{enqueueOutboxJob:async input=>{queues++;assert.equal(input.payload.effective_date,'2026-10-03');return result}})
 stubModule('@/lib/services/payments',{recordPayment:async()=>{money++}})
 delete require.cache[require.resolve('../lib/services/closings')]
 const {buildSettlement,recoverClosingCompletion}=require('../lib/services/closings')
 const saved=JSON.parse(JSON.stringify(await buildSettlement(PACKAGE)))
 Object.assign(h.db.store.closings[0],{status:'closed',actual_date:'2026-10-03',closing_invoice_id:ACTOR,lot_id:PACKAGE,settlement:saved,metadata:{settlement_statement_file_id:ACTOR}})
 h.db.store.invoices=[{id:ACTOR,org_id:ORG,project_id:PROJECT,total_cents:100000,metadata:{invoice_kind:'closing',source_closing_id:PACKAGE,settlement:saved}}]
 h.db.store.lots=[{id:PACKAGE,org_id:ORG,project_id:'other-home',status:'sold'}]
 const realFrom=h.db.from.bind(h.db)
 // The shared fake does not implement cardinality on updates. Model the
 // PostgREST single-row response for this conditional lot update explicitly.
 h.db.from=table=>{const q=realFrom(table);if(table==='lots'){const run=q.run.bind(q);q.run=()=>{const r=run();if(q.cardinality==='single'&&Array.isArray(r.data))return r.data.length===1?{data:r.data[0],error:null}:{data:null,error:{message:'Single row unavailable'}};return r}}return q}
 await assert.rejects(recoverClosingCompletion(PROJECT,PACKAGE),/resolving the lot/);assert.equal(queues,0)
 h.db.store.lots[0].project_id=PROJECT
 await assert.rejects(recoverClosingCompletion(PROJECT,PACKAGE),/could not be queued/)
 assert.equal(h.db.store.lots[0].status,'closed')
 result={enqueued:true,id:1}
 await assert.rejects(recoverClosingCompletion(PROJECT,PACKAGE),/statement is unavailable/)
 h.db.store.files=[{id:ACTOR,org_id:ORG,project_id:PROJECT,archived_at:null}]
 const {SETTLEMENT_STATEMENT_LINK_ROLE}=require('../lib/invoices/attachment-roles')
 h.db.store.file_links=[{id:PACKAGE,org_id:ORG,project_id:PROJECT,file_id:ACTOR,entity_type:'invoice',entity_id:ACTOR,link_role:SETTLEMENT_STATEMENT_LINK_ROLE}]
 assert.equal((await recoverClosingCompletion(PROJECT,PACKAGE)).statementFiled,true)
 result={enqueued:false,reason:'duplicate'}
 assert.equal((await recoverClosingCompletion(PROJECT,PACKAGE)).warrantyQueued,true)
 assert.equal(money,0);assert.equal(h.db.store.files.length,1)
 h.deny();await assert.rejects(recoverClosingCompletion(PROJECT,PACKAGE),/Project denied/)
})
function mutationHarness(){
 const h=harness(),context={supabase:h.db,orgId:ORG,userId:ACTOR};let beforeUpdate=null
 h.db.store.closings=[{id:PACKAGE,org_id:ORG,project_id:PROJECT,status:'scheduled',metadata:{adjustments:[{id:ACTOR,label:'Credit',kind:'seller_credit',amountCents:-100}]}}]
 const recorded=[]
 stubModule('@/lib/services/context',{requireOrgContext:async()=>context})
 stubModule('@/lib/services/permissions',{requirePermission:async()=>{}})
 stubModule('@/lib/services/events',{recordEvent:async input=>recorded.push(input)})
 stubModule('@/lib/services/audit',{recordAudit:async input=>recorded.push(input)})
 const from=h.db.from.bind(h.db)
 h.db.from=table=>{const q=from(table),eq=q.eq.bind(q),run=q.run.bind(q)
  // Model JSONB equality and single-row mutation cardinality that the shared
  // fake does not implement; both are actual PostgREST contracts used here.
  q.eq=(column,value)=>column==='metadata'&&typeof value==='string'?q.addFilter(row=>require('node:util').isDeepStrictEqual(row.metadata,JSON.parse(value))):eq(column,value)
  q.run=()=>{if(q.action==='update'&&beforeUpdate){const hook=beforeUpdate;beforeUpdate=null;hook()}
   const result=run();if(q.action==='update'&&q.cardinality==='single'&&Array.isArray(result.data))return result.data.length===1?{data:result.data[0],error:null}:{data:null,error:{message:'Single row unavailable'}}
   return result
  };return q
 }
 delete require.cache[require.resolve('../lib/services/closings')]
 return {...h,recorded,service:require('../lib/services/closings'),race:hook=>{beforeUpdate=hook}}
}
test('scheduling, checklist and adjustments authorize the home before any mutation',async()=>{
 for(const action of [h=>h.service.scheduleClosing({closingId:PACKAGE,scheduledDate:'2026-10-04'}),h=>h.service.updateClosingChecklistItem({itemId:PACKAGE,status:'open'}),h=>h.service.upsertClosingAdjustment({closingId:PACKAGE,label:'Credit',kind:'seller_credit',amountCents:-200}),h=>h.service.removeClosingAdjustment({closingId:PACKAGE,adjustmentId:ACTOR})]){
  const h=mutationHarness(),before=JSON.stringify(h.db.store);h.deny()
  await assert.rejects(action(h),/Project denied/);assert.equal(JSON.stringify(h.db.store),before);assert.equal(h.recorded.length,0)
  assert.equal(h.calls[0].projectId,PROJECT)
 }
})
test('closed and cancelled homes refuse checklist or adjustment edits',async()=>{
 for(const status of ['closed','cancelled']){
  const h=mutationHarness();h.db.store.closings[0].status=status
  await assert.rejects(h.service.updateClosingChecklistItem({itemId:PACKAGE,status:'open'}),/evidence cannot be changed/)
  await assert.rejects(h.service.upsertClosingAdjustment({closingId:PACKAGE,label:'Credit',kind:'seller_credit',amountCents:-200}),/evidence cannot be changed/)
  assert.equal(h.recorded.length,0)
 }
})
test('checklist file evidence is home scoped and explicit null clears stale file and notes',async()=>{
 const h=mutationHarness();h.db.store.files=[{id:ACTOR,org_id:ORG,project_id:PACKAGE,archived_at:null}]
 await assert.rejects(h.service.updateClosingChecklistItem({itemId:PACKAGE,status:'complete',fileId:ACTOR}),/belong to this home/)
 h.db.store.files[0].project_id=PROJECT
 await h.service.updateClosingChecklistItem({itemId:PACKAGE,status:'complete',fileId:ACTOR,notes:'Verified document'})
 assert.equal(h.db.store.closing_checklist_items[0].completed_by,ACTOR)
 await h.service.updateClosingChecklistItem({itemId:PACKAGE,status:'open',fileId:null,notes:null})
 assert.equal(h.db.store.closing_checklist_items[0].file_id,null);assert.equal(h.db.store.closing_checklist_items[0].notes,null)
})
test('schedule state races and adjustment metadata races reject stale writes without events',async()=>{
 for(const action of [h=>h.service.scheduleClosing({closingId:PACKAGE,scheduledDate:'2026-10-04'})]){
  const h=mutationHarness();h.race(()=>{h.db.store.closings[0].status='closed'})
  await assert.rejects(action(h));assert.equal(h.db.store.closings[0].status,'closed');assert.equal(h.recorded.length,0)
 }
 const h=mutationHarness();h.race(()=>{h.db.store.closings[0].metadata={anotherCoordinator:'Saved change'}})
 await assert.rejects(h.service.upsertClosingAdjustment({closingId:PACKAGE,label:'Credit',kind:'seller_credit',amountCents:-200}),/changed concurrently/)
 assert.deepEqual(h.db.store.closings[0].metadata,{anotherCoordinator:'Saved change'});assert.equal(h.recorded.length,0)
})
test('authorized adjustment writes preserve metadata',async()=>{
 const h=mutationHarness();await h.service.upsertClosingAdjustment({closingId:PACKAGE,id:ACTOR,label:'Revised credit',kind:'seller_credit',amountCents:-250})
 assert.equal(h.db.store.closings[0].metadata.adjustments[0].amountCents,-250)
 await h.service.removeClosingAdjustment({closingId:PACKAGE,adjustmentId:ACTOR});assert.equal(h.db.store.closings[0].metadata.adjustments.length,0)
})
test('a required inspection without an accepted attempt blocks closing, with no flag to turn it off',async()=>{
 const h=harness();h.inspections.result={data:null,error:{message:'Final inspection has no accepted attempt'}}
 await assert.rejects(h.check(),/Required inspection readiness: Final inspection has no accepted attempt/)
 h.inspections.result={data:{ready:true},error:null};await h.check();assert.equal(h.inspections.calls,2)
})
test('an open or failed milestone required before closing blocks it; tracked and resolved ones do not',async()=>{
 const h=harness(),row=overrides=>({title:'Appraisal received',status:'open',requiredBefore:'closing',dueOn:'2026-10-20',...overrides})
 h.milestones.push(row({}));await assert.rejects(h.check(),/Resolve the Appraisal received milestone before closing/)
 h.milestones[0]=row({title:'Sale of buyer home',status:'failed'});await assert.rejects(h.check(),/Sale of buyer home failed\. Waive it with a reason/)
 h.milestones[0]=row({status:'open',requiredBefore:null});await h.check()
 h.milestones[0]=row({status:'waived'});await h.check()
})
test('the certificate of occupancy gate needs its evidence file and cannot stand waived',async()=>{
 const h=harness();h.gate.evidence_required=true
 await assert.rejects(h.check(),/Attach the evidence file to complete Occupancy clearance/)
 h.gate.status='waived';h.gate.notes='Inspector verbally approved';await assert.rejects(h.check(),/cannot be waived/)
 h.gate.status='complete';h.gate.file_id=ACTOR;h.db.store.files=[{id:ACTOR,org_id:ORG,project_id:PROJECT}];await h.check()
})
test('the agreement in force closes only with approved commission terms or an explicit none',async()=>{
 const h=harness()
 h.db.store.contracts=[{id:PACKAGE,org_id:ORG,project_id:PROJECT,contract_type:'purchase_agreement',status:'active',total_cents:100000,snapshot:{}}]
 await assert.rejects(h.check(),/Set the agreement's commissions, or declare none, before closing/)
 h.db.store.sales_commission_plans=[{...noCommissions('proposed'),line_count:1,coop_broker:'broker'}]
 await assert.rejects(h.check(),/commission terms are waiting for approval/)
 h.db.store.sales_commission_plans=[noCommissions()];await h.check()
 h.db.store.contracts[0].status='void';h.db.store.sales_commission_plans=[];await h.check()
})
