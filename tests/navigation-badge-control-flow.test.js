const assert = require('node:assert/strict')
const fs = require('node:fs')
const test = require('node:test')
const ts = require('typescript')
const { redirect, notFound, unstable_rethrow } = require('next/navigation')
const { DynamicServerError } = require('next/dist/client/components/hooks-server-context')
const { makeDynamicHangingPromise } = require('next/dist/server/dynamic-rendering-utils')

function thrown(work) {
  try { work() } catch (error) { return error }
  throw new Error('Expected a framework signal')
}
function fixture({ phase, failure, grants = [], rows = {} } = {}) {
  const calls = [], exports = {}
  const supabase = { from(table) {
    const query = {}
    for (const method of ['select', 'eq', 'in', 'is', 'neq', 'limit', 'lte']) query[method] = () => query
    query.then = (resolve, reject) => {
      calls.push(table)
      return (phase === table ? Promise.reject(failure) : Promise.resolve({ data: rows[table] ?? [], error: null })).then(resolve, reject)
    }
    return query
  } }
  const context = { orgId: 'organization', userId: 'actor', supabase }
  const modules = {
    'next/navigation': { unstable_rethrow },
    '@/lib/services/context': { requireOrgContext: async () => { calls.push('context'); if (phase === 'context') throw failure; return context } },
    '@/lib/services/permissions': { hasPermission: async permission => { calls.push(permission); if (phase === permission) throw failure; return grants.includes(permission) } },
    '@/lib/services/authorization': { authorizeMany: async ({ projectIds }) => { calls.push('authorization'); if (phase === 'authorization') throw failure; return new Map(projectIds.map(id => [id, true])) } },
    './precon-deals': { listPipelineDeals: async () => { calls.push('deals'); if (phase === 'deals') throw failure; return { deals: [{ ball: 'you' }, { ball: 'them' }] } } },
  }
  const source = fs.readFileSync(process.env.NAVIGATION_BADGES_SOURCE ?? 'lib/services/navigation-badges.ts', 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  new Function('exports', 'require', code)(exports, name => { if (!modules[name]) throw new Error(`Unexpected module ${name}`); return modules[name] })
  return { calls, load: exports.getNavigationBadgeCounts, financial: exports.getProjectFinancialReviewBreakdown }
}
const empty = { pipelineBadgeCount: 0, myWorkBadgeCount: 0, readyToBillBadgeCount: 0, projectReviewBadgeCounts: {}, projectCorrespondenceBadgeCounts: {} }
const project = { project_id: 'project' }

test('ordinary navigation reader failures retain the existing fallback counts', async () => {
  assert.deepEqual(await fixture({ phase: 'context', failure: new Error('Context unavailable') }).load(), empty)
  assert.deepEqual(await fixture({ phase: 'authorization', failure: new Error('Authorization unavailable'), rows: { time_entries: [project] } }).financial(), {})
  const partial = await fixture({ phase: 'time_entries', failure: new Error('Time store unavailable'), rows: { project_expenses: [project] } }).load()
  assert.deepEqual(partial.projectReviewBadgeCounts, { project: 1 })
  assert.equal(partial.myWorkBadgeCount, 1)
})
test('ordinary optional permission failures avoid querying inaccessible sources', async () => {
  for (const permission of ['invoice.read', 'pipeline.read', 'correspondence.read']) {
    const f = fixture({ phase: permission, failure: new Error('Permission read unavailable') })
    assert.deepEqual(await f.load(), empty)
    assert.ok(!f.calls.includes('deals'))
    assert.ok(!f.calls.includes('project_emails'))
    assert.ok(!f.calls.includes('draw_schedules'))
  }
})
for (const phase of ['context', 'time_entries', 'project_expenses', 'vendor_bills', 'billable_costs', 'authorization', 'invoice.read', 'pipeline.read', 'correspondence.read', 'task_assignments', 'project_emails', 'deals']) {
  test(`navigation ${phase} preserves framework control flow through nested fallbacks`, async () => {
    const controller = new AbortController()
    const hanging = makeDynamicHangingPromise(controller.signal, '/', 'navigation counts').catch(error => error)
    controller.abort()
    const signals = [thrown(() => redirect('/auth/signin')), thrown(notFound), new DynamicServerError('Interrupted navigation read'), await hanging]
    for (const signal of signals) {
      for (const failure of [signal, new Error('Wrapped navigation interruption', { cause: signal })]) {
        const f = fixture({ phase, failure, grants: phase === 'project_emails' ? ['correspondence.read'] : phase === 'deals' ? ['pipeline.read'] : [], rows: phase === 'authorization' ? { time_entries: [project] } : {} })
        await assert.rejects(f.load(), error => error === signal)
        if (['authorization', 'time_entries', 'project_expenses', 'vendor_bills', 'billable_costs'].includes(phase)) {
          await assert.rejects(f.financial(), error => error === signal)
        }
      }
    }
  })
}
