const test = require('node:test')
const assert = require('node:assert/strict')
const root = require('node:path').resolve(__dirname, '..')
require(root + '/scripts/register-ts-node-test')
const { mapStripeEventToDomain } = require(root + '/lib/integrations/payments/stripe')
function event(type, metadata = {}) {
 return {type, data:{object:{id:'pi_test',amount:1000,currency:'usd',metadata,payment_method_types:['amazon_pay','card','link']}}}
}
for(const type of ['payment_intent.succeeded','payment_intent.processing']) {
 test(`${type}: unrelated payments do not reach invoice recording`,()=>assert.equal(mapStripeEventToDomain(event(type)),null))
 test(`${type}: Arc invoice payments keep their attribution and chosen method`,()=>{
  const result=mapStripeEventToDomain(event(type,{org_id:'org',invoice_id:'invoice',payment_method_choice:'card'}))
  assert.equal(result.org_id,'org');assert.equal(result.invoice_id,'invoice');assert.equal(result.method,'card');assert.equal(result.amount_cents,1000)
 })
 test(`${type}: incomplete attribution is not silently discarded`,()=>assert.notEqual(mapStripeEventToDomain(event(type,{invoice_id:'invoice'})),null))
 test(`${type}: vendor payments remain outside receivables`,()=>assert.equal(mapStripeEventToDomain(event(type,{arc_product:'vendor_payments',org_id:'org'})),null))
}
