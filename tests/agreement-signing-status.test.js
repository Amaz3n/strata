const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),test=require('node:test')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
require('../scripts/register-ts-node-test')
function fixture({denied=false,failedTable=null,flag=true,manage=true,patch={}}={}) {
 const source={id:id(1),org_id:id(2),project_id:id(3),title:'Agreement',number:'PA-1',terms:'Frozen terms',total_cents:30000000,currency:'usd',effective_date:'2026-10-03',buyer_contact_id:id(4),co_buyer_contact_id:null,snapshot:{purchase_agreement:{configuration:{lot_id:id(10),house_plan_id:null,house_plan_version_id:null,elevation_id:null,swing:'left'}}}}
 const calls=[],tables={contracts:[{...source,contract_type:'purchase_agreement',status:'draft'}],documents:[{id:id(5),org_id:id(2),project_id:id(3),source_entity_type:'contract',source_entity_id:id(1),status:'sent',current_revision:1,metadata:{purchase_agreement:true,agreement_signing_input:structuredClone(source)}}],envelopes:[{id:id(6),org_id:id(2),document_id:id(5),status:'sent',document_revision:1}],document_signing_requests:[
 {id:id(7),org_id:id(2),document_id:id(5),envelope_id:id(6),revision:1,status:'sent',sequence:1,required:true,signer_role:'buyer',recipient_contact_id:id(4),token_hash:'must-not-escape',delivery_status:null,provider_email_id:null},
 {id:id(8),org_id:id(2),document_id:id(5),envelope_id:id(6),revision:1,status:'draft',sequence:2,required:true,signer_role:'builder',recipient_contact_id:null,token_hash:'must-not-escape'},
 ],lots:[{id:id(10),org_id:id(2),project_id:id(3),status:'assigned',house_plan_id:null,house_plan_version_id:null,house_plan_elevation_id:null,swing:'left'}],lot_reservations:[{id:id(11),org_id:id(2),contract_id:id(1),lot_id:id(10),status:'reserved'}],...patch}
 const supabase={from(table){let rows=tables[table]??[];const record={table,filters:[],cap:null};calls.push(record);const q={select(columns){record.columns=columns;if(table==='lots')for(const column of columns.split(','))assert.ok(Object.hasOwn(tables.lots[0],column),`Unknown lot column ${column}`);return q},eq(k,v){record.filters.push([k,v]);rows=rows.filter(r=>r[k]===v);return q},contains(k,v){rows=rows.filter(r=>Object.entries(v).every(([key,value])=>r[k]?.[key]===value));return q},limit(n){record.cap=n;rows=rows.slice(0,n);return q},maybeSingle:async()=>({data:rows[0]??null,error:failedTable===table?{message:'read failed'}:null}),then(resolve,reject){return Promise.resolve({data:rows,error:failedTable===table?{message:'read failed'}:null}).then(resolve,reject)}};return q}}
 const compiled={exports:{}}
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/services/agreement-signing-status.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:compiled.exports,process:{env:{DOCUMENT_SIGNING_SECRET:'test-only',ARC_AGREEMENT_DURABLE_SIGNING_ENABLED:flag?'true':'false'}},require(name){
 if(name==='zod')return require(name)
 if(name==='@/lib/sales/agreement-signing-state')return require('../lib/sales/agreement-signing-state')
 if(name==='@/lib/sales/agreement-signing-source')return require('../lib/sales/agreement-signing-source')
 if(name==='@/lib/storage/files-storage')return {getFilesStorageProvider:()=> 'r2'}
 if(name==='@/lib/services/context')return {requireOrgContext:async()=>({supabase,orgId:id(2),userId:id(9)})}
 if(name==='@/lib/services/permissions')return {requirePermission:async()=>{},hasPermission:async()=>manage}
 if(name==='@/lib/services/authorization')return {requireAuthorization:async()=>{calls.push({authorization:true});if(denied)throw new Error('Home denied')},authorize:async()=>({allowed:manage})}
 return {}
 }})
 return {run:()=>compiled.exports.getAgreementSigningState(id(1)),calls,tables}
}
test('status reads are actual-home authorized, tenant scoped, bounded and return no credentials',async()=>{
 const f=fixture(),state=await f.run()
 assert.equal(state.stage,'queued')
 assert.ok(!JSON.stringify(state).includes('must-not-escape'))
 assert.ok(f.calls.findIndex(c=>c.authorization)<f.calls.findIndex(c=>c.table==='documents'))
 for(const call of f.calls.filter(c=>c.table))assert.ok(call.filters.some(([k,v])=>k==='org_id'&&v===id(2)))
 assert.equal(f.calls.find(c=>c.table==='documents').cap,2)
 assert.equal(f.calls.find(c=>c.table==='envelopes').cap,2)
 assert.equal(f.calls.find(c=>c.table==='document_signing_requests').cap,4)
 const denied=fixture({denied:true});await assert.rejects(denied.run(),/Home denied/);assert.ok(!denied.calls.some(c=>c.table==='documents'))
})
test('preparation, disabled recovery and read failures do not invent sent evidence',async()=>{
 const f=fixture();f.tables.documents=[]
 assert.equal((await f.run()).stage,'not_prepared')
 const off=fixture({flag:false});off.tables.documents=[];assert.equal((await off.run()).canResume,false)
 const prepared=fixture();prepared.tables.documents[0].status='draft';prepared.tables.envelopes=[];prepared.tables.document_signing_requests=[]
 assert.equal((await prepared.run()).stage,'prepared');assert.equal((await prepared.run()).canResume,true)
 for(const failedTable of ['documents','envelopes','document_signing_requests'])assert.equal((await fixture({failedTable}).run()).stage,'unavailable')
})
test('multiple packets, overflow, orphaned requests and mismatched revisions fail closed',async()=>{
 for(const alter of [f=>f.tables.documents.push({...f.tables.documents[0],id:id(20)}),f=>f.tables.envelopes.push({...f.tables.envelopes[0],id:id(20)}),f=>f.tables.document_signing_requests.push(...Array.from({length:4},(_,i)=>({...f.tables.document_signing_requests[0],id:id(20+i)}))),f=>f.tables.envelopes[0].document_revision=2,f=>f.tables.document_signing_requests[0].envelope_id=id(99),f=>f.tables.document_signing_requests[0].revision=2]){
  const f=fixture();alter(f);assert.equal((await f.run()).stage,'reconcile')
 }
 const orphan=fixture();orphan.tables.envelopes=[];orphan.tables.documents[0].status='draft';assert.equal((await orphan.run()).stage,'reconcile')
})


