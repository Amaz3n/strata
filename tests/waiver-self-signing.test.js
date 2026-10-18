require('../scripts/register-ts-node-test')
const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const { selfSignatureValues } = require('../lib/invoices/waiver-self-signing')
const signature = 'data:image/png;base64,iVBORw0KGgoAAA=='

test('self signing requires explicit consent and a bounded PNG signature', () => {
  const fields = [{ id: 'sig', field_type: 'signature', signer_role: 'claimant', required: true }]
  assert.throws(() => selfSignatureValues(fields, signature, false, '2026-09-12'), /Agree/)
  assert.throws(() => selfSignatureValues(fields, 'Alex', true, '2026-09-12'), /Add your signature/)
  assert.throws(() => selfSignatureValues(fields, signature + 'A'.repeat(500000), true, '2026-09-12'))
  assert.throws(() => selfSignatureValues([], signature, true, '2026-09-12'), /no signature field/)
})

test('self signing fills only claimant signature and date fields and rejects unsupported required fields', () => {
  const fields = [
    { id: 'sig', field_type: 'signature', signer_role: 'claimant', required: true },
    { id: 'date', field_type: 'date', signer_role: 'claimant', required: true },
    { id: 'other', field_type: 'signature', signer_role: 'owner', required: true },
  ]
  assert.deepEqual(selfSignatureValues(fields, signature, true, '2026-09-12'), { sig: signature, date: '2026-09-12' })
  assert.throws(() => selfSignatureValues([...fields, { id: 'text', field_type: 'text', signer_role: 'claimant', required: true }], signature, true, '2026-09-12'), /additional signing fields/)
})

test('native self signing binds the actor, uses packet delivery, executes once, and resumes a completed signature', async () => {
  let actor = 'other', lifecycle = 'draft', status = 'draft', sends = 0, submissions = 0
  let metadata = {}
  let workflow = { version: 2, lifecycle, input: { signer_name: 'Alex' } }
  const waiver = { id: 'waiver', metadata: { workflow } }
  const db = { from(table) {
    let patch
    const q = { select(){return q},eq(){return q},in(){return q},order(){return q},limit(){return q},single(){return q},maybeSingle(){return q},update(value){patch=value;return q},then(resolve){
      if (patch) metadata = patch.metadata
      const data = table === 'document_fields' ? [{ id: 'sig', field_type: 'signature', signer_role: 'claimant', required: true }, { id: 'date', field_type: 'date', signer_role: 'claimant', required: true }]
        : table === 'document_signing_requests' ? { revision: 1 }
        : table === 'envelopes' ? { id: 'envelope' }
        : { id: 'document', metadata, status }
      return Promise.resolve({ data, error: null }).then(resolve)
    } }; return q
  } }
  const stubs = {
    'next/cache': { revalidatePath(){} },
    '@/lib/services/invoice-waiver-workflow': {
      getInvoiceWaiverRecord: async () => ({ ctx: { supabase: db, orgId: 'org', userId: actor, invoice: {} }, waiver }),
      startInvoiceWaiverSigning: async (_invoice, _waiver, shared, packet) => {
        assert.equal(shared, true); assert.equal(packet, true)
        workflow.signing_document_id = 'document'
        return { documentId: 'document', status, waiver }
      },
    },
    '@/lib/services/waiver-signers': { listWaiverSigners: async () => [{ id: 'alex', name: 'Alex', email: 'alex@example.test' }] },
    '@/app/(app)/signatures/actions': {
      sendDocumentEnvelopeAction: async input => { sends++; assert.equal(input.recipients[0].user_id, 'alex'); status = 'sent'; return { success: true, data: { envelopeId: 'envelope' } } },
      createMySigningLinkAction: async () => ({ success: true, data: { url: 'https://example.test/d/' + 'a'.repeat(64) } }),
    },
    '@/app/d/[token]/actions': { submitDocumentSignatureAction: async input => {
      submissions++; assert.equal(input.signerName, 'Alex'); assert.equal(input.signerEmail, 'alex@example.test')
      assert.equal(input.values.sig, signature); assert.match(input.values.date, /^\d{4}-\d{2}-\d{2}$/)
      assert.match(input.consentText, /legally binding/)
      workflow.lifecycle = 'signed'
      return { success: true }
    } },
  }
  const original = Module._load
  Module._load = function(request, ...args) { return stubs[request] ?? original.call(this, request, ...args) }
  try {
    const { signOwnInvoiceWaiverAction: sign } = require('../app/(app)/invoices/waiver-actions')
    assert.equal((await sign('invoice', 'waiver', signature, true)).success, false)
    assert.equal(sends, 0)
    actor = 'alex'
    assert.equal((await sign('invoice', 'waiver', signature, false)).success, false)
    assert.equal(sends, 0)
    const result = await sign('invoice', 'waiver', signature, true)
    assert.equal(result.success, true, result.error)
    assert.equal(submissions, 1); assert.equal(sends, 1)
    assert.equal((await sign('invoice', 'waiver', signature, true)).success, true)
    assert.equal(submissions, 1); assert.equal(sends, 1)
  } finally { Module._load = original }
})
