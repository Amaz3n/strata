const assert=require('node:assert/strict'),fs=require('node:fs'),test=require('node:test')
const {setup,id,ownership}=require('./fixtures/agreement-signing-database')
test('agreement reservation owns one immutable packet and preserves original builder across another authorized actor',async t=>{
 const f=await setup(t)
 assert.equal((await f.reserve({probe:true})).rows[0].document,null)
 const first=(await f.reserve()).rows[0].document
 assert.equal(first.created_by,f.actor)
 assert.equal(first.source_file_id,f.file)
 await assert.rejects(f.db.query("insert into documents(org_id,project_id,title,source_file_id,source_entity_type,source_entity_id,metadata) values($1,$2,'Duplicate',$3,'contract',$4,'{\"purchase_agreement\":true}')",[f.org,f.home,f.file,f.contract]),/documents_purchase_agreement_owner_unique/)
 const second=(await f.reserve({actor:f.other,probe:true})).rows[0].document
 assert.equal(second.id,first.id)
 assert.deepEqual(second.metadata.draft_recipients,first.metadata.draft_recipients)
 const candidate=id(20);await f.db.query("insert into files(id,org_id,project_id,file_name,storage_path,checksum) values($1,$2,$3,'loser.pdf','loser.pdf',$4)",[candidate,f.org,f.home,'b'.repeat(64)])
 assert.equal((await f.reserve({file:candidate,actor:f.other})).rows[0].document.id,first.id)
 assert.equal((await f.db.query('select count(*)::int n from documents')).rows[0].n,1)
 assert.equal((await f.db.query('select count(*)::int n from audit_log')).rows[0].n,1)
 assert.equal((await f.db.query('select count(*)::int n from events')).rows[0].n,1)
 for(const sql of ["update documents set title='Changed'","update documents set metadata=metadata-'draft_recipients'","update documents set current_revision=2",'delete from documents'])await assert.rejects(f.db.exec(sql),/immutable|retained/)
})
test('owned publication binds one packet, queues once and rechecks source and permissions on replay',async t=>{
 const f=await setup(t),doc=(await f.reserve()).rows[0].document
 const envelope=(await f.publish(doc.id)).rows[0].envelope
 const requests=(await f.db.query('select * from document_signing_requests order by signer_role')).rows
 assert.equal((await f.publish(doc.id,{actor:f.other})).rows[0].envelope,envelope)
 assert.deepEqual((await f.db.query('select * from document_signing_requests order by signer_role')).rows,requests)
 assert.equal((await f.db.query('select count(*)::int n from outbox')).rows[0].n,2)
 await assert.rejects(f.publish(doc.id,{source:{...f.source,sha256:'b'.repeat(64)}}),/integrity/)
 await f.db.query("update memberships set status='inactive' where user_id=$1",[f.other])
 await assert.rejects(f.publish(doc.id,{actor:f.other}),/organization write permission/)
 assert.deepEqual((await f.db.query('select * from document_signing_requests order by signer_role')).rows,requests)
})
test('changed agreement, buyer details or original builder membership stops recovery without replacing a packet',async t=>{
 const f=await setup(t);const doc=(await f.reserve()).rows[0].document
 await f.db.exec("update contracts set terms='Changed terms'")
 await assert.rejects(f.reserve({probe:true}),/source changed/)
 await f.db.exec("update contracts set terms='Original terms'; update contacts set email='changed@example.test' where full_name='Buyer'")
 await assert.rejects(f.reserve({probe:true}),/signer details changed/)
 await f.db.exec("update contacts set email='buyer@example.test' where full_name='Buyer'")
 await f.db.query("update memberships set status='inactive' where user_id=$1",[f.actor])
 await assert.rejects(f.reserve({actor:f.other,probe:true}),/builder signer/)
 assert.equal((await f.db.query('select id from documents')).rows[0].id,doc.id)
})
test('changed PDF inputs, invalid source and failures in audit cannot create partial packet ownership',async t=>{
 const f=await setup(t)
 await assert.rejects(f.reserve({recipients:f.recipients.map((r,i)=>i===0?{...r,email:'different@example.test'}:r)}),/PDF recipients changed/)
 await f.db.exec("update files set visibility='public'");await assert.rejects(f.reserve(),/private agreement/)
 await f.db.exec("update files set visibility='private'; alter table audit_log add constraint reject_owner_audit check(source<>'agreement_signing_ownership')")
 await assert.rejects(f.reserve(),/reject_owner_audit/)
 for(const table of ['documents','events','audit_log'])assert.equal((await f.db.query(`select count(*)::int n from ${table}`)).rows[0].n,0)
 await f.db.exec('alter table audit_log drop constraint reject_owner_audit');await f.reserve()
})
test('scope, explicit denies, missing assignments, wrong tenants and untrusted roles fail closed',async t=>{
 const f=await setup(t)
 await assert.rejects(f.reserve({org:id(99)}),/not found/)
 for(const scope of ['project_scope','division_scope']){
  await f.db.exec(`update memberships set ${scope}='assigned'`)
  await assert.rejects(f.reserve({probe:true}),/assigned project|division access/)
  await f.db.exec(`update memberships set ${scope}='all'`)
 }
 await f.db.query("insert into membership_permission_overrides select id,'sales.manage','deny' from memberships where user_id=$1",[f.actor])
 await assert.rejects(f.reserve({probe:true}),/organization write permission/)
 await f.db.exec('delete from membership_permission_overrides')
 for(const role of ['anon','authenticated']){await f.db.exec(`set role ${role}`);try{await assert.rejects(f.reserve({probe:true}),/permission denied/)}finally{await f.db.exec('reset role')}}
 assert.equal((await f.db.query('select count(*)::int n from documents')).rows[0].n,0)
})
test('legacy duplicates refuse ownership rollout instead of choosing or deleting a winner',async t=>{
 const f=await setup(t,false)
 await f.db.query("insert into documents(org_id,project_id,title,source_file_id,source_entity_type,source_entity_id,metadata) select $1,$2,'Legacy',$3,'contract',$4,'{\"purchase_agreement\":true}' from generate_series(1,2)",[f.org,f.home,f.file,f.contract])
 await assert.rejects(f.db.exec(ownership),/Reconcile duplicate/);await f.db.exec('rollback')
 assert.equal((await f.db.query('select count(*)::int n from documents')).rows[0].n,2)
})


