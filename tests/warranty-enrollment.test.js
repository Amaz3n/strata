require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {createFakeSupabase}=require('./support/fake-supabase')
const {stubModule,ORG,PROJECT,PACKAGE}=require('./support/starts-harness')
function harness(){
 const term={key:'workmanship',label:'Workmanship',duration_months:12,is_structural:false,description:null}
 const db=createFakeSupabase({projects:[{id:PROJECT,org_id:ORG}],closings:[{id:PACKAGE,org_id:ORG,project_id:PROJECT,status:'closed',actual_date:'2026-10-03'}],warranty_programs:[{id:PACKAGE,org_id:ORG,is_default:true,is_active:true}],warranty_coverage_terms:[{org_id:ORG,program_id:PACKAGE,sort_order:1,...term}]})
 let failEvent=false,seeds=0
 stubModule('@/lib/services/events',{recordEvent:async input=>{if(failEvent)throw new Error('Event failed');if(!db.store.events.some(e=>e.id===input.idempotencyId))db.store.events.push({id:input.idempotencyId,org_id:input.orgId,event_type:input.eventType,entity_type:input.entityType,entity_id:input.entityId,payload:input.payload})}})
 delete require.cache[require.resolve('../lib/services/warranty-enrollment')]
 const {enrollSystemWarrantyCoverage}=require('../lib/services/warranty-enrollment')
 const input={orgId:ORG,projectId:PROJECT,effectiveDate:'2026-10-03',source:'closing'}
 return {db,term,input,run:()=>enrollSystemWarrantyCoverage(db,input,async()=>{seeds++}),seeds:()=>seeds,failEvent:value=>{failEvent=value}}
}
test('enrollment preserves original term snapshot and repairs missing event without another coverage',async()=>{
 const h=harness();h.failEvent(true);await assert.rejects(h.run(),/Event failed/)
 assert.equal(h.db.store.project_warranty_coverage.length,1)
 h.db.store.warranty_coverage_terms[0].duration_months=24;h.failEvent(false)
 const recovered=await h.run();assert.equal(recovered.enrolled,false);assert.equal(h.seeds(),1)
 assert.equal(h.db.store.project_warranty_coverage[0].terms_snapshot[0].expires_on,'2027-10-03')
 await h.run();assert.equal(h.db.store.events.length,1)
})
test('source dates, invalid calendar dates and unavailable home evidence block all enrollment writes',async()=>{
 for(const mutate of [h=>h.input.effectiveDate='2026-02-30',h=>h.db.store.closings[0].status='scheduled',h=>h.db.store.closings[0].actual_date='2026-10-02',h=>h.db.store.projects[0].org_id=PACKAGE]){
  const h=harness();mutate(h);await assert.rejects(h.run());assert.equal(h.seeds(),0);assert.equal((h.db.store.project_warranty_coverage??[]).length,0)
 }
})
test('read failures do not become missing coverage or missing program',async()=>{
 for(const table of ['projects','closings','project_warranty_coverage','warranty_programs','warranty_coverage_terms','events']){
  const h=harness(),from=h.db.from.bind(h.db);h.db.from=t=>{const q=from(t);if(t===table)q.run=()=>({data:null,error:{message:'Read unavailable'}});return q}
  await assert.rejects(h.run(),/unavailable/i)
 }
})
test('ambiguous default programs, absent or duplicate terms cannot enroll a home',async()=>{
 for(const mutate of [h=>h.db.store.warranty_programs.push({...h.db.store.warranty_programs[0],id:PROJECT}),h=>h.db.store.warranty_coverage_terms=[],h=>h.db.store.warranty_coverage_terms.push({...h.db.store.warranty_coverage_terms[0]})]){
  const h=harness();mutate(h);await assert.rejects(h.run());assert.equal((h.db.store.project_warranty_coverage??[]).length,0)
 }
})
test('unique insert conflict reuses a matching winner and rejects conflicting coverage',async()=>{
 for(const conflict of [false,true]){
  const h=harness(),from=h.db.from.bind(h.db);h.db.from=t=>{const q=from(t),run=q.run.bind(q);q.run=()=>{if(t==='project_warranty_coverage'&&q.action==='insert'){
   h.db.store.project_warranty_coverage.push({...q.payload,effective_date:conflict?'2026-10-02':q.payload.effective_date});return {data:null,error:{code:'23505',message:'Competing insert'}}
  }return run()};return q}
  if(conflict)await assert.rejects(h.run(),/conflicts/);else assert.equal((await h.run()).enrolled,false)
  assert.equal(h.db.store.project_warranty_coverage.length,1)
 }
})
test('corrupt expiry or mismatched enrollment event requires reconciliation',async()=>{
 const h=harness();await h.run();h.db.store.project_warranty_coverage[0].terms_snapshot[0].expires_on='2030-10-03'
 await assert.rejects(h.run(),/term evidence does not reconcile/)
 h.db.store.project_warranty_coverage[0].terms_snapshot[0].expires_on='2027-10-03';h.db.store.events[0].payload.project_id=PACKAGE
 await assert.rejects(h.run(),/event does not match/)
})
test('completion enrollment uses its recorded substantial completion date even after package reopens',async()=>{
 const h=harness();h.input.source='completion';h.db.store.closeout_packages=[{id:PACKAGE,org_id:ORG,project_id:PROJECT,status:'in_progress',substantial_completion_date:'2026-10-03'}]
 assert.equal((await h.run()).enrolled,true);assert.equal(h.db.store.project_warranty_coverage[0].effective_source,'completion')
})
test('competing callers converge on one coverage and one enrollment event at the unique-insert boundary',async()=>{
 const h=harness(),from=h.db.from.bind(h.db)
 h.db.from=table=>{const q=from(table),run=q.run.bind(q);q.run=()=>{
  if(table==='project_warranty_coverage'&&q.action==='insert'&&h.db.store.project_warranty_coverage.length)return {data:null,error:{code:'23505',message:'Unique project coverage'}}
  return run()
 };return q}
 const results=await Promise.all([h.run(),h.run()])
 assert.equal(results.filter(row=>row.enrolled).length,1);assert.equal(results[0].id,results[1].id)
 assert.equal(h.db.store.project_warranty_coverage.length,1);assert.equal(h.db.store.events.length,1)
})
test('manual enrollment authorizes the home before default or coverage writes',async()=>{
 const h=harness(),calls=[]
 stubModule('@/lib/services/context',{requireOrgContext:async()=>({supabase:h.db,orgId:ORG,userId:PACKAGE})})
 stubModule('@/lib/services/permissions',{requirePermission:async()=>{}})
 stubModule('@/lib/services/authorization',{requireAuthorization:async input=>{calls.push(input);throw new Error('Home access denied')}})
 stubModule('@/lib/supabase/server',{createServiceSupabaseClient:()=>h.db})
 stubModule('@/lib/services/audit',{recordAudit:async()=>{}})
 stubModule('@/lib/services/mailer',{})
 stubModule('@/lib/services/vendor-bills',{})
 delete require.cache[require.resolve('../lib/services/warranty-operations')]
 const {enrollProjectWarrantyCoverage}=require('../lib/services/warranty-operations')
 await assert.rejects(enrollProjectWarrantyCoverage({projectId:PROJECT,effectiveDate:'2026-10-03'},ORG),/Home access denied/)
 assert.equal(calls[0].projectId,PROJECT);assert.equal(calls[0].permission,'warranty.manage')
 assert.equal((h.db.store.project_warranty_coverage??[]).length,0)
})
test('manual enrollment rejects read failures, invalid dates and ambiguous program selection',async()=>{
 for(const failure of ['project_warranty_coverage','closings','invalid-date','ambiguous-program']){
  const h=harness()
  stubModule('@/lib/services/context',{requireOrgContext:async()=>({supabase:h.db,orgId:ORG,userId:PACKAGE})})
  stubModule('@/lib/services/authorization',{requireAuthorization:async()=>{}})
  if(failure==='ambiguous-program')h.db.store.warranty_programs.push({...h.db.store.warranty_programs[0],id:PROJECT})
  const from=h.db.from.bind(h.db);h.db.from=table=>{const q=from(table);if(table===failure)q.run=()=>({data:null,error:{message:'Source unavailable'}});return q}
  delete require.cache[require.resolve('../lib/services/warranty-operations')]
  const {enrollProjectWarrantyCoverage}=require('../lib/services/warranty-operations')
  await assert.rejects(enrollProjectWarrantyCoverage({projectId:PROJECT,effectiveDate:failure==='invalid-date'?'2026-02-30':'2026-10-03'},ORG))
  assert.equal((h.db.store.project_warranty_coverage??[]).length,0)
 }
})
test('closing enrolls the program the agreement sold, not the default at settlement',async()=>{
 const h=harness(),SOLD='00000000-0000-4000-8000-0000000000aa'
 h.db.store.warranty_programs.push({id:SOLD,org_id:ORG,is_default:false,is_active:false})
 h.db.store.warranty_coverage_terms.push({org_id:ORG,program_id:SOLD,sort_order:1,...h.term,duration_months:24})
 h.db.store.contracts=[{id:PROJECT,org_id:ORG,project_id:PROJECT,contract_type:'purchase_agreement',status:'active',signed_at:'2026-06-01',warranty_program_id:SOLD}]
 await h.run()
 assert.equal(h.db.store.project_warranty_coverage[0].program_id,SOLD)
 assert.equal(h.db.store.project_warranty_coverage[0].terms_snapshot[0].expires_on,'2028-10-03')
})
test('closing enrolls on the terms the agreement captured, not the program as edited since',async()=>{
 const h=harness(),SOLD='00000000-0000-4000-8000-0000000000aa'
 h.db.store.warranty_programs.push({id:SOLD,org_id:ORG,is_default:false,is_active:true})
 h.db.store.warranty_coverage_terms.push({org_id:ORG,program_id:SOLD,sort_order:1,...h.term,duration_months:6})
 h.db.store.contracts=[{id:PROJECT,org_id:ORG,project_id:PROJECT,contract_type:'purchase_agreement',status:'active',signed_at:'2026-06-01',warranty_program_id:SOLD,warranty_terms_snapshot:[{...h.term,duration_months:24}]}]
 await h.run()
 assert.equal(h.db.store.project_warranty_coverage[0].program_id,SOLD)
 assert.equal(h.db.store.project_warranty_coverage[0].terms_snapshot[0].expires_on,'2028-10-03')
})
test('a home whose closing was reversed enrolls again on its new closing date',async()=>{
 const h=harness()
 h.db.store.project_warranty_coverage=[{id:PACKAGE,org_id:ORG,project_id:PROJECT,program_id:PACKAGE,effective_date:'2026-09-01',effective_source:'closing',terms_snapshot:[{...h.term,expires_on:'2027-09-01'}],voided_at:'2026-09-20T00:00:00Z'}]
 const result=await h.run()
 assert.equal(result.enrolled,true)
 assert.deepEqual(h.db.store.project_warranty_coverage.filter(row=>!row.voided_at).map(row=>row.effective_date),['2026-10-03'])
})
