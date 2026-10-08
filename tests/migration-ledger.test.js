const test = require('node:test')
const assert = require('node:assert/strict')

const load = () => import('../scripts/migration-ledger.mjs')

test('a migration is applied by version, by MCP-stamped stem, by name under another version, or by object verification; the rest is the deploy', async () => {
  const { classifyMigrations } = await load()
  const migrations = [
    { version: '20260801000000', name: 'exact', file: '20260801000000_exact.sql' },
    { version: '20260802000000', name: 'stamped', file: '20260802000000_stamped.sql' },
    { version: '20260803000000', name: 'renamed_version', file: '20260803000000_renamed_version.sql' },
    { version: '20260804000000', name: 'object_checked', file: '20260804000000_object_checked.sql' },
    { version: '20260805000000', name: 'never_applied', file: '20260805000000_never_applied.sql' },
  ]
  const ledger = [
    { version: '20260801000000', name: 'exact' },
    { version: '20261006022553', name: '20260802000000_stamped' },
    { version: '20260901010101', name: 'renamed_version' },
  ]
  const result = classifyMigrations({ migrations, ledger, verified: new Map([['20260804000000', 'object_checked']]) })
  assert.deepEqual(result.exact.map((m) => m.name), ['exact'])
  assert.deepEqual(result.underOtherVersion.map((m) => [m.name, m.ledgerVersion]), [['stamped', '20261006022553'], ['renamed_version', '20260901010101']])
  assert.deepEqual(result.verifiedApplied.map((m) => m.name), ['object_checked'])
  assert.deepEqual(result.pending.map((m) => m.file), ['20260805000000_never_applied.sql'])
})

test('an object-verified entry counts only for the same version and name', async () => {
  const { classifyMigrations } = await load()
  const migrations = [{ version: '20260804000000', name: 'object_checked', file: '20260804000000_object_checked.sql' }]
  assert.equal(classifyMigrations({ migrations, ledger: [], verified: new Map([['20260804000000', 'something_else']]) }).pending.length, 1)
})

test('the ledger reads as JSON or as one version and name per line, and the repair map as its value rows', async () => {
  const { parseLedger, verifiedApplied } = await load()
  assert.deepEqual(parseLedger('20260801000000 exact\n\n20261006022553 20260802000000_stamped\n'), [
    { version: '20260801000000', name: 'exact' }, { version: '20261006022553', name: '20260802000000_stamped' }])
  assert.deepEqual(parseLedger('[{"version":"20260801000000","name":"exact"}]'), [{ version: '20260801000000', name: 'exact' }])
  assert.deepEqual([...verifiedApplied("values\n  ('20260517092101', 'remote_schema'),\n  ('20260519010000', 'fix_rls');\n")], [['20260517092101', 'remote_schema'], ['20260519010000', 'fix_rls']])
})
