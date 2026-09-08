require('../scripts/register-ts-node-test')
const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const originalLoad = Module._load
const calls = []
let permissions = ['org.member']
const track = (name, value = {}) => async () => { calls.push(name); return value }
Module._load = function (request, parent, main) {
  const stubs = {
    '@/lib/auth/context': { requireOrgMembership: async () => ({ orgId: 'org-one', membership: { role_key: 'org_member' } }) },
    '@/lib/services/context': { requireOrgContext: track('context') },
    '@/lib/services/users': { getCurrentUserProfile: track('profile', { id: 'user-one' }) },
    '@/lib/services/permissions': { getCurrentUserPermissions: async () => ({ permissions }) },
    '@/lib/services/stripe-connected-accounts': { getStripeConnectedAccount: track('stripe') },
    '@/lib/services/compliance': { getComplianceRules: track('rules'), getDefaultComplianceRequirements: track('requirements') },
    '@/lib/services/compliance-documents': { listComplianceDocumentTypes: track('document-types') },
    '@/lib/services/prequalification': { getPrequalificationTemplate: track('prequalification') },
    '@/lib/services/document-numbering': { getDocumentNumbering: track('numbering') },
    '@/lib/services/payment-rail-setup': { getPaymentRailSettings: track('payment-rails') },
    '@/lib/services/books/module': { getBooksModuleSettings: track('books') },
    '@/lib/services/team': { listOrganizationSigners: track('signers', []) },
    '@/app/(app)/settings/actions': {
      getBillingPageDataAction: track('billing', { billing: {} }),
      getOrganizationSettingsAction: track('organization'), getTeamSettingsDataAction: track('team'),
      getNotificationPreferencesAction: track('notifications'),
    },
  }
  if (stubs[request]) return stubs[request]
  return originalLoad.call(this, request, parent, main)
}
const { loadSettingsPanel } = require('../lib/services/settings-page')
test.after(() => { Module._load = originalLoad })
test.beforeEach(() => { calls.length = 0; permissions = ['org.member'] })

test('Profile never loads team, MFA or unrelated financial/compliance data', async () => {
  const result = await loadSettingsPanel('profile', 'org-one')
  assert.deepEqual(calls, ['profile'])
  assert.equal(result.roleLabel, 'Member')
})
test('Organization loads only its settings, numbering and lightweight signers', async () => {
  await loadSettingsPanel('organization', 'org-one')
  assert.deepEqual(calls.sort(), ['context', 'numbering', 'organization', 'signers'])
})
test('notification initial data starts on the server', async () => {
  await loadSettingsPanel('notifications', 'org-one')
  assert.deepEqual(calls, ['context', 'notifications'])
})
test('permission denial avoids querying privileged payment data', async () => {
  await assert.rejects(loadSettingsPanel('payments', 'org-one'), /access/)
  assert.deepEqual(calls, [])
  permissions = ['payment.release']
  await loadSettingsPanel('payments', 'org-one')
  assert.deepEqual(calls, ['context', 'payment-rails'])
})
test('an org switch refuses stale requests instead of returning another tenant', async () => {
  await assert.rejects(loadSettingsPanel('profile', 'org-two'), /Organization changed/)
  assert.deepEqual(calls, [])
})
