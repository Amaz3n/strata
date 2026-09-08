require('../scripts/register-ts-node-test')
const test = require('node:test')
const assert = require('node:assert/strict')
const { assertAccountingProviderContract } = require('../lib/integrations/accounting/provider-contract')
const operations = {
  supportsCDC: ['ingestChanges'], supportsImport: ['previewImport', 'applyImport'],
  supportsVendorCredits: ['pushVendorCredit'], supportsBillPaymentVoid: ['voidBillPayment'],
  supportsJournalEntryPush: ['pushJournalEntry'], supportsAttachments: ['uploadInvoiceAttachment'],
}
test('minimal future provider can advertise only implemented capabilities', () => {
  assert.doesNotThrow(() => assertAccountingProviderContract({ key: 'synthetic', capabilities: {} }))
})
for (const [capability, methods] of Object.entries(operations)) test(`${capability} fails registration until every promised operation exists`, () => {
  const provider = { key: 'synthetic', capabilities: { [capability]: true } }
  for (const method of methods) {
    assert.throws(() => assertAccountingProviderContract(provider), /advertises accounting capability/)
    provider[method] = async () => ({})
  }
  assert.doesNotThrow(() => assertAccountingProviderContract(provider))
})