test('original file evidence is retained and changed storage, checksum or version blocks recovery',async t=>{
 const f=await setup(t),doc=(await f.reserve()).rows[0].document
 assert.equal(doc.metadata.agreement_source_file.sha256,'a'.repeat(64))
 await f.db.exec("update files set storage_path='changed.pdf'")
 await assert.rejects(f.reserve({probe:true}),/file evidence changed/)
 await assert.rejects(f.publish(doc.id),/file evidence changed/)
 await f.db.exec("update files set storage_path='source.pdf',checksum='changed'")
 await assert.rejects(f.reserve({probe:true}),/file evidence changed/)
 await assert.rejects(f.db.exec("update documents set metadata=metadata-'agreement_source_file'"),/immutable/)
 assert.equal((await f.db.query('select count(*)::int n from envelopes')).rows[0].n,0)
})


test('an unknown legacy packet requires reconciliation without being replaced',async t=>{
 const f=await setup(t)
 await f.db.query("insert into documents(org_id,project_id,title,source_file_id,source_entity_type,source_entity_id,metadata) values($1,$2,'Legacy',$3,'contract',$4,'{\"purchase_agreement\":true}')",[f.org,f.home,f.file,f.contract])
 await assert.rejects(f.reserve({probe:true}),/requires reconciliation/)
 assert.equal((await f.db.query('select count(*)::int n from documents')).rows[0].n,1)
 assert.equal((await f.db.query('select count(*)::int n from audit_log')).rows[0].n,0)
})

test('service role can reserve and resume through the gated RPCs',async t=>{
 const f=await setup(t)
 await f.db.exec('set role service_role')
 try {
   const doc=(await f.reserve()).rows[0].document
   const published=(await f.publish(doc.id)).rows[0].envelope
   assert.equal((await f.publish(doc.id)).rows[0].envelope,published)
 } finally { await f.db.exec('reset role') }
})


test('invalid signer email fails before ownership can freeze an unusable packet',async t=>{
 const f=await setup(t)
 await f.db.exec("update contacts set email='invalid' where full_name='Buyer'")
 await assert.rejects(f.reserve({probe:true}),/Valid agreement signer emails/)
 await assert.rejects(f.reserve(),/Valid agreement signer emails/)
 assert.equal((await f.db.query('select count(*)::int n from documents')).rows[0].n,0)
})