test('frozen source drift disables recovery before reading signer credentials',async()=>{
 for(const [field,value] of [['terms','Changed terms'],['title','New title'],['total_cents',30000001],['buyer_contact_id',id(99)],['effective_date','2026-10-04'],['currency','cad']]){
  const f=fixture();f.tables.contracts[0][field]=value
  const state=await f.run();assert.equal(state.stage,'reconcile');assert.equal(state.canResume,false);assert.match(state.detail,/differs from the source/)
  assert.ok(!f.calls.some(c=>c.table==='document_signing_requests'))
 }
 for(const input of [{},null,{id:id(1)},[]]){const f=fixture();f.tables.documents[0].metadata.agreement_signing_input=input;assert.equal((await f.run()).stage,'reconcile')}
 const f=fixture();f.tables.documents[0].metadata.agreement_signing_input=Object.fromEntries(Object.entries(f.tables.documents[0].metadata.agreement_signing_input).reverse())
 assert.equal((await f.run()).stage,'queued','JSON object key order is immaterial')
})
test('preparation status requires current lot configuration and exactly one bound active reservation',async()=>{
 for(const alter of [f=>f.tables.lots[0].status='closed',f=>f.tables.lots[0].swing='right',f=>f.tables.lots[0].house_plan_elevation_id=id(99),f=>f.tables.lots[0].project_id=id(99),f=>f.tables.lot_reservations=[],f=>f.tables.lot_reservations[0].status='released',f=>f.tables.lot_reservations[0].lot_id=id(99),f=>f.tables.lot_reservations.push({...f.tables.lot_reservations[0],id:id(99),status:'released'})]){
  for(const hasDocument of [true,false]){
   const f=fixture();f.tables.documents[0].status='draft';f.tables.envelopes=[];f.tables.document_signing_requests=[]
   if(!hasDocument)f.tables.documents=[]
   alter(f);const state=await f.run();assert.equal(state.stage,'reconcile');assert.equal(state.canResume,false)
   const reservations=f.calls.find(c=>c.table==='lot_reservations');if(reservations)assert.equal(reservations.cap,2)
  }
 }
 for(const failedTable of ['lots','lot_reservations']){const f=fixture({failedTable});f.tables.documents=[];assert.equal((await f.run()).stage,'unavailable')}
 const published=fixture();published.tables.lots[0].status='closed';assert.equal((await published.run()).stage,'queued','published packets use their frozen source; later home lifecycle is not preparation eligibility')
 const legacy=fixture();legacy.tables.documents[0].status='draft';delete legacy.tables.documents[0].metadata.agreement_signing_input;legacy.tables.envelopes=[];legacy.tables.document_signing_requests=[]
 const state=await legacy.run();assert.equal(state.stage,'prepared');assert.equal(state.canResume,false);assert.ok(!state.detail.includes('Resume'))
})
