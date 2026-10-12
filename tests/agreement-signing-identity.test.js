require('../scripts/register-ts-node-test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const test = require('node:test')

function signing({ contractPatch = {}, contactPatch = {}, missingContact = null, denied = false, secret = true, failedTable = null, emailAccepted = true, missingWrite = false, requestPatch = {}, truncateRequests = false, provider = 'r2', durable = false, freezeFailure = false, publicationFailure = false, existingOwner = false, ownedDocumentId = 'document' } = {}) {
  const captured = { writes: [], emails: [], pdfs: [], recipients: [], authorizations: [], uploads: [], queries: [], publications: [], freezes: [], reservations: [] }
  const pricing = require('../lib/financials/purchase-agreement-pricing').composePurchaseAgreementPricing({ basePriceCents: 30000000, lotPremiumCents: 0, structuralOptions: [], designSelections: [], incentives: [] })
  const tables = {
    contracts: [{ id: 'agreement', org_id: 'org', project_id: 'home', contract_type: 'purchase_agreement', status: 'draft', buyer_contact_id: 'buyer', co_buyer_contact_id: 'co', project: { name: 'Lot 10', client: { id: 'changed-client', email: 'wrong@example.test' } }, title: 'Agreement', number: 'PA-1', snapshot: { purchase_agreement: { pricing } }, ...contractPatch }],
    contacts: [ { id: 'buyer', org_id: 'org', full_name: 'Buyer', email: 'buyer@example.test' }, { id: 'co', org_id: 'org', full_name: 'Co-buyer', email: 'co@example.test', ...contactPatch } ].filter(row => row.id !== missingContact),
    app_users: [{ id: 'builder', email: 'builder@example.test', full_name: 'Builder' }],
  }
  const supabase = { from(table) {
    let rows = tables[table] ?? [], payload = null
    const query = {
      select(columns) { captured.queries.push({ table, columns }); return query },
      eq(key,value) { rows = rows.filter(row => row[key] === value); return query },
      in(key,values) { rows = rows.filter(row => values.includes(row[key])); return query },
      update(value) { payload = value; return query },
      async single() { captured.writes.push({ table, payload }); return { data: missingWrite ? null : { id: 'request' }, error: failedTable === table ? { message: 'write failed' } : null } },
      async maybeSingle() { return { data: rows[0] ?? null, error: failedTable === table ? { message: 'read failed' } : null } },
      then(resolve,reject) { if (payload) captured.writes.push({ table, payload }); return Promise.resolve({ data: rows, error: failedTable === table ? { message: 'write failed' } : null }).then(resolve,reject) },
    }
    return query
  } }
  const compiled = { exports: {} }
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(require.resolve('../lib/services/community-sales.ts'),'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports: compiled.exports, process: { env: { ...(secret ? { DOCUMENT_SIGNING_SECRET: 'test-only-secret' } : {}), ...(durable ? { ARC_AGREEMENT_DURABLE_SIGNING_ENABLED: 'true' } : {}) } },
    require(name) {
      if (name === 'zod' || name === 'crypto') return require(name)
      if (name === '@/lib/services/context') return { requireOrgContext: async () => ({ supabase, orgId: 'org', userId: 'builder' }) }
      if (name === '@/lib/services/permissions') return { requirePermission: async () => {} }
      if (name === '@/lib/services/authorization') return { requireAuthorization: async args => { captured.authorizations.push(args); if (denied) throw new Error('Home denied') } }
      if (name === '@/lib/storage/files-storage') return { getFilesStorageProvider: () => provider, buildOrgScopedPath: () => 'test-object', uploadFilesObject: async input => captured.uploads.push(input) }
      if (name === '@/lib/services/agreement-signing-ownership') return {
        reserveAgreementSigningDocument: async input => { captured.reservations.push(input); return !input.fileId && !existingOwner ? null : {id:ownedDocumentId,source_file_id:'file'} },
        publishOwnedAgreementDocument: async input => {
          captured.freezes.push([input.orgId,input.document.id,input.document.source_file_id]); if (freezeFailure) throw new Error('Frozen source failed')
          captured.publications.push({name:'publish_purchase_agreement_document',input:{p_org_id:input.orgId,p_document_id:input.document.id,p_actor_id:input.actorId,p_source:{sha256:'a'.repeat(64)}}})
          if (publicationFailure) throw new Error('The agreement was saved but signing publication could not be confirmed. Reconcile its document before retrying')
          return {documentId:input.document.id,envelopeId:'durable-envelope',reason:'Buyer invitations are queued for delivery'}
        },
      }
      if (name === '@/lib/services/estimate-portal') return { getOrgBranding: async () => ({ name: 'Builder' }) }
      if (name === '@/lib/pdfs/proposal') return { renderProposalPdf: async input => { captured.pdfs.push(input); return Buffer.from('test PDF') } }
      if (name === '@/lib/services/files') return { createFileRecord: async () => ({ id: 'file' }) }
      if (name === '@/lib/services/documents') return { createDocument: async () => ({ id: 'document' }) }
      if (name === '@/lib/services/envelopes') return {
        ensureDraftEnvelopeForDocument: async () => ({ id: 'envelope' }),
        replaceEnvelopeRecipients: async input => { captured.recipients = input.recipients },
        createEnvelopeSigningRequests: async () => ({ requests: captured.recipients.map((recipient,i) => ({ id: `request-${i}`, org_id: 'org', document_id: 'document', envelope_id: 'envelope', token_hash: 'test-hash', signer_role: recipient.signer_role, sent_to_email: recipient.email, sequence: recipient.sequence, required: true, recipient_contact_id: recipient.contact_id ?? null, ...requestPatch })).slice(0,truncateRequests ? 1 : undefined) }),
      }
      if (name === '@/lib/esign/unified-contracts') return { buildUnifiedSigningUrl: () => 'https://example.test/sign' }
      if (name === '@/lib/esign/signing-tokens') return { createRecoverableSigningToken: () => 'test-recoverable-token' }
      if (name === '@/lib/financials/purchase-agreement-pricing') return require('../lib/financials/purchase-agreement-pricing')
      if (name === '@/lib/services/signature-delivery') return { sendSignerRequestEmail: async input => { captured.emails.push(input); if (!emailAccepted) throw new Error('Signature email delivery failed') } }
      return {}
    },
  })
  return { run: () => compiled.exports.generatePurchaseAgreementSigningDocument('agreement'), captured }
}