test('partial sale ownership or configuration drift cannot reserve or publish a signing packet',async t=>{
 const f=await setup(t),doc=(await f.reserve()).rows[0].document
 await f.db.exec("update lot_reservations set contract_id=null")
 await assert.rejects(f.reserve({probe:true}),/reservation ownership/)
 await assert.rejects(f.publish(doc.id),/reservation ownership/)
 await f.db.query("update lot_reservations set contract_id=$1",[f.contract])
 await f.db.exec("update lots set swing='right'")
 await assert.rejects(f.publish(doc.id),/home configuration/)
 assert.equal((await f.db.query('select count(*)::int n from outbox')).rows[0].n,0)
})


test('generic signing send cannot bypass owned agreement parent publication checks',async t=>{
 const f=await setup(t),doc=(await f.reserve()).rows[0].document
 await assert.rejects(f.db.query('select send_esign_document($1,$2,$3,$4,$5,$6,$7,$8,null)',[f.org,doc.id,f.actor,JSON.stringify(f.source),JSON.stringify(f.recipients),'{}','Home agreement','Review']),/Use purchase agreement signing recovery/)
 assert.equal((await f.db.query('select count(*)::int n from outbox')).rows[0].n,0)
 await f.publish(doc.id)
 // The publication marker is transaction-local; another request cannot inherit it.
 await assert.rejects(f.db.query('select send_esign_document($1,$2,$3,$4,$5,$6,$7,$8,null)',[f.org,doc.id,f.actor,JSON.stringify(f.source),JSON.stringify(f.recipients),'{}','Home agreement','Review']),/Use purchase agreement signing recovery/)
})


test('a closed lot cannot publish a draft agreement even if its old configuration still matches',async t=>{
 const f=await setup(t),doc=(await f.reserve()).rows[0].document
 await f.db.exec("update lots set status='closed'")
 await assert.rejects(f.publish(doc.id),/home configuration/)
 assert.equal((await f.db.query('select count(*)::int n from outbox')).rows[0].n,0)
})

test('ownership uses authoritative lot elevation columns with non-null configuration',async t=>{
 const f=await setup(t),elevation=id(40),changed=id(41)
 await f.db.query('insert into house_plan_elevations values($1),($2)',[elevation,changed])
 await f.db.query('update lots set house_plan_elevation_id=$1',[elevation])
 const expected=structuredClone(f.expected);expected.snapshot.purchase_agreement.configuration.elevation_id=elevation
 await f.db.query('update contracts set snapshot=$1',[JSON.stringify(expected.snapshot)])
 const doc=(await f.reserve({expected})).rows[0].document
 assert.equal(doc.metadata.agreement_signing_input.snapshot.purchase_agreement.configuration.elevation_id,elevation)
 await f.db.query('update lots set house_plan_elevation_id=$1',[changed])
 await assert.rejects(f.publish(doc.id),/configuration needs reconciliation/)
 assert.equal((await f.db.query('select count(*)::int n from envelopes')).rows[0].n,0)
})

test('application source comparison agrees with the actual SQL source projection and ordered JSON arrays',async t=>{
 require('../scripts/register-ts-node-test')
 const {agreementSigningInput,agreementSigningSourceMatches}=require('../lib/sales/agreement-signing-source')
 const f=await setup(t)
 await f.db.exec(`update contracts set snapshot=jsonb_set(snapshot,'{purchase_agreement,configuration,option_items}','[{"optionId":"first"},{"optionId":"second"}]')`)
 // PostgREST sends JSON dates; PGlite's raw date driver otherwise returns Date objects.
 const contract=(await f.db.query('select row_to_json(c) contract from contracts c')).rows[0].contract
 const source=(await f.db.query('select purchase_agreement_signing_input(c) source from contracts c')).rows[0].source
 assert.deepEqual(agreementSigningInput(contract),source)
 assert.equal(agreementSigningSourceMatches(Object.fromEntries(Object.entries(source).reverse()),contract),true)
 for(const [key,value] of Object.entries(source)){
  const altered={...source,[key]:value===null?'changed':null}
  assert.equal(agreementSigningSourceMatches(altered,contract),false,`Source field ${key} must match`)
 }
 const reordered=structuredClone(source);reordered.snapshot.purchase_agreement.configuration.option_items.reverse()
 assert.equal(agreementSigningSourceMatches(reordered,contract),false,'SQL JSONB arrays retain order')
 for(const bad of [undefined,null,{},[],{...source,extra:'unknown'},{...source,total_cents:NaN}])assert.equal(agreementSigningSourceMatches(bad,contract),false)
})
