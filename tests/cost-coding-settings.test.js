require('../scripts/register-ts-node-test')
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
function load(file, modules) {
  const exports = {}
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  new Function('exports', 'require', code)(exports, name => {
    if (name in modules) return modules[name]
    throw Error(`Unstubbed dependency: ${name}`)
  })
  return exports
}
function harness({ permitted = true, reply, rpcError } = {}) {
  const calls = [], settings = { cost_codes_enabled: true, fiscal_calendar: 'original', billing: { approval: 'dual' } }
  const client = { rpc: async (name, args) => {
    calls.push(['rpc', name, args]); Object.assign(settings, args.p_patch)
    return { data: reply === undefined ? { ...settings } : reply, error: rpcError }
  } }
  const service = load('lib/services/cost-coding-settings.ts', {
    '@/lib/auth/context': { requireOrgMembership: async () => ({ orgId: 'org-a', user: { id: 'actor-a' }, supabase: 'actor-client' }) },
    '@/lib/supabase/server': { createServiceSupabaseClient: () => { calls.push(['client']); return client } },
    '@/lib/services/permissions': {
      requireAnyPermission: async (keys, context) => { calls.push(['guard', keys, context]); if (!permitted) throw Error('Forbidden') },
      getCurrentUserPermissions: async () => ({ permissions: permitted ? ['org.admin'] : ['org.member'] }),
    },
    '@/lib/financials/cost-codes-enabled': { getOrgCostCodesEnabled: async () => settings.cost_codes_enabled },
    '@/lib/services/orgs': { getOrgSettings: async () => ({ ...settings }) },
    '@/lib/services/audit': { recordAudit: async args => calls.push(['audit', args]) },
    '@/lib/services/events': { recordEvent: async args => calls.push(['event', args]) },
    '@/lib/validation/cost-coding-settings': require('../lib/validation/cost-coding-settings'),
  })
  return { service, calls, settings }
}
for (const input of ['false', 'true', 0, 1, null, undefined, {}, []]) test(`rejects nonboolean ${JSON.stringify(input)} before privileged client or mutation`, async () => {
  const h = harness(); await assert.rejects(h.service.updateCostCodesEnabled(input)); assert.deepEqual(h.calls, [])
})
test('direct service mutation requires current actor org admin before privileged access', async () => {
  const h = harness({ permitted: false }); await assert.rejects(h.service.updateCostCodesEnabled(false), /Forbidden/)
  assert.deepEqual(h.calls, [['guard', ['org.admin'], { orgId: 'org-a', userId: 'actor-a', supabase: 'actor-client' }]])
})
for (const enabled of [false, true]) test(`confirmed ${enabled} merges only the flag and audits the actual actor`, async () => {
  const h = harness(); assert.deepEqual(await h.service.updateCostCodesEnabled(enabled), { costCodesEnabled: enabled })
  assert.deepEqual(h.calls.find(c => c[0] === 'rpc'), ['rpc', 'merge_org_settings', { p_org_id: 'org-a', p_patch: { cost_codes_enabled: enabled }, p_delete_keys: [] }])
  assert.equal(h.settings.fiscal_calendar, 'original'); assert.deepEqual(h.settings.billing, { approval: 'dual' })
  const audit = h.calls.find(c => c[0] === 'audit')[1]; assert.equal(audit.actorId, 'actor-a'); assert.equal(audit.orgId, 'org-a'); assert.deepEqual(audit.after, { cost_codes_enabled: enabled })
})
for (const reply of [null, {}, [], { cost_codes_enabled: 'false' }, { cost_codes_enabled: true }]) test(`unverified response ${JSON.stringify(reply)} cannot report a confirmed save`, async () => {
  const h = harness({ reply }); await assert.rejects(h.service.updateCostCodesEnabled(false), /Reload settings/)
  assert.ok(!h.calls.some(c => ['audit', 'event'].includes(c[0])))
})
test('RPC error propagates without claiming success', async () => {
  const h = harness({ rpcError: { message: 'unavailable' } }); await assert.rejects(h.service.updateCostCodesEnabled(false), /unavailable/)
  assert.ok(!h.calls.some(c => c[0] === 'audit'))
})
test('member read is available with management permission accurately disclosed', async () => {
  const h = harness({ permitted: false }); assert.deepEqual(await h.service.getCostCodingSettings(), { costCodesEnabled: true, canManage: false }); assert.deepEqual(h.calls, [])
})
test('action returns failure and does not revalidate when service refuses save', async () => {
  const calls = []
  const action = load('app/(app)/settings/cost-coding/actions.ts', {
    'next/cache': { revalidatePath: path => calls.push(path) },
    '@/lib/action-result': { actionError: e => ({ success: false, error: e.message }) },
    '@/lib/services/cost-coding-settings': { updateCostCodesEnabled: async () => { throw Error('Forbidden') } },
  })
  assert.deepEqual(await action.updateCostCodesEnabledAction(false), { success: false, error: 'Forbidden' }); assert.deepEqual(calls, [])
})
for (const failed of [true, false]) test(`project override ${failed ? 'read failure is surfaced' : 'absence inherits org default'}`, async () => {
  const filters = []
  const query = { select() { return this }, eq(key, value) { filters.push([key, value]); return this }, maybeSingle: async () => ({ data: null, error: failed ? { message: 'policy unavailable' } : null }) }
  const service = load('lib/financials/cost-codes-enabled.ts', { '@/lib/services/orgs': { getOrgSettings: async () => ({ cost_codes_enabled: false }) } })
  const work = service.getProjectCostCodesEnabled({ from: () => query }, 'org-a', 'project-a')
  if (failed) await assert.rejects(work, /policy unavailable/)
  else assert.equal(await work, false)
  assert.deepEqual(filters, [['org_id', 'org-a'], ['project_id', 'project-a']])
})
