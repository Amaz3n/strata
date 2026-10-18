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

test('parity fails on drift both ways, lists pending only when allowed, and excuses a ledger-only row only on its exact version and name', async () => {
  const { ledgerParity } = await load()
  const migrations = [
    { version: '20260801000000', name: 'exact', file: '20260801000000_exact.sql' },
    { version: '20260802000000', name: 'waiting', file: '20260802000000_waiting.sql' },
  ]
  const ledgerOnly = [{ version: '20260901000000', name: 'one_off_finalizer', livesIn: 'supabase/pending-migrations/one_off_finalizer.sql', why: 'test' }]
  const clean = ledgerParity({ migrations, ledger: [{ version: '20260801000000', name: 'exact' }, { version: '20260901000000', name: 'one_off_finalizer' }], allowPending: true, ledgerOnly })
  assert.deepEqual(clean, { problems: [], pending: ['20260802000000_waiting.sql'] })

  assert.deepEqual(ledgerParity({ migrations: migrations.slice(0, 1), ledger: [{ version: '20260801000000', name: 'exact' }], ledgerOnly }).problems, [])
  assert.equal(ledgerParity({ migrations, ledger: [{ version: '20260801000000', name: 'exact' }], ledgerOnly }).problems.length, 1)

  const restamped = ledgerParity({ migrations: migrations.slice(0, 1), ledger: [{ version: '20260801000000', name: 'exact' }, { version: '20261001000000', name: 'one_off_finalizer' }], ledgerOnly })
  assert.equal(restamped.problems.length, 2)
  const renamed = ledgerParity({ migrations: migrations.slice(0, 1), ledger: [{ version: '20260801000000', name: 'exact_renamed' }], ledgerOnly })
  assert.match(renamed.problems.join('\n'), /is "exact_renamed" but the repository records "exact"/)
})

test('every ledger-only row points at a repository file that exists, and none of them has a migration file of its own', async () => {
  const { existsSync } = require('node:fs')
  const { join } = require('node:path')
  const { LEDGER_ONLY_MIGRATIONS, repositoryMigrations } = await load()
  const root = join(__dirname, '..')
  const names = new Set(repositoryMigrations(join(root, 'supabase', 'migrations')).map((m) => m.name))
  for (const entry of LEDGER_ONLY_MIGRATIONS) {
    assert.ok(existsSync(join(root, entry.livesIn)), `${entry.name}: ${entry.livesIn} is missing`)
    assert.ok(!names.has(entry.name), `${entry.name} has a migration file, so it is not ledger-only`)
  }
})

test('every row of the reviewed repair map is a repository migration under that exact version and name', async () => {
  const { join } = require('node:path')
  const { readVerifiedApplied, repositoryMigrations } = await load()
  const root = join(__dirname, '..')
  const repo = new Map(repositoryMigrations(join(root, 'supabase', 'migrations')).map((m) => [m.version, m.name]))
  const strays = [...readVerifiedApplied(root)].filter(([version, name]) => repo.get(version) !== name)
  assert.deepEqual(strays, [])
})
