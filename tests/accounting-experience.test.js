require('../scripts/register-ts-node-test')
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { accountingExperience } = require('../lib/financials/accounting-experience')
const external = { provider: 'qbo', label: 'QuickBooks Online', healthy: true }

test('native ledger does not offer an external push even with a retained mapping', () => {
  const policy = accountingExperience({ ledger: 'official', external })
  assert.equal(policy.showBooks, true)
  assert.equal(policy.showExternalSync, false)
  assert.equal(policy.canRequestExternalSync, false)
  assert.equal(policy.recordPayment, 'Receive payment')
})
test('native outbound mirror is observable but does not become a manual sync workflow', () => {
  const policy = accountingExperience({ ledger: 'official', external, externalSyncPosture: 'outbound_mirror' })
  assert.equal(policy.showExternalSync, true)
  assert.equal(policy.canRequestExternalSync, false)
})
test('preview and parallel modes keep external authority and expose both evidence sets', () => {
  for (const ledger of ['shadow', 'parallel']) {
    const policy = accountingExperience({ ledger, external })
    assert.equal(policy.official, false)
    assert.equal(policy.showBooks, true)
    assert.equal(policy.canRequestExternalSync, true)
  }
})
test('unavailable, disconnected, and unhealthy accounting never offers a push', () => {
  for (const mode of [
    { ledger: 'unavailable', external: null },
    { ledger: 'none', external: null },
    { ledger: 'external', external, externalSyncPosture: 'disconnected' },
    { ledger: 'external', external: { ...external, healthy: false } },
  ]) assert.equal(accountingExperience(mode).canRequestExternalSync, false)
  assert.match(accountingExperience({ ledger: 'unavailable', external: null }).description, /could not be verified/)
})

test('expense coding keeps Arc Books accounts in their own validated namespace', () => {
  const actions = fs.readFileSync(path.join(__dirname, '../app/(app)/projects/[id]/expenses/actions.ts'), 'utf8')
  const service = fs.readFileSync(path.join(__dirname, '../lib/services/cost-plus.ts'), 'utf8')
  const workspace = fs.readFileSync(path.join(__dirname, '../components/expenses/expense-workspace.tsx'), 'utf8')
  assert.match(actions, /from\("gl_accounts"\).*select\("id, code, name"\)/s)
  assert.match(actions, /eq\("account_type", "cogs"\)/)
  assert.match(service, /arc_books_gl_account_id/)
  assert.match(service, /Arc Books cost account not found/)
  assert.match(workspace, /This override is stored in the Arc ledger namespace/)
  assert.doesNotMatch(workspace, /qboExpenseAccountId: line\.arcBooksAccountId/)
})

test('invoice coding adapts between Arc Books and an external provider', () => {
  const actions = fs.readFileSync(path.join(__dirname, '../app/(app)/invoices/actions.ts'), 'utf8')
  const service = fs.readFileSync(path.join(__dirname, '../lib/services/invoices.ts'), 'utf8')
  const editor = fs.readFileSync(path.join(__dirname, '../components/invoices/invoice-document-editor.tsx'), 'utf8')
  assert.match(actions, /nativeBooks[\s\S]*from\("gl_accounts"\)[\s\S]*eq\("account_type", "income"\)/)
  assert.match(actions, /accountingProvider: nativeBooks \? "arc_books"/)
  assert.match(editor, /arc_books_gl_account_id: nativeBooks/)
  assert.match(editor, /qbo_income_account_id: nativeBooks \? undefined/)
  assert.match(service, /Choose an active Arc Books income account/)
  assert.match(service, /arc_books_gl_account_id: line\.arc_books_gl_account_id/)
})
