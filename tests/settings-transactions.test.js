const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const runtime = process.env.ARC_PGLITE_MODULE

test('settings saves are atomic and MFA lookup is org-scoped', { skip: !runtime }, async (t) => {
  const { PGlite } = require(runtime)
  const db = new PGlite()
  const org = randomUUID(), otherOrg = randomUUID(), actor = randomUUID(), otherUser = randomUUID()
  const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20260907214341_settings_atomic_save_and_team_mfa.sql'), 'utf8')
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create table auth.mfa_factors(user_id uuid, status text);
      create table public.orgs(id uuid primary key, name text, billing_email text, address jsonb, logo_url text, updated_at timestamptz);
      create table public.org_settings(org_id uuid primary key references orgs(id), settings jsonb not null, updated_at timestamptz);
      create table public.memberships(org_id uuid, user_id uuid, status text);
      create table public.audit_log(org_id uuid, actor_user_id uuid, action text, entity_type text, entity_id uuid, before_data jsonb, after_data jsonb, source text);
      create table public.events(org_id uuid, event_type text, entity_type text, entity_id uuid, payload jsonb, channel text);
    `)
    await db.query('insert into orgs(id,name,billing_email) values ($1,$2,$3),($4,$5,$6)', [org, 'One', 'old@example.com', otherOrg, 'Two', 'other@example.com'])
    await db.query('insert into org_settings(org_id,settings) values ($1,$2),($3,$4)', [org, { invoice_default_note: 'Legacy note', invoice_default_payment_details: null, unrelated: 42 }, otherOrg, { invoice_default_note: 'Old', invoice_default_payment_details: '' }])
    await db.query('insert into memberships values ($1,$2,$3),($4,$5,$3)', [org, actor, 'active', otherOrg, otherUser])
    await db.query('insert into auth.mfa_factors values ($1,$2),($3,$4)', [actor, 'verified', otherUser, 'unverified'])
    await db.exec(migration)
    const save = (orgPatch, settingsPatch, section = 'invoicing') => db.query('select save_organization_settings($1,$2,$3,$4::jsonb,$5::jsonb) result', [org, actor, section, orgPatch, settingsPatch])
    await t.test('backfill preserves effective legacy values and explicit empty notes', async () => {
      const rows = (await db.query('select org_id,settings from org_settings')).rows
      assert.equal(rows.find(r => r.org_id === org).settings.invoice_default_payment_details, 'Legacy note')
      assert.equal(rows.find(r => r.org_id === otherOrg).settings.invoice_default_payment_details, '')
      assert.ok(rows.every(r => !('invoice_default_note' in r.settings)))
    })
    await t.test('canonical response and audit/event commit together; clear stays cleared', async () => {
      const result = (await save({ billing_email: 'new@example.com', address: { formatted: 'Main St' } }, { invoice_default_payment_terms_days: 30, invoice_default_payment_details: '' })).rows[0].result
      assert.equal(result.org.billing_email, 'new@example.com')
      assert.equal(result.settings.invoice_default_payment_details, '')
      assert.equal(result.settings.unrelated, 42)
      const audit = (await db.query('select * from audit_log')).rows[0]
      assert.equal(audit.before_data.org.billing_email, 'old@example.com')
      assert.equal(audit.after_data.org.billing_email, 'new@example.com')
      assert.equal((await db.query('select * from events')).rows[0].payload.actor_id, actor)
    })
    await t.test('a downstream event failure rolls back header, settings and audit', async () => {
      await db.exec("alter table events add constraint reject_settings check (event_type <> 'settings_updated') not valid")
      const before = (await db.query('select * from org_settings where org_id=$1', [org])).rows
      await assert.rejects(save({ billing_email: 'partial@example.com' }, { invoice_default_payment_details: 'must roll back' }))
      assert.equal((await db.query('select billing_email from orgs where id=$1', [org])).rows[0].billing_email, 'new@example.com')
      assert.deepEqual((await db.query('select * from org_settings where org_id=$1', [org])).rows, before)
      assert.equal((await db.query('select count(*) from audit_log')).rows[0].count, 1)
      await db.exec('alter table events drop constraint reject_settings')
    })
    await t.test('rejects unrelated keys and cross-org signers', async () => {
      await assert.rejects(save({ status: 'disabled' }, {}), /Unexpected settings fields/)
      await assert.rejects(save({}, { unrelated: 'clobber' }), /Unexpected settings fields/)
      await assert.rejects(save({}, { estimate_builder_signer_mode: 'specific_user', estimate_builder_signer_user_id: otherUser }, 'organization'), /active organization member/)
    })
    await t.test('MFA returns only requested org members, with actual verified status', async () => {
      const rows = (await db.query('select * from get_org_member_mfa_status($1,$2)', [org, [actor, otherUser]])).rows
      assert.deepEqual(rows, [{ user_id: actor, enabled: true }])
      await db.query("update auth.mfa_factors set status='unverified' where user_id=$1", [actor])
      assert.equal((await db.query('select * from get_org_member_mfa_status($1,$2)', [org, [actor]])).rows[0].enabled, false)
    })
    await t.test('browser database roles cannot call either privileged RPC', async () => {
      for (const role of ['anon', 'authenticated']) {
        const { rows } = await db.query("select has_function_privilege($1,'public.save_organization_settings(uuid,uuid,text,jsonb,jsonb)','EXECUTE') as save, has_function_privilege($1,'public.get_org_member_mfa_status(uuid,uuid[])','EXECUTE') as mfa", [role])
        assert.deepEqual(rows[0], { save: false, mfa: false })
      }
    })
  } finally { await db.close() }
})
