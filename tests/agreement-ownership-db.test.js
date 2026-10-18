const assert = require('node:assert/strict')
const fs = require('node:fs')
const test = require('node:test')
const { PGlite } = require('@electric-sql/pglite')
const migration = fs.readFileSync(require.resolve('../supabase/migrations/20261003221905_purchase_agreement_open_home_unique.sql'),'utf8')
async function database(t) {
  const db = new PGlite(); t.after(() => db.close())
  await db.exec('create table contracts(id integer primary key, org_id text not null, project_id text, contract_type text, status text);')
  return db
}
test('only one open purchase agreement owns each organization/home across insert and status changes', async t => {
  const db = await database(t); await db.exec(migration)
  await db.exec("insert into contracts values(1,'org','home','purchase_agreement','draft')")
  await assert.rejects(db.exec("insert into contracts values(2,'org','home','purchase_agreement','active')"), /contracts_open_purchase_agreement_home_unique/)
  await db.exec("insert into contracts values(3,'other','home','purchase_agreement','draft'),(4,'org','other-home','purchase_agreement','draft'),(5,'org','home','other','active'),(6,'org','home','purchase_agreement','void')")
  await assert.rejects(db.exec("update contracts set status='draft' where id=6"), /contracts_open_purchase_agreement_home_unique/)
  await db.exec("update contracts set status='void' where id=1; update contracts set status='draft' where id=6")
  assert.equal((await db.query("select count(*)::int n from contracts where org_id='org' and project_id='home' and contract_type='purchase_agreement' and status in ('draft','active')")).rows[0].n,1)
})
test('legacy duplicates stop migration without choosing a winner or deleting contracts', async t => {
  const db = await database(t)
  await db.exec("insert into contracts values(1,'org','home','purchase_agreement','draft'),(2,'org','home','purchase_agreement','active')")
  await assert.rejects(db.exec(migration), /Reconcile homes/)
  await db.exec('rollback')
  assert.equal((await db.query('select count(*)::int n from contracts')).rows[0].n,2)
  assert.equal((await db.query("select count(*)::int n from pg_indexes where indexname='contracts_open_purchase_agreement_home_unique'")).rows[0].n,0)
})
