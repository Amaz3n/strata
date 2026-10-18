const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const root = require('node:path').resolve(__dirname, '..')
const ts = require(root + '/node_modules/typescript')
function setup({ existing = false, writeError = null } = {}) {
  const writes = []; let entitlements = 0
  const db = { from() {
    const q = { select: () => q, eq: () => q, is: () => q, order: () => q, limit: () => q,
      maybeSingle: async () => ({ data: existing ? { id: 'local' } : null }),
      update: (payload) => { writes.push(payload); return { eq: async () => ({ error: writeError }) } },
      upsert: async (payload) => { writes.push(payload); return { error: writeError } } }
    return q
  } }
  const mocks = {
    '@/lib/supabase/server': { createServiceSupabaseClient: () => db },
    '@/lib/services/audit': { recordAudit: async () => {} },
    '@/lib/services/billing': { syncOrgEntitlementsFromPlan: async () => { entitlements++ } },
  }
  const source = ts.transpileModule(fs.readFileSync(root + '/lib/services/subscriptions.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', source)((name) => mocks[name] || {}, mod, mod.exports)
  return { run: mod.exports.upsertSubscriptionFromStripe, writes, entitlements: () => entitlements }
}
function subscription(period = {}) {
  return { id: 'sub_test', customer: 'cus_test', status: 'active', metadata: { org_id: 'org', plan_code: 'founders' },
    items: { data: [{ price: { id: 'price' }, ...period }] } }
}
for (const existing of [false, true]) test(`item-level period survives ${existing ? 'update' : 'insert'}`, async () => {
  const s = setup({ existing })
  await s.run(subscription({ current_period_start: 1790107853, current_period_end: 1792699853 }))
  assert.equal(s.writes[0].current_period_start, new Date(1790107853000).toISOString())
  assert.equal(s.writes[0].current_period_end, new Date(1792699853000).toISOString())
  assert.equal(s.entitlements(), 1)
})
test('legacy subscription-level periods remain supported', async () => {
  const s = setup()
  await s.run({ ...subscription(), current_period_start: 1790107853, current_period_end: 1792699853 })
  assert.equal(s.writes[0].current_period_start, new Date(1790107853000).toISOString())
})
test('missing periods fail before mutation', async () => {
  const s = setup()
  await assert.rejects(s.run(subscription()), /no valid billing period/)
  assert.equal(s.writes.length, 0)
})
for (const existing of [false, true]) test(`failed ${existing ? 'update' : 'insert'} propagates to webhook retry handling`, async () => {
  const s = setup({ existing, writeError: { message: 'database unavailable' } })
  await assert.rejects(s.run(subscription({ current_period_start: 1790107853, current_period_end: 1792699853 })), /Failed to upsert subscription/)
  assert.equal(s.entitlements(), 0)
})
