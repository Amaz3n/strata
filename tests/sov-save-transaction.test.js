const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

// Run with ARC_PGLITE_MODULE pointing to an isolated installation; never a live DB.
const runtime = process.env.ARC_PGLITE_MODULE

test('SOV save transaction, stale revision and tenant safeguards', { skip: !runtime }, async (t) => {
  const { PGlite } = require(runtime)
  const db = new PGlite()
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create function auth.jwt() returns jsonb language sql as $$ select jsonb_build_object('role', coalesce(current_setting('test.role', true), 'service_role')) $$;
      create function public.has_org_permission(uuid, text) returns boolean language sql as $$ select false $$;
      create table orgs(id uuid primary key);
      create table projects(id uuid primary key);
      create function public.is_org_member(uuid) returns boolean language sql as $$ select true $$;
      create table contracts(id uuid primary key, org_id uuid, project_id uuid);
      create table budgets(id uuid primary key, org_id uuid, project_id uuid);
      create table budget_lines(id uuid primary key, org_id uuid, budget_id uuid);
      create table cost_codes(id uuid primary key, org_id uuid);
      create table prime_sov_lines(id uuid primary key default gen_random_uuid(), org_id uuid, project_id uuid, contract_id uuid,
        description text, cost_code_id uuid, budget_line_id uuid, scheduled_value_cents bigint,
        previous_billed_cents bigint default 0, stored_materials_cents bigint default 0, retainage_held_cents bigint default 0,
        retainage_percent_override numeric check (retainage_percent_override between 0 and 100),
        line_number integer, sort_order integer, unique(contract_id, line_number));
      create table pay_applications(id uuid primary key, contract_id uuid, org_id uuid, status text);
      create table pay_application_lines(id uuid primary key, prime_sov_line_id uuid references prime_sov_lines(id) on delete cascade);
    `)
    await db.exec(fs.readFileSync(path.join(__dirname, '../supabase/migrations/20260905004354_commercial_sov_atomic_save.sql'), 'utf8'))
    await db.exec(fs.readFileSync(path.join(__dirname, '../supabase/migrations/20260905005511_prime_sov_budget_links.sql'), 'utf8'))
    const org = randomUUID(), project = randomUUID(), contract = randomUUID()
    await db.query('insert into orgs values ($1)', [org])
    await db.query('insert into projects values ($1)', [project])
    await db.query('insert into contracts(id,org_id,project_id) values ($1,$2,$3)', [contract, org, project])
    const revision = async () => Number((await db.query('select sov_revision from contracts where id=$1', [contract])).rows[0].sov_revision)
    const save = (rev, rows) => db.query('select save_prime_sov_lines($1,$2,$3,$4,$5::jsonb)', [org, project, contract, rev, JSON.stringify(rows)])
    const first = { id: randomUUID(), description: 'Foundations', scheduled_value_cents: 10000 }
    const second = { id: randomUUID(), description: 'Structure', scheduled_value_cents: 20000 }
    // New rows have no IDs. IDs supplied by a client must already belong to the contract.
    await t.test('rejects foreign/new IDs rather than upserting arbitrary objects', async () => {
      await assert.rejects(save(0, [first]), /does not belong/)
      assert.equal(await revision(), 0)
    })
    await save(0, [{ description: first.description, scheduled_value_cents: first.scheduled_value_cents },
      { description: second.description, scheduled_value_cents: second.scheduled_value_cents }])
    const stored = (await db.query('select * from prime_sov_lines order by line_number')).rows
    first.id = stored[0].id; second.id = stored[1].id
    await t.test('rejects stale editor without any writes', async () => {
      await assert.rejects(save(0, [first, second]), /changed/)
      assert.equal(await revision(), 2)
    })
    await t.test('rolls back deletions, parking and updates if a later row fails', async () => {
      const before = await revision()
      await assert.rejects(save(before, [{ ...first, description: 'Changed' }, { ...second, retainage_percent_override: 101 }]), /check constraint/)
      const rows = (await db.query('select * from prime_sov_lines order by line_number')).rows
      assert.equal(rows[0].description, 'Foundations')
      assert.deepEqual(rows.map(row => row.line_number), [1, 2])
      assert.equal(await revision(), before)
    })
    await t.test('reorders atomically and increments revision', async () => {
      await save(await revision(), [second, first])
      assert.deepEqual((await db.query('select description from prime_sov_lines order by line_number')).rows.map(row => row.description), ['Structure', 'Foundations'])
    })
    await t.test('preserves multiple cost links without changing contractual values', async () => {
      const budget = randomUUID(), a = randomUUID(), b = randomUUID()
      await db.query('insert into budgets values ($1,$2,$3)', [budget, org, project])
      await db.query('insert into budget_lines values ($1,$3,$4),($2,$3,$4)', [a,b,org,budget])
      await save(await revision(), [{ ...first, budget_line_ids: [a,b,a] }, second])
      assert.equal((await db.query('select * from prime_sov_budget_links where prime_sov_line_id=$1',[first.id])).rows.length, 2)
      await save(await revision(), [first, second])
      assert.equal((await db.query('select * from prime_sov_budget_links where prime_sov_line_id=$1',[first.id])).rows.length, 2)
      assert.equal(Number((await db.query('select scheduled_value_cents from prime_sov_lines where id=$1',[first.id])).rows[0].scheduled_value_cents),10000)
      const before = await revision()
      await assert.rejects(save(before, [{ ...first, budget_line_ids: [a,randomUUID()] },second]), /Budget line/)
      assert.equal(await revision(),before)
      await save(await revision(), [{ ...first, budget_line_ids: [] },second])
      assert.equal((await db.query('select * from prime_sov_budget_links where prime_sov_line_id=$1',[first.id])).rows.length, 0)
    })
    await t.test('blocks edits against an open application', async () => {
      const app = randomUUID()
      await db.query('insert into pay_applications values ($1,$2,$3,$4)', [app, contract, org, 'draft'])
      await assert.rejects(save(await revision(), [first, second]), /open pay application/)
      await db.query('delete from pay_applications where id=$1', [app])
    })
    await t.test('preserves historically referenced rows even when rollups are zero', async () => {
      await db.query('insert into pay_application_lines values ($1,$2)', [randomUUID(), first.id])
      await assert.rejects(save(await revision(), [second]), /references a removed line/)
    })
    await t.test('validates budget ownership and rejects unauthorized callers', async () => {
      await assert.rejects(save(await revision(), [{ ...first, budget_line_id: randomUUID() }, second]), /Budget line/)
      await db.exec("set test.role = 'authenticated'")
      await assert.rejects(save(await revision(), [first, second]), /Insufficient permission/)
    })
  } finally { await db.close() }
})
