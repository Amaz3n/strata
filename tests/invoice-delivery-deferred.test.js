const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const source = fs.readFileSync(require.resolve('../lib/services/invoices.ts'), 'utf8')
const start = source.indexOf('async function deliverIssuedInvoice(')
const end = source.indexOf('/** The issuance job body.', start)
const compiled = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText
function fixture(enqueued, fails = false) {
  let callback, deliveries = 0, completed = 0
  const context = { Date, console: { error() {} }, INVOICE_ISSUANCE_JOB_TYPE: 'issue_invoice',
    enqueueOutboxJob: async () => enqueued,
    runInvoiceIssuance: async () => { deliveries++; if (fails) throw new Error('provider unavailable') },
    completeOutboxJob: async () => { completed++ },
    after: fn => { callback = fn },
  }
  vm.createContext(context)
  vm.runInContext(compiled, context)
  return { send: () => context.deliverIssuedInvoice({ orgId: 'org', invoiceId: 'inv', recipients: ['customer@example.test'] }), flush: () => callback(), counts: () => [deliveries, completed] }
}
test('durably queued delivery returns before email work and completes after the response', async () => {
  const f = fixture({ enqueued: true, id: 'job' })
  await f.send(); assert.deepEqual(f.counts(), [0, 0])
  await f.flush(); assert.deepEqual(f.counts(), [1, 1])
})
test('provider failure leaves the durable job available for retry', async () => {
  const f = fixture({ enqueued: true, id: 'job' }, true)
  await f.send(); await f.flush(); assert.deepEqual(f.counts(), [1, 0])
})
test('without a durable queue record, delivery is awaited and failures are surfaced', async () => {
  const f = fixture({ enqueued: false, reason: 'error' })
  await f.send(); assert.deepEqual(f.counts(), [1, 1])
  await assert.rejects(fixture({ enqueued: false, reason: 'error' }, true).send(), /provider unavailable/)
})
