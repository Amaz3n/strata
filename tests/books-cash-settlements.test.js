require('../scripts/register-ts-node-test')
const test = require('node:test')
const assert = require('node:assert/strict')
const { allocateCashDocumentSettlements: report } = require('../lib/services/books/cash-settlement-rules')
const basis = {
  documentId: 'invoice-1', snapshotId: 'frozen-1', issuedOn: '2026-01-01',
  grossCents: 10001, completeSettlementHistory: true,
  components: [
    { id: 'labor', kind: 'income', accountCode: '4010', amountCents: 8000 },
    { id: 'service', kind: 'income', accountCode: '4020', amountCents: 2000 },
    { id: 'discount', kind: 'income', accountCode: '4090', amountCents: -833 },
    { id: 'tax', kind: 'sales_tax', accountCode: '2210', amountCents: 834 },
  ],
}
const event = (id, date, cents, document = basis) => ({ eventId: id, documentId: document.documentId, snapshotId: document.snapshotId, settledOn: date, appliedCents: cents })
const run = (settlements, startDate = '2026-01-01', endDate = '2026-12-31', documents = [basis]) => report({ documents, settlements, startDate, endDate })

test('cash income excludes collected sales tax and retains signed native income buckets', () => {
  const unpaid = run([])
  assert.equal(unpaid.incomeCents, 0)
  const full = run([event('receipt', '2026-02-01', 10001)])
  assert.equal(full.incomeCents, 9167)
  assert.equal(full.salesTaxCents, 834)
  assert.equal(full.appliedPrincipalCents, 10001)
  assert.deepEqual(Object.fromEntries(full.rows.map(row => [row.accountCode, row.amountCents])), { '4090': -833, '4010': 8000, '4020': 2000, '2210': 834 })
  // Processor cash of 9,701 after a 300-cent fee would still carry 10,001
  // principal: the fee is a separate expense, never a reduction of sales.
})

test('monthly windows telescope to annual income/tax and refund the cumulative cents exactly', () => {
  const settlements = [event('first', '2026-01-31', 1), event('second', '2026-02-01', 3333), event('third', '2026-03-01', 6667), event('refund', '2026-04-01', -10001)]
  const months = [['2026-01-01','2026-01-31'], ['2026-02-01','2026-02-28'], ['2026-03-01','2026-03-31'], ['2026-04-01','2026-04-30']].map(([start,end]) => run(settlements,start,end))
  assert.equal(months[0].appliedPrincipalCents, 1)
  assert.equal(months[1].appliedPrincipalCents, 3333)
  assert.equal(months[2].appliedPrincipalCents, 6667)
  assert.equal(months[3].incomeCents, -9167)
  assert.equal(months[3].salesTaxCents, -834)
  assert.equal(months.reduce((sum,row) => sum + row.incomeCents,0),0)
  assert.equal(months.reduce((sum,row) => sum + row.salesTaxCents,0),0)
  assert.deepEqual(run(settlements).rows, [])
  assert.deepEqual(run(settlements.slice().reverse()), run(settlements))
  assert.deepEqual(run(settlements,'2026-01-01','2026-03-31').rows,run([event('single','2026-03-01',10001)],'2026-01-01','2026-03-31').rows)
})

test('every cumulative cent conserves principal and collected tax never decreases on a positive receipt', () => {
  const tiny = { ...basis, grossCents: 14, components: [
    { id:'a',kind:'income',accountCode:'4010',amountCents:6 },
    { id:'b',kind:'income',accountCode:'4020',amountCents:6 },
    { id:'c',kind:'sales_tax',accountCode:'2210',amountCents:2 },
  ] }
  let priorTax = 0
  for (let cents = 1; cents <= 14; cents++) {
    const current = run([event('receipt','2026-02-01',cents,tiny)],'2026-01-01','2026-12-31',[tiny])
    assert.equal(current.appliedPrincipalCents,cents)
    assert.ok(current.salesTaxCents >= priorTax)
    assert.equal(current.incomeCents + current.salesTaxCents,cents)
    priorTax = current.salesTaxCents
  }
})

test('cash basis rejects incomplete, mismatched, duplicate and unsupported advance/unapplied evidence', () => {
  assert.throws(() => run([],undefined,undefined,[{...basis,completeSettlementHistory:false}]),/Complete dated/)
  assert.throws(() => run([event('advance','2025-12-31',100)]),/Advance receipts/)
  assert.throws(() => run([{...event('bad','2026-02-01',100),snapshotId:'live-other'}]),/matching frozen/)
  assert.throws(() => run([event('dup','2026-02-01',100),event('dup','2026-02-01',100)]),/Duplicate/)
  assert.throws(() => run([],undefined,undefined,[basis,basis]),/Duplicate/)
  assert.throws(() => run([event('overpaid','2026-02-01',10002),event('refund','2026-03-01',-1)]),/Unapplied/)
  assert.throws(() => run([event('excess-refund','2026-02-01',-1)]),/excess refunds/)
  assert.throws(() => run([event('invalid-date','2026-02-30',1)]),/calendar date/)
  assert.throws(() => run([],undefined,undefined,[{...basis,grossCents:10000}]),/equal gross/)
})

test('large amounts preserve the last cent and separate document ownership', () => {
  const huge = {...basis,grossCents:Number.MAX_SAFE_INTEGER,components:[{id:'income',kind:'income',accountCode:'4010',amountCents:Number.MAX_SAFE_INTEGER-1},{id:'tax',kind:'sales_tax',accountCode:'2210',amountCents:1}]}
  const full=run([event('huge','2026-02-01',Number.MAX_SAFE_INTEGER,huge)],undefined,undefined,[huge])
  assert.equal(full.salesTaxCents,1)
  assert.equal(full.incomeCents,Number.MAX_SAFE_INTEGER-1)
  const other={...basis,documentId:'invoice-2',snapshotId:'frozen-2'}
  const split=run([event('allocation-1','2026-02-01',5000),event('allocation-2','2026-02-01',4000,other)],undefined,undefined,[basis,other])
  assert.equal(split.appliedPrincipalCents,9000)
  assert.equal(split.rows.filter(row=>row.documentId===basis.documentId).reduce((sum,row)=>sum+row.amountCents,0),5000)
  assert.equal(split.rows.filter(row=>row.documentId===other.documentId).reduce((sum,row)=>sum+row.amountCents,0),4000)
  assert.throws(()=>run([event('overflow-1','2026-02-01',Number.MAX_SAFE_INTEGER,huge),event('overflow-2','2026-02-01',10001,other)],undefined,undefined,[huge,other]),/safe integer/)
})
