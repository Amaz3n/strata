require('../scripts/register-ts-node-test')
const test = require('node:test')
const assert = require('node:assert/strict')
const { waiverInvoiceRevision, withInvoiceWaiverFields } = require('../lib/invoices/waiver-composer-state')
const source = { projectName: 'Oak Street', preview: { data: { invoiceNumber: '1042', projectName: 'Framing', fromLines: ['Builder LLC'], billToLines: ['Original customer'], subtotalCents: 10000, taxCents: 0, totalCents: 10000, notes: '', dueDate: '2026-09-30', paymentMethods: [] }, lines: [{description:'Framing',quantity:1,unitCostCents:10000,lineTotalCents:10000}] } }
const input = { project_name:'Old project', claimant_name:'Old builder', customer_name:'Original customer', owner_name:'Original customer', amount_cents:5000, exceptions:'Keep my exceptions', through_date:'2026-09-12', signer_name:'Alex' }

test('invoice edits propagate into waiver fields while preserving waiver-specific input', () => {
  const changed = { ...source, preview:{...source.preview,data:{...source.preview.data,billToLines:['New customer'],totalCents:25000}} }
  const result = withInvoiceWaiverFields(input, changed, false)
  assert.equal(result.project_name, 'Oak Street')
  assert.equal(result.claimant_name, 'Builder LLC')
  assert.equal(result.customer_name, 'New customer')
  assert.equal(result.owner_name, 'New customer')
  assert.equal(result.amount_cents, 25000)
  for (const key of ['exceptions', 'through_date', 'signer_name']) assert.equal(result[key],input[key])
  assert.equal(input.customer_name,'Original customer')
})
test('partial coverage and a distinct property owner are retained deliberately', () => {
  const result = withInvoiceWaiverFields({...input,owner_name:'Property Trust'},source,true)
  assert.equal(result.amount_cents,5000)
  assert.equal(result.owner_name,'Property Trust')
})
test('financial and identity changes invalidate a prepared waiver without save-state noise', () => {
  const revision=waiverInvoiceRevision(source)
  const changed = data => ({...source,preview:{...source.preview,data:{...source.preview.data,...data}}})
  for (const data of [{totalCents:12000},{invoiceNumber:'1043'},{fromLines:['Different builder']},{billToLines:['Other customer']},{notes:'Different scope'}]) assert.notEqual(waiverInvoiceRevision(changed(data)),revision)
  assert.notEqual(waiverInvoiceRevision({...source,preview:{...source.preview,lines:[{...source.preview.lines[0],description:'Roofing'}]}}),revision)
  assert.equal(waiverInvoiceRevision(changed({dueDate:'2026-10-01',paymentMethods:['card']})),revision)
  assert.equal(waiverInvoiceRevision(JSON.parse(JSON.stringify(source))),revision)
})
