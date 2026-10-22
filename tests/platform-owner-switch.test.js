require('../scripts/register-ts-node-test')
const assert = require('node:assert/strict')
const test = require('node:test')
const { createFakeSupabase } = require('./support/fake-supabase')
const { stubModule, freshRequire } = require('./support/modules')

const OWNER = '00000000-0000-4000-8000-000000000001'
const ORG = '00000000-0000-4000-8000-000000000002'
const OTHER = '00000000-0000-4000-8000-000000000003'

function setup({ mode = 'role', grants = [], auditError = false } = {}) {
  delete process.env.SUPERADMIN_IDS
  delete process.env.SUPERADMIN_EMAILS
  if (mode === 'id') process.env.SUPERADMIN_IDS = OWNER
  if (mode === 'email') process.env.SUPERADMIN_EMAILS = 'owner@arc.test'
  const writes = []
  let refreshes = 0
  const db = createFakeSupabase({
    orgs: [{ id: ORG, name: 'First org' }, { id: OTHER, name: 'Second org' }],
    platform_memberships: [{ user_id: OWNER, status: 'active', expires_at: null,
      role: { key: mode === 'role' ? 'platform_super_admin' : 'platform_admin', permissions: [{ permission_key: 'platform.org.access' }] } }],
  })
  if (auditError) {
    const from = db.from.bind(db)
    db.from = (table) => {
      const query = from(table)
      if (table === 'authorization_audit_log') query.run = () => ({ data: null, error: { message: 'audit unavailable' } })
      return query
    }
  }
  stubModule('next/cache', { refresh: () => refreshes++ })
  stubModule('next/headers', { cookies: async () => ({ set: (value) => writes.push(value) }) })
  stubModule('@/lib/auth/context', { requireAuth: async () => ({ user: { id: OWNER, email: 'owner@arc.test' } }) })
  stubModule('@/lib/supabase/server', { createServiceSupabaseClient: () => db, createServerSupabaseClient: async () => db })
  stubModule('@/lib/services/orgs', { getOrgOnboardingState: async () => ({}) })
  stubModule('@/lib/services/platform-session', { listActivePlatformAccessGrants: async () => {
    if (mode !== 'staff') throw new Error('Owner must not need grants')
    return grants.map(orgId => ({ orgId }))
  } })
  freshRequire('lib/auth/platform.ts')
  freshRequire('lib/services/platform-access.ts')
  const actions = freshRequire('app/actions/orgs.ts')
  const route = freshRequire('app/api/orgs/route.ts')
  return { actions, route, db, writes, refreshes: () => refreshes }
}

test('configured and role-based owners can list and switch to every org without support grants', async () => {
  for (const mode of ['id', 'email', 'role']) {
    const h = setup({ mode })
    try {
      const payload = await (await h.route.GET()).json()
      assert.deepEqual(payload.orgs.map(org => org.org_id), [ORG, OTHER])
      await h.actions.switchOrgAction(OTHER)
      assert.equal(h.writes[0].name, 'org_id')
      assert.equal(h.writes[0].value, OTHER)
      assert.equal(h.refreshes(), 1)
      const audit = h.db.store.authorization_audit_log[0]
      assert.equal(audit.actor_user_id, OWNER)
      assert.equal(audit.org_id, OTHER)
      assert.equal(audit.reason_code, 'allow_superadmin')
    } finally {
      delete process.env.SUPERADMIN_IDS
      delete process.env.SUPERADMIN_EMAILS
    }
  }
})

test('staff see and switch only to orgs with current support access', async () => {
  const h = setup({ mode: 'staff', grants: [ORG] })
  const payload = await (await h.route.GET()).json()
  assert.deepEqual(payload.orgs.map(org => org.org_id), [ORG])
  await h.actions.switchOrgAction(ORG)
  assert.equal(h.writes[0].value, ORG)
  await assert.rejects(h.actions.switchOrgAction(OTHER), /with a reason first/)
  assert.equal(h.writes.length, 1)
})

test('owners cannot select nonexistent orgs or switch without recording access', async () => {
  const missing = setup()
  await assert.rejects(missing.actions.switchOrgAction(OWNER), /Organization not found/)
  assert.deepEqual(missing.writes, [])
  const failedAudit = setup({ auditError: true })
  await assert.rejects(failedAudit.actions.switchOrgAction(ORG), /audit unavailable/)
  assert.deepEqual(failedAudit.writes, [])
})
