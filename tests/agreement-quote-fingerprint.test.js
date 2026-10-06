require('../scripts/register-ts-node-test')
const assert = require('node:assert/strict')
const test = require('node:test')
const { agreementQuoteFingerprint } = require('../lib/sales/agreement-quote')
test('quote fingerprint ignores object/choice read order but retains duplicates', () => {
  const a = { totalCents: 300, choices: [{ id:'a',priceCents:100 },{ id:'b',priceCents:200 }] }
  const b = { choices: [{ priceCents:200,id:'b' },{priceCents:100,id:'a'}], totalCents:300 }
  assert.equal(agreementQuoteFingerprint(a),agreementQuoteFingerprint(b))
  assert.notEqual(agreementQuoteFingerprint(a),agreementQuoteFingerprint({...a,choices:[...a.choices,a.choices[0]]}))
})
test('same-total price redistribution, identities, configuration and labels require new review', () => {
  const quote = { lotId:'lot',versionId:'version',swing:'left',planLabel:'Oak',totalCents:300,choices:[{id:'a',priceCents:100},{id:'b',priceCents:200}] }
  for(const patch of [{swing:'right'},{versionId:'other'},{lotId:'other'},{planLabel:'Revised'},{choices:[{id:'a',priceCents:150},{id:'b',priceCents:150}]}]) assert.notEqual(agreementQuoteFingerprint(quote),agreementQuoteFingerprint({...quote,...patch}))
})
