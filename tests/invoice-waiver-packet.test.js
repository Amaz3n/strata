require('../scripts/register-ts-node-test')
const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const { invoiceWaiverContentHash: hash } = require('../lib/lien-waivers/invoice-content')
const invoice = { id: 'invoice', project_id: 'project', invoice_number: '1', total_cents: 2500, metadata: { waiver_packet: { enabled: true, waiver_id: 'selected' }, lines: [{ description: 'Work', quantity: 1, unit_price_cents: 2500 }] } }

test('waiver content survives delivery and row identity changes but detects financial changes', () => {
  assert.equal(hash(invoice), hash({ ...invoice, status: 'sent', updated_at: 'later', metadata: { ...invoice.metadata, lines: [{ ...invoice.metadata.lines[0], id: 'new-row' }] } }))
  assert.notEqual(hash(invoice), hash({ ...invoice, total_cents: 2000 }))
  assert.notEqual(hash(invoice), hash({ ...invoice, metadata: { ...invoice.metadata, lines: [{ description: 'Different work', quantity: 1, unit_price_cents: 2500 }] } }))
})

test('packet delivery requires the selected signed, shared, current waiver', async () => {
  const original = Module._load
  Module._load = function(request, ...args) {
    if (request === '@/lib/services/invoice-waiver-workflow') return { invoiceWaiverContext: async () => { throw new Error('not used') } }
    return original.call(this, request, ...args)
  }
  try {
    const { assertInvoiceWaiverPacketReady: ready } = require('../lib/services/invoice-waiver-packet')
    let rows = []
    const db = { from(table) { assert.equal(table, 'invoice_lien_waivers'); const q = { select(){return q}, eq(){return q}, neq(){return q}, then(resolve){return Promise.resolve({data: rows, error: null}).then(resolve)} }; return q } }
    await ready(db, 'org', { ...invoice, metadata: {} })
    await assert.rejects(ready(db, 'org', invoice), /Finish signing/)
    const waiver = { id: 'selected', status: 'pending_payment', amount_cents: 2500, metadata: { workflow: { version: 2, lifecycle: 'signed', source: 'template', shared: true, document_path: 'signed.pdf', invoice_content_hash: hash(invoice) } } }
    rows = [waiver]
    await ready(db, 'org', invoice)
    for (const change of [{ lifecycle: 'draft' }, { shared: false }, { needs_review: true }, { invoice_content_hash: 'stale' }]) {
      rows = [{ ...waiver, metadata: { workflow: { ...waiver.metadata.workflow, ...change } } }]
      await assert.rejects(ready(db, 'org', invoice), /Finish signing/)
    }
    rows = [{ ...waiver, id: 'different' }]
    await assert.rejects(ready(db, 'org', invoice), /Finish signing/)
    rows = [{ ...waiver, amount_cents: 3000 }]
    await assert.rejects(ready(db, 'org', invoice), /Finish signing/)
  } finally { Module._load = original }
})
