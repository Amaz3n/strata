const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { PGlite } = require(process.env.ARC_TEST_PGLITE_MODULE || '@electric-sql/pglite')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`

test('atomic replacement preserves old evidence, expiry, authentication and idempotency', async t => {
  const db=new PGlite(); t.after(()=>db.close())
  for(const path of ['tests/fixtures/esign-schema.sql','supabase/migrations/20261003004822_esign_durable_execution_and_evidence.sql','supabase/migrations/20261003013101_esign_atomic_resend.sql']) await db.exec(fs.readFileSync(path,'utf8'))
  const org=id(1),doc=id(2),file=id(3),actor=id(4),field=id(5)
  const source={file_id:file,sha256:'a'.repeat(64),storage_path:'frozen/source.pdf',size_bytes:20}
  await db.query('insert into public.orgs(id) values($1)',[org])
  await db.query("insert into public.documents(id,org_id,title,source_file_id) values($1,$2,'Agreement',$3)",[doc,org,file])
  await db.query("insert into public.document_fields(id,org_id,document_id,page_index,field_type,signer_role,x,y,w,h) values($1,$2,$3,0,'signature','owner',.1,.1,.3,.1)",[field,org,doc])
  const recipients=[{type:'external_email',role:'signer',signer_role:'owner',email:'owner@example.test',name:'Owner',sequence:1,access_code_hash:'fixture-access-hash'}]
  const old=(await db.query('select public.send_esign_document($1,$2,$3,$4,$5,$6,$7,$8,$9) id',[org,doc,actor,JSON.stringify(source),JSON.stringify(recipients),'{}','Please sign','Review scope',new Date(Date.now()+86400000).toISOString()])).rows[0].id
  await db.query("update public.envelopes set status='expired',sent_at=now()-interval '16 days',expires_at=now()-interval '2 days' where id=$1",[old])
  const resend=()=>db.query('select public.resend_esign_envelope($1,$2,$3,null) id',[org,old,actor])
  const request=(await db.query('select * from public.document_signing_requests where envelope_id=$1',[old])).rows[0]
  // Simulate an existing accepted signature; replacement must not touch it.
  await db.query("insert into public.document_signatures(org_id,document_id,signing_request_id,revision,consent_text,values) values($1,$2,$3,1,'Accepted',$4)",[org,doc,request.id,JSON.stringify({[field]:'accepted signature'})])
  await t.test('a downstream queue failure rolls back cancellation and cloned records',async()=>{
    await db.exec("create function public.reject_replacement_job() returns trigger language plpgsql as $$begin raise exception 'injected enqueue failure';end$$;create trigger reject_replacement before insert on public.outbox for each row execute function public.reject_replacement_job()")
    await assert.rejects(resend(),/injected enqueue failure/)
    assert.equal((await db.query('select status from public.envelopes where id=$1',[old])).rows[0].status,'expired')
    assert.equal(Number((await db.query('select count(*) n from public.documents')).rows[0].n),1)
    await db.exec('drop trigger reject_replacement on public.outbox;drop function public.reject_replacement_job()')
  })
  let replacement
  await t.test('replacement uses a distinct document and keeps old source, fields, signatures and authentication',async()=>{
    replacement=(await resend()).rows[0].id
    const envelope=(await db.query('select * from public.envelopes where id=$1',[replacement])).rows[0]
    assert.notEqual(envelope.document_id,doc)
    assert.equal(envelope.subject,'Please sign')
    assert.ok(new Date(envelope.expires_at)>new Date(Date.now()+13*86400000))
    const cloned=(await db.query('select * from public.documents where id=$1',[envelope.document_id])).rows[0]
    assert.deepEqual(cloned.metadata.esign_source,source)
    assert.equal((await db.query('select values from public.document_signatures where document_id=$1',[doc])).rows.length,1)
    assert.equal((await db.query('select id from public.document_fields where document_id=$1',[doc])).rows[0].id,field)
    const newRequest=(await db.query('select * from public.document_signing_requests where envelope_id=$1',[replacement])).rows[0]
    assert.equal(newRequest.access_code_hash,'fixture-access-hash')
    assert.notEqual(newRequest.token_hash,request.token_hash)
    assert.equal((await db.query('select status from public.envelopes where id=$1',[old])).rows[0].status,'voided')
    assert.notEqual((await db.query('select id from public.document_fields where document_id=$1',[envelope.document_id])).rows[0].id,field)
    assert.equal((await resend()).rows[0].id,replacement)
    assert.equal(Number((await db.query('select count(*) n from public.documents')).rows[0].n),2)
  })
  await t.test('the RPC is unavailable to browser roles and cross-tenant callers',async()=>{
    for(const role of ['anon','authenticated']) {
      await db.exec(`set role ${role}`)
      try{await assert.rejects(resend(),/permission denied/)}finally{await db.exec('reset role')}
    }
    await assert.rejects(db.query('select public.resend_esign_envelope($1,$2,$3,null)',[id(99),old,actor]),/Envelope not found/)
  })
  await t.test('a draft without evidence requires a frozen candidate and checks its file identity',async()=>{
    const draftDoc=id(20),draftEnvelope=id(21)
    await db.query("insert into public.documents(id,org_id,title,source_file_id) values($1,$2,'Draft agreement',$3)",[draftDoc,org,file])
    await db.query('insert into public.envelopes(id,org_id,document_id) values($1,$2,$3)',[draftEnvelope,org,draftDoc])
    await db.query("insert into public.document_fields(org_id,document_id,page_index,field_type,signer_role,x,y,w,h) values($1,$2,0,'signature','owner',.1,.1,.3,.1)",[org,draftDoc])
    await db.query("insert into public.envelope_recipients(org_id,envelope_id,email,name,signer_role) values($1,$2,'draft@example.test','Draft signer','owner')",[org,draftEnvelope])
    await assert.rejects(db.query('select public.resend_esign_envelope($1,$2,$3,null)',[org,draftEnvelope,actor]),/frozen signing source/)
    await assert.rejects(db.query('select public.resend_esign_envelope($1,$2,$3,$4)',[org,draftEnvelope,actor,JSON.stringify({...source,file_id:id(99)})]),/frozen signing source/)
    const sent=(await db.query('select public.resend_esign_envelope($1,$2,$3,$4) id',[org,draftEnvelope,actor,JSON.stringify(source)])).rows[0].id
    assert.equal((await db.query('select status from public.envelopes where id=$1',[sent])).rows[0].status,'sent')
  })
  await t.test('executed envelopes cannot be replaced',async()=>{
    await db.query("update public.envelopes set status='executed' where id=$1",[replacement])
    await assert.rejects(db.query('select public.resend_esign_envelope($1,$2,$3,null)',[org,replacement,actor]),/Executed envelopes/)
  })
})