test('PDF and delivery use agreement-bound buyer/co-buyer even when project client changes', async () => {
  const { run,captured } = signing()
  await run()
  assert.equal(captured.authorizations[0].projectId,'home')
  assert.equal(captured.authorizations[0].permission,'sales.manage')
  assert.equal(captured.pdfs[0].recipientEmail,'buyer@example.test')
  assert.deepEqual(Array.from(captured.emails, row => row.toEmail).sort(), ['buyer@example.test','co@example.test'])
  assert.equal(captured.recipients.length,3)
  assert.ok(captured.emails.every(row => row.requestId && row.expectedTokenHash === 'test-hash' && row.idempotencyKey.startsWith('esign-invitation:')))
  assert.ok(captured.writes.every(row => !('token_hash' in row.payload)))
  assert.ok(captured.queries.every(row => !row.columns.includes('client:contacts')))
})

test('missing, foreign or incomplete signer contacts fail before PDF, upload or delivery', async () => {
  for (const options of [ { missingContact: 'co' }, { contactPatch: { org_id: 'foreign' } }, { contactPatch: { email: null } }, { contractPatch: { buyer_contact_id: null } }, { contractPatch: { co_buyer_contact_id: 'buyer' } }, { failedTable: 'contacts' }, { failedTable: 'app_users' }, { secret: false } ]) {
    const { run,captured } = signing(options)
    await assert.rejects(run())
    assert.equal(captured.pdfs.length,0)
    assert.equal(captured.uploads.length,0)
    assert.equal(captured.emails.length,0)
  }
})

test('home denial and non-draft agreements stop signing even without storage', async () => {
  for (const options of [ { denied: true }, { denied: true, provider: 'supabase' }, { contractPatch: { status: 'active' } }, { contractPatch: { status: 'void' } } ]) {
    const { run,captured } = signing(options)
    await assert.rejects(run())
    assert.equal(captured.uploads.length,0)
  }
})

