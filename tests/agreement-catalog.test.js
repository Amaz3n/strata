require('../scripts/register-ts-node-test')
const assert = require('node:assert/strict')
const test = require('node:test')
const { agreementChoiceKey, indexAgreementCatalog, pageAgreementCatalog } = require('../lib/sales/agreement-catalog')
const items = Array.from({ length: 10000 }, (_,i) => ({ optionId: `option-${i}`, label: `Finish ${i}`, category: i % 2 ? 'Kitchen' : 'Bath', priceCents: i*100 }))

test('a ten-thousand-choice catalog renders bounded pages without losing late selections', () => {
  const index = indexAgreementCatalog(items), selected = new Set(['option:option-9999','option:option-2'])
  const first = pageAgreementCatalog(index,selected,{ query: '',selectedOnly: false,page: 0 })
  assert.equal(first.items.length,40)
  assert.equal(first.matchesCount,10000)
  assert.equal(first.selectedCount,2)
  const last = pageAgreementCatalog(index,selected,{ query: '',selectedOnly: false,page: 249 })
  assert.equal(last.items.at(-1).optionId,'option-9999')
  const review = pageAgreementCatalog(index,selected,{ query: '',selectedOnly: true,page: 249 })
  assert.equal(review.page,0)
  assert.deepEqual(review.items.map(item => item.optionId),['option-2','option-9999'])
  assert.equal(selected.size,2)
})

test('search matches names and categories with accents, case and multiple terms', () => {
  const index = indexAgreementCatalog([{ optionId:'cafe',label:'Café cabinetry',category:'Kitchen',priceCents:100 }])
  assert.equal(pageAgreementCatalog(index,new Set(),{ query:'  CAFE kitchen  ',selectedOnly:false,page:0 }).matchesCount,1)
  assert.equal(pageAgreementCatalog(index,new Set(),{ query:'cafe bath',selectedOnly:false,page:0 }).matchesCount,0)
})

test('option/package identity is distinct and filtering keeps the full selected count', () => {
  const index = indexAgreementCatalog([{ optionId:'same',label:'Option',category:null },{ packageId:'same',label:'Package',category:null }])
  const selected = new Set([agreementChoiceKey({ packageId:'same' })])
  const result = pageAgreementCatalog(index,selected,{ query:'Option',selectedOnly:false,page:0 })
  assert.equal(result.selectedCount,1)
  assert.equal(result.items.length,1)
  assert.notEqual(agreementChoiceKey({ optionId:'same' }),agreementChoiceKey({ packageId:'same' }))
  assert.equal(pageAgreementCatalog(index,selected,{ query:'Option',selectedOnly:true,page:0 }).matchesCount,0)
})

test('empty and shrinking results clamp navigation, and page size cannot disable the rendering bound', () => {
  const index = indexAgreementCatalog(items)
  const result = pageAgreementCatalog(index,new Set(),{ query:'missing',selectedOnly:false,page:249 })
  assert.equal(result.page,0); assert.equal(result.start,0); assert.equal(result.end,0)
  for (const pageSize of [0,101,Infinity,1.5]) assert.throws(() => pageAgreementCatalog(index,new Set(),{query:'',selectedOnly:false,page:0,pageSize}),/page size/)
})
