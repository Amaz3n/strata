require('../scripts/register-ts-node-test')
const assert = require('node:assert/strict')
const test = require('node:test')
const { agreementQuoteFingerprint } = require('../lib/sales/agreement-quote')
const { composePurchaseAgreementPricing } = require('../lib/financials/purchase-agreement-pricing')
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
test("a home's own price line is part of the reviewed quote", () => {
  const priced = (amountCents, kind = 'home_incentive') => agreementQuoteFingerprint(composePurchaseAgreementPricing({ basePriceCents: 300_000_00, lotPremiumCents: 0,
    homeAdjustments: [{ kind, sourceId: 'source', label: 'Home incentive', amountCents }] }))
  assert.notEqual(priced(-5_000_00), priced(-6_000_00))
  assert.notEqual(priced(-5_000_00), priced(-5_000_00, 'disposition'))
  assert.notEqual(priced(-5_000_00), agreementQuoteFingerprint(composePurchaseAgreementPricing({ basePriceCents: 300_000_00, lotPremiumCents: 0 })))
})