test('every required request must match the bound email, contact, scope and sequence', async () => {
  for (const options of [{ truncateRequests: true }, ...[{ sent_to_email: 'wrong@example.test' }, { recipient_contact_id: 'foreign' }, { sequence: 9 }, { required: false }, { org_id: 'foreign' }, { document_id: 'other' }, { envelope_id: 'other' }, { token_hash: null }].map(requestPatch => ({ requestPatch }))]) {
    const { run,captured } = signing(options)
    await assert.rejects(run(), /required recipients/)
    assert.equal(captured.emails.length,0)
    assert.equal(captured.writes.length,0)
  }
})

test('token persistence and provider failure cannot be reported as sent', async () => {
  for (const options of [{ failedTable: 'document_signing_requests' }, { missingWrite: true }, { emailAccepted: false }]) {
    const { run,captured } = signing(options)
    await assert.rejects(run(), /delivery/)
    assert.ok(!captured.writes.some(row => row.table === 'documents' || row.table === 'envelopes'))
    if (options.failedTable || options.missingWrite) assert.equal(captured.emails.length,0)
  }
  await assert.rejects(signing({ failedTable: 'documents' }).run(), /reconciliation/)
})

test('agreements without a co-buyer retain exactly the buyer and builder obligations', async () => {
  const { run,captured } = signing({ contractPatch: { co_buyer_contact_id: null } })
  await run()
  assert.equal(captured.recipients.length,2)
  assert.equal(captured.emails.length,1)
  assert.equal(captured.emails[0].toEmail,'buyer@example.test')
})


test('durable signing freezes the source and atomically queues agreement-bound recipients', async () => {
  const {run,captured}=signing({durable:true})
  const result=await run()
  assert.equal(result.envelopeId,'durable-envelope')
  assert.match(result.reason,/queued for delivery/)
  assert.equal(captured.emails.length,0)
  assert.equal(captured.writes.length,0)
  assert.deepEqual(Array.from(captured.freezes[0]),['org','document','file'])
  assert.equal(captured.authorizations.length,1)
  const publication=captured.publications[0]
  assert.equal(publication.name,'publish_purchase_agreement_document')
  assert.equal(publication.input.p_org_id,'org')
  assert.equal(publication.input.p_actor_id,'builder')
  assert.equal(publication.input.p_source.sha256,'a'.repeat(64))
  const recipients=captured.reservations[1].recipients
  assert.equal(recipients.length,3)
  assert.deepEqual(Array.from(recipients,r=>[r.type,r.contact_id,r.user_id,r.sequence]),[['contact','buyer',null,1],['contact','co',null,1],['internal_user',null,'builder',2]])
})

test('failed freeze or uncertain publication never falls back to legacy sending', async () => {
  for (const options of [{freezeFailure:true},{publicationFailure:true}]) {
    const {run,captured}=signing({durable:true,...options})
    await assert.rejects(run(),options.freezeFailure?/Frozen source failed/:/Reconcile its document/)
    assert.equal(captured.emails.length,0)
    assert.equal(captured.writes.length,0)
    assert.equal(captured.publications.length,options.freezeFailure?0:1)
  }
})


test('an existing owned agreement packet resumes before rendering or uploading another source',async()=>{
 const {run,captured}=signing({durable:true,existingOwner:true,failedTable:'contacts'})
 const result=await run()
 assert.equal(result.documentId,'document')
 assert.equal(captured.pdfs.length,0)
 assert.equal(captured.uploads.length,0)
 assert.equal(captured.reservations.length,1)
 assert.equal(captured.publications.length,1)
 assert.equal(captured.queries.some(q=>q.table==='contacts'),false)
})

test('a concurrent reservation winner is published without creating a legacy document',async()=>{
 const {run,captured}=signing({durable:true,ownedDocumentId:'winner'})
 const result=await run()
 assert.equal(result.documentId,'winner')
 assert.equal(captured.reservations.length,2)
 assert.equal(captured.publications[0].input.p_document_id,'winner')
 assert.equal(captured.emails.length,0)
})
