require('../scripts/register-ts-node-test')
const test = require('node:test'), assert = require('node:assert/strict'), Module = require('node:module')
let status, project, allowed, dealWriter, failure, checked, deskChecks
const client = { from(table) { const q = { select() { return q }, eq() { return q }, async maybeSingle() { return { data: table === 'projects' ? project : { id: 'deal', status }, error: failure } } }; return q } }
const original = Module._load
Module._load = function(name, ...args) { return ({
  'server-only': {}, '@/lib/services/context': {},
  '@/lib/supabase/server': { createServiceSupabaseClient: () => client },
  '@/lib/services/authorization': { requireAuthorization: async input => { checked.push(input); if (!allowed) throw Error('Forbidden') } },
  '@/lib/services/permissions': {
    requireAnyPermission: async keys => { deskChecks.push(keys); if (!dealWriter) throw Error('Forbidden') },
    hasAnyPermission: async () => dealWriter,
  },
})[name] ?? original.call(this, name, ...args) }
const { assertProspectWriteAccess, DEAL_WRITE_PERMISSIONS } = require('../lib/services/prospect-write-access')
Module._load = original
const context = { supabase: {}, orgId: 'org', userId: 'user' }
test.beforeEach(() => { status = 'new'; project = null; allowed = true; dealWriter = true; failure = null; checked = []; deskChecks = [] })
test('unlinked intake needs a deal-write key and hidden linked projects require manage access', async () => {
  await assertProspectWriteAccess(context, 'deal')
  assert.deepEqual(deskChecks[0], DEAL_WRITE_PERMISSIONS)
  dealWriter = false
  await assert.rejects(assertProspectWriteAccess(context, 'deal'), /Forbidden/)
  project = { id: 'hidden-project', phase: 'precon' }; allowed = false
  await assert.rejects(assertProspectWriteAccess(context, 'deal'), /Forbidden/)
  assert.equal(checked[0].projectId, 'hidden-project')
  assert.equal(checked[0].permission, 'project.manage')
})
test('closed and delivery deals reject ordinary edits and only lost deals reopen', async () => {
  for (const next of ['lost', 'won']) { status = next; await assert.rejects(assertProspectWriteAccess(context, 'deal')) }
  status = 'lost'; await assertProspectWriteAccess(context, 'deal', { reopen: true })
  status = 'new'; await assert.rejects(assertProspectWriteAccess(context, 'deal', { reopen: true }), /Only lost/)
  project = { id: 'project', phase: 'delivery' }; await assert.rejects(assertProspectWriteAccess(context, 'deal'), /delivery/)
})
test('lookup failures fail closed', async () => { failure = { message: 'Unavailable' }; await assert.rejects(assertProspectWriteAccess(context, 'deal'), /verify deal access/) })
