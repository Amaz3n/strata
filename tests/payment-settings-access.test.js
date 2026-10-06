require('../scripts/register-ts-node-test')
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), ts = require('typescript'), React = require('react')
const { createFakeSupabase } = require('./support/fake-supabase')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ORG = id(1), ACTOR = id(2)
function load(file, modules) {
  const exports = {}, code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const leaves = new Proxy({}, { get: (_, key) => String(key) })
  new Function('exports', 'require', code)(exports, name => modules[name] ?? (name === 'zod' ? require('zod') : name === 'react/jsx-runtime' ? require(name) : leaves))
  return exports
}
function harness(permissions) {
  const calls = [], db = createFakeSupabase({
    payment_rail_policies: [{ org_id: ORG, enabled: true, approval_mode: 'dual' }],
    org_funding_sources: [{ id: id(3), org_id: ORG, provider: 'stripe', bank_name: 'Example bank', last4: '1234', status: 'active', verification_status: 'verified', provider_payment_method_id: 'private-provider-reference' }],
    payment_control_change_requests: [ACTOR, id(9)].map((requester, i) => ({ id: id(4 + i), org_id: ORG, kind: 'org_funding_source', requested_by_user_id: requester, status: 'pending_approval', required_approvals: 2, proposed_masked_details: { bank_name: 'Example bank', last4: '1234', private_detail: 'Do not return' } })),
    payment_control_change_approvals: [],
  })
  const permits = key => permissions.includes(key) || permissions.includes('*')
  const modules = {
    '@/lib/services/context': { requireOrgContext: async () => ({ orgId: ORG, userId: ACTOR, supabase: db }) },
    '@/lib/services/permissions': {
      requireAnyPermission: async keys => { calls.push(['readGuard', keys]); if (!keys.some(permits)) throw Error('Forbidden settings read') },
      requirePermission: async key => { calls.push(['writeGuard', key]); if (!permits(key)) throw Error(`Forbidden ${key}`) },
      hasPermission: async key => permits(key),
    },
    '@/lib/supabase/server': { createServiceSupabaseClient: () => { calls.push('client'); return db } },
    '@/lib/validation/fintech-payments': require('../lib/validation/fintech-payments'),
    '@/lib/services/payment-approvers': { getPaymentApprovalRouting: async () => ({ approvers: [], viewerUserId: ACTOR }), listPaymentApproverCandidates: async () => { calls.push('candidates'); return [{ userId: id(9), name: 'Approver', email: null }] } },
  }
  return { calls, service: load('lib/services/payment-rail-setup.ts', modules) }
}
for (const permission of ['payment.release', 'payment.approve_run', 'payment.manage_rail', '*']) test(`${permission} can inspect masked payment settings with independent management/approval capabilities`, async () => {
  const h = harness([permission]), settings = await h.service.getPaymentRailSettings()
  assert.equal(settings.canManage, ['payment.manage_rail', '*'].includes(permission))
  assert.equal(settings.canApprove, ['payment.approve_run', '*'].includes(permission))
  assert.equal(settings.canManageAutoApproval, permission === '*')
  assert.equal(h.calls.includes('candidates'), settings.canManage)
  assert.equal(settings.controlChanges[0].canDecide, false, 'Requester cannot decide own funding change')
  assert.equal(settings.controlChanges[1].canDecide, settings.canApprove)
  assert.equal(settings.fundingSources[0].last4, '1234')
  assert.ok(!JSON.stringify(settings).includes('private-provider-reference'))
  assert.ok(!JSON.stringify(settings).includes('Do not return'))
})
for (const permissions of [[], ['org.member'], ['bill.approve']]) test(`${permissions.join(',') || 'no permission'} cannot read payment settings or create a privileged data client`, async () => {
  const h = harness(permissions)
  await assert.rejects(h.service.getPaymentRailSettings(), /Forbidden settings read/)
  assert.ok(!h.calls.includes('client'))
})
test('payment approver read access cannot edit policy or start funding setup', async () => {
  const h = harness(['payment.approve_run'])
  await assert.rejects(h.service.updatePaymentRailPolicy({ enabled: false }), /Forbidden payment.manage_rail/)
  await assert.rejects(h.service.createOrgFundingSetup(), /Forbidden payment.manage_rail/)
  assert.ok(!h.calls.includes('client'))
})
test('rail manager read access does not grant funding approval', async () => {
  const h = harness(['payment.manage_rail'])
  await assert.rejects(h.service.decidePaymentControlChange({ changeRequestId: id(4), decision: 'approved' }), /Forbidden payment.approve_run/)
  assert.ok(!h.calls.includes('client'))
})
function nodes(node) {
  if (Array.isArray(node)) return node.flatMap(nodes)
  if (!React.isValidElement(node)) return []
  return [node, ...nodes(node.props.children)]
}
for (const permissions of [['payment.manage_rail'], ['payment.approve_run'], ['payment.release'], ['payment.manage_rail', 'bill.approve']]) test(`actual payment panel separates auto-approval controls for ${permissions.join(',')}`, async () => {
  const settings = await harness(permissions).service.getPaymentRailSettings()
  const panel = load('components/settings/payment-rail-panel.tsx', {
    react: { ...React, useState: value => [value, () => {}], useRef: value => ({ current: value }), useMemo: fn => fn(), useEffect: () => {}, useTransition: () => [false, () => {}] },
    'next/navigation': { useRouter: () => ({}), useSearchParams: () => new URLSearchParams() },
    '@/lib/utils': { cn: (...values) => values.filter(Boolean).join(' ') },
  }).PaymentRailPanel
  const tree = nodes(panel({ initialSettings: settings, publishableKey: null }))
  const rules = tree.find(node => node.type === 'AutoApprovalRulesGroup')
  assert.equal(Boolean(rules), permissions.includes('bill.approve'))
  if (rules) assert.equal(rules.props.canManage, true)
})
