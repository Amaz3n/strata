const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { PGlite } = require(process.env.ARC_TEST_PGLITE_MODULE || '@electric-sql/pglite')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const org = id(1), doc = id(2), envelope = id(3), owner = id(4), builder = id(5), ownerField = id(6), builderField = id(7)
const lease = id(8), otherLease = id(9)
const migration = 'supabase/migrations/20261003004822_esign_durable_execution_and_evidence.sql'

test('actual signing migration preserves ownership, evidence and durable lifecycle invariants', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(fs.readFileSync('tests/fixtures/esign-schema.sql', 'utf8'))
  await db.exec(fs.readFileSync(migration, 'utf8'))
  const row = async (sql, args = []) => (await db.query(sql, args)).rows[0]
  const count = async table => Number((await row(`select count(*) as n from public.${table}`)).n)
  const start = () => db.query('select public.start_esign_envelope($1,$2,$3,$4)', [org, envelope, JSON.stringify({ sha256: 'a'.repeat(64), storage_path: 'org/frozen.pdf' }), '{}'])
  const accept = (request = owner, values = { [ownerField]: 'Owner' }, revision = 1) => db.query(
    'select public.record_document_signature_atomic($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) as signature_id',
    [org, request, doc, revision, request === owner ? 'Owner' : 'Builder', 'signer@example.test', '192.0.2.1', 'Fixture browser', 'Agreed electronic signature consent', JSON.stringify(values), '{}', new Date().toISOString()],
  )
  const claim = (token = lease) => row('select public.claim_esign_execution($1,$2,$3) as execution', [org, envelope, token])
  const artifact = { file_name: 'executed.pdf', storage_path: 'org/executed.pdf', size_bytes: 100, metadata: { source_sha256: 'a'.repeat(64), executed_sha256: 'b'.repeat(64) } }
  const complete = (token = lease) => row('select public.complete_esign_execution($1,$2,$3,$4) as file_id', [org, envelope, token, JSON.stringify(artifact)])
  const cancel = (requestId = null) => db.query('select public.cancel_esign_envelope($1,$2,$3,$4,$5)', [org, envelope, 'Fixture cancellation', requestId, null])
  const reset = async (send = true, parallel = false) => {
    await db.exec('truncate public.orgs,public.documents,public.envelopes,public.document_fields,public.document_signing_requests,public.document_signatures,public.events,public.outbox,public.files,public.doc_versions,public.envelope_recipients,public.esign_executions cascade')
    await db.query('insert into public.orgs(id) values($1)', [org])
    await db.query("insert into public.documents(id,org_id,title,source_file_id) values($1,$2,'Agreement',$3)", [doc, org, id(10)])
    await db.query('insert into public.envelopes(id,org_id,document_id) values($1,$2,$3)', [envelope, org, doc])
    for (const [fieldId, role] of [[ownerField, 'owner'], [builderField, 'builder']]) {
      await db.query("insert into public.document_fields(id,org_id,document_id,page_index,field_type,signer_role,x,y,w,h) values($1,$2,$3,0,'name',$4,.1,.1,.3,.1)", [fieldId, org, doc, role])
    }
    for (const [requestId, role, sequence] of [[owner, 'owner', 1], [builder, 'builder', parallel ? 1 : 2]]) {
      await db.query('insert into public.document_signing_requests(id,org_id,document_id,revision,token_hash,group_id,envelope_id,signer_role,sequence,sent_to_email) values($1,$2,$3,1,$4,$5,$5,$6,$7,$8)', [requestId, org, doc, `fixture-${role}`, envelope, role, sequence, `${role}@example.test`])
      await db.query('insert into public.envelope_recipients(org_id,envelope_id,email,name,signer_role,sequence) values($1,$2,$3,$4,$5,$6)', [org, envelope, `${role}@example.test`, role, role, sequence])
    }
    if (send) await start()
  }
  const asRole = async (role, fn) => {
    await db.exec(`set role ${role}`)
    try { return await fn() } finally { await db.exec('reset role') }
  }

  await t.test('unassigned values, missing required values, wrong revision and out-of-order signers are rejected without consuming links', async () => {
    await reset()
    await assert.rejects(accept(owner, { [ownerField]: 'Owner', [builderField]: 'Changed' }), /unassigned/)
    await assert.rejects(accept(owner, {}), /required fields/)
    await assert.rejects(accept(owner, { [ownerField]: 'Owner' }, 2), /document mismatch/)
    await assert.rejects(accept(builder, { [builderField]: 'Builder' }), /not yet authorized/)
    assert.equal(await count('document_signatures'), 0)
    assert.equal((await row('select used_count from public.document_signing_requests where id=$1', [owner])).used_count, 0)
  })

  await t.test('acceptance, evidence, execution record and outbox work roll back together on enqueue failure', async () => {
    await reset()
    await db.exec(`create function public.test_reject_esign_outbox() returns trigger language plpgsql as $$begin if new.job_type='finalize_document_signing' then raise exception 'injected outbox failure';end if;return new;end$$;create trigger test_outbox_failure before insert on public.outbox for each row execute function public.test_reject_esign_outbox();`)
    try {
      await assert.rejects(accept(), /injected outbox failure/)
      assert.equal(await count('document_signatures'), 0)
      assert.equal(await count('events'), 0)
      assert.equal(await count('esign_executions'), 0)
      assert.equal(await count('outbox'), 1)
      assert.equal((await row('select status from public.document_signing_requests where id=$1', [owner])).status, 'sent')
    } finally { await db.exec('drop trigger test_outbox_failure on public.outbox;drop function public.test_reject_esign_outbox()') }
  })

  await t.test('retrying an accepted signature returns its original identity without double use, evidence or jobs', async () => {
    await reset()
    const first = (await accept()).rows[0].signature_id
    const second = (await accept()).rows[0].signature_id
    assert.equal(first, second)
    assert.equal(await count('document_signatures'), 1)
    assert.equal(await count('events'), 1)
    assert.equal(await count('esign_executions'), 1)
    assert.equal((await row('select used_count from public.document_signing_requests where id=$1', [owner])).used_count, 1)
    assert.equal(Number((await row("select count(*) n from public.outbox where job_type='finalize_document_signing'")).n), 1)
    assert.equal((await row('select status from public.document_signing_requests where id=$1', [builder])).status, 'sent')
    assert.equal((await row('select audit_data from public.document_signatures')).audit_data.source_sha256, 'a'.repeat(64))
  })

  await t.test('authenticated members retain evidence reads but cannot fabricate, alter or delete it', async () => {
    await reset(); await accept()
    await asRole('authenticated', async () => {
      assert.equal(await count('document_signatures'), 1)
      await assert.rejects(db.query("update public.document_signatures set signer_name='Changed'"), /permission denied/)
      await assert.rejects(db.query('delete from public.document_signatures'), /permission denied/)
      await assert.rejects(db.query("insert into public.document_signatures(org_id,signing_request_id,document_id,revision,consent_text) values($1,$2,$3,1,'Fabricated')", [org, owner, doc]), /permission denied/)
      await assert.rejects(db.query("insert into public.events(org_id,event_type,entity_type) values($1,'recipient_signed','envelope')", [org]), /row-level security/)
      await db.query("update public.events set payload='{}' where entity_type='envelope'")
      await db.query("delete from public.events where entity_type='envelope'")
      assert.equal(await count('events'), 1)
      await assert.rejects(accept(), /permission denied/)
    })
    await asRole('service_role', async () => {
      await assert.rejects(db.query("update public.document_signatures set signer_name='Changed'"), /append-only/)
      await assert.rejects(db.query('delete from public.document_signatures'), /append-only/)
      await assert.rejects(db.query("update public.events set payload='{}' where entity_type='envelope'"), /append-only/)
      await assert.rejects(db.query("delete from public.events where entity_type='envelope'"), /append-only/)
    })
  })

  await t.test('failed draft replacement is transactional and sent fields/source are immutable', async () => {
    await reset(false)
    const replacement = [{ page_index: 0, field_type: 'name', signer_role: 'owner', x: .9, y: .1, w: .2, h: .1 }]
    await assert.rejects(db.query('select public.replace_draft_signing_fields($1,$2,1,$3)', [org, doc, JSON.stringify(replacement)]), /Invalid document field/)
    assert.equal(await count('document_fields'), 2)
    assert.equal((await row('select id from public.document_fields where id=$1', [ownerField])).id, ownerField)
    await start()
    await assert.rejects(db.query('select public.replace_draft_signing_fields($1,$2,1,$3)', [org, doc, '[]']), /Only draft/)
    await assert.rejects(db.query('delete from public.document_fields where id=$1', [ownerField]), /immutable/)
    await assert.rejects(db.query('update public.document_fields set x=.2 where id=$1', [ownerField]), /immutable/)
    await assert.rejects(db.query('update public.documents set source_file_id=$1 where id=$2', [id(99), doc]), /immutable/)
    await assert.rejects(db.query("update public.documents set metadata='{}' where id=$1", [doc]), /immutable/)
    assert.equal(await count('document_fields'), 2)
  })

  await t.test('only all-signed envelopes can be claimed; leases fence retries and completion is idempotent', async () => {
    await reset()
    await accept()
    assert.equal((await claim()).execution, null)
    await accept(builder, { [builderField]: 'Builder' })
    const execution = (await claim()).execution
    assert.equal(execution.status, 'processing')
    await assert.rejects(claim(otherLease), /already in progress/)
    await assert.rejects(complete(otherLease), /claim no longer valid/)
    await db.query("update public.esign_executions set lease_until=now()-interval '1 second'")
    await assert.rejects(complete(), /claim no longer valid/)
    const recovered = (await claim(otherLease)).execution
    assert.equal(recovered.file_id, execution.file_id)
    const done = await complete(otherLease)
    assert.equal(done.file_id, execution.file_id)
    assert.equal((await complete(otherLease)).file_id, done.file_id)
    assert.equal(await count('files'), 1)
    assert.equal(await count('doc_versions'), 1)
    assert.equal((await row('select status from public.envelopes')).status, 'executed')
    assert.equal((await row('select status from public.documents')).status, 'signed')
    assert.equal(Number((await row("select count(*) n from public.outbox where job_type='send_esign_executed_email'")).n), 2)
    assert.equal(Number((await row("select count(*) n from public.outbox where job_type='process_esign_execution_side_effects'")).n), 1)
    assert.equal((await claim()).execution, null)
  })

  await t.test('voided or expired lifecycle state prevents acceptance and rejects in-flight execution', async () => {
    for (const status of ['voided', 'expired']) {
      await reset()
      await db.query('update public.envelopes set status=$1', [status])
      await assert.rejects(accept(), /no longer active/)
      assert.equal(await count('document_signatures'), 0)
      await reset()
      await accept(); await accept(builder, { [builderField]: 'Builder' }); await claim()
      await db.query('update public.envelopes set status=$1', [status])
      assert.equal((await claim(otherLease)).execution, null)
      await assert.rejects(complete(), /claim no longer valid/)
      assert.equal(await count('files'), 0)
    }
  })

  await t.test('parallel routing queues each recipient once and shares one execution identity', async () => {
    await reset(true, true)
    assert.equal(Number((await row("select count(*) n from public.outbox where job_type='send_esign_invitation'")).n), 2)
    await db.query('select public.queue_esign_recipients($1,$2)', [org, envelope])
    assert.equal(Number((await row("select count(*) n from public.outbox where job_type='send_esign_invitation'")).n), 2)
    await Promise.all([accept(), accept(builder, { [builderField]: 'Builder' })])
    assert.equal(await count('document_signatures'), 2)
    assert.equal(await count('esign_executions'), 1)
    assert.equal((await claim()).execution.status, 'processing')
  })

  await t.test('cancellation is atomic, idempotent, validates recipient identity and fences publication', async () => {
    await reset()
    await assert.rejects(cancel(id(999)), /cannot decline/)
    assert.equal((await row('select status from public.envelopes')).status, 'sent')
    await db.exec(`create function public.test_cancel_event_failure() returns trigger language plpgsql as $$begin if new.event_type='recipient_declined' then raise exception 'injected cancellation failure';end if;return new;end$$;create trigger test_cancel_failure before insert on public.events for each row execute function public.test_cancel_event_failure();`)
    try {
      await assert.rejects(cancel(owner), /injected cancellation failure/)
      assert.equal((await row('select status from public.envelopes')).status, 'sent')
      assert.equal((await row('select status from public.documents')).status, 'sent')
      assert.equal((await row('select status from public.document_signing_requests where id=$1', [owner])).status, 'sent')
    } finally { await db.exec('drop trigger test_cancel_failure on public.events;drop function public.test_cancel_event_failure()') }
    await cancel(owner)
    await cancel(owner)
    assert.equal((await row('select status from public.envelopes')).status, 'voided')
    assert.equal((await row('select status from public.documents')).status, 'voided')
    assert.equal(Number((await row("select count(*) n from public.document_signing_requests where status='voided'")).n), 2)
    assert.equal(await count('events'), 1)
    await assert.rejects(accept(), /no longer active/)
    await reset(); await accept(); await accept(builder, { [builderField]: 'Builder' }); await claim()
    await cancel()
    await assert.rejects(complete(), /claim no longer valid/)
    assert.equal(await count('files'), 0)
    await reset(); await accept(); await accept(builder, { [builderField]: 'Builder' }); await claim(); await complete()
    await assert.rejects(cancel(), /cannot be voided/)
    assert.equal((await row('select status from public.envelopes')).status, 'executed')
  })

  await t.test('offline completion publishes transactionally, records its provenance and cannot replace electronic publication', async () => {
    const offline = () => row('select public.complete_esign_offline($1,$2,$3,$4) file_id', [org, envelope, id(99), JSON.stringify({ ...artifact, metadata: { ...artifact.metadata, note: 'Received original signed copy', execution_method: 'offline' } })])
    await reset()
    await db.exec(`create function public.test_offline_event_failure() returns trigger language plpgsql as $$begin if new.event_type='offline_executed' then raise exception 'injected offline failure';end if;return new;end$$;create trigger test_offline_failure before insert on public.events for each row execute function public.test_offline_event_failure();`)
    try {
      await assert.rejects(offline(), /injected offline failure/)
      assert.equal(await count('files'), 0)
      assert.equal((await row('select status from public.envelopes')).status, 'sent')
      assert.equal((await row('select status from public.document_signing_requests where id=$1', [owner])).status, 'sent')
    } finally { await db.exec('drop trigger test_offline_failure on public.events;drop function public.test_offline_event_failure()') }
    const result = await offline()
    assert.equal((await offline()).file_id, result.file_id)
    assert.equal(await count('files'), 1)
    assert.equal(await count('document_signatures'), 0)
    assert.equal(Number((await row("select count(*) n from public.events where event_type='offline_executed'")).n), 1)
    assert.equal((await row('select metadata from public.files')).metadata.execution_method, 'offline')
    await reset(); await accept(); await accept(builder, { [builderField]: 'Builder' }); await claim()
    await assert.rejects(offline(), /already in progress/)
  })

  await t.test('send atomically prepares recipients and requests, validates assignments and is retry-idempotent', async () => {
    const recipients = [
      { type: 'external_email', role: 'signer', signer_role: 'owner', name: 'Owner', email: 'owner@example.test', sequence: 1, required: true, access_code_hash: 'fixture-code-hash' },
      { type: 'external_email', role: 'signer', signer_role: 'builder', name: 'Builder', email: 'builder@example.test', sequence: 2, required: true },
    ]
    const send = (people = recipients) => row('select public.send_esign_document($1,$2,$3,$4,$5,$6,$7,$8,$9) envelope_id', [org, doc, id(99), JSON.stringify({ file_id: id(10), sha256: 'a'.repeat(64), storage_path: 'org/frozen.pdf', size_bytes: 10 }), JSON.stringify(people), '{}', 'Agreement', 'Please review', null])
    await reset(false)
    await assert.rejects(send([...recipients, { ...recipients[0], signer_role: "optional", required: false, sequence: 99 }]), /Optional signers must share/)
    await assert.rejects(send(recipients.slice(0, 1)), /required field/)
    assert.equal((await row('select status from public.documents')).status, 'draft')
    assert.equal(await count('document_signing_requests'), 2)
    await assert.rejects(send([{ ...recipients[0], contact_id: id(999) }, recipients[1]]), /does not belong/)
    assert.equal((await row('select id from public.document_signing_requests where id=$1', [owner])).id, owner)
    const first = await send(), second = await send()
    assert.equal(first.envelope_id, second.envelope_id)
    assert.equal(await count('envelopes'), 1)
    assert.equal(await count('document_signing_requests'), 2)
    assert.equal(await count('envelope_recipients'), 2)
    assert.equal(Number((await row("select count(*) n from public.outbox where job_type='send_esign_invitation'")).n), 1)
    assert.equal((await row('select status from public.documents')).status, 'sent')
    const metadata = (await row('select metadata from public.documents')).metadata
    assert.equal(metadata.envelope_recipients[0].access_code_hash, undefined)
    assert.equal(metadata.esign_source.sha256, 'a'.repeat(64))
  })

  await t.test('real client role can author drafts but cannot forge lifecycle state or bypass issued locks with JWT claims', async () => {
    await reset(false)
    await asRole('authenticated', async () => {
      await db.query("update public.documents set title='Edited draft' where id=$1", [doc])
      await db.query("update public.envelopes set subject='Edited draft' where id=$1", [envelope])
      await db.query("update public.document_signing_requests set sent_to_email='draft@example.test' where id=$1", [owner])
      await db.query("update public.envelope_recipients set name='Draft name' where envelope_id=$1", [envelope])
      await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ role: 'service_role' })])
      await assert.rejects(db.query("update public.documents set status='signed',executed_file_id=$1 where id=$2", [id(900), doc]), /trusted writer/)
      await assert.rejects(db.query("update public.document_signing_requests set status='signed',signed_at=now() where id=$1", [owner]), /trusted writer/)
      await assert.rejects(db.query("update public.envelopes set status='executed' where id=$1", [envelope]), /trusted writer/)
      await assert.rejects(db.query("insert into public.documents(org_id,title,source_file_id,status) values($1,'Fabricated',$2,'signed')", [org,id(10)]), /trusted writer/)
    })
    await start()
    await db.query("insert into public.documents(id,org_id,title,source_file_id) values($1,$2,'Other draft',$3)", [id(901),org,id(10)])
    await db.query("insert into public.envelopes(id,org_id,document_id) values($1,$2,$3)", [id(902),org,id(901)])
    await asRole('authenticated', async () => {
      await assert.rejects(db.query("update public.document_signing_requests set token_hash='changed' where id=$1", [owner]), /trusted lifecycle writer/)
      await assert.rejects(db.query("delete from public.document_signing_requests where id=$1", [owner]), /trusted lifecycle writer/)
      await assert.rejects(db.query("update public.envelopes set status='draft' where id=$1", [envelope]), /trusted lifecycle writer/)
      await assert.rejects(db.query("update public.envelope_recipients set email='changed@example.test' where envelope_id=$1", [envelope]), /trusted lifecycle writer/)
      await assert.rejects(db.query("delete from public.documents where id=$1", [doc]), /trusted lifecycle writer/)
      await assert.rejects(db.query("update public.documents set source_entity_type='estimate',source_entity_id=$1 where id=$2", [id(903),doc]), /trusted lifecycle writer/)
      await assert.rejects(db.query("update public.documents set metadata=metadata||'{\"estimate_signature_data\":{\"client\":{\"signer_name\":\"Fabricated\"}}}'::jsonb where id=$1", [doc]), /trusted lifecycle writer/)
      await assert.rejects(db.query("update public.document_signing_requests set document_id=$1,envelope_id=$2,group_id=$2 where id=$3", [id(901),id(902),builder]), /trusted lifecycle writer/)
      await assert.rejects(db.query('select public.freeze_legacy_esign_source($1,$2,$3,$4)', [org,doc,id(10),'{}']), /permission denied/)
    })
    await asRole('service_role', async () => { await accept() })
    assert.equal((await row('select status from public.document_signing_requests where id=$1', [owner])).status, 'signed')
  })

  await t.test('optional signatures cannot arrive after the execution snapshot is claimed or published', async () => {
    await reset()
    await db.query('update public.document_signing_requests set required=false,sequence=1 where id=$1', [builder])
    await accept()
    await claim()
    await assert.rejects(accept(builder, { [builderField]: 'Late optional signer' }), /being finalized/)
    assert.equal(await count('document_signatures'), 1)
    await complete()
    await assert.rejects(accept(builder, { [builderField]: 'Late optional signer' }), /already completed/)
    assert.equal(await count('document_signatures'), 1)
    // The signer already in the evidence still receives the same receipt.
    assert.ok((await accept()).rows[0].signature_id)
  })
})
