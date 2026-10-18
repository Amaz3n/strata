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

test('review saves large imported waivers with short version filters and rejects actual races', async () => {
  let conflict = false, failure = false
  const waiver = { id: 'selected', org_id: 'org', invoice_id: 'invoice', status: 'pending_payment', updated_at: '2026-09-01T00:00:00Z', metadata: { template: 'Imported wording '.repeat(2000), workflow: { version: 2, lifecycle: 'draft', source: 'template', shared: false } } }
  const currentInvoice = { ...structuredClone(invoice), org_id: 'org', updated_at: '2026-09-01T00:00:00Z' }
  const db = { from(table) {
    const filters = []; let patch, single = false
    const q = {
      select(){return q}, order(){return q},
      eq(key, value){ assert.notEqual(key, 'metadata', 'never put the document in a URL'); assert.ok(String(value).length < 100); filters.push(row => row[key] === value); return q },
      neq(key, value){ filters.push(row => row[key] !== value); return q },
      update(value){patch = value; return q}, maybeSingle(){single = true; return q},
      then(resolve, reject){return Promise.resolve().then(() => {
        if (patch && table === 'invoice_lien_waivers') {
          if (failure) return { data: null, error: { message: 'database unavailable' } }
          if (conflict) waiver.updated_at = 'concurrent-version'
        }
        const row = table === 'invoice_lien_waivers' ? waiver : currentInvoice
        const found = filters.every(f => f(row))
        if (found && patch) Object.assign(row, structuredClone(patch))
        return { data: single ? (found ? structuredClone(row) : null) : (found ? [structuredClone(row)] : []), error: null }
      }).then(resolve, reject)},
    }; return q
  } }
  const original = Module._load
  const modulePath = require.resolve('../lib/services/invoice-waiver-packet')
  delete require.cache[modulePath]
  Module._load = function(request, ...args) {
    if (request === '@/lib/services/invoice-waiver-workflow') return { invoiceWaiverContext: async () => ({ supabase: db, orgId: 'org', invoice: structuredClone(currentInvoice) }) }
    return original.call(this, request, ...args)
  }
  try {
    const { setInvoiceWaiverPacket: save } = require(modulePath)
    const wording = waiver.metadata.template
    await save('invoice', true, 'selected')
    assert.equal(waiver.metadata.template, wording)
    assert.equal(waiver.metadata.workflow.sharing_requested, true)
    assert.equal(waiver.metadata.workflow.shared, false, 'review must not publish unsigned waivers')
    assert.notEqual(waiver.updated_at, '2026-09-01T00:00:00Z')
    assert.equal(currentInvoice.metadata.waiver_packet.waiver_id, 'selected')
    conflict = true
    await assert.rejects(save('invoice', false), /waiver changed/)
    assert.equal(currentInvoice.metadata.waiver_packet.enabled, true)
    conflict = false; failure = true
    await assert.rejects(save('invoice', false), /Could not save the waiver packet/)
  } finally { Module._load = original; delete require.cache[modulePath] }
})
