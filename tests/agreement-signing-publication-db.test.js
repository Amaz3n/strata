const assert = require('node:assert/strict')
const fs = require('node:fs')
const test = require('node:test')
const { PGlite } = require('@electric-sql/pglite')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`

async function setup(t) {
  const db = new PGlite(); t.after(() => db.close())
  for (const path of ['tests/fixtures/esign-schema.sql','supabase/migrations/20261003004822_esign_durable_execution_and_evidence.sql','supabase/migrations/20261003231638_esign_send_recipient_binding.sql']) await db.exec(fs.readFileSync(path,'utf8'))
  const org=id(1), doc=id(2), actor=id(3), buyer=id(4), co=id(5), file=id(6)
  await db.query('insert into orgs values($1)',[org])
  await db.query('insert into contacts values($1,$3),($2,$3)',[buyer,co,org])
  await db.query("insert into memberships(org_id,user_id,status) values($1,$2,'active')",[org,actor])
  await db.query("insert into documents(id,org_id,title,source_file_id,source_entity_type,source_entity_id) values($1,$2,'Home agreement',$3,'contract',$4)",[doc,org,file,id(7)])
  const source={file_id:file,sha256:'a'.repeat(64),storage_path:'frozen/packet.pdf',size_bytes:1234}
  const recipients=[
    {type:'contact',contact_id:buyer,name:'Buyer',email:'buyer@example.test',role:'signer',signer_role:'buyer',sequence:1,required:true},
    {type:'contact',contact_id:co,name:'Co-buyer',email:'co@example.test',role:'signer',signer_role:'co_buyer',sequence:1,required:true},
    {type:'internal_user',user_id:actor,name:'Builder',email:'builder@example.test',role:'signer',signer_role:'builder',sequence:2,required:true},
  ]
  const send = (patch={}) => db.query('select public.send_esign_document($1,$2,$3,$4,$5,$6,$7,$8,$9) id',[
    patch.org??org,doc,actor,JSON.stringify(patch.source??source),JSON.stringify(patch.recipients??recipients),JSON.stringify(patch.metadata??{contract_id:id(7),purchase_agreement:true}),patch.subject??'Home agreement',patch.message??'Review the agreement',patch.expiry??null,
  ])
  const requests = async () => (await db.query('select * from document_signing_requests order by signer_role')).rows
  return {db,org,doc,actor,buyer,co,source,recipients,send,requests}
}

test('atomic agreement publication binds contacts, freezes source and queues only the buyer stage',async t => {
  const f=await setup(t), envelope=(await f.send()).rows[0].id
  const requests=await f.requests()
  assert.equal(requests.length,3)
  for (const [role,contact] of [['buyer',f.buyer],['co_buyer',f.co],['builder',null]]) {
    const request=requests.find(r=>r.signer_role===role)
    assert.equal(request.recipient_contact_id,contact)
    assert.equal(request.envelope_id,envelope)
    assert.equal(request.status,role==='builder'?'draft':'sent')
    assert.equal(request.revision,1)
  }
  assert.equal((await f.db.query('select count(*)::int n from outbox')).rows[0].n,2)
  const doc=(await f.db.query('select * from documents')).rows[0]
  assert.equal(doc.status,'sent')
  assert.deepEqual(doc.metadata.esign_source,f.source)
  assert.equal((await f.db.query('select status from envelopes')).rows[0].status,'sent')
  assert.equal((await f.db.query('select count(*)::int n from events')).rows[0].n,1)
})

test('lost-reply replay preserves invitation identities, credentials, source and queued deliveries',async t => {
  const f=await setup(t), envelope=(await f.send()).rows[0].id, before=await f.requests()
  const retry=(await f.send({recipients:[...f.recipients].reverse(),source:{...f.source,storage_path:'unused/retry-copy.pdf'}})).rows[0].id
  assert.equal(retry,envelope)
  assert.deepEqual(await f.requests(),before)
  assert.equal((await f.db.query('select count(*)::int n from envelopes')).rows[0].n,1)
  assert.equal((await f.db.query('select count(*)::int n from outbox')).rows[0].n,2)
  assert.equal((await f.db.query('select count(*)::int n from events')).rows[0].n,1)
  assert.deepEqual((await f.db.query('select metadata from documents')).rows[0].metadata.esign_source,f.source)
  await f.db.exec('set role service_role')
  try { assert.equal((await f.send()).rows[0].id,envelope) } finally { await f.db.exec('reset role') }
})

test('changed signing replay fails without mutating the published packet',async t => {
  const f=await setup(t); await f.send(); const before=await f.requests()
  const changes=[{email:'other@example.test'},{contact_id:f.co},{name:'Other buyer'},{sequence:2},{required:false},{signer_role:'other'},{access_code_hash:'changed'}]
  for (const change of changes) await assert.rejects(f.send({recipients:f.recipients.map((r,i)=>i===0?{...r,...change}:r)}),/retry differs/)
  for (const patch of [{source:{...f.source,sha256:'b'.repeat(64)}},{source:{...f.source,size_bytes:999}},{subject:'Changed title'},{message:'Changed terms'},{metadata:{purchase_agreement:false}},{expiry:new Date(Date.now()+86400000).toISOString()}]) await assert.rejects(f.send(patch),/retry differs/)
  assert.deepEqual(await f.requests(),before)
  await f.db.query('update document_signing_requests set recipient_contact_id=null where signer_role=$1',['buyer'])
  await assert.rejects(f.send(),/retry differs/)
})

test('queue failure rolls back the whole packet publication and allows clean retry',async t => {
  const f=await setup(t)
  await f.db.exec("create function reject_agreement_job() returns trigger language plpgsql as $$begin raise exception 'injected queue failure';end$$; create trigger reject_agreement before insert on outbox for each row execute function reject_agreement_job()")
  await assert.rejects(f.send(),/injected queue failure/)
  for (const table of ['envelopes','envelope_recipients','document_signing_requests','outbox','events']) assert.equal((await f.db.query(`select count(*)::int n from ${table}`)).rows[0].n,0)
  assert.equal((await f.db.query('select status from documents')).rows[0].status,'draft')
  await f.db.exec('drop trigger reject_agreement on outbox; drop function reject_agreement_job()')
  await f.send(); assert.equal((await f.requests()).length,3)
})

test('invalid source, tenant, identity and untrusted role fail before publication',async t => {
  const f=await setup(t)
  for (const patch of [{source:{...f.source,sha256:'invalid'}},{source:{...f.source,file_id:id(99)}},{source:{...f.source,size_bytes:0}},{source:{...f.source,size_bytes:1.1}},{source:{...f.source,storage_path:''}},{org:id(99)},...[
    {type:'contact',contact_id:null},{type:'internal_user',contact_id:null,user_id:null},{type:'external_email'},{contact_id:id(99)},{role:'invalid'},{sequence:0},{signer_role:''},
  ].map(change=>({recipients:f.recipients.map((r,i)=>i===0?{...r,...change}:r)}))]) await assert.rejects(f.send(patch))
  for (const role of ['anon','authenticated']) {
    await f.db.exec(`set role ${role}`)
    try { await assert.rejects(f.send(),/permission denied/) } finally { await f.db.exec('reset role') }
  }
  assert.equal((await f.requests()).length,0)
})


test('missing request ownership cannot be treated as a successful replay',async t => {
  const f=await setup(t); await f.send()
  const buyer=(await f.requests()).find(r=>r.signer_role==='buyer')
  await f.db.query('delete from document_signing_requests where id=$1',[buyer.id])
  await assert.rejects(f.send(),/retry differs/)
})


test('duplicate recipient requests cannot be treated as a successful replay',async t => {
  const f=await setup(t); await f.send()
  await f.db.exec(`insert into document_signing_requests(org_id,document_id,revision,token_hash,status,recipient_contact_id,sent_to_email,group_id,envelope_id,envelope_recipient_id,signer_role,sequence,required)
    select org_id,document_id,revision,token_hash,status,recipient_contact_id,sent_to_email,group_id,envelope_id,envelope_recipient_id,signer_role,sequence,required from document_signing_requests where signer_role='buyer'`)
  await assert.rejects(f.send(),/retry differs/)
})

test('contact signers with access codes and CC recipients preserve generic send compatibility',async t => {
  const f=await setup(t)
  const recipients=[{...f.recipients[0],access_code_hash:'frozen-access-hash'},{type:'external_email',name:'Office',email:'office@example.test',role:'cc'}]
  const first=(await f.send({recipients})).rows[0].id
  const requests=await f.requests()
  assert.equal(requests.length,1)
  assert.equal(requests[0].access_code_hash,'frozen-access-hash')
  assert.equal(requests[0].recipient_contact_id,f.buyer)
  assert.equal((await f.send({recipients})).rows[0].id,first)
  assert.deepEqual(await f.requests(),requests)
})
