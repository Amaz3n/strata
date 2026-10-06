require('../scripts/register-ts-node-test')
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
const { createFakeSupabase } = require('./support/fake-supabase')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ORG = id(1), ACTOR = id(2), PROJECT = id(3), SCHEDULE = id(4), TEMPLATE = id(5), OTHER = id(6)
function load(file, modules) {
  const exports = {}
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  new Function('exports', 'require', code)(exports, name => {
    if (name in modules) return modules[name]
    if (name === 'zod') return require('zod')
    throw Error(`Unstubbed dependency: ${name}`)
  })
  return exports
}
function rateHarness({ settings = null, denied = false, scheduleStatus = 'active', settingsError } = {}) {
  const saves = [], guards = [], events = []
  const db = createFakeSupabase({ projects: [{ id: PROJECT, org_id: ORG, name: 'Original project' }], billing_rate_schedules: [{ id: SCHEDULE, org_id: ORG, status: scheduleStatus }], contracts: [{ id: id(7), org_id: ORG, project_id: PROJECT, status: 'active', contract_type: 'time_materials', title: 'Original contract', total_cents: 500000, currency: 'usd', snapshot: { preserved: 'original' } }] })
  const service = load('lib/services/billing-rate-schedules.ts', {
    '@/lib/financials/billing-model': require('../lib/financials/billing-model'),
    '@/lib/services/authorization': { requireAuthorization: async args => { guards.push(args); if (denied) throw Error('Forbidden') } },
    '@/lib/services/audit': { recordAudit: async () => {} },
    '@/lib/services/context': { requireOrgContext: async () => ({ orgId: ORG, userId: ACTOR, supabase: db }) },
    '@/lib/services/events': { recordEvent: async args => events.push(args) },
    '@/lib/services/project-financial-setup': {
      getProjectFinancialSettings: async args => { assert.equal(args.projectId, PROJECT); assert.equal(args.orgId, ORG); if (settingsError) throw settingsError; return settings },
      saveBillingContractWithAmendment: async args => { saves.push(args); return { contractId: id(7), action: 'amend', materialChanges: [] } },
    },
  })
  return { service, saves, guards, events }
}
test('unavailable financial settings prevent rate assignment and downstream publication', async () => {
  const failure = Error('settings query unavailable'), h = rateHarness({ settingsError: failure })
  await assert.rejects(h.service.assignBillingRateScheduleToProject({ projectId: PROJECT, rateScheduleId: SCHEDULE }), e => e === failure)
  assert.deepEqual(h.saves, []); assert.deepEqual(h.events, [])
})
test('genuinely absent settings retain original T&M contract defaults and canonical amendment', async () => {
  const h = rateHarness(); await h.service.assignBillingRateScheduleToProject({ projectId: PROJECT, rateScheduleId: SCHEDULE })
  assert.equal(h.saves.length, 1); const saved = h.saves[0]
  assert.equal(saved.existingSettings, null); assert.equal(saved.contractPayload.rate_schedule_id, SCHEDULE)
  assert.equal(saved.contractPayload.total_cents, 500000); assert.equal(saved.contractPayload.snapshot.preserved, 'original')
  assert.equal(saved.userId, ACTOR); assert.equal(saved.orgId, ORG)
  assert.equal(h.guards[0].permission, 'project.manage'); assert.equal(h.guards[0].projectId, PROJECT)
})
test('loaded financial requirements survive schedule assignment and removal', async () => {
  for (const rateScheduleId of [SCHEDULE, null]) {
    const settings = { billing_model: 'time_and_materials', client_cost_approval_required: true, open_book_required: false }
    const h = rateHarness({ settings }); await h.service.assignBillingRateScheduleToProject({ projectId: PROJECT, rateScheduleId })
    const saved = h.saves[0]; assert.equal(saved.existingSettings, settings)
    assert.equal(saved.contractPayload.requires_client_cost_approval, true); assert.equal(saved.contractPayload.open_book, false)
    assert.equal(saved.contractPayload.rate_schedule_id, rateScheduleId)
  }
})
for (const args of [{ denied: true }, { scheduleStatus: 'archived' }, { settings: { billing_model: 'fixed_price' } }]) test(`rate assignment refuses ${JSON.stringify(args)} before canonical save`, async () => {
  const h = rateHarness(args); await assert.rejects(h.service.assignBillingRateScheduleToProject({ projectId: PROJECT, rateScheduleId: SCHEDULE })); assert.deepEqual(h.saves, []); assert.deepEqual(h.events, [])
})
function templateHarness({ transportCap = 100, failAfter = null, missingBody = false } = {}) {
  const lines = Array.from({ length: 1700 }, (_, i) => ({ id: id(100 + i), org_id: ORG, budget_template_id: i < 900 ? TEMPLATE : OTHER, sort_order: 1700 - i, description: `Line ${i}`, amount_cents: i + 1, cost_code_id: null, quantity: null, unit_cost_cents: null }))
  lines.push({ id: id(2000), org_id: id(90), budget_template_id: TEMPLATE, sort_order: 0, amount_cents: 99999999 })
  lines.push({ id: id(2001), org_id: ORG, budget_template_id: id(91), sort_order: 0, amount_cents: 99999999 })
  const base = createFakeSupabase({ budget_templates: [TEMPLATE, OTHER].map((key, i) => ({ id: key, org_id: ORG, name: `Template ${i}`, is_active: true })), budget_template_lines: lines })
  const reads = [], db = { from: table => {
    const q = base.from(table)
    if (table === 'budget_template_lines') {
      const limit = q.limit.bind(q); q.limit = n => limit(Math.min(n, transportCap))
      const then = q.then.bind(q); q.then = (resolve, reject) => {
        reads.push(q); if (failAfter !== null && reads.length > failAfter) return Promise.resolve({ data: null, error: { message: 'later page unavailable' } }).then(resolve, reject)
        if (missingBody) return Promise.resolve({ data: null, error: null }).then(resolve, reject)
        return then(resolve, reject)
      }
    }
    return q
  } }
  const service = load('lib/services/budget-templates.ts', {
    '@/lib/land/paging': require('../lib/land/paging'),
    '@/lib/financials/plan-pricing': require('../lib/financials/plan-pricing'),
    '@/lib/services/audit': { recordAudit: async () => {} },
    '@/lib/services/authorization': { requireAuthorization: async () => {} },
    '@/lib/services/context': { requireOrgContext: async () => ({ orgId: ORG, userId: ACTOR, supabase: db }) },
    '@/lib/services/events': { recordEvent: async () => {} },
    '@/lib/services/permissions': { requirePermission: async () => {} },
    '@/lib/validation/budget-templates': {},
  })
  return { service, reads }
}
for (const cap of [100, 37]) test(`complete template totals traverse forced ${cap}-row pages without foreign or unselected lines`, async () => {
  const h = templateHarness({ transportCap: cap }), templates = await h.service.listBudgetTemplates()
  assert.deepEqual(templates.map(t => t.line_count), [900, 800])
  assert.equal(templates[0].total_cents, 900 * 901 / 2)
  assert.equal(templates[1].total_cents, (1700 * 1701 - 900 * 901) / 2)
  const ids = templates.flatMap(t => t.lines.map(line => line.id)); assert.equal(ids.length, 1700); assert.equal(new Set(ids).size, 1700)
  for (const t of templates) assert.ok(t.lines.every((line, i) => i === 0 || line.sort_order >= t.lines[i - 1].sort_order))
  assert.ok(h.reads.length > 17)
})
test('individual template detail stays bounded to its selected org/parent and complete', async () => {
  const h = templateHarness(); const detail = await h.service.getBudgetTemplate(TEMPLATE)
  assert.equal(detail.line_count, 900); assert.equal(detail.total_cents, 405450)
})
for (const args of [{ failAfter: 2 }, { missingBody: true }]) test(`partial template evidence ${JSON.stringify(args)} never becomes partial totals`, async () => {
  const h = templateHarness(args); await assert.rejects(h.service.listBudgetTemplates(), /Failed to load complete budget template lines/)
})
for (const error of [null, { message: 'query unavailable' }]) test(`estimate template ${error ? 'query error surfaces' : 'verified empty remains empty'}`, async () => {
  const filters = [], q = { select() { return this }, eq(key, value) { filters.push([key, value]); return this }, order() { return this }, limit() { return this }, then(resolve, reject) { return Promise.resolve({ data: [], error }).then(resolve, reject) } }
  const service = load('lib/services/estimate-templates.ts', { '@/lib/land/paging': require('../lib/land/paging'), '@/lib/services/permissions': { requirePermission: async () => {} }, '@/lib/services/context': { requireOrgContext: async () => ({ orgId: ORG, supabase: { from: () => q } }) } })
  if (error) await assert.rejects(service.listEstimateTemplates(), /query unavailable/)
  else assert.deepEqual(await service.listEstimateTemplates(), [])
  assert.deepEqual(filters, [['org_id', ORG]])
})
