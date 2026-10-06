require('../scripts/register-ts-node-test')
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
const { createFakeSupabase } = require('./support/fake-supabase')
const ORG = '00000000-0000-4000-8000-000000000001', ACTOR = '00000000-0000-4000-8000-000000000002', HOME = '00000000-0000-4000-8000-000000000003', BUYER = '00000000-0000-4000-8000-000000000004'
const NOW = '2026-10-05T12:00:00.000Z'
function load(file, overrides = {}) {
  const source = fs.readFileSync(file, 'utf8'), modules = { react: require('react'), zod: require('zod'), crypto: require('node:crypto') }
  for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
    const name = match[1]
    if (/^@\/lib\/(financials\/|product-tier$|receivables\/)/.test(name)) modules[name] = require('../' + name.slice(2))
    else if (!(name in modules)) modules[name] = {}
  }
  Object.assign(modules, overrides)
  const exports = {}
  new Function('exports', 'require', ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)(exports, name => {
    if (name in modules) return modules[name]
    throw Error('Unstubbed dependency: ' + name)
  })
  return exports
}
function fixture(tier = 'production', propertyType = 'production') {
  const db = createFakeSupabase({ projects: [{ id: HOME, org_id: ORG, property_type: propertyType }], contracts: [], project_financial_settings: [], accounting_entity_map: [{ id: 'default', org_id: ORG, project_id: null, community_id: null, division_id: null, connection_id: 'connection' }], orgs: [{ id: ORG, name: 'Builder', email: 'billing@example.test', phone: '555', address: { line1: 'Model home' } }], contacts: [{ id: BUYER, org_id: ORG }], invoices: [] })
  const guards = [], audits = [], events = [], commits = [], jobs = [], after = []
  const context = { supabase: db, orgId: ORG, userId: ACTOR, productTier: tier }
  const common = {
    '@/lib/services/context': { requireOrgContext: async () => context },
    '@/lib/services/audit': { recordAudit: async input => audits.push(input) },
    '@/lib/services/events': { recordEvent: async input => events.push(input) },
    '@/lib/services/permissions': { requirePermission: async (...args) => guards.push(args) },
    '@/lib/financials/cost-codes-enabled': { getOrgCostCodesEnabled: async () => true, resolveCostCodesEnabled: (project, org) => project ?? org },
  }
  const financial = load('lib/services/project-financial-setup.ts', common)
  const projects = load('lib/services/projects.ts', { ...common, '@/lib/services/project-financial-setup': financial })
  const invoices = load('lib/services/invoices.ts', { ...common,
    'next/server': { after: fn => after.push(fn) },
    '@/lib/services/authorization': { requireAuthorization: async args => guards.push(args) },
    '@/lib/supabase/server': { createServiceSupabaseClient: () => ({ rpc: async (name, args) => {
      commits.push({ name, args })
      const invoice = { id: 'invoice-1', ...args.p_invoice, invoice_lines: args.p_lines }
      db.store.invoices.push(invoice)
      return { data: { invoice, lines: args.p_lines }, error: null }
    } }) },
    '@/lib/services/outbox': { enqueueOutboxJob: async input => { jobs.push(input); return { enqueued: true, id: 'job-1' } } },
    '@/lib/services/accounting-sync-state': { getAccountingSyncState: async () => null },
    '@/lib/services/books/authority': { resolveLedgerAuthority: async () => 'arc' },
  })
  return { projects, financial, invoices, db, context, guards, audits, events, commits, jobs, after }
}
function homePreparation(h, input = {}) {
  return h.projects.prepareProjectCreation({ input: { name: 'Lot 47', ...input }, orgId: ORG, userId: ACTOR, productTier: h.context.productTier })
}
function depositInput(cents = 500001) {
  return { project_id: HOME, invoice_number: 'DEP-original', title: 'Earnest deposit', issue: true, issue_date: '2026-10-05', due_date: '2026-10-05', tax_rate: 0, customer_id: BUYER, lines: [{ description: 'Earnest deposit', quantity: 1, unit: 'deposit', unit_cost: cents / 100, taxable: false }], metadata: { invoice_kind: 'earnest_deposit', source_reservation_id: 'original-hold' } }
}
for (const [tier, property, expectedRetainage] of [['commercial', 'production', 0], ['production', 'commercial', 10], ['residential', 'production', 0]]) test(`project preparation follows actual ${property} posture in ${tier} org`, () => {
  const h = fixture(tier), p = homePreparation(h, { property_type: property, status: 'planning', client_id: BUYER, prospect_id: BUYER, address: '47 Main', total_value: 100.6 })
  assert.equal(p.project.property_type, property); assert.equal(p.project.retainage_percent, expectedRetainage)
  assert.equal(p.project.phase, 'delivery'); assert.equal(p.project.status, 'planning'); assert.equal(p.project.total_value, 101)
  assert.deepEqual(p.project.location, { address: '47 Main' }); assert.equal(p.project.created_by, ACTOR)
  assert.equal(h.db.store.projects.length, 1); assert.equal(h.audits.length, 0)
})
test('new production home keeps its unpriced billing contract, setup and inherited cost coding', async () => {
  const h = fixture('commercial'), p = homePreparation(h, { property_type: 'production', status: 'planning', client_id: BUYER })
  const billing = h.projects.prepareProjectBillingContract({ input: p.input, orgId: ORG, projectId: HOME, projectName: p.project.name })
  assert.equal(billing.billingModel, 'fixed_price'); assert.equal(billing.contract.total_cents, null)
  assert.equal(billing.contract.title, 'Lot 47 Contract'); assert.equal(billing.contract.retainage_percent, 0)
  assert.equal(billing.contract.open_book, true); assert.equal(billing.contract.snapshot.billing_setup_source, 'project_settings')
  const settings = h.financial.prepareProjectFinancialSettings({ orgId: ORG, projectId: HOME, userId: ACTOR, input: p.input, existingContract: billing.contract, existingRawCostCodesEnabled: null, now: NOW })
  assert.equal(settings.billing_model, 'fixed_price'); assert.equal(settings.open_book_required, false)
  assert.equal(settings.cost_codes_enabled, null); assert.equal(settings.fixed_price_billing_basis, 'draws')
  assert.equal(settings.setup_completed_at, NOW); assert.equal(settings.setup_completed_by, ACTOR)
  const saved = await h.projects.createProject({ input: p.input, context: h.context, authorizationPermission: 'sales.manage' })
  const contract = h.db.store.contracts.find(c => c.project_id === saved.id), financial = h.db.store.project_financial_settings.find(s => s.project_id === saved.id)
  assert.equal(contract.total_cents, null); assert.equal(contract.retainage_percent, 0); assert.equal(financial.cost_codes_enabled, null)
  assert.equal(financial.billing_model, 'fixed_price'); assert.equal(financial.open_book_required, false)
  assert.deepEqual(h.db.store.accounting_entity_map.find(m => m.project_id === saved.id).dimensions, {})
  assert.equal(h.events[0].eventType, 'project_created'); assert.ok(h.audits.some(a => a.entityType === 'contract'))
})
test('billing preparation preserves approved changes, explicit fees and unrelated snapshot evidence', () => {
  const h = fixture(), existing = { title: 'Original', status: 'active', currency: 'usd', contract_type: 'cost_plus', total_cents: 12000, fixed_fee_cents: 3000, snapshot: { base_total_cents: 10000, approved_change_orders_cents: 2000, original_evidence: 'keep', fee_presentation: 'separate_total' } }
  const p = h.projects.prepareProjectBillingContract({ orgId: ORG, projectId: HOME, projectName: 'Home', input: { billing_model: 'cost_plus_fixed_fee', total_contract_value_cents: 20000 }, existing })
  assert.equal(p.contract.total_cents, 22000); assert.equal(p.contract.fixed_fee_cents, 3000)
  assert.equal(p.contract.fee_presentation, 'separate_total'); assert.equal(p.contract.snapshot.original_evidence, 'keep')
  assert.equal(p.contract.snapshot.base_total_cents, 20000); assert.equal(p.contract.snapshot.approved_change_orders_cents, 2000)
  assert.throws(() => h.projects.prepareProjectBillingContract({ orgId: ORG, projectId: HOME, projectName: 'Home', input: { savings_split_owner_pct: 60, savings_split_builder_pct: 50 } }), /cannot exceed/)
})
test('financial preparation distinguishes inheritance, explicit disabled and existing settings', () => {
  const h = fixture(), base = { orgId: ORG, projectId: HOME, userId: ACTOR, existingRawCostCodesEnabled: false, now: NOW, existingContract: { contract_type: 'cost_plus', gmp_cents: 50000, snapshot: { proof_required: true, paid_costs_required: true } } }
  const p = h.financial.prepareProjectFinancialSettings({ ...base, input: {} })
  assert.equal(p.billing_model, 'cost_plus_gmp'); assert.equal(p.open_book_required, true)
  assert.equal(p.proof_required, true); assert.equal(p.paid_costs_required, true); assert.equal(p.cost_codes_enabled, false)
  assert.equal(h.financial.prepareProjectFinancialSettings({ ...base, input: { cost_codes_enabled: null } }).cost_codes_enabled, null)
  assert.equal(h.financial.prepareProjectFinancialSettings({ ...base, input: { cost_codes_enabled: true } }).cost_codes_enabled, true)
})
test('accounting dimension preparation preserves untouched mappings and removes explicit cleared values', () => {
  const h = fixture(), existing = { class: { id: 'class-1' }, customer: { id: 'customer-1', name: 'Buyer' } }
  assert.deepEqual(h.projects.prepareProjectAccountingDimensions({ existingDimensions: existing, classId: null }), { customer: existing.customer })
  assert.deepEqual(h.projects.prepareProjectAccountingDimensions({ existingDimensions: existing, customerId: 'customer-2', customerName: 'New buyer' }), { class: existing.class, customer: { id: 'customer-2', name: 'New buyer' } })
  assert.equal(existing.class.id, 'class-1'); assert.equal(existing.customer.id, 'customer-1')
})
test('deposit preparation keeps exact cents, one snapshot time, actor and original hold metadata without writes', () => {
  const h = fixture(), input = depositInput(), amounts = h.invoices.prepareInvoiceAmounts(input, null)
  assert.equal(amounts.totals.total_cents, 500001); assert.equal(amounts.totals.tax_cents, 0)
  const p = h.invoices.prepareInvoiceCreation({ input, orgId: ORG, userId: ACTOR, productPosture: 'production', approvalStatus: 'not_required', sourceContext: null, ...amounts, orgInfo: h.db.store.orgs[0], token: 'original-token', now: NOW })
  assert.equal(p.invoice.total_cents, 500001); assert.equal(p.lines[0].unit_price_cents, 500001)
  assert.equal(p.invoice.status, 'sent'); assert.equal(p.invoice.delivery_status, 'queued')
  assert.equal(p.invoice.sent_at, NOW); assert.equal(p.invoice.issued_snapshot.issued_at, NOW)
  assert.equal(p.invoice.token, 'original-token'); assert.equal(p.invoice.metadata.created_by, ACTOR)
  assert.equal(p.invoice.metadata.source_reservation_id, 'original-hold'); assert.equal(p.invoice.metadata.org_name, 'Builder')
  assert.equal(h.commits.length, 0); assert.equal(h.jobs.length, 0); assert.equal(h.events.length, 0)
})
test('invoice preparation rejects unapproved issuance and absent original token', () => {
  const h = fixture(), input = depositInput(), amounts = h.invoices.prepareInvoiceAmounts(input, null)
  const args = { input, orgId: ORG, userId: ACTOR, productPosture: 'commercial', approvalStatus: 'draft', sourceContext: null, ...amounts, orgInfo: null, token: 'original', now: NOW }
  assert.throws(() => h.invoices.prepareInvoiceCreation(args), /approved before/)
  assert.throws(() => h.invoices.prepareInvoiceCreation({ ...args, approvalStatus: 'approved', token: null }), /original token/)
  const draft = h.invoices.prepareInvoiceCreation({ ...args, input: { ...input, issue: false }, token: null })
  assert.equal(draft.invoice.status, 'draft'); assert.equal(draft.invoice.issued_snapshot, null)
})
test('original invoice owner still checks actual home then commits header/lines and queues original issuance', async () => {
  const h = fixture('commercial'), input = depositInput()
  await h.invoices.createInvoice({ input, context: h.context, authorizationPermission: 'sales.manage', sendAuthorizationPermission: 'sales.manage' })
  assert.ok(h.guards.some(g => g.permission === 'sales.manage' && g.projectId === HOME))
  assert.equal(h.commits.length, 1); assert.equal(h.commits[0].name, 'create_invoice_atomic')
  assert.equal(h.commits[0].args.p_invoice.product_posture, 'production')
  assert.equal(h.commits[0].args.p_invoice.total_cents, 500001); assert.equal(h.commits[0].args.p_lines[0].unit_price_cents, 500001)
  assert.equal(h.jobs.length, 1); assert.equal(h.jobs[0].jobType, 'issue_invoice'); assert.equal(h.jobs[0].payload.invoice_id, 'invoice-1')
  assert.equal(h.after.length, 1); assert.ok(h.events.some(e => e.eventType === 'invoice_created'))
})
