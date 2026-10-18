require('../scripts/register-ts-node-test')
const test = require('node:test')
const assert = require('node:assert/strict')
const { parseBulkRecipientCsv, unsignedDraftValues, readUnsignedDraft } = require('../lib/esign/esign-ui-helpers')
const { formatFieldValue } = require('../app/d/[token]/components/types')

test('bulk roster accepts quoted commas/newlines and never silently discards bad rows', () => {
  const parsed = parseBulkRecipientCsv('"Doe, Jane",JANE@example.com,"Contract, phase 2"\nsam@example.com\nbroken\nOther,jane@example.com')
  assert.deepEqual(parsed.recipients, [{ name: 'Doe, Jane', email: 'jane@example.com', title: 'Contract, phase 2' }, { name: '', email: 'sam@example.com', title: undefined }])
  assert.equal(parsed.errors.length, 2)
  assert.match(parsed.errors[0], /Row 3/)
  assert.match(parsed.errors[1], /duplicate/)
  assert.ok(parseBulkRecipientCsv('"Unclosed,jane@example.com').errors.length)
  assert.ok(parseBulkRecipientCsv(Array.from({length:101},(_,i)=>`user${i}@example.com`).join('\n')).errors.length)
})

test('unsigned resume excludes signatures, foreign fields, data URLs and expired/tampered state', () => {
  const fields = [{id:'sig',field_type:'signature'},{id:'text',field_type:'text'},{id:'check',field_type:'checkbox'},{id:'image',field_type:'text'}]
  const values = { sig:'data:image/png;base64,abc', text:'Contract number 12', check:false, image:'data:image/png;base64,abc', foreign:'private' }
  assert.deepEqual(unsignedDraftValues(fields, values), {text:'Contract number 12',check:false})
  const raw = JSON.stringify({version:1,savedAt:100,values})
  assert.deepEqual(readUnsignedDraft(raw,fields,101), {text:'Contract number 12',check:false})
  assert.equal(readUnsignedDraft(raw,fields,86400200),null)
  assert.equal(readUnsignedDraft(raw,fields,99),null)
  assert.equal(readUnsignedDraft('broken',fields),null)
})

test('review formats dates according to sender choice and preserves unchecked values', () => {
  for (const [dateFormat, expected] of [['MM/DD/YYYY','10/03/2026'],['DD/MM/YYYY','03/10/2026'],['YYYY-MM-DD','2026-10-03'],['MMM D, YYYY','Oct 3, 2026']]) {
    assert.equal(formatFieldValue({field_type:'date',metadata:{dateFormat}},'2026-10-03'),expected)
  }
  assert.equal(formatFieldValue({field_type:'checkbox'},false),'Unchecked')
  assert.equal(formatFieldValue({field_type:'text'},'Contract number 12'),'Contract number 12')
})

test('text field constraints reject invalid email and non-decimal number values', () => {
  const { isFieldComplete } = require('../app/d/[token]/components/types')
  const numeric = { id:'value',field_type:'text',metadata:{validation:'number'} }
  const email = { id:'value',field_type:'text',metadata:{validation:'email'} }
  for (const value of ['12','-12.50','.5','+42']) assert.equal(isFieldComplete(numeric,{value}),true)
  for (const value of ['','Infinity','1e3','12.','twelve']) assert.equal(isFieldComplete(numeric,{value}),false)
  assert.equal(isFieldComplete(email,{value:'jane@example.com'}),true)
  assert.equal(isFieldComplete(email,{value:'jane@'}),false)
})
