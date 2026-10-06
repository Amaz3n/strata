require('../scripts/register-ts-node-test')
const test = require('node:test')
const assert = require('node:assert/strict')
const { assertWaiverRecipientEmail, requiresWaiverCompanyMember, waiverRecipientConsent } = require('../lib/invoices/waiver-recipient')

test('external waiver recipients use their assigned email without company membership', () => {
  assert.equal(requiresWaiverCompanyMember('claimant'), true)
  for (const role of ['notary', 'witness']) {
    assert.equal(requiresWaiverCompanyMember(role), false)
    assert.doesNotMatch(waiverRecipientConsent(role), /for my company/)
  }
  assertWaiverRecipientEmail('Notary@example.test', ' notary@example.test ')
  assert.throws(() => assertWaiverRecipientEmail('claimant@example.test', 'notary@example.test'), /different email/)
  assert.throws(() => assertWaiverRecipientEmail(null, 'notary@example.test'), /different email/)
  assert.match(waiverRecipientConsent('claimant'), /for my company/)
})
